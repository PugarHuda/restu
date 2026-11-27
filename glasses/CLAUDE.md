# glasses/

Even Hub app (WebView inside the Even Realities app → G2 over BLE). Started from `even-realities/evenhub-templates/minimal`.

## Commands
- `npm run dev`: Vite on :5173 (`VITE_RESTU_API` overrides the server URL, default `http://localhost:8787`)
- `npm run build`: typecheck + build to `dist/`
- `npm run pack`: build + `evenhub pack` → `restu.ehpk`

## Files
- `src/main.ts`: bridge, pairing token (bridge localStorage), 3 text containers (header/body/footer, body captures events), polling `/v1/glass/state` every 1.5 s, gesture → action, long-press voice capture (PCM → `/v1/glass/voice`).
- `src/api.ts`: typed client for the server.
- `src/companion.ts`: phone-side page: mirror of the lens + typed ask/edit + demo button (simulator fallback for voice).
- `app.json`: `package_id com.bangdrop.restu`; network whitelist must contain the server origin.

## SDK gotchas (0.0.16)
- A tap arrives with `eventType` undefined (protobuf drops 0): resolve to CLICK only inside an existing envelope (`typeOf()`).
- Taps/long-press come on `sysEvent`, swipes on `textEvent`; double-tap must call `shutDownPageContainer(1)`.
- Update text with `textContainerUpgrade` (no flicker); `containerID` + `containerName` must match exactly.
- Mic only works after `createStartUpPageContainer`.
