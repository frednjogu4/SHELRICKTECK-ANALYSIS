/* ASTER candle evidence — deterministic, read-only evidence derived from closed OHLC bars.
 * This module never fabricates quote, spread, news, account, sizing or broker evidence.
 */
const PERIODS = Object.freeze({ m15: 900, h1: 3600, h4: 14400, d1: 86400 });
const MAX_AGE_SEC = Object.freeze({ m15: 2700, h1: 10800, h4: 43200, d1: 259200 });

const finite = (v) => Number.isFinite(Number(v));
function validRows(rows) {
  if (!Array.isArray(rows) || rows.length < 55) return false;
  let previous = 0;
  for (const c of rows) {
    const t = Number(c?.time), o = Number(c?.open), h = Number(c?.high), l = Number(c?.low), cl = Number(c?.close);
    if (![t, o, h, l, cl].every(Number.isFinite) || t <= previous || Math.min(o, h, l, cl) <= 0 ||
      h < Math.max(o, cl, l) || l > Math.min(o, cl, h)) return false;
    previous = t;
  }
  return true;
}
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let v = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) v = values[i] * k + v * (1 - k);
  return Number.isFinite(v) ? v : null;
}
function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    gains += Math.max(d, 0); losses += Math.max(-d, 0);
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (ag === 0 && al === 0) return 50;
  if (al === 0) return 100;
  if (ag === 0) return 0;
  return 100 - 100 / (1 + ag / al);
}
function analyzeFrame(rows, timeframe, nowSec) {
  if (!validRows(rows)) return { valid: false, fresh: false, direction: null, indicatorsValid: false };
  // The newest bar may still be forming. Never use it as closed evidence.
  const closed = rows.slice(0, -1);
  const closes = closed.map((c) => Number(c.close));
  const last = closed[closed.length - 1];
  const e20 = ema(closes, 20), e50 = ema(closes, 50), strength = rsi(closes);
  const age = nowSec - (Number(last.time) + PERIODS[timeframe]);
  const fresh = Number.isFinite(age) && age >= -30 && age <= MAX_AGE_SEC[timeframe];
  const indicatorsValid = [e20, e50, strength].every(Number.isFinite);
  let direction = null;
  if (indicatorsValid) {
    if (last.close > e20 && e20 > e50) direction = 'LONG';
    else if (last.close < e20 && e20 < e50) direction = 'SHORT';
  }
  const recent = closed.slice(-20), prior = closed.slice(-40, -20);
  const structure = recent.length === 20 && prior.length === 20
    ? {
        higherHighs: Math.max(...recent.map(c => c.high)) > Math.max(...prior.map(c => c.high)),
        higherLows: Math.min(...recent.map(c => c.low)) > Math.min(...prior.map(c => c.low)),
        lowerHighs: Math.max(...recent.map(c => c.high)) < Math.max(...prior.map(c => c.high)),
        lowerLows: Math.min(...recent.map(c => c.low)) < Math.min(...prior.map(c => c.low))
      } : null;
  return { valid: true, fresh, direction, indicatorsValid, rsi: strength, ema20: e20, ema50: e50, lastClosed: last, previousClosed: closed[closed.length - 2], structure };
}

/** Return ASTER evidence and auditable frame diagnostics; absent inputs remain UNKNOWN. */
export function buildAsterCandleEvidence({ candleSets = {}, direction, now = Date.now() } = {}) {
  const dir = String(direction || '').toUpperCase();
  const nowSec = Number(now) / 1000;
  const frames = Object.fromEntries(Object.keys(PERIODS).map(tf => [tf, analyzeFrame(candleSets[tf], tf, nowSec)]));
  const complete = Object.values(frames).every(f => f.valid);
  const aligned = (tf) => frames[tf].valid && frames[tf].direction === dir && (dir === 'LONG' || dir === 'SHORT');
  const htfAligned = aligned('d1') && aligned('h4');
  const h1 = frames.h1, m15 = frames.m15;
  const structureValid = dir === 'LONG'
    ? Boolean(frames.d1.structure?.higherHighs && frames.d1.structure?.higherLows && frames.h4.structure?.higherHighs && frames.h4.structure?.higherLows)
    : dir === 'SHORT'
      ? Boolean(frames.d1.structure?.lowerHighs && frames.d1.structure?.lowerLows && frames.h4.structure?.lowerHighs && frames.h4.structure?.lowerLows)
      : null;
  const h1Setup = aligned('h1') && (dir === 'LONG' ? h1.rsi >= 45 && h1.rsi <= 75 : h1.rsi >= 25 && h1.rsi <= 55);
  const m15Confirmation = aligned('m15') && (dir === 'LONG'
    ? m15.lastClosed.close > m15.previousClosed.high && m15.lastClosed.close > m15.lastClosed.open
    : m15.lastClosed.close < m15.previousClosed.low && m15.lastClosed.close < m15.lastClosed.open);
  const indicatorsValid = complete && Object.values(frames).every(f => f.indicatorsValid);
  const evidence = {
    ohlcValid: complete,
    marketDataFresh: complete && Object.values(frames).every(f => f.fresh),
    d1Trend: frames.d1.valid ? aligned('d1') : null,
    h4Trend: frames.h4.valid ? aligned('h4') : null,
    h1Setup: frames.h1.valid ? h1Setup : null,
    m15Confirmation: frames.m15.valid ? m15Confirmation : null,
    indicatorsValid: complete ? indicatorsValid : null,
    structureValid: frames.d1.valid && frames.h4.valid ? structureValid : null,
    // These require independent sources not represented by OHLC bars.
    bidAskValid: null, spreadValid: null, newsValidated: null,
    stopLossValid: null, measuredTargetsValid: null, positionSizingValid: null,
    brokerConstraintsValid: null, riskWithinLimit: null
  };
  const confluence = {
    htfStructure: frames.d1.valid && frames.h4.valid ? (htfAligned ? 1 : 0) : null,
    priceAction: evidence.structureValid,
    setupQuality: evidence.h1Setup,
    indicators: evidence.indicatorsValid,
    entryConfirmation: evidence.m15Confirmation,
    newsConditions: null
  };
  return {
    evidence, confluence,
    frames: Object.fromEntries(Object.entries(frames).map(([tf, f]) => [tf, {
      valid: f.valid, fresh: f.fresh, direction: f.direction,
      indicatorsValid: f.indicatorsValid,
      rsi: finite(f.rsi) ? Math.round(f.rsi * 100) / 100 : null,
      lastClosedTime: f.lastClosed?.time ?? null
    }])),
    source: 'closed OHLC candles; quote/news/account evidence not supplied'
  };
}
