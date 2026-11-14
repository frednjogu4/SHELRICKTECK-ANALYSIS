# ASTER Evidence Contract

## Purpose

ASTER is a deterministic, read-only pre-publication validation gate. It may allow a result to be presented for manual review only when every mandatory check is verified. It never authorizes or places real trades or orders.

## Evidence currently derived from candle data

The analysis service can derive D1, H4, H1 and M15 evidence from closed OHLC candle sets:

- OHLC shape and chronological timestamp integrity
- Per-timeframe freshness
- EMA20, EMA50 and RSI availability
- Directional trend alignment
- Basic range-extreme structure comparison
- H1 directional setup alignment
- M15 directional breakout confirmation

The structure check is deliberately basic: it compares highs and lows across two 20-candle windows. It is not a swing-point, order-block, liquidity, or institutional market-structure engine.

## Proposed level-plan checks

ASTER independently checks the geometry of the deterministic analysis levels:

- Stop must be on the protective side of entry.
- TP1 and TP2 must be on the intended side of entry and ordered outward.
- TP1 reward-to-risk is recomputed from entry, stop and TP1.
- TP1 must meet the minimum 1:2 reward-to-risk requirement.

These are mathematical plan checks only. They do not verify execution price, slippage, tick value, broker stop-distance rules, or actual monetary risk.

## Evidence that must remain UNKNOWN

The current public Deriv feed implementation returns a single quote. It does not expose an independently verified bid/ask pair in the interface used by ASTER. Therefore bid/ask and spread checks must remain UNKNOWN.

The following checks also remain UNKNOWN until trusted server-side sources and authentication are implemented:

- Instrument-matched, timestamped news and economic-event validation
- Authenticated account equity and account currency
- Account-specific position sizing and monetary risk
- Broker instrument specifications and account constraints
- Verified risk against the configured account limit

Do not treat browser-submitted values, an AI-generated summary, heuristic headlines, or a single last-traded quote as proof of these checks.

## Fail-closed policy

- Missing evidence is UNKNOWN, not PASS.
- Invalid evidence is FAILED.
- The weighted confluence score cannot override a failed or unknown mandatory check.
- A directional technical reading is not a validated signal.
- The only positive ASTER outcome is READY FOR MANUAL REVIEW.
- `executionAuthorized` remains false. Real-money execution is outside this gate and remains disabled.

## Verification status

Unit and API tests cover candle evidence, missing evidence, malformed and stale candles, plan geometry, RR recomputation, and evidence-gap explanations. They have not been run in this work session.
