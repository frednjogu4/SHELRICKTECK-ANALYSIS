
## Round 18 — Rule-based setups, ANALYSIS-ONLY (branch feature/setups, commit 9a82fef)
- Suite: 411/411 (smoke 239 + server 172). New: indicators.ext 6, setups 8 (fire+skip fixture per setup), setupsBacktest 5, setupsapi 4, smoke +8.
- Build: dist/index.html single-file, setupsCard + AURUM_SETUPS_ENABLED strings verified inlined.
- Isolation vs master (88d8f69): 11 files; ZERO trading-path files touched (tradederiv/derivpat/backtest.js/patterns.js/indicators.js/decision.js/derivproxy byte-identical). src/main.js = ONE insertion hunk (+81/0 deletions). app.js = import line + config flag + additive routes only; removed-line count across app: 2 (both re-added in place: import + config trailing line).
- Flag: AURUM_SETUPS_ENABLED (default OFF -> 503 setups_disabled with hint). Routes: POST /api/setups/analyze, POST /api/setups/backtest (12/min, analysis_only:true in every response).
