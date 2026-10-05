import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import {Args, Command, Flags} from '@oclif/core'

import {BuConfig, loadConfig, projectRoot, saveConfig, saveSecret} from '../../core/config.js'
import {clientFor, mockFile} from '../../core/sfmc.js'

export default class McConnect extends Command {
  static override description =
    'Connect a Marketing Cloud Business Unit. Live mode uses an installed package (server-to-server); the client secret is stored outside the project, never in Git. Mock mode stores the BU as local JSON for demos and CI.'

  static override examples = [
    'MCSHIP_CLIENT_SECRET=*** <%= config.bin %> <%= command.id %> DEV --subdomain mc563885gzs27c5t9 --account-id 510001234 --client-id abc123',
    '<%= config.bin %> <%= command.id %> PROD --mock --seed sample-project/mock/PROD.json',
  ]

  static override enableJsonFlag = true

  static override args = {
    bu: Args.string({description: 'Name you will use for this Business Unit, e.g. DEV or PROD', required: true}),
  }

  static override flags = {
    mock: Flags.boolean({description: 'Use a local JSON mock instead of a real BU'}),
    seed: Flags.string({description: 'Mock only: JSON file to load as the BU contents', dependsOn: ['mock']}),
    subdomain: Flags.string({description: 'Tenant subdomain (from the installed package auth URL)'}),
    'account-id': Flags.string({description: 'MID of the Business Unit'}),
    'client-id': Flags.string({description: 'Installed package client ID'}),
  }

  public async run(): Promise<{bu: string; mode: string; verified: boolean}> {
    const {args, flags} = await this.parse(McConnect)
    const root = projectRoot()
    const config = loadConfig(root)

    let bu: BuConfig
    if (flags.mock) {
      bu = {mode: 'mock'}
      if (flags.seed) {
        const target = mockFile(args.bu, root)
        fs.mkdirSync(path.dirname(target), {recursive: true})
        fs.copyFileSync(flags.seed, target)
      }
    } else {
      if (!flags.subdomain || !flags['account-id'] || !flags['client-id']) {
        this.error('Live mode needs --subdomain, --account-id and --client-id (or use --mock).')
      }
      bu = {mode: 'live', subdomain: flags.subdomain, accountId: flags['account-id'], clientId: flags['client-id']}
      const secret = process.env.MCSHIP_CLIENT_SECRET ?? (await askHidden(`Client secret for ${args.bu}: `))
      if (!secret) this.error('No client secret given.')
      saveSecret(bu, secret)
    }

    await clientFor(args.bu, bu, root).verify()
    config.bus[args.bu] = bu
    saveConfig(config, root)
    this.log(`Connected ${args.bu} (${bu.mode}). Next: agentia mc pull --bu ${args.bu}`)
    return {bu: args.bu, mode: bu.mode, verified: true}
  }
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true})
    const out = rl as unknown as {_writeToOutput: (s: string) => void; output: NodeJS.WriteStream}
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
    out._writeToOutput = (s: string) => {
      if (s.startsWith(question)) process.stdout.write(question)
    }
  })
}
