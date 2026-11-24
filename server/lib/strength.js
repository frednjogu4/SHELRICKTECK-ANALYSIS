/* ================================================================
 * GOLD MARKET STRENGTH — deterministic technical-condition scoring.
 *
 * Pure ESM, no network. Imported by server/app.js (adds `strength` to
 * /api/signals/analyze) AND by src/main.js for the browser-side Deriv
 * fallback — the same shared-pipeline pattern as analyzer.js.
 *
 * Inputs are COMPLETED candles only (the caller runs closedCandleSets
 * first; a forming candle is never scored — opts.currentPresent only
 * records that one was excluded).
 *
 * The three scores are technical EVIDENCE percentages, not
 * probabilities of profit, forecasts or trade instructions. The WAIT
 * signal is independent of these bars.
 *
 * Method (deterministic, documented, unit-tested):
 *   per timeframe (M1 20% / M5 30% / H1 50%):
 *     TREND (4 slots): price vs EMA20 · EMA20 vs EMA50 · EMA50 vs
 *       EMA200 (skipped when EMA200 unavailable) · EMA20 direction.
 *     MOMENTUM (3 slots): RSI14 zone · MACD line vs signal · MACD
 *       line slope. Missing RSI/MACD → slot SKIPPED (denominator
 *       shrinks; never scored as zero).
 *     STRUCTURE (3 slots): last two swing highs (HH/LH) · last two
 *       swing lows (HL/LL) · close beyond the recent range (breakout).
 *     VOLATILITY (1 slot): ATR expansion assigns +1 to the current
 *       trend direction only; normal/low volatility scores 0 —
 *       volatility alone never creates direction.
 *   shares = bull/bear/neutral over evaluated slots; weighted mean
 *   across valid timeframes; largest-remainder rounding so
 *   buying + selling + neutral === 100 exactly.
 *   Trust gates: <50 closed candles, stale last close, or all slots
 *   unevaluable → that timeframe is invalid; zero valid timeframes →
 *   INSUFFICIENT_DATA (no numbers are invented).
 * ================================================================ */

import { rsi, macd, emaSeries, ema, atr } from './indicators.js';

const TIMEFRAMES = [
  { key: 'm1', label: 'M1', weight: 0.20, staleSec: 180, granSec: 60 },
  { key: 'm5', label: 'M5', weight: 0.30, staleSec: 900, granSec: 300 },
  { key: 'h1', label: 'H1', weight: 0.50, staleSec: 7500, granSec: 3600 }
];
const MIN_CLOSED = 50;
const EXPANSION_RATIO = 1.3;

function finite(v) { return Number.isFinite(v); }
/** Equality with a relative epsilon — a flat market must read as flat, not as float noise. */
function near(a, b) {
  if (!finite(a) || !finite(b)) return false;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}
function cmp(a, b) { return near(a, b) ? 0 : a > b ? 1 : -1; }

/** Last two pivot highs / lows (window of 1 on each side). */
function swingPoints(candles, side) {
  const pts = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const v = side === 'high' ? Number(candles[i].high) : Number(candles[i].low);
    if (!finite(v)) continue;
    const prev = side === 'high' ? Number(candles[i - 1].high) : Number(candles[i - 1].low);
    const next = side === 'high' ? Number(candles[i + 1].high) : Number(candles[i + 1].low);
    if (!finite(prev) || !finite(next)) continue;
    if (side === 'high' ? (v > prev && v > next) : (v < prev && v < next)) pts.push(v);
  }
  return pts.slice(-2);
}

/** Score one timeframe. Returns {valid, reason?, bull, bear, neutral, label, newest, count, skipped[]}. */
function scoreTimeframe(candles, tf, nowSec) {
  if (!Array.isArray(candles) || candles.length < MIN_CLOSED) {
    return { valid: false, reason: 'INSUFFICIENT_CANDLES', detail: `${tf.label}: ${Array.isArray(candles) ? candles.length : 0}/${MIN_CLOSED} closed candles` };
  }
  const last = candles[candles.length - 1];
  let newest = Number(last && last.time);
  if (!finite(newest) || newest <= 0) return { valid: false, reason: 'NO_CLOSED_CANDLE', detail: `${tf.label}: last closed candle has no timestamp` };
  if (newest > 1e12) newest = Math.floor(newest / 1000); /* accept ms epochs too (MT5 bridge rows) */
  const age = Math.max(0, nowSec - newest);
  if (age > tf.staleSec) return { valid: false, reason: 'STALE_DATA', detail: `${tf.label}: newest closed candle is ${age}s old (limit ${tf.staleSec}s)` };

  const closes = candles.map((c) => Number(c.close));
  if (!closes.every(finite)) return { valid: false, reason: 'INVALID_CANDLES', detail: `${tf.label}: non-numeric close in window` };

  const price = closes[closes.length - 1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);          /* null under 200 closes — slot skipped */
  const r = rsi(closes, 14);              /* null under 15 closes — slot skipped */
  const m = macd(closes);                 /* null under 34 closes — slot skipped */
  const aNow = atr(candles.slice(-30), 14);
  const prior = candles.slice(0, Math.max(0, candles.length - 30));
  const aPrior = prior.length >= 15 ? atr(prior, 14) : null;

  let bull = 0, bear = 0, neutral = 0;
  const skipped = [];
  const add = (side) => { if (side === 'bull') bull++; else if (side === 'bear') bear++; else neutral++; };
  const slot = (name, side, skippedNote) => {
    if (side === 'skip') { skipped.push(skippedNote || name); return; }
    add(side);
  };

  /* --- TREND (4 slots) --- */
  slot('price_vs_ema20', !finite(e20) ? 'skip' : cmp(price, e20) > 0 ? 'bull' : cmp(price, e20) < 0 ? 'bear' : 'neutral', 'price vs EMA20');
  slot('ema20_vs_ema50', (!finite(e20) || !finite(e50)) ? 'skip' : cmp(e20, e50) > 0 ? 'bull' : cmp(e20, e50) < 0 ? 'bear' : 'neutral', 'EMA20 vs EMA50');
  slot('ema50_vs_ema200', (!finite(e50) || !finite(e200)) ? 'skip' : cmp(e50, e200) > 0 ? 'bull' : cmp(e50, e200) < 0 ? 'bear' : 'neutral', 'EMA50 vs EMA200 (EMA200 needs 200 closes)');
  const eSeries = emaSeries(closes, 20);
  let eDir = 'skip';
  if (Array.isArray(eSeries) && eSeries.length >= 6) {
    const a = eSeries[eSeries.length - 1], b = eSeries[eSeries.length - 6];
    eDir = finite(a) && finite(b) ? (cmp(a, b) > 0 ? 'bull' : cmp(a, b) < 0 ? 'bear' : 'neutral') : 'skip';
  }
  slot('ema20_direction', eDir, 'EMA20 direction');

  /* --- MOMENTUM (3 slots) --- */
  slot('rsi14', !finite(r) ? 'skip' : r > 55 ? 'bull' : r < 45 ? 'bear' : 'neutral', 'RSI(14)');
  if (m && finite(m.line) && finite(m.signal)) {
    slot('macd_vs_signal', cmp(m.line, m.signal) > 0 ? 'bull' : cmp(m.line, m.signal) < 0 ? 'bear' : 'neutral');
    const series = Array.isArray(m.lineSeries) ? m.lineSeries : [];
    const prev = series.length >= 2 ? series[series.length - 2] : null;
    slot('macd_slope', finite(prev) ? (cmp(m.line, prev) > 0 ? 'bull' : cmp(m.line, prev) < 0 ? 'bear' : 'neutral') : 'skip', 'MACD line slope');
  } else {
    slot('macd_vs_signal', 'skip', 'MACD (needs 34 closes)');
    slot('macd_slope', 'skip', 'MACD line slope');
  }

  /* --- STRUCTURE (3 slots) --- */
  const hi = swingPoints(candles, 'high');
  const lo = swingPoints(candles, 'low');
  slot('swing_highs', hi.length < 2 ? 'skip' : hi[1] > hi[0] ? 'bull' : hi[1] < hi[0] ? 'bear' : 'neutral', 'two swing highs');
  slot('swing_lows', lo.length < 2 ? 'skip' : lo[1] > lo[0] ? 'bull' : lo[1] < lo[0] ? 'bear' : 'neutral', 'two swing lows');
  const win = candles.slice(-10, -2);
  let breakout = 'neutral';
  if (win.length >= 4 && win.every((c) => finite(Number(c.high)) && finite(Number(c.low)))) {
    const wh = Math.max(...win.map((c) => Number(c.high)));
    const wl = Math.min(...win.map((c) => Number(c.low)));
    if (price > wh) breakout = 'bull';
    else if (price < wl) breakout = 'bear';
  } else breakout = 'skip';
  slot('range_breakout', breakout, 'close beyond recent range');

  /* --- VOLATILITY (1 slot): expansion follows trend direction only --- */
  const trendNet = bull - bear;
  let volSide = 'neutral', volNote = 'normal volatility';
  if (!finite(aNow) || !finite(aPrior) || aPrior <= 0) {
    volSide = 'skip'; volNote = 'ATR comparison';
  } else if (aNow > aPrior * EXPANSION_RATIO) {
    volNote = 'ATR expansion';
    volSide = trendNet > 0 ? 'bull' : trendNet < 0 ? 'bear' : 'neutral';
  } else if (aNow < aPrior * 0.7) volNote = 'low-volatility consolidation';
  slot('volatility_regime', volSide, volNote);

  const denom = bull + bear + neutral;
  if (denom === 0) return { valid: false, reason: 'NO_EVALUABLE_SLOTS', detail: `${tf.label}: no indicator produced an evaluable reading` };
  const label = trendNet >= 2 ? 'BULLISH' : trendNet <= -2 ? 'BEARISH' : 'NEUTRAL';
  return { valid: true, bull, bear, neutral, label, newest, count: candles.length, skipped, note: volNote, rsi: finite(r) ? r : null };
}

/** Largest-remainder rounding to integers summing exactly total. */
function roundToSum(raw, total) {
  const floors = raw.map((x) => Math.floor(x));
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k].i]++;
  return out;
}

/**
 * @param {{m1:Array,m5:Array,h1:Array}} sets COMPLETED candles per timeframe
 * @param {{nowSec?:number, currentPresent?:boolean}} [opts]
 * @returns strength object — {ok:false, reason:'INSUFFICIENT_DATA'} when untrusted
 */
export function marketStrength(sets, opts = {}) {
  const nowSec = Number.isFinite(opts.nowSec) ? opts.nowSec : Math.floor(Date.now() / 1000);
  const src = sets && typeof sets === 'object' ? sets : {};
  const per = {};
  const invalid = [];
  for (const tf of TIMEFRAMES) {
    const s = scoreTimeframe(src[tf.key], tf, nowSec);
    per[tf.key] = { valid: !!s.valid, label: tf.label, weight: tf.weight, trend: s.valid ? s.label : null, reason: s.reason || null, detail: s.detail || null, newestClosed: s.newest || null, closedCount: s.count || 0, skipped: s.skipped || [], bull: s.bull || 0, bear: s.bear || 0, neutral: s.neutral || 0 };
    if (!s.valid) invalid.push(`${s.reason} — ${s.detail || tf.label}`);
    else per[tf.key]._score = s;
  }
  const validTf = TIMEFRAMES.filter((tf) => per[tf.key].valid);
  const base = {
    disclaimer: 'Technical evidence from completed candles — not a probability of profit, forecast or trade instruction.',
    computedAt: new Date(nowSec * 1000).toISOString(),
    currentCandle: opts.currentPresent ? 'excluded (still forming)' : 'none present',
    weights: { m1: '20%', m5: '30%', h1: '50%' },
    rounding: 'largest remainder — the three scores always total 100%',
    perTimeframe: Object.fromEntries(TIMEFRAMES.map((tf) => [tf.key, per[tf.key]]))
  };
  if (validTf.length === 0) {
    return Object.assign({ ok: false, reason: 'INSUFFICIENT_DATA', detail: invalid.join(' · ') || 'No completed candle window available.' }, base);
  }

  /* Weighted mean of valid timeframe shares (weights renormalised). */
  const wSum = validTf.reduce((a, tf) => a + tf.weight, 0);
  let rb = 0, rs = 0, rn = 0;
  const evidence = [];
  for (const tf of validTf) {
    const s = per[tf.key]._score;
    const d = s.bull + s.bear + s.neutral;
    rb += tf.weight * (s.bull / d);
    rs += tf.weight * (s.bear / d);
    rn += tf.weight * (s.neutral / d);
    evidence.push({ tf: tf.label, bull: s.bull, bear: s.bear, neutral: s.neutral, trend: s.label, skipped: s.skipped });
  }
  rb /= wSum; rs /= wSum; rn /= wSum;
  const [buying, selling, neutral] = roundToSum([rb * 100, rs * 100, rn * 100], 100);

  let classification;
  if (buying >= 50 && buying - selling >= 20) classification = 'Dominant buying pressure';
  else if (selling >= 50 && selling - buying >= 20) classification = 'Dominant selling pressure';
  else if (buying - selling >= 10) classification = 'Moderate buying pressure';
  else if (selling - buying >= 10) classification = 'Moderate selling pressure';
  else classification = 'Balanced / neutral conditions';

  /* Supporting vs contradicting evidence relative to the dominant side. */
  const dominant = buying > selling ? 'bull' : selling > buying ? 'bear' : 'neutral';
  const supporting = [], contradicting = [], neutralNotes = [];
  for (const e of evidence) {
    const push = (side, text) => {
      if (side === dominant) supporting.push(text);
      else if (dominant !== 'neutral' && side !== 'neutral') contradicting.push(text);
      else neutralNotes.push(text);
    };
    push(e.trend === 'BULLISH' ? 'bull' : e.trend === 'BEARISH' ? 'bear' : 'neutral', `${e.tf} trend ${e.trend} (${e.bull}–${e.bear}–${e.neutral} slots)`);
    if (e.skipped.length) neutralNotes.push(`${e.tf} skipped: ${e.skipped.join(', ')}`);
  }
  if (validTf.length < TIMEFRAMES.length) {
    const dropped = TIMEFRAMES.filter((tf) => !per[tf.key].valid);
    neutralNotes.push(`Excluded timeframes: ${dropped.map((t) => `${t.label} (${per[t.key].reason || 'invalid'})`).join(', ')} — scores use ${validTf.map((t) => t.label).join(' / ')} only.`);
  }

  return Object.assign({
    ok: true,
    buying, selling, neutral,
    classification,
    dominant,
    supporting: supporting.slice(0, 8),
    contradicting: contradicting.slice(0, 8),
    notes: neutralNotes.slice(0, 8),
    methodology: [
      'Completed M1/M5/H1 candles only; a forming candle is excluded from every score.',
      'Per timeframe: trend (price vs EMA20, EMA alignment, EMA20 direction), momentum (RSI14 zone, MACD line vs signal, MACD slope), structure (swing highs/lows, range breakout), volatility (ATR expansion follows the trend direction only).',
      'Missing indicators are skipped and shrink that timeframe’s denominator — never scored as zero.',
      'Timeframes weighted M1 20% / M5 30% / H1 50%; scores rounded by largest remainder to total exactly 100%.',
      'The BUY/SELL/WAIT signal and confidence are computed separately — a dominant bar can coexist with WAIT.'
    ],
    latestClosed: Math.max(...validTf.map((tf) => per[tf.key].newestClosed || 0)),
    validTimeframes: validTf.map((tf) => tf.label)
  }, base);
}
