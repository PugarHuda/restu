// The approval queue: every agent request lands here, the policy decides,
// approved work waits out an undo window, then an executor runs it.
import { randomUUID } from 'node:crypto'
import type { Db } from './db.ts'
import { evaluate, needsCosign } from './policy.ts'
import { checkTransfer } from './scam.ts'
import { issueIntent, verifyIntent } from './intents.ts'
import type { ActionKind, ApprovalRequest, Contact, Payload, TelegramMessagePayload, TonTransferPayload } from './types.ts'

export type Executor = (r: ApprovalRequest) => Promise<string>

export interface QueueDeps {
  db: Db
  secret: string
  executors: Partial<Record<ActionKind, Executor>>
  // Refreshes a contact from Telegram (ton_wallet_card) when possible.
  lookupContact: (username: string) => Promise<Contact | null>
  onChange?: (r: ApprovalRequest, event: string) => void
  now?: () => number
  hour?: () => number
}

export interface SubmitInput {
  agentId: string
  kind: ActionKind
  title: string
  payload: Payload
}

const RISK_ORDER = { high: 0, medium: 1, low: 2 }
const CORRECTABLE: Record<ActionKind, string[]> = {
  ton_transfer: ['amount', 'memo'],
  telegram_message: ['text'],
  calendar_change: ['change'],
  generic: [],
}

export function createQueue(d: QueueDeps) {
  const now = d.now ?? Date.now
  const hour = d.hour ?? (() => new Date(now()).getHours())
  const usedIntents = new Set<string>()
  const startOfDay = () => { const t = new Date(now()); t.setHours(0, 0, 0, 0); return t.getTime() }

  function emit(r: ApprovalRequest, event: string, detail = '') {
    d.db.saveRequest(r)
    d.db.audit(event, r.id, r.agentId, detail)
    d.onChange?.(r, event)
  }

  async function assess(r: ApprovalRequest) {
    let findings: ApprovalRequest['findings'] = []
    let recipientKnown = true
    if (r.kind === 'ton_transfer') {
      const p = r.payload as TonTransferPayload
      const contact = await d.lookupContact(p.to)
      findings = checkTransfer({
        address: p.address,
        amount: p.amount,
        contact,
        paidBefore: contact ? d.db.paidTo(contact.username) : [],
        hour: hour(),
        blocklist: JSON.parse(d.db.get('blocklist') ?? '[]'),
      })
    }
    if (r.kind === 'telegram_message') {
      const p = r.payload as TelegramMessagePayload
      recipientKnown = Boolean(d.db.getContact(p.to))
    }
    const res = evaluate({
      agentId: r.agentId, kind: r.kind, payload: r.payload, findings,
      spentToday: d.db.spentSince(startOfDay()), recipientKnown,
      agentSpentToday: agentSpentToday(r),
    }, d.db.rules())
    Object.assign(r, { findings, verdict: res.verdict, risk: res.risk, reasons: res.reasons })
    if (res.verdict === 'hold') r.wasHeld = true
  }

  // GRAM this agent already committed today (sent, sending, or waiting for a co-signer).
  function agentSpentToday(r: ApprovalRequest) {
    return d.db.requestsSince(startOfDay())
      .filter(x => x.id !== r.id && x.agentId === r.agentId && x.kind === 'ton_transfer' && ['done', 'scheduled', 'cosign'].includes(x.status))
      .reduce((sum, x) => sum + Number((x.payload as TonTransferPayload).amount || 0), 0)
  }

  // After the wearer (or the policy) says yes: big transfers still need a second human.
  function release(r: ApprovalRequest, event: string) {
    if (needsCosign(r.kind, r.payload, d.db.rules(), Boolean(d.db.get('cosigner')))) {
      r.status = 'cosign'
      emit(r, `${event}:needs-cosign`, `over ${d.db.rules().cosignOver} GRAM`)
      return
    }
    schedule(r, event)
  }

  function schedule(r: ApprovalRequest, event: string) {
    const secs = d.db.rules().undoSeconds[r.kind] ?? 10
    r.status = 'scheduled'
    r.scheduledAt = now()
    r.executeAt = now() + secs * 1000
    emit(r, event, `executes in ${secs}s`)
  }

  async function settle(r: ApprovalRequest, event: string) {
    await assess(r)
    if (r.verdict === 'deny') { r.status = 'denied'; emit(r, `${event}:policy-denied`, r.reasons.join('; ')); return r }
    if (r.verdict === 'auto') { release(r, `${event}:auto`); return r }
    r.status = 'pending'
    emit(r, `${event}:${r.verdict}`, r.reasons.join('; '))
    return r
  }

  return {
    async submit(i: SubmitInput): Promise<ApprovalRequest> {
      const r: ApprovalRequest = {
        id: randomUUID().slice(0, 8), agentId: i.agentId, kind: i.kind, title: i.title.slice(0, 60),
        payload: i.payload, version: 1, status: 'pending', verdict: 'ask', risk: 'low', reasons: [],
        findings: [], createdAt: now(), executeAt: null, result: null,
      }
      return settle(r, 'submitted')
    },

    intentFor(r: ApprovalRequest) { return issueIntent(r, d.secret, now()) },

    // approve | deny | later, from the glasses or the Telegram fallback buttons.
    decide(id: string, action: 'approve' | 'deny' | 'later', intent: string | null) {
      const r = d.db.getRequest(id)
      if (!r || r.status !== 'pending') return { ok: false as const, reason: 'not pending' }
      if (action === 'later') { r.laterAt = now(); emit(r, 'later'); return { ok: true as const, request: r } }
      if (action === 'deny') { r.status = 'denied'; emit(r, 'denied-by-wearer'); return { ok: true as const, request: r } }
      if (r.verdict === 'hold') return { ok: false as const, reason: 'held: fix or review on phone' }
      const check = verifyIntent(intent ?? '', r, d.secret, usedIntents, now())
      if (!check.ok) return { ok: false as const, reason: check.reason }
      usedIntents.add(intent!)
      release(r, 'approved-by-wearer')
      return { ok: true as const, request: r }
    },

    // The one-tap fix for a held transfer: pay the address on their Telegram wallet card instead.
    async fixToCard(id: string, intent: string | null) {
      const r = d.db.getRequest(id)
      if (!r || r.status !== 'pending' || r.kind !== 'ton_transfer') return { ok: false as const, reason: 'not fixable' }
      const check = verifyIntent(intent ?? '', r, d.secret, usedIntents, now())
      if (!check.ok) return { ok: false as const, reason: check.reason }
      const p = r.payload as TonTransferPayload
      const contact = await d.lookupContact(p.to)
      if (!contact?.cardAddress) return { ok: false as const, reason: 'no wallet card to fall back to' }
      usedIntents.add(intent!)
      r.payload = { ...p, address: contact.cardAddress }
      r.version += 1
      d.db.audit('fixed-to-wallet-card', r.id, r.agentId, `${p.address} -> ${contact.cardAddress}`)
      await assess(r)
      if (r.verdict === 'hold' || r.verdict === 'deny') { r.status = 'pending'; emit(r, 'fix:still-held', r.reasons.join('; ')); return { ok: true as const, request: r } }
      release(r, 'fix:approved-by-wearer') // the tap was the approval of the corrected payment
      return { ok: true as const, request: r }
    },

    // Voice correction ("make it 20", "add: contract tonight") produces a new version to re-approve.
    async correct(id: string, raw: Record<string, unknown>) {
      const r = d.db.getRequest(id)
      if (!r || r.status !== 'pending') return { ok: false as const, reason: 'not pending' }
      // A spoken correction may never redirect money: the recipient address only
      // changes through fixToCard (their verified wallet card).
      const allowed = CORRECTABLE[r.kind]
      const patch = Object.fromEntries(Object.entries(raw).filter(([k, v]) => allowed.includes(k) && v !== undefined && v !== ''))
      if (!Object.keys(patch).length) return { ok: false as const, reason: 'nothing to change' }
      if ('amount' in patch && !(Number(patch.amount) > 0)) return { ok: false as const, reason: 'amount must be positive' }
      r.payload = { ...r.payload, ...patch }
      r.version += 1
      d.db.audit('corrected-by-wearer', r.id, r.agentId, JSON.stringify(patch))
      await settle(r, 'corrected')
      return { ok: true as const, request: r }
    },

    // The second person's answer (Telegram button from the co-signer's own chat).
    cosign(id: string, version: number, approve: boolean, by: string) {
      const r = d.db.getRequest(id)
      if (!r || r.status !== 'cosign') return { ok: false as const, reason: 'not waiting for a co-signer' }
      if (r.version !== version) return { ok: false as const, reason: 'request changed since it was sent' }
      if (!approve) { r.status = 'denied'; emit(r, 'cosign-denied', `by @${by}`); return { ok: true as const, request: r } }
      schedule(r, `cosigned`)
      d.db.audit('cosigned-by', r.id, r.agentId, `@${by}`)
      return { ok: true as const, request: r }
    },

    undo(id: string) {
      const r = d.db.getRequest(id)
      if (!r || r.status !== 'scheduled' || (r.executeAt ?? 0) <= now()) return { ok: false as const, reason: 'too late to undo' }
      r.status = 'undone'
      r.executeAt = null
      emit(r, 'undone-by-wearer')
      return { ok: true as const, request: r }
    },

    // Runs everything whose undo window has passed. Called on an interval.
    async tick() {
      for (const r of d.db.requestsByStatus('scheduled')) {
        if ((r.executeAt ?? Infinity) > now()) continue
        const run = d.executors[r.kind]
        r.status = 'done' // claim before awaiting so a second tick cannot double-send
        d.db.saveRequest(r)
        try {
          r.result = run ? await run(r) : 'recorded (no executor configured)'
          if (r.kind === 'ton_transfer') {
            const p = r.payload as TonTransferPayload
            d.db.recordPayment(p.to.replace(/^@/, ''), p.address, p.amount)
          }
          emit(r, 'executed', r.result)
        } catch (e) {
          r.status = 'failed'
          r.result = (e as Error).message
          emit(r, 'failed', r.result)
        }
      }
      // pending requests nobody answered within a day expire instead of piling up
      for (const r of d.db.requestsByStatus('pending')) {
        if (now() - r.createdAt > 24 * 3600_000) { r.status = 'expired'; emit(r, 'expired') }
      }
    },

    pending() {
      return d.db.requestsByStatus('pending').sort((a, b) =>
        (a.laterAt ?? 0) - (b.laterAt ?? 0) || RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.createdAt - b.createdAt)
    },
    scheduled() { return d.db.requestsByStatus('scheduled') },
    awaitingCosign() { return d.db.requestsByStatus('cosign') },

    today() {
      const rs = d.db.requestsSince(startOfDay())
      const count = (f: (r: ApprovalRequest) => boolean) => rs.filter(f).length
      return {
        total: rs.length,
        auto: count(r => r.verdict === 'auto' && ['done', 'scheduled', 'undone'].includes(r.status)),
        approved: count(r => r.verdict !== 'auto' && ['done', 'scheduled'].includes(r.status)),
        needYou: count(r => r.status === 'pending'),
        blocked: count(r => Boolean(r.wasHeld)),
        denied: count(r => r.status === 'denied'),
      }
    },
  }
}

export type Queue = ReturnType<typeof createQueue>
