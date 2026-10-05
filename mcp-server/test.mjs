// End-to-end: start the MCP server over stdio and drive a release with an MCP client.
// Needs agentia + the MC Ship plugin installed, and a demo project (demo/reset.sh).
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'

const dir = process.env.MCSHIP_PROJECT_DIR
test('MCP tools drive a release', {skip: !dir && 'set MCSHIP_PROJECT_DIR to a demo project'}, async () => {
  const client = new Client({name: 'mc-ship-test', version: '0.0.0'})
  await client.connect(new StdioClientTransport({command: 'node', args: ['server.mjs'], env: {...process.env, MCSHIP_PROJECT_DIR: dir}}))
  const tools = (await client.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(tools, ['mc_check', 'mc_deploy', 'mc_diff', 'mc_explain', 'mc_pull', 'mc_status'])

  const json = (r) => JSON.parse(r.content[0].text)
  assert.equal(json(await client.callTool({name: 'mc_status', arguments: {}})).bus.length, 2)
  await client.callTool({name: 'mc_pull', arguments: {bus: ['PROD']}})
  const check = json(await client.callTool({name: 'mc_check', arguments: {from: 'DEV', to: 'PROD'}}))
  assert.ok(['pass', 'warn', 'fail'].includes(check.status))

  const refused = await client.callTool({name: 'mc_deploy', arguments: {from: 'DEV', to: 'PROD', dryRun: false}})
  assert.equal(refused.isError, true)
  const plan = json(await client.callTool({name: 'mc_deploy', arguments: {from: 'DEV', to: 'PROD'}}))
  assert.ok(['dry-run', 'blocked', 'nothing-to-deploy'].includes(plan.status))
  await client.close()
})
