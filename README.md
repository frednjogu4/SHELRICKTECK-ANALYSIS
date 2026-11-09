# AURUM Trading Workspace

Real-data-only trading workspace: **Deriv live prices** (public WebSocket, no key), **TradingView** official widgets (charts, news, calendar), **Deriv's existing gated execution path**, **Exness MT5 local read-only verification** (Phase 1; Exness order/close routes disabled in both client and bridge), and **AI guidance** behind a shared **$5/day** budget. No simulated prices or fake content — unavailable data is stated honestly.

## Quick start

```bash
npm install
npm run api        # API  → http://localhost:4100  (live Deriv candles, AI, trading relay)
npm run website    # website → http://localhost:5173  (production build of dist/ + /api proxy)
npm test           # app smoke + server regression suites
npm run build      # (re)build the website → dist/index.html + dist/AURUM_Workspace.html
```

`npm run dev` remains available for development (Vite dev server, same proxy).

## Put the website online

The whole website is **one file**: `dist/AURUM_Workspace.html` (also copied to
`/home/user/AURUM_Workspace.html`). It works three ways:

1. **Open locally** — double-click the file. Live Deriv prices, TradingView
   charts/news and notifications work immediately (browser network required).
   Analysis/scan/briefs show an honest "API server is not running" state.
2. **Static hosting (free)** — upload the single file as `index.html` to any of:
   Netlify Drop (drag-and-drop at app.netlify.com/drop), GitHub Pages (repo →
   Settings → Pages), Cloudflare Pages, or Vercel. ~2 minutes, no code needed.
   Same behaviour as (1): front-end fully live; AI analysis needs the API.
3. **Full website (API included)** — deploy two processes on any Node host
   (Railway, Render, Fly.io, a VPS): `npm run api` and `npm run website`
   (or put `server/websiteserver.js` behind your own reverse proxy with HTTPS).
   Set env keys in `.env.example` on the host. Then analysis, AI engines and
   Deriv execution all work end-to-end on the public URL.

Never upload `.env.local` or paste a PAT into hosting settings — the PAT is
entered by the user in the app at runtime, per browser session.

## MT5 convenience, session status, and signal timing

- During a connected browser-tab session, AURUM keeps Exness login, server, MT5 password and bridge token in `sessionStorage` so a page refresh can reconnect. It does not write those secrets to `localStorage` or the server. They are cleared on disconnect/sign-out or when the tab session ends. Use **Forget saved Exness details** to clear saved values immediately.
- Forex/commodity open/closed badges use typical Deriv session hours in UTC; crypto/synthetics are marked 24/7. Index badges remain **UNKNOWN** until a fresh local Exness MT5 tick and terminal trade mode are available. A broker's own symbol schedule is authoritative.
- Markets show approximate higher-activity windows in Nairobi time (EAT), with daylight-saving caveats. They are context only—not a guaranteed best time, profitability claim, or substitute for checking the live spread and broker schedule.
- Analyzer results identify the M1/M5/H1 confluence and suggest reviewing after the next M5 candle close. That is a refresh reminder, not a fixed signal expiry or holding-time guarantee.
- The separate Gold/USD monitor auto-refreshes deterministic M1/M5/H1 analysis once per minute while enabled and AURUM is open after you have opened the Gold view once. It prefers fresh Exness MT5 local candles when that bridge is connected; otherwise it uses fresh Deriv public candles. It fails visibly on stale/unavailable data and never silently switches providers. Scheduled USD high-impact events generate 15-minute and 5-minute alerts while the monitor is active; matching headlines are best-effort, not exhaustive or guaranteed real-time. Signal/event updates can be auto-shared through the existing WhatsApp setting when configured. All outputs are analysis-only; the Gold monitor does not place orders.


## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on 5173, proxies `/api` → 4100 |
| `npm run api` | Express API on 4100 (live Deriv candles, AI engines, budget, Deriv execution relay) |
| `npm test` | `tests/smoke.mjs` (jsdom, mocked feed+API) + `server/tests/` (node:test, injected stub feed — no network) — includes the 12-pattern recognition battery |
| `npm run build` | Single-file HTML (vite-plugin-singlefile) + copy to `dist/AURUM_Workspace.html` |

## Architecture

```
browser ── wss://api.derivws.com/trading/v1/options/ws/public   live ticks (marketdata.js)
browser ── https://s3.tradingview.com/...                       chart/news/calendar widgets (tradingview.js)
browser ── /api ──> Express :4100 ── Deriv candles              analyzer + AI decisions (budget-gated)
                      │
                      └── /api/deriv (WS relay + REST proxy) ── Deriv WS  [env token, server-side only]
                           proposal → confirm → buy  (trading OFF by default, server-side limits)
                      └── /api/backtest ── walk-forward over real Deriv candles (same indicator engine)
browser ── local/LAN only ──> bridge/mt5_bridge.py ──> Exness MT5 terminal [Windows PC; read-only Phase 1]
```

- **Instrument universe**: `server/lib/symbols.js` — single source of truth for supported instruments and verified TradingView symbols; index CFDs are Exness MT5-only, never Deriv-orderable, and remain excluded from automation.
- **AI budget**: device-wide ledger under `local` (`server/lib/store.js` usage rows) — switching sessions never resets the $5/day cap. Keys come from Settings vault (`x-ai-*` headers) or server env (`.env.example`).
- **Trading**: Deriv orders relay through `/api/deriv/*` with the existing gated auth flow. Exness uses the local bridge protocol for read-only account/position/quote/symbol/history checks; app-side and Python order/close handlers are hard-disabled for Phase 1. Exact server and Exness identity are verified locally; the bridge pins one account/server for connected PC/phone clients.
- **Notifications**: `src/notify.js` — browser Notification + toasts for feed, analysis, news briefs, trade lifecycle, TP1 guidance / TP2 / SL crossings (`src/main.js` level watcher).
- **Honesty rules** (tests enforce): live feed down → `502 live_data_unavailable` (never simulated candles); no keys → `technical` mode label (never fake AI); no broker → orders blocked (never demo fills).

## Key files

```
index.html            UI shell (connect screen, views, Settings key vault)
src/main.js           app logic (feed wiring, scanner, trading, notifications)
src/marketdata.js     Deriv public WS engine (reconnect + watchdog)
src/tradingview.js    Advanced Chart / timeline / calendar mounts
src/notify.js         notifications engine
src/vault.js          AI key vault (localStorage, x-ai-* headers)
src/bridge.js         Exness MT5 local bridge client (Phase 1 read-only)
server/app.js         Express routes: analyze, scan, news, usage, health, deriv/*
server/lib/           analyzer, decision (Claude/OpenAI/Perplexity), derivfeed, tradederiv, store
bridge/               Exness MT5 local read-only bridge (Python, MetaTrader5) — see bridge/README.md
server/lib/derivconn.js persistent Deriv connection manager (authorize-first, ping 30s, backoff+re-subscribe)
server/derivproxy.js    /api/deriv REST + WS relay — token never reaches the browser
server/lib/backtest.js  walk-forward backtest on real candles (no simulated data anywhere)
server/lib/patterns.js  12-pattern recognition engine (pivots, ATR geometry, walk-forward study, PATTERN_META education)
tests/smoke.mjs       full-journey jsdom suite (scripted fake WS + mocked /api)
src/patterns.js       pattern UI: /api/patterns client + SVG candle chart + playbook + perf bars
```

Setup / keys walkthrough: see `../SETUP_GUIDE.md` (Part A = activate live build, Part B = deferred Phase 1).
