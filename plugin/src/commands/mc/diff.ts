import {Args, Command} from '@oclif/core'

import {projectRoot} from '../../core/config.js'
import {diffSnapshots} from '../../core/diff.js'
import {bold, changeLines} from '../../core/format.js'
import {readSnapshot} from '../../core/store.js'
import {AssetChange} from '../../core/types.js'

export default class McDiff extends Command {
  static override description = 'Show what would change in the target BU if the source BU (as stored in Git) were deployed.'

  static override examples = ['<%= config.bin %> <%= command.id %> DEV PROD', '<%= config.bin %> <%= command.id %> DEV PROD --json']

  static override enableJsonFlag = true

  static override args = {
    from: Args.string({description: 'Source BU (local files)', required: true}),
    to: Args.string({description: 'Target BU', required: true}),
  }

  public async run(): Promise<{from: string; to: string; changes: AssetChange[]}> {
    const {args} = await this.parse(McDiff)
    const root = projectRoot()
    const changes = diffSnapshots(readSnapshot(args.from, root), readSnapshot(args.to, root))
    this.log(bold(`${args.from} -> ${args.to}: ${changes.length} difference(s)`))
    for (const l of changeLines(changes)) this.log(l)
    return {from: args.from, to: args.to, changes}
  }
}
