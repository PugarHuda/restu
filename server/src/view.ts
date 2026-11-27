// Builds the exact text the glasses show. The glasses app stays thin: it renders
// three text boxes and sends gestures back. Only glyphs from the G2 font are used.
import type { Queue } from './queue.ts'
import type { ApprovalRequest } from './types.ts'
import type { Meeting } from './calendar.ts'

export interface GlassView {
  screen: 'pair' | 'home' | 'card'
  header: string
  body: string
  footer: string
  card?: { id: string; intent: string; hold: boolean; fixable: boolean }
  undo?: { id: string; secondsLeft: number }
  toast?: string      // short-lived answer (ASK / edit result) shown over the body
}

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}...${a.slice(-6)}` : a)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s)
const time = (t: number) => new Date(t).toTimeString().slice(0, 5)

export function cardBody(r: ApprovalRequest): string {
  const p = r.payload as Record<string, any>
  const mark = r.verdict === 'hold' ? '■ HELD' : r.risk === 'medium' ? '▲ CHECK' : '● OK'
  const lines = [`${mark}  ${clip(r.title, 34)}`, `from ${r.agentId}`]
  if (r.kind === 'ton_transfer') {
    lines.push(`Pay ${p.amount} GRAM to @${String(p.to).replace(/^@/, '')}`, `to ${short(String(p.address))}`)
  } else if (r.kind === 'telegram_message') {
    lines.push(`Telegram to @${String(p.to).replace(/^@/, '')}:`, clip(`"${p.text}"`, 130))
  } else if (r.kind === 'calendar_change') {
    lines.push(`${p.eventTitle}: ${p.change}`)
  } else {
    lines.push(clip(JSON.stringify(p), 120))
  }
  for (const reason of r.reasons.slice(0, 3)) lines.push(`${r.verdict === 'hold' ? '■' : '▷'} ${clip(reason, 40)}`)
  return lines.join('\n')
}

export function buildView(q: Queue, meeting: Meeting | null, paired: boolean, pairCode: string | null, bot: string | null, now = Date.now()): GlassView {
  if (!paired) {
    return {
      screen: 'pair',
      header: 'RESTU',
      body: `Pair your glasses\n\nOpen Telegram and send\n/pair ${pairCode ?? '------'}\nto @${bot ?? 'your Restu bot'}`,
      footer: 'Double-tap to exit',
    }
  }

  const t = q.today()
  const header = `RESTU  ●${t.auto} auto  ▲${t.needYou} need you  ■${t.blocked} blocked`
  const running = q.scheduled().filter(r => (r.executeAt ?? 0) > now).sort((a, b) => (b.scheduledAt ?? 0) - (a.scheduledAt ?? 0)) // newest first: undo what you just approved
  const undo = running[0] && { id: running[0].id, secondsLeft: Math.ceil(((running[0].executeAt ?? 0) - now) / 1000) }
  const undoLine = undo ? `Sending "${clip(running[0].title, 18)}" in ${undo.secondsLeft}s · ▲ undo` : ''

  const next = q.pending()[0]
  if (next) {
    const hold = next.verdict === 'hold'
    const fixable = hold && next.kind === 'ton_transfer' && next.findings.some(f => f.code === 'CARD_MISMATCH' || f.code === 'LOOKALIKE')
    const tap = hold ? (fixable ? 'TAP pay verified card' : 'review on phone') : 'TAP approve'
    // ▲ means "undo" while something is about to send, otherwise "later".
    const footer = undo
      ? `▲ undo (${undo.secondsLeft}s) · ${tap} · ▼ deny`
      : `${tap} · ▼ deny · ▲ later${hold ? '' : ' · HOLD edit'}`
    return {
      screen: 'card', header, body: cardBody(next), footer,
      card: { id: next.id, intent: q.intentFor(next), hold, fixable },
      undo,
    }
  }

  const lines = [] as string[]
  if (meeting) lines.push(`${now < meeting.start ? `Next ${time(meeting.start)}` : 'Now'}: ${clip(meeting.title, 30)}`)
  lines.push(`Today: ${t.total} requests, ${t.auto} ran on their own`)
  if (t.blocked) lines.push(`${t.blocked} suspicious payment${t.blocked > 1 ? 's' : ''} stopped`)
  lines.push('', 'HOLD and ask a number, e.g. "renewal value"')
  return { screen: 'home', header, body: lines.join('\n'), footer: undoLine || 'All clear · HOLD to ask', undo }
}
