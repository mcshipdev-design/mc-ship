import {AssetChange, CheckResult} from './types.js'

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code: number) => (s: string) => (tty ? `\u001B[${code}m${s}\u001B[0m` : s)
export const green = paint(32)
export const red = paint(31)
export const yellow = paint(33)
export const dim = paint(2)
export const bold = paint(1)

export function changeLines(changes: AssetChange[]): string[] {
  if (!changes.length) return [dim('  No differences.')]
  const sym: Record<string, string> = {added: green('+'), changed: yellow('~'), removed: red('-'), unchanged: ' '}
  const out: string[] = []
  for (const c of changes) {
    const kind = c.kind === 'dataExtension' ? 'DE     ' : 'Content'
    out.push(`  ${sym[c.change]} ${kind}  ${c.name} ${dim(`(${c.customerKey})`)}  ${dim(c.change)}`)
    for (const d of c.details) out.push(dim(`        ${d}`))
  }
  return out
}

export function checkLines(r: CheckResult): string[] {
  const out: string[] = []
  const badge = r.status === 'pass' ? green('PASS') : r.status === 'warn' ? yellow('WARN') : red('FAIL')
  out.push(`${bold('MC Ship policy check')}  ${r.from} -> ${r.to}  ${badge}`)
  out.push(dim(`  ${r.rulesRun.length} rules run, ${r.findings.length} finding(s)`))
  for (const f of r.findings) {
    const s = f.severity === 'fail' ? red('FAIL') : yellow('WARN')
    out.push(`  ${s}  ${bold(f.asset)}  ${dim(`[${f.rule}]`)}`)
    out.push(`        ${f.message}`)
    if (f.fix) out.push(dim(`        fix: ${f.fix}`))
  }
  return out
}
