# Exness Gold alignment — initial audit (before code changes)

## What is accessible
- The supplied Exness WebTerminal URL redirects to Exness sign-in. The authenticated chart, indicators, and account-specific quote cannot be inspected here; do not share login credentials.
- The user's latest local-app screenshot showed the downloaded `AURUM_UPDATED_app.html` opened as a file, and the bridge health check timed out. In that state, AURUM cannot read live Exness MT5 quotes/history.

## Verified AURUM data paths
- The dedicated Gold analyzer already offers an Exness MT5 local-bridge source. In that mode, it requests Exness MT5 XAU candles for M1/M5/H1 and a fresh quote, then runs the deterministic AURUM analyzer; it does not silently substitute Deriv when Exness is unavailable.
- The ordinary Chart & Trade TradingView embed maps XAU/USD to `OANDA:XAUUSD`. This is a different feed from the user's Exness MT5 account and can show small price/candle/spread differences. The green top-bar Deriv status is not evidence that Exness is connected.
- Exness Terminal's logged-in page is private and currently inaccessible from the provided URL without sign-in. The app should be aligned using the local MT5 bridge, not by scraping or sharing credentials.

## No code changes made for this alignment request
The last local baseline remains 376 smoke assertions and 228 Node tests passing, with a successful build; no production deployment or trading changes were made.

## Safe alignment plan
1. First establish a working local bridge connection from the PC that has Exness MT5 open, or via that PC's private-LAN address from another device. Do not open the downloaded HTML directly; do not expose the bridge to the public internet.
2. Use Exness MT5 local candles/quotes as the single Gold source for the monitor and, if requested, the Chart & Trade Gold display. Clearly label source, timestamp, timeframe, and bid/ask/spread; block analysis when data is stale/unavailable.
3. Compare with a user-provided, credential-free Exness chart screenshot and the selected timeframe/indicators. Do not claim exact matching of Exness proprietary signals or guaranteed trading results.
4. Keep Gold analysis-only; this alignment does not enable order execution.
