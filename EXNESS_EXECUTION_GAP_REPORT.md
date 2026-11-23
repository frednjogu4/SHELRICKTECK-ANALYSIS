# Exness order-execution safety review (local app)

## Current implementation status (2026-11-14)

The user-approved scope is **manual REAL and DEMO account orders only**, with a separate explicit confirmation for every order. The bridge now verifies the requested account mode against MT5, creates a 30-second local risk preview, then rechecks broker state immediately before its single market-order send. App automation/Sniper execution and app-side closes remain blocked. The historical Phase 1 review below is retained for context; current code supersedes some of its listed blockers.

**The REAL execution path is not end-to-end verified against Exness.** Tests use mocked MT5 responses; no terminal or live account was connected during implementation. Passing tests do not establish safety or profitability. REAL orders can lose money; stops and risk estimates do not guarantee the final loss.

### Implemented manual REAL/DEMO safeguards

- Both client and Python bridge require an explicit mode that matches MT5-reported REAL or DEMO trade mode. The bridge also binds every action to the authenticated Exness login/server and requires a connected, trade-enabled terminal and USD account.
- The bridge recalculates the plan from broker account data, symbol rules, fresh bid/ask, broker profit/margin calculators, current positions, and the current UTC day's realized broker history. Unknown/stale required data blocks the preview or send.
- The preview is server-held, unguessable, and expires after 30 seconds. Confirmation rechecks size, SL/TP, quote, risk, account, margin, and positions. A changed order requires a new preview and confirmation.
- The ticket sizer now refreshes contract size, minimum/maximum lot, exact volume step, and broker bid/ask on MT5 connect, symbol change, and account refresh. It does not synthesize the step or substitute the Deriv price for the Exness quote. A missing/stale quote or any required volume spec leaves the plan incomplete; the computed size is capped at the broker maximum and rounded down to its step.
- Symbol lookup now prefers exact names, then a unique decorated prefix/suffix (including Exness names such as `XAUUSDm`), or a sole visible match; multiple visible variants fail closed with a diagnostic. The Gold monitor discovers its exact XAU/USD symbol from the connected terminal catalogue before requesting candles and quotes.
- Limits currently configured in code: one open MT5 position, 0.5% buffered estimated stop risk per order, a 2% daily realized-loss threshold, reward/risk of at least 1.2, and maximum 80% of free margin. These are software estimates/guards, not guaranteed maximum losses; floating P/L and slippage/gaps are not guaranteed to be contained by the realized-loss threshold or fixed buffer.
- A unique intent is cached during the bridge process; order submission is attempted once. An uncertain, partial, or pending result blocks subsequent app sends until the user inspects MT5 positions/history and restarts the bridge after understanding the outcome. There is no automatic retry. Closing positions and Sniper/automated entries are explicitly unavailable in the app; manage REAL/DEMO positions directly in MT5.

## Historical Phase 1 verification

- `npm test`: passed (373 smoke assertions; 228 Node tests).
- `python -m unittest discover -s tests -p 'test_mt5*.py' -v`: passed (12 tests).
- `npm run build`: passed.
- Those historical tests explicitly verified that the earlier Exness bridge refused orders/closes before calling MT5 `order_send`/close methods.

## Historical Phase 1 execution blockers (superseded where current code now has explicit manual safeguards)

1. **Two independent hard-off guards are active.** `src/bridge.js` has a hard-coded `MT5_EXECUTION_ENABLED = false`; `bridge/mt5_bridge.py` has its own hard-coded `MT5_EXECUTION_ENABLED = False`. Both client and PC-local bridge refuse order and close messages. `src/main.js` also returns early with the read-only warning for a connected MT5 broker. Simply removing one guard would leave the other in place; removing both without closing the gaps below could expose the real account.
2. **The current order amount is not a verified maximum-loss budget.** The local bridge interprets `volume` as USD notional and converts it to lots. The UI’s CFD position sizer calculates stop-based lots, but the current order-send call passes the amount field instead of the validated sizer result. The generic server gate caps the amount and checks stop/target geometry, but does not verify the estimated currency loss at the broker-derived lot size against an approved per-trade risk budget. The UI’s minimum-notional check is not a substitute for that loss calculation.
3. **Some risk evidence is currently supplied by the browser.** The Exness caller sends `marketHours: true` and `newsBlocked: false` to the API. A real order path must not treat browser-supplied booleans as trusted proof; missing or unverifiable mandatory checks must block.
4. **The cloud-side Exness counters are not authoritative for the real account.** The API’s opens, reservations, and P&L are in-memory application state, initially empty. They do not represent MT5 positions or the real account’s day-to-date loss if positions are opened/closed outside AURUM. The bridge already rechecks open-position count before send, which is useful, but it does not make the app’s daily-loss gate an account-verified limit.
5. **Every execution route needs the same protections.** Manual order and close paths, retries/ambiguous outcomes, and any automation path must all require an explicit user confirmation, server-side risk approval, kill-switch enforcement, duplicate-order protection, exact account/server identity, fresh broker state, and correct reservation/fill handling. The currently blocked Exness branch would otherwise continue directly into the bridge after the Place Order click; it needs a distinct confirmation summary before any send. Exness automation must remain disabled unless separately approved; this request does not authorize enabling the sniper.
6. **The local app's risk API is currently proxied to Railway staging.** `bridge/mt5_bridge.py` forwards its `/api/*` requests to `AURUM_UPSTREAM`, defaulting to the Railway staging host. Thus the local app's `/api/risk/gate` and `/api/risk/fill` are not local risk state; real-order protection would depend on a remote, potentially stale service. This conflicts with the PC-local-only requirement for the Exness execution path and needs to be replaced by verified local enforcement (or an explicitly approved architecture change). No order request is currently enabled.

## Historical Phase 1 follow-up list (not a description of current account-mode gates)

- Wire the existing CFD sizer’s verified stop-based lot result into manual order construction; reject incomplete/missing conversion, broker spec, stop, or quote data.
- Move or repeat mandatory checks at the local bridge boundary immediately before any MT5 send; bind them to the locked Exness identity and fresh MT5 account/position/quote data.
- Add an explicit confirmation gate and robust idempotency/ambiguous-outcome tests for both opens and closes, and keep automation disabled.
- Define and test how the existing per-trade/open-trade/daily-loss caps map to Exness currency, account state, and externally opened positions; do not silently reset or infer P&L.
- Add mocked tests proving every rejected/unknown path makes zero MT5 execution calls, plus full approved-path request-shape tests. Then test only in a separate Exness demo environment if available. No live-account order should be used as a test.

The bullets above record the older Phase 1 review and are not current authorization or instructions. Current code enables only manual REAL/DEMO market orders behind the bridge's local checks and a fresh explicit confirmation; automation and app-side closes remain disabled. No credentials, account identifiers, or bridge tokens are included in this report.
