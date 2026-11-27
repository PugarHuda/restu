# Restu

**Your agents ask. Your glasses decide.**

Restu is an approval layer for AI agents, messages and payments, worn on **Even Realities G2**.
Every agent that wants to act (send a Telegram reply, pay an invoice in GRAM, move a meeting)
files a request. A policy engine lets the small, safe ones run on their own; the rest reach your
lens as one card you settle with one tap. Mid-meeting, hold the ring and ask a number: Restu answers
from your own spreadsheet, with the cell it came from.

> *Restu* is Indonesian for "blessing / consent", what you give before something may happen.

Track: **AI Assistants & Work** (core: Claude, Google Workspace) · second track **Crypto & DeFi** (Gram/TON testnet) · built for **Best Telegram integration**.

![Held invoice on G2](docs/shots/02-held-invoice.png)

## The problem

1. **Agents can act now, but a human still has to sign.** Every approval pulls you to your phone, often mid-meeting.
2. **Approve-everything trains people to click without reading.** Approve-nothing lets agents send the wrong thing. You need a *policy*, not more prompts.
3. **Outgoing-payment scams.** Address poisoning and impersonators are the main crypto scam on Telegram. The payment apps we saw check money *coming in*; nobody checks "is this payment going to the right person?"
4. **In meetings the numbers live in a spreadsheet.** A G2 owner on r/EvenRealities: *"The dream: I'm in a client meeting and can quietly ask Claude to pull up numbers from my connected apps, without picking up my phone."*

## What it does

| | |
|---|---|
| **One queue for every agent** | Claude agents (MCP or HTTP), other Telegram bots (bot-to-bot, Bot API 10.0), and Restu's own follow-up / invoice / calendar agents file requests in one place. |
| **Policy, not prompts** | Replies to known contacts, transfers ≤ 10 GRAM to a verified address and small calendar edits run on their own, after an undo window. Bigger, newer or riskier actions ask. Unknown agents are denied. Daily cap. Rules editable from Telegram (`/setrule`). |
| **Outgoing-payment anti-scam** | Before money leaves, Restu checks the address against the recipient's **Telegram wallet card** (`getChat().ton_wallet_card`, Bot API 10.4), flags first-time addresses, **look-alike (poisoned) addresses**, unusual amounts and night-time requests. A high-risk payment is *held*: it cannot be approved with a tap; the one-tap fix pays their verified wallet-card address instead. |
| **Intents bound to what you saw** | Approving sends back an HMAC intent tied to the exact payload version, single-use, 5-minute TTL. An agent cannot swap the amount or recipient after the card was shown. A spoken correction can change the amount or text, never the address. |
| **Undo + audit** | Everything waits out a 10–30 s undo window (swipe ▲). Every decision, auto-run and execution lands in one audit log, mirrored to Telegram (`/audit`). |
| **ASK: your numbers, mid-meeting** | Hold, say "renewal value" → `$48,000 · Acme · Renewal value · Deals!B2 · read 14:41`. Live Google Sheets (or CSV), deterministic cell lookup, scoped to the meeting you are in (calendar ICS). No matching cell → no answer. Nothing is generated. |

## On the glasses

576 × 288, three text boxes, three gestures (the G2's most criticised part is its input, so Restu never needs more):

| Gesture | Card | Home |
|---|---|---|
| **Tap** | approve (held payment: pay their verified card) | – |
| **Swipe ▼** | deny | – |
| **Swipe ▲** | undo what you just approved, otherwise "later" | undo |
| **Hold** | speak a correction ("make it 20") | ask a number |
| **Double-tap** | exit (Even Hub rule) | exit |

| | | |
|---|---|---|
| ![home](docs/shots/01-start.png) | ![held](docs/shots/02-held-invoice.png) | ![fixed](docs/shots/03-fixed.png) |

## Architecture

```
 Claude / any MCP agent ──MCP──┐
 Other Telegram bots ──bot-to-bot──┤
 Restu agents (follow-up, invoice) ┤      ┌──────────── Restu server (Node 22) ────────────┐
                                   └────► │ queue → scam checks → policy → intent → undo → │──► Telegram (send as you via
                                          │ executors      audit log (SQLite)              │     business connection)
 Google Sheets / ICS calendar ──────────► │ ASK: deterministic cell lookup                 │──► TON testnet (agent wallet)
 Telegram getChat → ton_wallet_card ────► │                                                │
                                          └───────────────┬────────────────────────────────┘
                                                          │ HTTP (whitelisted, CORS)
                                  Even app WebView: Restu glasses app (Even Hub SDK 0.0.16)
                                                          │ BLE
                                                     Even G2 + R1 ring
```

- `server/`: Node 22, TypeScript run natively (`--experimental-strip-types`), `node:sqlite`, zero framework. Deps: `@anthropic-ai/sdk`, `@ton/ton`.
- `glasses/`: Even Hub app (Vite + TS). The server renders every line; the app is a thin renderer (no keys, no business logic), so it survives Android WebView suspends.
- Plugins cannot run in the background, so **Telegram is the push channel**: anything that needs you also arrives as a Telegram card with Approve / Deny buttons.

## Run it

Requirements: Node 22.13+.

```bash
# 1. server
cd server
npm install
cp .env.example .env         # DEMO_MODE=1 works with no keys at all
npm test                     # 23 tests: policy, scam checks, intents, queue, ASK, ICS
npm start                    # http://localhost:8787

# 2. glasses app + simulator
cd ../glasses
npm install
npm run dev                  # http://localhost:5173
node node_modules/@evenrealities/evenhub-simulator/bin/index.js http://localhost:5173

# 3. load the story
#    click "Load Acme demo" on the phone page, or send /demo to your bot
```

With `TELEGRAM_BOT_TOKEN` unset, `DEMO_MODE=1` and no agent wallet, the glasses pair themselves and the server listens on 127.0.0.1 only (local simulator mode). Pairing codes are unique, expire after 10 minutes, and `/pair` allows 5 wrong tries per chat. With it set, the glasses show a 6-digit code; send `/pair <code>` to your bot.

On real G2: `npx evenhub qr --url http://<your-LAN-IP>:5173` and add that server origin to `app.json` → `network.whitelist`. Package with `npm run pack` → `restu.ehpk`.

### Connect an agent (MCP)

```bash
claude mcp add restu -e RESTU_URL=http://localhost:8787 -e RESTU_AGENT_KEY=<key from AGENT_KEYS> \
  -- node --experimental-strip-types --no-warnings /path/to/restu/server/src/mcp.ts
```

Tools: `request_approval({kind, title, payload, wait_seconds})` and `check_request({id})`. The agent should only proceed when the status is `done` or `scheduled`.

### Or plain HTTP

```bash
curl -X POST localhost:8787/v1/requests -H "authorization: Bearer <agent key>" -H "content-type: application/json" \
  -d '{"kind":"ton_transfer","title":"Pay Acme invoice #41","payload":{"to":"omar_acme","address":"0Q...","amount":25}}'
```

### Telegram commands (owner)

`/audit` · `/rules` · `/setrule autoTransferMax 10` · `/verify @user ADDRESS` · `/contacts` · `/demo`

## Safety and the hackathon rules

- **Testnet only.** The TON executor is hard-wired to the testnet endpoint; the agent wallet is a testnet wallet. No user funds are held; Restu never touches your own wallet.
- No API keys in the glasses app; speech-to-text and Claude run server-side. The `.ehpk` contains only the renderer.
- A voice correction cannot change a payment address; held payments cannot be approved by tap.
- Without Claude, an STT key or Google credentials, every part still works with deterministic fallbacks.

## What existed before Nov 23, 2026

Nothing. Restu was designed and built during the Heads Up build week. It uses the official Even Hub minimal template (`even-realities/evenhub-templates`) as the starting point for `glasses/`, and open-source libraries listed in each `package.json`.

## API feature requests (for Even Realities and Telegram)

1. **Even Hub: background wake for plugins.** A way for a plugin's server to raise a single glanceable card while the plugin is closed (today Restu falls back to Telegram notifications).
2. **Even Hub: built-in on-device speech-to-text** for plugins, so short commands ("make it 20") need no cloud round-trip or third-party key.
3. **Even Hub: a "confirm" system dialog** rendered by the OS (not the plugin) for high-stakes actions, so users can trust that the confirm screen was not spoofed.
4. **Telegram Bot API: a bot method to request a TON/Gram transfer** that the user confirms in Telegram's own sheet (today only TON Connect / links exist), so policy engines like Restu can hand off execution without holding any wallet.
5. **Telegram Bot API: a verified "wallet card changed" update**, so a recipient switching their wallet card can trigger re-verification instead of being discovered at payment time.

## License

MIT
