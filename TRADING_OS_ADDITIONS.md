# Trading OS Master Prompt — Addendum for the Existing AURUM Project

**Purpose:** Apply the useful governance and data-quality ideas from the Trading OS master prompt to the existing AURUM codebase without replacing its architecture or silently expanding trading scope.

## 1. Existing project baseline

The current project is an existing web application, not a new Python Trading OS repository:

- Vite-built browser application with a single-file export.
- Plain Express/Node.js API and existing Node test suite.
- PC-local Python bridge to MetaTrader 5; the active Exness migration is read-only Phase 1.
- Existing Deriv public market-data feed and existing gated Deriv route; Exness MT5 is read-only in Phase 1.
- The market-discovery change is analysis-only; it does not add order routes.

Preserve working features and architecture. Do not migrate to FastAPI, Streamlit, VectorBT, Docker, Redis, Kafka, or another broker as part of market-catalogue work. Consider such changes only as separately scoped and explicitly approved future projects.

## 2. Scope of broker-market discovery

The Markets view may expose instruments actually returned by:

1. Deriv's public active-symbol catalogue.
2. The connected PC-local Exness/MT5 terminal's symbol catalogue.

The Deriv API documents the no-auth `active_symbols` market-data endpoint: <https://developers.deriv.com/docs/data/active-symbols/>.

Do not fabricate or manually imply availability for instruments absent from the queried broker catalogue. A product class such as bonds, ETFs, equities, or energy should appear only when a connected broker actually returns symbols in that class. Classify from provider metadata; if it is insufficient, show **Other / unclassified**.

## 3. Data and privacy requirements

- Preserve the source symbol, provider, category/path metadata, and retrieval time.
- Label quotes as **LIVE**, **DELAYED**, **HISTORICAL**, or **UNAVAILABLE** only when timestamps and provider evidence justify that label.
- A recent retrieval time does not, by itself, prove a quote is live.
- Validate candle fields, timestamps, ordering, and minimum history before analysis. Missing or invalid bars remain unavailable; never synthesize replacements.
- Exness symbol lists, quotes, and OHLC history must stay on the local PC/browser-to-bridge path. Do not send Exness account positions or Exness market history to a cloud analysis route.
- Deriv public catalogue/market-data requests may use the existing application API, but must not include account credentials or private account data.
- Report provider errors plainly; do not silently fall back to a different symbol or provider.

## 4. Analysis and execution boundary

Newly discovered instruments are for browsing and technical analysis only. They must not inherit an existing order button or be treated as orderable merely because a quote or candle history exists.

Preserve the existing risk checks, position cap, kill switch, and confirmation gates. Exness Phase 1 is read-only; no Exness order or close may be sent. In particular:

- Do not add brokers or expand asset-class orderability without separate approval.
- Never route index orders through Deriv. The approved target route is Exness MT5 only after the exact account server and each symbol are verified; in Phase 1, all Exness order and close handlers are hard-disabled.
- Do not expand sniper/automation coverage through catalogue discovery.
- Do not introduce simulated balances, fake accounts, or simulated market data.
- A technical reading is analysis, not a probability-of-profit estimate or trade authorization.

## 5. Acceptance criteria for market-catalogue changes

A market-discovery change is acceptable only when:

- Deriv results come from its actual active-symbol response and retain the provider symbol and market metadata.
- Exness results come from an authenticated local MT5 terminal; inaccessible bridge or catalogue returns an explicit unavailable/error state.
- Search and category filters work on returned symbols, including an honest Other/unclassified category.
- A symbol is analyzed only after provider-backed candle history is returned and validated.
- Insufficient history, closed markets, stale ticks, and unavailable data are distinguished rather than hidden.
- Exness candles are analyzed locally and are not sent to cloud routes.
- Newly discovered symbols remain analysis-only, and tests verify no order path was added for them.
- Unit/contract tests cover malformed catalogues, unknown symbols, missing/invalid candles, provider errors, and rate/timeout failures.
- Build and regression suites pass; no production deployment occurs without explicit approval.

## 6. Previous 20v market-discovery baseline (pre-Exness migration)

- **VERIFIED:** Build passed; 368 smoke checks and 219 Node tests passed; 6 Python tests passed; Python compilation passed.
- **VERIFIED:** A read-only Deriv public catalogue request returned active symbols, and read-only tick/candle requests succeeded in the development environment. The observed catalogue count is time-dependent and is not a promise of user/account-specific availability.
- **PARTIALLY VERIFIED:** HFM bridge catalogue/history code passed local unit/static/build checks, but has not been exercised against the owner's Windows MT5 terminal.
- **UNVERIFIED:** The exact HFM symbol list, asset-class coverage, and historical depth available on the owner's connected account.
- **NOT DONE:** No deployment and no live order test.

## 7. Previous market-catalogue follow-up (superseded)

The prior HFM-specific follow-up is superseded by the Exness Phase 1 plan below. Historical HFM test status is retained above for provenance; it does not verify Exness.

This addendum narrows the master prompt to the current application. Broader Trading OS phases—additional brokers, persistent research data lake, portfolio construction, paper execution, live promotion, and agent-driven strategy research—remain separate proposals requiring their own scope and approval.

## 8. Active Exness migration — Phase 1 (2026-10-29)

- User-selected scope: replace HFM with Exness MT5, including the index route. Existing Deriv support remains separate.
- Local implementation/testing only. The exact Exness server must be supplied privately in the local app; the bridge verifies the server returned by MT5 and requires an Exness company identity. No account credential or server is to be shared in chat.
- PC and phone clients share the same PC-local bridge; the bridge pins a single account/server identity in memory for its lifetime. The full account ID is never logged or returned; responses show a masked account.
- Account, positions, quotes, symbol catalogue, and history are read-only and stay on the PC/LAN. Exness order and close sends are hard-disabled in both the app client and Python bridge. Sniper/automation remains unavailable for Exness, and indices remain excluded.
- Preserve the existing maximum of 10 positions and all mandatory risk checks; do not clear counters/reservations.
- **LOCAL CODE VERIFIED:** `npm test` passed (368 smoke checks + 221 Node tests); 11 Python tests, production build, Python compilation, and `git diff --check` passed. Bundle 21a was checked for required files and read-only/server markers.
- **UNVERIFIED:** Exness login, server/company identity, symbol resolution, quotes, and history against the owner's Windows terminal/account. No account connection, order test, or deployment has occurred. The prior `npm ci` reported 4 dependency vulnerabilities (1 moderate, 3 high); public deployment remains blocked pending review.
- Next permitted test: owner verifies the local read-only connection using their exact Exness server. Any order enablement or deployment requires separate explicit approval after local verification and a fresh risk review.


## 9. Local-only convenience and market/signal guidance (2026-11-01)

- User-selected persistence is limited to Exness MT5 account login and exact server in browser `localStorage`. Password, bridge token, and bridge URL are not included. Both Exness forms share the saved identity; **Forget saved identity** removes the login/server. No deployment or remote credential relay was added.
- Forex/commodity badges continue using typical Deriv UTC hours; crypto/synthetics are presented as generally 24/7. Index status is **UNKNOWN** without a fresh MT5 tick plus the terminal's `trade_mode`; when verified from a fresh local quote it can indicate OPEN, CLOSE ONLY, or NO ENTRY. This is status evidence, not a guarantee that a broker will accept a trade.
- The market list gives an approximate higher-activity window in Nairobi/EAT for each class. It is explicitly guidance, not a guaranteed optimum or profitability claim; DST and instrument/broker schedules vary.
- Analyzer output labels M1/M5/H1 confluence and suggests review after the next M5 candle close. The UI explicitly says the reminder is not a fixed expiry or holding-time guarantee.
- **LOCAL CODE VERIFIED:** `npm test` passed (368 smoke assertions + 224 Node tests); 12 Python tests passed; `npm run build`, Python compilation, and `git diff --check` passed. Updated single-file app copied to `bridge/app.html` and refreshed into the 7-file `/home/user/FREDRICK_EXNESS_BRIDGE.zip`; no order/close was sent. Four npm audit findings were reported during `npm ci` (1 moderate, 3 high); not remediated as part of this UI request.
- **UNVERIFIED:** Windows/Exness owner-terminal behavior, real index tick freshness/trade-mode mapping, live screen rendering, and browser-specific localStorage persistence have not been exercised against the user's PC. No deployment and no updated staging link.


## 10. Dedicated Gold/USD live monitor (2026-11-01)

- User requested a separate XAU/USD monitor with direction, entry/stop/TP1/TP2, incoming USD news, and signal sharing. Added a Gold/USD navigation view with M1/M5/H1 technical confluence, fresh-price timestamp/status, BUY/SELL only on confirmation (otherwise WAIT), entry/SL/TP1/TP2 reference levels, vote pressure, headline filter, and scheduled USD event countdowns.
- Data source is explicit: when Exness MT5 is connected, the view requests XAU history and quote directly from the local bridge and fails visibly if stale/unavailable; it does not silently switch providers. Otherwise it uses the existing Deriv public Gold candles/ticks. Exness and Deriv data are not mixed for a single analysis.
- Added a Gold-scoped `technicalOnly` mode to `/api/signals/analyze`; it is limited to XAU/USD, bypasses AI calls and signal-history writes, and labels Deriv public candles. The browser refreshes deterministic analysis once/minute while enabled and AURUM is open after opening the Gold view. No trade or close route is invoked.
- The USD calendar is the existing ForexFactory public weekly schedule. High-impact USD entries trigger in-app/browser alerts at approximately 15 and 5 minutes when the Gold monitor has been activated and AURUM remains open; the signal is included. Gold signal-state changes and event alerts use the existing WhatsApp auto-send toggle/configuration; manual Share signal remains available. Public headlines are best-effort and cannot guarantee all breaking news. No headline alone forces BUY/SELL.
- Buyer/seller indication is explicitly a technical timeframe-vote tally, not order-book or true market-flow data. No probability-of-profit claim; confidence remains a quality score. Entry/SL/TPs are analysis references, no fixed expiry and no execution.
- **LOCAL CODE VERIFIED:** `npm test` passed (370 smoke assertions + 225 Node tests); 12 Python tests, Python compilation, production build, and `git diff --check` passed. Gold technical-only API behavior is covered: XAU/USD levels return deterministically, no AI call/history write occurs, and non-Gold `technicalOnly` requests are rejected. **UNVERIFIED:** no live Exness terminal, broker quote/history, scheduled event, browser notification permission, or WhatsApp delivery was tested from this workspace. No order and no deployment.
