import fs from 'node:fs'
import path from 'node:path'

import {loadConfig, projectRoot} from './config.js'
import {ContentAsset, DataExtension, Snapshot} from './types.js'

/**
 * Pulled assets live in Git as readable files:
 *   mc/<BU>/_bu.json
 *   mc/<BU>/dataextensions/<key>.json
 *   mc/<BU>/content/<key>.json   (metadata)
 *   mc/<BU>/content/<key>.html   (HTML + AMPscript body)
 */
export function buDir(bu: string, root = projectRoot()): string {
  return path.join(root, loadConfig(root).srcDir, bu)
}

function safe(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function writeSnapshot(s: Snapshot, root = projectRoot()): {dir: string; files: number} {
  const dir = buDir(s.bu, root)
  fs.rmSync(dir, {recursive: true, force: true})
  fs.mkdirSync(path.join(dir, 'dataextensions'), {recursive: true})
  fs.mkdirSync(path.join(dir, 'content'), {recursive: true})
  fs.writeFileSync(path.join(dir, '_bu.json'), JSON.stringify({bu: s.bu, mid: s.mid, pulledAt: s.pulledAt}, null, 2) + '\n')
  let files = 1
  for (const de of sortByKey(s.dataExtensions)) {
    fs.writeFileSync(path.join(dir, 'dataextensions', `${safe(de.customerKey)}.json`), JSON.stringify(de, null, 2) + '\n')
    files++
  }
  for (const c of sortByKey(s.content)) {
    const {content, ...meta} = c
    fs.writeFileSync(path.join(dir, 'content', `${safe(c.customerKey)}.json`), JSON.stringify(meta, null, 2) + '\n')
    fs.writeFileSync(path.join(dir, 'content', `${safe(c.customerKey)}.html`), content)
    files += 2
  }
  return {dir, files}
}

export function readSnapshot(bu: string, root = projectRoot()): Snapshot {
  const dir = buDir(bu, root)
  if (!fs.existsSync(dir)) {
    throw new Error(`No local copy of BU "${bu}". Run: agentia mc pull --bu ${bu}`)
  }
  const meta = readJson<{bu: string; mid?: string; pulledAt?: string}>(path.join(dir, '_bu.json'), {bu})
  const dataExtensions = listJson(path.join(dir, 'dataextensions')).map((f) => readJson<DataExtension>(f))
  const content = listJson(path.join(dir, 'content')).map((f) => {
    const m = readJson<Omit<ContentAsset, 'content'>>(f)
    const html = f.replace(/\.json$/, '.html')
    return {...m, content: fs.existsSync(html) ? fs.readFileSync(html, 'utf8') : ''} as ContentAsset
  })
  return {bu, mid: meta.mid, pulledAt: meta.pulledAt, dataExtensions, content}
}

function listJson(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(dir, f))
}

function readJson<T>(file: string, fallback?: T): T {
  if (!fs.existsSync(file) && fallback !== undefined) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function sortByKey<T extends {customerKey: string}>(list: T[]): T[] {
  return [...list].sort((a, b) => a.customerKey.localeCompare(b.customerKey))
}

// ---- audit log: one JSON line per deploy, committed with the assets ----
export function appendAudit(entry: Record<string, unknown>, root = projectRoot()): string {
  const file = path.join(root, loadConfig(root).srcDir, 'audit.log.jsonl')
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.appendFileSync(file, JSON.stringify(entry) + '\n')
  return file
}
