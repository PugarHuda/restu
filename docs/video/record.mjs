// Records the Restu demo: real screenshots from the Even Hub simulator (glasses)
// and the user's Telegram Web tab (via the CDP bridge), then ffmpeg stitches them.
import { writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\/]$/, '')
const OUT = fileURLToPath(new URL('./frames', import.meta.url))
const API = 'http://localhost:8787'
const SIM = 'http://localhost:9898'
const BRIDGE = 'http://127.0.0.1:4999'
mkdirSync(OUT, { recursive: true })

const db = new DatabaseSync(`${ROOT}/server/data/restu.db`)
const device = db.prepare('select token from devices where chat_id is not null order by created_at desc limit 1').get().token
const agentKey = (await import('node:fs')).readFileSync(`${ROOT}/server/.env`, 'utf8').match(/invoice-agent:([^,\s]+)/)[1]

const sleep = ms => new Promise(r => setTimeout(r, ms))
const scenes = []
let n = 0

async function glasses(caption, secs = 4) {
  const res = await fetch(`${SIM}/api/screenshot/glasses`)
  const file = `${OUT}/s${String(++n).padStart(2, '0')}-g.png`
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  scenes.push({ file, caption, secs, kind: 'glasses' })
}
async function bridge(code) {
  const r = await fetch(BRIDGE, { method: 'POST', body: code })
  return r.text()
}
async function telegram(caption, secs = 5) {
  const file = `${OUT}/s${String(++n).padStart(2, '0')}-t.png`
  await bridge(`await page.screenshot({ path: '${file}' }); return 'ok'`)
  scenes.push({ file, caption, secs, kind: 'telegram' })
}
const tg = text => bridge(`
  const box = page.locator('.chat.active .input-message-input[contenteditable="true"]').first();
  await box.focus(); await box.fill(${JSON.stringify(text)}); await page.keyboard.press('Enter');
  await page.waitForTimeout(4000); return 'sent'`)
const sim = action => fetch(`${SIM}/api/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
const card = async () => (await (await fetch(`${API}/v1/glass/state`, { headers: { 'x-device': device } })).json())

function title(caption, secs) { scenes.push({ file: null, caption, secs, kind: 'title' }) }

// ---- reset to a clean day ---------------------------------------------------
db.exec("delete from requests; delete from audit; delete from payments;")
await bridge(`const p = ctx.pages().find(x => x.url().includes('web.telegram.org')); setPage(p); await p.bringToFront(); return 'tg'`)
await bridge(`
  const s = page.locator('input.input-search-input').first();
  await s.click(); await s.fill('restu_glasses_bot'); await page.waitForTimeout(3000);
  const l = page.locator('.search-group a').filter({ hasText: '@restu_glasses_bot' }).first();
  await l.click(); await page.waitForTimeout(3000); return 'ok'`)
await sleep(2500)

// ---- story --------------------------------------------------------------------
title('Restu\nYour agents ask. Your glasses decide.\n\nAn approval layer for AI agents, Telegram messages and Gram payments on Even Realities G2', 5)
title('Agents can now reply, reschedule and pay.\nEvery approval still drags you to your phone, often mid-meeting.\nApprove everything and you stop reading. Approve nothing and agents send the wrong thing.\nAnd address-poisoning scams target exactly the payments you approve in a hurry.', 8)
await glasses('On the lens: Restu knows you are in the Acme renewal (calendar).\nToday is clean: nothing needs you.', 4)

await fetch(`${API}/v1/glass/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device': device }, body: JSON.stringify({ text: 'renewal value' }) })
await sleep(2200)
await glasses('ASK, mid-meeting: "renewal value"\nAnswered from the live sheet, scoped to Acme by the meeting. The exact cell is cited. No cell, no answer.', 7)
await sleep(7000)

await tg('/demo')
await sleep(3000)
await telegram('Three agents file requests: a follow-up, a calendar move, an invoice and a courier fee.\nTelegram is the fallback channel: every card also arrives here with buttons.', 6)

await sleep(1500)
await glasses('The invoice is HELD. Its address copies the first and last characters of Omar\'s real one (address poisoning).\nRestu checked it against Omar\'s Telegram wallet card (Bot API 10.4). A held payment cannot be approved by tap.', 9)

await sim('click')
await sleep(1800)
await glasses('One tap: pay Omar\'s verified wallet-card address instead.\nIt waits 30 s in the undo window. Swipe up to undo.', 5)
await sleep(3500)
await glasses('Next: moving the Acme kickoff touches 4 people, so the policy asks.\nSmall, known actions (the follow-up, a 2 GRAM courier fee) already ran on their own.', 6)
await sim('click')
await sleep(1500)
await glasses('Approved with one tap. Every approval carries a signed intent bound to exactly what you saw.', 4)

// let the undo windows pass so things actually execute
await sleep(60000)
await glasses('Back to calm: the header counts what ran on its own, what needed you, and what was blocked.', 5)
await telegram('Executed for real: the follow-up was sent, and GRAM moved on TON testnet to the verified address.', 6)
await tg('/audit')
await sleep(1500)
await telegram('One audit log for every agent and every decision (/audit).', 5)

// ---- an outside agent over HTTP (same path the MCP server uses) -------------
await fetch(`${API}/v1/requests`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${agentKey}` },
  body: JSON.stringify({ kind: 'ton_transfer', title: 'Claude agent: refund Initech', payload: { to: 'lynx129', address: '0QBCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQoOt', amount: 40 } }),
}).catch(() => {})
await sleep(2500)
await glasses('Any agent can ask: Claude Code / Claude Desktop through the Restu MCP server (request_approval), or plain HTTP.\nHere an agent asks to send 40 GRAM to an unknown address: held, with reasons.', 7)
await sim('scroll_down').catch(() => {})
await sleep(1500)
await glasses('Swipe down: denied. The agent gets "denied" back and stops.', 4)

title('Restu\n\nOne queue for every agent · policy, not prompts · outgoing-payment anti-scam via Telegram wallet cards\nSigned intents · undo window · one audit log · numbers from your own sheet\n\nTestnet only · no keys on the glasses · github.com/PugarHuda/restu', 8)

writeFileSync(`${OUT}/scenes.json`, JSON.stringify(scenes, null, 1))
console.log(`captured ${scenes.length} scenes`)
