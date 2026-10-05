import {Args, Command, Flags} from '@oclif/core'

import {projectRoot} from '../../core/config.js'
import {checkLines} from '../../core/format.js'
import {RULES, runChecks} from '../../core/rules.js'
import {readSnapshot} from '../../core/store.js'
import {CheckResult} from '../../core/types.js'

export default class McCheck extends Command {
  static override description =
    'Run MC Ship policy checks on a release before it ships: hardcoded BU values, broken AMPscript lookups, footer compliance, PII typing and retention, missing content blocks, breaking DE changes. Exits 1 on failure, so it can gate CI.'

  static override examples = ['<%= config.bin %> <%= command.id %> DEV PROD', '<%= config.bin %> <%= command.id %> DEV PROD --fail-on warn --json']

  static override enableJsonFlag = true

  static override args = {
    from: Args.string({description: 'Source BU (local files)', required: true}),
    to: Args.string({description: 'Target BU', required: true}),
  }

  static override flags = {
    'fail-on': Flags.string({description: 'Lowest severity that fails the check', options: ['fail', 'warn'], default: 'fail'}),
    rule: Flags.string({description: `Run only these rules: ${RULES.map((r) => r.id).join(', ')}`, multiple: true}),
  }

  public async run(): Promise<CheckResult> {
    const {args, flags} = await this.parse(McCheck)
    const root = projectRoot()
    const rules = flags.rule?.length ? RULES.filter((r) => flags.rule!.includes(r.id)) : RULES
    const result = runChecks(readSnapshot(args.from, root), readSnapshot(args.to, root), rules)
    for (const l of checkLines(result)) this.log(l)
    if (result.status === 'fail' || (flags['fail-on'] === 'warn' && result.status === 'warn')) process.exitCode = 1
    return result
  }
}
