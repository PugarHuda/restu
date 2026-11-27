// The policy engine: decides what runs on its own and what reaches the glasses.
// Pure function, no I/O, so every rule is unit-tested.
import type {
  ActionKind, CalendarChangePayload, Finding, Payload, Risk, Rules, TelegramMessagePayload,
  TonTransferPayload, Verdict,
} from './types.ts'

export interface PolicyInput {
  agentId: string
  kind: ActionKind
  payload: Payload
  findings: Finding[]
  spentToday: number          // GRAM already sent today (all agents)
  recipientKnown: boolean     // telegram: we have talked to this person before
}

export interface PolicyResult {
  verdict: Verdict
  risk: Risk
  reasons: string[]
}

const LINK = /https?:\/\/|t\.me\/|www\./i

export function evaluate(i: PolicyInput, rules: Rules): PolicyResult {
  if (!rules.trustedAgents.includes(i.agentId) && !i.agentId.startsWith('bot:')) {
    return { verdict: 'deny', risk: 'high', reasons: [`Agent "${i.agentId}" is not trusted`] }
  }

  const high = i.findings.filter(f => f.severity === 'high')
  const medium = i.findings.filter(f => f.severity === 'medium')
  const risk: Risk = high.length ? 'high' : medium.length ? 'medium' : 'low'
  const reasons = i.findings.map(f => f.message)

  // Anything a scam check flags as high is held: the wearer sees it in red and
  // cannot approve the original with a single tap.
  if (high.length) return { verdict: 'hold', risk, reasons }

  switch (i.kind) {
    case 'ton_transfer': {
      const p = i.payload as TonTransferPayload
      if (i.spentToday + p.amount > rules.dailyTransferCap) {
        return { verdict: 'ask', risk: 'medium', reasons: [...reasons, `Over daily cap (${rules.dailyTransferCap} GRAM)`] }
      }
      if (p.amount > rules.autoTransferMax) {
        return { verdict: 'ask', risk, reasons: [...reasons, `Above auto limit (${rules.autoTransferMax} GRAM)`] }
      }
      if (medium.length) return { verdict: 'ask', risk, reasons }
      return { verdict: 'auto', risk, reasons: [`Up to ${rules.autoTransferMax} GRAM, verified address`] }
    }
    case 'telegram_message': {
      const p = i.payload as TelegramMessagePayload
      if (LINK.test(p.text)) return { verdict: 'ask', risk: 'medium', reasons: [...reasons, 'Message contains a link'] }
      if (!i.recipientKnown) return { verdict: 'ask', risk, reasons: [...reasons, 'New recipient'] }
      if (rules.autoTelegramToKnown && !medium.length) {
        return { verdict: 'auto', risk, reasons: ['Reply to a known contact'] }
      }
      return { verdict: 'ask', risk, reasons }
    }
    case 'calendar_change': {
      const p = i.payload as CalendarChangePayload
      if (p.attendees >= rules.calendarAskAttendees) {
        return { verdict: 'ask', risk: 'medium', reasons: [...reasons, `Affects ${p.attendees} people`] }
      }
      return { verdict: 'auto', risk, reasons: ['Small calendar change'] }
    }
    default:
      return { verdict: 'ask', risk, reasons }
  }
}
