# SHELRICKTECK NEXUS — Repository Inspection, Architecture & Implementation Plan
**Phase:** inspect & plan only — no code modified · **Date:** 2026-11-24
**Branch for implementation:** `arena/a3c9e72d-shelrickteck-analysis` (session branch = dedicated feature branch; no auto-merge, no deploy)

---

## 1. Repository baseline (executed this pass)

| Item | Value |
|---|---|
| HEAD = `origin/main` | `dddec46` (*Merge pull request #53*), working tree **clean**, not shallow, **0 open PRs** from this branch |
| Baseline tests (just run) | `npm test` → smoke **400 PASS / ALL GOOD**; node suite **921 tests, 920 pass, 0 fail, 1 skipped** |
| Prior executed evidence (this session) | worker **14/14**; Python bridge **72/72** + CI Py 3.11/3.13 green; `verify:dist` OK; wrangler dry-run OK; `npm audit` **0** |
| Stack | Vite SPA (`index.html` 2,318 lines + inline token-based CSS; `src/main.js` ~6.8k lines; 29 modules) · local Node API `server/server.js :4100` · static host `:8788` · Cloudflare Worker (staging) · Python MT5 bridge (WS :8787) · PWA (`sw.js` v`aurum-local-v2`) |
| Recent session history on `main` | #49 sizing/risk panel · #50–#51, #53 audits · #52 position reconciliation |

---

## 2. Current architecture → NEXUS three-zone mapping

```
ZONE A (exists, to be restructured)          ZONE B (exists, to be re-scaled)       ZONE C (NEW)
──────────────────────────────               ────────────────────────────────      ─────────────────
Fixed left sidebar (#sidebar)                <header class="topbar">               contextual right
14 nav items, hamburger drawer               title/crumb/theme/install/order        intelligence panel
groups: none today — will add               <main class="content">                (bias, trend, confluence,
                                             views: overview, markets, watch,       levels, volatility,
                                             trade, state, signals, sniper,         news, data quality)
                                             proscalper, gold, news, portfolio,
                                             automation, learn, settings
```

**Already reusable (no rebuild):**

| Brief need | Existing asset (evidence) |
|---|---|
| Palette swap to #080E18 / #19C6E6 … | Token architecture `:root{--bg;--surface;--brand;--green;--red;--amber…}` (`index.html:19`) — one-token re-skin, light theme untouched |
| Market table w/ search, sort, filter, freshness | `view-markets`: `#mktSearch`, `#mktCats`, `#mktSort` (`index.html:1068-1077`), `renderMarkets` + `chgOf`, per-quote freshness, hostedscan statuses |
| Charts M1–D1 + W1, indicators, crosshair, fullscreen-ready | TradingView widget `mountChart(container,sym)` (`src/tradingview.js:42`) — full study set incl. EMA/RSI/MACD/BB/ATR/Volume, all timeframes M1–W1; native charts `goldchart/annotatedchart` with `GRAN_LABELS` 1m…1D (`main.js:4086`), `chartDisplayMode` toggle |
| Indicator math (server-side) | `server/lib/indicators.js`: `sma/ema/rsi/macd/bollingerBands/atr` (`:14-100`), `indicators.ext.js`, tick-volume attach for proscalper |
| AI / NEXUS intelligence engine | `/api/pipeline/analyze` + `server/lib/pipeline/*` (scout/news/charts/strategy/risk+boss in `index.js`), `/api/signals/analyze`, `localDecision` deterministic score, `loadPipelineFlow()` role presentation, votes/rationale/risks/key-levels fields |
| Gold research workspace | `view-gold`: source select (Exness/Deriv), M1/M5/H1 monitor, chart, outlook, levels, news/events, `goldReading()`; plus exposure panel from #52 |
| Calendar + news | `view-news`: `tv.mountCalendar/mountNews`, `/api/news/feed` (Investing.com RSS), `/api/news/calendar`, EAT countdowns, importance flags |
| Key levels / technical research | scan readings carry entry/SL/TP1/TP2/support/resistance per symbol (hostedscan, signalrun), `#backtestCard`, analysis history |
| Diagnostics inputs | `/api/health` (build `BOOT_ID`, engines, feed, budget), feed/deriv/mt5 pills, session error log `aurum_sesslog` (`main.js:737`), MT5 snapshot timestamps |
| Risk/data-quality panel inputs | `derivHealth`, `withheldReading`/stale logic, ATR/volatility from analyses, markethours session state, calendar event risk |
| Layout responsive base | breakpoints 1050/960/900/700/640…, hamburger drawer + scrim, `data-goto`/`data-goto-section` deep-linking (already used by MCC nav) |
| Screenshot harness pattern | `scripts/screenshot-size-plan.mjs` (puppeteer-core + @sparticuz/chromium, console-safe interception) — extend to 4 viewports |

---

## 3. Navigation map (13 NEXUS destinations ↔ existing routes)

| NEXUS nav item | Route strategy | Notes |
|---|---|---|
| Command Centre | `view-overview` (reworked) | single-MCC regression tests stay green |
| Market Explorer | `view-markets` (reworked compact) | + watchlist reachable inside |
| Gold Analytics | `view-gold` (re-styled research layout) | keep #52 panel, source labelling |
| Forex Analytics | **new** thin workspace `view-forex` | preset majors → reuses chart workspace + bias card; no new endpoints |
| Indices | **new** thin workspace `view-indices` | NAS100/US500/US30/GER40, daily-context rules preserved |
| Technical Research | `view-signals` + **new** compact levels table (§9) | levels table renders existing scan state only |
| AI Intelligence | **new** `view-ai` = NEXUS INTELLIGENCE presentation of existing pipeline/analysis output | supporting vs conflicting evidence split from existing votes/risks fields |
| Economic Calendar | deep-link `view-news` calendar section (`data-goto-section`) | |
| Market News | deep-link `view-news` feed section | |
| Historical Analysis | deep-link to `#backtestCard` + analysis history *(see decision D4)* | |
| Reports | deep-link to `#closedHistoryCard` + share exports *(D4)* | |
| System Diagnostics | **new** `view-diagnostics` | /api/health + pills + sesslog + version/cache, honest UNKNOWN |
| Settings | `view-settings` | |

**Preservation rule:** the 7 views not in the brief’s list — **Watchlist, Trade (advanced ticket), Sniper, Pro Scalper, Portfolio, Automation, Calculator Lab** — are NOT deleted. Plan: sidebar **secondary “Workspace” group** (collapsed by default) + existing Command Centre Workspace-Navigation links. Every current `goto()` target keeps working (smoke nav tests unchanged).

---

## 4. Design-system plan

- Swap dark-theme token values in `:root` (`--bg:#080E18`, `--surface:#101B2A`, `--surface-2:#152235`, `--brand:#19C6E6`, `--green:#16C784`, `--red:#EA5964`, `--amber:#E7B64A`, `--text:#EDF3FA`, `--text-2:#91A1B6`, `--border:#25364A`; sidebar var `--sidebar-bg:#0B1320`) — **no per-component colour rewrites** (components already consume tokens).
- Typography: `Inter, -apple-system, …` stack first (no new network dependency; CSP/`font-src 'self'` untouched); monospaced numerals via existing `--mono` + `font-variant-numeric: tabular-nums` (already used in KPIs).
- Remove residual gold accents where tokens don’t cover (badges/buttons using `--brand-hi` etc. map through tokens already); shadows reduced to `--shadow` token; hover/focus states standardised.
- `manifest.webmanifest` theme/background colour → `#080E18`; branding defaults (`BRAND_DEFAULT` tagline “INVESTMENT” → “NEXUS INTELLIGENCE”) with `tests/platform/branding.test.mjs` updated in the same commit.
- Light theme: left functionally intact (out of brief’s palette scope) — documented.

---

## 5. Implementation milestones (incremental, reversible, tested after each)

| M | Deliverable | Primary files | Risk |
|---|---|---|---|
| **M0** | Baseline captured (done); branch hygiene | — | none |
| **M1** | **Design system**: token swap, typography, shadow/hover/focus pass, manifest/theme colour, branding defaults | `index.html` (`:root`, base CSS), `public/manifest.webmanifest`, `src/main.js` (BRAND_DEFAULT), branding test | low — pure CSS/config, instant revert |
| **M2** | **Three-zone shell**: sidebar groups + collapse + line icons + tooltips; extended header (session state via markethours, source-status pill, last refresh, notifications → existing notify history, profile→settings); **right intelligence panel** (contextual per `state.chart.sym`, fed by existing scan/signal/news/health state, collapsible, stacks ≤960px); mobile drawer preserved | `index.html` (shell markup), `src/main.js` (header/panel render, goto wiring), new `src/nexuspanel.js` (pure render from existing state) | medium — layout grid change; guarded by app-shell tests |
| **M3** | **Command Centre rework**: compact sortable overview table (8 instruments, reuse market state), chart-first composition, workspace nav retained, single-MCC + portfolio-pinned assertions intact; ticker per decision D2 | `index.html` `view-overview`, `src/main.js` renderOverview, platform tests | medium |
| **M4** | **Chart workspace**: toolbar (instrument, M1–W1 timeframe, chart type tv/native, indicator toggles → TV studies + native overlays, refresh, fullscreen), OHLC readout, clean multi-panel spacing | `index.html` `view-trade` shell (preserved ticket inside), `src/tradingview.js`, `src/main.js` chart wiring | medium — chart lifecycle/cleanup verified |
| **M5** | **Module views**: `view-ai` (NEXUS INTELLIGENCE: structure/trend/context/explanation + supporting vs conflicting), `view-forex`, `view-indices`, levels table, calendar/news split links, `view-diagnostics`, Gold research re-layout | new markup sections + `src/main.js` render cases + `src/nexuspanel.js` | medium |
| **M6** | **QA**: full test suite, new platform tests (nav integrity, single MCC, table sort/search, panel context switch, diagnostics truthfulness, no-dup-IDs), screenshot harness → **1600×900, 1366×768, 768×1024, 390×844** with console-error capture, a11y pass (focus/labels/contrast) | `tests/platform/*`, `tests/smoke.mjs`, `scripts/screenshot-nexus.mjs` (extends size-plan pattern) | low |
| **M7** | Build + ZIP refresh + notes + PR + final report (§18 items) | `dist/`, ZIPs, `LOCAL_UPDATE_NOTES.txt` | low |

**Explicitly untouched:** bridge execution logic, `/api/deriv/order|fill|close`, PAT engine, risk caps, credentials flow, security Wave A (separate pending approval), databases/localStorage schemas (additive keys only), Railway/Vercel files.

---

## 6. Verification plan (per brief §16 — all to be actually executed)

1. `npm test` (baseline before M1 — recorded above; re-run after each milestone) · `npm run build` · `npm run test:worker` · `npm run verify:dist` · `npm run verify`.
2. New regression tests: nav map completeness (13 NEXUS + 7 preserved), one-and-only-one MCC, overview table sort/search/filter, right-panel context switching, diagnostics never claims ONLINE without passing health response, chart toolbar controls exist and dispatch, no duplicate IDs (existing478-id check extended).
3. Real browser: puppeteer harness at the 4 required viewports; **console error capture asserted empty**; single-MCC visual check; mobile no-horizontal-overflow check.
4. CI Node 22/24 + Python bridge (unchanged code — expected green; reported as executed).
5. Honest labels: all scores remain “technical agreement, not probability of profit” (existing strings preserved + asserted).

---

## 7. Decisions needed before implementation

| # | Question | Recommended default |
|---|---|---|
| **D1** | Where do the 7 non-listed legacy views live? | **Secondary collapsed “Workspace” group** in the sidebar (nothing hidden or deleted) |
| **D2** | Instrument ticker under the header — it was *removed* once as a duplicate-dashboard offender | **Include one compact single-instance ticker** on Command Centre only, fed by the existing global tick state (no duplicate fetch); skip if any existing test forbids it — will check first |
| **D3** | Inter font | **System stack with Inter first** (zero bundle cost, offline-safe); bundle `Inter` woff2 later only if visual QA demands |
| **D4** | Historical Analysis & Reports: anchor-links to existing panels vs physically moving DOM | **Anchor-links first** (zero regression risk, reversible); physical relocation only if you want it after seeing M5 |

---

## 8. Status

- Repository inspected; architecture and reuse map documented with file:line evidence — **VERIFIED**.
- Baseline tests executed this pass — **VERIFIED** (400 ALL GOOD; 920/0/1).
- No code modified; no PR opened; nothing merged or deployed.

**Awaiting approval to begin M1 (design system) — or re-sequenced subset.** Suggested reply: *“approve D1-default, D2-default, D3-default, D4-default — start M1”* (or override any decision).
