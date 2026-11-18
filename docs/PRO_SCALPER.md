# Pro Scalper (analysis only)

The Pro Scalper view is an additive module in the existing AURUM workspace. It reuses the pure indicator libraries and existing read-only market data paths; it does not call an order API, the ASTER gate, or any execution bridge. Its BUY/SELL/WAIT is a technical reading, not execution approval. Existing ASTER, authentication, and broker risk checks remain unchanged and authoritative for their existing workflows.

## Deterministic rules and safeguards

- Requires at least 220 chronologically ordered OHLCV candles, valid OHLC bounds, a closed latest candle, and fresh data. Indicators include EMA 200, Parabolic SAR, MACD, RSI, ADX/+DI/−DI, ATR, Bollinger Bands, and a current-to-20-bar average volume ratio.
- Uses the primary timeframe plus two higher timeframes. A directional result is withheld unless the technical bias is strong and both higher frames provide valid, agreeing BUY/SELL confirmation. Contradictions, missing volume, unavailable indicators, stale/forming candles, or inadequate data produce WAIT and explicit rejection reasons.
- Current read paths: connected local MT5 history (M1/M5/M15/H1, with MT5 tick volume); otherwise the existing public Deriv candles plus public tick history. For Deriv, quote observations are counted into each candle as a clearly-labelled tick-volume proxy (quote activity, not traded volume). The proxy is accepted only when the tick history covers all of the latest 21 closed bars and each has observations; otherwise the module stays WAIT and reports the missing coverage.
- Entry and invalidation are analytical references only. No order is opened, no sizing is proposed, and no broker is contacted by the analysis, backtest, or paper-log functions.
- Next-candle percentages are an indicator-confluence heuristic, explicitly not statistically calibrated and never a guarantee or probability of profit. They are withheld when validation rejects the input.
- Backtest is a historical walk-forward next-close comparison with timestamp-filtered higher-timeframe data; results are descriptive, with no simulated capital or orders. The local paper log records a hypothetical setup and checks its next closed candle; it uses no funds and sends no orders. Audit/paper entries are browser-local and bounded to the most recent 100 records.

## Tests

Focused unit and walk-forward checks: `node --import ./scripts/test-network-guard.mjs --test server/tests/proscalper.test.mjs`. The MT5 M15 history extension is covered in `tests/test_mt5_bridge_readonly.py`.
