# Signal Engine Audit — Findings and Evidence

## Status

**Not ready for merge or release.** This audit made isolated signal-engine changes on the active branch and retained the other workspace edits. No production deployment, merge, or live-market test was performed. Node 22/24 builds and Cloudflare deployment dry-runs completed successfully; the full automated test suite is not green, and several requested market/execution proofs remain open.

## Changes made

- `server/lib/patterns.js` — added `confirmedClosedCandles()`. It validates strictly increasing timestamps and OHLC geometry (and volume when present) and excludes the newest candle unless a later candle proves the interval ended.
- `server/app.js` — `/api/patterns/analyze` now fetches one look-ahead bar, analyzes only proven-closed candles, returns the requested number of completed bars, and labels `candle_close_confirmed`.
- `server/lib/analyzer.js` — timeframe analysis now abstains on unordered/corrupt OHLC or invalid supplied volume, and checks finite EMA20/EMA50, RSI range, MACD, ATR, and Bollinger ordering before a timeframe may vote.
- `server/lib/decision.js` — an AI BUY/SELL must agree with the independently computed deterministic MTF decision; otherwise the result fails closed to WAIT. AI levels must have directional geometry and at least 1.5:1 TP1 RR; rejected plans fall back to deterministic levels. RR is recomputed, and `decision_validation` records agreement, plan acceptance, and rejection reasons.
- Daily index display hardening: `server/lib/indices.js` rejects corrupt/unordered Yahoo candles and invalid indicator outputs; daily trend is emitted as `CONTEXT_ONLY`/`WAIT` with a separate `context_signal`, `confidence: null`, and null levels. `server/app.js` and `cloudflare/worker.js` preserve that contract.
- `src/bestpick.js` and `src/hostedscan.js` normalize legacy daily BUY/SELL records with missing/zero levels to context-only and exclude them from directional picks. `src/main.js` shows explicit unavailable labels, hides the confidence bar, and disables “Use setup” for these cards. The best-pick daily line shows date and trend context, not a trade signal or percentage.
- Regression tests added/extended in `server/tests/{analyzer,api,cloudflare-worker,decision,indices,patterns-api,patterns}.test.mjs` and `tests/platform/{best-pick,hosted-markets,hosted-scan}.test.mjs`.

## Confirmed behavior and defects

### Fixed in this patch

1. **Pattern endpoint used uncontracted latest bars.** `/api/patterns/analyze` previously passed every feed candle into detection, including a latest candle that could still be forming. The route now supplies only candles confirmed by a later bar.
2. **Analyzer trusted input arrays too far.** Timeframe analysis now refuses malformed/unordered OHLC and bad supplied volume; indicator outputs are screened before contributing a vote.
3. **AI could override MTF direction.** Previously `sanitizeDecision()` accepted a model BUY/SELL even when deterministic analysis returned WAIT or the opposite side. It now requires independent MTF agreement and fails closed on disagreement.
4. **AI RR was recalculated but its geometry was not constrained there.** Directional plan ordering and minimum 1.5:1 TP1 RR are now checked before accepting model levels; RR remains recomputed from entry/SL/TP1. ASTER remains the separate, stricter publication gate.
5. **Daily index trend had been treated like a trade direction despite having no risk plan.** Yahoo daily analysis now reports context-only WAIT, no trade-confidence number, and null levels. Frontend normalization also protects against legacy/stale `BUY 74%` objects with zero or absent fields; cards render “Unavailable” and cannot populate the order ticket. Best-pick context is shown separately from live setups.
6. **Yahoo daily input and indicator outputs were insufficiently validated.** Malformed/nonpositive/unordered OHLC bars and missing/nonfinite indicator results now fail closed; unknown volume stays null instead of becoming zero.

### Verified architectural safeguards

- The main signal route runs on finished M1/M5/H1 reading sets; ASTER additionally evaluates D1/H4/H1/M15 evidence.
- ASTER is fail-closed when evidence is missing and reports `executionAuthorized: false`. The server records structured `aster.validation` checks and only marks ASTER-publishable rows active.
- There is **no code path from signal analysis directly to a broker order** in the inspected routes. The Deriv order/risk endpoints are separately user-driven and do not consume an analysis ID or ASTER approval capability. This means the current signal engine does not auto-execute, but the requested signal-to-execution authorization binding is not demonstrated by this audit.
- Symbol normalization and Deriv instrument mapping are centralized in `server/lib/symbols.js`; BTC/USD resolves to the configured Deriv symbol mapping. No price or market data was fabricated for this work.

## Test and build evidence

- **Focused engine/API tests (Node 22):** 28 passed, 0 failed.
- **Server + app groups (Node 22):** latest run 334 passed, 0 failed, 1 skipped (335 total).
- **Server + app groups (Node 24.22.3):** latest run 334 passed, 0 failed, 1 skipped (335 total).
- **Index/Worker/best-pick/hosted-scan focused tests:** 109 passed, 0 failed on both Node 22 and 24.
- **Daily-index browser UI regressions:** nine relevant hosted-markets tests passed on both Node 22 and 24, including a legacy `BUY 74`/zero-level card, unavailable trade confidence, disabled order load, dated context line, and PC fallback. Two additional confidence/sniper regressions passed on Node 22.
- **Most recent complete runner, Node 22 and Node 24:** 885 total, 875 passed, 9 failed, 1 skipped on each runtime. Three failures were stale assertions for this continuation's daily context, news-chip, and missing-timestamp behavior; each was corrected and its targeted regression passed on both runtimes. Six remain from the run: five tests still treat jsdom's unimplemented `HTMLCanvasElement.getContext` warning as a failure, and one asserts that the main chart exposes zero bias controls although four informational controls render. The full runner was not rerun after those three targeted fixes; current full-suite status is therefore not fully verified.
- **Server + app groups:** latest Node 22 and Node 24 runs each 334 passed, 0 failed, 1 skipped (335 total).
- **Index/Worker/best-pick/hosted-scan focused tests:** 109 passed, 0 failed on both Node 22 and 24. Worker daily-bar metadata + Cloudflare route tests: 24/24 on both runtimes. Worker runtime: 14/14 on both runtimes.
- **Daily-index/browser UI regressions:** 11/11 targeted cases passed on Node 22 and Node 24; includes legacy `BUY 74`/zero-level cards, disabled order loading, context-only news chips, dated context display, and PC fallback. Two additional card-confidence/Sniper regressions passed on Node 22.
- **`npm test` history:** smoke assertions reported `PASS (390)`, but the command exited with an issue because jsdom reports `HTMLCanvasElement.prototype.getContext` as unimplemented. Not rerun in this continuation.
- **Build and Cloudflare dry-run:** both `npm run build` and `npm run cf:dry-run` passed on Node 22 and Node 24.22.3 after the latest changes. No deployment occurred.
- `git diff --check` passed; `bridge/app.html` matches `dist/index.html`.

## Remaining risks / acceptance gaps

1. **No BTC/USD historical replay evidence was produced.** Existing tests include synthetic pattern fixtures and walk-forward logic, but those are not a real BTC market-data replay. No external or production data was invented or fetched.
2. **No independent bid/ask or spread validation is available in the public Deriv candle path.** ASTER correctly leaves these checks UNKNOWN, so those analyses cannot become publication-ready.
3. **Exness candle sets arrive from a browser-supplied body.** Timestamp/OHLC quality is checked, but the server cannot independently attest that the supplied series belongs to the requested symbol. ASTER currently sets the request symbol-valid check true; this needs authoritative symbol provenance before it can be considered independently verified.
4. **Volume is integrity-checked only when supplied.** Missing volume remains possible and volume is not an independent confluence input in this analyzer.
5. **RR policy thresholds differ intentionally by stage:** AI sanitation allows the prompt’s 1.5:1 minimum, while ASTER’s manual-review publication policy requires at least 2:1. Confirm whether these thresholds are intended to differ; local technical defaults at 1.5:1 consequently remain non-publishable under ASTER.
6. **Execution authorization is not bound to a validated signal.** The order APIs are separate/manual and do not accept a server-verifiable ASTER-approved signal capability. If signal-originated execution is required, add that binding and tests before release; do not infer approval from a browser assertion.
7. **The full suite remains red** for the UI/jsdom failures listed above. Historical replay, feed-symbol provenance, full execution-boundary coverage, and an explicit volume policy still need evidence/tests.

## Merge / release recommendation

Do **not** propose merge or release yet. Close the remaining acceptance gaps, especially the execution authorization decision and real BTC historical replay, then rerun the complete Node 22/24 suites after resolving or explicitly accepting the UI failures. Repeat the dry-run after any final changes; do not deploy to production as part of this audit.
