# Structured Forex Analyst

The Signal Analyzer includes a deterministic, read-only Forex workflow. It supports the built-in forex pairs and requested intervals of 1m, 5m, 10m, or 15m. It reads verified provider candles through the app's existing history path; it does not fill missing bars or call order/broker execution functions.

## Evidence and signal gates

- Each of 1m, 5m, and 10m needs 50 completed, ordered OHLC candles. A candle is considered completed only when a later candle proves its interval has elapsed. A 15m request also needs its own 50-candle context for entry/stop/target analysis.
- Each MTF frame computes EMA(9), EMA(21), RSI(14), MACD, recent candle pattern, and swing-based support/resistance. At least two MTF frames must independently align BUY or SELL. Missing frames abstain.
- A fresh live quote is required for entry. Otherwise output is WAIT with no entry/stop/target.
- Entry is the verified live quote. Stops use the last confirmed swing plus a one-pip structural buffer. If that stop is on the wrong side or wider than 15 pips, the workflow returns WAIT; it never tightens a stop by inventing a level.
- Targets are the nearest verified S/R level that meets at least 1.5:1 reward-to-risk. If no such level exists, the workflow returns WAIT rather than fabricating a target.
- Confidence is a deterministic confluence quality score (not a probability); any score below 70 is WAIT. It is not calibrated and should not be interpreted as a win probability.

## JSON and chart data

The panel displays valid JSON. The top-level fields include the requested mode, pair/timeframe, 1m/5m/10m alignment, signal, action, entry, stop, target, R:R, confidence, reason, and prior-signal check. `chart_data` contains, per MTF frame, the latest 50 candles, aligned EMA(9)/EMA(21) series, swing trendline endpoints, support/resistance levels and zones, and any validated entry/SL/TP overlays. For a 15m request, `chart_data.requested_context` carries its separate 15m series.

`action: "NONE"` is an explicit no-position/no-order state used when the signal is WAIT. `HOLD`, `EXIT`, and `REVERSE` are analysis labels on UPDATE; they do not inspect or change any broker position. Prior analysis is stored only in this browser's local storage, keyed by pair. If UPDATE has no newer closed candle, it retains the prior reading and says it was not refreshed.

This workflow is technical analysis only. It sends no order, and its output is not a guarantee of direction or profit.
