/* ================================================================
 * AURUM — signal scan for the cloud viewer (browser side, no DOM).
 *
 * Who computes what on the hosted page:
 *
 *   Deriv-backed markets (forex, metals, crypto, synthetics)
 *     -> THIS BROWSER: Deriv public candles (derivhistory.js) through the
 *        same deterministic analysis the Worker and the PC server run.
 *     -> the AURUM cloud (Worker) is asked only when this browser could not
 *        reach Deriv at all, and its answer is labelled as such.
 *   Index CFDs (US30, NAS100, ...)
 *     -> the AURUM cloud: Yahoo daily data cannot be read from a browser.
 *
 * Every reading carries one explicit state, so the interface never has to
 * guess what an empty cell means:
 *
 *   live         candles are current (newest 1-minute candle under 5 minutes old)
 *   daily        end-of-day index reading
 *   stale        candles exist but are old: market closed or feed paused
 *   no-data      Deriv answered, but has no usable history for the market
 *   unavailable  neither this browser nor the AURUM cloud could get the data
 *
 * Only 'live' and 'daily' readings carry a signal. The other three are
 * error-shaped ({ error, detail, data_state }), which every existing consumer
 * (alerts, best pick, signal cards, order-ticket levels) already skips.
 * Nothing is ever estimated or filled in.
 * ================================================================ */

import { DERIV_CODE_MAP } from '../server/lib/symbols.js';
import { runDeterministicAnalysis, votesSummary, waitReason } from '../server/lib/analyzer.js';
import { localDecision } from '../server/lib/localdecision.js';
import { isFeedFailure } from './derivhistory.js';
import { closedCandleSets } from './closedcandles.js';

export const DERIV_SOURCE = 'Deriv public candles';
export const YAHOO_SOURCE = 'Yahoo Finance public daily data';
export const BROWSER_LABEL = DERIV_SOURCE + ' · analysed in this browser';
export const CLOUD_SUFFIX = ' · AURUM cloud analysis';
/** A reading is live while its newest 1-minute candle started less than this many seconds ago. */
export const LIVE_MAX_AGE_SEC = 300;
/** The three series one multi-timeframe reading needs: [key, candle width in seconds]. */
export const SCAN_TIMEFRAMES = Object.freeze([['m1', 60], ['m5', 300], ['h1', 3600]]);
export const SCAN_CANDLES = 120;
/* How long a reading from the AURUM cloud is reused, so that scans that follow
   each other closely (signal cards, best pick, Markets table) do not each spend
   a request of the cloud's rate limit on the same markets. Daily index readings
   change once a day. A reading on minute candles is kept no longer than the
   1-minute series itself is (20 s, here and in the Worker); whether it is still
   live is judged from its candle time at every scan, reused or not. */
export const CLOUD_INDEX_TTL_MS = 60000;
export const CLOUD_DERIV_TTL_MS = 20000;
/* A tick older than this no longer says anything about the current time. */
const FEED_CLOCK_MAX_AGE_MS = 120000;
/** After a scan in which this browser could not reach Deriv at all, the browser is tried again this much later. */
export const BROWSER_RETRY_MS = 60000;

/**
 * "Now" on Deriv's clock when a recent tick tells us what that is; the device
 * clock otherwise. Candle times are Deriv's, so comparing them with a device
 * clock that is minutes off would mislabel live markets as stale.
 *
 * @param {number} deviceMs  the time on this device, epoch milliseconds
 * @param {{epochMs:number, seenAtMs:number}|null} clock  the newest tick's time and when this device saw it
 */
export function feedTimeMs(deviceMs, clock) {
  if (clock && Number(clock.epochMs) > 0 && Number(clock.seenAtMs) > 0) {
    const sinceSeen = deviceMs - Number(clock.seenAtMs);
    if (sinceSeen >= 0 && sinceSeen < FEED_CLOCK_MAX_AGE_MS) return Number(clock.epochMs) + sinceSeen;
  }
  return deviceMs;
}

/** True for the built-in markets that have a Deriv public candle feed. */
export function isDerivBacked(symbol) {
  const code = DERIV_CODE_MAP[symbol];
  return typeof code === 'string' && code.length > 0;
}

/**
 * One multi-timeframe reading from three candle series. Field for field the
 * same result the Worker's /api/signals/scan and /api/signals/analyze return
 * for the same candles (tests/platform/hosted-scan.test.mjs holds the two
 * together), so a market reads the same wherever it is computed.
 *
 * The reading is made from finished candles, as of the last 5-minute close
 * (closedcandles.js): `candle_close` is that close. `latest_candle_time` stays
 * the start of the newest 1-minute candle the feed returned, finished or not,
 * because it answers a different question: is the feed current?
 */
export function buildDerivReading(symbol, sets, nowMs = Date.now()) {
  const closed = closedCandleSets(sets);
  const det = runDeterministicAnalysis(symbol, closed.sets);
  const decision = localDecision(det);
  const wr = decision.signal === 'WAIT' ? waitReason(det, { maxAgeSec: 3 * 3600 + 300 }) : null;
  const latest = sets.m1[sets.m1.length - 1];
  return {
    ...decision,
    symbol,
    price: det.analyses.m1?.currentPrice ?? null,
    mtf_signal: det.mtfSignal,
    data_ok: det.ok,
    votes: votesSummary(det.analyses),
    wait_reason: wr?.code || null,
    wait_detail: wr?.detail || null,
    tf: 'MTF 1m/5m/1h',
    timeframe: 'MTF',
    model: 'technical',
    source: DERIV_SOURCE,
    data_source: DERIV_SOURCE,
    latest_candle_time: Number(latest?.time || 0),
    candle_close: closed.close,
    candle_current: closed.current,
    ts: nowMs,
    sentiment_score: 50,
    sentiment_source: 'derived',
    news: { available: false, reason: 'technical_only' },
    meta: { mode: 'technical', reason: 'analysed_in_browser', engines: [], spent: 0, cap: 0, cached: false, at: new Date(nowMs).toISOString() }
  };
}

/** "4 min", "3 h", "2 days" — for sentences about how old the newest candle is. */
export function ageText(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 90) return s + ' s';
  if (s < 90 * 60) return Math.round(s / 60) + ' min';
  if (s < 48 * 3600) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' days';
}

/* Start of the newest 1-minute candle of a reading, in epoch seconds; 0 when the reading carries none. */
function candleSeconds(reading) {
  const raw = Number(reading && reading.latest_candle_time);
  if (!(raw > 0)) return 0;
  return raw > 1e12 ? raw / 1000 : raw;
}

/** Seconds since the newest 1-minute candle of a reading started; null when the reading carries no candle time. */
export function candleAgeSec(reading, nowMs) {
  const seconds = candleSeconds(reading);
  if (!seconds) return null;
  return Math.max(0, Math.round(nowMs / 1000 - seconds));
}

/** The state of a reading as set by the hosted scan; '' for readings from anywhere else (PC app, Exness). */
export function signalState(reading) {
  return String((reading && reading.data_state) || '');
}

/** Counts per state and per place of computation, for the status line and for diagnostics. */
export function summarizeReadings(readings) {
  const out = { total: 0, live: 0, daily: 0, stale: 0, noData: 0, unavailable: 0, browser: 0, cloud: 0 };
  for (const r of readings || []) {
    if (!r) continue;
    out.total += 1;
    const state = signalState(r);
    if (state === 'live') out.live += 1;
    else if (state === 'daily') out.daily += 1;
    else if (state === 'stale') out.stale += 1;
    else if (state === 'no-data') out.noData += 1;
    else if (state === 'unavailable') out.unavailable += 1;
    if (!r.error && r.computed === 'browser') out.browser += 1;
    if (!r.error && r.computed === 'cloud') out.cloud += 1;
  }
  return out;
}

function staleReading(symbol, ageSec, computed, latestCandleTime) {
  const known = ageSec != null;
  return {
    symbol, error: 'STALE_DATA', data_state: 'stale', computed,
    detail: known
      ? 'The newest 1-minute candle for ' + symbol + ' is ' + ageText(ageSec) + ' old, so the market is closed or the feed is paused. No current reading is shown.'
      : 'The reading for ' + symbol + ' carries no candle time, so it cannot be confirmed as current. No reading is shown.',
    source: DERIV_SOURCE,
    data_source: DERIV_SOURCE + (known ? ' · last candle ' + ageText(ageSec) + ' ago' : ' · candle time unknown'),
    latest_candle_time: latestCandleTime || 0
  };
}

/* The feed is current again after a pause, but every finished candle is from before it (closedcandles.js).
   The PC's own server sends the same row for this state (server/app.js, resumedAnswer). */
export function resumedReading(reading) {
  return {
    symbol: reading.symbol, error: 'STALE_DATA', data_state: 'stale', computed: reading.computed,
    detail: reading.symbol + ' has just resumed after a pause: no 5-minute candle has closed since, so a reading would describe the market before the pause. The first reading comes with the next 5-minute close.',
    source: DERIV_SOURCE,
    data_source: DERIV_SOURCE + ' \u00b7 resumed, waiting for a finished candle',
    latest_candle_time: reading.latest_candle_time || 0
  };
}

/* Marked as not current, with a direction, but without the 5-minute close it would belong to. No server of this
   project sends that. Nothing says which candles it was made from, so it is not shown and fills no order ticket. */
function unconfirmedReading(reading) {
  return {
    symbol: reading.symbol, error: 'STALE_DATA', data_state: 'stale', computed: reading.computed,
    detail: 'The reading for ' + reading.symbol + ' is marked as not current and names no 5-minute close, so it cannot be confirmed. No reading is shown.',
    source: DERIV_SOURCE,
    data_source: DERIV_SOURCE + ' \u00b7 not confirmed as current',
    latest_candle_time: reading.latest_candle_time || 0
  };
}

/**
 * What is shown in place of a reading that is marked candle_current:false (closedcandles.js), or null when the
 * reading is shown as it is. The mark alone does not say why a reading is not current:
 *
 *   with the close it belongs to (candle_close > 0)
 *       every finished candle is from before a pause: the row of resumedReading().
 *   without one (candle_close 0)
 *       the history holds no finished 5-minute candle. That is missing history, not a pause. Such a reading is a
 *       WAIT that says so itself, and it is shown as that. A BUY or SELL without a close is withheld.
 *
 * Used for the cloud viewer's readings below and, in main.js, for the answers of the PC's own server, so that
 * both show the same row for the same answer.
 */
export function withheldReading(reading) {
  if (!reading || reading.candle_current !== false) return null;
  if (Number(reading.candle_close) > 0) return resumedReading(reading);
  return reading.signal === 'BUY' || reading.signal === 'SELL' ? unconfirmedReading(reading) : null;
}

function noDataReading(symbol, reason) {
  return {
    symbol, error: 'NO_DATA', data_state: 'no-data', computed: 'browser',
    detail: 'Deriv has no usable candle history for ' + symbol + ' right now (' + String(reason || 'no candles returned').slice(0, 180) + ').',
    source: DERIV_SOURCE, data_source: DERIV_SOURCE + ' · no usable history'
  };
}

function unavailableReading(symbol, detail, dataSource) {
  return { symbol, error: 'FEED_ERROR', data_state: 'unavailable', detail: String(detail).slice(0, 420), source: 'unavailable', data_source: dataSource };
}

/**
 * @param {object}   deps
 * @param {Function} deps.fetchCandles  (symbol, granularity, count) => Promise<candles>; rejects with a CandleError
 * @param {Function} deps.cloudScan     (symbols[]) => Promise<Map<symbol, reading>>; the AURUM cloud's /api/signals/scan
 * @param {Function} [deps.now]         () => epoch milliseconds on this device
 * @param {Function} [deps.feedClock]   () => { epochMs, seenAtMs } | null; Deriv's clock as seen through live ticks
 * @param {Function} [deps.onScan]      (report) => void; one call per scan, for the status line and diagnostics
 */
export function createHostedScanner({ fetchCandles, cloudScan, now = () => Date.now(), feedClock = () => null, onScan = null }) {
  const cloudCache = new Map(); // symbol -> { at, reading }; readings without an error only
  /* Set when this browser could not reach Deriv for any market of a scan. Until
     the time given, scans go straight to the AURUM cloud: a visitor whose
     network blocks Deriv does not wait for the same failure before every
     reading, and the cloud is asked once per scan instead of twice. */
  let browserPausedUntil = 0;
  let browserFailure = null;

  const feedNowMs = () => feedTimeMs(now(), feedClock());

  async function analyseInBrowser(symbol) {
    const settled = await Promise.allSettled(SCAN_TIMEFRAMES.map(([, granularity]) => fetchCandles(symbol, granularity, SCAN_CANDLES)));
    const failures = settled.filter((x) => x.status === 'rejected').map((x) => x.reason);
    /* A feed-level failure decides what happens next (ask the AURUM cloud), so it wins over a data-level one. */
    if (failures.length) return { symbol, failure: failures.find(isFeedFailure) || failures[0] };
    const [m1, m5, h1] = settled.map((x) => x.value);
    try { return { symbol, reading: buildDerivReading(symbol, { m1, m5, h1 }, now()) }; }
    catch (error) { return { symbol, failure: error }; }
  }

  /* Readings from the AURUM cloud, one entry per requested symbol. Never
     rejects. A reading is reused for a short time (see the TTLs above); a
     failure is never kept. */
  async function cloudReadings(symbols) {
    const out = new Map();
    const ask = [];
    for (const symbol of symbols) {
      const hit = cloudCache.get(symbol);
      if (hit && now() - hit.at < (isDerivBacked(symbol) ? CLOUD_DERIV_TTL_MS : CLOUD_INDEX_TTL_MS)) out.set(symbol, hit.reading);
      else ask.push(symbol);
    }
    if (!ask.length) return out;
    try {
      const found = await cloudScan(ask);
      for (const symbol of ask) {
        const reading = found && found.get(symbol);
        if (!reading) { out.set(symbol, { symbol, error: 'FEED_ERROR', detail: 'no reading returned for ' + symbol + '.' }); continue; }
        out.set(symbol, reading);
        if (!reading.error) cloudCache.set(symbol, { at: now(), reading });
      }
    } catch (error) {
      const detail = 'no answer (' + String((error && error.message) || error || 'request failed').slice(0, 160) + ').';
      for (const symbol of ask) out.set(symbol, { symbol, error: 'FEED_ERROR', detail });
    }
    return out;
  }

  function labelCloud(reading) {
    const base = reading.source ? String(reading.source) : (isDerivBacked(reading.symbol) ? DERIV_SOURCE : YAHOO_SOURCE);
    const label = base + CLOUD_SUFFIX;
    return { ...reading, source: label, data_source: label, computed: 'cloud', fallback: true };
  }

  /* Why the AURUM cloud has no reading, in its own words, and marked as the cloud's reason. */
  function cloudReason(reading) {
    return 'AURUM cloud: ' + String((reading && reading.detail) || 'no answer').slice(0, 200);
  }

  /* live or stale, by the age of the newest 1-minute candle. */
  function byFreshness(reading, nowMs) {
    const age = candleAgeSec(reading, nowMs);
    if (age == null || age > LIVE_MAX_AGE_SEC) return staleReading(reading.symbol, age, reading.computed, reading.latest_candle_time);
    return withheldReading(reading) || { ...reading, data_state: 'live' };
  }

  /**
   * One reading per requested symbol, in the order given. Never rejects:
   * whatever went wrong is reported as that symbol's state.
   *
   * `browser: false` keeps this browser away from Deriv and asks the AURUM
   * cloud for everything. The application uses it on the sign-in screen, where
   * no connection to a third party is opened before the visitor enters.
   *
   * After a scan in which this browser could not reach Deriv for any market,
   * the scans of the next minute skip the browser and ask the cloud directly;
   * then the browser is tried again.
   */
  async function scan(symbols, { browser = true } = {}) {
    const startedAt = now();
    const requested = (symbols || []).map((s) => String(s || '')).filter(Boolean);
    const unique = [...new Set(requested)];
    const deriv = unique.filter(isDerivBacked);
    const other = unique.filter((s) => !isDerivBacked(s));

    /* Paused: the last scan showed that this browser cannot reach Deriv. Its
       reason stands for every market, and the cloud is asked for all of them at once. */
    const paused = !!browser && startedAt < browserPausedUntil;
    const readHere = !!browser && !paused;
    const [attempts, cloud] = await Promise.all([
      readHere ? Promise.all(deriv.map(analyseInBrowser)) : Promise.resolve(paused ? deriv.map((symbol) => ({ symbol, failure: browserFailure })) : []),
      cloudReadings(readHere ? other : unique)
    ]);
    const tried = new Map(attempts.map((x) => [x.symbol, x]));
    /* Markets this browser could not reach Deriv for: the AURUM cloud is the labelled fallback. */
    const unreachable = attempts.filter((x) => x.failure && isFeedFailure(x.failure)).map((x) => x.symbol);
    const notAskedYet = unreachable.filter((symbol) => !cloud.has(symbol));
    if (notAskedYet.length) for (const [symbol, reading] of await cloudReadings(notAskedYet)) cloud.set(symbol, reading);
    if (readHere && attempts.length) {
      if (unreachable.length === attempts.length) { browserPausedUntil = now() + BROWSER_RETRY_MS; browserFailure = attempts[0].failure; }
      else { browserPausedUntil = 0; browserFailure = null; }
    }

    /* "Now" for the freshness check. A candle cannot start in the future, so the
       newest candle among the markets of this scan is a floor for the current
       time: with a device clock that runs slow and no tick to correct it, a
       market that has just closed is still compared with the ones that are open. */
    const candleTimes = [...attempts.map((x) => x.reading), ...deriv.map((symbol) => cloud.get(symbol))]
      .map((reading) => candleSeconds(reading)).filter((seconds) => seconds > 0);
    const nowMs = Math.max(feedNowMs(), ...candleTimes.map((seconds) => seconds * 1000));
    const bySymbol = new Map();
    for (const symbol of deriv) {
      const attempt = tried.get(symbol); /* undefined when this browser was not used */
      if (attempt && attempt.reading) {
        bySymbol.set(symbol, byFreshness({ ...attempt.reading, source: BROWSER_LABEL, data_source: BROWSER_LABEL, computed: 'browser' }, nowMs));
        continue;
      }
      if (attempt && !isFeedFailure(attempt.failure)) {
        bySymbol.set(symbol, noDataReading(symbol, attempt.failure && attempt.failure.message));
        continue;
      }
      const fromCloud = cloud.get(symbol);
      if (fromCloud && !fromCloud.error) {
        bySymbol.set(symbol, byFreshness(labelCloud(fromCloud), nowMs));
        continue;
      }
      if (!attempt) bySymbol.set(symbol, unavailableReading(symbol, cloudReason(fromCloud), 'unavailable'));
      else {
        const here = String((attempt.failure && attempt.failure.message) || 'the Deriv public feed could not be reached').slice(0, 200);
        bySymbol.set(symbol, unavailableReading(symbol, 'This browser: ' + here + ' ' + cloudReason(fromCloud), 'Deriv public feed unreachable'));
      }
    }
    for (const symbol of other) {
      const fromCloud = cloud.get(symbol);
      if (fromCloud && !fromCloud.error) bySymbol.set(symbol, { ...labelCloud(fromCloud), data_state: 'daily' });
      else bySymbol.set(symbol, unavailableReading(symbol, cloudReason(fromCloud), 'unavailable'));
    }

    const readings = requested.map((symbol) => bySymbol.get(symbol));
    if (typeof onScan === 'function') {
      const problems = [...bySymbol.values()].filter((r) => r.error)
        .map((r) => ({ symbol: r.symbol, state: r.data_state, detail: String(r.detail || '').slice(0, 200) }));
      try {
        onScan({
          at: now(), ms: Math.max(0, now() - startedAt), ...summarizeReadings([...bySymbol.values()]),
          usedBrowser: readHere, browserPaused: paused, askedCloudForDeriv: browser ? unreachable.length : deriv.length, problems
        });
      } catch (_e) { /* a reporting problem must never break a scan */ }
    }
    return readings;
  }

  /** A person asked for a retry: the next scan tries this browser again instead of waiting out the pause. */
  function retryBrowser() { browserPausedUntil = 0; }

  return { scan, retryBrowser };
}
