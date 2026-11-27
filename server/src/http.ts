// HTTP API for the glasses app and for agents. node:http, JSON in and out.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { Db } from './db.ts'
import type { Queue } from './queue.ts'
import type { ActionKind } from './types.ts'
import { buildView, type GlassView } from './view.ts'
import type { Meeting } from './calendar.ts'

export interface HttpDeps {
  db: Db
  queue: Queue
  agentKeys: Map<string, string>       // key -> agentId
  autoPair: boolean                    // no Telegram configured: devices pair themselves (simulator/demo)
  botName: () => string | null
  meeting: () => Promise<Meeting | null>
  ask: (text: string) => Promise<{ text: string; ok: boolean }>
  transcribe: (pcm: Buffer) => Promise<string>
  correct: (id: string, spoken: string) => Promise<{ ok: boolean; reason?: string }>
  demo?: () => Promise<string>
}

const KINDS: ActionKind[] = ['telegram_message', 'ton_transfer', 'calendar_change', 'generic']

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization, x-device',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit = 2_000_000): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new Error('body too large')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

const json = async (req: IncomingMessage) => {
  const raw = await readBody(req, 100_000)
  return raw.length ? JSON.parse(raw.toString('utf8')) : {}
}

function agentFrom(req: IncomingMessage, keys: Map<string, string>): string | null {
  const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  for (const [key, agent] of keys) {
    if (given.length === key.length && timingSafeEqual(Buffer.from(given), Buffer.from(key))) return agent
  }
  return null
}

export function createHttp(d: HttpDeps) {
  return createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204, {})
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.pathname

      if (path === '/health') return send(res, 200, { ok: true })

      // ---- agents --------------------------------------------------------
      if (path === '/v1/requests' && req.method === 'POST') {
        const agentId = agentFrom(req, d.agentKeys)
        if (!agentId) return send(res, 401, { error: 'unknown agent key' })
        const b = await json(req)
        if (!KINDS.includes(b.kind) || typeof b.title !== 'string' || typeof b.payload !== 'object') {
          return send(res, 400, { error: 'need kind, title, payload' })
        }
        const r = await d.queue.submit({ agentId, kind: b.kind, title: b.title, payload: b.payload })
        return send(res, 201, { id: r.id, status: r.status, verdict: r.verdict, reasons: r.reasons })
      }
      const one = path.match(/^\/v1\/requests\/([\w-]+)$/)
      if (one && req.method === 'GET') {
        const agentId = agentFrom(req, d.agentKeys)
        const r = d.db.getRequest(one[1])
        if (!agentId || !r || r.agentId !== agentId) return send(res, 404, { error: 'not found' })
        return send(res, 200, { id: r.id, status: r.status, verdict: r.verdict, result: r.result, version: r.version, payload: r.payload })
      }

      // ---- glasses -------------------------------------------------------
      if (path === '/v1/pair/start' && req.method === 'POST') {
        const token = randomBytes(18).toString('base64url')
        const code = String(randomInt(100000, 1000000))
        d.db.saveDevice(token, code, d.autoPair ? 0 : null)
        return send(res, 200, { token, code })
      }

      const device = d.db.deviceByToken(String(req.headers['x-device'] ?? ''))
      if (!device) return send(res, 401, { error: 'unknown device, call /v1/pair/start' })
      const paired = device.chatId !== null

      if (path === '/v1/glass/state') {
        const view: GlassView = buildView(d.queue, paired ? await d.meeting() : null, paired, device.code, d.botName())
        return send(res, 200, view)
      }
      if (!paired) return send(res, 403, { error: 'pair first' })

      if (path === '/v1/glass/action' && req.method === 'POST') {
        const b = await json(req)
        const id = String(b.id ?? '')
        let out: { ok: boolean; reason?: string }
        switch (b.action) {
          case 'approve': case 'deny': case 'later': out = d.queue.decide(id, b.action, b.intent ?? null); break
          case 'fix': out = await d.queue.fixToCard(id, b.intent ?? null); break
          case 'undo': out = d.queue.undo(id); break
          default: return send(res, 400, { error: 'unknown action' })
        }
        return send(res, out.ok ? 200 : 409, { ok: out.ok, reason: out.reason })
      }
      if (path === '/v1/glass/ask' && req.method === 'POST') {
        const b = await json(req)
        return send(res, 200, await d.ask(String(b.text ?? '')))
      }
      if (path === '/v1/glass/correct' && req.method === 'POST') {
        const b = await json(req)
        return send(res, 200, await d.correct(String(b.id ?? ''), String(b.text ?? '')))
      }
      // Raw 16 kHz PCM from the G2 mic, transcribed server-side so no key ships in the app.
      if (path === '/v1/glass/voice' && req.method === 'POST') {
        const pcm = await readBody(req)
        let heard: string
        try { heard = await d.transcribe(pcm) } catch (e) { return send(res, 200, { ok: false, text: (e as Error).message }) }
        if (url.searchParams.get('mode') === 'correct') {
          const r = await d.correct(String(url.searchParams.get('id')), heard)
          return send(res, 200, { ok: r.ok, heard, text: r.ok ? `Updated: "${heard}"` : r.reason })
        }
        return send(res, 200, { heard, ...(await d.ask(heard)) })
      }
      if (path === '/v1/audit') return send(res, 200, d.db.auditList(30))
      if (path === '/v1/demo/acme' && req.method === 'POST' && d.demo) return send(res, 200, { text: await d.demo() })

      return send(res, 404, { error: 'not found' })
    } catch (e) {
      console.error('[http]', e)
      return send(res, 500, { error: (e as Error).message })
    }
  })
}
