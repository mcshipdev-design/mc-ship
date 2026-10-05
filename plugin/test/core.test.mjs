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
    ['added:Spring_Promo_Offers', 'added:promo-footer', 'added:spring-promo-email', 'changed:Loyalty_Members'],
  )
  const loyalty = changes.find((c) => c.customerKey === 'Loyalty_Members')
  assert.ok(loyalty.details.includes('~ field Points type Number -> Text'))
})

test('sample release fails with the six expected findings', () => {
  const r = runChecks(seed('DEV'), seed('PROD'))
  assert.equal(r.status, 'fail')
  assert.equal(r.rulesRun.length, 6)
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
  for (const rule of RULES) {
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
