/*
 * A read-only Smart Money Concepts playbook built from finished M5 candles.
 *
 * This is an educational checklist, not a trading signal, probability estimate,
 * or order path. It only calls a setup confirmed when its candle conditions are
 * met AND the H1/H4 trend states agree. No stops, targets, or entries are
 * invented. Every result is tied to closed candle timestamps.
 */
import { cleanCandles, atrSeries, swingPoints } from './marketstate.js';

export const SMC_SETUP_RULES = Object.freeze([
  Object.freeze({ key: 'break-retest', name: 'Break & retest', rule: 'A confirmed swing level breaks on a candle close, then price retests and closes back on the breakout side.' }),
  Object.freeze({ key: 'liquidity-mss', name: 'Liquidity sweep → MSS', rule: 'A wick sweeps a confirmed swing level and closes back inside; a later close breaks a confirmed opposing internal swing.' }),
  Object.freeze({ key: 'fvg-retest', name: 'FVG + imbalance retest', rule: 'A three-candle fair-value gap is found, then a later closed candle retests it and reacts in the gap direction.' })
]);

const NO_RESULT = 'No recent closed-candle setup found.';
const RECENT_CONFIRM_BARS = 3;
const MAX_BREAKOUT_AGE = 10;
const MAX_SWEEP_AGE = 12;
const MAX_LOOKBACK = 120;
const MAJOR_SWING_SPAN = 5;
const INTERNAL_SWING_SPAN = 2;

function validTrend(reading) {
  return !!(reading && reading.ok && reading.trend && ['UP', 'DOWN'].includes(reading.trend.state));
}

/** H1 and H4 must both be directional and agree; all other cases stand aside. */
export function smcHigherTimeframeBias(h1, h4) {
  if (!validTrend(h1) || !validTrend(h4)) return { direction: 'WAIT', reason: 'H1 and H4 both need a confirmed uptrend or downtrend.' };
  if (h1.trend.state !== h4.trend.state) return { direction: 'WAIT', reason: 'H1 and H4 disagree.' };
  return { direction: h1.trend.state === 'UP' ? 'BUY' : 'SELL', reason: 'H1 and H4 agree on ' + h1.trend.state.toLowerCase() + '.' };
}

function result(key, phase, direction, detail, bar, bias, level) {
  let status = phase;
  let reason = detail;
  if (phase === 'CONFIRMED') {
    if (bias.direction === 'WAIT') { status = 'WAIT'; reason += ' Higher-timeframe filter: ' + bias.reason; }
    else if (bias.direction !== direction) { status = 'CONFLICT'; reason += ' Opposes the H1/H4 ' + bias.direction + ' bias; filtered out.'; }
  }
  return { key, status, direction: direction || null, detail: reason, time: bar && bar.time || null, level: Number.isFinite(level) ? level : null };
}

function emptyResult(key, bias, detail = NO_RESULT) {
  return { key, status: 'NONE', direction: null, detail: bias.direction === 'WAIT' ? detail + ' H1/H4 filter: ' + bias.reason : detail, time: null, level: null };
}

function recentSwingPoints(candles, span, minIndex) {
  return swingPoints(candles, span).filter((point) => point.index >= minIndex);
}

function breakRetest(candles, majorSwings, tolerance, bias) {
  const n = candles.length, candidates = [];
  for (const pivot of majorSwings) {
    const direction = pivot.kind === 'high' ? 'BUY' : 'SELL';
    let breakout = -1;
    for (let i = pivot.index + 1; i < n; i++) {
      if (direction === 'BUY' ? candles[i].close > pivot.price + tolerance * 0.05 : candles[i].close < pivot.price - tolerance * 0.05) { breakout = i; break; }
    }
    if (breakout < 0 || n - 1 - breakout > MAX_BREAKOUT_AGE) continue;
    let retest = -1;
    for (let i = breakout + 1; i < n; i++) {
      const c = candles[i], touched = c.low <= pivot.price + tolerance && c.high >= pivot.price - tolerance;
      const rejected = direction === 'BUY' ? c.close > pivot.price && c.close > c.open : c.close < pivot.price && c.close < c.open;
      if (touched && rejected) { retest = i; break; }
    }
    candidates.push({ pivot, direction, breakout, retest });
  }
  candidates.sort((a, b) => Math.max(b.retest, b.breakout) - Math.max(a.retest, a.breakout));
  const c = candidates[0];
  if (!c) return emptyResult('break-retest', bias);
  if (c.retest >= 0 && n - 1 - c.retest <= RECENT_CONFIRM_BARS) return result('break-retest', 'CONFIRMED', c.direction, 'Swing level ' + c.pivot.price + ' broke on a close and was retested with a rejecting close.', candles[c.retest], bias, c.pivot.price);
  if (c.retest < 0) return result('break-retest', 'WAIT', c.direction, 'Break beyond ' + c.pivot.price + ' closed; wait for a retest and rejection. No entry is inferred.', candles[c.breakout], bias, c.pivot.price);
  return emptyResult('break-retest', bias, 'The last retest is older than ' + RECENT_CONFIRM_BARS + ' M5 bars; it is not presented as current.');
}

function liquidityMss(candles, majorSwings, internalSwings, tolerance, bias) {
  const n = candles.length, sweeps = [];
  for (const pivot of majorSwings) {
    const direction = pivot.kind === 'low' ? 'BUY' : 'SELL';
    for (let i = Math.max(pivot.index + 1, n - MAX_SWEEP_AGE - 1); i < n; i++) {
      const c = candles[i];
      const swept = direction === 'BUY'
        ? c.low < pivot.price - tolerance * 0.05 && c.close > pivot.price
        : c.high > pivot.price + tolerance * 0.05 && c.close < pivot.price;
      if (swept) sweeps.push({ pivot, direction, sweepIndex: i });
    }
  }
  sweeps.sort((a, b) => b.sweepIndex - a.sweepIndex);
  const sweep = sweeps[0];
  if (!sweep) return emptyResult('liquidity-mss', bias);
  const internalKind = sweep.direction === 'BUY' ? 'high' : 'low';
  const internal = internalSwings.filter((p) => p.kind === internalKind && p.index > sweep.pivot.index && p.index < sweep.sweepIndex).at(-1);
  if (!internal) return result('liquidity-mss', 'WAIT', sweep.direction, 'The ' + sweep.pivot.kind + ' at ' + sweep.pivot.price + ' was swept and reclaimed, but no confirmed internal swing is available for MSS.', candles[sweep.sweepIndex], bias, sweep.pivot.price);
  let shift = -1;
  for (let i = sweep.sweepIndex + 1; i < n; i++) {
    if (sweep.direction === 'BUY' ? candles[i].close > internal.price : candles[i].close < internal.price) { shift = i; break; }
  }
  if (shift >= 0 && n - 1 - shift <= RECENT_CONFIRM_BARS) return result('liquidity-mss', 'CONFIRMED', sweep.direction, 'Sweep and reclaim of ' + sweep.pivot.price + ', followed by an M5 close through internal swing ' + internal.price + '.', candles[shift], bias, internal.price);
  if (shift < 0) return result('liquidity-mss', 'WAIT', sweep.direction, 'Liquidity swept and reclaimed at ' + sweep.pivot.price + '; wait for a confirmed close through internal ' + internalKind + ' ' + internal.price + ' (MSS).', candles[sweep.sweepIndex], bias, internal.price);
  return emptyResult('liquidity-mss', bias, 'MSS confirmation is older than ' + RECENT_CONFIRM_BARS + ' M5 bars; it is not presented as current.');
}

function fvgRetest(candles, atr, bias) {
  const n = candles.length, gaps = [], minGap = Math.max((atr || 0) * 0.02, candles[n - 1].close * 1e-7);
  for (let i = Math.max(0, n - 40); i < n - 2; i++) {
    const first = candles[i], third = candles[i + 2];
    if (third.low - first.high > minGap) gaps.push({ direction: 'BUY', low: first.high, high: third.low, formed: i + 2 });
    if (first.low - third.high > minGap) gaps.push({ direction: 'SELL', low: third.high, high: first.low, formed: i + 2 });
  }
  if (!gaps.length) return emptyResult('fvg-retest', bias, 'No three-candle FVG of measurable size in the recent closed bars.');
  /* Prefer the newest gap that agrees with the higher-timeframe filter; if none does, expose the newest as a conflict/wait. */
  gaps.sort((a, b) => {
    const aAligned = bias.direction !== 'WAIT' && a.direction === bias.direction ? 1 : 0;
    const bAligned = bias.direction !== 'WAIT' && b.direction === bias.direction ? 1 : 0;
    return bAligned - aAligned || b.formed - a.formed;
  });
  const gap = gaps[0], midpoint = (gap.low + gap.high) / 2;
  let touch = -1, reaction = -1, invalidated = false;
  for (let i = gap.formed + 1; i < n; i++) {
    const c = candles[i];
    if (gap.direction === 'BUY' ? c.close < gap.low : c.close > gap.high) { invalidated = true; break; }
    const overlaps = c.low <= gap.high && c.high >= gap.low;
    if (!overlaps) continue;
    touch = i;
    const rejects = gap.direction === 'BUY' ? c.close > midpoint && c.close > c.open : c.close < midpoint && c.close < c.open;
    if (rejects) { reaction = i; break; }
  }
  if (invalidated) return emptyResult('fvg-retest', bias, 'The most recent ' + gap.direction + ' gap (' + gap.low + '–' + gap.high + ') closed through its far edge; it is invalidated.');
  if (reaction >= 0 && n - 1 - reaction <= RECENT_CONFIRM_BARS) return result('fvg-retest', 'CONFIRMED', gap.direction, 'Three-candle FVG ' + gap.low + '–' + gap.high + ' was revisited and rejected on a closed M5 candle.', candles[reaction], bias, midpoint);
  if (touch >= 0) return result('fvg-retest', 'WAIT', gap.direction, 'Price entered the FVG ' + gap.low + '–' + gap.high + '; wait for a closed M5 reaction candle.', candles[touch], bias, midpoint);
  return result('fvg-retest', 'WAIT', gap.direction, 'Recent three-candle FVG ' + gap.low + '–' + gap.high + ' is unfilled; wait for a retest.', candles[gap.formed], bias, midpoint);
}

/** Analyze the latest 120 completed M5 candles against the H1/H4 trend readings. */
export function evaluateSmcSetups(rawCandles, { h1 = null, h4 = null } = {}) {
  const bias = smcHigherTimeframeBias(h1, h4);
  const clean = cleanCandles(rawCandles);
  if (!clean.ordered) return { available: false, bias, reason: 'Candle times are not strictly increasing; no SMC read is made.', setups: [] };
  const candles = clean.candles.slice(-MAX_LOOKBACK);
  if (candles.length < 30) return { available: false, bias, reason: 'Fewer than 30 finished M5 candles; no SMC read is made.', setups: [] };
  const atr = atrSeries(candles).filter(Number.isFinite).at(-1) || 0;
  const tolerance = Math.max(atr * 0.15, candles.at(-1).close * 1e-7);
  const major = recentSwingPoints(candles, MAJOR_SWING_SPAN, Math.max(0, candles.length - 70));
  const internal = recentSwingPoints(candles, INTERNAL_SWING_SPAN, Math.max(0, candles.length - 50));
  const setups = [
    breakRetest(candles, major, tolerance, bias),
    liquidityMss(candles, major, internal, tolerance, bias),
    fvgRetest(candles, atr, bias)
  ];
  const confirmed = setups.filter((setup) => setup.status === 'CONFIRMED');
  const confluence = confirmed.length === 3 && confirmed.every((setup) => setup.direction === confirmed[0].direction) && bias.direction === confirmed[0].direction
    ? { status: 'ALIGNED', direction: confirmed[0].direction, count: 3, text: 'All three checklist patterns and the H1/H4 bias align. This is not entry, risk, or execution approval.' }
    : { status: 'WAIT', direction: null, count: confirmed.length, text: confirmed.length + ' of 3 setup patterns are confirmed on recent closed M5 candles; the full confluence checklist is not complete.' };
  return { available: true, bias, candles: candles.length, asOf: candles.at(-1).time, setups, confluence };
}
