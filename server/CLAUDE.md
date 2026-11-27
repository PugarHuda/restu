# server/

Node 22.13+, ESM, TypeScript run directly by Node (type stripping). Use `import type` for types and `.ts` extensions in imports; no enums, no parameter properties (`erasableSyntaxOnly`).

## Commands
- `npm start`: run (loads `.env` via `process.loadEnvFile`)
- `npm test`: `node --test test/*.test.ts` (node:test + assert, no framework)
- `npm run typecheck`: `tsc --noEmit`

## Modules (`src/`)
| File | Role |
|---|---|
| `types.ts` | shared shapes + `DEFAULT_RULES` |
| `policy.ts` | pure policy engine → verdict auto/ask/hold/deny |
| `scam.ts` | pure outgoing-payment checks (wallet card, look-alike, first-time, spike, night) |
| `intents.ts` | HMAC intents bound to payload version, single-use, TTL |
| `queue.ts` | submit → assess → schedule (undo window) → tick executes; decide/fixToCard/correct/undo |
| `db.ts` | `node:sqlite` store (requests, audit, contacts, payments, kv, devices) |
| `view.ts` | builds the exact glasses text (header/body/footer) |
| `http.ts` | node:http API: `/v1/requests` (agents), `/v1/glass/*` (device token), `/v1/pair/start` |
| `telegram.ts` | Bot API via fetch: pairing, contacts + `ton_wallet_card`, bot-to-bot requests, owner fallback buttons, business-connection send |
| `ton.ts` | TON testnet executor (WalletContractV4) |
| `sheets.ts` | ASK: deterministic cell lookup over Google Sheets/CSV |
| `calendar.ts` | ICS parse → current meeting → context terms |
| `llm.ts` | Claude (`claude-opus-5-5`, effort low, server-side fallbacks) for drafts and correction parsing, with fallbacks |
| `stt.ts` | PCM → WAV → OpenAI-compatible transcription endpoint |
| `demo.ts` | Acme demo seed + `poisonedTwin` (grinds a real look-alike address) |
| `mcp.ts` | stdio MCP server exposing `request_approval` / `check_request` |

## Conventions
- Pure logic (policy, scam, intents, lookup) takes everything as arguments → unit-tested.
- Corrections are whitelisted per kind (`CORRECTABLE` in queue.ts); the payment address only changes via `fixToCard`.
- Short, ASCII-safe reason strings: they are rendered on the glasses.
