import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface BuConfig {
  /** live = real Marketing Cloud APIs, mock = local JSON file (demos, tests, CI) */
  mode: 'live' | 'mock'
  /** Tenant subdomain, e.g. mc563885gzs27c5t9-63k636ttgm */
  subdomain?: string
  /** MID of the Business Unit */
  accountId?: string
  clientId?: string
}

export interface ProjectConfig {
  /** Folder (relative to project root) where pulled assets are stored */
  srcDir: string
  bus: Record<string, BuConfig>
}

const DEFAULT_CONFIG: ProjectConfig = {srcDir: 'mc', bus: {}}

export function projectRoot(start = process.cwd()): string {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.mcship', 'config.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(start)
    dir = parent
  }
}

export function configPath(root = projectRoot()): string {
  return path.join(root, '.mcship', 'config.json')
}

export function loadConfig(root = projectRoot()): ProjectConfig {
  const file = configPath(root)
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_CONFIG)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProjectConfig>
  return {...DEFAULT_CONFIG, ...parsed, bus: parsed.bus ?? {}}
}

export function saveConfig(config: ProjectConfig, root = projectRoot()): void {
  const file = configPath(root)
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
}

export function requireBu(config: ProjectConfig, bu: string): BuConfig {
  const found = config.bus[bu]
  if (!found) {
    const known = Object.keys(config.bus)
    throw new Error(
      `Business Unit "${bu}" is not connected. ` +
        (known.length ? `Connected: ${known.join(', ')}. ` : '') +
        `Run: agentia mc connect ${bu}`,
    )
  }
  return found
}

// ---- Secrets: kept outside the project so they never reach Git ----

function credentialsFile(): string {
  return process.env.MCSHIP_CREDENTIALS_FILE ?? path.join(os.homedir(), '.mcship', 'credentials.json')
}

function secretKey(bu: BuConfig): string {
  return `${bu.subdomain}:${bu.accountId}:${bu.clientId}`
}

export function saveSecret(bu: BuConfig, secret: string): void {
  const file = credentialsFile()
  fs.mkdirSync(path.dirname(file), {recursive: true})
  const all = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>) : {}
  all[secretKey(bu)] = secret
  fs.writeFileSync(file, JSON.stringify(all, null, 2), {mode: 0o600})
}

export function loadSecret(buName: string, bu: BuConfig): string {
  const envName = `MCSHIP_SECRET_${buName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  if (process.env[envName]) return process.env[envName] as string
  const file = credentialsFile()
  if (fs.existsSync(file)) {
    const all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    const secret = all[secretKey(bu)]
    if (secret) return secret
  }
  throw new Error(`No client secret for BU "${buName}". Set ${envName} or run: agentia mc connect ${buName}`)
}
