// Wires everything together. Configuration is env only (see .env.example).
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { Address } from '@ton/core'
import { openDb } from './db.ts'
import { createQueue, type Executor } from './queue.ts'
import { createTelegram } from './telegram.ts'
import { createTonSender } from './ton.ts'
import { createSheets } from './sheets.ts'
import { createCalendar, contextTerms } from './calendar.ts'
import { createLlm } from './llm.ts'
import { createStt } from './stt.ts'
import { createHttp } from './http.ts'
import { seedAcme } from './demo.ts'
import type { TelegramMessagePayload } from './types.ts'

if (existsSync('.env')) process.loadEnvFile('.env')
const env = process.env
const demoMode = env.DEMO_MODE === '1'

const db = openDb(env.DB_PATH ?? 'data/restu.db')
const secret = env.INTENT_SECRET ?? db.get('intent_secret') ?? (() => {
  const s = randomBytes(32).toString('base64url'); db.set('intent_secret', s); return s
})()

// Hosts without a persistent disk lose the database on restart: restore the owner from env.
if (env.OWNER_CHAT_ID && !db.get('owner_chat_id')) db.set('owner_chat_id', env.OWNER_CHAT_ID)

const llm = createLlm(env.ANTHROPIC_API_KEY)
const stt = createStt({ url: env.STT_URL, key: env.STT_API_KEY, model: env.STT_MODEL })
const calendar = createCalendar(env.CALENDAR_ICS_URL, demoMode)
const sheets = createSheets({
  sheetId: env.GOOGLE_SHEET_ID,
  apiKey: env.GOOGLE_API_KEY,
  oauth: env.GOOGLE_REFRESH_TOKEN ? {
    clientId: env.GOOGLE_CLIENT_ID ?? '', clientSecret: env.GOOGLE_CLIENT_SECRET ?? '', refreshToken: env.GOOGLE_REFRESH_TOKEN,
  } : undefined,
  localFiles: [{ tab: 'Deals', path: 'data/deals.csv' }, { tab: 'Metrics', path: 'data/metrics.csv' }],
  // GOOGLE_SHEETS=Deals=<sheetId>,Metrics=<sheetId> (sheets shared as "anyone with the link")
  publicSheets: (env.GOOGLE_SHEETS ?? '').split(',').filter(Boolean).map(pair => {
    const [tab, id] = pair.split('=')
    return { tab: tab.trim(), id: (id ?? '').trim() }
  }).filter(x => x.tab && x.id),
}, p => readFile(p, 'utf8'))

const tg = env.TELEGRAM_BOT_TOKEN ? createTelegram({
  token: env.TELEGRAM_BOT_TOKEN,
  db,
  queue: () => queue,
  botAllowlist: (env.BOT_ALLOWLIST ?? '').split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean),
  onDemo: () => demo(),
}) : null

const executors: Partial<Record<string, Executor>> = {}
if (tg) executors.telegram_message = r => tg.sendApproved(r)
if (env.AGENT_WALLET_MNEMONIC) {
  const ton = await createTonSender(env.AGENT_WALLET_MNEMONIC, env.TONCENTER_API_KEY)
  executors.ton_transfer = r => ton.send(r)
  console.log(`[ton] agent wallet ${ton.address} · balance ${await ton.balance().catch(() => '?')} GRAM (testnet)`)
}

const queue = createQueue({
  db, secret, executors,
  lookupContact: async u => (tg ? tg.lookupContact(u) : db.getContact(u)),
  onChange: (r, event) => { tg?.notify(r, event).catch(e => console.error('[telegram] notify:', e.message)) },
})

async function ask(text: string) {
  const meeting = await calendar.current()
  const hit = await sheets.ask(text, contextTerms(meeting))
  if (!hit) return { ok: false, text: `No cell matches "${text}".\nTry a column name, e.g. "renewal value".` }
  const at = new Date(hit.fetchedAt).toTimeString().slice(0, 5)
  db.audit('ask', null, 'wearer', `${text} -> ${hit.ref}`)
  return { ok: true, text: `${hit.value}\n${hit.label}\n${hit.ref} · read ${at}\n${hit.source}` }
}

async function correct(id: string, spoken: string) {
  const r = db.getRequest(id)
  if (!r) return { ok: false, reason: 'not found' }
  const patch = await llm.parseCorrection(spoken, r.kind)
  if (!patch) return { ok: false, reason: `Could not apply "${spoken}"` }
  const { appendText, ...rest } = patch
  if (appendText) rest.text = `${(r.payload as TelegramMessagePayload).text ?? ''} ${appendText}`.trim()
  return queue.correct(id, rest as Record<string, unknown>)
}

async function demo() {
  return seedAcme({
    db, queue,
    contact: env.DEMO_CONTACT || 'omar_acme',
    // a deterministic stand-in testnet address when the demo contact has no wallet card
    cardFallback: env.DEMO_RECIPIENT_CARD || new Address(0, createHash('sha256').update('restu-demo-omar').digest()).toString({ testOnly: true, bounceable: false }),
    ask: async q => { const m = await calendar.current(); return (await sheets.ask(q, contextTerms(m)))?.value ?? null },
    draft: facts => llm.draftFollowup({ meeting: 'Acme renewal', person: 'Omar', facts }),
  })
}

let botName: string | null = null
if (tg) {
  tg.me().then(m => { botName = m.username; console.log(`[telegram] @${m.username} polling`) }).catch(e => console.error('[telegram]', e.message))
  tg.start()
}

setInterval(() => { queue.tick().catch(e => console.error('[tick]', e)) }, 1000)

const port = Number(env.PORT ?? 8787)
// Self-pairing (no Telegram) is a local simulator convenience only: never with a funded
// wallet, and only on loopback so nobody else on the network can grab a device token.
const autoPair = !tg && demoMode && !executors.ton_transfer
if (!tg && !autoPair) console.warn('[restu] no TELEGRAM_BOT_TOKEN: devices cannot pair (set DEMO_MODE=1 without a wallet for simulator mode)')
createHttp({
  db, queue,
  agentKeys: new Map((env.AGENT_KEYS ?? '').split(',').filter(Boolean).map(pair => {
    const [agent, key] = pair.split(':')
    return [key, agent] as [string, string]
  })),
  autoPair,
  botName: () => botName,
  meeting: () => calendar.current(),
  ask,
  transcribe: pcm => stt.transcribe(pcm),
  correct,
  demo: demoMode ? demo : undefined,
}).listen(port, autoPair ? '127.0.0.1' : undefined, () => {
  console.log(`[restu] http://localhost:${port} · telegram ${tg ? 'on' : autoPair ? 'off (local simulator: devices auto-pair, loopback only)' : 'off'} · claude ${llm.enabled ? 'on' : 'off'} · stt ${stt.enabled ? 'on' : 'off'} · ton ${executors.ton_transfer ? 'on' : 'off (transfers are recorded only)'} · demo ${demoMode ? 'on' : 'off'}`)
})
