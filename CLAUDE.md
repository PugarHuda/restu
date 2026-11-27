# Restu

Approval layer for AI agents, messages and TON/Gram payments on Even Realities G2.
Hackathon: Heads Up (DoraHacks, TVM Ventures × Daos Hub). Research and decisions: `../ANALISA-HACKATHON.md`, `../PAIN-POINTS-DAN-IDE.md`, `../IDE-FINAL.md`.

## Layout
- `server/`: Node 22.13+ backend, TypeScript executed natively (`--experimental-strip-types`). See `server/CLAUDE.md`.
- `glasses/`: Even Hub app (Vite + TS, SDK 0.0.16), thin renderer. See `glasses/CLAUDE.md`.
- `docs/shots/`: simulator screenshots (from the simulator automation API).

## Run
```bash
cd server && npm start            # :8787, reads server/.env
cd glasses && npm run dev         # :5173
node glasses/node_modules/@evenrealities/evenhub-simulator/bin/index.js http://localhost:5173 --automation-port 9898
```
`npx evenhub-simulator` does not resolve on this machine; call the package's `bin/index.js` directly.

## Rules of the project
- Testnet only for TON. Never add a mainnet endpoint.
- No secrets in `glasses/` (anyone can unpack an `.ehpk`). Keys live in `server/.env` (gitignored).
- The server decides every line shown on the glasses (`server/src/view.ts`); keep the app thin.
- Glasses font: no emoji, no ✓ ✗ ⚠ ≠ ≤. Safe glyphs: ● ○ ▲ ▼ ▶ ▷ ■ □ ━ ─ │.
