// An intent is what the glasses send back when the wearer taps "approve".
// It is bound to the exact payload version they saw, expires, and is single-use,
// so an agent cannot swap the amount or recipient after the card was shown.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import type { ApprovalRequest } from './types.ts'

export const INTENT_TTL_MS = 5 * 60_000

export function payloadHash(r: Pick<ApprovalRequest, 'id' | 'kind' | 'payload' | 'version'>): string {
  return createHash('sha256')
    .update(JSON.stringify([r.id, r.kind, r.version, stable(r.payload)]))
    .digest('base64url')
    .slice(0, 22)
}

export function issueIntent(r: ApprovalRequest, secret: string, now = Date.now()): string {
  const body = `${r.id}.${r.version}.${payloadHash(r)}.${now + INTENT_TTL_MS}`
  return `${body}.${sign(body, secret)}`
}

export type IntentCheck = { ok: true } | { ok: false; reason: string }

export function verifyIntent(token: string, r: ApprovalRequest, secret: string, used: Set<string>, now = Date.now()): IntentCheck {
  const parts = token.split('.')
  if (parts.length !== 5) return { ok: false, reason: 'malformed intent' }
  const [id, version, hash, exp, mac] = parts
  const body = `${id}.${version}.${hash}.${exp}`
  const expected = sign(body, secret)
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return { ok: false, reason: 'bad signature' }
  }
  if (id !== r.id) return { ok: false, reason: 'intent for another request' }
  if (Number(version) !== r.version || hash !== payloadHash(r)) return { ok: false, reason: 'request changed since you saw it' }
  if (Number(exp) < now) return { ok: false, reason: 'intent expired' }
  if (used.has(token)) return { ok: false, reason: 'intent already used' }
  return { ok: true }
}

const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32)

// Key-order independent JSON so the hash does not depend on how an agent ordered fields.
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]))
  }
  return v
}
