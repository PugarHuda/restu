// Outgoing-payment checks. Pure: everything it needs is passed in.
import { Address } from '@ton/core'
import type { Contact, Finding } from './types.ts'

export interface TransferCheckInput {
  address: string
  amount: number
  contact: Contact | null
  paidBefore: { address: string; amount: number }[] // past transfers to this contact
  hour: number                                      // wearer's local hour, 0-23
}

// Same account regardless of friendly-format flags (bounceable, testnet, url-safe).
export function sameAddress(a: string, b: string): boolean {
  try {
    return Address.parse(a).equals(Address.parse(b))
  } catch {
    return a.trim() === b.trim()
  }
}

// What a human compares on screen: the friendly form, normalised to one flag set.
function display(a: string): string {
  try {
    return Address.parse(a).toString({ bounceable: false, testOnly: true, urlSafe: true })
  } catch {
    return a.trim()
  }
}

// Address poisoning: an attacker grinds a vanity address whose first and last
// characters match one you trust, hoping you only eyeball the ends.
// ponytail: 4+4 chars is the common poisoning window; widen if attackers go longer.
export function looksAlike(a: string, b: string): boolean {
  if (sameAddress(a, b)) return false
  const x = display(a), y = display(b)
  // skip the 2-char format prefix (UQ/EQ/0Q/kQ), it is identical for most wallets
  return x.slice(2, 6) === y.slice(2, 6) && x.slice(-4) === y.slice(-4)
}

export function checkTransfer(i: TransferCheckInput): Finding[] {
  const out: Finding[] = []
  const trusted = [
    ...(i.contact?.cardAddress ? [i.contact.cardAddress] : []),
    ...(i.contact?.knownAddresses ?? []),
    ...i.paidBefore.map(p => p.address),
  ]
  const matchesTrusted = trusted.some(t => sameAddress(t, i.address))

  if (!i.contact) {
    out.push({ code: 'UNKNOWN_RECIPIENT', severity: 'high', message: 'Recipient is not a known contact' })
  }

  const card = i.contact?.cardAddress
  if (card && !sameAddress(card, i.address)) {
    out.push({ code: 'CARD_MISMATCH', severity: 'high', message: "Not their Telegram wallet card" })
  }

  const twin = trusted.find(t => looksAlike(t, i.address))
  if (twin) {
    out.push({ code: 'LOOKALIKE', severity: 'high', message: 'Look-alike of a trusted address' })
  }

  if (!matchesTrusted && !i.paidBefore.some(p => sameAddress(p.address, i.address))) {
    out.push({ code: 'FIRST_TIME', severity: 'medium', message: 'First payment to this address' })
  }

  if (i.contact && !card && i.contact.knownAddresses.length === 0) {
    out.push({ code: 'NO_CARD', severity: 'medium', message: 'Contact has no verified wallet' })
  }

  const past = i.paidBefore.map(p => p.amount).sort((a, b) => a - b)
  if (past.length >= 2) {
    const median = past[Math.floor(past.length / 2)]
    if (i.amount > median * 3) {
      out.push({ code: 'AMOUNT_SPIKE', severity: 'medium', message: `${round(i.amount / median)}x their usual amount` })
    }
  }

  if (i.hour >= 0 && i.hour < 5) {
    out.push({ code: 'ODD_HOUR', severity: 'low', message: 'Requested at night' })
  }
  return out
}

const round = (n: number) => Math.round(n * 10) / 10
