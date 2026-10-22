import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {blockReferences, deReferences} from '../dist/core/ampscript.js'
import {diffSnapshots} from '../dist/core/diff.js'
import {localExplanation} from '../dist/core/explain.js'
import {RULES, runChecks} from '../dist/core/rules.js'
import {answerText} from '../dist/core/agentia.js'
import {tableRefs, usesSelectStar} from '../dist/core/sql.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const seed = (bu) => JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'sample-project', 'seed', `${bu}.json`), 'utf8'))
const ids = (r) => r.findings.map((f) => `${f.severity}:${f.rule}:${f.asset}`).sort()

test('AMPscript parser finds DEs, fields and blocks', () => {
  const src = `%%[ SET @a = Lookup("Offers", "Code", "SubscriberKey", @sk)
  SET @rows = LookupRows('Loyalty', 'Tier', 'Gold')
  SET @x = lookuporderedrows("Hist", 5, "Date desc", "SubscriberKey", @sk) ]%%
  %%=ContentBlockByKey("footer")=%% %%=ContentBlockById(123)=%% %%=ContentBlockByName("Content Builder\\Blocks\\Header")=%%`
  assert.deepEqual(
    deReferences(src).map((r) => [r.fn, r.de, r.fields]),
    [
      ['Lookup', 'Offers', ['Code', 'SubscriberKey']],
      ['LookupRows', 'Loyalty', ['Tier']],
      ['LookupOrderedRows', 'Hist', ['SubscriberKey']],
    ],
  )
  assert.deepEqual(
    blockReferences(src).map((b) => [b.by, b.value]),
    [
      ['key', 'footer'],
      ['id', '123'],
      ['name', 'Content Builder\\Blocks\\Header'],
    ],
  )
})

test('parser handles nested calls, commas in strings and doubled quotes', () => {
  const src = `Lookup("My, ""odd"" DE", Concat("a", "b"), "Key", Lowercase(@k))`
  const [r] = deReferences(src)
  assert.equal(r.de, 'My, "odd" DE')
  assert.deepEqual(r.fields, ['Key'])
})

test('diff reports added, changed and field-level changes', () => {
  const changes = diffSnapshots(seed('DEV'), seed('PROD'))
  assert.deepEqual(
    changes.map((c) => `${c.change}:${c.customerKey}`).sort(),
    [
      'added:Spring_Promo_Offers',
      'added:promo-footer',
      'added:spring-promo-audience',
      'added:spring-promo-daily',
      'added:spring-promo-email',
      'changed:Loyalty_Members',
    ],
  )
  const loyalty = changes.find((c) => c.customerKey === 'Loyalty_Members')
  assert.ok(loyalty.details.includes('~ field Points type Number -> Text'))
})

test('sample release fails with the six expected findings', () => {
  const r = runChecks(seed('DEV'), seed('PROD'))
  assert.equal(r.status, 'fail')
  assert.equal(r.rulesRun.length, 11)
  assert.deepEqual(ids(r), [
    'fail:broken-de-reference:spring-promo-email',
    'fail:destructive-de-change:Loyalty_Members',
    'fail:email-footer-compliance:spring-promo-email',
    'fail:hardcoded-bu-values:spring-promo-email',
    'warn:pii-and-sendability:Loyalty_Members',
    'warn:pii-and-sendability:Loyalty_Members',
  ])
})

test('every rule has a failing sample and can pass', () => {
  const dev = seed('DEV')
  const prod = seed('PROD')
  // The sample's queries and automations are clean; each Automation Studio rule gets its own broken copy
  const broken = automationSamples(dev)
  for (const rule of RULES) {
    if (broken[rule.id]) {
      assert.equal(runChecks(dev, prod, [rule]).findings.length, 0, `${rule.id} passes on the sample`)
      assert.ok(runChecks(broken[rule.id], prod, [rule]).findings.length > 0, `${rule.id} should flag its broken sample`)
      continue
    }
    const r = runChecks(dev, prod, [rule])
    if (rule.id === 'missing-content-block') {
      // promo-footer ships in the same release, so nothing is missing
      assert.equal(r.findings.length, 0)
      const noFooter = {...dev, content: dev.content.filter((c) => c.customerKey !== 'promo-footer')}
      assert.equal(runChecks(noFooter, prod, [rule]).findings.length, 1, rule.id)
    } else assert.ok(r.findings.length > 0, `${rule.id} should flag the sample`)
  }
  // identical BUs ship nothing -> pass
  assert.equal(runChecks(prod, prod).status, 'pass')
})

test('breaking change on an empty DE is only a warning', () => {
  const prod = seed('PROD')
  const empty = {...prod, dataExtensions: prod.dataExtensions.map((d) => ({...d, rowCount: 0}))}
  const r = runChecks(seed('DEV'), empty, RULES.filter((x) => x.id === 'destructive-de-change'))
  assert.equal(r.findings[0].severity, 'warn')
})

test('MID in content is flagged', () => {
  const dev = seed('DEV')
  dev.content = dev.content.map((c) => (c.customerKey === 'spring-promo-email' ? {...c, content: c.content + '\n<!-- mid 510000101 -->'} : c))
  const r = runChecks(dev, seed('PROD'), RULES.filter((x) => x.id === 'hardcoded-bu-values'))
  assert.ok(r.findings.some((f) => f.message.includes('510000101')))
})

test('local explanation is high risk and lists fixes', () => {
  const dev = seed('DEV')
  const prod = seed('PROD')
  const e = localExplanation(diffSnapshots(dev, prod), runChecks(dev, prod))
  assert.equal(e.risk, 'high')
  assert.match(e.summary, /Fix before deploying/)
  assert.match(e.releaseNote, /Spring Promo Email/)
})

test('answerText reads common Copado AI response shapes', () => {
  assert.equal(answerText({answer: 'a'}), 'a')
  assert.equal(answerText({result: {message: {content: 'b'}}}), undefined) // result is unwrapped by runAgentia
  assert.equal(answerText({message: {content: 'b'}}), 'b')
  assert.equal(answerText({messages: [{content: 'x'}, {content: 'y'}]}), 'y')
})

/** One broken copy of DEV per Automation Studio rule */
function automationSamples(dev) {
  const withQuery = (patch) => ({
    ...dev,
    queries: dev.queries.map((q) => (q.customerKey === 'spring-promo-audience' ? {...q, ...patch} : q)),
  })
  return {
    'query-target-exists': withQuery({targetKey: 'Spring_Promo_Winners', targetName: 'Spring_Promo_Winners'}),
    'query-de-reference': withQuery({sql: 'SELECT l.SubscriberKey FROM Loyalty_Members l JOIN [Loyalty Tiers] t ON t.Tier = l.Tier'}),
    'query-update-needs-key': {
      ...withQuery({updateType: 'Update'}),
      dataExtensions: dev.dataExtensions.map((d) =>
        d.customerKey === 'Spring_Promo_Offers' ? {...d, fields: d.fields.map((f) => ({...f, isPrimaryKey: false}))} : d,
      ),
    },
    'query-select-star': withQuery({sql: 'SELECT * FROM Loyalty_Members'}),
    'automation-missing-query': {...dev, queries: dev.queries.filter((q) => q.customerKey !== 'spring-promo-audience')},
  }
}

test('SQL reader finds DEs, skips comments, strings, data views and ENT', () => {
  const sql = `/* FROM Fake_One */
SELECT s.SubscriberKey, 'from Fake_Two' AS Note
FROM [Spring Promo Offers] o
INNER JOIN ENT.Shared_Prefs p ON p.Key = o.Key
LEFT JOIN _Sent x ON x.SubscriberKey = o.SubscriberKey -- join Fake_Three
JOIN Loyalty_Members l ON l.SubscriberKey = o.SubscriberKey`
  const refs = tableRefs(sql)
  assert.deepEqual(
    refs.map((r) => [r.name, r.ent, r.systemView, r.line]),
    [
      ['Spring Promo Offers', false, false, 3],
      ['Shared_Prefs', true, false, 4],
      ['_Sent', false, true, 5],
      ['Loyalty_Members', false, false, 6],
    ],
  )
  assert.equal(usesSelectStar('select top 10 * from A'), true)
  assert.equal(usesSelectStar('SELECT a.* FROM A a'), true)
  assert.equal(usesSelectStar("SELECT a.Id, '*' AS x FROM A a"), false)
})

test('diff covers SQL queries and automations', () => {
  const dev = seed('DEV')
  const prod = seed('PROD')
  const kinds = diffSnapshots(dev, prod).filter((c) => c.kind === 'query' || c.kind === 'automation')
  assert.deepEqual(
    kinds.map((c) => `${c.change}:${c.kind}:${c.customerKey}`),
    ['added:query:spring-promo-audience', 'added:automation:spring-promo-daily'],
  )
  const changed = {
    ...prod,
    queries: prod.queries.map((q) => ({...q, sql: q.sql.replace("'active'", "'held'"), updateType: 'Overwrite'})),
    automations: prod.automations.map((a) => ({...a, status: 'Paused'})),
  }
  const d = diffSnapshots(changed, prod)
  assert.deepEqual(d.find((c) => c.kind === 'query').details, ['data action Update -> Overwrite', 'SQL changed (+1 / -1 lines)'])
  assert.deepEqual(d.find((c) => c.kind === 'automation').details, ['status Scheduled -> Paused'])
  // whitespace-only SQL edits are not a change
  const spaced = {...prod, queries: prod.queries.map((q) => ({...q, sql: q.sql.replace(/\n/g, '\n\n  ')}))}
  assert.equal(diffSnapshots(spaced, prod).length, 0)
})
