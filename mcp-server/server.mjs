#!/usr/bin/env node
/**
 * MC Ship MCP server.
 *
 * Exposes the `agentia mc` plugin commands as MCP tools so any MCP client
 * (Cursor, VS Code, Claude) can run a Marketing Cloud release end to end.
 * Agentia plugins cannot register MCP tools inside `agentia mcp start` yet,
 * so this small server runs next to it and calls the CLI with --json.
 *
 * Env:
 *   MCSHIP_PROJECT_DIR  project folder that holds .mcship/ and mc/ (default: cwd)
 *   MCSHIP_AGENTIA_BIN  path to the agentia binary (default: agentia)
 */
import {execFile} from 'node:child_process'

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {z} from 'zod'

const BIN = process.env.MCSHIP_AGENTIA_BIN ?? 'agentia'
const CWD = process.env.MCSHIP_PROJECT_DIR ?? process.cwd()

export function runMc(args) {
  return new Promise((resolve) => {
    execFile(
      BIN,
      ['mc', ...args, '--json'],
      {cwd: CWD, timeout: 600_000, maxBuffer: 50 * 1024 * 1024, env: {...process.env, NO_COLOR: '1'}},
      (err, stdout, stderr) => {
        let data
        try {
          data = JSON.parse(stdout)
        } catch {
          data = undefined
        }
        if (data === undefined) {
          resolve({ok: false, text: (stderr || err?.message || stdout || 'no output').trim()})
          return
        }
        const failed = data?.error || (typeof data?.status === 'number' && data.status !== 0 && data.message)
        resolve({ok: !failed, data})
      },
    )
  })
}

const asResult = (r) => ({
  isError: !r.ok,
  content: [{type: 'text', text: r.data === undefined ? r.text : JSON.stringify(r.data, null, 2)}],
})

const bu = (what) => z.string().min(1).describe(`${what} Business Unit name, as connected with "agentia mc connect" (e.g. DEV, PROD)`)

export function createServer() {
  const server = new McpServer({name: 'mc-ship', version: '0.1.0'})

  server.registerTool(
    'mc_pull',
    {
      title: 'Pull Marketing Cloud BUs into Git',
      description:
        'Pull Data Extensions (schema and row counts) and Content Builder emails, blocks and templates from one or more BUs into the project as files. Run this for both source and target before diff or check.',
      inputSchema: {bus: z.array(z.string().min(1)).min(1).describe('BUs to pull, e.g. ["DEV","PROD"]')},
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
    },
    async ({bus}) => asResult(await runMc(['pull', ...bus.flatMap((b) => ['--bu', b])])),
  )

  server.registerTool(
    'mc_diff',
    {
      title: 'Diff two BUs',
      description: 'List assets that are added or changed in the source BU (local files) compared to the target BU, with field-level detail.',
      inputSchema: {from: bu('Source'), to: bu('Target')},
      annotations: {readOnlyHint: true},
    },
    async ({from, to}) => asResult(await runMc(['diff', from, to])),
  )

  server.registerTool(
    'mc_check',
    {
      title: 'Run release policy checks',
      description:
        'Run the six MC Ship policy checks on a release. Returns status pass, warn or fail and findings, each with a suggested fix. A fail blocks deploy.',
      inputSchema: {from: bu('Source'), to: bu('Target')},
      annotations: {readOnlyHint: true},
    },
    async ({from, to}) => {
      const r = await runMc(['check', from, to])
      // A failing check is a valid answer, not a tool error
      return asResult({...r, ok: r.data !== undefined})
    },
  )

  server.registerTool(
    'mc_explain',
    {
      title: 'Explain release risk in plain English',
      description:
        'Write a plain-English risk summary and release note for a marketer or release manager, using the Copado AI release agent when configured. Optionally attach it to a Copado user story.',
      inputSchema: {
        from: bu('Source'),
        to: bu('Target'),
        userStory: z.string().optional().describe('Copado user story ID or name'),
        attach: z.boolean().optional().describe('Write the explanation to the user story. Needs userStory.'),
        offline: z.boolean().optional().describe('Skip Copado AI and use the built-in summary'),
      },
      annotations: {readOnlyHint: false, destructiveHint: false},
    },
    async ({from, to, userStory, attach, offline}) => {
      const args = ['explain', from, to]
      if (userStory) args.push('--user-story', userStory)
      if (attach && userStory) args.push('--attach')
      if (offline) args.push('--offline')
      return asResult(await runMc(args))
    },
  )

  server.registerTool(
    'mc_deploy',
    {
      title: 'Deploy a release to the target BU',
      description:
        'Deploy added and changed assets from the source BU (local files) to the target BU. Refreshes the target, re-runs checks and refuses on fail. Defaults to a dry run. To really deploy, set dryRun=false AND confirm=true, and only after a human has approved the plan shown by the dry run.',
      inputSchema: {
        from: bu('Source'),
        to: bu('Target'),
        dryRun: z.boolean().default(true).describe('Show the plan only (default true)'),
        confirm: z.boolean().default(false).describe('Must be true, with human approval, to deploy'),
        userStory: z.string().optional().describe('Copado user story to attach the release note to'),
      },
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false},
    },
    async ({from, to, dryRun, confirm, userStory}) => {
      if (!dryRun && !confirm) {
        return {
          isError: true,
          content: [{type: 'text', text: 'Refused: set confirm=true after the user approves the dry-run plan.'}],
        }
      }
      const args = ['deploy', from, to]
      if (dryRun) args.push('--dry-run')
      else args.push('--yes')
      if (userStory) args.push('--user-story', userStory)
      const r = await runMc(args)
      return asResult({...r, ok: r.data !== undefined && r.data.status !== 'blocked'})
    },
  )

  server.registerTool(
    'mc_status',
    {
      title: 'Show MC Ship project status',
      description: 'Show connected BUs and the latest deploys from the audit log. Use first to learn which BU names exist.',
      inputSchema: {},
      annotations: {readOnlyHint: true},
    },
    async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const cfgFile = path.join(CWD, '.mcship', 'config.json')
      if (!fs.existsSync(cfgFile)) {
        return {isError: true, content: [{type: 'text', text: `No MC Ship project in ${CWD}. Run "agentia mc connect <BU>" first.`}]}
      }
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      const audit = path.join(CWD, cfg.srcDir ?? 'mc', 'audit.log.jsonl')
      const deploys = fs.existsSync(audit)
        ? fs.readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).slice(-5).map((l) => JSON.parse(l))
        : []
      const bus = Object.entries(cfg.bus ?? {}).map(([name, b]) => ({name, mode: b.mode, pulled: fs.existsSync(path.join(CWD, cfg.srcDir ?? 'mc', name))}))
      return {content: [{type: 'text', text: JSON.stringify({projectDir: CWD, bus, lastDeploys: deploys}, null, 2)}]}
    },
  )

  return server
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs') || process.argv[1]?.endsWith('mc-ship-mcp')) {
  await createServer().connect(new StdioServerTransport())
}
