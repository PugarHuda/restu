// The Acme demo: one story that shows every part of Restu in under 3 minutes.
import { randomBytes } from 'node:crypto'
import { Address } from '@ton/core'
import type { Db } from './db.ts'
import type { Queue } from './queue.ts'

const FMT = { testOnly: true, bounceable: false, urlSafe: true } as const

// Grinds a real address-poisoning twin: same visible prefix and suffix as
// `target`, different account. ~65k tries on average (matching the CRC16 tail).
export function poisonedTwin(target: string): string {
  const t = Address.parse(target)
  const want = t.toString(FMT)
  for (let i = 0; i < 2_000_000; i++) {
    const h = Buffer.from(t.hash)
    randomBytes(27).copy(h, 3)          // keep bytes 0-2 (prefix chars) and 31 (suffix char)
    const cand = new Address(t.workChain, h)
    const s = cand.toString(FMT)
    if (s.slice(2, 6) === want.slice(2, 6) && s.slice(-4) === want.slice(-4) && !cand.equals(t)) return s
  }
  throw new Error('could not grind a twin')
}

export interface DemoDeps {
  db: Db
  queue: Queue
  contact: string            // the "Omar from Acme" Telegram username
  cardFallback: string       // used when that contact has no ton_wallet_card yet
  ask: (q: string) => Promise<string | null>
  draft: (facts: string[]) => Promise<string>
}

export async function seedAcme(d: DemoDeps): Promise<string> {
  const username = d.contact.replace(/^@/, '').toLowerCase()
  const c = d.db.getContact(username) ?? { username, userId: null, chatId: null, cardAddress: null, knownAddresses: [] }
  if (!c.cardAddress) c.cardAddress = d.cardFallback
  d.db.saveContact(c)
  const card = c.cardAddress!

  const renewal = await d.ask('renewal value')
  const text = await d.draft(renewal ? [`renewal value ${renewal}`] : [])

  const submitted = [
    await d.queue.submit({ agentId: 'followup-agent', kind: 'telegram_message', title: 'Follow-up to Omar', payload: { to: username, text } }),
    await d.queue.submit({ agentId: 'calendar-agent', kind: 'calendar_change', title: 'Move Acme kickoff', payload: { eventTitle: 'Acme kickoff', change: 'move to Fri 10:00', attendees: 4 } }),
    await d.queue.submit({ agentId: 'invoice-agent', kind: 'ton_transfer', title: 'Pay Acme invoice #41', payload: { to: username, address: poisonedTwin(card), amount: 25, memo: 'Invoice #41' } }),
    await d.queue.submit({ agentId: 'invoice-agent', kind: 'ton_transfer', title: 'Courier fee', payload: { to: username, address: card, amount: 2, memo: 'Courier' } }),
  ]
  return submitted.map(r => `${r.title}: ${r.verdict}${r.reasons[0] ? ` (${r.reasons[0]})` : ''}`).join('\n')
}
