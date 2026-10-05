#!/usr/bin/env node
// Applies the fixes shown in the demo to mc/DEV (run inside the demo project).
// In the video, make these edits by hand in your editor; this script is for rehearsals.
import fs from 'node:fs'

const edit = (file, fn) => fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')))
const editJson = (file, fn) => edit(file, (s) => JSON.stringify(fn(JSON.parse(s)), null, 2) + '\n')

// 1. Hardcoded asset ID -> stable customer key
edit('mc/DEV/content/spring-promo-email.html', (s) => s.replace('ContentBlockById(48211)', 'ContentBlockByKey("brand-header")'))

// 2. The lookup needs a PromoBanner field: add it to the new DE
editJson('mc/DEV/dataextensions/Spring_Promo_Offers.json', (de) => {
  de.fields.push({name: 'PromoBanner', type: 'Text', length: 500})
  return de
})

// 3. Footer gets an unsubscribe link
edit('mc/DEV/content/promo-footer.html', (s) =>
  s.replace('%%Member_PostalCode%%', '%%Member_PostalCode%%<br>\n  <a href="%%unsub_center_url%%">Unsubscribe</a>'),
)

// 4. Keep Points as Number (48k rows in PROD); fix PII typing and retention
editJson('mc/DEV/dataextensions/Loyalty_Members.json', (de) => {
  de.fields = de.fields.map((f) => {
    if (f.name === 'Points') return {name: 'Points', type: 'Number'}
    if (f.name === 'PersonalEmail') return {...f, type: 'EmailAddress'}
    return f
  })
  de.retentionDays = 730
  return de
})
console.log('Applied 4 fixes to mc/DEV')
