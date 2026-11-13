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
| Signals and analysis | Deriv markets: the visitor's browser, from Deriv public candles (`analysed in this browser`). Index CFDs: the Worker, from Yahoo daily data (`AURUM cloud analysis`). See [Signals on the cloud viewer](#signals-on-the-cloud-viewer) | Exness/MT5 data first; public sources only as a labelled fallback |
| Orders, accounts, Exness/MT5 | not available: hidden or blocked in the page and refused by the Worker (`403`) | available |
| Top bar | `Cloud · view only` | `proxy · …` (state of the local Deriv proxy) |
| Settings → About → Mode | `Cloud viewer · read-only` | `Full workspace` |

Both places show real data only. The feed is reported as live only after a
valid tick has arrived: the cloud viewer then shows
`Deriv public feed · receiving ticks` and the PC app `Deriv live feed`. Until
the first tick the label stays at `Deriv feed · connecting…`; after 30 seconds
without a tick it changes to `Deriv feed · no recent ticks (stale)`; and when
the browser cannot open the feed at all it says `Deriv feed · unavailable`
(hover the label for the browser's reason). A market that has not received a
price shows `—`; nothing is estimated.

The cloud viewer cannot reach the PC, the MT5 bridge or any broker account, and
it is not meant to. Use it to watch prices and signals away from the desk and
the PC app to act on them.

**The PC copy is refreshed by hand.** The page the PC app serves is
`bridge/app.html` (with its icons in `bridge/pwa/`): a copy of the built page
(`dist/index.html`) that is replaced when the PC package is updated.
`npm run build` does not touch it. The copy committed here is still the build
that was uploaded with the PC package (commit `243eb80`), so it is older than
`dist/`: it does not include changes made since then (for example the
feed-status labels and the Settings → About rows described above), and it
still carries the previous name, logo and icons. Refreshing it changes what
runs on the trading PC, so it is a separate, deliberate step.

### Signals on the cloud viewer

**Who computes a reading.** On the cloud viewer the 20 Deriv-backed markets
(forex, gold and silver, crypto, synthetic indices) are analysed in the
visitor's browser. `src/derivhistory.js` reads the candles from Deriv's public
feed and `src/hostedscan.js` runs them through the same analysis code the
Worker and the PC server use, so a market reads the same wherever it is
computed. The Worker reads the six index CFDs (Yahoo daily data cannot be read
from a browser) and is the labelled fallback for a browser that cannot reach
Deriv. On the sign-in screen the Worker is the only source: the browser opens
no connection to Deriv before the visitor enters the workspace. The PC app does
not use any of this.

**Why the Worker is not used for this.** The Worker opens a new outbound
connection to Deriv for every candle series, three per market, and Deriv often
refuses them. Whenever it did, every Deriv market showed
`No data · source: unavailable` while the markets were open.

What is known about the refusals:

- Deriv limits requests: 220 a minute and 14,400 an hour for these calls
  ([Limits](https://developers.deriv.com/docs/limits/)).
- Deriv's API is served through Cloudflare, and Cloudflare presents every
  Worker that calls another Cloudflare-hosted service under one shared address
  ([Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/),
  "CF-Connecting-IP in Worker subrequests").
- On 11 Nov 2026 the live Worker was refused with
  `You have reached the rate limit for active_symbols.` on the first request
  of a new connection. The limit is therefore not counted per connection.

The most likely explanation is that this Worker shares one request budget with
every other Cloudflare Worker that calls Deriv. Deriv does not document what
its limit is counted against, so this is an inference, not a confirmed fact.
A visitor's browser connects to Deriv under the visitor's own address, as the
live price stream already does.

**How the browser asks Deriv.** One connection for candle history, reused for
every request and separate from the price stream; answers matched to requests
by `req_id`; six requests in flight; no more than 180 requests a minute. A
series is reused for 20 seconds (1-minute candles), 60 seconds (5-minute) or
5 minutes (1-hour). A failure is never kept or reused.

Deriv's published limit for these calls is 220 a minute and 14,400 an hour
([Limits](https://developers.deriv.com/docs/limits/)). A Markets table left
open sends 60 requests for its first scan and about 30 a minute after that
(1,800 an hour). If Deriv rejects a request for sending too fast, candle
requests pause for 30 seconds, doubling up to 5 minutes, and the Worker is
asked meanwhile. If Deriv counts its limit per network address, as the
refusals above suggest, several tabs or visitors behind one address share it.

**Every reading has one state**, shown in the Markets table and counted in the
line above it (`Signal column: 20 live · 6 daily index readings · …`):

| State | Shown as | Meaning |
|---|---|---|
| live | the signal, with `source: Deriv public candles · analysed in this browser` (or `· AURUM cloud analysis`) | the newest 1-minute candle started no more than 5 minutes ago |
| daily | the signal, with `source: Yahoo Finance public daily data · AURUM cloud analysis` | end-of-day reading of an index CFD |
| stale | `Stale data`, `source: Deriv public candles · last candle 2 h ago` | candles exist but are old: the market is closed or the feed is paused. No signal and no levels are shown, and there is no Retry because a retry cannot make a closed market current |
| no data | `No data` + Retry, `source: Deriv public candles · no usable history` | Deriv answered but has no usable candles for the market |
| unavailable | `Feed unavailable` + Retry, `source: Deriv public feed unreachable` | neither the browser nor the Worker could get the data. Hover the badge for both reasons |

Only live and daily readings carry a signal, an entry, a stop or a target.
Nothing is estimated, filled in or carried over from an earlier reading.

Freshness is judged on Deriv's clock: the time of the newest tick when the
price stream is running, otherwise the device clock, and never earlier than the
newest candle of the same scan. A device clock that is minutes off therefore
does not turn live markets stale or closed markets live.

After a scan in which the browser could not reach Deriv for any market, the
scans of the next minute go straight to the Worker instead of waiting for the
same failure again; **Retry** and the Signals **Refresh** button try the
browser again at once. Readings from the Worker are reused for 20 seconds
(index readings for a minute), so the scans a page makes when it opens fit
inside the Worker's rate limit of 8 scan requests a minute.

**The best-market panel** ("Today's best market to forecast on", on the sign-in
screen and on the Overview) has two lines, because two kinds of reading reach
it and their scores are not on one scale:

| Line | What it shows | Scale |
|---|---|---|
| The pick | the strongest BUY or SELL among the **live** readings of six major forex pairs (EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CHF, USD/CAD), with the time it was read | 1m/5m/1h reading: 15 + 7 per timeframe + up to 25 for bias + 20 when confirmed; at most 81 with three timeframes |
| Daily index trend | the strongest BUY or SELL among the **daily** readings of NAS100, US30 and SPX500, with the day its newest bar belongs to | five checks on daily closes: 50 + 8 per net check, so a BUY or SELL is always 74, 82 or 90 |

Until 2026-11 both kinds were ranked together. A daily reading of 82 or 90
beat every live market, and it only changes when a daily bar does, so the
panel named the same index from morning to night and through the weekend. A
daily reading no longer competes for the pick.

The daily line says which day it speaks for, instead of the time the page last
asked:

- `Daily index trend · daily close of Wed 11 Nov`: that day's session had
  ended when the data was read. Nothing changes until the next session opens.
- `Daily index trend · Thu 12 Nov, session open — not final`: today's bar was
  still forming, so the reading can still change.
- `Daily index trend · daily bar of Wed 11 Nov`: Yahoo's answer did not say
  which of the two it is.
- `Daily index trend`, without a day: the reading carries no bar time. That is
  the PC app, whose local API does not send one.

The day is the UTC date of the bar; the sessions read here do not cross
midnight UTC, so it is the trading day wherever the page is opened. When there
is nothing to name, each line says what was read and what was not
(`No live market could be read right now: 6 stale (market closed or feed paused). …`,
`Daily index trend: not read right now (3 unavailable). Nothing is estimated.`).
In the PC app an index that Exness MT5 delivers live is a live market and
competes for the pick like the others.

The panel is read when the page opens, every 10 minutes after that, and once
more when the visitor enters the workspace. (It used to be read every 20
minutes: the 10-minute timer was combined with a check for "10 minutes since
the last result", which every second tick missed by the few seconds a read
takes.) A repeated read keeps the previous lines on screen until its own
result replaces them.

For this the Worker's index readings (`/api/signals/scan` and
`/api/signals/analyze`) carry two fields more:

| Field | Meaning |
|---|---|
| `daily_bar_time` | epoch second of the newest daily bar the reading was computed from; `0` when the bar has no usable time |
| `daily_bar_final` | `true`: the bar's session had ended when the series was read. `false`: it was still forming. `null`: Yahoo's answer does not allow either statement |

Both describe the daily series as it was read from Yahoo. The Worker keeps a
series for 15 minutes, so a reading taken just before the close says "not
final" until the series is read again. `ts` remains the moment of the answer.

**Finding out why a market has no reading.**

- In the page: hover the badge. The reason is the text Deriv, the browser or
  the Worker gave.
- In the browser console: `__aurumDiagnostics()` returns the counts of the
  last scan, its problems (market, state, reason) and the counters of the
  candle connection (requests sent, answered, failed by kind, whether it is
  paused). When the set of affected markets changes, the page also writes one
  line starting with `[aurum] {"event":"hosted_scan_trouble"`. A closed
  market is not reported as trouble.
- In the Worker's logs (Cloudflare dashboard → the Worker → Logs): one
  `provider_feed_failed` line per request in which Deriv or Yahoo could not be
  read, with the route, how many markets failed, the markets, how each failed
  (`deriv:connect`, `deriv:closed`, `deriv:timeout`, `deriv:provider`,
  `yahoo:error`), how long it took and, where there is one, the WebSocket
  close code or Deriv's error code.

None of these carries a token, a saved key, a header, an address or anything
about the visitor: market names, counts, durations and error text only.

**Still read through the Worker**, and therefore still failing whenever Deriv
refuses the Worker:

- The pick of the best-market panel on the sign-in screen. When no live market
  can be read it says so, and says who reads them next
  (`No live market could be read right now: 6 unavailable. … Inside the workspace this browser reads the live markets itself.`)
  instead of "no setup"; the pick is read again in the browser once the
  visitor is inside. The last sentence is left out for markets that are closed,
  because entering does not open them. The panel's daily index line does not
  depend on Deriv.
- The full Deriv catalogue under "Broker-discovered markets" and the analysis
  of a market picked from it. They say so
  (`Deriv catalogue unavailable: You have reached the rate limit for active_symbols.`)
  and the failure appears in the Worker's log.
- The Gold monitor's first attempt. It reads the candles in the browser itself
  when the Worker fails, as it did before.

### The confidence score, and how it moves with the price

Every reading carries a score ("Confidence"). It is computed once, when the
analysis runs, from how the three timeframes vote: 15 + 7 per timeframe + up
to 25 for the strength of the votes + 20 when two of three agree, at most 93
(a WAIT at most 45). The daily index readings use 50 + 8 per net daily check.
The formula is fixed and is shown in the app under **AI Signals → How the
confidence score is computed**.

**It is a score, not a chance of profit.** See the replay result below before
reading anything into it.

Since 2026-11 the score shown for a BUY or SELL then **moves with the market**
(`src/signalrun.js`):

- A reading is followed from the price it was **first read** at. While later
  analyses repeat the same direction, the entry, stop and target 1 of that
  first reading stay the reference; the newest analysis supplies the score.
- Up to **30 points come off** as the live price moves from that entry toward
  the stop; up to **15 are added** as it moves toward target 1. Both are in
  proportion to the distance covered. (A move in the signal's direction has
  used up part of the target distance, so the score rises half as fast as it
  falls.) The result stays between 5 and 93.
- The sentence beside the score says how far the price has moved and in which
  direction, how much of the way to the stop or the target that is, and where
  and when the reading started:
  `6.0 pips with this BUY · 33% of the way to target 1 · first read at 1.08500, 14:05:09 · score as read 70%`.
- At the **stop** or at **target 1** the reading is over
  (`Stop level reached at 14:12:40 · this BUY reading (…) is over`). A price
  that comes back does not revive it. The next analysis that still says BUY or
  SELL starts a new reading at its own entry.
- Distances are given in **pips** for currency pairs (0.0001, or 0.01 where
  the yen is quoted), in **dollars** for gold, silver and crypto, and in
  **points** for everything else. Gold is in dollars on purpose: brokers do
  not agree on what one pip of gold is.

| Where | What is shown |
|---|---|
| AI Signals → Market scanner cards | live score, bar, the full sentence under the bar, then what the replay measured for that market |
| Markets table, Overview signal list | live score in the badge |
| Sniper alerts: Selected markets, Live Sniper setups | a **Confidence** column: live score and `6.0 pips with` / `6.0 pips against` / `stop reached` / `target 1 reached`; then `measured 39.6%` or `not measured`; the detail line (eye icon) has the full sentences |
| Gold / US Dollar monitor | **Confidence** under the signal: live score, bar and the full sentence; followed from the gold price the monitor itself shows (Exness MT5 in the PC app, otherwise the public Deriv tick); under it what the replay measured on gold |

What does **not** move: a WAIT (nothing to follow); the daily index readings
(US30, NAS100, SPX500 have no entry, stop or target, so their score changes
only when a daily vote does, and the card says so); the best-market panel
(a snapshot with its read time); the "Analyze a symbol" card; notifications
and WhatsApp texts, which quote the score as read; and the Sniper filter
("confidence ≥ 70%"), which compares the score as read.

The scores update on every price tick, without a new scan. Readings are
followed in the page's memory only: after a reload a reading is followed from
the first analysis the page makes.

**One venue's levels are never measured with another venue's price.** The
prices streaming into the page come from Deriv. In the PC app with Exness
connected, a scanner reading made from Exness candles has Exness levels, so
it is measured against the Exness price that came with its latest analysis
and the sentence ends with `measured at the Exness price of 14:07:12, updated
at each analysis`. Such a score moves at each analysis, not at each tick. If
Exness then fails and the market is read from the fallback, that is a new
reading with its own levels. The Gold monitor asks the terminal for the
Exness gold price every ten seconds while its view is open; a tick older
than two minutes is not treated as a live price.

**A card is one reading.** The scanner cards stay as they were read until
Refresh, while other views read the same markets again. When the newest
analysis of a market is a different reading, the card shows its own score as
read and `This BUY reading is no longer the newest for this market: refresh
to see the latest.` A stop or target is noticed on every tick, whether or
not that market is on screen at the time.

**One reading per finished 5-minute candle** (`src/closedcandles.js`, since
2026-11-13). Until then a 1m/5m/1h reading was made from whatever candles the
feed held at the moment of the look, the three forming ones included, and a
market looked at every minute could change its mind every minute. A reading is
now made from **finished candles only, as they stood at the last 5-minute
close**:

- Looking again before the next 5-minute close gives the same reading, so a
  market can change (and alert) at most once per 5-minute candle. On gold the
  replay below counts about 46 alerts a weekday instead of about 100.
- The close is taken from the candles themselves, not from the device clock,
  and a candle counts as finished only when its own series shows a later one.
  A copy of a series from just before a close is never read as if the candle
  had closed; the reading then stays the one of the close before until the
  copy is renewed (`src/derivhistory.js` renews it at once after a close).
- After a pause (the weekend, the daily break of gold, a quiet market) the
  first new price makes the feed current again while every finished candle is
  still from before the pause. No reading is shown then, and no alert is sent:
  the market says `resumed, waiting for a finished candle` until a 5-minute
  candle of the new session has closed. A reading belongs to a 5-minute candle
  that traded, and is current while its close is less than two candles behind
  the feed.
- Each card says which close it was read at (`read at the 14:35 candle
  close`). The Gold monitor still checks every minute, and looks again a few
  seconds after each 5-minute close.
- This holds wherever the page or the Worker makes the reading: Deriv markets
  on the cloud, the Exness paths of the PC app, the Gold monitor on both. **Not
  changed:** readings made by the PC's own Node server (`server/app.js`), which
  still looks every minute with forming candles; they name no close.
- It is not a better signal. The votes, thresholds and levels in `server/lib`
  are untouched; only the moment they are read at changed.

**What a replay of the rule measured, shown beside every signal**
(`src/measured.js`, `scripts/replay-rule.mjs`). The rule was replayed on
historical 1-minute prices with the repository's own code. An alert is a
reading that says BUY or SELL when the reading before it said something else;
each alert was followed until its stop or its target 1 (the stop is counted
when both lie inside one 1-minute bar). With a stop of 1.5 × ATR and a target
1 of 2.25 × ATR, **40%** of alerts must reach target 1 first to break even,
before the spread.

| Market | Period | Alerts | Per weekday | Target 1 first | Alerts, look every minute | Per weekday | Target 1 first |
|---|---|---|---|---|---|---|---|
| Gold (XAU/USD) | Jan 2020 – Nov 2026 | 82,069 | 46 | **39.6%** | 177,715 | 100 | 39.8% |
| EUR/USD | Mar – Sep 2026 | 6,453 | 49 | **40.2%** | 13,990 | 106 | 39.9% |
| GBP/USD | Mar – Sep 2026 | 6,444 | 49 | **36.9%** | 13,876 | 105 | 36.8% |
| AUD/USD | Mar – Sep 2026 | 6,560 | 50 | **39.3%** | 13,968 | 106 | 39.4% |
| USD/JPY | Mar – Sep 2026 | 6,272 | 48 | **40.5%** | 13,703 | 104 | 40.1% |
| USD/CHF | Mar – Sep 2026 | 6,273 | 48 | **38.6%** | 13,523 | 102 | 38.7% |
| USD/CAD | Mar – Sep 2026 | 6,364 | 48 | **40.9%** | 13,887 | 105 | 41.2% |
| US30 | Mar – Sep 2026 | 6,087 | 46 | **39.7%** | 13,055 | 99 | 39.9% |
| NAS100 | Mar – Sep 2026 | 5,827 | 44 | **40.7%** | 12,536 | 95 | 41.4% |
| SPX500 | Mar – Sep 2026 | 5,952 | 45 | **40.7%** | 12,923 | 98 | 40.3% |

The first three figure columns are the rule as it runs now (one reading per
5-minute close), the last three the rule as it ran before. Gold over the whole
period, as it runs now:

| Gold, Jan 2020 – 11 Nov 2026, one reading per 5-minute close | Alerts | Target 1 first |
|---|---|---|
| Each single year 2020 … 2026 | 10,236 – 12,119 | 38.6 / 39.8 / 39.5 / 39.1 / 40.4 / 39.9 / 39.9% |
| Score below 60 / 60–64 / 65–69 / 70–74 / 75–79 / 80 and above | 6,087 / 27,178 / 23,012 / 20,429 / 5,067 / 296 | 39.4 / 39.9 / 39.2 / 39.7 / 39.4 / 40.2% |
| All three timeframes agree | 7,831 | 39.4% |
| The 1-hour vote agrees / is neutral / is against | 34,851 / 21,997 / 25,221 | 40.0 / 39.0 / 39.5% |
| BUY / SELL | 41,964 / 40,105 | 39.8 / 39.4% |
| Control: the opposite direction at the same moments, same distances | 82,069 | 40.6% |
| Control: a coin flip at the same moments, same distances | 82,069 | 39.8% |

In words: on this data the rule's direction was right as often as a coin's,
its score did not separate better alerts from worse ones, and stricter
versions of the same votes did not change that. The six-month figures of the
other markets lie between 37% and 41%; with about 6,000 alerts each they are
known to about ±1.2 points at best, so none of them is evidence of an edge.
(The coin flip itself moves by that much from one run to the next: on GBP/USD
it reached 38.4% in one run and 39.8% in another.) One reading per 5-minute
candle halves the number of alerts and leaves the share where it was: per gold
alert at 0.01 lot the replay gives −$0.02 before the spread and −$0.27 after an
assumed $0.25, about −$22,000 over the period against −$43,700 with a look
every minute. Fewer alerts cost less; they do not win more often. The live
movement of the score does not change this either: it reports where the price
is against a reading, it does not predict where it goes next.

What the page shows (`measuredText` in `src/measured.js`): under a BUY or SELL
of the 1m/5m/1h rule, the figure of that market and of the timing that made
the reading, for example `Measured in a replay on gold (Jan 2020 – Nov 2026):
39.6% of 82,069 signals of this rule reached target 1 before the stop; 40% is
needed to break even, before the spread. Not a forecast.` A market that was
not replayed says so and gives the range of the ten that were. A WAIT has no
such line. A daily index reading (US30, NAS100, SPX500 on the cloud) has no
stop or target, so it has no measured result, and its card says why its three
boxes are empty. Alerts and shared messages end with the same figure in one
line. The numbers are fixed in `src/measured.js`; they do not update by
themselves, and `tests/platform/measured.test.mjs` keeps this table, the page
and the module equal.

To repeat a run (the price data is not in this repository):

```
node scripts/replay-rule.mjs --data <folder of 1-minute CSV files> --symbol XAU/USD \
     --from 2020-01-01 --to 2027-01-01 --by-year --spread 0.25 [--timing minute]
```

Data used: gold, the public archive
`parshant65-lang/Gold-XAUUSD-1m-2020-2025-Historical-Data` on GitHub at commit
`b2cfdc5` (2 January 2020 to 11 November 2026 13:11 UTC); the other nine
markets, the free six-month 1-minute samples published on GitHub by
getdata.finance (26 March to 25 September 2026). Neither is Exness's or
Deriv's price series. As a check of one source against the other, gold over
the same six months gives 39.8% of 6,045 alerts in the first and 39.7% of
6,002 in the second.

Limits of the replay: one price series per market that is not the broker's;
the alert is taken at the price of the 5-minute close it belongs to, while a
person sees it some seconds later; no spread, slippage or overnight cost
unless stated; when a stop and a target fall inside the same minute the stop
is counted. The earlier version of this section gave 39.3% for EUR/USD and
36.7% for GBP/USD with a look every minute: those came from a first replay
program that was not kept; the figures above are from the script in this
repository, which gives 39.9% and 36.8% for the same data and timing.

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

### When a merge does not reach the live site

The staging Worker is published by that Git integration: a merge into `main`
starts a build, and a successful build becomes the active deployment. The
builds so far took 22 to 45 seconds.

**What is live.** Cloudflare dashboard → Workers & Pages → `cloudflare-staging`
→ **Deployments**. "Active deployment" is the version that serves the site.
Its row in the list below carries the commit message of the merge it was built
from.

**The merge is not in that list.** The list shows successful builds only.

1. On the same page select **View Build History** at the bottom. Failed and
   cancelled builds are listed there, each with its log.
2. Use **Retry build** on the build of that merge. In GitHub the same action
   is **Re-run** on the commit's check: commit page → the mark next to the
   author → Details.
3. A retry rebuilds the commit of *that* build. Retrying the build of an older
   merge publishes the older code again; it does not pick up later merges.
4. If no build exists for the merge at all, the next commit on `main` starts
   one, and it publishes everything merged up to then.

**Pull requests get a separate preview build.** It runs Cloudflare's Preview
command (`npx wrangler preview` by default, an open-beta Wrangler command)
instead of the deploy command. The preview builds of pull requests #3 and #4
failed. The cause is in Cloudflare's build log and has not been established.
A red preview mark on a pull request is not the result of the production
publish: #3 was published after its preview had failed.

### Bringing in a package made outside this repository

A package (ZIP) prepared elsewhere is a copy of the project from the day it was
made. Only the files changed there are new; every other file in it is an older
copy. Uploading the whole package to `main` ("Add files via upload") replaces
the newer files of the repository with those older copies, and the upload is
published like any other commit on `main`.

This happened on 12 November 2026 with the package described in
`CLOUDFLARE_STAGING_GITHUB_HANDOFF.md`. It had been made from the copy of
10 November, and its upload put back the page, icons, price feed,
`package.json` and `wrangler.jsonc` of that day. The live site followed within
minutes. Afterwards the files the package had really changed were kept, the one
file changed on both sides (`src/main.js`) was merged, and the rest was
restored.

To bring such a package in:

1. Find what the package changed by comparing it with the commit it was made
   from, not with `main`. A file that is identical to that older commit was not
   changed by the package.
2. Put only the changed files on a branch. Merge a file that both sides changed
   (`git merge-file <current> <older commit's copy> <package's copy>`); do not
   replace it.
3. Run `npm run build` and `npm test`, commit the rebuilt `dist/`, and open a
   pull request.

**Open item.** The package of 12 November also changed files in `bridge/`:
a new `START_MT5_IF_CLOSED.ps1`, and `SETUP_AND_RUN.bat`, `AUTO_START.bat` and
`mt5_bridge.py`. That folder was not uploaded. The launcher texts and
`tests/localHosting.test.mjs` already describe it, so two tests in that file
are reported as `# TODO` until `bridge/START_MT5_IF_CLOSED.ps1` is in the
repository, and count as failures again from then on. Until then
`START_ALL_LOCAL.bat` from this repository runs the bridge scripts of
10 November. They do not contain the steps its banner now names (starting MT5
when it is closed, opening the app in Chrome), and that bridge has no
`/local-config` route, so the page does not receive the bridge token. Nothing
in `bridge/` has changed here since 10 November, so uploading that one folder
from the package replaces nothing newer.

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
  When Deriv or Yahoo cannot be read it writes one `provider_feed_failed`
  line (see [Signals on the cloud viewer](#signals-on-the-cloud-viewer)).
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

## Brand and WhatsApp sharing

Every device starts with the Shelricktech brand: the name `Shelricktech`, the
tagline `INVESTMENT` and the ST logo in the sidebar and on the login screen,
and the same logo as the browser-tab and home-screen icon.

| What | Where it is set |
|---|---|
| Name, tagline and logo inside the page | `BRAND_DEFAULT` in `src/main.js`; the text shown before the script runs is in `index.html` (`<title>`, `#brandName`, `#brandTag`) |
| Browser-tab and home-screen icons | `public/icons/`, listed in `public/manifest.webmanifest` |
| WhatsApp number the share buttons open | `WA_DEFAULT` in `src/main.js` |

A device can replace any of these for itself in **Settings** (Brand & logo,
WhatsApp signal number). That choice is stored in that browser only.

The four share buttons (a news signal, today's brief, the Gold signal, an AI
brief) open `https://wa.me/<number>` with the message filled in. Nothing is
sent until the person presses Send in WhatsApp. `WA_DEFAULT` is part of the
public page, so anyone who opens the site can read it. Today's brief is shared
only when the calendar actually loaded; a failed calendar is reported, not
shared as "no events".

Automatic sending (no tap) is separate: it goes through the server's WhatsApp
Cloud API and is addressed by the `WA_TO` server variable (see
`server/lib/wa.js`), not by `WA_DEFAULT`. The Cloudflare Worker has no
WhatsApp, news or calendar route, so on the Cloudflare site only the Gold
signal button has anything to share, and only while live Gold prices are
arriving in the browser.

To change the logo, replace `branding/shelricktech-logo.jpg` (square, white
background, 512 px or larger) and run:

```bash
python -m pip install pillow          # once; only this script needs it
python scripts/make-brand-assets.py   # icons + the logo built into src/main.js
npm run build                         # then commit the changed files, including dist/
```

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
src/derivhistory.js   cloud viewer: Deriv public candle history over one paced connection
src/hostedscan.js     cloud viewer: signal scan in the browser, with one state per reading
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
scripts/              build check (verify-dist), post-build copy, test runner, test network guard,
                      brand image generator (make-brand-assets.py, needs Pillow, not part of the build)
branding/             source artwork for the logo and the icons
tests/platform/       Worker HTTP, app shell, config, build-check and tooling tests
tests/worker-runtime/ the Worker under the real Cloudflare runtime (npm run test:worker)
src/patterns.js       pattern UI: /api/patterns client + SVG candle chart + playbook + perf bars
```

The setup / keys walkthrough this README used to point to (`../SETUP_GUIDE.md`) is not part of this repository.
