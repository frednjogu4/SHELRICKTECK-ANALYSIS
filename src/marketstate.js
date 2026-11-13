/* ================================================================
 * Market state per timeframe: trend, structure and volatility.
 *
 * What this is. A description of one market on four timeframes (5 minutes,
 * 15 minutes, 1 hour, 4 hours), each with the numbers it was read from:
 *
 *   trend       are the averages in order (EMA 20 / 50 / 200), and is the
 *               market moving in one direction at all (ADX 14)?
 *   structure   the last two swing highs and the last two swing lows:
 *               higher highs and higher lows, lower ones, or a mixture
 *   volatility  the size of a candle now (ATR 14) against the same figure
 *               over the 200 candles before
 *
 * What it is not. It is not a signal and takes no part in one: the BUY, SELL
 * and WAIT of the 1m/5m/1h rule (server/lib/analyzer.js, localdecision.js)
 * are computed without anything in this file. A replay on gold, 2020 to 2026,
 * measured what became of that rule's alerts in each state (README, "Market
 * state"; scripts/state-replay.mjs; STATE_MEASURED below): alerts that pointed
 * with the 4-hour trend reached target 1 about two points more often than
 * those against it, and still fell short of break-even after the spread. So
 * nothing here is a reason to take or to skip a trade. It says what the chart
 * looks like.
 *
 * Finished candles only. In every series the newest candle may still be
 * forming, so it is never used; a state is "as of" the close of the candle
 * before it. Looking again before that timeframe's next close gives the same
 * state, and the swing points already found never move: a swing needs
 * SWING_SPAN finished candles after it before it counts, and from then on it
 * depends on no later candle. (The same rule as closedcandles.js: a candle
 * counts as finished only when its own series holds a later one.)
 *
 * Definitions are the ones a chart shows, so the figures can be checked
 * against TradingView or MetaTrader: EMA seeded with a simple average, ATR
 * and ADX with Wilder's smoothing. (Since 13 November 2026 the signal rule
 * computes its RSI and ATR the same way, in server/lib/indicators.js; before
 * that it used averages of the last 14 values. This file has its own series
 * either way, because it needs a value for every candle.)
 *
 * Nothing is estimated. Too few candles, candles out of order or a series
 * that could not be read give `ok: false` with the reason, never a state.
 *
 * Pure functions: no DOM, no network, no clock other than the one passed in.
 * ================================================================ */

import { emaSeries } from '../server/lib/indicators.js';
import { wilder } from '../server/lib/indicators.ext.js';
import { eatClock, eatDay } from './newsimpact.js';

/** The four timeframes of the view, shortest first. */
export const STATE_TIMEFRAMES = Object.freeze([
  Object.freeze({ key: 'm5', label: 'M5', name: '5 minutes', seconds: 300 }),
  Object.freeze({ key: 'm15', label: 'M15', name: '15 minutes', seconds: 900 }),
  Object.freeze({ key: 'h1', label: 'H1', name: '1 hour', seconds: 3600 }),
  Object.freeze({ key: 'h4', label: 'H4', name: '4 hours', seconds: 14400 })
]);
/**
 * Candles asked for per timeframe. EMA 200 starts from a simple average of
 * its first 200 closes; after 400 more candles that start weighs under 2%, so
 * the figure is the one a chart with a long history shows.
 */
export const STATE_CANDLES = 600;
/**
 * Fewer finished candles than this give no state. At 400 the simple average
 * EMA 200 started from still weighs about 14% in it; with fewer, the figure
 * drifts away from the one a chart with a long history shows.
 */
export const MIN_FINISHED = 400;
export const ATR_PERIOD = 14;
export const ADX_PERIOD = 14;
/** ADX at or above this, with the averages in order: a trend. Below ADX_RANGE: a range. Between the two: unclear. */
export const ADX_TREND = 25;
export const ADX_RANGE = 20;
/** A swing high is higher than the highs of this many candles before it and not lower than those of as many after it. */
export const SWING_SPAN = 5;
/** The candles the present ATR is compared with. */
export const VOL_WINDOW = 200;
/** Share of those candles with a smaller ATR, in percent: below 20 quiet, from 80 high, from 95 extreme. */
export const VOL_QUIET = 20;
export const VOL_HIGH = 80;
export const VOL_EXTREME = 95;
/** ATR against its value ATR_PERIOD candles earlier: more than this far apart is "rising" or "falling". */
export const VOL_CHANGE = 0.1;
/** Candles drawn in the sketch of one timeframe. */
export const SKETCH_CANDLES = 120;
/** The feed is current while its newest candle started less than this many candle widths ago (as in closedcandles.js). */
export const CURRENT_WIDTHS = 2;

const DEFAULTS = Object.freeze({ adxTrend: ADX_TREND, adxRange: ADX_RANGE, swingSpan: SWING_SPAN, minFinished: MIN_FINISHED });

/* Candle times are epoch seconds on every feed used here; milliseconds are accepted as well. */
function startSec(candle) {
  const raw = Number(candle && candle.time);
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  return raw > 1e12 ? raw / 1000 : raw;
}

/**
 * The rows of a series that are real candles: a time, four finite positive
 * prices, the high not below and the low not above the other three. The same
 * rule as derivhistory.js; applied again here because the PC's server checks
 * less. `ordered` is false when a time is not later than the one before it.
 */
export function cleanCandles(raw) {
  const candles = [];
  let dropped = 0, ordered = true, previous = 0;
  if (!Array.isArray(raw)) return { candles, dropped, ordered };
  for (const row of raw) {
    const time = startSec(row);
    const open = Number(row && row.open), high = Number(row && row.high), low = Number(row && row.low), close = Number(row && row.close);
    const prices = [open, high, low, close];
    if (!time || !prices.every((value) => Number.isFinite(value) && value > 0) || high < Math.max(open, close, low) || low > Math.min(open, close, high)) { dropped++; continue; }
    if (time <= previous) ordered = false;
    previous = time;
    candles.push({ time, open, high, low, close });
  }
  return { candles, dropped, ordered };
}

/** EMA of `period` over `values`, one entry per value; null until `period` values exist. */
export function emaAligned(values, period) {
  const out = new Array(values.length).fill(null);
  const series = emaSeries(values, period);
  if (series) for (let i = 0; i < series.length; i++) out[i + period - 1] = series[i];
  return out;
}

/* True range of every candle from the second on (the first has no close before it). */
function trueRanges(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high, low = candles[i].low, before = candles[i - 1].close;
    out.push(Math.max(high - low, Math.abs(high - before), Math.abs(low - before)));
  }
  return out;
}

/** ATR with Wilder's smoothing, one entry per candle; null for the first `period` candles. */
export function atrSeries(candles, period = ATR_PERIOD) {
  const out = new Array(candles.length).fill(null);
  const smoothed = wilder(trueRanges(candles), period);
  if (smoothed) for (let i = 0; i < smoothed.length; i++) out[i + period] = smoothed[i];
  return out;
}

/**
 * ADX with +DI and -DI, one entry per candle. The same arithmetic as adx() in
 * server/lib/indicators.ext.js, which gives the last value only; the series
 * is needed here to say for how long a state has held. DI exists from candle
 * `period` on, ADX from candle `2 * period - 1` on.
 */
export function adxSeries(candles, period = ADX_PERIOD) {
  const n = candles.length;
  const out = { adx: new Array(n).fill(null), plusDI: new Array(n).fill(null), minusDI: new Array(n).fill(null) };
  const plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high, down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const range = wilder(trueRanges(candles), period), plus = wilder(plusDM, period), minus = wilder(minusDM, period);
  if (!range || !plus || !minus) return out;
  const dx = [];
  for (let i = 0; i < range.length; i++) {
    const plusDI = range[i] > 0 ? (100 * plus[i]) / range[i] : 0, minusDI = range[i] > 0 ? (100 * minus[i]) / range[i] : 0;
    out.plusDI[i + period] = plusDI;
    out.minusDI[i + period] = minusDI;
    dx.push(plusDI + minusDI > 0 ? (100 * Math.abs(plusDI - minusDI)) / (plusDI + minusDI) : 0);
  }
  const smoothed = wilder(dx, period);
  if (smoothed) for (let i = 0; i < smoothed.length; i++) out.adx[i + 2 * period - 1] = smoothed[i];
  return out;
}

/**
 * The trend state of one candle from its close, the three averages and ADX.
 *
 *   RANGE    ADX below 20: the market is not moving in one direction,
 *            whatever order the averages are in
 *   UP       ADX 25 or more, EMA 20 above EMA 50 above EMA 200, close above EMA 50
 *   DOWN     ADX 25 or more, EMA 20 below EMA 50 below EMA 200, close below EMA 50
 *   UNCLEAR  everything else: ADX between 20 and 25, or a strong move with
 *            the averages not in order
 *
 * null when one of the five figures does not exist yet.
 */
export function trendStateOf({ close, ema20, ema50, ema200, adx }, { adxTrend = ADX_TREND, adxRange = ADX_RANGE } = {}) {
  if (![close, ema20, ema50, ema200, adx].every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  if (adx < adxRange) return 'RANGE';
  if (adx >= adxTrend && close > ema50 && ema20 > ema50 && ema50 > ema200) return 'UP';
  if (adx >= adxTrend && close < ema50 && ema20 < ema50 && ema50 < ema200) return 'DOWN';
  return 'UNCLEAR';
}

/** 'up', 'down' or 'mixed': the order of the three averages and the close, without ADX. */
export function stackOf({ close, ema20, ema50, ema200 }) {
  if (close > ema50 && ema20 > ema50 && ema50 > ema200) return 'up';
  if (close < ema50 && ema20 < ema50 && ema50 < ema200) return 'down';
  return 'mixed';
}

/**
 * Swing highs and lows of finished candles, oldest first.
 *
 * A candle is a swing high when its high is above the highs of the `span`
 * candles before it and not below those of the `span` candles after it (of
 * two equal highs the earlier one counts); a swing low likewise. It needs all
 * `span` later candles, so the newest swing is at least that old, and once it
 * is found no later candle changes it.
 *
 * @returns {Array<{index:number, time:number, price:number, kind:'high'|'low'}>}
 */
export function swingPoints(candles, span = SWING_SPAN) {
  const out = [];
  for (let i = span; i < candles.length - span; i++) {
    let high = true, low = true;
    for (let j = 1; j <= span && (high || low); j++) {
      if (candles[i - j].high >= candles[i].high || candles[i + j].high > candles[i].high) high = false;
      if (candles[i - j].low <= candles[i].low || candles[i + j].low < candles[i].low) low = false;
    }
    const last = out[out.length - 1];
    const asHigh = { index: i, time: candles[i].time, price: candles[i].high, kind: 'high' };
    const asLow = { index: i, time: candles[i].time, price: candles[i].low, kind: 'low' };
    /* One candle that is both: the one that continues the alternation comes first. */
    if (high && low) out.push(...(last && last.kind === 'high' ? [asLow, asHigh] : [asHigh, asLow]));
    else if (high) out.push(asHigh);
    else if (low) out.push(asLow);
  }
  return out;
}

/**
 * Swings in turn: high, low, high, low. Of two swing highs with no swing low
 * between them the higher one stays, of two such lows the lower one. This is
 * what "the last high" and "the high before it" mean on a chart.
 */
export function alternatingSwings(points) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || last.kind !== point.kind) out.push(point);
    else if (point.kind === 'high' ? point.price > last.price : point.price < last.price) out[out.length - 1] = point;
  }
  return out;
}

function compare(later, earlier) { return later.price > earlier.price ? 'higher' : later.price < earlier.price ? 'lower' : 'equal'; }

/**
 * Every swing with its mark against the swing of the same kind before it:
 * HH / LH / EH for a higher, lower or equal high, HL / LL / EL for a low, and
 * H or L for the first of its kind, which has nothing to be compared with.
 */
export function markSwings(swings) {
  const before = { high: null, low: null };
  return swings.map((swing) => {
    const earlier = before[swing.kind];
    before[swing.kind] = swing;
    const letter = swing.kind === 'high' ? 'H' : 'L';
    if (!earlier) return { ...swing, mark: letter };
    return { ...swing, mark: { higher: 'H', lower: 'L', equal: 'E' }[compare(swing, earlier)] + letter };
  });
}

/**
 * Structure from the last two swing highs and the last two swing lows.
 *
 *   UP           higher high and higher low
 *   DOWN         lower high and lower low
 *   WIDENING     higher high and lower low
 *   NARROWING    lower high and higher low
 *   MIXED        one of the two pairs is level
 *   UNKNOWN      fewer than two swing highs or two swing lows in the candles read
 *
 * `position` says where the last finished close is against the last swing
 * high and the last swing low: 'above' the high, 'below' the low or 'inside'.
 */
export function structureOf(swings, lastClose) {
  const highs = swings.filter((swing) => swing.kind === 'high'), lows = swings.filter((swing) => swing.kind === 'low');
  if (highs.length < 2 || lows.length < 2) return { state: 'UNKNOWN', highs: null, lows: null, lastHigh: highs[highs.length - 1] || null, prevHigh: null, lastLow: lows[lows.length - 1] || null, prevLow: null, position: null };
  const lastHigh = highs[highs.length - 1], prevHigh = highs[highs.length - 2], lastLow = lows[lows.length - 1], prevLow = lows[lows.length - 2];
  const high = compare(lastHigh, prevHigh), low = compare(lastLow, prevLow);
  const state = high === 'equal' || low === 'equal' ? 'MIXED'
    : high === 'higher' && low === 'higher' ? 'UP'
    : high === 'lower' && low === 'lower' ? 'DOWN'
    : high === 'higher' ? 'WIDENING' : 'NARROWING';
  const position = lastClose > lastHigh.price ? 'above' : lastClose < lastLow.price ? 'below' : 'inside';
  return { state, highs: high, lows: low, lastHigh, prevHigh, lastLow, prevLow, position };
}

/**
 * Volatility of the last candle: its ATR against the ATR of the VOL_WINDOW
 * candles before it.
 *
 *   rank    share of those candles whose ATR was smaller, in percent
 *   state   QUIET below 20, NORMAL, HIGH from 80, EXTREME from 95
 *   ratio   ATR divided by the middle value (median) of those candles
 *   change  'rising' / 'falling' / 'steady': ATR against its value ATR_PERIOD
 *           candles earlier, more than 10% apart or not
 *
 * null when the ATR of the last candle or of one candle of the window does not exist.
 */
export function volatilityOf(atr, closes) {
  const last = atr.length - 1;
  const now = atr[last];
  if (last - VOL_WINDOW < 0 || typeof now !== 'number') return null;
  const window = atr.slice(last - VOL_WINDOW, last);
  if (!window.every((value) => typeof value === 'number')) return null;
  const smaller = window.filter((value) => value < now).length;
  const rank = (100 * smaller) / window.length;
  const sorted = [...window].sort((a, b) => a - b);
  const median = (sorted[VOL_WINDOW / 2 - 1] + sorted[VOL_WINDOW / 2]) / 2;
  const earlier = atr[last - ATR_PERIOD];
  const changePct = typeof earlier === 'number' && earlier > 0 ? now / earlier - 1 : null;
  return {
    state: rank >= VOL_EXTREME ? 'EXTREME' : rank >= VOL_HIGH ? 'HIGH' : rank < VOL_QUIET ? 'QUIET' : 'NORMAL',
    atr: now,
    atrPct: (100 * now) / closes[last],
    rank,
    ratio: median > 0 ? now / median : null,
    change: changePct == null ? null : changePct > VOL_CHANGE ? 'rising' : changePct < -VOL_CHANGE ? 'falling' : 'steady',
    changePct
  };
}

function unavailable(timeframe, reason, extra = {}) {
  return { ok: false, timeframe: timeframe.key, label: timeframe.label, name: timeframe.name, seconds: timeframe.seconds, reason, ...extra };
}

/**
 * The state of one timeframe from the candles the feed returned, oldest first.
 *
 * @param {Array}  raw        candles { time, open, high, low, close }; the newest may still be forming
 * @param {object} timeframe  one of STATE_TIMEFRAMES
 * @param {object} [options]  thresholds; the defaults are the constants above (the replay script tries others)
 * @returns {object} `ok: true` with trend, structure, volatility and the candles for the sketch, or
 *          `ok: false` with `reason`: 'NO_CANDLES' | 'OUT_OF_ORDER' | 'NOT_ENOUGH_CANDLES' (with `have`, `need`)
 */
export function timeframeState(raw, timeframe, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const { candles: clean, dropped, ordered } = cleanCandles(raw);
  if (!clean.length) return unavailable(timeframe, 'NO_CANDLES', { dropped });
  if (!ordered) return unavailable(timeframe, 'OUT_OF_ORDER', { dropped });
  /* The newest candle may still be forming: everything before it has finished. */
  const candles = clean.slice(0, -1);
  const newestStart = clean[clean.length - 1].time;
  if (candles.length < settings.minFinished) return unavailable(timeframe, 'NOT_ENOUGH_CANDLES', { have: candles.length, need: settings.minFinished, newestStart, dropped });

  const last = candles.length - 1;
  const closes = candles.map((candle) => candle.close);
  const ema20 = emaAligned(closes, 20), ema50 = emaAligned(closes, 50), ema200 = emaAligned(closes, 200);
  const dmi = adxSeries(candles), atr = atrSeries(candles);
  const figuresAt = (i) => ({ close: closes[i], ema20: ema20[i], ema50: ema50[i], ema200: ema200[i], adx: dmi.adx[i] });
  const state = trendStateOf(figuresAt(last), settings);
  /* Only with a lowered `minFinished`: EMA 200 does not exist before 200 closes. */
  if (state === null) return unavailable(timeframe, 'NOT_ENOUGH_CANDLES', { have: candles.length, need: Math.max(settings.minFinished, 200), newestStart, dropped });

  /* For how many candles the trend state has been the present one, counted back from the last. */
  let first = last;
  while (first > 0 && trendStateOf(figuresAt(first - 1), settings) === state) first--;
  /* `sinceOpen`: the run reaches the first candle at which a state exists, so it may be longer than counted. */
  const sinceOpen = trendStateOf(figuresAt(first - 1), settings) === null;

  const swings = markSwings(alternatingSwings(swingPoints(candles, settings.swingSpan)));
  const structure = structureOf(swings, closes[last]);
  const volatility = volatilityOf(atr, closes);

  /* The sketch shows the last SKETCH_CANDLES candles, and as far back as the four swings the structure
     was read from when they are older, up to twice that many. */
  const used = [structure.prevHigh, structure.prevLow].filter(Boolean).map((swing) => swing.index - settings.swingSpan);
  const from = Math.max(0, candles.length - 2 * SKETCH_CANDLES, Math.min(candles.length - SKETCH_CANDLES, ...used));
  return {
    ok: true, timeframe: timeframe.key, label: timeframe.label, name: timeframe.name, seconds: timeframe.seconds,
    /* The close of the last finished candle: the moment this state belongs to. */
    asOf: candles[last].time + timeframe.seconds,
    newestStart,
    candles: candles.length,
    dropped,
    price: closes[last],
    trend: {
      state, stack: stackOf(figuresAt(last)),
      ema20: ema20[last], ema50: ema50[last], ema200: ema200[last],
      adx: dmi.adx[last], plusDI: dmi.plusDI[last], minusDI: dmi.minusDI[last],
      candlesInState: last - first + 1, since: candles[first].time + timeframe.seconds, sinceOpen
    },
    structure,
    volatility: volatility || { state: 'UNKNOWN', atr: atr[last], atrPct: null, rank: null, ratio: null, change: null, changePct: null },
    sketch: {
      candles: candles.slice(from),
      ema50: ema50.slice(from), ema200: ema200.slice(from),
      swings: swings.filter((swing) => swing.index >= from).map((swing) => ({ ...swing, index: swing.index - from }))
    }
  };
}

/**
 * The four trend states side by side.
 *
 *   INCOMPLETE    a timeframe has no state: nothing is said about the whole
 *   ALIGNED_UP    all four are UP              ALIGNED_DOWN  all four are DOWN
 *   CONFLICT      one is UP and another DOWN: named, not resolved
 *   PARTIAL_UP    some are UP, the rest RANGE or UNCLEAR   (PARTIAL_DOWN likewise)
 *   NO_TREND      none is UP or DOWN
 *
 * @param {Array} readings  results of timeframeState(), in any order
 */
export function summarizeStates(readings) {
  /* Named longest first, the way a chart is read: the larger picture, then the smaller. */
  const list = (Array.isArray(readings) ? [...readings] : []).sort((a, b) => ((b && b.seconds) || 0) - ((a && a.seconds) || 0));
  const missing = list.filter((reading) => !reading || !reading.ok).map((reading) => (reading && reading.label) || '?');
  const labelsOf = (state) => list.filter((reading) => reading && reading.ok && reading.trend.state === state).map((reading) => reading.label);
  const up = labelsOf('UP'), down = labelsOf('DOWN'), range = labelsOf('RANGE'), unclear = labelsOf('UNCLEAR');
  /* `sequence`: every timeframe with its state, longest first; null for one without a state. */
  const sequence = list.map((reading) => ({ label: (reading && reading.label) || '?', state: reading && reading.ok ? reading.trend.state : null }));
  const groups = { up, down, range, unclear, missing, sequence };
  if (!list.length || missing.length) return { state: 'INCOMPLETE', ...groups };
  if (up.length && down.length) return { state: 'CONFLICT', ...groups };
  if (up.length === list.length) return { state: 'ALIGNED_UP', ...groups };
  if (down.length === list.length) return { state: 'ALIGNED_DOWN', ...groups };
  if (up.length) return { state: 'PARTIAL_UP', ...groups };
  if (down.length) return { state: 'PARTIAL_DOWN', ...groups };
  return { state: 'NO_TREND', ...groups };
}

/**
 * Is the feed current? Judged by the newest candle of the shortest timeframe
 * that was read: it started less than two of its candle widths ago. Otherwise
 * the market is closed or the feed has paused, and every state shown is the
 * one of its last close before that.
 *
 * @param {Array}  readings  results of timeframeState()
 * @param {number} nowSec    the time now, epoch seconds (the feed's clock when a recent tick tells it)
 * @returns {{current:boolean, newestStart:number, ageSec:number|null, label:string|null}}
 */
export function feedFreshness(readings, nowSec) {
  const shortest = (Array.isArray(readings) ? readings : []).filter((reading) => reading && Number(reading.newestStart) > 0 && Number(reading.seconds) > 0)
    .sort((a, b) => a.seconds - b.seconds)[0];
  if (!shortest || !(nowSec > 0)) return { current: false, newestStart: 0, ageSec: null, label: null };
  const ageSec = Math.max(0, Math.round(nowSec - shortest.newestStart));
  return { current: ageSec < CURRENT_WIDTHS * shortest.seconds, newestStart: shortest.newestStart, ageSec, label: shortest.label };
}

/* ---------------------------------------------------------------- words */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A moment on the Nairobi clock: '16:30' on the Nairobi day of `nowSec`,
 * '13 Nov 16:30' on any other day. '' for no time.
 */
export function eatMoment(sec, nowSec) {
  if (!(sec > 0) || !Number.isFinite(sec)) return '';
  const ms = sec * 1000;
  if (nowSec > 0 && eatDay(ms) === eatDay(nowSec * 1000)) return eatClock(ms);
  const [, month, day] = eatDay(ms).split('-');
  return Number(day) + ' ' + MONTHS[Number(month) - 1] + ' ' + eatClock(ms);
}

export const TREND_WORDS = Object.freeze({ UP: 'Uptrend', DOWN: 'Downtrend', RANGE: 'Range', UNCLEAR: 'Unclear' });
/** "Higher highs, higher lows", "Lower highs, higher lows", "Equal highs, lower lows", ... */
export function structureWords(structure) {
  if (!structure || !structure.highs || !structure.lows) return 'Not enough swings';
  return structure.highs.charAt(0).toUpperCase() + structure.highs.slice(1) + ' highs, ' + structure.lows + ' lows';
}
export const VOLATILITY_WORDS = Object.freeze({ QUIET: 'Quiet', NORMAL: 'Normal', HIGH: 'High', EXTREME: 'Extreme', UNKNOWN: 'Unknown' });
export const UNAVAILABLE_WORDS = Object.freeze({
  NO_CANDLES: 'The feed returned no usable candles.',
  OUT_OF_ORDER: 'The candles came back out of order, so they are not used.',
  NOT_ENOUGH_CANDLES: 'Not enough finished candles.',
  FEED: 'The candles could not be read.'
});

function listed(labels) {
  if (labels.length <= 1) return labels.join('');
  return labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
}

/**
 * The summary of summarizeStates() in words, the larger picture first, with
 * neighbouring timeframes in the same state named together:
 * "H4: unclear. H1 and M15: range. M5: downtrend."
 */
export function summaryText(summary) {
  if (!summary) return '';
  if (summary.state === 'INCOMPLETE') return 'No summary: ' + listed(summary.missing) + (summary.missing.length === 1 ? ' has' : ' have') + ' no state.';
  if (summary.state === 'ALIGNED_UP') return 'All timeframes: uptrend.';
  if (summary.state === 'ALIGNED_DOWN') return 'All timeframes: downtrend.';
  const parts = [];
  for (const { label, state } of summary.sequence) {
    const last = parts[parts.length - 1];
    if (last && last.state === state) last.labels.push(label);
    else parts.push({ state, labels: [label] });
  }
  const told = parts.map((part) => listed(part.labels) + ': ' + TREND_WORDS[part.state].toLowerCase() + '.').join(' ');
  if (summary.state === 'CONFLICT') return 'The timeframes disagree. ' + told;
  if (summary.state === 'NO_TREND') return 'No timeframe is in a trend. ' + told;
  return told;
}

/* ---------------------------------------------------------------- what a replay measured */

const figure = (percent, alerts, needed) => Object.freeze({ percent, alerts, needed });

/**
 * What became of the alerts of the 1m/5m/1h rule in each state, measured by
 * scripts/state-replay.mjs on gold, 2 January 2020 to 11 November 2026 (the
 * run and its limits are in the README, "Market state"). An alert is matched
 * with the trend state of a timeframe as of the 5-minute close it belongs to:
 * "with" is a BUY in an uptrend or a SELL in a downtrend, "against" the
 * reverse.
 *
 *   percent  share of finished alerts that reached target 1 before the stop
 *   alerts   alerts in the group
 *   needed   the share at which the group breaks even after `spread` dollars
 *            per alert, from its own average win and loss (for a single
 *            alert it is 40% before the spread)
 *
 * Fixed numbers from the run of 13 November 2026, made after the rule's RSI
 * and ATR were changed to Wilder's (with the former ones the same run gave
 * 41.1% of 12,614 alerts with the 4-hour trend and 38.9% of 11,615 against
 * it). They do not update by themselves, and
 * tests/platform/market-state.test.mjs keeps the README and this object equal.
 */
export const STATE_MEASURED = Object.freeze({
  market: 'gold', span: 'Jan 2020 \u2013 Nov 2026', spread: 0.25,
  all: figure(39.7, 72280, 42.6),
  h4With: figure(41.2, 11631, 42.9),
  h4Against: figure(39.0, 10963, 42.2),
  h1h4With: figure(41.4, 5616, 42.0),
  allFourWith: figure(42.2, 618, 40.1)
});

const thousands = (count) => count.toLocaleString('en-US');

/** The sentence under the heading of the view: what the 4-hour trend state did for the rule's alerts. */
export const STATE_MEASURED_TEXT = 'Measured in a replay on ' + STATE_MEASURED.market + ' (' + STATE_MEASURED.span + '): of the alerts of the 1m/5m/1h rule, '
  + STATE_MEASURED.h4With.percent + '% of the ' + thousands(STATE_MEASURED.h4With.alerts) + ' that pointed with the 4-hour trend reached target 1 before the stop, and '
  + STATE_MEASURED.h4Against.percent + '% of the ' + thousands(STATE_MEASURED.h4Against.alerts) + ' that pointed against it. About '
  + Math.round(STATE_MEASURED.h4With.needed) + '% is needed to break even after a spread of $' + STATE_MEASURED.spread.toFixed(2) + ', so both groups lost. Not a forecast.';
