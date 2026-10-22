/**
 * Just enough SQL reading for release checks on Marketing Cloud Query Activities:
 * which Data Extensions a query reads, and whether it uses SELECT *.
 */

export interface TableRef {
  /** Data Extension name as written, without brackets or the ENT. prefix */
  name: string
  /** ENT.<name>: a DE in the parent (Enterprise) BU */
  ent: boolean
  /** System data views such as _Sent, _Open, _Subscribers */
  systemView: boolean
  line: number
}

/** Remove comments and string literals so they cannot look like table names. */
export function stripSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''")
}

const TABLE = /\b(from|join)\s+((?:ent\s*\.\s*)?)(\[[^\]]+\]|[A-Za-z0-9_]+)/gi

export function tableRefs(sql: string): TableRef[] {
  const clean = stripSql(sql)
  const out: TableRef[] = []
  for (const m of clean.matchAll(TABLE)) {
    const raw = m[3]
    const name = raw.startsWith('[') ? raw.slice(1, -1).trim() : raw
    const line = clean.slice(0, m.index).split('\n').length
    out.push({name, ent: Boolean(m[2]), systemView: name.startsWith('_'), line})
  }
  return out
}

/** True when the query uses SELECT * (or alias.*), which breaks when DE fields change. */
export function usesSelectStar(sql: string): boolean {
  return /\bselect\s+(?:distinct\s+)?(?:top\s+\d+\s+(?:percent\s+)?)?(?:[\w\]\[]+\s*\.\s*)?\*/i.test(stripSql(sql))
}
