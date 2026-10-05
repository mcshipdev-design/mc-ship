#!/usr/bin/env node
// Step 2 of the live test: change the release in mc/SRC (run inside your project).
// Adds a field to the test DE and uses it in the email, then you deploy again (update path).
import fs from 'node:fs'

const de = 'mc/SRC/dataextensions/MCShip_Test_DE.json'
const json = JSON.parse(fs.readFileSync(de, 'utf8'))
if (!json.fields.some((f) => f.name === 'ExpiryDate')) json.fields.push({name: 'ExpiryDate', type: 'Date'})
fs.writeFileSync(de, JSON.stringify(json, null, 2) + '\n')

const html = 'mc/SRC/content/MCShip_Test_Email.html'
let body = fs.readFileSync(html, 'utf8')
if (!body.includes('ExpiryDate')) {
  body = body
    .replace(']%%', '\n   SET @exp = Lookup("MCShip_Test_DE", "ExpiryDate", "SubscriberKey", _subscriberkey) ]%%')
    .replace('</p>', '</p>\n<p>Valid until %%=v(@exp)=%%</p>')
}
fs.writeFileSync(html, body)

const meta = 'mc/SRC/content/MCShip_Test_Email.json'
const m = JSON.parse(fs.readFileSync(meta, 'utf8'))
m.subject = 'MC Ship test email v2 (do not send)'
fs.writeFileSync(meta, JSON.stringify(m, null, 2) + '\n')
console.log('Step 2 applied: +ExpiryDate field, email v2')
