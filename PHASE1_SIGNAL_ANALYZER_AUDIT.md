# PHASE 1 — Signal Analyzer Audit (Gold + Forex + Index CFD)
**Mode:** audit first, preserve existing functionality · **Date:** 2026-11-23
**Branch for implementation:** `arena/a3c9e72d-shelrickteck-analysis` (session branch; nothing committed to `main` without approval)
**Baseline:** `main = a4d920b` (PRs #49 + #50 merged; CI 5/5 green at both merges)
**Method:** source-verified with file:line evidence; executed tests referenced only where actually run; no code modified in this phase.

---

## 1. Root causes / headline findings

The brief assumes several features must be built from scratch. **Most of them already exist — some exactly to spec.** The real work is five gaps plus verification:

1. **Determinism gap (real defect):** on the PC server, `/api/signals/analyze` goes through `makeDecision()` (`server/app.js:371`) which — when AI keys are configured and budget allows — takes `confidence` from **LLM engine output** (single engine, or the *mean* of engine confidences in `mergeEngineResults`, `server/lib/decision.js:282-301`). Only `technicalOnly` (Gold monitor), budget-exceeded, no-keys and engine-error paths use the deterministic `localDecision()`. The brief’s “deterministic confluence score” is therefore **not guaranteed** on the analyzer path today.
2. **Historical figures are hard-coded** in `src/measured.js` (`MEASURED` frozen table: XAU/USD `39.6 / 76,694`). The module header states they “do not update by themselves.” The brief explicitly forbids hard-coding percentages/sample sizes and requires validating the gold figure **before** displaying it as verified. The replay engine exists, but **the historical CSV data does not exist in this repository or sandbox** (`find *.csv` → none; no `data/` dir), so re-validation is **BLOCKED until a data source is provided**.
3. **No score-calculation breakdown is displayed** — the analyzer shows a bare confidence number (`#azConf`), not the T/B/C components the brief requires.
4. **The analyzer result is not wired into live tracking** — `signalRuns.observe()` is called only for scan results (`src/main.js:1653`) and the Gold monitor (`:4728`); a manual `azAnalyze()` reading gets no “original reading / live movement / distance” panel (the tracker itself is fully built and tested).
5. **“Use setup in ticket” still hands levels to the broker ticket** (`azUseSetup()` `src/main.js:4062` fills `#orderSL/#orderTP` and `goto('trade')`; also `sig-use` buttons `:1423`) — the brief requires an explicitly labelled educational paper-trading scenario interface *inside the Signal Analyzer*.

Everything else in sections 1–5 of the brief is **already implemented and largely tested** — details below.

---

## 2. What already exists (spec → code map)

### 2.1 Instrument support — **VERIFIED**
- `server/lib/symbols.js` is the single instrument registry: **Gold** `{s:'XAU/USD', d:2, deriv:'frxXAUUSD'}` (:31) with input aliases `XAUUSD…` (:71); **indices** `US30, NAS100, SPX500 (=US500), GER40` (:40-44); majors + metals + crypto. Client `INSTRUMENTS` imported at `src/main.js:9`.
- Gold is first-class: dedicated view (`GOLD_SYMBOL='XAU/USD'` `:4401`), dedicated technical-only API route (`technicalOnly` restricted to XAU/USD, `server/app.js:291`), MT5 symbol-mapping ambiguity guard (`:4510` — refuses to guess between XAUUSD variants), precision via `bySym[...].d`.
- `#azSymbol` lists **all** `INSTRUMENTS` (`src/main.js:3862`) — gold present; “prominently displayed” is a UI polish item (§7).

### 2.2 Multi-timeframe cadence — **VERIFIED (implemented + tested)**
- 1m/5m/1h completed candles only: `src/closedcandles.js` + `closedCandleSets()`; readings name their `candle_close`; `candle_current` flag; pause/resume → HTTP **409** with no reading (`server/app.js:360-367`); same-5-minute dedupe enforced server-side (5-minute analysis cache + closed-candle rule) and client-side.
- Tests: `tests/platform/closed-candles.test.mjs` — *“the same reading whenever it is made before the next 5-minute close”* (:127), forming-candle exclusion (:99), hour boundaries (:89/:119), pause rule (:124 in replay tests), etc. This is exactly brief §2.

### 2.3 Score formulas — **FOREX/GOLD ALREADY EXACT; INDEX FORMULA = EXISTING Q**
`server/lib/localdecision.js:74-76`:
```js
let confidence = 15 + valid.length * 7 + Math.min(Math.abs(avgBias), 5) * 5 + (confirmed ? 20 : 0);
if (signal === 'WAIT') confidence = Math.min(confidence, 45);
confidence = Math.round(clamp(confidence, 5, 93));
```
= `min(93, 15 + 7·T + 5·|B| + 20·C)` with WAIT cap **45** — identical to brief §3. Documented independently in `src/bestpick.js:9-11`.

**Normalization of B (to publish in UI):**
- Per timeframe, `analyzer.js` produces `biasScore ∈ [−5, +5]` (±1 each: price vs EMA20, price vs EMA50, MACD histogram sign, RSI zone, trend class) — `server/lib/analyzer.js:33-58`.
- `avgBias` = mean of `biasScore` over the valid timeframes → `∈ [−5, +5]`.
- **B = min(|avgBias|, 5) ∈ [0, 5]** (the clamp makes the term `5·B ∈ [0,25]`).
- **T** = count of valid timeframes (currently ≤3; brief says max 5 → add explicit `min(T,5)` hardening).
- **C = 1** iff `mtfSignal ∈ {BUY_CONFIRMED, SELL_CONFIRMED}` **and** valid ≥ 2 (2-of-3 confirmation).
- Floor: current clamp is `(5, 93)` — stricter than the brief’s “never below zero”; retained (any change would be a weakening, so none).

**Index CFD score (Q):** `server/lib/indices.js:41-86` `indexDailySignal()` computes **Q = `context_score`**, the net of **5 symmetric votes** (above SMA20, above SMA50, SMA50>SMA20 (or SMA20>SMA50), 20-day momentum, RSI14 zone; each ±1, momentum/RSI may be 0) → **Q ∈ [−5, +5]**. The documented display formula is `min(90, 50 + 8·|Q|)` (`src/bestpick.js:11`, `DAILY_TREND_NOTE` `src/main.js:1290`) → 50…90; daily BUY/SELL context requires |Q|≥3 → 74/82/90. **Defect found:** the computation site of `50+8·|Q|` was not located in `src/` — daily cards display `d.confidence` (`main.js:1314`) which the server/worker set to **`null`** (`server/app.js:546`, `cloudflare/worker.js:384`) → possible `0%`/missing display. Phase 2 must pin and repair this path (context-only, never tradeable — `CONTEXT_ONLY` strip already enforced by `bestpick.js:49-60`).

### 2.4 Dynamic signal tracking — **ALREADY EXACT (implemented + tested)**
`src/signalrun.js`:
- `AGAINST_POINTS = 30`, `WITH_POINTS = 15` (:16,:19) — exactly brief §4.
- First-read `entry/stop_loss/tp1` preserved for the whole run; later same-direction analyses update only the base score (:150-160).
- Direction-aware proportional adjustment `liveConfidence()` (:74-95); clamp `5..93` (never negative, never above cap); states `with/against/flat/stop/target/none`.
- **Termination** on stop or TP1, including a crossing between two looks (:168-171, :193 test); fresh run only from the next eligible analysis.
- **Units:** `moveUnit()` — forex **pips** (0.0001 / 0.01 JPY), **gold & other USD quotes → USD distance** (`"$2.79"`), else points (:26-43) — brief §4 gold-dollar requirement already satisfied.
- **Daily readings without levels:** no run, no movement (`NO_LEVELS_NOTE`); their score changes only when the daily reading itself changes (once per daily bar) ✓.
- **Provider isolation inside tracking:** `feedOfReading` (`technical-exness` → `exness` vs Deriv stream) — a Deriv tick never moves an Exness reading’s score; cross-venue prices are ignored and the run reports its own venue’s latest analysis price with `sampledAt` (:169-180, `src/main.js:117-120`).
- Tests: `tests/platform/signal-run.test.mjs` — **14 tests** covering −30/+15 proportions, mirror SELL, scale bounds, first-read preservation, flip/WAIT/error ending, stop/target permanence, cross-feed keys, unit formatting (pips vs gold dollars).

### 2.5 Provider & price integrity — **VERIFIED (with one labelling caveat)**
- Supplied candles must declare `dataSource === 'Exness MT5 local candles'` or the server returns **400 `invalid_candle_source`** (`server/app.js:318-321`); Exness sets are validated (`cleanSuppliedCandleSets`) and labelled `data_source` on every response.
- Cloudflare-hosted mode keeps Exness candles **inside the browser** and never POSTs them to the Worker (`src/main.js:3874-3881`).
- Unlabelled provider fallback exists only when no candles are supplied: `dataSource='Deriv public candles'` (`app.js:316,329`) — it is **labelled in the response and shown in `#azMtf`**, but the brief says never *silently* switch: Phase 2 will make the fallback explicit in UI copy (and for Exness-context requests, prefer UNAVAILABLE over silent Deriv substitution — decision §9).
- Stale/paused/missing: `waitReason` STALE_DATA, 409 resumed, `withheldReading`, per-card candle-close timestamps (`closeText`), `feedText/derivPill/mt5Status` freshness pills.

### 2.6 Replay engine — **EXISTS; needs driver + validation run (BLOCKED on data)**
- `scripts/replay-rule.mjs`: replays the app’s **own** `analyzer.js + localdecision.js + closedcandles.js` over historical **1-minute CSV bars** (dir supplied via `--data`; **not in repo**), `--timing close|minute`, `--spread`, `--by-year`; follows each alert to stop/TP1 (stop wins when both in one bar); runs opposite-direction + seeded-coin **controls**; score buckets; span-limited counting; explicit “cannot tell fills/slippage/future” disclaimer.
- Tests: `tests/platform/replay-rule.test.mjs` — 8 tests incl. **no-look-ahead** (:64), shipped timing (:82), pause rule (:124), controls (:156).
- Display layer: `src/measured.js` (`measuredText/measuredLine`, break-even 40%, “Not a forecast”) used by scan/gold/sniper/signals — but its `MEASURED` table is the hard-coded artifact (root cause #2).
- README §“What a replay of the rule measured” documents methodology + full result tables (gold 39.6%/76,694; nine other markets; year-by-year; score bands; controls; cost math).

### 2.7 Interface inventory (what the upgrade builds on)
`view-signals` (`index.html:1294-1541`): symbol selector, Analyze, result card (`#azSignal #azConf #azEntry #azSl #azTp1 #azTp2 #azRrr #azMtf #azSignalTiming …`), **`#azUse` “Use setup in ticket”**, `#azWhy`, session history `#azHistBody`, analysis-history bridge (`azAddHistory` → Settings), `#backtestCard` (`#btRun`), setups check (`#suRun`), FX analyst row (`#fxaAnalyze`), six-role pipeline panel (`loadPipelineFlow`), AI budget pill. Smoke asserts: `#azUse` → trade view (`tests/smoke.mjs:331`).

---

## 3. Gaps to implement (file-level plan)

| # | Brief § | Change | Files |
|---|---|---|---|
| G1 | 3, 7 | **Deterministic score always:** compute displayed `confidence` via `localDecision()` formula on every path (LLM engines may keep providing rationale/levels *only if* they do not overwrite the confluence score — or keep LLM decision but override `confidence` with the deterministic value + breakdown; preferred: override, label engines separately) | `server/lib/decision.js` (`mergeEngineResults`), `server/app.js` (analyze route), tests `server/tests/api.test.mjs` |
| G2 | 3 | **Score breakdown UI:** show `T`, `B` (with normalization text), `C`, WAIT-cap note, formula string, “setup quality — not probability of profit” | `index.html` (`#azResult` new breakdown block), `src/main.js` (az render), `tests/smoke.mjs` |
| G3 | 4 | **Wire analyzer reading into `signalRuns`** + live-movement panel in `#azResult`: original reading timestamp, original reference price, current verified price, distance to stop/TP1 (gold = `$`), adjustment breakdown (−30…+15), reading status | `src/main.js` (`azAnalyze`/az render), reuse `src/signalrun.js` unchanged, `tests/platform/signal-run.test.mjs` (integration case) |
| G4 | 7 | **Paper-trading scenario interface:** replace `#azUse`/`sig-use` ticket hand-off *inside the analyzer* with a labelled **VIRTUAL scenario** card (side, entry/SL/TP1 from the reading, hypothetical P/L at current price, VIRTUAL badge, isolated `localStorage` key `aurum-az-paper-v1`, no broker calls). Trade view’s existing manual ticket is untouched (out of analyzer scope) | `index.html`, `src/main.js` (`azUseSetup` → scenario), `tests/smoke.mjs:331` re-assert, new platform test |
| G5 | 6 | **Generated, not hard-coded, historical figures:** replay driver `scripts/replay-markets.mjs` runs `replay-rule.mjs` per market (gold, each forex, each index) from CSV dirs → writes `src/measured.generated.json` (percent, alerts, span, timing, score bands, OOS split, CI, spread+slippage assumptions); `src/measured.js` loads generated file when present & **validated**, otherwise shows “not measured / UNVERIFIED — replay data not available”, never the frozen numbers | NEW `scripts/replay-markets.mjs`, `src/measured.generated.json` (build artifact), `src/measured.js`, `tests/platform/measured.test.mjs` |
| G6 | 6 | **Validation run of gold 39.6%/76,694:** execute `node scripts/replay-rule.mjs --data <XAUUSD1m CSV dir> --symbol XAU/USD --from 2020-01-01 --to 2026-11-30 --spread0.25 --by-year` and compare to README/measured claims; display gated on this run | BLOCKED — needs historical CSVs (§5) |
| G7 | 6 | Replay output extensions: out-of-sample split, Wilson/binomial CIs, slippage parameter (per-side), explicit sample-size fields; keep controls | `scripts/replay-rule.mjs`, replay tests |
| G8 | 3 | Index score path: pin `50+8·|Q|` computation, fix daily `confidence:null` display, keep `CONTEXT_ONLY` strip | `src/bestpick.js`, `src/main.js:1314` area, `server/lib/indices.js` (no behavior change to votes), tests |
| G9 | 7 | Instrument selector: gold first (pinned option/optgroup), categories (Gold / Forex / Index CFD / other) | `index.html`, `src/main.js:3861` |
| G10 | 7 | Historical performance panel in analyzer: per-market measured table from generated file, labelled “past observations, not forecasts”, sample sizes + CIs | `index.html`, `src/main.js`, `src/measured.js` |
| G11 | 2,5 | Copy hardening: provider/freshness line on `#azResult` (source, candle-close time, age), explicit UNAVAILABLE/STALE states; silent-fallback wording fix | `src/main.js` (az render), smoke |
| G12 | 8 | New tests: formula boundaries (T clamp to 5, WAIT 45, cap 93, rounding, invalid ATR→15), index formula `min(90,50+8|Q|)`, provider-isolation400 (`invalid_candle_source`), stale/missing data, gold `formatMove` `$` (exists — keep), replay determinism (same input → same output), duplicate-5m (exists — keep), dynamic adjustments (exist — keep), paper-scenario isolation | `server/tests/localdecision.test.mjs` (currently 1 test — expand), `server/tests/api.test.mjs`, `tests/platform/*`, `tests/smoke.mjs` |

**Explicitly not touched:** `bridge/mt5_bridge.py`, `/api/deriv/order|fill|close`, trade-view ticket, PAT engine, bots, credentials, existing history/settings keys (new paper key is additive), risk caps (0.5% / 1.25 buffer), `signalrun.js` math constants (already exact).

---

## 4. Test & verification plan (Phase 5)

Run exactly: `npm test` · `npm run build` · `npm run test:worker` · `npm run verify:dist` · `npm run verify` · CI Node 22 + 24 · wrangler dry-run · desktop/mobile screenshots (extend `scripts/screenshot-size-plan.mjs` pattern → `scripts/screenshot-signal-analyzer.mjs`).
Baseline at `a4d920b`: **910 tests / 909 pass / 0 fail / 1 skip** (smoke 395), Python 72, worker 14 — all executed previously; will be re-run after changes.
Preserve smoke must-strings; `#azUse` assertion is updated to the paper-scenario flow (documented in the PR).

---

## 5. Data availability for replay validation — **BLOCKED**

| Need | Status |
|---|---|
| Replay engine | **VERIFIED** (code + 8 tests) |
| Historical 1m CSVs (gold Jan2020–Nov2026 ≈ 76,694 alerts’ worth of bars; fx/index Mar–Sep 2026) | **BLOCKED** — not in repo; sandbox has no market-data network access |
| Options to unblock | (a) you provide the CSV directories used for the README run (bridge/MT5 export), (b) run `scripts/replay-markets.mjs` on your PC and commit only the generated JSON, (c) approve displaying the existing figures *labelled as “Nov 2026 replay, re-validation pending”* until (a)/(b) finish |

Until validated, `measured` figures will not be presented as **verified** (brief §6).

---

## 6. Status board (per brief’s required labels)

| Item | Status |
|---|---|
| Gold symbol resolution / precision / MT5 mapping | **VERIFIED** (`symbols.js`, `main.js:4510`, tests) |
|1m/5m/1h completed-candle cadence + duplicate prevention | **VERIFIED** (closed-candles tests) |
| Forex/gold score formula = spec | **VERIFIED** (`localdecision.js:74-76`) |
| Index Q formula + `50+8` display path | **PARTIAL — FAILED display path** (confidence null; computation site unpinned) |
| Dynamic tracking −30/+15, termination, gold USD units | **VERIFIED** (`signalrun.js` + 14 tests) |
| Provider isolation (server400 + feed tracking + cloud in-browser) | **VERIFIED**; silent-fallback wording **UNVERIFIED in UI** |
| Deterministic score when AI keys configured | **FAILED** (LLM confidence path) |
| Replay engine reproducibility | **VERIFIED** (tests incl. no-look-ahead) |
| Gold39.6% re-validation | **BLOCKED** (no data) |
| Hard-coded `MEASURED` table vs brief | **FAILED** (by design today) |
| Paper-scenario in analyzer | **FAILED** (ticket hand-off exists) |
| Live movement inside `#azResult` | **FAILED** (tracker unused there) |
| Staging deploy from branch | **BLOCKED** (workflow main-only — same §9 decision as Command Centre audit) |
| Existing functionality preservation | smoke/platform suites green at baseline |

---

## 7. Decisions needed before implementation

1. **Replay data:** which option in §5 (a/b/c)? Without it, historical panel ships as UNVERIFIED.
2. **LLM rationale:** keep AI engines for rationale/levels with the deterministic score overriding `confidence` (recommended), or force `technicalOnly`-style determinism on the analyzer (AI keys then unused there)?
3. **Silent Deriv fallback:** on PC requests lacking Exness candles — show UNAVAILABLE (strict, recommended for Exness-context) or keep labelled Deriv fallback?
4. **Staging:** same open question as Command Centre audit — add branch staging workflow, or merge-then-dispatch with your approval?

*No production merge, no deploy, no broker-order code without explicit approval.*
