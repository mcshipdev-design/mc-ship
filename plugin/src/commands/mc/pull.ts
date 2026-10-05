import path from 'node:path'

import {Command, Flags} from '@oclif/core'

import {loadConfig, projectRoot, requireBu} from '../../core/config.js'
import {clientFor} from '../../core/sfmc.js'
import {writeSnapshot} from '../../core/store.js'

export default class McPull extends Command {
  static override description =
    'Pull Data Extensions (schema + row counts) and Content Builder emails, blocks and templates from a BU into Git as readable files.'

  static override examples = ['<%= config.bin %> <%= command.id %> --bu DEV', '<%= config.bin %> <%= command.id %> --bu DEV --bu PROD --json']

  static override enableJsonFlag = true

  static override flags = {
    bu: Flags.string({description: 'Business Unit to pull (repeat for several)', required: true, multiple: true}),
  }

  public async run(): Promise<{pulled: {bu: string; dataExtensions: number; content: number; dir: string}[]}> {
    const {flags} = await this.parse(McPull)
    const root = projectRoot()
    const config = loadConfig(root)
    const pulled = []
    for (const name of flags.bu) {
      const snap = await clientFor(name, requireBu(config, name), root).snapshot()
      const {dir} = writeSnapshot(snap, root)
      const rel = path.relative(root, dir) || '.'
      this.log(`Pulled ${name}: ${snap.dataExtensions.length} Data Extensions, ${snap.content.length} content assets -> ${rel}/`)
      pulled.push({bu: name, dataExtensions: snap.dataExtensions.length, content: snap.content.length, dir: rel})
    }
    return {pulled}
  }
}
