# GOLD MARKET STRENGTH METER + TRADINGVIEW SOURCE CONSISTENCY — Inspection Findings & Implementation Plan
**Phase:** inspect & plan only — no code modified · **Date:** 2026-11-24
**Branch for implementation:** `arena/a3c9e72d-shelrickteck-analysis` (session feature branch; no auto-merge, no deploy)

---

## 1. Repository baseline (executed this pass)

| Item | Value |
|---|---|
| HEAD = `origin/main` | `dddec46` (PR #53 merge), tree clean except prior plan deliverable `NEXUS_ARCHITECTURE_AND_PLAN.md` (untracked, unrelated), **0 open PRs** from this branch |
| Tests (just run) | `npm test` → smoke **400 PASS / ALL GOOD**; node **921 tests, 920 pass, 0 fail, 1 skipped** |
| Prior executed evidence (this session) | worker 14/14 · Python bridge 72/72 + CI green · `verify:dist` OK · `npm audit` 0 |

---

## 2. Files inspected (key findings)

| File:lines | Finding |
|---|---|
| `src/tradingview.js` (whole file) | TradingView integration = **official embedded iframe widget** (`widgetembed` endpoint, symbol mapped via `TV_MAP` in `server/lib/symbols.js`). Comment header confirms “official widgets, free, no key”, honest notice when no mapping. |
| grep `datafeed\|UDF\|charting_library\|lightweight` across `src/ server/ index.html` | **ZERO hits** — no authorised Advanced Charts datafeed, no Lightweight Charts, no UDF endpoint exists. |
| `server/app.js:291` (`POST /api/signals/analyze`) | Fetches **Deriv M1/M5/H1 candles** (60s cache), runs `closedCandleSets` (finished candles only) + `runDeterministicAnalysis`. Response: `signal, mtf_signal, votes, entry/stop_loss/tp1/tp2, rationale/technical_summary, risks, data_source, latest_candle_time, candle_close, updatedAt, meta`. |
| `server/lib/analyzer.js` | `analyzeTimeframe` already computes per timeframe: `trend, signal, biasScore, indicators{rsi, macd{line,signal,histogram}, bb, ema20, ema50, ema200, atr}, levels{support[],resistance[]}, fib, candles(last 20 closed)`. `votesSummary` → `"M1 +2 BUY · M5 0 WAIT · H1 +3 BUY"`. `runDeterministicAnalysis` runs m1/m5/h1. |
| `server/lib/indicators.js` | `sma/ema/rsi/macd/bollingerBands/atr/findLevels` — all math the brief requires. |
| `src/main.js:19-33` | **Precedent: the client already imports server libs directly** (`../server/lib/analyzer.js`, `localdecision.js`, `./closedcandles.js`) — one shared pipeline is the existing architecture, not a new invention. |
| `src/main.js:4619-4646` (`renderGoldAnalysis`) | Technical Signal card renders: badge/signal, `#goldVotes` (M1/M5/H1 + mtf + data_source), `#goldSignalUpdated` (close-aware timestamps), entry/SL/TPs, `#goldPressure` (vote tally), `#goldRationale`, `#goldRisks`. |
| `src/main.js:4660+` (`goldAnalysisNoticeText`) | Gold data status already shows verified source, last-success age, cadence, MT5→Deriv **labelled fallback** (never silent). |
| `index.html:1108-1113` | `#brokerMarketSource` = **All sources / Deriv / Exness / MT5** (broker catalogue filter, markets view) — honest provider names, no TradingView option. |
| `index.html:1272` `#msSym` | Labelled **“Market”** — it is the *Market State instrument picker* (scrollable JS-built symbol list), not a data-source selector. |
| grep `<option>…Market/York/London/Asian/Session…` in `index.html` | **No native option anywhere reads “TradingView Market” or “New York Market”.** |
| Session strings `src/main.js:1764-1772` | “London · ~10–19 EAT”, “LDN/NY · ~16–20 EAT” — **market-session classification** (markethours), displayed text, never a provider. |
| Watchlist `src/main.js:231/247` | Chips titled “TradingView (may be delayed)” for index tiles — honest display-source labelling already present. |
| `index.html` gold controls | `#goldSourceSelect` (EXNESS/DERIV chart-candles source), `#goldAutoRefresh`, `#goldAnalyzeNow`, `#goldShare` — all to be preserved. |

---

## 3. PART C — Source selector audit (findings)

**The reported “TradingView Market / New York Market” selector does not exist as a native control in this codebase.** Verified candidates for what was seen, in likelihood order:

| # | Actual component | What it is | Verdict |
|---|---|---|---|
| 1 | **TradingView widget’s own toolbar** (iframe UI on Trade/Gold charts, news & calendar widgets) | TradingView’s embedded UI — includes its own market/timezone/session controls | Third-party UI; **cannot be relabelled by us** → we add OUR provenance caption beside it (Part D/E) |
| 2 | `#msSym` — “**Market**” select (Market State view) | Scrollable instrument picker (`msMarkets()`), auto-classifies session per instrument | Mislabelled word “Market” = instrument; rename label to **Instrument** (clarity fix) |
| 3 | `#brokerMarketSource` (Markets view) | Provider filter: Deriv / Exness-MT5 | Correct already; add descriptions |
| 4 | Session strings near MCC outlook / Market State | **New York / London session = time classification**, shown as text | Not a source; will be labelled “MARKET SESSION” explicitly (Part E) |

**Provider map (actual, evidence-based):**

| Data role | Actual provider | Where |
|---|---|---|
| Chart candles (display) | **TradingView widget** (iframe, TV-hosted) | `src/tradingview.js` |
| Chart candles (gold native monitor chart) | **Exness/MT5 or Deriv** (explicit `#goldSourceSelect`) | `goldRefreshChart` `main.js:4576+` |
| Live prices (ticks) | **Deriv** WS ticks (`derivtickfeed`), Exness quotes for gold when MT5 connected | pills `#mt5Feed/#derivFeed` |
| Prices (index scan) | **Yahoo** hostedscan | `hostedscan.js` |
| Technical indicators + structure + AI analysis | **Deriv/Exness closed candles** via `server/lib/analyzer.js` (M1/M5/H1) | `/api/signals/analyze` |
| News/calendar | **Investing.com RSS** (feed) + TradingView news/calendar **widgets** (display) | `server/lib/news.js`, `tv.mountNews/Calendar` |
| Market session | **markethours** (local clock rules) | `server/lib/market.js` |

**Silent mixing?** One real mix exists and is *partially* disclosed: charts display TradingView data while analysis runs on Deriv/Exness candles. Prices, indicators, structure and AI never come from TradingView. Watchlist and gold chart already disclose; **Command Centre does not** → fixed in M3/M4.

---

## 4. PART D — TradingView consistency determination

**Finding: the project uses an embedded TradingView *widget* (iframe `widgetembed`), not Advanced Charts, not Lightweight Charts, no datafeed/UDF, no authorised market-data integration.**

Therefore, per the brief’s rules:
- **No authorised TradingView data feed is available** → limitation reported; **no scraping, no private APIs, no reverse engineering**.
- Existing verified providers retained and **accurately labelled**; TradingView labelled as **“chart display (TradingView widget)”** everywhere it appears.
- All calculations keep using the identified dataset: **Deriv/Exness closed candles** (already consistent M1/M5/H1, single `analyzeTimeframe` pipeline).
- **Source-consistency indicator** (new, deterministic):
  ```
  DATA SOURCE:        Deriv closed candles (MT5/Exness when connected on Gold)
  SOURCE STATUS:      CONNECTED / DEGRADED / UNAVAILABLE   (from existing feed checks — measured, not guessed)
  LAST UPDATE:        <latest candle/tick timestamp>
  DATA AGE:          <measured seconds>
  ANALYSIS SOURCE:    server/lib/analyzer.js (M1/M5/H1 closed candles)
  CHART DISPLAY:      TradingView widget (display only — not used for calculations)
  ```
  Placed on Gold monitor + Command Centre; UNKNOWN shown when a value cannot be verified.

---

## 5. PART A — Market Strength Meter: calculation methodology (deterministic, testable)

**New pure module `server/lib/strength.js`** — imported by `server/app.js` (adds `strength` to `/api/signals/analyze`) **and** by `src/main.js` for the client-side fallback path (same shared-pipeline pattern as `analyzer.js`). Inputs: the **same closed candle sets** already fetched (no new network calls). Uses `indicators.js` (EMA/RSI/MACD/ATR/findLevels) + a small new swing-structure helper.

**Step 1 — per timeframe T ∈ {M1, M5, H1} (closed candles only; incomplete candle never included — `closedCandleSets` already guarantees this):**

| Bucket | Rules (points) | Max |
|---|---|---|
| TREND | price vs EMA20 (±1) · EMA20 vs EMA50 position (±1) · EMA50 vs EMA200 (±1, **skipped** if EMA200 null → max 3) · EMA20 slope over last 5 closes (±1) | 4 |
| MOMENTUM | RSI14 zone >55 / <45 / else neutral (±1/0) · MACD line vs signal (±1) · histogram sign & rising/falling (±1/0) | 3 |
| STRUCTURE | last two swing highs: HH (+1 bull) / LH (+1 bear) / flat neutral · last two swing lows: HL (+1 bull) / LL (+1 bear) · close beyond recent key level from `findLevels` (±1/0) | 3 |
| VOLATILITY | ATR vs its 20-period mean: expansion (+1 **to the current trend direction only**), compression/normal (0 — volatility alone never creates direction) | 1 |

- Points are tallied as **bull / bear / neutral** (neutral = bucket outcomes that fired neither side, plus skipped buckets excluded from the denominator).
- Timeframe share = `(bull, bear, neutral) / (bull+bear+neutral)` — sums to 1; if denominator 0 → timeframe **invalid** (contributes nothing; flagged).

**Step 2 — aggregation:** weighted mean of valid timeframe shares — **M1 20% · M5 30% · H1 50%** (documented rationale: higher timeframe structure dominates). Renormalise over valid timeframes only.

**Step 3 — rounding:** scale to 100 with **largest-remainder method** → `buying + selling + neutral ≡ 100` exactly (unit-tested).

**Step 4 — trust gates (never manufacture):**
- Zero valid timeframes, or candles missing/stale (existing `STALE_DATA`/`INSUFFICIENT_CANDLES` checks), or no confirmed (closed) candle → **INSUFFICIENT DATA** state: bars replaced with reason + timestamp, no numbers.
- Exactly one valid timeframe → bars shown **with an explicit badge** “based on M5 only”.
- Missing RSI/MACD/EMA200 individually → those rules skipped and the denominator shrinks (no fake zeros); methodology panel lists what was skipped.

**Step 5 — classification (thresholds documented + tested):** dominant buying = buy ≥50% ∧ buy−sell ≥20 · moderate buying = buy > sell+10 · balanced = all pairs within ±10 · moderate/dominant selling mirrored · else insufficient. **The WAIT signal stays fully independent** — a dominant bar never changes `signal`.

**Explainability:** expandable `<details>` — methodology, per-indicator contributing/contradicting evidence lists, skipped items, `computedAt`, latest closed candle time per timeframe, weights used.

**UI (Part A + B):** new `GOLD MARKET STRENGTH` block directly under the Technical Signal header — three horizontal bars (green/red/grey-amber), label + large % + progress bar + evidence line + timeframe + last-calc timestamp; animated width only (restrained, `prefers-reduced-motion` respected). Technical Signal card extended with: current state, three strengths, M1/M5/H1 trend lines, overall alignment (from `mtf_signal`), data source, freshness, calculation time; multi-timeframe summary block `M1/M5/H1 → OVERALL` with supporting vs contradicting lists — all fields already exist on `state.goldAnalysis` (`trend/mtf_signal/votes/data_source/updatedAt/latest_candle_time`).

---

## 6. PART E — Selector / labelling actions

1. `#msSym` label “Market” → **“Instrument”** (it never selected a provider).
2. `#brokerMarketSource` — add per-option descriptions (Deriv = synthetic/public feed; Exness/MT5 = your connected PC bridge; catalogue filter only, not a chart/analysis switch).
3. MCC gains two separate read-only chips: **MARKET DATA SOURCE** (actual provider + status + age) and **MARKET SESSION** (markethours classification: Asian/London/New York/overlap) — session never presented as a source.
4. TradingView widget caption beside charts: “Chart display: TradingView widget — calculations use Deriv/Exness closed candles”.
5. Gold source selector keeps its explicit EXNESS/DERIV behaviour (already correct, tested by existing goldsource tests).

---

## 7. PART F — Shared analysis pipeline (scoped honestly)

- **Now (this PR):** `server/lib/strength.js` (pure, shared app+browser) + provenance registry `src/provenance.js` (single map: source id → display name, status fn, freshness) consumed by the strength block, the source-consistency indicator, MCC caption, and `#msSym`/broker captions. Record shape `{instrument, source, timestamp, timeframe, ohlcv?, freshness, validation}` used by strength inputs (documented in module header).
- **Explicitly deferred (reported, not silently skipped):** migrating *every* legacy panel (news, learn, portfolio…) onto the provenance registry — listed in the final report as follow-up; no panel currently shows an unlabelled cross-provider price *for analysis* (audit above), so the disclosure risk is covered by captions now.

---

## 8. PART G — Test matrix (to be executed, not assumed)

| Area | File | Cases |
|---|---|---|
| Strength engine (node) | **new** `tests/platform/strength.test.mjs` | strong bullish series · strong bearish · neutral/chop · mixed indicators · missing RSI · missing MACD · missing candles → INSUFFICIENT · stale → INSUFFICIENT · incomplete (forming) candle excluded · zero/invalid values (NaN/0/neg) · normalisation sums to 1 · rounding totals exactly 100 (property loop) · EMA200-null denominator · single-timeframe badge · WAIT independence |
| Data source (platform) | **new** `tests/platform/sourceconsistency.test.mjs` | source indicator strings truthful · no silent fallback (existing labelled-fallback asserted) · session chip ≠ provider · instrument mapping (`TV_MAP` missing symbol → honest notice) · freshness/age maths · MCC regression: existing `command-centre.test.mjs` stays green |
| Regression (existing) | `npm test` (smoke 400 + node suite), `npm run test:worker` | must stay green after each milestone |

---

## 9. PART H — Visual verification (during implementation)

- **Before** screenshots (captured before first edit): Gold Signal Monitor, Command Centre, mobile 390×844 (puppeteer harness pattern from `scripts/screenshot-size-plan.mjs`; re-install `puppeteer-core --no-save` + reuse `/tmp/al2023` chromium if present).
- **After** screenshots at same sizes: bars render, % readable and summing 100, INSUFFICIENT state visible when feed killed, source labels accurate, no misleading LIVE, single Command Centre, **console error capture asserted empty**, mobile no horizontal overflow.

---

## 10. Implementation milestones (incremental, reversible)

| M | Deliverable | Files | Risk |
|---|---|---|---|
| M0 | Baseline (done) + **before** screenshots | — | none |
| M1 | Strength engine + 15-case unit tests (pure, unwired) | `server/lib/strength.js` (new), `tests/platform/strength.test.mjs` (new) | low |
| M2 | Wire into analyze response + client fallback; Gold UI: strength bars, methodology details, Part B card fields, MTF summary | `server/app.js` (response field only), `src/main.js` (gold render), `index.html` (markup) | medium |
| M3 | Source-consistency indicator + session/source chips + selector labels/captions | `src/provenance.js` (new), `index.html`, `src/main.js` (MCC header) | low |
| M4 | Source tests + captions on MCC overview + regression sweep | `tests/platform/sourceconsistency.test.mjs` (new) | low |
| M5 | Full QA: `npm test`, build, worker, verify:dist, ZIP refresh, **after** screenshots, console check, final report (Part J), PR | `dist/`, ZIPs, notes | low |

**Untouched:** execution/order features, PAT engine, risk caps, credentials, TV widget internals, provider selection logic (only labels), databases.

---

## 11. Rollback

Single feature-branch PR; all changes additive (new modules + appended markup/fields). Revert = close PR unmerged, or revert merge commit; `LOCAL_UPDATE_NOTES.txt` entry documents the switch-off (hide strength block via one `hidden` class if needed).

---

## 12. Status & approval

- Inspection complete; selector/TV/provider audit executed with file:line evidence — **findings above VERIFIED**.
- Baseline tests executed this pass — **VERIFIED** (400 ALL GOOD; 920/0/1).
- **No code modified.** Nothing merged or deployed.

**Awaiting approval to start M0(before screenshots)→M1.** Suggested reply: *“approve — start implementation”* (methodology weights M1 20 / M5 30 / H1 50 and the M3 provenance scope can be overridden before I begin).
