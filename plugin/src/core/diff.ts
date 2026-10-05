import {AssetChange, ContentAsset, DataExtension, Snapshot} from './types.js'

/** Compare a source snapshot (what we want) with a target snapshot (what is live). */
export function diffSnapshots(source: Snapshot, target: Snapshot, opts: {includeUnchanged?: boolean} = {}): AssetChange[] {
  const changes: AssetChange[] = [
    ...diffList(source.dataExtensions, target.dataExtensions, 'dataExtension', deDetails),
    ...diffList(source.content, target.content, 'content', contentDetails),
  ]
  return opts.includeUnchanged ? changes : changes.filter((c) => c.change !== 'unchanged')
}

function diffList<T extends DataExtension | ContentAsset>(
  src: T[],
  tgt: T[],
  kind: T['kind'],
  details: (a: T, b: T) => string[],
): AssetChange[] {
  const out: AssetChange[] = []
  const tgtByKey = new Map(tgt.map((t) => [t.customerKey, t]))
  for (const s of src) {
    const t = tgtByKey.get(s.customerKey)
    if (!t) {
      out.push({kind, customerKey: s.customerKey, name: s.name, change: 'added', details: []})
      continue
    }
    const d = details(s, t)
    out.push({kind, customerKey: s.customerKey, name: s.name, change: d.length ? 'changed' : 'unchanged', details: d})
  }
  const srcKeys = new Set(src.map((s) => s.customerKey))
  for (const t of tgt) {
    if (!srcKeys.has(t.customerKey)) {
      out.push({kind, customerKey: t.customerKey, name: t.name, change: 'removed', details: ['only in target; never deleted by MC Ship']})
    }
  }
  return out
}

function deDetails(s: DataExtension, t: DataExtension): string[] {
  const d: string[] = []
  if (s.name !== t.name) d.push(`name "${t.name}" -> "${s.name}"`)
  if (Boolean(s.isSendable) !== Boolean(t.isSendable)) d.push(`sendable ${Boolean(t.isSendable)} -> ${Boolean(s.isSendable)}`)
  if (s.retentionDays !== t.retentionDays) d.push(`retention ${t.retentionDays ?? 'none'} -> ${s.retentionDays ?? 'none'} days`)
  for (const f of s.fields) {
    const o = t.fields.find((x) => x.name === f.name)
    if (!o) {
      d.push(`+ field ${f.name} (${f.type}${f.length ? `(${f.length})` : ''})`)
      continue
    }
    if (o.type !== f.type) d.push(`~ field ${f.name} type ${o.type} -> ${f.type}`)
    if ((o.length ?? 0) !== (f.length ?? 0)) d.push(`~ field ${f.name} length ${o.length ?? '-'} -> ${f.length ?? '-'}`)
    if (Boolean(o.isPrimaryKey) !== Boolean(f.isPrimaryKey)) d.push(`~ field ${f.name} primary key ${Boolean(o.isPrimaryKey)} -> ${Boolean(f.isPrimaryKey)}`)
  }
  for (const o of t.fields) if (!s.fields.some((f) => f.name === o.name)) d.push(`- field ${o.name}`)
  return d
}

function contentDetails(s: ContentAsset, t: ContentAsset): string[] {
  const d: string[] = []
  if (s.name !== t.name) d.push(`name "${t.name}" -> "${s.name}"`)
  if ((s.subject ?? '') !== (t.subject ?? '')) d.push(`subject "${t.subject ?? ''}" -> "${s.subject ?? ''}"`)
  if (normalise(s.content) !== normalise(t.content)) {
    const a = lines(t.content)
    const b = lines(s.content)
    const added = b.filter((l) => !a.includes(l)).length
    const removed = a.filter((l) => !b.includes(l)).length
    d.push(`body changed (+${added} / -${removed} lines)`)
  }
  return d
}

function normalise(s: string): string {
  return s.replace(/\r\n/g, '\n').trim()
}

function lines(s: string): string[] {
  return normalise(s)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}
