import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Address } from '@ton/core'
import { lookup, parseCsv, colLetter } from '../src/sheets.ts'
import { parseIcs, relevantMeeting, contextTerms } from '../src/calendar.ts'
import { poisonedTwin } from '../src/demo.ts'
import { looksAlike } from '../src/scam.ts'
import { pcmToWav } from '../src/stt.ts'

const grids = [
  { tab: 'Deals', rows: parseCsv(readFileSync('data/deals.csv', 'utf8')) },
  { tab: 'Metrics', rows: parseCsv(readFileSync('data/metrics.csv', 'utf8')) },
]

test('csv keeps quoted commas', () => {
  assert.equal(grids[0].rows[1][1], '$48,000')
})

test('colLetter', () => {
  assert.deepEqual([0, 25, 26, 27].map(colLetter), ['A', 'Z', 'AA', 'AB'])
})

test('meeting context picks the right company row', () => {
  assert.deepEqual(lookup(grids, 'renewal value', ['Acme renewal', 'acme']), { value: '$48,000', label: 'Acme · Renewal value', ref: 'Deals!B2' })
  assert.equal(lookup(grids, 'renewal value', ['Globex sync'])?.ref, 'Deals!B3')
})

test('explicit row beats meeting context', () => {
  assert.equal(lookup(grids, 'initech seats', ['Acme renewal'])?.value, '18')
})

test('key/value metrics', () => {
  assert.deepEqual(lookup(grids, 'Q3 churn', []), { value: '4.2%', label: 'Q3 churn rate', ref: 'Metrics!B3' })
  assert.equal(lookup(grids, 'runway', [])?.value, '19 months')
})

test('no matching cell means no answer (nothing is made up)', () => {
  assert.equal(lookup(grids, 'weather tomorrow', []), null)
  assert.equal(lookup(grids, 'renewal value', []), null) // ambiguous without a company
})

test('ics: current meeting and company from attendee domain', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Acme renewal', 'DTSTART:20261128T090000Z', 'DTEND:20261128T093000Z',
    'ATTENDEE;CN="Omar":mailto:omar@acme.com', 'ATTENDEE:mailto:me@gmail.com', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
  const ms = parseIcs(ics)
  const m = relevantMeeting(ms, Date.UTC(2026, 10, 28, 9, 10))
  assert.equal(m?.title, 'Acme renewal')
  assert.deepEqual(contextTerms(m), ['Acme renewal', 'acme'])
  assert.equal(relevantMeeting(ms, Date.UTC(2026, 10, 28, 12)), null)
})

test('poisonedTwin grinds a real look-alike address', () => {
  const card = new Address(0, Buffer.alloc(32, 7)).toString({ testOnly: true, bounceable: false })
  const twin = poisonedTwin(card)
  assert.notEqual(twin, card)
  assert.ok(looksAlike(card, twin))
  assert.doesNotThrow(() => Address.parse(twin))
})

test('wav header', () => {
  const w = pcmToWav(Buffer.alloc(3200))
  assert.equal(w.toString('ascii', 0, 4), 'RIFF')
  assert.equal(w.readUInt32LE(24), 16000)
  assert.equal(w.length, 3244)
})
