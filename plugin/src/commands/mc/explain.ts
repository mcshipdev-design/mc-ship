import {Args, Command, Flags} from '@oclif/core'

import {attachToUserStory} from '../../core/agentia.js'
import {projectRoot} from '../../core/config.js'
import {diffSnapshots} from '../../core/diff.js'
import {Explanation, explain} from '../../core/explain.js'
import {bold, dim} from '../../core/format.js'
import {runChecks} from '../../core/rules.js'
import {readSnapshot} from '../../core/store.js'

export default class McExplain extends Command {
  static override description =
    'Explain a release in plain English for marketers and release managers. Uses the Copado AI release agent (agentia ai agent ask) and falls back to a built-in summary when offline. Optionally attaches the note to a Copado user story.'

  static override examples = [
    '<%= config.bin %> <%= command.id %> DEV PROD',
    '<%= config.bin %> <%= command.id %> DEV PROD --user-story US-0001234 --attach',
    '<%= config.bin %> <%= command.id %> DEV PROD --offline --json',
  ]

  static override enableJsonFlag = true

  static override args = {
    from: Args.string({description: 'Source BU (local files)', required: true}),
    to: Args.string({description: 'Target BU', required: true}),
  }

  static override flags = {
    offline: Flags.boolean({description: 'Do not call Copado AI; use the built-in summary'}),
    'user-story': Flags.string({description: 'Copado user story ID or name to give the AI as context'}),
    attach: Flags.boolean({description: 'Write the explanation to the user story (technical specifications)', dependsOn: ['user-story']}),
  }

  public async run(): Promise<Explanation & {attached?: boolean}> {
    const {args, flags} = await this.parse(McExplain)
    const root = projectRoot()
    const source = readSnapshot(args.from, root)
    const target = readSnapshot(args.to, root)
    const changes = diffSnapshots(source, target)
    const check = runChecks(source, target)
    const result: Explanation & {attached?: boolean} = await explain(changes, check, {
      offline: flags.offline,
      userStory: flags['user-story'],
    })

    this.log(bold(`Release explanation  ${args.from} -> ${args.to}`) + dim(`  (${result.source === 'copado-ai' ? 'Copado AI release agent' : 'built-in summary'})`))
    if (result.aiError) this.log(dim(`  Copado AI not used: ${result.aiError}`))
    this.log('')
    this.log(result.summary)
    this.log('')
    this.log(bold('Release note: ') + result.releaseNote)

    if (flags.attach && flags['user-story']) {
      const r = await attachToUserStory(flags['user-story'], `MC Ship release explanation (${args.from} -> ${args.to})\n\n${result.summary}\n\n${result.releaseNote}`)
      result.attached = r.ok
      this.log(r.ok ? `Attached to user story ${flags['user-story']}.` : `Could not attach to user story: ${r.error}`)
    }
    return result
  }
}
