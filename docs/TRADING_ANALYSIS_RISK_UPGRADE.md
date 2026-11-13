# Trading Analysis & Risk Intelligence Upgrade

## Purpose

Upgrade the existing AURUM / Fredrick Trading workspace incrementally. Preserve the current application, existing routes, Cloudflare read-only viewer, Deriv market-data integration, current indicator calculations, and established design language. This document is the implementation contract for the next engineering phase; it does not authorize live order execution.

## Non-negotiable safety and integrity rules

1. Analysis and paper/simulation workflows only. Do not add, enable, or invoke real-money order placement, broker execution, auto-trading, leverage controls, or credential collection as part of this upgrade.
2. No strategy, indicator, signal, confidence score, or AI output may claim to prevent losses or guarantee profit.
3. Never invent, interpolate, silently substitute, or label stale/demo/test prices as live. Every quote and candle must carry source, instrument, timeframe, timestamp, and freshness status.
4. Missing, stale, malformed, delayed, or contradictory data must produce `UNKNOWN` / `BLOCKED`, not a bullish/bearish signal.
5. The AI may explain evidence but must not override deterministic validation or risk checks.
6. Keep the Cloudflare viewer read-only. Do not expose broker secrets, API tokens, account identifiers, or private environment values to browser code, logs, or client storage.
7. Work on a feature branch, add tests, and submit a draft pull request. Do not merge or deploy automatically.

## Phase 0 — Repository reconnaissance and baseline

Before changing code:

- Map the current UI, API/worker routes, market-data adapters, indicator modules, signal analyzer, decision logic, settings, and tests.
- Identify the authoritative quote/candle schema and existing freshness thresholds.
- Trace the Deriv WebSocket lifecycle, reconnect handling, subscription cleanup, rate limits, and error states.
- Identify any duplicated calculations between browser and worker; make one shared deterministic implementation authoritative where feasible.
- Record the current test/build/lint commands and baseline results.
- Preserve current routes, storage contracts, and user-visible functionality unless a migration is explicitly tested.
- Do not create a second competing risk engine or duplicate indicator pipeline.

## Phase 1 — Market data integrity

Implement a single validated market-data contract:

- Required fields: instrument symbol, canonical instrument ID, asset class, source/provider, bid/ask or candle OHLCV where available, timeframe, event timestamp, received timestamp, and status.
- Validate finite numeric values, positive prices, valid OHLC relationships, monotonic candle timestamps, duplicate candles, missing intervals, and supported instrument specifications.
- Distinguish `LIVE`, `DELAYED`, `STALE`, `REPLAY`, `SIMULATED`, and `UNAVAILABLE` data states.
- Calculate data age from server timestamps; do not trust client clocks alone.
- Add bounded reconnect with exponential backoff and jitter, subscription cleanup, heartbeat monitoring, and visible connection status.
- Prevent stale cached values from being presented as current prices.
- Add contract tests for malformed, delayed, duplicated, missing, and out-of-order data.
- Keep instrument metadata (tick size, pip size, contract multiplier, trading hours, minimum increment) sourced from verified provider metadata. If unavailable, mark sizing as unsupported rather than guessing.

## Phase 2 — Deterministic risk engine (highest priority)

Create one reusable, pure risk-evaluation module used by all analysis surfaces.

Inputs:
- instrument specification and quote freshness;
- simulated account equity/balance supplied by the user for educational calculations;
- user-configured risk budget and maximum aggregate exposure;
- proposed entry, stop, target, and direction;
- spread, estimated fees, slippage assumptions, and ATR;
- open simulated positions and correlated exposure, if available.

Validations:
- reject non-finite or non-positive values;
- reject missing instrument specifications;
- reject stale/unavailable prices;
- reject a stop on the wrong side of the proposed entry;
- reject targets on the wrong side of entry;
- reject zero/negative stop distance;
- reject position-size calculations when tick value, contract multiplier, or conversion rate is unknown;
- show assumptions and units for every calculation;
- never silently increase a risk budget or widen a stop.

Outputs:
- `PASS`, `WARN`, or `BLOCK` with machine-readable reason codes;
- estimated monetary risk and percentage of simulated equity;
- stop distance, target distance, reward/risk ratio, spread cost, and assumptions;
- aggregate simulated exposure and correlation warnings;
- an explanation of what data is missing when sizing cannot be calculated.

Risk controls:
- configurable conservative per-idea risk ceiling;
- configurable daily simulated loss limit and weekly drawdown warning;
- maximum simultaneous simulated positions;
- aggregate exposure and correlated-instrument warnings;
- cooldown after a configured sequence of simulated losses;
- no new paper idea when the simulated loss limit is reached;
- explicit warning that gaps, slippage, spreads, and execution differences can exceed estimates.

Do not ship universal lot-size, pip-value, or contract-value constants. Use instrument-specific verified metadata and explicit currency conversion. Do not treat a risk/reward ratio as proof of positive expectancy.

## Phase 3 — Market regime and structure

Add deterministic classifications, each with evidence and an `UNKNOWN` fallback:

- trend / range / compression / expansion / high-volatility / low-liquidity;
- swing structure: higher highs/lows, lower highs/lows, range boundaries;
- support/resistance zones with source timeframe and age;
- breakout / retest / failed-breakout candidates, requiring candle-close confirmation;
- volatility regime using ATR relative to its own historical distribution;
- spread anomaly and session/liquidity warnings.

Avoid repainting: closed-candle signals must not change when a new candle arrives. Clearly label any intrabar observation as provisional.

## Phase 4 — Multi-timeframe confluence

Retain the existing M1/M5/H1 analysis but make the timeframe policy configurable and testable. Add M15/H4 context where valid data exists.

- Separate higher-timeframe bias from lower-timeframe trigger.
- Do not count correlated indicators as independent votes.
- Show each timeframe's trend, structure, volatility, and data freshness.
- Require explicit agreement rules; expose disagreement as `CONFLICT`, not a forced direction.
- Include candle-close confirmation and configurable minimum evidence.
- Show why a setup is rejected.

## Phase 5 — Indicator quality and signal scoring

Retain existing EMA20/50/200, RSI, MACD, Bollinger Bands, ATR, Fibonacci, and support/resistance calculations after validating them against known fixtures.

Add only when useful and testable:
- RSI/MACD divergence with pivot confirmation;
- volume confirmation only for instruments/providers with meaningful volume;
- session-aware volatility context;
- spread-to-ATR quality check;
- range-bound false-breakout filter.

Signal scoring:
- deterministic, versioned scoring with documented weights;
- explicit penalties for stale data, spread anomalies, conflicting timeframes, low liquidity, and missing confirmations;
- no score may bypass a risk `BLOCK`;
- do not describe a heuristic score as a probability of winning;
- if confidence is shown, label it as a heuristic evidence score until calibrated on out-of-sample data.

## Phase 6 — News and session context

- Add an economic-calendar provider only after source, timezone, licensing, and timestamp handling are verified.
- Display event title, currency/region, impact, source, published time, and event time in Africa/Nairobi and UTC.
- Flag high-impact event proximity as a risk warning; do not infer the event outcome.
- Add configurable session windows for London, New York, Asia, and overlap periods using timezone-safe logic.
- Show weekends, holidays, market closures, and instrument-specific trading hours where reliable data exists.
- Do not block or recommend activity solely from an unverified news headline.

## Phase 7 — Backtesting and paper analysis

Add a reproducible simulation environment, separate from live data and any broker account:

- historical candle input with source and coverage metadata;
- no look-ahead bias, survivorship assumptions, or future-candle leakage;
- spread, fees, slippage, and gaps represented in configurable assumptions;
- consistent signal version, strategy parameters, instrument metadata, and date range stored with every run;
- out-of-sample and walk-forward evaluation;
- paper-trade journal with entry rationale, invalidation, stop/target assumptions, and outcome;
- metrics: expectancy, profit factor, win/loss distribution, maximum drawdown, average adverse/favourable excursion, exposure, and sample size;
- results segmented by instrument, timeframe, session, regime, and signal version;
- warn when sample size is too small or historical data is incomplete;
- never present backtest results as expected future performance.

## Phase 8 — Dashboard improvements

Add four focused modules, matching the current dark-first AURUM visual system:

1. **Market Regime Detector** — trend/range/volatility state, timeframe context, and data freshness.
2. **Risk Command Center** — simulated risk budget, exposure, drawdown, blocked reasons, and calculation assumptions.
3. **MTF Confluence Matrix** — instrument rows and timeframe columns with bias, structure, volatility, and conflict state.
4. **Strategy Performance Lab** — backtest/paper results, drawdown, expectancy, profit factor, and sample-size warnings.

Every signal card should show:
- instrument and asset class;
- source and freshness;
- timeframe and candle-close status;
- market regime and multi-timeframe evidence;
- entry/stop/target only as hypothetical analysis levels;
- estimated risk and assumptions, or a clear reason why calculation is unavailable;
- invalidation conditions;
- risk gate status and reason codes;
- timestamp and analysis version.

Accessibility:
- responsive desktop/mobile layouts;
- keyboard-operable controls and visible focus;
- readable contrast in dark and light themes;
- no color-only status indicators;
- loading, empty, stale, disconnected, and error states.

## Phase 9 — Security and operational quality

- Keep all secrets server-side in environment/secret management.
- Remove credentials and sensitive tokens from localStorage, sessionStorage, URLs, frontend bundles, and logs.
- Validate and authorize every server-side endpoint; apply rate limits and request-size limits.
- Sanitize untrusted text before rendering; review DOM sinks and any dynamic HTML for XSS.
- Enforce strict CORS, secure headers, and safe error responses.
- Do not log full account payloads or secrets.
- Keep read-only viewer permissions explicit and test that no write endpoint is reachable from it.
- Add structured, redacted audit events for configuration changes and simulation runs.
- Add dependency and secret scanning to CI where supported.

## Phase 10 — Test and release gates

Required tests:
- unit tests for indicator calculations and risk calculations;
- property tests for numeric validation and OHLC invariants;
- fixtures for trend, range, volatility expansion, and false breakout;
- tests for stale data, provider disconnect, reconnect, duplicate/out-of-order candles;
- tests for conflicting timeframes and missing instrument metadata;
- tests that every `BLOCK` condition prevents a paper idea from being marked eligible;
- tests for no look-ahead bias in backtests;
- accessibility and responsive UI checks;
- regression tests for existing routes and features.

Release gates:
- all existing tests pass;
- all new tests pass;
- build and lint pass;
- no critical/high security findings remain unresolved;
- no secrets in client bundle or browser storage;
- no fabricated market data or misleading live labels;
- risk calculations independently reviewed with known test cases;
- Cloudflare viewer remains read-only;
- deployment is a separate, explicit approval after review.

## Implementation order

1. Baseline audit and data contract.
2. Risk engine and test coverage.
3. Freshness/connection reliability.
4. Regime classification and MTF confluence.
5. Signal scoring and rejection explanations.
6. Calendar/session context.
7. Backtesting and paper journal.
8. Dashboard modules, accessibility, and observability.
9. Security review and release verification.

## Required engineering deliverables

- architecture/data-flow diagram;
- changed-file list and rationale;
- migration notes for any schema change;
- unit/integration/regression test results;
- security findings and remediation status;
- sample analysis output using clearly labeled fixtures or historical data;
- known limitations and unsupported instruments;
- draft pull request with a checklist of remaining release gates.

## Definition of done

The upgrade is complete only when the existing application remains functional, every displayed market value has truthful provenance and freshness, risk calculations fail closed when required inputs are missing, all new behavior is covered by automated tests, paper/backtest results are reproducible, and no real-money execution or automatic trading has been introduced.
