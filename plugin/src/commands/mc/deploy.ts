import os from 'node:os'
import readline from 'node:readline/promises'

import {Args, Command, Flags} from '@oclif/core'

import {attachToUserStory} from '../../core/agentia.js'
import {loadConfig, projectRoot, requireBu} from '../../core/config.js'
import {diffSnapshots} from '../../core/diff.js'
import {localExplanation} from '../../core/explain.js'
import {bold, changeLines, checkLines, dim, green, red} from '../../core/format.js'
import {runChecks} from '../../core/rules.js'
import {UpsertResult, clientFor} from '../../core/sfmc.js'
import {appendAudit, readSnapshot, writeSnapshot} from '../../core/store.js'
import {AssetChange, CheckResult} from '../../core/types.js'

interface DeployResult {
  from: string
  to: string
  status: 'deployed' | 'dry-run' | 'blocked' | 'cancelled' | 'nothing-to-deploy'
  check: CheckResult
  changes: AssetChange[]
  results: UpsertResult[]
  auditLog?: string
  attachedToUserStory?: boolean
}

export default class McDeploy extends Command {
  static override description =
    'Deploy the source BU (as stored in Git) to the target BU. Refreshes the target first, re-runs every policy check, blocks on failures, writes an audit log and can attach a release note to a Copado user story. Never deletes anything in the target.'

  static override examples = [
    '<%= config.bin %> <%= command.id %> DEV PROD --dry-run',
    '<%= config.bin %> <%= command.id %> DEV PROD --user-story US-0001234',
    '<%= config.bin %> <%= command.id %> DEV PROD --yes --json',
  ]

  static override enableJsonFlag = true

  static override args = {
    from: Args.string({description: 'Source BU (local files)', required: true}),
    to: Args.string({description: 'Target BU', required: true}),
  }

  static override flags = {
    'dry-run': Flags.boolean({description: 'Show what would be deployed and stop'}),
    yes: Flags.boolean({char: 'y', description: 'Skip the confirmation prompt (required with --json)'}),
    force: Flags.boolean({description: 'Deploy even when checks fail. Logged in the audit trail.'}),
    'user-story': Flags.string({description: 'Copado user story to attach the release note to'}),
    only: Flags.string({description: 'Limit the target refresh to DEs and content whose name or key starts with this prefix (repeatable)', multiple: true}),
  }

  public async run(): Promise<DeployResult> {
    const {args, flags} = await this.parse(McDeploy)
    const root = projectRoot()
    const config = loadConfig(root)
    const target = clientFor(args.to, requireBu(config, args.to), root)

    // 1. Always compare against the live target, not a stale local copy
    this.log(dim(`Refreshing ${args.to} from Marketing Cloud...`))
    const progress = (m: string) => process.stderr.write(`  ${m}\n`)
    const live = await target.snapshot({only: flags.only, onProgress: progress})
    writeSnapshot(live, root)
    const source = readSnapshot(args.from, root)

    // 2. What changes, and is it safe?
    const changes = diffSnapshots(source, live)
    const ship = changes.filter((c) => c.change === 'added' || c.change === 'changed')
    const check = runChecks(source, live)
    this.log(bold(`Release ${args.from} -> ${args.to}: ${ship.length} asset(s) to deploy`))
    for (const l of changeLines(ship)) this.log(l)
    this.log('')
    for (const l of checkLines(check)) this.log(l)
    this.log('')

    const base = {from: args.from, to: args.to, check, changes, results: [] as UpsertResult[]}
    if (!ship.length) {
      this.log('Nothing to deploy.')
      return {...base, status: 'nothing-to-deploy'}
    }
    if (check.status === 'fail' && !flags.force) {
      this.log(red('Blocked: fix the FAIL findings above, or rerun with --force (logged).'))
      process.exitCode = 1
      return {...base, status: 'blocked'}
    }
    if (flags['dry-run']) {
      this.log('Dry run: nothing was changed.')
      return {...base, status: 'dry-run'}
    }
    if (!flags.yes) {
      if (this.jsonEnabled() || !process.stdin.isTTY) this.error('Pass --yes to deploy non-interactively.')
      const rl = readline.createInterface({input: process.stdin, output: process.stdout})
      const answer = await rl.question(`Deploy ${ship.length} asset(s) to ${args.to}? (y/N) `)
      rl.close()
      if (!/^y(es)?$/i.test(answer.trim())) return {...base, status: 'cancelled'}
    }

    // 3. Deploy: DEs first, then blocks and templates, then emails (dependencies first)
    const keys = new Set(ship.map((c) => `${c.kind}:${c.customerKey}`))
    const results: UpsertResult[] = []
    for (const de of source.dataExtensions.filter((d) => keys.has(`dataExtension:${d.customerKey}`))) {
      const existing = live.dataExtensions.find((d) => d.customerKey === de.customerKey)
      results.push(await target.upsertDataExtension(de, existing))
    }
    const order = {htmlblock: 0, template: 1, htmlemail: 2}
    const content = source.content
      .filter((c) => keys.has(`content:${c.customerKey}`))
      .sort((a, b) => order[a.assetType] - order[b.assetType])
    for (const c of content) results.push(await target.upsertContent(c))

    for (const r of results) {
      this.log(`  ${r.action === 'skipped' ? dim('skip') : green('ok  ')}  ${r.customerKey}  ${dim(r.action)}${r.note ? dim(`  ${r.note}`) : ''}`)
    }

    // 4. Record it
    const auditLog = appendAudit(
      {
        at: new Date().toISOString(),
        from: args.from,
        to: args.to,
        user: safeUser(),
        forced: Boolean(flags.force && check.status === 'fail'),
        checkStatus: check.status,
        findings: check.findings.length,
        userStory: flags['user-story'],
        results,
      },
      root,
    )
    writeSnapshot(await target.snapshot({only: flags.only, onProgress: progress}), root)
    this.log(green(`Deployed to ${args.to}.`) + dim(`  Audit log: ${auditLog}`))

    let attachedToUserStory: boolean | undefined
    if (flags['user-story']) {
      const note = localExplanation(changes, check)
      const r = await attachToUserStory(
        flags['user-story'],
        `MC Ship deploy ${args.from} -> ${args.to} at ${new Date().toISOString()}\n\n${note.summary}\n\n${results
          .map((x) => `${x.action}: ${x.customerKey}${x.note ? ` (${x.note})` : ''}`)
          .join('\n')}`,
      )
      attachedToUserStory = r.ok
      this.log(r.ok ? `Release note attached to ${flags['user-story']}.` : `Could not update user story: ${r.error}`)
    }
    return {...base, status: 'deployed', results, auditLog, attachedToUserStory}
  }
}

function safeUser(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown'
  }
}
