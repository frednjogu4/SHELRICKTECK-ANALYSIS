# Exness order-execution safety review (local Phase 1 build)

**Decision:** Do not enable real-account order execution yet. No order was sent; no execution guard or deployment was changed in this review.

## Verification performed

- `npm test`: passed (373 smoke assertions; 228 Node tests).
- `python -m unittest discover -s tests -p 'test_mt5*.py' -v`: passed (12 tests).
- `npm run build`: passed.
- The current tests explicitly verify that the Exness bridge refuses orders/closes before calling MT5 `order_send`/close methods.

## Confirmed execution blockers

1. **Two independent hard-off guards are active.** `src/bridge.js` has a hard-coded `MT5_EXECUTION_ENABLED = false`; `bridge/mt5_bridge.py` has its own hard-coded `MT5_EXECUTION_ENABLED = False`. Both client and PC-local bridge refuse order and close messages. `src/main.js` also returns early with the read-only warning for a connected MT5 broker. Simply removing one guard would leave the other in place; removing both without closing the gaps below could expose the real account.
2. **The current order amount is not a verified maximum-loss budget.** The local bridge interprets `volume` as USD notional and converts it to lots. The UI’s CFD position sizer calculates stop-based lots, but the current order-send call passes the amount field instead of the validated sizer result. The generic server gate caps the amount and checks stop/target geometry, but does not verify the estimated currency loss at the broker-derived lot size against an approved per-trade risk budget. The UI’s minimum-notional check is not a substitute for that loss calculation.
3. **Some risk evidence is currently supplied by the browser.** The Exness caller sends `marketHours: true` and `newsBlocked: false` to the API. A real order path must not treat browser-supplied booleans as trusted proof; missing or unverifiable mandatory checks must block.
4. **The cloud-side Exness counters are not authoritative for the real account.** The API’s opens, reservations, and P&L are in-memory application state, initially empty. They do not represent MT5 positions or the real account’s day-to-date loss if positions are opened/closed outside AURUM. The bridge already rechecks open-position count before send, which is useful, but it does not make the app’s daily-loss gate an account-verified limit.
5. **Every execution route needs the same protections.** Manual order and close paths, retries/ambiguous outcomes, and any automation path must all require an explicit user confirmation, server-side risk approval, kill-switch enforcement, duplicate-order protection, exact account/server identity, fresh broker state, and correct reservation/fill handling. The currently blocked Exness branch would otherwise continue directly into the bridge after the Place Order click; it needs a distinct confirmation summary before any send. Exness automation must remain disabled unless separately approved; this request does not authorize enabling the sniper.
6. **The local app's risk API is currently proxied to Railway staging.** `bridge/mt5_bridge.py` forwards its `/api/*` requests to `AURUM_UPSTREAM`, defaulting to the Railway staging host. Thus the local app's `/api/risk/gate` and `/api/risk/fill` are not local risk state; real-order protection would depend on a remote, potentially stale service. This conflicts with the PC-local-only requirement for the Exness execution path and needs to be replaced by verified local enforcement (or an explicitly approved architecture change). No order request is currently enabled.

## Safe next work before considering activation

- Wire the existing CFD sizer’s verified stop-based lot result into manual order construction; reject incomplete/missing conversion, broker spec, stop, or quote data.
- Move or repeat mandatory checks at the local bridge boundary immediately before any MT5 send; bind them to the locked Exness identity and fresh MT5 account/position/quote data.
- Add an explicit confirmation gate and robust idempotency/ambiguous-outcome tests for both opens and closes, and keep automation disabled.
- Define and test how the existing per-trade/open-trade/daily-loss caps map to Exness currency, account state, and externally opened positions; do not silently reset or infer P&L.
- Add mocked tests proving every rejected/unknown path makes zero MT5 execution calls, plus full approved-path request-shape tests. Then test only in a separate Exness demo environment if available. No live-account order should be used as a test.

Until those checks are implemented and pass, the system must remain read-only for Exness. No credentials, account identifiers, or bridge tokens are included in this report.
