/**
 * AURUM institutional risk intelligence — deterministic, read-only analytics.
 *
 * Consumes normalized OHLCV candles only. No network, broker, account,
 * execution, order, or persistence dependencies. Every unavailable metric is
 * null and every insufficient/stale series returns UNKNOWN rather than a guess.
 */
import { atr, ema, rsi } from './indicators.js';
import { adx } from './indicators.ext.js';

const MIN_CANDLES = 220;
const ATR_PERIOD = 14;
const VOLATILITY_WINDOW = 100;
const MAX_CANDLES = 1200;

const finite = (value) => Number.isFinite(Number(value));
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function normalizeCandles(input) {
  if (!Array.isArray(input) || input.length > MAX_CANDLES) return null;
  const rows = [];
  let previousTime = 0;
  for (const raw of input) {
    const timeRaw = Number(raw?.time ?? raw?.epoch);
    const time = timeRaw > 1e12 ? timeRaw / 1000 : timeRaw;
    const open = Number(raw?.open), high = Number(raw?.high);
    const low = Number(raw?.low), close = Number(raw?.close);
    const volume = Number(raw?.volume ?? 0);
    if (![time, open, high, low, close].every(Number.isFinite) ||
        time <= previousTime || time <= 0 ||
        Math.min(open, high, low, close) <= 0 ||
        high < Math.max(open, close, low) ||
        low > Math.min(open, close, high) ||
        !Number.isFinite(volume) || volume < 0) return null;
    rows.push({ time, open, high, low, close, volume });
    previousTime = time;
  }
  return rows;
}

function trueRanges(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    out.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return out;
}

/** Return a percentile rank (0–100) of the latest ATR against its own history. */
function atrPercentile(candles, period = ATR_PERIOD, window = VOLATILITY_WINDOW) {
  const values = [];
  const start = Math.max(period, candles.length - window);
  for (let end = start; end < candles.length; end++) {
    const value = atr(candles.slice(end - period, end + 1), period);
    if (Number.isFinite(value)) values.push(value);
  }
  if (!values.length) return null;
  const current = values[values.length - 1];
  return Math.round((values.filter((v) => v <= current).length / values.length) * 1000) / 10;
}

function realizedVolatility(candles, window = 30) {
  if (candles.length < window + 1) return null;
  const returns = [];
  for (let i = candles.length - window; i < candles.length; i++) {
    const prior = candles[i - 1].close, current = candles[i].close;
    if (!(prior > 0 && current > 0)) return null;
    returns.push(Math.log(current / prior));
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return Math.round(Math.sqrt(variance) * 100000) / 1000;
}

/**
 * Analyze one instrument/timeframe.
 * @param {object} options
 * @param {Array} options.candles normalized OHLCV candles, oldest first
 * @param {string} [options.symbol]
 * @param {number} [options.timeframeSeconds] candle width for freshness checks
 * @param {number} [options.nowMs] injectable clock for deterministic tests
 */
export function analyzeRiskIntelligence({
  candles: input,
  symbol = 'UNKNOWN',
  timeframeSeconds = 300,
  nowMs = Date.now()
} = {}) {
  const candles = normalizeCandles(input);
  if (!candles || candles.length < MIN_CANDLES) {
    return {
      ok: false, symbol, posture: 'UNKNOWN', regime: 'UNKNOWN',
      reason: !candles ? 'INVALID_CANDLE_SERIES' : 'INSUFFICIENT_CANDLES',
      dataQuality: { valid: false, bars: Array.isArray(input) ? input.length : 0 },
      metrics: null
    };
  }
  if (!Number.isFinite(timeframeSeconds) || timeframeSeconds <= 0 ||
      !Number.isFinite(nowMs) || nowMs <= 0) {
    return {
      ok: false, symbol, posture: 'UNKNOWN', regime: 'UNKNOWN',
      reason: 'INVALID_ANALYSIS_CONTEXT',
      dataQuality: { valid: false, bars: candles.length },
      metrics: null
    };
  }

  const latest = candles[candles.length - 1];
  const ageSeconds = Math.max(0, nowMs / 1000 - latest.time);
  if (ageSeconds > timeframeSeconds * 2) {
    return {
      ok: false, symbol, posture: 'UNKNOWN', regime: 'UNKNOWN',
      reason: 'STALE_CANDLE_SERIES',
      dataQuality: { valid: true, stale: true, bars: candles.length, ageSeconds },
      metrics: null
    };
  }

  const closes = candles.map((c) => c.close);
  const atrNow = atr(candles, ATR_PERIOD);
  const atrRank = atrPercentile(candles);
  const adxNow = adx(candles, 14);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const realizedVol = realizedVolatility(candles);
  const required = [atrNow, atrRank, adxNow?.adx, ema20, ema50, ema200, rsi14, realizedVol];
  if (!required.every((value) => Number.isFinite(value))) {
    return {
      ok: false, symbol, posture: 'UNKNOWN', regime: 'UNKNOWN',
      reason: 'INDICATOR_UNAVAILABLE',
      dataQuality: { valid: true, stale: false, bars: candles.length, ageSeconds },
      metrics: null
    };
  }

  const bullishStack = latest.close > ema20 && ema20 > ema50 && ema50 > ema200;
  const bearishStack = latest.close < ema20 && ema20 < ema50 && ema50 < ema200;
  let regime = 'TRANSITION';
  if (adxNow.adx < 20) regime = 'RANGE';
  else if (adxNow.adx >= 25 && bullishStack) regime = 'TREND_UP';
  else if (adxNow.adx >= 25 && bearishStack) regime = 'TREND_DOWN';

  const priorAtr = [];
  for (let end = Math.max(ATR_PERIOD, candles.length - 12); end < candles.length - 1; end++) {
    const value = atr(candles.slice(end - ATR_PERIOD, end + 1), ATR_PERIOD);
    if (Number.isFinite(value)) priorAtr.push(value);
  }
  const baselineAtr = median(priorAtr);
  const riskMomentum = baselineAtr === null ? 'UNKNOWN'
    : atrNow > baselineAtr * 1.05 ? 'RISING'
      : atrNow < baselineAtr * 0.95 ? 'FALLING' : 'STABLE';

  let posture = 'NORMAL';
  if (atrRank >= 95) posture = 'DEFENSIVE';
  else if (atrRank >= 80 || regime === 'TRANSITION') posture = 'CAUTION';

  return {
    ok: true,
    symbol: String(symbol).slice(0, 32),
    asOf: latest.time,
    posture,
    regime,
    dataQuality: { valid: true, stale: false, bars: candles.length, ageSeconds },
    metrics: {
      lastPrice: latest.close,
      atr14: atrNow,
      atrPercentile: atrRank,
      adx14: Math.round(adxNow.adx * 10) / 10,
      plusDI: Math.round(adxNow.plusDI * 10) / 10,
      minusDI: Math.round(adxNow.minusDI * 10) / 10,
      ema20, ema50, ema200,
      rsi14: Math.round(rsi14 * 10) / 10,
      realizedVolatility30: realizedVol,
      riskMomentum,
      volatilitySurpriseRisk: atrRank >= 80 ? 'ELEVATED' : atrRank <= 20 ? 'LOW' : 'MODERATE'
    },
    notes: [
      'Historical volatility percentile is descriptive, not a forecast.',
      'Regime labels describe the supplied completed candles; they are not trade instructions.',
      'No broker account, order, or execution functionality is used.'
    ]
  };
}

export const RISK_INTELLIGENCE_LIMITS = Object.freeze({
  minCandles: MIN_CANDLES,
  maxCandles: MAX_CANDLES,
  atrPeriod: ATR_PERIOD,
  volatilityWindow: VOLATILITY_WINDOW
});
