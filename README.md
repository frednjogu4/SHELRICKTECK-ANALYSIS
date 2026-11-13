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
| `npm run build` | Single-file HTML (vite-plugin-singlefile), copy to `dist/AURUM_Workspace.html`, check that `dist/` is complete, then copy the built page and its icons into `bridge/` for the PC app (see [Bringing the PC app up to date](#bringing-the-pc-app-up-to-date)) |
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

**The PC app serves the same build.** The page the PC app serves is
`bridge/app.html`, with its icons, manifest and service worker in
`bridge/pwa/`. They are copies of the built page (`dist/index.html`) and of its
static files. `npm run build` ends by making those copies
(`scripts/pc-page.mjs`), and `tests/platform/pc-page.test.mjs` fails when one
of them differs from `dist/`, so in this repository the PC page cannot fall
behind the website. Until 13 November 2026 nothing refreshed them: the PC app
showed the build its package had been uploaded with, a week of work behind the
website and with another logo.

**Without Exness, the PC app reads a market the way the website does.** While
Exness is not connected, the page asks the PC's own server (`server/app.js`)
for its readings. Since 13 November 2026 that server makes one reading per
finished 5-minute candle, like the Worker and the browser
(`server/lib/closedcandles.js`); before, it read whatever candles the feed held,
the three forming ones included, so the PC and the website showed different
scores and levels for the same market at the same minute.
`tests/platform/pc-server-reading.test.mjs` gives the three places the same
candles and compares their answers.

What stays different on purpose is what the table above lists: Exness, accounts
and the AI engines exist on the PC only, where a public source is labelled as a
fallback; the website is view-only. A reading is also only as new as the last
look: a signal card is read when the workspace is entered and when Refresh is
pressed, in both places, so two screens agree when both were read at the same
5-minute close. Each card and the Gold page name that close.

### Bringing the PC app up to date

A merge changes the website within minutes. It does not change the trading PC:
the PC runs the files in its own package folder (the folder that holds
`START_ALL_LOCAL.bat`), and those change only when someone replaces them.

1. On GitHub, open the repository, press **Code**, then **Download ZIP**, and
   extract the ZIP.
2. Open the extracted folder (it carries the repository's name followed by
   `-main`; the one to open is the folder that holds `START_ALL_LOCAL.bat`),
   select everything in it, copy, and paste into the package folder on the PC.
   Choose **Replace the files in the destination**. What exists only on the PC
   is not in the ZIP and stays as it is: `bridge\bridge_token.txt`,
   `bridge\terminal_path.txt`, `bridge\python_runtime.txt`, `server\data\`,
   `node_modules\` and `logs\`.
3. Close the minimised window **Fredrick AURUM Local API**, or restart the PC.
   `START_LOCAL_API.bat` leaves a server that is already running alone, so
   without this step the new page would talk to the old server.
4. Run `START_ALL_LOCAL.bat`.
5. In the browser tab of the app press Ctrl+F5. The icon follows at the second
   load: the service worker shows the stored one first and renews it behind.

Copy the whole folder, not single files: the page (`bridge\app.html`), the
bridge (`bridge\mt5_bridge.py`) and the server (`server\`) belong together.
The server folder is complete on its own (nothing under `server/` imports a
file from outside it, `tests/platform/pc-package.test.mjs`), and it needs the
three packages `npm ci --omit=dev` installs, which have not changed.

How to tell it worked: the Gold page says `Reading of the 14:35 candle close`
under the signal, as the website does, and the signal cards end with
`read at the 14:35 candle close`. When the page is new and the server is still
the old one, the Gold page says so itself: `this reading can change every
minute: it comes from an older version of the AURUM server` (step 3 was left
out, or the `server` folder was not replaced).

The other direction is described under
[Bringing in a package made outside this repository](#bringing-in-a-package-made-outside-this-repository):
do not upload the PC's package folder to `main` to "sync" the two.

### When Connect cannot attach to MetaTrader 5

On the PC, **Connect Exness (read-only)** needs the bridge
(`bridge/mt5_bridge.py`) to attach to the MetaTrader 5 desktop program before
it can check an account. When the attach fails, the form shows the bridge's
message:

```text
Cannot attach to MetaTrader 5: <what is wrong> (step terminal, code <n>: <MetaTrader's own text>). <what to do> Terminal tried: "<folder>\<file>".
```

The message distinguishes: the saved location is gone, the program found is
MetaTrader 4, MetaTrader 5 is not logged in (code -6), no MetaTrader 5 was
found, it could not be started, it has no connection for Python, it did not
answer in time (code -10005), and a version mismatch. The same text is printed
in the bridge window when the bridge starts without MetaTrader 5.

- **`(step terminal, code 1: Success)` is the old fault.** Until 13 November
  2026 the bridge read MetaTrader's error after `mt5.shutdown()`, which sets it
  back to `(1, 'Success')`, so every failed attach read the same. A PC shows
  that text for as long as its own `bridge\mt5_bridge.py` is the older file:
  replace the file and restart the bridge window.
- **Wording.** The sign-in form replaces a bridge message that contains
  `unreachable`, `timeout`, `refused`, `closed` or `blocked` with its own
  "Bridge not reachable" help. The bridge rewords these five words, or
  MetaTrader's `IPC timeout` would hide the message.
- **Times.** The app waits 8 seconds for the answer to a login and repeats a
  failed login once over HTTP straight away. An attach asked for by a login is
  therefore limited to 5 seconds, the repeat gets the same answer without a
  second attempt, and a login that arrives during an attach is answered at once
  with "still contacting MetaTrader 5". The attach at bridge start keeps
  MetaTrader's 60 seconds, because a terminal the launcher has just started
  needs them.
- **Tests.** `tests/test_mt5_bridge_attach.py` runs the bridge against a
  stand-in for the Windows-only `MetaTrader5` package, and
  `tests/platform/pc-bridge-attach.test.mjs` checks the three facts about the
  app named above and runs the Python tests where Python 3 is installed
  (`npm test` includes it). The wording for each case follows MetaQuotes' list
  of error codes and users' reports. Nothing has been run on Windows or against
  a real terminal.

### When the PC app refuses every Exness order

Since 13 November 2026 (pull request #16) an Exness order from the PC app
stops at the app's own order check, before anything is sent to MetaTrader,
with:

```text
Blocked: mandatory checks UNKNOWN (missing data never counts as passed): news_event.
```

The check (`/api/risk/gate`, `server/lib/riskgate.js`) asks whether a news
restriction applies. The page answers "none" with every order, as it always
has; it never looked at the calendar for that. The server no longer takes the
page's word, and it has no calendar check of its own yet. So the answer is
"unknown" for every order, and an unknown mandatory check blocks. This is the
same for a manual ticket and for an automated entry, and no setting turns it
off.

What would let an order pass again is the server reading the calendar and the
market hours itself (step 3 of the plan in `docs/ANALYSIS_ENGINE_AUDIT.md`),
with an unreadable calendar still counting as unknown. That is not built, and
pull request #17 (the same day) keeps the refusal on purpose until it is.
Until then the PC app analyses and alerts, and an Exness order is placed in
MetaTrader by hand. `server/tests/risklimits.test.mjs` states the refusal as a
test, and keeps the former reservation test beside it, skipped.

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

**One reading per finished 5-minute candle** (`server/lib/closedcandles.js`,
which the page and the Worker import as `src/closedcandles.js`; since
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
  the feed. The Worker passes such a reading on marked `candle_current: false`
  and the page withholds it. The PC's server withholds it itself, because the PC
  is where an order ticket is filled from a reading: its scan row carries no
  signal and no level, an analysis or a six-role request is answered with HTTP
  409, and no news or AI request is made for it. On the order ticket, levels
  that were filled in from an earlier reading are withdrawn when the market is
  closed, paused or has just resumed; levels the trader typed stay.
- A history without any finished 5-minute candle is not a pause. Such an answer
  names no close (`candle_close: 0`) and is a WAIT that says it has no usable
  candles; it is shown as that, on the website and on the PC
  (`withheldReading` in `src/hostedscan.js` decides for both).
- Each card says which close it was read at (`read at the 14:35 candle
  close`). The Gold monitor still checks every minute, and looks again a few
  seconds after each 5-minute close.
- This holds wherever a reading is made: Deriv markets on the cloud, the
  Exness paths of the PC app, the Gold monitor on both and, since the same day,
  the PC's own Node server (`server/app.js`: scan, analysis and the six-role
  panel). A PC whose `server` folder is older still looks every minute with
  forming candles; its readings name no close, and the Gold page says so (see
  [Bringing the PC app up to date](#bringing-the-pc-app-up-to-date)).
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
| Gold (XAU/USD) | Jan 2020 – Nov 2026 | 76,694 | 43 | **39.6%** | 177,715 | 100 | 39.8% |
| EUR/USD | Mar – Sep 2026 | 6,114 | 46 | **39.9%** | 13,990 | 106 | 39.9% |
| GBP/USD | Mar – Sep 2026 | 5,991 | 45 | **36.9%** | 13,876 | 105 | 36.8% |
| AUD/USD | Mar – Sep 2026 | 6,143 | 47 | **39.4%** | 13,968 | 106 | 39.4% |
| USD/JPY | Mar – Sep 2026 | 5,919 | 45 | **41.1%** | 13,703 | 104 | 40.1% |
| USD/CHF | Mar – Sep 2026 | 5,807 | 44 | **38.9%** | 13,523 | 102 | 38.7% |
| USD/CAD | Mar – Sep 2026 | 5,996 | 45 | **40.4%** | 13,887 | 105 | 41.2% |
| US30 | Mar – Sep 2026 | 5,723 | 43 | **41.2%** | 13,055 | 99 | 39.9% |
| NAS100 | Mar – Sep 2026 | 5,369 | 41 | **41%** | 12,536 | 95 | 41.4% |
| SPX500 | Mar – Sep 2026 | 5,585 | 42 | **39.6%** | 12,923 | 98 | 40.3% |

The first three figure columns are the rule as it runs now: one reading per
5-minute close, RSI and ATR with Wilder's smoothing. The last three are the
rule as it ran until November 2026: a look every minute, with the RSI and ATR
it had then. Gold over the whole period, as it runs now:

| Gold, Jan 2020 – 11 Nov 2026, one reading per 5-minute close | Alerts | Target 1 first |
|---|---|---|
| Each single year 2020 … 2026 | 9,510 – 11,459 | 38.2 / 40.2 / 39.5 / 39.6 / 39.9 / 39.5 / 40.4% |
| Score below 60 / 60–64 / 65–69 / 70–74 / 75–79 / 80 and above | 2,476 / 21,873 / 20,967 / 22,252 / 8,423 / 703 | 39.1 / 39.5 / 39.5 / 39.7 / 39.9 / 37.3% |
| All three timeframes agree | 9,956 | 39.4% |
| The 1-hour vote agrees / is neutral / is against | 31,777 / 21,458 / 23,459 | 39.6 / 39.6 / 39.5% |
| BUY / SELL | 39,101 / 37,593 | 39.7 / 39.5% |
| Control: the opposite direction at the same moments, same distances | 76,694 | 40.8% |
| Control: a coin flip at the same moments, same distances | 76,694 | 40.3% |

In words: on this data the rule's direction was right as often as a coin's,
its score did not separate better alerts from worse ones, and stricter
versions of the same votes did not change that. The six-month figures of the
other markets lie between 37% and 41%; with about 6,000 alerts each they are
known to about ±1.2 points at best, so none of them is evidence of an edge.
(The coin flip itself moves by that much from one run to the next: on GBP/USD
it reached 38.4% in one run and 39.8% in another.) Per gold alert at 0.01 lot
the replay gives −$0.01 before the spread and −$0.26 after an assumed $0.25,
about −$19,800 over the period; with a look every minute it was −$43,700.
Fewer alerts cost less; they do not win more often. The live movement of the
score does not change this either: it reports where the price is against a
reading, it does not predict where it goes next.

Two things about the rule changed in November 2026, and each was replayed on
the same data before and after:

| Change | Before | After |
|---|---|---|
| One reading per finished 5-minute candle instead of a look every minute (gold) | 39.8% of 177,715 | 39.6% of 82,069 |
| RSI and ATR with Wilder's smoothing, as a chart shows them, instead of averages of the last 14 values (gold) | 39.6% of 82,069 | 39.6% of 76,694 |
| The same change of RSI and ATR on the nine other markets | 36.9% to 40.9% | 36.9% to 41.2% |

The first halved the number of alerts. The second (13 November,
`server/lib/indicators.js`) removed about 6% of them, between 5% and 8% on
every market. Neither moved the share that reached target 1. On gold it stayed
at 39.6%. On the nine six-month samples it went up on five, down on three and
stayed on one; the largest moves were +1.5 points (US30) and −1.1 (SPX500),
one up and one down, at the edge of the ±1.2 points that about 6,000 alerts
leave open. So a reading now shows the same
RSI and ATR as TradingView or MT5 would. It is not a better reading for that,
and not a worse one. A PC whose `server` folder dates from the hours between
the two changes still computes the former RSI and ATR; the figure beside its
signals is the new one, and the table says how little that matters.

What the page shows (`measuredText` in `src/measured.js`): under a BUY or SELL
of the 1m/5m/1h rule, the figure of that market and of the timing that made
the reading, for example `Measured in a replay on gold (Jan 2020 – Nov 2026):
39.6% of 76,694 signals of this rule reached target 1 before the stop; 40% is
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
the same six months gives 40.0% of 5,665 alerts in the first and 39.7% of
5,557 in the second.

Limits of the replay: one price series per market that is not the broker's;
the alert is taken at the price of the 5-minute close it belongs to, while a
person sees it some seconds later; no spread, slippage or overnight cost
unless stated; when a stop and a target fall inside the same minute the stop
is counted. The earlier version of this section gave 39.3% for EUR/USD and
36.7% for GBP/USD with a look every minute: those came from a first replay
program that was not kept; the figures above are from the script in this
repository, which gives 39.9% and 36.8% for the same data and timing.

One more fact about the gold archive, found while measuring releases (next
section): its files say their bar times are UTC, but until mid-2025 they are
broker time (Athens: UTC+2, UTC+3 in summer), and from then on UTC. The replay
above is not affected, because the rule never looks at the clock: a shift by
whole hours leaves every 5-minute and 1-hour candle as it is. Anything that
compares these bars with clock times has to convert them first.

### News: which markets, and standing aside around a release

The News view answers three questions and leaves a fourth unanswered on
purpose.

1. **Which markets does a headline concern?** The ones it names
   (`src/newsimpact.js`): a pair written out is that pair; a currency or its
   central bank is every listed market priced in it; a company such as Nvidia
   is the indices it is a large part of (NAS100, US100, SPX500). A headline
   that names nothing this application follows gets no market.
2. **Buy or sell?** Beside each market stands that market's own price reading
   at this moment (Buy, Sell or Wait, the same reading the Markets view
   shows). It is not taken from the headline.
3. **When to stop and when to start again around a release?** For every
   high-impact entry of the calendar: no new trade from 30 minutes before the
   release until 30 minutes after it, in the markets priced in its currency.
   Times are Nairobi time (EAT). The same note appears in the line above the
   chart for the market selected there, and on the Gold page: under the gold
   signal, in its table of dollar releases, and at the start of the alert it
   sends 15 and 5 minutes before a high-impact dollar release. A reading stays
   shown during the period; the note says that no new trade belongs in it.
4. **Which way will the news move the price?** Not answered, because it is not
   known. The calendar source gives the forecast and the previous figure, not
   the result, and the wording of a headline does not decide a price. On the
   cloud no direction is derived from a headline at all. (The PC server still
   attaches its keyword chip, `biasFor` in `server/lib/news.js`: it takes the
   first currency of a fixed list that the title mentions, any "up" or "down"
   word anywhere in the title, and the major pair of that currency. For the
   real headline "Euro Falls as US Dollar gains on inflation concerns, Fed
   rate hike bets" it answers "BUY USD/JPY", a market the headline does not
   mention.)

The cloud reads the same public sources as the PC server: the RSS feeds of
FXStreet, Investing.com and CNBC, and the ForexFactory weekly calendar.
`GET /api/news/feed` and `GET /api/news/calendar` pass on what those sources
publish, name each source, say which one did not answer, and keep an answer
for 5 and 30 minutes so that a source is not asked for every request. When no
source answers, the page says so and shows nothing in its place. One
exception, for the calendar only: while its source does not answer, the copy
that was read last is passed on for up to six hours, and the calendar card
says when it was read ("read at 14:05 EAT") and, once that is more than 45
minutes ago, that the source has not answered since. A week's schedule is published
days ahead; a copy a few hours old is still the schedule, and the page would
otherwise lose its stand-aside periods whenever the source refuses one
request. The page reads the calendar again every ten minutes while the News
view, the chart or the Gold page is open, and one minute after a read that
failed.

**Why 30 minutes either side.** Measured on gold with `scripts/news-window.mjs`
(6 January 2020 to 1 April 2023): 386 high-impact US data releases and rate
decisions of a public copy of the ForexFactory calendar, 379 with prices. In
the minute of the release the 1-minute price range was 5.4 times the usual
one, and 1.8 times 15 to 29 minutes later. "A stop distance" is the distance
the rule puts its stop at (1.5 x the 5-minute ATR before the release):

| Price a full stop distance away from where it stood | At a release | Same weekday and hour a week earlier, no release |
|---|---|---|
| within 1 minute | 54% | 5% |
| within 15 minutes | 84% | 50% |
| in both directions within 15 minutes | 21% | 2% |

Which way it went is not known beforehand. An alert of the rule stays open
30 minutes at the median, so one taken in the half hour before a release is
still open at the release about as often as not. The rule's own alerts near a
release are few (a few hundred in each group), so these figures are uncertain
by 4 to 5 points either way: 37.5% of 510 alerts in the 30 minutes before a
release reached target 1 first, 34.1% of 369 in the 30 minutes after, against
39.4% of 37,250 with no release within an hour. None of the groups reaches the
40% needed to break even. The period is a precaution against the first minute,
not a way to make the rule profitable.

```
node scripts/news-window.mjs --bars <folder of 1-minute CSV files> --events <calendar CSV> \
     --from 2020-01-06 --to 2023-04-01 --bars-clock eet
```

Data used: the gold archive named above (its bars before mid-2025 are on the
Athens clock: `--bars-clock eet`), and the calendar file `events.csv` of
`EPSOFT/dataset-forexfactory` on GitHub at commit `a36d527` (January 2007 to
March 2023, times on the New York clock). The clocks were checked against each
other: in 165 of the 386 releases the largest 1-minute move of the two hours
either side falls exactly on the listed minute. Limits: gold only, US releases
only, a calendar that ends in March 2023; other markets and other currencies
were not measured and get the same period as a precaution; spreads, which
widen at a release, are not in the price bars.

### Market state: trend, structure and volatility on four timeframes

The **Market state** view (`src/marketstate.js`, drawn in `src/main.js`)
describes one market on the 4-hour, 1-hour, 15-minute and 5-minute chart. Each
timeframe has a card with a small chart and three lines, and every line comes
with the figures it was read from:

| Line | States | Read from |
|---|---|---|
| Trend | **Uptrend**: EMA 20 above EMA 50 above EMA 200, close above EMA 50, ADX 14 at 25 or more. **Downtrend**: the reverse. **Range**: ADX below 20, whatever order the averages are in. **Unclear**: everything else | The close, EMA 20 / 50 / 200 and ADX 14 of the last finished candle; for how many candles the state has held |
| Structure | Higher highs and higher lows, lower highs and lower lows, higher highs and lower lows (widening), lower highs and higher lows (narrowing) | The last two swing highs and the last two swing lows, each with its price and time, and where the last close stands against them. A swing high is a candle whose high stands above the five candles before it and is not passed by the five after it |
| Volatility | **Quiet**, **Normal**, **High**, **Extreme** | ATR 14 of the last finished candle against the 200 candles before it: quiet when fewer than 20 in 100 of them were smaller, high from 80, extreme from 95 |

Above the cards one sentence puts the four trend states side by side, the
larger picture first: `H4: unclear. H1 and M15: range. M5: downtrend.` When one
timeframe is in an uptrend and another in a downtrend it says that the
timeframes disagree and names them; it does not pick one. When a timeframe
could not be read it says nothing about the whole.

**It is a description, not a signal.** The Buy, Sell and Wait of the signal
pages are computed without it, by the same code as before, and no alert, order
ticket or risk check reads it. What a replay measured about it is below.

**Finished candles only.** In every series the newest candle may still be
forming and is never used; a state is "as of" the close of the candle before
it, and the card names that close in Nairobi time. A state therefore changes
at most once per candle of its timeframe, and a swing that has been drawn
never moves: it needs five finished candles after it, and from then on it
depends on no later candle. The figures follow the definitions a chart uses
(EMA seeded with a simple average, ATR and ADX with Wilder's smoothing), so
they can be compared with TradingView or MetaTrader on the same candles.
(Since 13 November 2026 the signal rule computes its RSI and ATR the same way;
before that it used averages of the last 14 values, see
`docs/ANALYSIS_ENGINE_AUDIT.md` B2. This view has its own series either way,
because it needs a value for every candle.)

**Where the candles come from.** 600 candles per timeframe from Deriv's public
feed: on the website this browser reads them itself, and the AURUM cloud is
asked only for a series the browser could not get; in the PC app they come
through the PC's own server (`POST /api/history/candles`). The card says
which. The view is read when it is opened, when the market is changed, with
**Read again**, and a few seconds after every 5-minute close while it stays
open. At such a close only the series whose own candle may have finished are
read again: the 5-minute series each time, the 4-hour series six times a day.
When the feed does not show the candle after the close yet, the view asks
again every half minute until it does. The PC's server answers twelve candle
requests a minute and a full look is four, so a fourth full look within one
minute is refused: its cards say "too many candle requests within one minute"
until the next 5-minute close or **Read again**.

**When there is no state.** Fewer than 400 finished candles, candles out of
order, or a series that could not be read give "No state" with the reason, and
nothing is filled in. When the newest 5-minute candle started ten minutes ago
or earlier, the view says that the market is closed or the feed has paused,
and that every state shown is as of the close named on its card, not the state
now. When a later look fails, the states read before stay on screen, each
marked "last look failed"; the feed is then called neither current nor
paused, because the look that would tell is the one that failed. Index
markets are not offered: this app has no intraday candles for them.

**What a replay measured** (`scripts/state-replay.mjs`). The states were
computed over gold from 2 January 2020 to 11 November 2026 exactly as the page
computes them, at the close of every candle. How often each trend state
occurred, and for how many candles in a row it lasted (the middle run):

| Timeframe | Candles with a state | Uptrend | Downtrend | Range | Unclear | Middle run: up / down / range / unclear |
|---|---|---|---|---|---|---|
| M5 | 485,104 | 14.7% | 13.8% | 39.0% | 32.5% | 10 / 10 / 14 / 5 candles |
| M15 | 161,743 | 16.1% | 14.6% | 36.2% | 33.1% | 10 / 11 / 14 / 5 candles |
| H1 | 40,011 | 19.4% | 13.9% | 30.8% | 35.9% | 13 / 10 / 13 / 6 candles |
| H4 | 10,114 | 20.2% | 11.4% | 30.0% | 38.5% | 10 / 11 / 11 / 6 candles |

A trend is the state of about three candles in ten, and "unclear" is common
and short-lived: with ADX between 20 and 25 the state can change from one
candle to the next. Structure was "higher highs, higher lows" on 32 to 35% of
candles, "lower highs, lower lows" on 28 to 30%, widening and narrowing on 18
to 21% each. Volatility was quiet on 22 to 30%, normal on 47 to 58%, high on
12 to 14% and extreme on 6 to 11%. The four swings a structure is read from
lay within the 120 candles of the sketch in 99 cases of 100.

Then the question that decides what the page may say: did the 1m/5m/1h rule do
better in one state than in another? Every alert of the rule (the replay of
[the section above](#the-confidence-score-and-how-it-moves-with-the-price))
was matched with the state of each timeframe as of the 5-minute close the
alert belongs to. "With" is a BUY in an uptrend or a SELL in a downtrend,
"against" the reverse. 72,280 of the 76,694 alerts could be matched; the first
4,414 fall before 599 four-hour candles existed.

| Alerts of the rule on gold | Alerts | Target 1 first | Needed after a $0.25 spread | Per alert after the spread |
|---|---|---|---|---|
| All alerts | 72,280 | 39.7% | 42.6% | −$0.241 |
| With the 4-hour trend | 11,631 | 41.2% | 42.9% | −$0.153 |
| Against the 4-hour trend | 10,963 | 39% | 42.2% | −$0.294 |
| 4-hour state: range | 21,563 | 39.2% | 43.5% | −$0.316 |
| 4-hour state: unclear | 28,123 | 39.8% | 42.2% | −$0.200 |
| With the 1-hour and the 4-hour trend | 5,616 | 41.4% | 42% | −$0.062 |
| With the trend on all four timeframes | 618 | 42.2% | 40.1% | +$0.275 |

These are the figures of the rule as it runs now. The run was repeated on 13
November 2026, after the rule's RSI and ATR were changed to Wilder's (see the
section above). Before that change it gave 41.1% of 12,614 alerts with the
4-hour trend and 38.9% of 11,615 against it: the same picture.

"Needed" is the share at which a group breaks even, from its own average win
and loss, after an assumed spread of $0.25 per alert (the same assumption as
in the section above). Before the spread it is 40% for any single alert, and
39.7% for the 76,694 alerts of the rule together, whose winners were a little
larger than their losers. "Per alert" is in dollars per ounce, which is the
result of 0.01 lot. The same $0.25 weighs more in the early years, when gold
stood near $1,800 and the stops were closer: with the 4-hour trend the share
needed was 44.7% in 2020 and 41.5% in 2026.

In words:

- Alerts that pointed with the 4-hour trend reached target 1 about two points
  more often than those against it (41.2% against 39.0%), and did so in five
  of the seven years. With 11,000 alerts in a group a share is known to about
  ±0.9 points at best (alerts close together in time are not independent of
  each other), so the difference is probably not chance.
- It is not enough. 42.9% is needed after the spread, and the group lost money
  in each of the seven years. The 1-hour and the 4-hour trend together give
  41.4% against the 42.0% needed, and a loss in five of the seven years.
- Of the groups in the table, the one above break-even is the smallest: 618
  alerts in seven years with the trend on all four timeframes, between 63 and
  135 a year, known to about ±3.9 points. It came out ahead in two of the
  seven years, 2024 and 2026, and its total comes from those two (2026 alone:
  95 alerts at +$3.21 each).
- Splitting the alerts by structure or by volatility instead gave between
  38.2% and 41.4% in every group of more than 1,000 alerts. One of those 32
  groups came out above its break-even: alerts while 15-minute volatility
  was "extreme" (41.4% of 3,145 against the 40.9% needed, +$0.095 per alert).
  With 3,145 alerts a share is known to about ±1.7 points, and among 32
  groups one that far above the rest is what chance alone gives. It was the
  same group before the change of RSI and ATR, but on largely the same
  alerts, so that is not a second confirmation. It was not looked into
  further.

So the state is shown as what it is, a description of the chart, and no
filter, veto or score was built on it. The sentence under the heading of the
view gives the 4-hour figures (`STATE_MEASURED` in `src/marketstate.js`;
`tests/platform/market-state.test.mjs` keeps this table and the page equal,
`tests/platform/state-replay.test.mjs` checks the counting of the script on
written price paths: that a state of the replay is the state the page shows
at that close, and that an alert is matched with nothing later than itself).

To repeat the run (the price data is not in this repository; it is the gold
archive named in the section above):

```
node scripts/state-replay.mjs --data <folder of 1-minute CSV files> --symbol XAU/USD \
     --from 2020-01-01 --to 2027-01-01 --spread 0.25
```

Limits of the measurement: one market; a price series that is neither Deriv's
nor Exness's; the archive's bars are on broker time until mid-2025, so its
4-hour candles start at other hours than Deriv's, and what that does to the
shares was not measured; one assumed spread for every alert. The thresholds
(ADX 25 and 20, five candles, 200 candles) are the usual textbook values and
were not tuned on this data, which also means nobody has shown that they are
the best ones.

Limits of the view: a swing high one cent above the one before it counts as a
higher high. There is no band for "equal"; the card gives both prices, so
that a double top can be seen for what it is. A state says nothing about the
candle that is forming. A candle counts as finished only when the series
holds a later one (the rule of the signal pages), so on a closed market the
last candle before the close is left out until the market opens again, and a
chart elsewhere shows one candle more than the card was read from. Not
verified anywhere: the view against Deriv's live feed. The tests use written
candles, and the pictures taken while building it used the gold archive.

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
starts a build, and a successful build becomes the active deployment.
Cloudflare reports every build on the commit in GitHub, as the check
**Workers Builds: cloudflare-staging**. For the 23 builds of `main` up to
13 November the result arrived 24 to 87 seconds after the push, and all 23
succeeded.

**What is live.** Cloudflare dashboard → Workers & Pages → `cloudflare-staging`
→ **Deployments**. "Active deployment" is the version that serves the site.
Its row in the list below carries the commit message of the merge it was built
from. GitHub shows it too: on the list of commits of `main`, select the mark
next to a commit. Cloudflare's line in the list that opens is **Workers
Builds: cloudflare-staging**, green after a successful build. A merge commit
without that line two minutes after the merge was not built. The mark itself
is not enough: it also turns green when only the repository's own tests have
passed (the lines **Build, test, dry-run** and **PC bridge tests**, see
[Continuous integration](#continuous-integration)). (On `1534184` and
`d3fdf22` Cloudflare's line is red although they were published, and on
`e0e7903` it is red although no build of `main` ever ran for it: a branch was
created at each of them later, and the preview build of that branch failed.)

**An address with eight characters in front.**
`https://<eight characters>-cloudflare-staging.<account>.workers.dev` is a
Version URL. Cloudflare gives one to every version it uploads, and it shows
that one version for good: it does not change when something is merged or
published. The site is the address without the prefix. The **Deployments**
page links both, so to see whether a merge is live, open the one without the
prefix.

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

**Pushes that were never built.** Of the 28 pushes to `main` between the first
build (9 November) and 13 November, 19:20 UTC, five got no build at all, and
neither did the next three: no check on the commit, and nothing to retry.
GitHub received nothing from Cloudflare for them, neither the check Cloudflare
posts when a build starts nor a failed one. GitHub had registered each of
these pushes for Cloudflare's app: it holds a check suite of that app for the
commit, opened within seconds of the push and still empty
(`gh api repos/<owner>/<repository>/commits/<commit>/check-suites` lists it as
`cloudflare-workers-and-pages`, `queued`, no runs). So the app was installed
on the repository each time. Whether GitHub's notice reached Cloudflare cannot
be seen from the repository; that Cloudflare never answered it can.

| Push to `main` (UTC) | What | Published by |
| --- | --- | --- |
| 11 Nov, 20:00:44 | merge of #4 | the build of #5, an hour and a half later |
| 13 Nov, 08:00:43 | files uploaded on GitHub | the build of #11, three and a half hours later |
| 13 Nov, 18:00:09 | merge of #12 | see below |
| 13 Nov, 19:12:21 | merge of #14 | see below |
| 13 Nov, 19:20:17 | merge of #13 | see below |
| 13 Nov, 22:03:44 | merge of #16 | see below |
| 13 Nov, 22:52:39 | merge of #17 | see below |
| 13 Nov, 23:27:47 | merge of #15 | see below |

*The first two* were single pushes, each published by the next build. Both
were pushed in the first minute after a full hour, as was the third, and none
of the 23 pushes that were built was (the nearest ones came 4 and 18 seconds
before an hour, and 3 and 5 minutes after one). The first is from two days
before the repository was renamed. Whether the hour is the cause has not been
established.

*The last six* are one stretch, and the hour does not explain it. On
13 November no push started a build from 18:00 UTC until 23:27 UTC: not these
six merges, five of them well after the hour, and not one of the 13 pushes to
other branches between 19:11 and 23:09, which got no preview build either. The
last build that a push had started was that of a branch at 14:03 UTC. Builds
asked for with **Re-run** on GitHub at 18:44 UTC still ran, so Cloudflare
could still reach and build the repository; it was pushes that no longer
started anything. Cloudflare's own status page listed a fault of its Workers
API from 15:31 UTC that day ("an increase in 5xx errors deploying Workers or
doing other API actions"), not yet closed at 23:34 UTC. Whether that was the
cause has not been established. Two pushes to a branch at 23:44 and 23:45 UTC
were built again. What had changed in between cannot be seen from GitHub.

What follows from both:

- After a merge, look for the check on the merge commit. Without one, the
  merge is published by the next push to `main` that is built (point 4 above).
- When several pushes in a row carry no check, a further merge does not help.
  Look in the Cloudflare dashboard: **Settings** → **Builds** shows whether
  the repository is still connected, and **Deployments** → **View Build
  History** whether Cloudflare saw the pushes at all. Connecting the
  repository again is described under "The repository's name" below, and
  "Deploying staging" above publishes without the Git integration.
- `main` can be built without a push. Cloudflare's documentation (30 October
  2026) describes a **Deploy Hook**: **Settings** → **Builds** → **Deploy
  Hooks**, a name, the branch `main`, **Create**. An HTTP POST to the address
  it gives starts a production build of the branch as it stands, for example
  `curl.exe -X POST "<address>"` in a Windows command prompt. The address is
  the only credential: keep it out of the repository and out of messages. Not
  tried here.
- **Re-run** needs a person, and a check to press. A commit that was never
  built has none. And GitHub lets only Cloudflare's own app, or someone signed
  in on the website, ask for Cloudflare's check again: a workflow's token is
  refused with HTTP 403 (`Invalid check_suite_id`), tried on 13 November.
- Merging at five minutes past the hour or later costs nothing, and avoids
  the one pattern seen so far.

**Pull requests get a separate preview build.** It runs Cloudflare's Preview
command (`npx wrangler preview` by default, an open-beta Wrangler command)
instead of the deploy command. Every preview build so far has failed: on each
of the pull requests #3 to #12, before the repository was renamed and after.
The cause is in Cloudflare's build log and has not been established. The log
is behind the **View logs** link of Cloudflare's comment on the pull request
and opens only for someone signed in to the Cloudflare account. Wrangler
itself accepts the configuration: `npx wrangler versions upload --dry-run`
passes, and so does the production deploy. A red preview mark on a pull
request is not the result of the production publish: #3 was published after
its preview had failed.

**The repository's name.** The Worker's name, the site's address and `name` in
`wrangler.jsonc` do not depend on the name of the GitHub repository, and the
rename of 13 November changed none of them. Cloudflare's build settings keep
showing the repository under the name it had when it was connected. That alone
is no fault: after the rename Cloudflare still started builds for this
repository (preview builds on 13 November from 12:56 UTC on, one of them a
**Re-run** asked for on GitHub). The pages of Cloudflare's Workers Builds
documentation read on that day (Git integration, configuration, build
branches, troubleshooting) do not mention a rename. Its documented way to
switch a Worker to another repository is **Settings** → **Builds** →
**Disconnect**, then **Connect**, and the repository can be chosen there again
under its new name. Write the build settings down before disconnecting, and
push a commit to `main` afterwards: connecting does not start a build by
itself. GitHub redirects the old address to the new one only as long as no new
repository takes the old name.

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

**The `bridge/` files of that package.** The package of 12 November had also
changed four files in `bridge/`: a new `START_MT5_IF_CLOSED.ps1`, and
`SETUP_AND_RUN.bat`, `AUTO_START.bat` and `mt5_bridge.py`. They were uploaded
on 13 November 2026. The upload put them in the top folder of the repository
and once more replaced `package.json` and `package-lock.json` with the
package's older copies, so the four files were moved into `bridge/` and the two
package files restored. `tests/localHosting.test.mjs`, which describes these
scripts, now passes without a `# TODO`.

`bridge/mt5_bridge.py` in the repository is now newer than the copy in that
package (see
[When Connect cannot attach to MetaTrader 5](#when-connect-cannot-attach-to-metatrader-5)).
Uploading the package's `bridge` folder again would put the older file back.

When uploading through GitHub's web page, open the folder the files belong to
first and upload there: files dropped on the repository's front page land in
the top folder. Leave `package.json` and `package-lock.json` out of an upload
that comes from the PC package.

### What the configuration does

- **Routing.** `/api` and `/api/*` always run the Worker. Other requests are
  answered from `dist/`. A path that is not a file falls through to the Worker:
  app routes such as `/app` and deep links get the app page, anything that
  looks like a file (`/missing.js`, `/.env`, `/wp-login.php`) gets a plain `404`.
- **API surface.** `GET /api/health`, `/api/signals/usage`, `/api/signals/history`,
  `/api/markets/deriv`, `/api/news/feed`, `/api/news/calendar`; `POST /api/signals/scan`, `/api/signals/analyze`,
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

`.github/workflows/ci.yml` is the GitHub Actions workflow for this repository
(active since 13 November; until then the file lay one folder higher, where
GitHub does not run it). It runs on pull requests and on pushes to `main`, and
it only verifies — it never deploys and needs no secrets:

- Node 22 and 24: `npm ci`, `npm audit --audit-level=high`, then
  `npm run verify` (build → smoke and unit tests → the Worker inside workerd →
  `wrangler deploy --dry-run`). Since 13 November a high or critical advisory
  against a dependency fails the job (before, it was a warning). A job can
  therefore turn red on a commit that changed nothing about dependencies:
  `npm audit` names the package, `npm audit fix` usually repairs it.
- Python 3.11 and 3.13: a syntax check and the PC bridge unit tests
  (`python -m unittest discover -s tests -p "test_*.py"`). They use only the
  standard library; no conda environment is involved.

Its marks on a commit (**Build, test, dry-run** and **PC bridge tests**) say
that the code passed its tests. They do not say that the website was
published: that is the separate check **Workers Builds: cloudflare-staging**
(see "When a merge does not reach the live site").

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
src/marketstate.js    Market state view: trend, structure and volatility per timeframe (a description, not a signal)
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
