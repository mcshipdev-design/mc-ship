import {AssetChange, Automation, ContentAsset, DataExtension, QueryActivity, Snapshot} from './types.js'

/** Compare a source snapshot (what we want) with a target snapshot (what is live). */
export function diffSnapshots(source: Snapshot, target: Snapshot, opts: {includeUnchanged?: boolean} = {}): AssetChange[] {
  const changes: AssetChange[] = [
    ...diffList(source.dataExtensions, target.dataExtensions, 'dataExtension', deDetails),
    ...diffList(source.content, target.content, 'content', contentDetails),
    ...diffList(source.queries ?? [], target.queries ?? [], 'query', queryDetails),
    ...diffList(source.automations ?? [], target.automations ?? [], 'automation', automationDetails),
  ]
  return opts.includeUnchanged ? changes : changes.filter((c) => c.change !== 'unchanged')
}

type Diffable = DataExtension | ContentAsset | QueryActivity | Automation

function diffList<T extends Diffable>(
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
      out.push({
        kind,
        customerKey: t.customerKey,
        name: t.name,
        change: 'removed',
        details: [kind === 'automation' ? 'only in target' : 'only in target; never deleted by MC Ship'],
      })
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

function queryDetails(s: QueryActivity, t: QueryActivity): string[] {
  const d: string[] = []
  if (s.name !== t.name) d.push(`name "${t.name}" -> "${s.name}"`)
  if (s.targetKey !== t.targetKey) d.push(`target DE ${t.targetKey} -> ${s.targetKey}`)
  if (s.updateType !== t.updateType) d.push(`data action ${t.updateType} -> ${s.updateType}`)
  if (normaliseSql(s.sql) !== normaliseSql(t.sql)) {
    const a = lines(t.sql)
    const b = lines(s.sql)
    d.push(`SQL changed (+${b.filter((l) => !a.includes(l)).length} / -${a.filter((l) => !b.includes(l)).length} lines)`)
  }
  return d
}

function automationDetails(s: Automation, t: Automation): string[] {
  const d: string[] = []
  if (s.name !== t.name) d.push(`name "${t.name}" -> "${s.name}"`)
  if ((s.status ?? '') !== (t.status ?? '')) d.push(`status ${t.status ?? '-'} -> ${s.status ?? '-'}`)
  const stepText = (a: Automation, n: number) =>
    (a.steps.find((x) => x.step === n)?.activities ?? []).map((x) => `${x.type}:${x.key ?? x.name}`).join(', ')
  const steps = [...new Set([...s.steps, ...t.steps].map((x) => x.step))].sort((x, y) => x - y)
  for (const n of steps) {
    const before = stepText(t, n)
    const after = stepText(s, n)
    if (before !== after) d.push(`step ${n}: ${before || '(none)'} -> ${after || '(none)'}`)
  }
  return d
}

/** SQL compared ignoring whitespace differences */
function normaliseSql(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
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
