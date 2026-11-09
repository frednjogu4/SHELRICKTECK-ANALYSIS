# AURUM — Part 6 Test Checklist (Deriv proxy + trading + backtesting)

Run against a configured server (`.env.local` loaded). `n` = automated test
name (all run in `npm test`: 112 smoke + 61 server). `m` = manual step that
needs real credentials.

## 1. Connection
- [x] n — health endpoint reports `not_configured` listing `DERIV_APP_ID`, `DERIV_API_TOKEN` when env vars are missing (fail-fast, platform keeps running).
- [x] n — `createDerivConn` connects and reaches `authorized` with an injected WebSocket (no network in CI).
- [x] n — health JSON never contains the token; `appId` is masked.
- [ ] m — start server with real `.env.local`; GET `/api/deriv/health` → `state: authorized`, `environment: demo`, `endpoint` = spec URL (or fallback with `endpointIsFallback: true`).
- [ ] m — structured JSON logs show `deriv.conn open` / `authorize` events with redacted tokens only.

## 2. Authorize first
- [x] n — authorize is injected by the connection manager before any request; client `authorize` frames over the relay are rejected (`ClientAuthorizeForbidden`).
- [x] n — trading endpoints return 503 `not_authorized` while the socket is not authorized.

## 3. Candle fetch (normalized)
- [x] n — `/api/deriv/candles` returns `{time,open,high,low,close,volume}` rows; invalid symbol/granularity → 400 before any upstream call.
- [ ] m — real EUR/USD 5m candles return `source: deriv-auth` when authorized, `deriv-public` fallback otherwise.

## 4. Live tick (WS relay)
- [x] n — frontend module + relay wiring covered by smoke (modal tick feed opens the relay without JS errors).
- [ ] m — open the trade modal, confirm ticks update the `Live price` row in real time.
- [ ] m — browser DevTools: no token appears in any WS frame to the client.

## 5. Reconnect + backoff
- [x] n — backoff constants: base 1000 ms, max 30 000 ms, ping 30 000 ms (spec).
- [ ] m — kill the network / restart the upstream: logs show `reconnect attempt n` with growing delays + jitter, then re-authorize and re-subscribe.

## 6. Invalid symbol / bad input
- [x] n — `/api/deriv/candles?symbol=NOTREAL` → 400 with allowed list; granularity `77` → 400.
- [x] n — `/api/backtest` with `FAKEX` or bad granularity → 400.
- [x] n — proposal with bad side/amount → 400.

## 7. Missing token (fail-fast)
- [x] n — unconfigured app: health lists both missing vars; `/api/deriv/proposal` → 503 `not_configured` with hint.
- [x] n — `request()` rejects with `notConfigured: true` without opening a socket.

## 8. Trade confirmation (trading OFF by default)
- [x] n — `DERIV_TRADING_ENABLED` unset → proposal 403 `trading_disabled`; health still available.
- [x] n — proposal → ticket (+30 s TTL); confirm with unknown/expired ticket → 400 `ticket_expired`; confirm with valid ticket → `order.contract_id`.
- [x] n — server-side limits: stake above `DERIV_MAX_STAKE_USD` → 400 `stake_limit`; open contracts above `DERIV_MAX_OPEN_TRADES` → 400 `max_open_trades`; daily loss limit → 403 `daily_loss_limit`.
- [x] n — rate limit: `DERIV_PROXY_RATE_PER_MIN=2` → third request 429.
- [ ] m — UI: DEMO/LIVE badge in the confirm modal; Cancel places nothing; Confirm places exactly one contract; close sells via `/api/deriv/close`.

## 9. Backtesting (real candles only)
- [x] n — `runBacktest` fixture: stats/trades shape, risk geometry (sl ≈ −1R), no invented history under 70 bars.
- [x] n — `/api/backtest` with injected feed returns stats + trades; bad inputs 400.
- [ ] m — UI backtest card renders 6 stat tiles + trade table; note references real Deriv candles.

## 10. Regression
- [x] `npm test` → 199/199 (126 smoke + 73 server) ALL GOOD — includes the chart-pattern suites below.
- [x] `npm run build` → single-file `dist/` (no server secrets inside — token is env-only).

## 11. Auto-trade (sniper) — Settings accordion
- [x] n — card present, toggle OFF by default (smoke).
- [x] n — enabling without a connected broker is rejected and the toggle reverts (smoke).
- [x] n — session realized P&L comes from real closed-trade history only (`at` flag); stops at +target, −target guard, and max entries.
- [ ] m — with a demo broker connected: arm at 70% confidence → confirm an entry places one contract with SL/TP from the decision, exits fire via the tick watcher, status shows `running · $x / $y target`, and the system stops at the target with a notification.

## 12. Chart patterns (12-pattern recognition)
- [x] n — engine battery: all 12 textbook fixtures recognized (`server/tests/patterns.test.mjs`), confidence in 40–92, lines[] overlay present, bearish twins → SELL, bullish twins → BUY (falling wedge is bullish — upside break).
- [x] n — input gates: <30 candles → `[]`; noise (sine walk) → ≤3 detections; short study keys-filter respected; walk-forward sums equal signals; cooldown prevents overlapping entries per pattern.
- [x] n — API: `/api/patterns/analyze` 200 {candles,patterns,source:'deriv-candles'}; bad symbol/granularity 400; bars clamp (240 max, backtest convention); <30 candles → 502 `insufficient_history`; feed error → 502 without stack traces.
- [x] n — `/api/patterns/study` walk-forward shape {window,holdBars,signals,note,patterns,meta}; small-sample note when n<15 (honest labelling).
- [x] n (smoke) — patterns card + timeframe select (1m→1D); Detect renders 2 detection cards + SVG candle chart with overlay lines + entry/stop/levels; `Pattern alert` toast fires for formed ≥60%; Success rates renders perf bars with the walk-forward note; playbook renders all 12 educational items.
- [ ] m — manual: on a live session run Detect on EURUSD 1h (weekdays) and on VOLATILITY indices (weekends) — confirm the SVG lines match the visual pattern and forming patterns show HOLD until the break.
- [ ] m — manual: Success rates on 4h with ≥600 bars — check sample sizes shown (n=) and the small-sample warning appears when n<15.
