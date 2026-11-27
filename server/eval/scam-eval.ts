// Anti-scam evaluation: generates labelled payment scenarios and runs them through the
// real checks + policy. Reports how many scams are held and how many legit payments
// are wrongly held. Run: node --experimental-strip-types --no-warnings eval/scam-eval.ts
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { Address } from '@ton/core'
import { checkTransfer } from '../src/scam.ts'
import { evaluate } from '../src/policy.ts'
import { poisonedTwin } from '../src/demo.ts'
import { DEFAULT_RULES } from '../src/types.ts'
import type { Contact } from '../src/types.ts'

const addr = () => new Address(0, randomBytes(32)).toString({ testOnly: true, bounceable: false })
type Case = { family: string; scam: boolean; address: string; amount: number; contact: Contact | null; paid: { address: string; amount: number }[]; blocklist?: string[]; hour?: number }

const cases: Case[] = []
const N = Number(process.env.N ?? 40)
for (let i = 0; i < N; i++) {
  const card = addr()
  const known = addr()
  const contact: Contact = { username: `c${i}`, userId: i, chatId: i, cardAddress: card, knownAddresses: [] }
  const noCard: Contact = { username: `n${i}`, userId: i, chatId: i, cardAddress: null, knownAddresses: [known] }
  const amount = 1 + (i % 9)
  // ---- legitimate
  cases.push({ family: 'legit: pay their wallet card', scam: false, address: card, amount, contact, paid: [] })
  cases.push({ family: 'legit: repeat payee', scam: false, address: card, amount, contact, paid: [{ address: card, amount }, { address: card, amount: amount + 1 }] })
  cases.push({ family: 'legit: owner-verified address (no card)', scam: false, address: known, amount, contact: noCard, paid: [] })
  // ---- scams
  cases.push({ family: 'scam: poisoned look-alike of the card', scam: true, address: poisonedTwin(card), amount, contact, paid: [] })
  cases.push({ family: 'scam: swapped address (invoice tampering)', scam: true, address: addr(), amount, contact, paid: [{ address: card, amount }] })
  cases.push({ family: 'scam: impersonator (unknown recipient)', scam: true, address: addr(), amount, contact: null, paid: [] })
  const bad = addr()
  cases.push({ family: 'scam: reported address', scam: true, address: bad, amount, contact: { ...contact, cardAddress: bad }, paid: [], blocklist: [bad] })
  cases.push({ family: 'scam: poisoned twin of a past payee (no card)', scam: true, address: poisonedTwin(known), amount, contact: noCard, paid: [{ address: known, amount }] })
}

type Row = { family: string; n: number; held: number; asked: number; auto: number }
const rows = new Map<string, Row>()
for (const c of cases) {
  const findings = checkTransfer({ address: c.address, amount: c.amount, contact: c.contact, paidBefore: c.paid, hour: c.hour ?? 14, blocklist: c.blocklist })
  const v = evaluate({ agentId: 'invoice-agent', kind: 'ton_transfer', payload: { to: 'x', address: c.address, amount: c.amount }, findings, spentToday: 0, recipientKnown: true, agentSpentToday: 0 }, DEFAULT_RULES).verdict
  const r = rows.get(c.family) ?? { family: c.family, n: 0, held: 0, asked: 0, auto: 0 }
  r.n++
  if (v === 'hold' || v === 'deny') r.held++
  else if (v === 'ask') r.asked++
  else r.auto++
  rows.set(c.family, r)
}

const all = [...rows.values()]
const scams = all.filter(r => r.family.startsWith('scam'))
const legit = all.filter(r => r.family.startsWith('legit'))
const sum = (rs: Row[], k: keyof Row) => rs.reduce((a, r) => a + Number(r[k]), 0)
const scamN = sum(scams, 'n'), legitN = sum(legit, 'n')
const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`

const lines = [
  `# Restu anti-scam evaluation`,
  ``,
  `${cases.length} labelled payment scenarios (${scamN} scams, ${legitN} legitimate), run through the real \`checkTransfer\` + policy (default rules). Look-alike addresses are ground for real (same visible prefix and suffix).`,
  ``,
  `| Scenario | n | held | asked | auto-sent |`,
  `|---|---:|---:|---:|---:|`,
  ...all.map(r => `| ${r.family} | ${r.n} | ${r.held} | ${r.asked} | ${r.auto} |`),
  ``,
  `- **Scams held (cannot be approved by tap): ${sum(scams, 'held')}/${scamN} = ${pct(sum(scams, 'held'), scamN)}**`,
  `- Scams that would auto-send: ${sum(scams, 'auto')}/${scamN}`,
  `- **Legit payments wrongly held: ${sum(legit, 'held')}/${legitN} = ${pct(sum(legit, 'held'), legitN)}**`,
  `- Legit payments that ran on their own or asked once: ${sum(legit, 'auto') + sum(legit, 'asked')}/${legitN}`,
  ``,
  `**Limits (read before quoting the numbers):** the scenarios are synthetic and cover the attack families Restu's checks were written for. They do not cover a compromised Telegram account (the wallet card itself is attacker-controlled), a contact who is the scammer, or social engineering that convinces the owner to verify a bad address. "Asked" legit payments are the policy working as designed (above the auto limit or the agent's daily budget), not false alarms.`,
  ``,
  `Generated ${new Date().toISOString()} by \`server/eval/scam-eval.ts\`.`,
]
writeFileSync(new URL('../../docs/scam-eval.md', import.meta.url), lines.join('\n') + '\n')
console.log(lines.join('\n'))
