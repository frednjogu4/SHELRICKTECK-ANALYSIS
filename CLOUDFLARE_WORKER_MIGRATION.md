# Cloudflare Worker signal API — staging migration

## What this migration implements

- A separate Cloudflare Worker entry point at `cloudflare/worker.js`; the existing Express server remains unchanged.
- Static UI assets served from `dist/`, with `/api/*` routed through the Worker. The refreshed Sniper UI is included in the current build: selected markets are the default view and setup rows show timeframe, entry, SL, TP1, and labelled source.
- Read-only endpoints for deterministic signal scans/analysis, Deriv public active-symbols/ticks/candles, health, and basic signal history/usage compatibility.
- Source labels: `Deriv public candles` for Deriv instruments and `Yahoo Finance public daily data` for the supported index daily read.
- Cloudflare Rate Limiting bindings are required for provider-backed endpoints (8 signal requests/min/IP; 60 market/history requests/min/IP); missing bindings fail closed.
- The Worker itself has no PAT/account routes, broker orders/closes, risk-gate routes, WhatsApp sending, or durable user/signal storage. The browser-only Deriv read-only connection described below does not change the Worker API surface.
- Exness MT5 stays on the PC. The browser computes Exness signal analysis locally on Cloudflare-hosted pages; the Worker rejects any Exness candle upload. On Cloudflare, the Exness tab is hidden/disabled and the app does not restore saved Exness credentials or contact the bridge. If local Exness data is unavailable, the app can use the explicitly labelled public fallback.

## Deriv staging session and live-market policy

- Cloudflare staging accepts only a **Deriv Classic API token with Read scope and no other scopes**. The app authorizes directly from the browser tab to Deriv's official WebSocket and fails closed if the authorization response does not show Read-only scope.
- The Deriv token is held in `sessionStorage` for this tab and sent only to Deriv. The account response remains in browser memory. Neither is posted, logged, or persisted by the Cloudflare Worker; hosted browser calls to `/api/deriv/*` are blocked. New-API PAT/server sessions are unavailable in hosted mode.
- Hosted mode disables and blocks order proposals, buys, confirmations, and contract closes, including saved-position/automation paths. Trading is analysis-only. Exness credential entry and saved-session restore are blocked on Cloudflare; use the PC-local app for Exness.
- The public `/api/markets/deriv` catalogue shows all active Deriv symbols. The default built-in symbol subscriptions are disabled on Cloudflare. A user must click **Follow live** on individual catalogue rows to start direct browser WebSocket tick streams; at most 20 symbols can be followed simultaneously. **The catalogue is complete as returned by Deriv, but the app does not promise live quotes for every listed market or for unselected symbols.**
- Exness symbols/candles remain local and are never streamed through the Cloudflare Worker.

## Local verification

```sh
npm ci
npm test
npm run build
# Wrangler 4.137.0 requires Node.js 22 or newer
npx --yes --package=node@22 --package=wrangler@4.137.0 -c 'node "$(command -v wrangler)" dev --config wrangler.jsonc --local --port 8790'
```

The unit tests use mocked providers. In this workspace, a local Wrangler smoke test successfully reached the public Deriv WebSocket and Yahoo Finance chart endpoint; that verifies the local Worker runtime path only, not a deployment in your Cloudflare account.

## Cloudflare staging deployment — do not use production credentials

The separate staging project should build from this repository using:

- Build command: `npm ci && npm run build`
- Node.js build environment: `22`
- Deploy command: `npx --yes wrangler@4.137.0 deploy --config wrangler.jsonc`
- Worker entry: `cloudflare/worker.js`
- Static assets: `dist/`
- Secrets/bindings: none for this technical-only stage

Keep the GitHub repo private, use the `cloudflare-staging` Worker name, and do not attach a production domain. The `workers.dev` URL is public. The config declares `AURUM_SIGNAL_LIMITER` (8 requests/minute per IP) and `AURUM_MARKET_LIMITER` (60 requests/minute per IP). The namespace IDs are numeric binding identifiers, not secrets; if either is already used in your Cloudflare account, change it to another unique integer before deploying. The Worker refuses provider-backed requests if either binding is missing.

## Known limitations

- The Worker is technical-only; `/api/signals/usage` reports zero AI spend, and `/api/signals/history` is empty (no database is connected).
- Yahoo index data is daily and remains labelled; it is not M1/M5/H1 data and does not invent entry/SL/TP levels.
- News, six-role pipeline, AI engines, account/PAT, trading, and other non-migrated routes are intentionally unavailable.
- The UI remains analysis-only in the public staging preview. Deriv read-only credentials must be a dedicated Read-only Classic token; never enter a token with Trade, Payments, or Admin scopes. The token is sent from this tab directly to Deriv (not Cloudflare) and is cleared on sign-out/tab close. Revoke it in Deriv if you no longer need it.
- No Cloudflare deployment or remote database provisioning is performed by this change.
