# AURUM Trading Workspace

Real-data-only trading workspace: **Deriv live prices** (public WebSocket, no key), **TradingView** official widgets (charts, news, calendar), **Deriv's existing gated execution path**, **Exness MT5 local read-only verification** (Phase 1; Exness order/close routes disabled in both client and bridge), and **AI guidance** behind a shared **$5/day** budget. No simulated prices or fake content — unavailable data is stated honestly.

## Quick start

```bash
npm install
npm run api        # API  → http://localhost:4100  (live Deriv candles, AI, trading relay)
npm run website    # website → http://localhost:5173  (production build of dist/ + /api proxy)
npm test           # app smoke + server, app and platform regression suites (no network access)
npm run build      # (re)build the website → dist/ (index.html, AURUM_Workspace.html, PWA files, _headers)
```

`npm run dev` remains available for development (Vite dev server, same proxy).

Use Node.js 22.12 or newer (checked on 22.22 and 24.22). Wrangler, the
Cloudflare tool, does not start on Node 20, which is also past its end of life.
The Cloudflare staging deployment has its own section below:
[Cloudflare staging (read-only)](#cloudflare-staging-read-only).

## Put the website online

The whole website is **one file**: `dist/AURUM_Workspace.html`. It works three ways:

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
| `npm run website` | Static server for `dist/` on 5173 with an `/api` proxy → 4100 |
| `npm test` | `tests/smoke.mjs` (jsdom, mocked feed+API), then every `*.test.mjs`/`*.test.js` in `server/tests/`, `tests/` and `tests/platform/` (node:test) — includes the 12-pattern recognition battery. Outbound connections are blocked while the tests run (see below) |
| `npm run test:server` / `npm run test:platform` | Only the `server/tests/` group / only the Cloudflare and tooling group in `tests/platform/` |
| `npm run test:worker` | The Worker in the real Cloudflare runtime (`wrangler dev`, local only). Needs `npm run build` first |
| `npm run build` | Single-file HTML (vite-plugin-singlefile), copy to `dist/AURUM_Workspace.html`, then check that `dist/` is complete |
| `npm run verify` | Build → `npm test` → `npm run test:worker` → Wrangler deploy dry-run. One command to run before any deployment |
| `npm run verify:dist` | Check an existing `dist/` (required files, security headers file, nothing secret-looking) without rebuilding |
| `npm run cf:dev` | Build, then run the Cloudflare Worker and the site locally on http://localhost:8790 |
| `npm run cf:dry-run` | Build, bundle the Worker and print its bindings. Uploads nothing |
| `npm run cf:deploy:staging` | Build and **deploy** the `cloudflare-staging` Worker. Needs Cloudflare credentials; run only with explicit approval |

**Tests and the network.** `npm test` loads `scripts/test-network-guard.mjs` into
every test process: a connection to anything other than this machine is refused
immediately, so a test run cannot reach a broker, a data provider or any other
outside service, and gives the same result offline and in CI. (One older test,
the `/api/deriv/diagnose` case in `server/tests/risklimits.test.mjs`, would
otherwise send a dummy token to Deriv and open its public WebSocket on every
run.) `AURUM_TEST_ALLOW_NETWORK=1 npm test` restores the previous behaviour.
`npm run test:worker` is separate: the tests themselves stay on this machine,
but Wrangler contacts `workers.cloudflare.com` when it starts.

## Cloudflare staging (read-only)

`cloudflare/worker.js` and `wrangler.jsonc` publish the built site plus a small
**read-only** signal API as the Cloudflare Worker `cloudflare-staging`. It is a
separate runtime from the Express server: no broker orders, no account or PAT
routes, no AI engines, no database. Scope and background are in
`CLOUDFLARE_WORKER_MIGRATION.md`.

Wrangler is a pinned devDependency (`wrangler@4.156.2`), installed by `npm ci`.
Use the npm scripts or `npx wrangler`; no global install is needed.

### One workspace, two places (cloud + PC)

The Cloudflare site and the PC app are the same application build. The page
works out where it is running and switches on only what that place can do:

| | Cloud viewer (Cloudflare) | PC app (local) |
|---|---|---|
| Open it | the `*.workers.dev` address, from any device | `http://127.0.0.1:8788/app` on the trading PC |
| Live prices | built-in watchlist from the public Deriv feed, straight into the browser (no account, no token) | the same feed, plus Exness/MT5 quotes once the bridge is connected |
| Signals and analysis | the Worker, from Deriv public candles (Yahoo daily data for index CFDs), labelled `AURUM cloud analysis` | Exness/MT5 data first; public sources only as a labelled fallback |
| Orders, accounts, Exness/MT5 | not available: hidden or blocked in the page and refused by the Worker (`403`) | available |
| Top bar | `Cloud · view only` | `proxy · …` (state of the local Deriv proxy) |
| Settings → About → Mode | `Cloud viewer · read-only` | `Full workspace` |

Both places show real data only. The feed label says `Deriv live feed` in the
cloud viewer only while ticks are arriving; with an open connection and no
ticks yet it says `Deriv feed · connected · waiting for ticks`, and when the
browser cannot open the feed it says `Deriv feed · unavailable` (hover the
label for the browser's reason). Prices then show `—`; nothing is estimated.

The cloud viewer cannot reach the PC, the MT5 bridge or any broker account, and
it is not meant to. Use it to watch prices and signals away from the desk and
the PC app to act on them.

### Before any deployment

```bash
npm ci
npm run verify              # must finish without errors
```

### Deploying staging (manual, only when approved)

```bash
npx wrangler login          # once per machine, or set CLOUDFLARE_API_TOKEN in your shell
npm run cf:deploy:staging
```

Then check the published URL:

- `/api/health` answers `"runtime":"cloudflare-readonly"` and `"execution":false`
- `/api/deriv/health` answers `403` with `broker_execution_routes_disabled`
- `/` carries `content-security-policy`, `x-frame-options` and `x-robots-tag` headers
- `/does-not-exist.js` answers `404`, not the app page

If the Worker is deployed by Cloudflare's Git integration (Workers Builds)
instead, use build command `npm ci && npm run build` and deploy command
`npx wrangler deploy --config wrangler.jsonc`. A deploy that skips the build
now stops with "dist verification FAILED" rather than publishing a site without
its service worker, manifest, icons and headers file. To pin the Node version
there, set the build variable `NODE_VERSION` (22 or 24) in the Cloudflare
dashboard.

### What the configuration does

- **Routing.** `/api` and `/api/*` always run the Worker. Other requests are
  answered from `dist/`. A path that is not a file falls through to the Worker:
  app routes such as `/app` and deep links get the app page, anything that
  looks like a file (`/missing.js`, `/.env`, `/wp-login.php`) gets a plain `404`.
- **API surface.** `GET /api/health`, `/api/signals/usage`, `/api/signals/history`,
  `/api/markets/deriv`; `POST /api/signals/scan`, `/api/signals/analyze`,
  `/api/markets/deriv/candles`, `/api/markets/deriv/tick`, `/api/history/candles`.
  `/api/deriv*`, `/api/risk*` and `/api/ctl*` are refused first with `403` for
  every method. Any other `/api` path answers `501 cloudflare_route_not_migrated`.
- **Errors.** Always JSON (`{ "error": "...", "detail": "..." }`): `400` invalid
  body, `403` blocked namespace or foreign origin, `405` wrong method (with
  `Allow`), `413` body over 64 KB, `415` body that is not JSON, `429` rate
  limited (with `Retry-After`), `502` data provider failed, `503` rate limiter
  or assets binding unavailable, `500` anything unexpected (details go to the
  log, not to the caller).
- **Rate limits.** `AURUM_SIGNAL_LIMITER` (8 requests a minute per IP) and
  `AURUM_MARKET_LIMITER` (60 a minute per IP). If a binding is missing the
  route fails closed with `503`.
- **Headers.** Static files get their security headers from `public/_headers`
  (the build copies it to `dist/_headers`); the Worker adds its own to every
  API response. `X-Robots-Tag: noindex, nofollow` keeps staging out of search
  engines — remove that line from `public/_headers` if this ever becomes a
  public site.
- **Logs.** Worker logs are kept in Cloudflare (`observability.logs`) without
  per-request invocation logs. The Worker writes an event name, the method,
  the path and a short error description (name, message, top of the stack).
  It does not log request bodies or headers.
- **Nothing else.** No `vars`, no secrets, no KV/D1/R2, no custom domain, no routes.

### Keep in mind

- **Staging only — do not attach a custom domain.** In the browser the
  read-only lock is immediate on `*.workers.dev` and `*.pages.dev` hostnames.
  On any other hostname it depends on one `/api/health` request succeeding.
- `preview_urls` is on, so every uploaded version also gets its own public
  preview URL.
- `railway.json` builds this repository with Nixpacks, which chooses its Node
  version from `engines.node` in `package.json`, `.nvmrc` or `.node-version`.
  The repository deliberately has none of these, so adding one also changes
  the Node version of a Railway deployment.

## Continuous integration

`.github/ci.yml` is the GitHub Actions workflow for this repository. It runs
on pull requests and on pushes to `main`, and it only verifies — it never
deploys and needs no secrets:

- Node 22 and 24: `npm ci`, `npm audit` (reported as a warning), then
  `npm run verify` (build → smoke and unit tests → the Worker inside workerd →
  `wrangler deploy --dry-run`).
- Python 3.11 and 3.13: a syntax check and the PC bridge unit tests
  (`python -m unittest discover -s tests -p "test_*.py"`). They use only the
  standard library; no conda environment is involved.

GitHub runs a workflow only from `.github/workflows/`. If the file is still at
`.github/ci.yml`, open it on github.com, choose **Edit**, change the file name
to `workflows/ci.yml` (so the path becomes `.github/workflows/ci.yml`) and
commit.

## Environment variables and secrets

| Runtime | What it reads |
|---|---|
| **Cloudflare Worker** | No environment variables and no secrets. Only its bindings from `wrangler.jsonc`: `ASSETS`, `AURUM_SIGNAL_LIMITER`, `AURUM_MARKET_LIMITER`. Do not add broker tokens or AI keys as Worker secrets — nothing reads them |
| **Deploying to Cloudflare** | `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`) in your shell or CI settings only, or `npx wrangler login`. Never in the repository |
| **Express API** (`npm run api`, local or a Node host) | The names in `.env.example`. Also read by the server but not listed there: `HOST`, `WEBSITE_PORT`, `CORS_ORIGIN`, `CLAUDE_MAX_TOKENS`, `CLAUDE_TIMEOUT_MS`, `AURUM_SETUPS_ENABLED`, `AURUM_KILL_SWITCH`, `AURUM_DIAG_KEY`, `DERIV_CONNECT_RATE_PER_MIN`, `DERIV_ALLOW_BROWSER_EXEC`, `DERIV_PUBLIC_URL_OVERRIDE`, `PAT_DEBUG`, `WA_PHONE_NUMBER_ID`, `WA_TOKEN`, `WA_TO`, `WA_AUTO_SHARE` |
| **Browser** | Nothing at build time. `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` appear in `.env.example` but no code reads them; the Supabase project URL and publishable key are typed into the app's Settings |
| **PC bridge** (`bridge/`) | `AURUM_BRIDGE_HOST`, `AURUM_BRIDGE_TOKEN`, `AURUM_BRIDGE_ALLOWED_ORIGINS`, `AURUM_LOCAL_API_AUTH`, `AURUM_LOCAL_API_TOKEN`, `AURUM_MT5_PATH`, `AURUM_UPSTREAM` — see `bridge/README.md` |

`.env`, `.env.*` (except `.env.example`), `.dev.vars`, `.wrangler/` and
`bridge_token.txt` are ignored by Git. Keep real values out of the repository.

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
cloudflare/worker.js  Cloudflare Worker: read-only signal API + app page for /app and deep links
cloudflare/platform.js  Worker HTTP helpers (body limits, error type, bounded cache, logging)
wrangler.jsonc        Cloudflare configuration (routing, rate limits, logs)
public/_headers       security headers for the static files on Cloudflare
src/resilience.js     offline/online notices, service-worker registration, key-header stripping
scripts/              build check (verify-dist), post-build copy, test runner, test network guard
tests/platform/       Worker HTTP, app shell, config, build-check and tooling tests
tests/worker-runtime/ the Worker under the real Cloudflare runtime (npm run test:worker)
src/patterns.js       pattern UI: /api/patterns client + SVG candle chart + playbook + perf bars
```

The setup / keys walkthrough this README used to point to (`../SETUP_GUIDE.md`) is not part of this repository.
