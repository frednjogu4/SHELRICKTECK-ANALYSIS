/**
 * Pro Scalper indicator extensions.
 *
 * Pure, market-agnostic calculations over caller-supplied OHLCV candles.
 * The caller MUST supply chronologically ordered, validated, closed candles.
 * This module does not fetch prices, infer missing volume, or generate orders.
 *
 * Volume caveat: bar-level volume indicators are only valid where the feed
 * supplies genuine volume. Volume Profile is explicitly an OHLCV bar-close
 * approximation, not exchange tick-level volume-at-price.
 */

const finite = (v) => Number.isFinite(Number(v));
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function validCloses(values, minimum = 1) {
  return Array.isArray(values) && values.length >= minimum && values.every(finite);
}

function validCandles(candles, minimum = 1, requireVolume = false) {
  if (!Array.isArray(candles) || candles.length < minimum) return false;
  return candles.every((c) => {
    if (!c || ![c.open, c.high, c.low, c.close].every(finite)) return false;
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
    if (![o, h, l, cl].every((v) => v > 0) || h < Math.max(o, l, cl) || l > Math.min(o, h, cl)) return false;
    return !requireVolume || (finite(c.volume) && Number(c.volume) > 0);
  });
}

function trueRange(c, previousClose) {
  return Math.max(c.high - c.low, Math.abs(c.high - previousClose), Math.abs(c.low - previousClose));
}

function atrSeries(candles, period = 14) {
  if (!validCandles(candles, period + 1) || !Number.isInteger(period) || period < 1) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) ranges.push(trueRange(candles[i], candles[i - 1].close));
  let current = mean(ranges.slice(0, period));
  const out = new Array(candles.length).fill(null);
  out[period] = current;
  for (let i = period; i < ranges.length; i++) {
    current = ((current * (period - 1)) + ranges[i]) / period;
    out[i + 1] = current;
  }
  return out;
}

function rsiSeries(closes, period = 14) {
  if (!validCloses(closes, period + 1) || !Number.isInteger(period) || period < 1) return null;
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = Number(closes[i]) - Number(closes[i - 1]);
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  gain /= period; loss /= period;
  const value = () => gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : gain === 0 ? 0 : 100 - 100 / (1 + gain / loss);
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const d = Number(closes[i]) - Number(closes[i - 1]);
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

export function stochasticRsi(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  const series = rsiSeries(closes, rsiPeriod);
  if (!series || ![stochPeriod, smoothK, smoothD].every((n) => Number.isInteger(n) && n > 0)) return null;
  const raw = [];
  for (let i = 0; i < series.length; i++) {
    if (i < rsiPeriod + stochPeriod - 1 || series[i] == null) { raw.push(null); continue; }
    const window = series.slice(i - stochPeriod + 1, i + 1);
    if (window.some((v) => v == null)) { raw.push(null); continue; }
    const lo = Math.min(...window), hi = Math.max(...window);
    raw.push(hi === lo ? 50 : ((series[i] - lo) / (hi - lo)) * 100);
  }
  const smooth = (arr, period) => arr.map((v, i) => {
    const w = arr.slice(i - period + 1, i + 1);
    return i >= period - 1 && w.every((x) => Number.isFinite(x)) ? mean(w) : null;
  });
  const kSeries = smooth(raw, smoothK);
  const dSeries = smooth(kSeries, smoothD);
  const k = kSeries.at(-1), d = dSeries.at(-1);
  return Number.isFinite(k) && Number.isFinite(d) ? { k, d, raw: raw.at(-1) } : null;
}

export function cci(candles, period = 20) {
  if (!validCandles(candles, period) || !Number.isInteger(period) || period < 2) return null;
  const tp = candles.slice(-period).map((c) => (Number(c.high) + Number(c.low) + Number(c.close)) / 3);
  const avg = mean(tp);
  const deviation = mean(tp.map((v) => Math.abs(v - avg)));
  return deviation === 0 ? 0 : (tp.at(-1) - avg) / (0.015 * deviation);
}

export function williamsR(candles, period = 14) {
  if (!validCandles(candles, period) || !Number.isInteger(period) || period < 1) return null;
  const window = candles.slice(-period);
  const high = Math.max(...window.map((c) => Number(c.high)));
  const low = Math.min(...window.map((c) => Number(c.low)));
  return high === low ? -50 : ((high - Number(window.at(-1).close)) / (high - low)) * -100;
}

export function supertrend(candles, period = 10, multiplier = 3) {
  if (!validCandles(candles, period + 1) || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  const atr = atrSeries(candles, period);
  if (!atr) return null;
  let upper = null, lower = null, direction = null, line = null;
  for (let i = period; i < candles.length; i++) {
    const c = candles[i], mid = (Number(c.high) + Number(c.low)) / 2;
    const basicUpper = mid + multiplier * atr[i], basicLower = mid - multiplier * atr[i];
    if (upper == null) { upper = basicUpper; lower = basicLower; direction = c.close >= mid ? 'UP' : 'DOWN'; }
    else {
      const prevClose = Number(candles[i - 1].close);
      upper = basicUpper < upper || prevClose > upper ? basicUpper : upper;
      lower = basicLower > lower || prevClose < lower ? basicLower : lower;
      if (direction === 'DOWN' && Number(c.close) > upper) direction = 'UP';
      else if (direction === 'UP' && Number(c.close) < lower) direction = 'DOWN';
    }
    line = direction === 'UP' ? lower : upper;
  }
  return { value: line, direction, atr: atr.at(-1), period, multiplier };
}

export function ichimoku(candles, conversionPeriod = 9, basePeriod = 26, spanBPeriod = 52) {
  const maxPeriod = Math.max(conversionPeriod, basePeriod, spanBPeriod);
  if (!validCandles(candles, maxPeriod) || ![conversionPeriod, basePeriod, spanBPeriod].every((n) => Number.isInteger(n) && n > 0)) return null;
  const mid = (period) => {
    const w = candles.slice(-period);
    return (Math.max(...w.map((c) => Number(c.high))) + Math.min(...w.map((c) => Number(c.low)))) / 2;
  };
  const conversion = mid(conversionPeriod), base = mid(basePeriod), spanB = mid(spanBPeriod);
  return { conversion, base, spanA: (conversion + base) / 2, spanB, laggingClose: Number(candles.at(-1).close), displacement: basePeriod };
}

export function keltnerChannels(candles, emaPeriod = 20, atrPeriod = 10, multiplier = 2) {
  if (!validCandles(candles, Math.max(emaPeriod, atrPeriod + 1)) || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  const closes = candles.map((c) => Number(c.close));
  const k = 2 / (emaPeriod + 1);
  let mid = mean(closes.slice(0, emaPeriod));
  for (let i = emaPeriod; i < closes.length; i++) mid = closes[i] * k + mid * (1 - k);
  const atr = atrSeries(candles, atrPeriod)?.at(-1);
  if (!Number.isFinite(atr)) return null;
  return { mid, upper: mid + multiplier * atr, lower: mid - multiplier * atr, atr };
}

export function onBalanceVolume(candles) {
  if (!validCandles(candles, 2, true)) return null;
  let value = 0;
  for (let i = 1; i < candles.length; i++) {
    const change = Number(candles[i].close) - Number(candles[i - 1].close);
    if (change > 0) value += Number(candles[i].volume);
    else if (change < 0) value -= Number(candles[i].volume);
  }
  return value;
}

export function moneyFlowIndex(candles, period = 14) {
  if (!validCandles(candles, period + 1, true) || !Number.isInteger(period) || period < 1) return null;
  let positive = 0, negative = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const current = candles[i], previous = candles[i - 1];
    const tp = (Number(current.high) + Number(current.low) + Number(current.close)) / 3;
    const prevTp = (Number(previous.high) + Number(previous.low) + Number(previous.close)) / 3;
    const flow = tp * Number(current.volume);
    if (tp > prevTp) positive += flow;
    else if (tp < prevTp) negative += flow;
  }
  if (positive === 0 && negative === 0) return 50;
  if (negative === 0) return 100;
  if (positive === 0) return 0;
  return 100 - 100 / (1 + positive / negative);
}

/**
 * Anchored VWAP from the first candle at/after anchorTime (epoch seconds or ms).
 * Returns null when the anchor is absent or any included volume is missing/zero.
 */
export function anchoredVwap(candles, anchorTime) {
  if (!Array.isArray(candles) || !candles.length || !Number.isFinite(Number(anchorTime))) return null;
  const anchor = Number(anchorTime) > 1e12 ? Number(anchorTime) / 1000 : Number(anchorTime);
  const start = candles.findIndex((c) => Number(c.time) >= anchor);
  if (start < 0) return null;
  const window = candles.slice(start);
  if (!validCandles(window, 1, true)) return null;
  let pv = 0, volume = 0;
  for (const c of window) {
    const typical = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    pv += typical * Number(c.volume);
    volume += Number(c.volume);
  }
  return volume > 0 ? { value: pv / volume, volume, bars: window.length, anchorTime: window[0].time } : null;
}

/**
 * Bar-close volume profile approximation. Each candle's full volume is assigned
 * to the bin containing its close; this is NOT tick-level volume-at-price.
 */
export function volumeProfile(candles, bins = 24, valueAreaPercent = 70) {
  if (!validCandles(candles, 2, true) || !Number.isInteger(bins) || bins < 2 || bins > 200 ||
      !Number.isFinite(valueAreaPercent) || valueAreaPercent <= 0 || valueAreaPercent > 100) return null;
  const low = Math.min(...candles.map((c) => Number(c.low)));
  const high = Math.max(...candles.map((c) => Number(c.high)));
  if (!(high > low)) return null;
  const width = (high - low) / bins;
  const rows = Array.from({ length: bins }, (_, i) => ({ lower: low + i * width, upper: i === bins - 1 ? high : low + (i + 1) * width, volume: 0 }));
  for (const c of candles) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor((Number(c.close) - low) / width)));
    rows[index].volume += Number(c.volume);
  }
  const totalVolume = rows.reduce((sum, row) => sum + row.volume, 0);
  if (!(totalVolume > 0)) return null;
  const pocIndex = rows.reduce((best, row, i) => row.volume > rows[best].volume ? i : best, 0);
  const ranked = rows.map((row, i) => ({ i, volume: row.volume })).sort((a, b) => b.volume - a.volume);
  const included = new Set(); let accumulated = 0;
  for (const row of ranked) {
    included.add(row.i); accumulated += row.volume;
    if (accumulated >= totalVolume * valueAreaPercent / 100) break;
  }
  const valueRows = [...included].sort((a, b) => a - b);
  return {
    bins: rows,
    poc: (rows[pocIndex].lower + rows[pocIndex].upper) / 2,
    valueAreaLow: rows[valueRows[0]].lower,
    valueAreaHigh: rows[valueRows.at(-1)].upper,
    totalVolume,
    method: 'bar-close allocation approximation; not tick-level volume-at-price'
  };
}

/** One compact, transparent snapshot; null means unavailable, never a guessed value. */
export function buildProScalperSnapshot(candles, options = {}) {
  if (!validCandles(candles, 60)) {
    return { ok: false, status: 'INSUFFICIENT_OR_INVALID_CANDLES', required: 60, received: Array.isArray(candles) ? candles.length : 0 };
  }
  const closes = candles.map((c) => Number(c.close));
  const volumeReady = validCandles(candles, 2, true);
  return {
    ok: true,
    status: 'ANALYSIS_ONLY',
    candleCount: candles.length,
    latestCandleTime: candles.at(-1).time ?? null,
    indicators: {
      stochasticRsi: stochasticRsi(closes),
      cci: cci(candles),
      williamsR: williamsR(candles),
      supertrend: supertrend(candles),
      ichimoku: ichimoku(candles),
      keltner: keltnerChannels(candles),
      obv: volumeReady ? onBalanceVolume(candles) : null,
      mfi: volumeReady ? moneyFlowIndex(candles) : null,
      anchoredVwap: options.anchorTime != null && volumeReady ? anchoredVwap(candles, options.anchorTime) : null,
      volumeProfile: volumeReady ? volumeProfile(candles, options.profileBins ?? 24) : null
    },
    dataQuality: {
      volumeAvailable: volumeReady,
      volumeDerivedIndicatorsStatus: volumeReady ? 'AVAILABLE' : 'UNAVAILABLE_REAL_VOLUME_REQUIRED',
      volumeProfileMethod: 'bar-close approximation; not tick-level volume-at-price'
    },
    executionAuthorized: false
  };
}
