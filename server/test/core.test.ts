import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Address } from '@ton/core'
import { evaluate } from '../src/policy.ts'
import { checkTransfer, looksAlike, sameAddress } from '../src/scam.ts'
import { issueIntent, verifyIntent } from '../src/intents.ts'
import { openDb } from '../src/db.ts'
import { createQueue } from '../src/queue.ts'
import { DEFAULT_RULES } from '../src/types.ts'
import type { ApprovalRequest, Contact } from '../src/types.ts'

const addr = (n: number, bounceable = false) =>
  new Address(0, Buffer.alloc(32, n)).toString({ testOnly: true, bounceable })

const OMAR_CARD = addr(1)
const ATTACKER = addr(9)
const omar: Contact = { username: 'omar', userId: 1, chatId: 1, cardAddress: OMAR_CARD, knownAddresses: [] }

test('sameAddress ignores friendly-format flags', () => {
  assert.ok(sameAddress(addr(1, false), addr(1, true)))
  assert.ok(!sameAddress(addr(1), addr(2)))
})

test('looksAlike catches a vanity twin but not the real address', () => {
  assert.ok(looksAlike('UQAbCdXXXXXXXXXXwxyz', 'UQAbCdYYYYYYYYYYwxyz'))
  assert.ok(!looksAlike('UQAbCdXXXXXXXXXXwxyz', 'UQAbCdXXXXXXXXXXwxyz'))
  assert.ok(!looksAlike('UQAbCdXXXXXXXXXXwxyz', 'UQZZZZYYYYYYYYYYwxyz'))
})

test('paying the wallet-card address raises no high finding', () => {
  const f = checkTransfer({ address: OMAR_CARD, amount: 5, contact: omar, paidBefore: [], hour: 14 })
  assert.deepEqual(f.filter(x => x.severity === 'high'), [])
})

test('paying a different address than the wallet card is CARD_MISMATCH + FIRST_TIME', () => {
  const codes = checkTransfer({ address: ATTACKER, amount: 5, contact: omar, paidBefore: [], hour: 14 }).map(f => f.code)
  assert.ok(codes.includes('CARD_MISMATCH'))
  assert.ok(codes.includes('FIRST_TIME'))
})

test('unknown recipient, amount spike and night-time are flagged', () => {
  assert.ok(checkTransfer({ address: ATTACKER, amount: 5, contact: null, paidBefore: [], hour: 14 }).some(f => f.code === 'UNKNOWN_RECIPIENT'))
  const spike = checkTransfer({ address: OMAR_CARD, amount: 100, contact: omar, paidBefore: [{ address: OMAR_CARD, amount: 5 }, { address: OMAR_CARD, amount: 6 }], hour: 3 })
  assert.ok(spike.some(f => f.code === 'AMOUNT_SPIKE'))
  assert.ok(spike.some(f => f.code === 'ODD_HOUR'))
})

test('policy: untrusted agent denied, high finding held, small verified transfer auto', () => {
  const base = { kind: 'ton_transfer' as const, payload: { to: 'omar', address: OMAR_CARD, amount: 5 }, spentToday: 0, recipientKnown: true }
  assert.equal(evaluate({ ...base, agentId: 'rogue', findings: [] }, DEFAULT_RULES).verdict, 'deny')
  assert.equal(evaluate({ ...base, agentId: 'invoice-agent', findings: [{ code: 'CARD_MISMATCH', severity: 'high', message: '' }] }, DEFAULT_RULES).verdict, 'hold')
  assert.equal(evaluate({ ...base, agentId: 'invoice-agent', findings: [] }, DEFAULT_RULES).verdict, 'auto')
  assert.equal(evaluate({ ...base, agentId: 'invoice-agent', payload: { ...base.payload, amount: 25 }, findings: [] }, DEFAULT_RULES).verdict, 'ask')
  assert.equal(evaluate({ ...base, agentId: 'invoice-agent', spentToday: 98, findings: [] }, DEFAULT_RULES).verdict, 'ask')
})

test('policy: telegram auto to known contact, ask for links or new people', () => {
  const msg = (text: string, known: boolean) => evaluate({ agentId: 'followup-agent', kind: 'telegram_message', payload: { to: 'omar', text }, findings: [], spentToday: 0, recipientKnown: known }, DEFAULT_RULES).verdict
  assert.equal(msg('Thanks Omar, deck tonight', true), 'auto')
  assert.equal(msg('see https://evil.example', true), 'ask')
  assert.equal(msg('hello', false), 'ask')
})

test('intent: bound to payload version, single-use, expires', () => {
  const r = { id: 'r1', kind: 'ton_transfer', payload: { amount: 5 }, version: 1 } as ApprovalRequest
  const used = new Set<string>()
  const t = issueIntent(r, 's3cret', 1000)
  assert.deepEqual(verifyIntent(t, r, 's3cret', used, 2000), { ok: true })
  assert.equal(verifyIntent(t, { ...r, version: 2 }, 's3cret', used, 2000).ok, false)
  assert.equal(verifyIntent(t, { ...r, payload: { amount: 500 } }, 's3cret', used, 2000).ok, false)
  assert.equal(verifyIntent(t, r, 'other', used, 2000).ok, false)
  assert.equal(verifyIntent(t, r, 's3cret', used, 1000 + 6 * 60_000).ok, false)
  used.add(t)
  assert.equal(verifyIntent(t, r, 's3cret', used, 2000).ok, false)
})

function setup() {
  let t = new Date('2026-11-28T10:00:00').getTime()
  const db = openDb()
  db.saveContact(omar)
  const sent: string[] = []
  const q = createQueue({
    db, secret: 'k', now: () => t, hour: () => 10,
    lookupContact: async u => db.getContact(u),
    executors: {
      ton_transfer: async r => { sent.push(`ton:${(r.payload as { address: string }).address}`); return 'ok' },
      telegram_message: async r => { sent.push(`tg:${(r.payload as { text: string }).text}`); return 'ok' },
    },
  })
  return { q, db, sent, advance: (ms: number) => { t += ms } }
}

test('queue: auto telegram reply waits the undo window, then sends', async () => {
  const { q, sent, advance } = setup()
  const r = await q.submit({ agentId: 'followup-agent', kind: 'telegram_message', title: 'Follow-up', payload: { to: 'omar', text: 'Thanks!' } })
  assert.equal(r.status, 'scheduled')
  await q.tick()
  assert.deepEqual(sent, [])
  advance(11_000)
  await q.tick()
  assert.deepEqual(sent, ['tg:Thanks!'])
})

test('queue: undo inside the window stops the send', async () => {
  const { q, sent, advance } = setup()
  const r = await q.submit({ agentId: 'followup-agent', kind: 'telegram_message', title: 'x', payload: { to: 'omar', text: 'oops' } })
  assert.ok(q.undo(r.id).ok)
  advance(60_000)
  await q.tick()
  assert.deepEqual(sent, [])
})

test('queue: poisoned invoice is held, cannot be approved, one-tap fix pays the wallet card', async () => {
  const { q, sent, advance } = setup()
  const r = await q.submit({ agentId: 'invoice-agent', kind: 'ton_transfer', title: 'Invoice #41', payload: { to: 'omar', address: ATTACKER, amount: 8 } })
  assert.equal(r.verdict, 'hold')
  assert.equal(r.status, 'pending')
  const intent = q.intentFor(r)
  assert.equal(q.decide(r.id, 'approve', intent).ok, false)
  const fixed = await q.fixToCard(r.id, intent)
  assert.ok(fixed.ok)
  assert.equal(fixed.ok && fixed.request.status, 'scheduled')
  advance(31_000)
  await q.tick()
  assert.deepEqual(sent, [`ton:${OMAR_CARD}`])
  assert.equal(q.today().blocked, 1)
})

test('queue: a correction can change the amount but never the recipient address', async () => {
  const { q } = setup()
  const r = await q.submit({ agentId: 'invoice-agent', kind: 'ton_transfer', title: 'Big', payload: { to: 'omar', address: OMAR_CARD, amount: 25 } })
  const res = await q.correct(r.id, { address: ATTACKER, amount: 20 })
  assert.ok(res.ok)
  const p = q.pending()[0].payload as { address: string; amount: number }
  assert.equal(p.address, OMAR_CARD)
  assert.equal(p.amount, 20)
  assert.equal((await q.correct(r.id, { address: ATTACKER })).ok, false)
})

test('queue: approval needs a fresh intent; a changed payload invalidates it', async () => {
  const { q } = setup()
  const r = await q.submit({ agentId: 'invoice-agent', kind: 'ton_transfer', title: 'Big', payload: { to: 'omar', address: OMAR_CARD, amount: 25 } })
  assert.equal(r.verdict, 'ask')
  const stale = q.intentFor(r)
  await q.correct(r.id, { amount: 20 })
  assert.equal(q.decide(r.id, 'approve', stale).ok, false)
  const fresh = q.intentFor(q.pending()[0])
  assert.ok(q.decide(r.id, 'approve', fresh).ok)
})

test('pairing: codes are unique, expire, and unpaired devices are capped', () => {
  const db = openDb()
  let n = 0
  const same = () => '123456'
  assert.equal(db.newDevice('t1', same, false), '123456')
  assert.equal(db.newDevice('t2', same, false), null)            // collision on every retry → refused
  assert.equal(db.deviceByCode('123456')?.token, 't1')
  db.saveDevice('t1', null, 42)                                  // paired: code no longer usable
  assert.equal(db.deviceByCode('123456'), undefined)
  for (let i = 0; i < 20; i++) db.newDevice(`x${i}`, () => String(100000 + n++), false)
  assert.equal(db.newDevice('y', () => '999999', false), null)  // cap of 20 waiting devices
  db.newDevice('z', () => '888888', true)                        // auto-paired: no usable code stored
  assert.equal(db.deviceByCode('888888'), undefined)
  assert.equal(db.deviceByToken('z')?.chatId, 0)
})

test('two-person rule: big transfer waits for the co-signer after the wearer approves', async () => {
  const { q, db, sent, advance } = setup()
  db.saveContact({ username: 'cfo', userId: 9, chatId: 9, cardAddress: null, knownAddresses: [] })
  db.set('cosigner', 'cfo')
  const r = await q.submit({ agentId: 'invoice-agent', kind: 'ton_transfer', title: 'Pay 3', payload: { to: 'omar', address: OMAR_CARD, amount: 3 } })
  assert.equal(r.status, 'cosign')                      // auto by policy, but 3 > cosignOver 1
  assert.equal(q.cosign(r.id, r.version + 1, true, 'cfo').ok, false) // stale version refused
  assert.ok(q.cosign(r.id, r.version, true, 'cfo').ok)
  advance(31_000)
  await q.tick()
  assert.deepEqual(sent, [`ton:${OMAR_CARD}`])
})

test('two-person rule: co-signer can refuse', async () => {
  const { q, db, sent, advance } = setup()
  db.saveContact({ username: 'cfo', userId: 9, chatId: 9, cardAddress: null, knownAddresses: [] })
  db.set('cosigner', 'cfo')
  const r = await q.submit({ agentId: 'invoice-agent', kind: 'ton_transfer', title: 'Pay 3', payload: { to: 'omar', address: OMAR_CARD, amount: 3 } })
  assert.ok(q.cosign(r.id, r.version, false, 'cfo').ok)
  advance(60_000)
  await q.tick()
  assert.deepEqual(sent, [])
})

test('agent budget: over the daily budget the policy asks', async () => {
  const { q } = setup()
  const a = await q.submit({ agentId: 'invoice-agent', kind: 'ton_transfer', title: 'a', payload: { to: 'omar', address: OMAR_CARD, amount: 4 } })
  assert.equal(a.verdict, 'auto')
  const b = await q.submit({ agentId: 'invoice-agent', kind: 'ton_transfer', title: 'b', payload: { to: 'omar', address: OMAR_CARD, amount: 2 } })
  assert.equal(b.verdict, 'ask')
  assert.ok(b.reasons.some(x => x.includes('budget')))
})

test('blocklist: a reported address is held even when it is the wallet card', async () => {
  const { q, db } = setup()
  db.set('blocklist', JSON.stringify([OMAR_CARD]))
  const r = await q.submit({ agentId: 'invoice-agent', kind: 'ton_transfer', title: 'x', payload: { to: 'omar', address: OMAR_CARD, amount: 1 } })
  assert.equal(r.verdict, 'hold')
  assert.ok(r.findings.some(f => f.code === 'BLOCKLISTED'))
})
