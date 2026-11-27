// Telegram Bot API over plain fetch (no SDK: it is one POST per method).
// Roles:
//  - phone fallback: the owner can approve/deny from Telegram buttons
//  - identity source: getChat(user).ton_wallet_card (Bot API 10.4) for the scam check
//  - agent inbox: allow-listed bots send "/request {json}" (bot-to-bot, Bot API 10.0)
//  - executor: sends approved messages, as the owner when a business connection exists
import type { Db } from './db.ts'
import type { Queue } from './queue.ts'
import type { ApprovalRequest, Contact, TelegramMessagePayload } from './types.ts'

export interface TelegramDeps {
  token: string
  db: Db
  queue: () => Queue
  botAllowlist: string[]          // usernames of bots allowed to file requests
  onDemo?: () => Promise<string>  // /demo seeds the Acme scenario
}

type Update = Record<string, any>

export function createTelegram(d: TelegramDeps) {
  const base = `https://api.telegram.org/bot${d.token}`
  const cardCache = new Map<number, { at: number; address: string | null }>()
  const pairFails = new Map<number, { n: number; since: number }>()

  async function api<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
    const body = await res.json() as { ok: boolean; result: T; description?: string }
    if (!body.ok) throw new Error(`telegram ${method}: ${body.description}`)
    return body.result
  }

  const ownerChat = () => { const v = d.db.get('owner_chat_id'); return v ? Number(v) : null }

  // ton_wallet_card lives on ChatFullInfo; only private chats with users carry it.
  async function walletCard(userId: number): Promise<string | null> {
    const hit = cardCache.get(userId)
    if (hit && Date.now() - hit.at < 60_000) return hit.address
    try {
      const chat = await api<{ ton_wallet_card?: { address?: string } }>('getChat', { chat_id: userId })
      const address = chat.ton_wallet_card?.address || null
      cardCache.set(userId, { at: Date.now(), address })
      return address
    } catch {
      return hit?.address ?? null
    }
  }

  async function lookupContact(username: string): Promise<Contact | null> {
    const c = d.db.getContact(username)
    if (!c) return null
    if (c.userId) {
      const card = await walletCard(c.userId)
      if (card && card !== c.cardAddress) { c.cardAddress = card; d.db.saveContact(c) }
    }
    return c
  }

  async function rememberUser(from: { id: number; username?: string; is_bot?: boolean }, chatId: number) {
    if (from.is_bot || !from.username) return
    const existing = d.db.getContact(from.username)
    const card = await walletCard(from.id)
    d.db.saveContact({
      username: from.username.toLowerCase(),
      userId: from.id,
      chatId,
      cardAddress: card ?? existing?.cardAddress ?? null,
      knownAddresses: existing?.knownAddresses ?? [],
    })
  }

  const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
    api('sendMessage', { chat_id, text, link_preview_options: { is_disabled: true }, ...extra })

  function cardText(r: ApprovalRequest) {
    const head = r.verdict === 'hold' ? '🛑 HELD' : r.risk === 'medium' ? '⚠️ Needs you' : '🟢 Needs you'
    return [`${head} · ${r.title}`, `from ${r.agentId}`, ...r.reasons.map(x => `• ${x}`), '', describe(r)].join('\n')
  }

  function buttons(r: ApprovalRequest) {
    const v = `${r.id}:${r.version}`
    const row = r.verdict === 'hold'
      ? [{ text: 'Pay wallet-card address', callback_data: `f:${v}` }, { text: 'Deny', callback_data: `d:${v}` }]
      : [{ text: 'Approve', callback_data: `a:${v}` }, { text: 'Deny', callback_data: `d:${v}` }]
    return { inline_keyboard: [row] }
  }

  async function onCallback(cq: Update) {
    const chatId = cq.message?.chat?.id
    const [op, id, version] = String(cq.data).split(':')
    const q = d.queue()
    const cosigner = d.db.get('cosigner') ? d.db.getContact(String(d.db.get('cosigner'))) : null
    if (op === 'c' || op === 'x') {
      if (!cosigner || chatId !== cosigner.chatId) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'You are not the co-signer' })
      const res = q.cosign(id, Number(version), op === 'c', cosigner.username)
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: res.ok ? (op === 'c' ? 'Co-signed' : 'Refused') : res.reason })
      await api('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      const owner = ownerChat()
      if (owner && res.ok) await send(owner, `${op === 'c' ? '✅ Co-signed' : '⛔ Refused'} by @${cosigner.username}: ${res.request.title}`)
      return
    }
    if (chatId !== ownerChat()) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not your queue' })
    const r = d.db.getRequest(id)
    let text = 'Done'
    if (!r || String(r.version) !== version) text = 'This request changed. Check the latest card.'
    else if (op === 'a') { const res = q.decide(id, 'approve', q.intentFor(r)); text = res.ok ? 'Approved' : res.reason }
    else if (op === 'd') { const res = q.decide(id, 'deny', null); text = res.ok ? 'Denied' : res.reason }
    else if (op === 'f') { const res = await q.fixToCard(id, q.intentFor(r)); text = res.ok ? 'Paying the wallet-card address' : res.reason }
    await api('answerCallbackQuery', { callback_query_id: cq.id, text })
    await api('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
  }

  async function onMessage(m: Update) {
    const chatId: number = m.chat.id
    const text: string = m.text ?? ''
    const from = m.from ?? {}

    // Bot-to-bot: an allow-listed agent bot files a request.
    if (from.is_bot) {
      if (!d.botAllowlist.includes(String(from.username).toLowerCase())) return
      const json = text.replace(/^\/request(@\w+)?\s*/, '')
      try {
        const body = JSON.parse(json)
        const r = await d.queue().submit({ agentId: `bot:${from.username}`, kind: body.kind, title: body.title, payload: body.payload })
        await send(chatId, JSON.stringify({ id: r.id, verdict: r.verdict, status: r.status }), { reply_to_message_id: m.message_id })
      } catch (e) {
        await send(chatId, JSON.stringify({ error: (e as Error).message }))
      }
      return
    }

    if (m.chat.type === 'private') await rememberUser(from, chatId)
    const owner = ownerChat()

    const pair = text.match(/^\/pair\s+(\d{6})/)
    if (pair) {
      if (owner && owner !== chatId) return send(chatId, 'This Restu already has an owner.')
      // Brute-forcing a 6-digit code: 5 wrong tries per chat per 10 minutes.
      const tries = pairFails.get(chatId) ?? { n: 0, since: Date.now() }
      if (Date.now() - tries.since > 10 * 60_000) { tries.n = 0; tries.since = Date.now() }
      if (tries.n >= 5) return send(chatId, 'Too many wrong codes. Try again in 10 minutes.')
      const dev = d.db.deviceByCode(pair[1])
      if (!dev) { tries.n++; pairFails.set(chatId, tries); return send(chatId, 'Unknown or expired code. Open Restu on your glasses to get a fresh one.') }
      pairFails.delete(chatId)
      d.db.set('owner_chat_id', String(chatId))
      d.db.saveDevice(dev.token, null, chatId)
      d.db.audit('paired', null, null, `chat ${chatId}`)
      return send(chatId, '✅ Glasses paired. Requests that need you will show on your lens, and here as a fallback.')
    }

    if (chatId !== owner) {
      if (text.startsWith('/start')) {
        return send(chatId, 'Hi! I am Restu. Your contact is saved so the person you work with can pay or message you safely.' +
          '\nTip: set a TON wallet on your Telegram profile so payments to you are verified.')
      }
      return
    }

    if (text.startsWith('/audit')) {
      const rows = d.db.auditList(12).map(a => `${new Date(a.at).toLocaleTimeString()} ${a.event}${a.agentId ? ` · ${a.agentId}` : ''}${a.detail ? ` · ${a.detail.slice(0, 60)}` : ''}`)
      return send(chatId, rows.join('\n') || 'Audit log is empty.')
    }
    if (text.startsWith('/rules')) return send(chatId, `<pre>${JSON.stringify(d.db.rules(), null, 1)}</pre>`, { parse_mode: 'HTML' })
    const setRule = text.match(/^\/setrule\s+(autoTransferMax|dailyTransferCap|calendarAskAttendees|cosignOver)\s+(\d+(\.\d+)?)/)
    if (setRule) {
      const rules = { ...d.db.rules(), [setRule[1]]: Number(setRule[2]) }
      d.db.set('rules', JSON.stringify(rules))
      d.db.audit('rule-changed', null, null, `${setRule[1]}=${setRule[2]}`)
      return send(chatId, `Rule updated: ${setRule[1]} = ${setRule[2]}`)
    }
    const wallet = text.match(/^\/verify\s+@?(\w+)\s+(\S+)/)
    if (wallet) {
      const c = d.db.getContact(wallet[1])
      if (!c) return send(chatId, `@${wallet[1]} has not talked to Restu yet. Ask them to send /start.`)
      c.knownAddresses = [...new Set([...c.knownAddresses, wallet[2]])]
      d.db.saveContact(c)
      d.db.audit('address-verified', null, null, `@${c.username} ${wallet[2]}`)
      return send(chatId, `Verified ${wallet[2].slice(0, 6)}…${wallet[2].slice(-4)} for @${c.username}`)
    }
    const cos = text.match(/^\/cosigner\s+@?(\w+)/)
    if (cos) {
      const c = d.db.getContact(cos[1])
      if (!c?.chatId) return send(chatId, `@${cos[1]} must send /start to @${(await api('getMe')).username} first.`)
      d.db.set('cosigner', c.username)
      d.db.audit('cosigner-set', null, null, `@${c.username}`)
      await send(c.chatId, `You are now the co-signer for Restu payments above ${d.db.rules().cosignOver} GRAM. You will get an Approve / Refuse card when one needs you.`)
      return send(chatId, `Two-person rule on: transfers above ${d.db.rules().cosignOver} GRAM also need @${c.username}.`)
    }
    if (text.startsWith('/nocosigner')) { d.db.set('cosigner', ''); d.db.audit('cosigner-removed', null, null, ''); return send(chatId, 'Two-person rule off.') }
    const blk = text.match(/^\/(un)?block\s+(\S+)/)
    if (blk) {
      const list: string[] = JSON.parse(d.db.get('blocklist') ?? '[]')
      const next = blk[1] ? list.filter(a => a !== blk[2]) : [...new Set([...list, blk[2]])]
      d.db.set('blocklist', JSON.stringify(next))
      d.db.audit(blk[1] ? 'unblocked' : 'blocked', null, null, blk[2])
      return send(chatId, `${blk[1] ? 'Removed from' : 'Added to'} the scam blocklist (${next.length} address${next.length === 1 ? '' : 'es'}).`)
    }
    const bud = text.match(/^\/setbudget\s+([\w:-]+)\s+(\d+(\.\d+)?)/)
    if (bud) {
      const rules = d.db.rules()
      rules.agentBudgets = { ...rules.agentBudgets, [bud[1]]: Number(bud[2]) }
      d.db.set('rules', JSON.stringify(rules))
      d.db.audit('rule-changed', null, null, `budget ${bud[1]}=${bud[2]}`)
      return send(chatId, `Budget for ${bud[1]}: ${bud[2]} GRAM per day.`)
    }
    if (text.startsWith('/contacts')) {
      const rows = d.db.contacts().map(c => `@${c.username} · card: ${c.cardAddress ? `${c.cardAddress.slice(0, 6)}…${c.cardAddress.slice(-4)}` : 'none'}`)
      return send(chatId, rows.join('\n') || 'No contacts yet.')
    }
    if (text.startsWith('/demo') && d.onDemo) return send(chatId, await d.onDemo())
    if (text.startsWith('/start') || text.startsWith('/help')) {
      return send(chatId, 'Restu commands:\n/audit · last actions\n/rules · current policy\n/setrule autoTransferMax 10\n/setrule cosignOver 1\n/setbudget invoice-agent 5\n/cosigner @user · two-person rule\n/nocosigner\n/block ADDRESS · scam blocklist (/unblock)\n/verify @user ADDRESS\n/contacts\n/demo · seed the Acme demo')
    }
  }

  let offset = 0
  let running = false

  return {
    api,
    lookupContact,
    async me() { return api<{ username: string; id: number }>('getMe') },

    async start() {
      running = true
      while (running) {
        try {
          const updates = await api<Update[]>('getUpdates', {
            offset, timeout: 25,
            allowed_updates: ['message', 'callback_query', 'business_connection', 'business_message'],
          })
          for (const u of updates) {
            offset = u.update_id + 1
            try {
              if (u.message) await onMessage(u.message)
              else if (u.callback_query) await onCallback(u.callback_query)
              else if (u.business_connection) {
                // Only the owner's own account may let Restu reply on their behalf.
                const bc = u.business_connection
                if (bc.user_chat_id !== ownerChat()) continue
                if (bc.is_enabled) d.db.set('business_connection_id', bc.id)
                else if (d.db.get('business_connection_id') === bc.id) d.db.set('business_connection_id', '')
                d.db.audit(bc.is_enabled ? 'business-connected' : 'business-disconnected', null, null, '')
              }
            } catch (e) {
              console.error('[telegram] update failed:', (e as Error).message)
            }
          }
        } catch (e) {
          console.error('[telegram] poll failed:', (e as Error).message)
          await new Promise(r => setTimeout(r, 3000))
        }
      }
    },
    stop() { running = false },

    // Owner-facing mirror of the queue (fallback when the glasses are off).
    async notify(r: ApprovalRequest, event: string) {
      const owner = ownerChat()
      if (!owner) return
      if (r.status === 'cosign' && event.endsWith(':needs-cosign')) {
        const c = d.db.getContact(String(d.db.get('cosigner')))
        if (c?.chatId) {
          await send(c.chatId, `✍️ Co-sign needed · ${r.title}
Approved by the owner on their glasses.

${describe(r)}`, {
            reply_markup: { inline_keyboard: [[{ text: 'Co-sign', callback_data: `c:${r.id}:${r.version}` }, { text: 'Refuse', callback_data: `x:${r.id}:${r.version}` }]] },
          })
          await send(owner, `⏳ ${r.title}: waiting for @${c.username} to co-sign.`)
        }
        return
      }
      if (r.status === 'pending' && /^(submitted|corrected|fix:still-held)/.test(event)) {
        await send(owner, cardText(r), { reply_markup: buttons(r) })
      } else if (event === 'executed' || event === 'failed' || event.endsWith('policy-denied')) {
        const icon = event === 'executed' ? '✅' : '⛔'
        await send(owner, `${icon} ${r.title} · ${event}${r.result ? `\n${r.result}` : ''}`)
      }
    },

    // Executor for telegram_message: sends as the owner through a business
    // connection (Chat Automation) when one exists, otherwise as the bot.
    async sendApproved(r: ApprovalRequest): Promise<string> {
      const p = r.payload as TelegramMessagePayload
      const c = d.db.getContact(p.to)
      const chatId = c?.chatId ?? (/^-?\d+$/.test(p.to) ? Number(p.to) : null)
      if (!chatId) throw new Error(`@${p.to} has not started the bot yet`)
      const bc = d.db.get('business_connection_id')
      const extra = bc && c?.userId ? { business_connection_id: bc } : {}
      const sent = await send(bc && c?.userId ? c.userId : chatId, p.text, extra)
      return `sent to @${p.to}${bc ? ' as you' : ' via Restu bot'} (msg ${sent.message_id})`
    },
  }
}

export function describe(r: ApprovalRequest): string {
  const p = r.payload as Record<string, any>
  switch (r.kind) {
    case 'ton_transfer': return `Pay ${p.amount} GRAM to @${String(p.to).replace(/^@/, '')}\n${p.address}${p.memo ? `\nmemo: ${p.memo}` : ''}`
    case 'telegram_message': return `To @${String(p.to).replace(/^@/, '')}:\n"${p.text}"`
    case 'calendar_change': return `${p.eventTitle}: ${p.change} (${p.attendees} people)`
    default: return JSON.stringify(p).slice(0, 200)
  }
}
