/* ================================================================
 * AURUM — technical indicator library (pure functions, ESM)
 *
 * Corrections vs. the draft spec:
 *  - RSI: guards the degenerate flat-market case (0/0 -> 50) and the
 *    zero-loss / zero-gain cases properly (100 / 0).
 *  - MACD: signal line is an EMA over the MACD *series*, computed with
 *    correct index alignment — the draft's `ema([...closes, macdLine])`
 *    mixed prices with one MACD value and produced meaningless numbers.
 *  - ATR: standard True Range (first candle excluded from the average).
 *
 * Documented simplifications (deterministic, testable, good enough for
 * confluence scoring): RSI uses a simple average of the last N changes
 * (Cutler's RSI) rather than Wilder smoothing; ATR uses SMA of TR.
 * ================================================================ */

export function sma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Full EMA series aligned so out[i] corresponds to values[i + period - 1]. */
export function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function ema(values, period) {
  const series = emaSeries(values, period);
  return series ? series[series.length - 1] : null;
}

/** RSI over the last `period` price changes. Needs period+1 closes. */
export function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1 || period <= 0) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgGain === 0 && avgLoss === 0) return 50; // flat market
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD with a correctly computed signal line.
 * Requires at least slowPeriod + signalPeriod - 1 closes (34 by default).
 */
export function macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!Array.isArray(closes) || closes.length < slowPeriod + signalPeriod - 1) return null;
  const fast = emaSeries(closes, fastPeriod);
  const slow = emaSeries(closes, slowPeriod);
  if (!fast || !slow) return null;
  const offset = slowPeriod - fastPeriod;
  const lineSeries = slow.map((sv, i) => fast[i + offset] - sv);
  const signalSeries = emaSeries(lineSeries, signalPeriod);
  if (!signalSeries) return null;
  const line = lineSeries[lineSeries.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  return { line, signal, histogram: line - signal, lineSeries };
}

export function bollingerBands(closes, period = 20, stdDevMult = 2) {
  const mid = sma(closes, period);
  if (mid === null) return null;
  const slice = closes.slice(-period);
  const variance = slice.reduce((s, v) => s + (v - mid) * (v - mid), 0) / period;
  const sd = Math.sqrt(variance);
  return {
    mid,
    upper: mid + sd * stdDevMult,
    lower: mid - sd * stdDevMult,
    bandwidth: mid === 0 ? null : (2 * sd) / mid
  };
}

/** Average True Range via SMA of True Range (first candle has no TR). */
export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return sma(trs, period);
}

/**
 * Support / resistance from swing points inside `lookback` candles.
 * support  = swing lows below current price (nearest first)
 * resistance = swing highs above current price (nearest first)
 * Falls back to the lookback min/max when no swing qualifies.
 */
export function findLevels(candles, lookback = 50, maxLevels = 3) {
  const empty = { support: [], resistance: [] };
  if (!Array.isArray(candles) || candles.length < 3) return empty;
  const prices = candles.slice(-lookback);
  const current = prices[prices.length - 1].close;
  const support = [];
  const resistance = [];
  for (let i = 1; i < prices.length - 1; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];
    const next = prices[i + 1];
    if (cur.low < prev.low && cur.low <= next.low && cur.low < current) support.push(cur.low);
    if (cur.high > prev.high && cur.high >= next.high && cur.high > current) resistance.push(cur.high);
  }
  if (!support.length) support.push(Math.min(...prices.map((c) => c.low)));
  if (!resistance.length) resistance.push(Math.max(...prices.map((c) => c.high)));
  const uniq = (arr) => [...new Set(arr.map((v) => v.toFixed(8)))].map(Number);
  return {
    support: uniq(support).sort((a, b) => b - a).slice(0, maxLevels),
    resistance: uniq(resistance).sort((a, b) => a - b).slice(0, maxLevels)
  };
}
