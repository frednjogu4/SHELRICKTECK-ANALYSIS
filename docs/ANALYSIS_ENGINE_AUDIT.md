# Analysis engine audit

Written 13 November 2026 against commit `77b72ad` of the branch
`arena/05c6d650-cloudflare-staging`, in answer to the upgrade brief ("produce
file-level evidence before implementation"). Line numbers refer to that commit.

What this document is: what the analysis code does today, where it is weak,
and what should be built next and in which order. What it is not: a promise
that any of the proposed work makes the signals profitable. Every proposal
below carries the condition under which it would be shipped, and for most of
them the honest expectation is "unknown until replayed".

The figures quoted come from two scripts in this repository,
`scripts/replay-rule.mjs` and `scripts/news-window.mjs`, and from two
one-off comparisons described in section B. Their data and limits are in the
README ("The confidence score…" and "News: which markets…").

---

## A. What exists

### The signal path (the same code on the PC server, the Worker and in the browser)

| Step | File | What it does |
|---|---|---|
| Candles | `server/lib/closedcandles.js:148` `closedCandleSets` (the page and the Worker import it as `src/closedcandles.js`) | Keeps finished candles only; one reading per 5-minute close; no reading after a pause until a new candle has finished. 110 candles per timeframe (`READING_CANDLES`, line 58). |
| Indicators | `server/lib/indicators.js` | `sma`, `emaSeries`/`ema` (line 24), `rsi` (43), `macd`, `bollingerBands`, `atr` (94), `findLevels` (112). |
| One timeframe | `server/lib/analyzer.js:62` `analyzeTimeframe` | Needs 50 candles (`MIN_CANDLES`, 19). Computes RSI, MACD, Bollinger, EMA 20/50/200, SMA 50/200, ATR, swing levels, Fibonacci, a 20-candle trend label (`identifyTrend`, 21). |
| The vote | `server/lib/analyzer.js:39` `detectSignalBias` | A score from -5 to +5: price against EMA20, price against EMA50, sign of the MACD histogram, RSI zone, the trend label. BUY from +3, SELL from -3. |
| Three timeframes | `server/lib/analyzer.js:108` `confirmMultiTimeframe` | 1m, 5m and 1h with equal weight; BUY or SELL when two agree; a "lean" when two reach +/-2. |
| Decision | `server/lib/localdecision.js` | BUY/SELL/WAIT; stop 1.5 x ATR, target 1 at 2.25 x, target 2 at 4 x (43-45), ATR of the 5-minute timeframe (19); score 15 + 7 per timeframe + 5 x average vote + 20, capped at 93, 45 for a WAIT (48-50). |
| WAIT reasons | `server/lib/analyzer.js:218` `waitReason` | INSUFFICIENT_CANDLES, STALE_DATA, MTF_CONFLICT, MTF_LEAN_NOT_CONFIRMED, MTF_NO_ALIGNMENT, FEED_ERROR. |
| Cloud reading | `src/hostedscan.js:74`, `cloudflare/worker.js` (scan and analyze routes) | The browser reads Deriv's public candles itself; the Worker is the labelled fallback. Indices: a daily reading from Yahoo daily closes, without levels. |
| Live score | `src/signalrun.js` | Follows a BUY/SELL from its first reading: up to 30 points off toward the stop, up to 15 on toward target 1. Describes where price stands; predicts nothing. |
| Measured result | `src/measured.js`, `scripts/replay-rule.mjs` | The replay figure shown under every BUY/SELL. |

### Risk, limits and execution (PC application only)

| File | What it does |
|---|---|
| `server/lib/riskgate.js:33` `evaluateRisk` | Seven checks, each PASSED / FAILED / UNKNOWN: kill switch, stake limit, open trades, daily loss, reward to risk, market hours, news event. Missing data is UNKNOWN and blocks. `bossVerdict` (127): WAIT / SETUP DETECTED / REJECTED / READY FOR MANUAL REVIEW; never overrides a blocked risk report. |
| `server/lib/limits.js`, `killswitch.js` | Server-side limits and the stop-all switch. |
| `src/sizer.js:27` `planPosition` | Position size from stake, stop distance and the instrument values the MT5 bridge reports. |
| `server/app.js:655` | The risk gate route for an MT5 order. |
| `cloudflare/worker.js:54` | `/api/deriv`, `/api/risk`, `/api/ctl` are refused first on the cloud, for every method. No account, order or risk route exists there. |

### Other analysis code that exists and is not part of the reading

`server/lib/setups.js` (four set-ups: EMA pullback, VWAP mean reversion,
opening-range breakout, RSI mean reversion; off unless `AURUM_SETUPS_ENABLED`),
`server/lib/indicators.ext.js` (Wilder smoothing, ADX, session VWAP, swing and
pivot levels), `server/lib/backtest.js`, `setupsBacktest.js`, `patterns.js`,
`server/lib/pipeline/` (news, charts, scout and strategy roles for the AI
pipeline of the PC application).

### Tests

`npm test` runs the smoke checks (`tests/smoke.mjs`) and every test file under
`server/tests`, `tests` and `tests/platform` with outbound network blocked;
`npm run test:worker` runs the Worker inside the Workers runtime. Counts for
this commit are in section F.

---

## B. Weaknesses, with evidence

Ordered as in the brief: data and indicators, risk, regime and timeframes,
signal quality, news, measurement.

### B1. The signals do not win more often than chance (the finding everything else hangs on)

Replay of the rule as coded, one reading per finished 5-minute candle
(`scripts/replay-rule.mjs`): gold, January 2020 to November 2026, 82,069
signals, 39.6% reached target 1 before the stop. With a stop of 1.5 and a
target of 2.25, 40% is needed to break even before the spread. The same
signals taken in the opposite direction: 40.6%. A coin toss: 39.8%. Nine other
markets over six months: 36.9% to 40.9%. No part of the rule separates better
signals from worse ones:

| Split | Target 1 first |
|---|---|
| Score below 60 … 80 and above | 39.4 / 39.9 / 39.2 / 39.7 / 39.4 / 40.2% |
| All three timeframes agree | 39.4% |
| 1-hour agrees / is neutral / is against | 40.0 / 39.0 / 39.5% |
| BUY / SELL | 39.8 / 39.4% |

Consequence for the brief: adding indicators to this rule is unlikely to help,
and a higher score must not be read as a better signal. Any new module is
judged by this same replay.

### B2. Indicator calculations: arithmetic right, two definitions differ from a chart, two values never exist

Checked for this audit and pinned in `tests/platform/indicator-reference.test.mjs`:

- **Arithmetic.** EMA 20/50, MACD 12/26/9, Bollinger 20/2, ATR and RSI were
  re-computed independently (Python, from the textbook definitions) on a fixed
  series. Largest difference to `server/lib/indicators.js`: 0.
- **RSI is not the RSI on a chart.** `rsi` (line 43) averages the last 14
  changes (the file header, line 12, says so). TradingView and MT5 show the
  Wilder RSI. On gold 5-minute candles, January to October 2026 (8,234
  readings): the two differ by 5.4 points at the median and 16.5 at the 95th
  percentile, and the RSI vote of the rule (its zones) differs in 44.2% of the
  readings.
- **ATR is not the ATR on a chart** (line 94: plain average of 14 true
  ranges). Against the Wilder ATR: 0.98 at the median, 0.81 to 1.18 between
  the 5th and 95th percentile. Stops and targets are that much nearer or
  further than a chart's ATR would put them.
- **EMA 200 and SMA 200 never exist.** `analyzeTimeframe` asks for them
  (line 81), but a reading has 110 candles, so both are always `null`.
- **EMA 50 from 110 candles** is close to the EMA 50 of a long history: 0.035
  ATR apart at the median, 0.146 at the 95th percentile; "price above or below
  EMA 50" differs in 1.0% of readings. EMA 20 and the MACD histogram sign: no
  difference.
- **Computed and unused.** Bollinger bands, Fibonacci levels, support and
  resistance and the SMAs are computed for every reading and take no part in
  the decision (`detectSignalBias`, lines 39-59, uses five inputs only).
- **Support and resistance** (`findLevels`, 112) are single candles higher or
  lower than their two neighbours within the last 50: noise-level swings, not
  tested levels.

Not known: whether Wilder definitions would change the 39.6%. That is a replay
to run before changing `indicators.js`, because the change would alter every
reading on the PC and the cloud.

### B3. Five votes are one piece of evidence

Price above EMA20, price above EMA50, MACD histogram positive, RSI between 55
and 70, and "above the 20-candle average and above the price 20 candles ago"
(`detectSignalBias` 39-59, `identifyTrend` 21-30) all say the same thing:
price has been rising. They are counted as five independent points. The RSI
vote also turns round at the extremes (above 70 counts against a BUY, below 30
for it), so a strong move can lose a point for being strong.

### B4. Timeframes are equal, and a higher one can be outvoted without a word

`confirmMultiTimeframe` (108-124) gives 1m, 5m and 1h one vote each. A BUY
from 1m and 5m against a 1h SELL is a confirmed BUY with no conflict noted;
`MTF_CONFLICT` exists only for a WAIT (`waitReason`, 218). There is no M15 and
no H4. The replay (B1) shows no measurable difference between "1h agrees" and
"1h against" with the present rule, so making the higher timeframe a veto is
a hypothesis to test, not a known improvement.

### B5. No market regime

The only regime notion is `identifyTrend` (21-30): UPTREND, DOWNTREND or
CONSOLIDATION from 20 candles. There is no volatility state, no range
detection, no "uncertain". ADX and Wilder smoothing exist in
`server/lib/indicators.ext.js` and are not used by the reading.

### B6. Score and levels

- The score (`localdecision.js:48-50`) counts timeframes and the average vote.
  It is not calibrated against outcomes (B1). The page now says "how strongly
  the timeframes agree, not the chance of profit" wherever it shows it.
- Stop and targets are fixed multiples of the 5-minute ATR (43-45) for every
  market and every state of the market. If the 5-minute timeframe is missing,
  the ATR of the 1-hour or 1-minute timeframe is used instead (line 19) with
  the same multiples and no note.
- `let a = atr || (price ? price * 0.002 : 1)` (line 32): without an ATR a
  distance of 0.2% of price, or 1, is made up. With 50 candles required it
  should not occur, but it fails open where the brief asks to fail closed.
- A WAIT carries levels too (line 43: stop one ATR below, targets above,
  whichever way the market leans). The page showed them as "≈ … (unconfirmed)".
  **Changed in this pull request:** levels are shown for a BUY or SELL only.
- Outcomes are BUY, SELL and WAIT. REJECTED exists only in `bossVerdict` on
  the PC pipeline.

### B7. Risk

- The cloud has no risk engine, by design: it has no account.
- On the PC the gate is sound in shape (UNKNOWN blocks), but two of its seven
  inputs are whatever the page sends: `marketHours` and `newsBlocked`
  (`server/app.js:666-667`). The page sends `newsBlocked:false` as a constant
  (`src/main.js:2345`), so the news check always passes, and it derives
  `marketHours` from "a quote arrived".
- Exposure across correlated markets (EUR/USD and GBP/USD, gold and the
  dollar), drawdown over more than a day, and spread at the moment of entry
  are not checked.
- The cloud Gold monitor reads Deriv's price while the account is at Exness.

### B8. News

- Until this pull request the cloud had no headline or calendar route: the
  News view and the Gold monitor's news cards read "unavailable".
- On the PC, `biasFor` (`server/lib/news.js:52`) turns a headline into BUY or
  SELL from keywords: the first currency of a fixed list that the title
  mentions (line 55), any "up" or "down" word anywhere in it, and the major
  pair of that currency. For the real headline "Euro Falls as US Dollar gains
  on inflation concerns, Fed rate hike bets" it answers BUY USD/JPY. The page
  puts an "⚡ Execute" button and a 25-minute "validity window" beside such a
  chip, and auto-shares it to WhatsApp as a "trading signal".
- The calendar card advised: "High-impact releases = sniper moments: trade
  them inside the 25-minute news window". Measured on gold
  (`scripts/news-window.mjs`, 379 releases): in the minute of a high-impact US
  release price is a full stop distance away in 54% of cases (5% without a
  release), and within 15 minutes it has been that far in both directions in
  21% (2% without). **Changed in this pull request:** the advice is replaced
  by a stand-aside period.
- Events are not part of a reading. After this pull request they are shown
  beside it: in the News view, above the chart and on the Gold page (under the
  signal, in its table of dollar releases, and at the start of the alert it
  sends 15 and 5 minutes before a high-impact dollar release, which until now
  carried the current signal and no word about standing aside). A reading is
  still computed and shown during a stand-aside period; steps 3 and 8 of the
  plan make the event part of the order check and of the reading itself.

### B9. Data

- Cloud prices are Deriv's; indices on the cloud have daily closes only.
- The price archive used for the gold replay stamps its bars with broker time
  until mid-2025 and calls it UTC (README). The replay figures do not depend
  on the clock; the release measurement converts.
- The calendar source gives forecast and previous figure, not the result.

---

## C. Proposed architecture (incremental; nothing replaced)

```
candles (finished only)           server/lib/closedcandles.js     exists
   -> indicators                  server/lib/indicators.js        exists; definitions pinned by a reference test
   -> per-timeframe evidence      server/lib/analyzer.js          exists
   -> regime                      server/lib/regime.js            NEW, pure: trend / range / volatility / uncertain, with its evidence
   -> timeframe policy            server/lib/confluence.js        NEW, pure: higher timeframes as context, conflicts named
   -> decision                    server/lib/localdecision.js     extend: BUY / SELL / WAIT / REJECTED with reason codes
   -> event exposure              src/newsimpact.js               exists since this pull request
   -> risk gate (PC only)         server/lib/riskgate.js          extend; no second engine
   -> measured result             scripts/replay-rule.mjs         exists; every change above is replayed before it ships
```

Rules for all of it: pure functions, no network; the Worker and the browser
import the same modules as the PC server; a reading that is incomplete or
rejected carries no levels; the cloud stays read-only.

---

## D. Plan, file by file, in the order of the brief

Each step is its own pull request. "Ships if" is the evidence required.

1. **Indicator definitions** (`server/lib/indicators.js`, critical).
   Replay the rule with Wilder RSI and Wilder ATR. Ships if the outcome is not
   worse; then the page shows the same RSI and ATR as the chart. If it changes
   nothing measurable it still ships for consistency, and the README says so.
2. **Fail closed in the decision** (`server/lib/localdecision.js`). Remove the
   made-up distance (line 32) and the levels of a WAIT (line 43); a missing
   5-minute ATR becomes a WAIT with a reason. Needs your word: it changes what
   the PC application shows.
3. **Risk gate inputs** (`server/app.js`, `server/lib/riskgate.js`,
   `src/main.js`). Market hours from `server/lib/markethours.js` and the
   bridge quote, event exposure from `src/newsimpact.js` and the calendar,
   both computed on the server; an unreadable calendar is UNKNOWN. This will
   block orders on the PC when the calendar cannot be read or a release is
   near. In the same step the PC news list loses the order button beside a
   keyword chip (B8): `biasFor` stays, if at all, as a label that says it is a
   word match, and a headline no longer opens an order ticket. Needs your
   word.
4. **Exposure and limits** (`server/lib/riskgate.js`, `src/sizer.js`): one
   position per correlated group, loss limit over a week, spread against the
   stop distance at entry; every limit configurable; tick value and contract
   size only from what the MT5 bridge reports.
5. **Regime** (`server/lib/regime.js`, new): ADX and the ATR against its own
   history, swing structure. First as a label on the page with its evidence.
   It becomes a filter (no BUY or SELL in a range or in "uncertain") only if
   the replay shows the filtered signals above break-even on years it was not
   tuned on.
6. **Timeframes** (`server/lib/confluence.js`, new; candle reads for M15 and
   H4 in `src/derivhistory.js` and the Worker): a matrix on the page first;
   a higher-timeframe veto only with the same replay evidence.
7. **Evidence groups and REJECTED** (`server/lib/localdecision.js`): trend,
   momentum, structure, volatility and event exposure each count once; a
   reading that fails a hard condition is REJECTED with its reasons.
8. **Events in readings and alerts** (`src/hostedscan.js`, `src/main.js`): a
   BUY or SELL inside a stand-aside period is shown as such, and its alert
   says so or is withheld.
9. **Performance lab** (`scripts/replay-rule.mjs`, a page view): results by
   market, year, regime and rule version; out-of-sample years kept apart;
   sample-size warnings.

Not planned without new data: indices and oil with minute prices on the cloud
(no verified public source), volume analysis (Deriv's candles carry no volume
for forex), single stocks.

---

## E. Changed in this pull request

- `cloudflare/news.js` (new), `cloudflare/worker.js`: `GET /api/news/feed`,
  `GET /api/news/calendar`.
- `src/newsimpact.js` (new): markets of a headline and of a release, Nairobi
  time, the stand-aside period, the timeframes of a reading in words.
- `src/main.js`, `index.html`: News view, the line above the chart, levels for
  a BUY or SELL only, calendar brief in Nairobi time; on the Gold page the
  stand-aside note under the signal, in the table of dollar releases and in
  the alert before a release. The page now reads one calendar for all of
  these.
- `src/tradingview.js`: the calendar widget's address.
- `scripts/news-window.mjs` (new): the release measurement.
- Tests: `worker-news`, `news-impact`, `news-window`, `indicator-reference`
  (new); `hosted-markets`, `branding`, `worker-http` (extended).
- `README.md`, this document.

Not changed: anything under `server/` (the PC server and its rules), the
bridge, the service worker, the Content-Security-Policy, the deployment
configuration, the dependencies.

(Later, 13 November 2026: the PC server now makes its reading at the 5-minute
close as well, and `closedcandles.js` moved to `server/lib/`. See "One
workspace, two places" in `README.md`.)

---

## F. Test results

See the pull request description: it reports the run of `npm run verify` for
the commit it describes.

---

## G. Security review of this change

- **Read-only boundary.** The two new routes are GET only; broker, risk and
  control namespaces are still refused first (`cloudflare/worker.js:54`). The
  order button of the news list is drawn only where the server sent a keyword
  chip, which the Worker never does.
- **What leaves the Worker.** A request to four fixed addresses with two
  headers (accept, user-agent). No header, query string or address of the
  visitor is forwarded (tested).
- **What comes back.** At most 1 MB per source is read; a title is plain text
  after decoding and is escaped by the page; a link is shown only if it is an
  http(s) address, on both hosts (tested with `javascript:` and `data:`).
- **Abuse.** Both routes are behind the per-address rate limiter and fail
  closed without it; answers are kept 5 and 30 minutes, failures 1 and 2.
  While the calendar source does not answer, the copy read last is passed on
  for up to six hours with the time it was read; headlines are kept five
  minutes and no longer.
- **Errors.** The reason shown for a failed source is one of four fixed
  phrases or `HTTP nnn`; internal error texts are logged, not shown.
- **Secrets, storage, dependencies, CSP.** None added or changed.
- Open, not part of this change: `server/app.js:666-667` trusts the page for
  two risk inputs (B7); the PC news list can still open an order from a
  keyword chip (B8).

---

## H. Deployment readiness

- Nothing is deployed by this work. Merging the pull request publishes the
  cloud site through the existing Cloudflare integration.
- Not verifiable from the build environment: whether Cloudflare can reach the
  four sources (they were reachable from another network while this was
  written).
  If one refuses, the page names it and shows the others; if all do, it says
  so. Check the News view once after the merge.
- The PC application's page copy under `bridge/` is separate and unchanged.
  (Later, 13 November 2026: `npm run build` refreshes that copy; see
  "Bringing the PC app up to date" in `README.md`.)
- Real-money trading stays off by default, and nothing here is a reason to
  turn it on: by the measurement in B1 the signals lose money after the
  spread.
