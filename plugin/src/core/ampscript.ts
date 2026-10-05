/**
 * Just enough AMPscript parsing to find the Data Extensions, fields and
 * content blocks an email depends on. Only string-literal arguments are
 * resolved; variables are reported as "dynamic" and skipped.
 */

export interface FunctionCall {
  name: string
  args: string[]
  /** 1-based line number in the asset body */
  line: number
}

export interface DeReference {
  fn: string
  de: string
  fields: string[]
  line: number
}

export interface BlockReference {
  by: 'key' | 'name' | 'id'
  value: string
  line: number
}

export function findCalls(src: string, names: string[]): FunctionCall[] {
  const out: FunctionCall[] = []
  const re = new RegExp(`\\b(${names.join('|')})\\s*\\(`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length
    const args = splitArgs(src, start)
    if (!args) continue
    const canonical = names.find((n) => n.toLowerCase() === m![1].toLowerCase()) ?? m[1]
    out.push({name: canonical, args, line: src.slice(0, m.index).split('\n').length})
  }
  return out
}

/** Split a call's arguments starting right after "(" up to the matching ")". */
function splitArgs(src: string, start: number): string[] | undefined {
  const args: string[] = []
  let depth = 0
  let quote: string | undefined
  let cur = ''
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      cur += ch
      if (ch === quote) {
        // AMPscript escapes a quote by doubling it
        if (src[i + 1] === quote) cur += src[++i]
        else quote = undefined
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '(') {
      depth++
      cur += ch
    } else if (ch === ')') {
      if (depth === 0) {
        if (cur.trim() || args.length) args.push(cur.trim())
        return args
      }
      depth--
      cur += ch
    } else if (ch === ',' && depth === 0) {
      args.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  return undefined
}

/** "Name" or 'Name' -> Name; anything else (variables, expressions) -> undefined */
export function literal(arg: string | undefined): string | undefined {
  if (!arg) return undefined
  const m = /^(["'])([\s\S]*)\1$/.exec(arg.trim())
  return m ? m[2].split(m[1] + m[1]).join(m[1]) : undefined
}

const DE_FUNCTIONS = [
  'Lookup',
  'LookupRows',
  'LookupRowsCS',
  'LookupOrderedRows',
  'LookupOrderedRowsCS',
  'ClaimRow',
  'ClaimRowValue',
  'DataExtensionRowCount',
  'InsertDE',
  'UpdateDE',
  'UpsertDE',
  'DeleteDE',
  'InsertData',
  'UpdateData',
  'UpsertData',
  'DeleteData',
]

/** Argument positions (0-based) that hold field names, per function. */
function fieldArgs(fn: string, args: string[]): string[] {
  const pick = (from: number, step = 2) => {
    const out: string[] = []
    for (let i = from; i < args.length; i += step) {
      const v = literal(args[i])
      if (v) out.push(v)
    }
    return out
  }
  switch (fn) {
    case 'Lookup':
      // Lookup(de, returnField, matchField1, matchValue1, ...)
      return [literal(args[1]), ...pick(2)].filter((x): x is string => Boolean(x))
    case 'LookupRows':
    case 'LookupRowsCS':
      // LookupRows(de, matchField1, matchValue1, ...)
      return pick(1)
    case 'LookupOrderedRows':
    case 'LookupOrderedRowsCS':
      // LookupOrderedRows(de, count, sort, matchField1, matchValue1, ...)
      return pick(3)
    default:
      return []
  }
}

export function deReferences(src: string): DeReference[] {
  return findCalls(src, DE_FUNCTIONS)
    .map((c) => ({fn: c.name, de: literal(c.args[0]) ?? '', fields: fieldArgs(c.name, c.args), line: c.line}))
    .filter((r) => r.de)
}

export function blockReferences(src: string): BlockReference[] {
  return findCalls(src, ['ContentBlockByKey', 'ContentBlockByName', 'ContentBlockById']).map((c) => {
    const by = c.name === 'ContentBlockByKey' ? 'key' : c.name === 'ContentBlockByName' ? 'name' : 'id'
    return {by, value: literal(c.args[0]) ?? c.args[0] ?? '', line: c.line}
  })
}
