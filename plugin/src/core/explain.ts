import {askCopadoAi} from './agentia.js'
import {AssetChange, CheckResult} from './types.js'

export interface Explanation {
  risk: 'low' | 'medium' | 'high'
  source: 'copado-ai' | 'local'
  summary: string
  releaseNote: string
  aiError?: string
}

export function riskLevel(check: CheckResult): Explanation['risk'] {
  return check.status === 'fail' ? 'high' : check.status === 'warn' ? 'medium' : 'low'
}

export function buildPrompt(changes: AssetChange[], check: CheckResult): string {
  return [
    `You are reviewing a Salesforce Marketing Cloud release from Business Unit ${check.from} to ${check.to}.`,
    `Write for a marketing manager, not a developer. Plain English, short lines, no markdown tables.`,
    `Give: 1) Risk: low, medium or high and why in one line. 2) What could go wrong for customers if shipped as-is.`,
    `3) What to fix before deploying, as a short numbered list. 4) A 2-line release note.`,
    ``,
    `Changes:`,
    ...changes.map((c) => `- ${c.change} ${c.kind} ${c.name} (${c.customerKey})${c.details.length ? ': ' + c.details.join('; ') : ''}`),
    ``,
    `Policy check result: ${check.status.toUpperCase()}`,
    ...check.findings.map((f) => `- [${f.severity}] ${f.asset}: ${f.message}`),
  ].join('\n')
}

/** Deterministic explanation used offline or when Copado AI is not available. */
export function localExplanation(changes: AssetChange[], check: CheckResult): Explanation {
  const risk = riskLevel(check)
  const fails = check.findings.filter((f) => f.severity === 'fail')
  const warns = check.findings.filter((f) => f.severity === 'warn')
  const count = (k: string, t: string) => changes.filter((c) => c.kind === k && c.change === t).length
  const what = [
    `${count('content', 'added')} new and ${count('content', 'changed')} changed content assets`,
    `${count('dataExtension', 'added')} new and ${count('dataExtension', 'changed')} changed Data Extensions`,
  ].join(', ')

  const lines = [
    `Risk: ${risk.toUpperCase()}. ${
      risk === 'high'
        ? `${fails.length} blocking issue(s) would break sends or lose data.`
        : risk === 'medium'
          ? `No blockers, ${warns.length} warning(s) to review.`
          : 'All policy checks pass.'
    }`,
    `Release: ${check.from} -> ${check.to}. ${what}.`,
  ]
  if (fails.length) {
    lines.push('', 'Fix before deploying:')
    fails.forEach((f, i) => lines.push(`${i + 1}. ${f.asset}: ${f.message}${f.fix ? ` -> ${f.fix}` : ''}`))
  }
  if (warns.length) {
    lines.push('', 'Review:')
    warns.forEach((f) => lines.push(`- ${f.asset}: ${f.message}`))
  }
  const shipped = changes.filter((c) => c.change === 'added' || c.change === 'changed').map((c) => c.name)
  const releaseNote = `${check.to} release: ${shipped.join(', ') || 'no changes'}. Policy check: ${check.status.toUpperCase()} (${check.findings.length} finding(s)).`
  return {risk, source: 'local', summary: lines.join('\n'), releaseNote}
}

export async function explain(
  changes: AssetChange[],
  check: CheckResult,
  opts: {offline?: boolean; userStory?: string} = {},
): Promise<Explanation> {
  const local = localExplanation(changes, check)
  if (opts.offline) return local
  const ai = await askCopadoAi(buildPrompt(changes, check), opts.userStory)
  if (!ai.ok || !ai.data) return {...local, aiError: ai.error}
  return {...local, source: 'copado-ai', summary: ai.data.trim()}
}
