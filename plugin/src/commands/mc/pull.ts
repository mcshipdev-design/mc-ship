import path from 'node:path'

import {Command, Flags} from '@oclif/core'

import {loadConfig, projectRoot, requireBu} from '../../core/config.js'
import {clientFor} from '../../core/sfmc.js'
import {writeSnapshot} from '../../core/store.js'

export default class McPull extends Command {
  static override description =
    'Pull Data Extensions (schema + row counts), Content Builder emails, blocks and templates, and Automation Studio SQL queries and automations from a BU into Git as readable files.'

  static override examples = ['<%= config.bin %> <%= command.id %> --bu DEV', '<%= config.bin %> <%= command.id %> --bu DEV --bu PROD --json']

  static override enableJsonFlag = true

  static override flags = {
    bu: Flags.string({description: 'Business Unit to pull (repeat for several)', required: true, multiple: true}),
    only: Flags.string({description: 'Only pull DEs and content whose name or key starts with this prefix (repeatable)', multiple: true}),
    'row-counts': Flags.boolean({description: 'Fetch row counts per Data Extension (needed by destructive-de-change)', default: true, allowNo: true}),
    automations: Flags.boolean({description: 'Pull SQL queries and automations from Automation Studio', default: true, allowNo: true}),
  }

  public async run(): Promise<{pulled: {bu: string; dataExtensions: number; content: number; queries: number; automations: number; dir: string}[]}> {
    const {flags} = await this.parse(McPull)
    const root = projectRoot()
    const config = loadConfig(root)
    const pulled = []
    for (const name of flags.bu) {
      const snap = await clientFor(name, requireBu(config, name), root).snapshot({
        only: flags.only,
        rowCounts: flags['row-counts'],
        automations: flags.automations,
        onProgress: (m) => process.stderr.write(`  ${m}\n`),
      })
      const {dir} = writeSnapshot(snap, root)
      const rel = path.relative(root, dir) || '.'
      const queries = snap.queries?.length ?? 0
      const automations = snap.automations?.length ?? 0
      this.log(
        `Pulled ${name}: ${snap.dataExtensions.length} Data Extensions, ${snap.content.length} content assets, ` +
          `${queries} SQL ${queries === 1 ? 'query' : 'queries'}, ${automations} ${automations === 1 ? 'automation' : 'automations'} -> ${rel}/`,
      )
      pulled.push({bu: name, dataExtensions: snap.dataExtensions.length, content: snap.content.length, queries, automations, dir: rel})
    }
    return {pulled}
  }
}
