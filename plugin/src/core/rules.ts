import {blockReferences, deReferences, findCalls, literal} from './ampscript.js'
import {diffSnapshots} from './diff.js'
import {fieldChangesNeedingRebuild} from './sfmc.js'
import {AssetChange, CheckResult, ContentAsset, DataExtension, Finding, Snapshot} from './types.js'

export interface RuleContext {
  source: Snapshot
  target: Snapshot
  changes: AssetChange[]
  /** Content and DEs that will be shipped (added or changed) */
  shippedContent: ContentAsset[]
  shippedDes: DataExtension[]
  /** What the target BU will look like after the deploy */
  after: {dataExtensions: DataExtension[]; content: ContentAsset[]}
}

export interface Rule {
  id: string
  title: string
  run(ctx: RuleContext): Finding[]
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 1. Values that only make sense in the source BU */
export const hardcodedBuValues: Rule = {
  id: 'hardcoded-bu-values',
  title: 'No BU-specific IDs or MIDs in content',
  run(ctx) {
    const out: Finding[] = []
    for (const c of ctx.shippedContent) {
      for (const b of blockReferences(c.content).filter((r) => r.by === 'id')) {
        out.push({
          rule: this.id,
          severity: 'fail',
          asset: c.customerKey,
          message: `ContentBlockById(${b.value}) on line ${b.line}: asset IDs are different in every BU`,
          fix: 'Use ContentBlockByKey("<customer key>") and keep the same key in each BU',
        })
      }
      for (const r of deReferences(c.content).filter((x) => GUID.test(x.de))) {
        out.push({
          rule: this.id,
          severity: 'fail',
          asset: c.customerKey,
          message: `${r.fn} on line ${r.line} points at a DE by generated key "${r.de}"`,
          fix: 'Reference the Data Extension by its name or a stable customer key',
        })
      }
      if (ctx.source.mid && new RegExp(`\\b${ctx.source.mid}\\b`).test(c.content)) {
        out.push({
          rule: this.id,
          severity: 'fail',
          asset: c.customerKey,
          message: `Contains the source BU MID ${ctx.source.mid}`,
          fix: 'Use %%memberid%% or a lookup instead of a hardcoded MID',
        })
      }
    }
    return out
  },
}

/** 2. AMPscript lookups must point at DEs and fields that exist after the deploy */
export const brokenDeReference: Rule = {
  id: 'broken-de-reference',
  title: 'AMPscript lookups point at real DEs and fields',
  run(ctx) {
    const out: Finding[] = []
    for (const c of ctx.shippedContent) {
      for (const r of deReferences(c.content)) {
        if (GUID.test(r.de)) continue // reported by hardcoded-bu-values
        const de = findDe(ctx.after.dataExtensions, r.de)
        if (!de) {
          out.push({
            rule: this.id,
            severity: 'fail',
            asset: c.customerKey,
            message: `${r.fn}("${r.de}", ...) on line ${r.line}: DE "${r.de}" does not exist in ${ctx.target.bu}`,
            fix: `Add the DE to this release, or fix the name`,
          })
          continue
        }
        for (const f of r.fields) {
          if (!de.fields.some((x) => x.name.toLowerCase() === f.toLowerCase())) {
            out.push({
              rule: this.id,
              severity: 'fail',
              asset: c.customerKey,
              message: `${r.fn} on line ${r.line}: field "${f}" is not in DE "${de.name}" in ${ctx.target.bu}`,
              fix: `Add field "${f}" to "${de.name}" or correct the field name`,
            })
          }
        }
      }
    }
    return out
  },
}

/** 3. Every email needs an unsubscribe link and a physical address (CAN-SPAM, GDPR) */
export const emailFooter: Rule = {
  id: 'email-footer-compliance',
  title: 'Emails have unsubscribe link and physical address',
  run(ctx) {
    const out: Finding[] = []
    for (const c of ctx.shippedContent.filter((x) => x.assetType === 'htmlemail')) {
      const full = expandBlocks(c.content, ctx.after.content)
      if (!/unsub_center_url|%%unsub%%|subscription_center_url|profile_center_url|unsubscribe/i.test(full)) {
        out.push({
          rule: this.id,
          severity: 'fail',
          asset: c.customerKey,
          message: 'No unsubscribe link found (checked the email and the content blocks it includes)',
          fix: 'Add <a href="%%unsub_center_url%%">Unsubscribe</a> to the footer',
        })
      }
      if (!/%%member_(addr|busname|city|postalcode)%%/i.test(full)) {
        out.push({
          rule: this.id,
          severity: 'fail',
          asset: c.customerKey,
          message: 'No physical mailing address found',
          fix: 'Add %%Member_Busname%%, %%Member_Addr%%, %%Member_City%% to the footer',
        })
      }
    }
    return out
  },
}

/** 4. Personal data is typed, sendable and retained correctly */
export const piiAndSendability: Rule = {
  id: 'pii-and-sendability',
  title: 'Personal data fields are typed and retained correctly',
  run(ctx) {
    const out: Finding[] = []
    for (const de of ctx.shippedDes) {
      if (de.isSendable && de.sendableField && !de.fields.some((f) => f.name === de.sendableField)) {
        out.push({
          rule: this.id,
          severity: 'fail',
          asset: de.customerKey,
          message: `Sendable DE uses "${de.sendableField}" as send relationship, but that field does not exist`,
          fix: 'Point the send relationship at the subscriber key field',
        })
      }
      for (const f of de.fields) {
        if (/e-?mail/i.test(f.name) && f.type === 'Text') {
          out.push({
            rule: this.id,
            severity: 'warn',
            asset: de.customerKey,
            message: `Field "${f.name}" holds email addresses but is typed Text`,
            fix: 'Use the EmailAddress field type so SFMC validates it',
          })
        }
        if (/(phone|mobile)/i.test(f.name) && f.type === 'Text') {
          out.push({
            rule: this.id,
            severity: 'warn',
            asset: de.customerKey,
            message: `Field "${f.name}" holds phone numbers but is typed Text`,
            fix: 'Use the Phone field type',
          })
        }
      }
      const sensitive = de.fields.filter((f) => /(birth|dob|ssn|social_?sec|passport|national_?id|tax_?id)/i.test(f.name))
      if (sensitive.length && !de.retentionDays) {
        out.push({
          rule: this.id,
          severity: 'warn',
          asset: de.customerKey,
          message: `Sensitive fields (${sensitive.map((f) => f.name).join(', ')}) with no data retention policy`,
          fix: 'Set a row-based data retention period on this DE',
        })
      }
    }
    return out
  },
}

/** 5. Content blocks used by an email must exist in the target BU */
export const missingContentBlock: Rule = {
  id: 'missing-content-block',
  title: 'Referenced content blocks exist in target',
  run(ctx) {
    const out: Finding[] = []
    for (const c of ctx.shippedContent) {
      for (const b of blockReferences(c.content)) {
        if (b.by === 'key' && !ctx.after.content.some((x) => x.customerKey === b.value)) {
          out.push({
            rule: this.id,
            severity: 'fail',
            asset: c.customerKey,
            message: `ContentBlockByKey("${b.value}") on line ${b.line}: block not in ${ctx.target.bu} and not in this release`,
            fix: `Pull and include block "${b.value}" in the release`,
          })
        }
        if (b.by === 'name') {
          const leaf = b.value.split('\\').pop()
          if (!ctx.after.content.some((x) => x.name === leaf)) {
            out.push({
              rule: this.id,
              severity: 'warn',
              asset: c.customerKey,
              message: `ContentBlockByName("${b.value}") on line ${b.line}: no block named "${leaf}" found in ${ctx.target.bu}`,
              fix: 'Prefer ContentBlockByKey; folder paths often differ between BUs',
            })
          }
        }
      }
    }
    return out
  },
}

/** 6. Field changes the API cannot apply, on DEs that already hold data */
export const destructiveDeChange: Rule = {
  id: 'destructive-de-change',
  title: 'No breaking field changes on DEs with data',
  run(ctx) {
    const out: Finding[] = []
    for (const de of ctx.shippedDes) {
      const live = ctx.target.dataExtensions.find((d) => d.customerKey === de.customerKey)
      if (!live) continue
      const breaking = fieldChangesNeedingRebuild(live, de)
      if (!breaking.length) continue
      const rows = live.rowCount ?? 0
      out.push({
        rule: this.id,
        severity: rows > 0 ? 'fail' : 'warn',
        asset: de.customerKey,
        message: `${breaking.join('; ')} on a DE with ${rows.toLocaleString('en-US')} rows in ${ctx.target.bu}`,
        fix:
          rows > 0
            ? 'Add a new field instead, or plan a rebuild with a data backup'
            : 'DE is empty: rebuild it manually in the target, then redeploy',
      })
    }
    return out
  },
}

export const RULES: Rule[] = [
  hardcodedBuValues,
  brokenDeReference,
  emailFooter,
  piiAndSendability,
  missingContentBlock,
  destructiveDeChange,
]

export function buildContext(source: Snapshot, target: Snapshot): RuleContext {
  const changes = diffSnapshots(source, target)
  const shipKeys = new Set(changes.filter((c) => c.change === 'added' || c.change === 'changed').map((c) => `${c.kind}:${c.customerKey}`))
  const shippedDes = source.dataExtensions.filter((d) => shipKeys.has(`dataExtension:${d.customerKey}`))
  const shippedContent = source.content.filter((c) => shipKeys.has(`content:${c.customerKey}`))
  const merge = <T extends {customerKey: string}>(live: T[], shipped: T[]) => [
    ...live.filter((l) => !shipped.some((s) => s.customerKey === l.customerKey)),
    ...shipped,
  ]
  return {
    source,
    target,
    changes,
    shippedDes,
    shippedContent,
    after: {dataExtensions: merge(target.dataExtensions, shippedDes), content: merge(target.content, shippedContent)},
  }
}

export function runChecks(source: Snapshot, target: Snapshot, rules = RULES): CheckResult {
  const ctx = buildContext(source, target)
  const findings = rules.flatMap((r) => r.run(ctx))
  const status = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.length ? 'warn' : 'pass'
  return {from: source.bu, to: target.bu, status, findings, rulesRun: rules.map((r) => r.id)}
}

function findDe(list: DataExtension[], ref: string): DataExtension | undefined {
  const r = ref.toLowerCase()
  return list.find((d) => d.name.toLowerCase() === r) ?? list.find((d) => d.customerKey.toLowerCase() === r)
}

/** Inline ContentBlockByKey blocks (3 levels deep) so footer checks see the whole email */
function expandBlocks(src: string, content: ContentAsset[], depth = 0): string {
  if (depth > 3) return src
  const included = findCalls(src, ['ContentBlockByKey'])
    .map((c) => content.find((x) => x.customerKey === literal(c.args[0])))
    .filter((x): x is ContentAsset => Boolean(x))
  return [src, ...included.map((b) => expandBlocks(b.content, content, depth + 1))].join('\n')
}
