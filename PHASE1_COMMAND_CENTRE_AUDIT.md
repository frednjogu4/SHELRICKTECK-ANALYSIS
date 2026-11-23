# PHASE 1 — Repository & System Audit
**Project:** SHELRICKTECH AI Intelligence Command Centre (upgrade, not rebuild)
**Date:** 2026-11-23 · **Auditor:** Agent Mode (source-verified; no code modified)
**Branch for implementation:** `arena/a3c9e72d-shelrickteck-analysis` (session branch = the dedicated feature branch; nothing is committed to `main`)
**Baseline `main`:** `f0c676b` — *Merge pull request #49* (sizing/exposure repair; CI 5/5 green at merge)

> Method: every finding below was verified against the working tree, GitHub API, or an executed test run. Where something could not be verified from this environment it is marked **UNVERIFIED** or **BLOCKED** rather than assumed.

---

## 1. Repository, branches, PRs, commits, deployment workflow

### 1.1 Recent commits (GitHub API; local clone is shallow depth=1)
```
f0c676b Merge pull request #49 (sizing/exposure math + risk panel)   ← main HEAD
bfd9c48 Fix MT5 sizing/exposure math; add transparent risk-calculation panel
0ff4de7 Merge pull request #48 (broker-minimum floor exempt from notional cap)
051231b Exempt the broker minimum lot from the order notional cap
246bb1b Merge pull request #47 (manual REAL/DEMO Exness execution + guards)
9a3b562 Enable manual REAL/DEMO Exness order execution with per-order guards
49a4a90 / c17705e  local update packages + dashboard launcher
… (45 branches total on the repo)
```

### 1.2 Open pull requests (relevant to this project)
| PR | Title | Relevance |
|---|---|---|
| **#42** (draft) | Fix duplicate Market Command Centre display | **CRITICAL — must not be merged as-is (§3)** |
| #29 | PC bridge 22a … | Bridge identity; touches `arena/8d344289-cloudflare-staging` |
| #9 (draft) | Analysis & risk command centre specification | Related spec; overlaps this brief |
| #37 (draft) | Cap position sizing tiers at broker-capped FULL | Sizing display; overlaps #49 work |
| #38, #33, #28 (drafts) | Pro Scalper features | Trade view / Pro Scalper scope (F) |
| #26 | Feat/aster market evidence | Evidence module; unrelated to shell |

### 1.3 CI / deployment workflow — **VERIFIED**
- `.github/workflows/ci.yml`: **Node 22 + 24** matrix → install, build, `npm test`, wrangler dry-run; **Python 3.11 + 3.13** bridge tests; cloudflare-staging worker build job.
- `.github/workflows/deploy-cloudflare-staging.yml`: `workflow_dispatch` with `confirm_deploy=deploy`, **runs only on `refs/heads/main`**, environment `cloudflare-staging` (secret `CLOUDFLARE_API_TOKEN`), Node 22, `npm ci`, wrangler deploy.
- Scripts: `verify` = build + test + worker tests + wrangler dry-run; `cf:deploy:staging` = local deploy path (needs CF token — not present in this sandbox).
- **Baseline test results at this commit (executed during #49):** `npm test` **910 / 909 pass / 0 fail / 1 skip** (smoke 395 ALL GOOD), Python bridge **72/72**, worker runtime **14/14**, wrangler dry-run OK, both update ZIPs in sync.

**⚠ Rule conflict (needs decision):** the brief requires *staging deploy after successful tests without merging to main*, but the only staging workflow is **main-only**. Options in §9.

---

## 2. Architecture map & canonical dashboard entry point

```
index.html (2,316 lines — markup + ALL CSS inline, 23 @media blocks)
  └─ src/main.js (6,746 lines — state, navigation, all view renderers)
       ├─ src/commandcentre.js   additive MCC module (currently INERT — §3)
       ├─ src/hostedscan.js, marketdata.js, marketstate.js, derivws.js, derivproxy.js   market feeds
       ├─ src/signalrun.js, bestpick.js, measured.js, smcplaybook.js, patterns.js, shortoutlook.js  analysis
       ├─ src/sizer.js, mt5Risk.js, resilience.js   risk
       ├─ src/newsimpact.js, schedulednews.js   news/calendar client
       ├─ src/cloud.js (Supabase), notify.js (WhatsApp), vault.js, bridge.js, tradingview.js, goldchart.js, annotatedchart.js
       └─ imports server/lib/proscalper.js, indicators*.js (bundled by Vite)
server/app.js + server/lib/**  local API (signals, pipeline, setups, backtest, news, PAT, health, limits, riskgate…)
server/websiteserver.js       static local hosting (port 8788 launcher)
cloudflare/{worker,platform,news}.js + wrangler.jsonc   staging Worker (technical-only subset)
bridge/mt5_bridge.py + bridge/app.html                   local MT5 bridge (read + manual order plan)
public/{sw.js,manifest}       PWA
```

**Canonical dashboard entry point:** `index.html` → `<section class="view active" id="view-overview">` (`commandTitle` = *Market Command Centre*), rendered by `renderOverview()` (`src/main.js:3357`) = `updatePortfolioLive()` + `renderCommandMarkets()` + `renderBestPick()` + `renderConnectionSummary()`.

**Navigation:** `goto(view)` (`src/main.js:433`) + `VIEW_META` — **14 views**: overview, markets, watch, trade, state, signals, sniper, proscalper, gold, news, portfolio, automation, learn, settings. Desktop: fixed left sidebar (`≥961px`). Mobile: hamburger drawer (`#hamburger`/`#sidebar`/`#scrim`, `<960px`). `data-goto` delegation + `data-goto-section` scroll anchors. Mobile order bar only when `body[data-view="trade"]`.

**Breakpoints in use:** 1050, 960/961 (nav flip), 900, 700, 640, 600, 560, 520, 480.

**Charts:** TradingView widget mount (`tv.mountChart/mountNews/mountCalendar`), native `goldchart`/`annotatedchart`, market-state grid, Pro Scalper panels — all read-only display.

---

## 3. Dashboard / navigation duplication audit (root causes)

1. **Current `main` shows exactly ONE Market Command Centre.** The legacy `view-overview` markup *is* the consolidated MCC (Market Status → Market Overview → Analysis Summary → Portfolio Overview → Workspace Navigation), produced by the earlier consolidation documented in `DASHBOARD_AUDIT.md`.
2. **`src/commandcentre.js` is dead code in production:** `initCommandCentre()` requires anchor `#ovKpis` (`commandcentre.js:91`), which **does not exist** in current `index.html` (grep: 0 hits) → it returns `false` and never mounts. Its test fixture (`tests/platform/commandcentre.test.mjs`) *injects* `#ovKpis`, so the test passes while the module never runs in the real app — **test/production mismatch**.
3. **PR #42 would BLANK the dashboard** (FAILED as-is): it adds `#view-overview > :not(#shelrick-command-centre){display:none!important}` and touches only `commandcentre.js` + its test. Since the module never mounts (no `#ovKpis`), *every* overview child would be hidden and the landing page would render empty. Its passing test masks this because the fixture supplies the missing anchor. → Recommend **close #42** (with approval) and fold its regression intent into new tests on the real markup.
4. **Duplicate IDs: NONE** — all 478 `id=` attributes in `index.html` are unique (scripted check).
5. **Duplicate nav items: NONE** — sidebar (14) and MCC Workspace Navigation (10 shortcut buttons) are single instances and complementary; no other nav containers found.
6. **Hidden views / init order:** all views toggled solely via `.view.active` + `body[data-view]`; no stray `display:none` rules found on `#view-trade` etc. Init: module top-level → `initCommandCentre()` on DOMContentLoaded (inert) → `boot()` (`main.js:5759`) → `render(state.view||'overview')`; startup guard `window.__aurumAppStarted` is the last statement. **No broken imports** (build green on Node 22/24).
7. **Historical note (from `DASHBOARD_AUDIT.md`, preserved):** duplicate portfolio KPIs, duplicate movers/signals/news panels, injected `#ovDaily` card and the global ticker were already removed; `#ovBest` is the single authoritative analysis panel (smoke asserts it, `tests/smoke.mjs:265`).

---

## 4. AI agent modules (SCOUT · NEWS · CHARTS · STRATEGY · RISK · BOSS)

- **Server:** `server/lib/pipeline/` → `scout.js`, `news.js`, `charts.js`, `strategy.js`, `index.js` (Risk + Boss composed in `index.js`; contract comment: *“REJECTED — never ‘READY FOR MANUAL REVIEW’. The Boss never overrides Risk.”* `pipeline/index.js:6`). Route: `POST /api/pipeline/analyze` (`server/app.js:665`), rate-limited, tested in `server/tests/api.test.mjs` (rolesBefore/rolesAfter, missing-data cases).
- **Client presentation:** `loadPipelineFlow()` (`main.js:6694`) renders the six-role chips + timestamped role reports after Signal Analyzer results; statuses used: WAIT / SETUP DETECTED / REJECTED / READY FOR MANUAL REVIEW, labelled *“analysis only — this panel never executes”*.
- **Staging caveat:** on Cloudflare the client explicitly reports *“Cloudflare staging is technical-only. The AI / six-role pipeline is not migrated”* (`main.js:6702`) — the agent panel there must show honest unavailable state, never fabricated status.
- **Boss/LLM-only approval:** server-side gating is tested for missing/stale inputs; deep code review of `pipeline/index.js` is scheduled as the first task of Phase 2-D before any UI work (**UNVERIFIED** beyond contract + tests until then).

---

## 5. Portfolio data model (no `/api/portfolio` exists — confirmed)

**There is no generic portfolio endpoint.** Actual sources:

| Data | Source | Where |
|---|---|---|
| MT5 balance/equity/positions | local bridge quote (`state.broker`, `state.mt5LivePositions`) | `updatePortfolioLive()` `main.js:3247-3262` |
| Deriv balances/positions | `/api/deriv/connect` + proposal/fill flow (`state.balance`, `state.positions`) | same |
| Paper (PAT) accounts & contracts | `/api/deriv/pat/{session,portfolio,proposal,confirm,close,refresh}` — virtual, server-held | `view-portfolio #pfAccounts` (`data-pat-accounts`) |
| App-recorded positions / history | local `state.positions` / `state.history` | `#posBody`, `#histBody`, `#closedHistoryCard` |
| MCC KPI row | same writers → `#pfBalance #pfEquity #pfPl #pfClosed` | `index.html` overview card |

**Honesty baseline (preserve):** disconnected → `Not connected` / `—`, never `0`; REAL/DEMO verified via broker environment (toasts + account list `main.js:697,819,991`); P&L marked `—` when unknown.

**Gaps vs brief:** MCC Portfolio card has **no** REAL/DEMO/PAPER badge, **no** data timestamp/source line, and no performance/drawdown summary (drawdown lives only in `view-learn`). “Open simulated positions / realized & unrealized simulated P&L / performance history” exist only for PAT + app history, not as one labelled block.

---

## 6. Integrations inventory (classified)

| Integration | Class | Evidence |
|---|---|---|
| Deriv public WS feed + proxy | READ-ONLY market data — **VERIFIED** (code + tests `deriv-*`) | `src/derivws.js`, `server/lib/derivfeed.js` |
| Deriv PAT paper engine | VIRTUAL paper trading, labelled — **VERIFIED** | `server/lib/derivpat.js`, `/api/deriv/pat/*` |
| Exness MT5 bridge (quotes, positions, spec) | READ path — **VERIFIED**; manual order-plan path = pre-existing execution | `bridge/mt5_bridge.py`, `src/bridge.js` |
| News: Investing.com RSS + calendar | READ-ONLY — **VERIFIED** (route + lib; live provider response **UNVERIFIED** from sandbox) | `server/lib/news.js:13`, `/api/news/feed` |
| Signals/pipeline/setups/backtest/health local API | READ/COMPUTE — **VERIFIED** by tests | `server/app.js` |
| TradingView charts | READ-ONLY embed | `src/tradingview.js` |
| Supabase cloud sync | config/docs exist — live sync **UNVERIFIED** | `src/cloud.js`, `SUPABASE_CLOUD_SYNC_*` |
| WhatsApp notify | opt-in push — **UNVERIFIED** (needs config) | `src/notify.js`, `server/lib/wa.js` |
| **Deriv order/fill/close, automation bots + auto-trade toggle, MT5 manual REAL/DEMO plan** | **PRE-EXISTING EXECUTION SURFACES — out of scope; will not be enabled, extended, or simulated-as-real** | `main.js` automation view, `server/lib/tradederiv.js`, `limits.js`, `riskgate.js` |
| Pro Scalper | analysis + paper ledger only, `execution:'disabled'` — **VERIFIED** | `main.js:5643-5647`, `server/lib/proscalper.js` |
| Cloudflare staging Worker | technical-only API subset (health, news, signals, markets) — **VERIFIED** by route table `cloudflare/worker.js:40-49` | |

No secrets in frontend: PAT/token inputs are password fields sent to the server; `/api/health` exposes engine booleans only.

---

## 7. What works / what is broken / what must be preserved

**Works (VERIFIED):** view switching & responsive nav; single consolidated MCC; honest portfolio KPIs; sizing/exposure panel (#49); signal analyzer + best-pick completeness gating; PAT labelling; news/calendar/backtest UI; markets search/category/sort (`#mktSearch #mktCats #mktSort`); Pro Scalper execution-disabled; full test suite green; CI Node 22/24 + Py 3.11/3.13; PWA.

**Broken / missing vs brief:** (a) PR #42 hazard + inert `commandcentre.js` test mismatch (§3); (b) MCC lacks AI-agent status panel, news intelligence, risk warnings, recent system events, portfolio badge/timestamp, last-successful-update line; (c) no System Health view (only pills + `/api/health`); (d) no dedicated Risk Centre view (risk material is spread across trade `#sizePlan`, bridge guards, learn drawdown, pipeline risk role); (e) staging deploy is main-only (rule conflict §1.3); (f) header lacks system-health/freshness/settings access.

**Must preserve:** all localStorage keys (`aurum-proscalper-*`, settings, watchlists, history), PAT/bridge credential flows, guardrails (0.5% / 2% / 1-pos / 1.2 R:R / 80% margin), smoke must-strings, ZIP packaging flow, existing DBs/records, light theme, PWA.

---

## 8. File-level implementation plan (Phase 2 → 5 mapping)

> All work stays on `arena/a3c9e72d-shelrickteck-analysis`. No file below is touched outside this list without a plan update.

| # | Area | Files | Change (additive, read-only scope) |
|---|---|---|---|
| A | Global shell | `index.html` (CSS `:root` tokens → `#10151D/#1B2633/#D99A35/#37C98A/#E05252`, topbar: health dot + data-freshness + settings shortcut), `src/main.js` (header status wiring) | Re-skin via tokens only; keep light theme; no layout rewrite |
| B | Command Centre | `index.html` `view-overview` (section order per brief), `src/commandcentre.js` (**rework**: mount on a real anchor; own the new panels; retire the inert path), `src/main.js` `renderOverview()` | ONE MCC: status+freshness, watchlist/trend/volatility summary (existing `commandMarkets`), **AI agent panel** (reads last pipeline result, honest unavailable on staging), latest analysis (`#ovBest`), news preview (existing feed renderers), risk warnings (bridge/limit state), **Portfolio Overview pinned** (existing `pf*` + source/timestamp/REAL-DEMO-PAPER badge), recent system events (ring buffer of real status transitions + `azAddHistory` rows — no invented events) |
| C | Portfolio honesty | `src/main.js` `updatePortfolioLive()`, `index.html` MCC card | Badge from `state.broker.environment` / PAT flag; timestamp of last quote; `UNAVAILABLE` styling when unknown |
| D | Agent control room | `server/lib/pipeline/index.js` (review-first; only if a gating gap is proven), `src/main.js` `loadPipelineFlow()`, `index.html` MCC panel, `server/tests/api.test.mjs` | Surface per-agent status/last-run/freshness/errors; regression: missing/stale input ⇒ Boss never READY (no LLM-only approval) |
| E | Market scanner | `index.html` `view-markets`, `src/main.js` `renderMarkets()`, `src/hostedscan.js` | Retain search/filters/sort/timeframes; add explicit provider-error & unavailable-instrument rows (no fake quotes) |
| F | Trade view | `index.html` `view-trade` (no structural removal), `tests/smoke.mjs` | Regression asserts: Trade opens, charts/indicators mount, paper vs actual labelled; Pro Scalper audited, not modified |
| G | Risk centre | **new** `index.html #view-risk` + `src/main.js` case/nav entry (renames nothing), reusing `src/sizer.js`, bridge risk state, learn drawdown, `server/lib/riskintelligence.js` | Educational analytics only: exposure, virtual sizing, drawdown, R:R, volatility & data-quality warnings, historical risk events (from existing logs); failures stay visible |
| H | News & strategy lab | `index.html` `view-news` + `#backtestCard`, `src/newsimpact.js` | Add source/time/freshness chips where missing; label backtests as historical/paper |
| I | System health | new panel in `view-settings` (`settingsConnections` area) + MCC strip | API/feed/provider/DB/job/error checks each render only on **successful** health response; never “ONLINE” without a passing check |
| T | Tests | `tests/platform/*` (new `command-centre-upgrade.test.mjs`), `tests/smoke.mjs` | Single-MCC, nav-complete, trade-accessible, truthful agent status, no dup IDs, portfolio honesty, no order-request assertions |
| S | Staging | **new** `.github/workflows/deploy-staging-branch.yml` (workflow_dispatch on this branch, same environment secret) or merge-then-dispatch with approval (§9) | Deploy only after `npm run verify`; record deployed SHA; screenshots via puppeteer harness (`scripts/screenshot-size-plan.mjs` pattern → `scripts/screenshot-command-centre.mjs`) |

**Not touched:** `bridge/mt5_bridge.py` execution logic, `/api/deriv/order|fill|close`, automation bots, PAT engine, credentials handling, existing databases/localStorage schemas, `dist/` except via `npm run build`, both update ZIPs (refreshed only via `scripts/refresh_local_update_packages.py --refresh` if packaging is required).

---

## 9. Decisions required before implementation

1. **Staging path:** (a) add branch-triggered staging workflow using the `cloudflare-staging` environment secret (environment secret access from a non-main ref = **UNVERIFIED** until first run), or (b) approve merge-to-main then run the existing dispatch. Brief says staging without merging → default to (a).
2. **PR #42:** close it (it would blank the overview) and re-assert its “single MCC” intent in the new tests — needs your approval to close.
3. **Palette:** brief tokens (`#10151D` etc.) differ from current (`#0a0e16`/`#e0b45c`…) — confirm re-skin to exact brief values (plan assumes yes).

---

## 10. Integration / workflow status board

| Item | Status |
|---|---|
| CI (Node 22/24, Py 3.11/3.13) on `main` | **VERIFIED** (5/5 at `f0c676b`) |
| Test suite baseline (910/909/0/1, smoke 395, py 72, worker 14) | **VERIFIED** (executed) |
| Wrangler dry-run | **VERIFIED** (executed) |
| Staging deploy workflow exists (main-only) | **VERIFIED** |
| Staging deploy from feature branch | **BLOCKED** (needs §9.1 decision) |
| Live staging commit-SHA exposure | **UNVERIFIED** — plan: record workflow run SHA + add version header/endpoint in Phase 6 |
| Deriv/MT5/news provider live responses | **UNVERIFIED** from sandbox (no market-network access) — must be checked from the deployed/PC environment before any “works” claim |
| PR #42 merge safety | **FAILED** (would blank overview — do not merge) |
| Pipeline Boss gating (deep review) | **UNVERIFIED** → first task of Phase 2-D |
| Supabase / WhatsApp live operation | **UNVERIFIED** (config-dependent) |

---

## 11. Phase-5 verification checklist (pre-agreed, to run after implementation)

`npm test` · `npm run build` · `npm run test:worker` · `npm run verify:dist` · `npm run verify` · CI Node 22 + 24 · wrangler dry-run · browser checks (single MCC, portfolio pinned, Trade opens, all 14 nav destinations, charts/indicators, truthful agent status, stale/failed data marked, paper isolated, records intact, desktop/tablet/mobile, no dup IDs/console errors, **no order-placement requests**) · desktop + tablet + mobile screenshots · deployed staging SHA match.

*No production deployment and no merge to `main` will occur without explicit approval.*
