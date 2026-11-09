/* ================================================================
 * AURUM — signal analyzer core (pure, key-free, testable)
 *
 * This is the deterministic layer that runs BEFORE any LLM call:
 *   candles -> indicators -> per-timeframe bias vote -> MTF confirmation
 * Claude later receives this computed evidence and returns the final
 * decision JSON — it never has to do math we can do ourselves.
 *
 * Corrections vs. the draft spec:
 *  - analyzeTimeframe now actually sets `.signal` (the draft returned
 *    no signal field, so confirmMultiTimeframe always saw undefined
 *    and MTF degenerated to NO_CONFIRMATION).
 *  - Every timeframe object carries an `error` only when data is
 *    insufficient; MTF counts votes only from valid timeframes.
 * ================================================================ */

import { rsi, macd, bollingerBands, ema, sma, atr, findLevels } from './indicators.js';

export const MIN_CANDLES = 50;

export function identifyTrend(closes) {
  if (!Array.isArray(closes) || closes.length < 20) return 'CONSOLIDATION';
  const last20 = closes.slice(-20);
  const avg = last20.reduce((a, b) => a + b, 0) / 20;
  const current = closes[closes.length - 1];
  const prev = closes[closes.length - 20];
  if (current > avg && current > prev) return 'UPTREND';
  if (current < avg && current < prev) return 'DOWNTREND';
  return 'CONSOLIDATION';
}

/**
 * Deterministic confluence score in [-5, +5]:
 *   price vs EMA20, price vs EMA50, MACD histogram sign,
 *   RSI zone (55-70 adds, >70 subtracts overbought, mirrored below),
 *   trend classification.
 * BUY at >= +3, SELL at <= -3, otherwise WAIT.
 */
export function detectSignalBias({ price, indicators, trend }) {
  let score = 0;
  const { rsi: r, macd: m, ema20, ema50 } = indicators;
  if (price > ema20) score += 1;
  else if (price < ema20) score -= 1;
  if (price > ema50) score += 1;
  else if (price < ema50) score -= 1;
  if (m) {
    if (m.histogram > 0) score += 1;
    else if (m.histogram < 0) score -= 1;
  }
  if (r !== null && r !== undefined) {
    if (r >= 55 && r <= 70) score += 1;
    else if (r > 70) score -= 1; // overbought — caution against longs
    else if (r >= 30 && r <= 45) score -= 1;
    else if (r < 30) score += 1; // oversold — bounce potential
  }
  if (trend === 'UPTREND') score += 1;
  else if (trend === 'DOWNTREND') score -= 1;
  return { score, signal: score >= 3 ? 'BUY' : score <= -3 ? 'SELL' : 'WAIT' };
}

/** Compute indicators + bias vote for one timeframe. */
export function analyzeTimeframe(symbol, candles, timeframe) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
    return {
      error: 'Insufficient data',
      symbol,
      timeframe,
      required: MIN_CANDLES,
      have: Array.isArray(candles) ? candles.length : 0,
      signal: null
    };
  }
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const indicators = {
    rsi: rsi(closes),
    macd: macd(closes),
    bb: bollingerBands(closes),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200), // null until 200+ closes — callers must tolerate
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    atr: atr(candles)
  };
  const levels = findLevels(candles, 50);
  const fib = fibRetracement(candles);
  const trend = identifyTrend(closes);
  const bias = detectSignalBias({ price, indicators, trend });
  return {
    symbol,
    timeframe,
    currentPrice: price,
    indicators,
    levels,
    fib,
    trend,
    signal: bias.signal,
    biasScore: bias.score,
    candles: candles.slice(-20) // compact context for the LLM prompt
  };
}

/**
 * 2-of-3 majority across the provided timeframe analyses.
 * Invalid/error timeframes abstain; fewer than 2 valid votes => no call.
 */
export function confirmMultiTimeframe(analyses) {
  const list = [analyses.m1, analyses.m5, analyses.h1];
  const valid = list.filter((a) => a && !a.error && (a.signal === 'BUY' || a.signal === 'SELL' || a.signal === 'WAIT'));
  if (valid.length < 2) return 'NO_CONFIRMATION';
  const buyCount = valid.filter((a) => a.signal === 'BUY').length;
  const sellCount = valid.filter((a) => a.signal === 'SELL').length;
  if (buyCount >= 2) return 'BUY_CONFIRMED';
  if (sellCount >= 2) return 'SELL_CONFIRMED';
  /* gradient: 2+ timeframes LEAN the same way (|score|>=2) but none of the
     full-strength |3| votes — honest direction info without a trade call */
  const bullLean = valid.filter((a) => (a.biasScore || 0) >= 2).length;
  const bearLean = valid.filter((a) => (a.biasScore || 0) <= -2).length;
  if (bullLean >= 2) return 'BULLISH_LEAN';
  if (bearLean >= 2) return 'BEARISH_LEAN';
  return 'NO_CONFIRMATION';
}

/** Compact per-timeframe vote line, e.g. "1m +2 WAIT · 5m +3 BUY · 1h −1 WAIT". */
export function votesSummary(analyses) {
  return [analyses.m1, analyses.m5, analyses.h1]
    .filter(Boolean)
    .map((a) => a.error
      ? a.timeframe + ' n/a'
      : a.timeframe + ' ' + (a.biasScore >= 0 ? '+' : '') + a.biasScore + ' ' + a.signal)
    .join(' · ');
}

/** Format one timeframe analysis for the Claude prompt. */
/** Fibonacci retracement of the window's swing low -> swing high. */
export function fibRetracement(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  let hi = -Infinity, lo = Infinity;
  for (const c of candles) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  const range = hi - lo;
  if (!Number.isFinite(range) || range <= 0) return null;
  const retrace = {};
  for (const f of [0.236, 0.382, 0.5, 0.618, 0.786]) retrace[String(f)] = hi - range * f;
  return { low: lo, high: hi, range, retracements: retrace };
}

function fibLine(fib) {
  if (!fib) return 'N/A';
  const r = fib.retracements || {};
  return ['0.382', '0.5', '0.618'].map(k => `${k}=${Number(r[k]).toFixed(5)}`).join(' | ');
}

export function formatAnalysis(analysis) {
  if (!analysis) return 'No data';
  if (analysis.error) return `${analysis.error} (have ${analysis.have}, need ${analysis.required})`;
  const i = analysis.indicators;
  const f = (v, d = 4) => (v === null || v === undefined ? 'N/A' : Number(v).toFixed(d));
  const rsiZone =
    i.rsi > 70 ? ' (OVERBOUGHT)' : i.rsi < 30 ? ' (OVERSOLD)' : '';
  return `
Price: ${f(analysis.currentPrice)}
Trend: ${analysis.trend}
Signal vote: ${analysis.signal} (bias ${analysis.biasScore})

Indicators:
- RSI(14): ${i.rsi === null ? 'N/A' : i.rsi.toFixed(1)}${rsiZone}
- MACD: ${f(i.macd?.line)} | Signal: ${f(i.macd?.signal)} | Histogram: ${f(i.macd?.histogram)}
- BB: Upper ${f(i.bb?.upper)} | Mid ${f(i.bb?.mid)} | Lower ${f(i.bb?.lower)}
- EMA20: ${f(i.ema20)} | EMA50: ${f(i.ema50)} | EMA200: ${f(i.ema200)}
- ATR: ${f(i.atr)}

Fib: ${fibLine(analysis.fib)}

Key Levels:
- Support: ${analysis.levels.support.map((s) => f(s)).join(', ')}
- Resistance: ${analysis.levels.resistance.map((r) => f(r)).join(', ')}
`;
}

/**
 * Full deterministic analysis pipeline (no network, no keys).
 * Returns everything the decision prompt needs; the caller only adds
 * sentiment + the LLM call on top.
 */
export function runDeterministicAnalysis(symbol, candleSets) {
  const analyses = {
    m1: analyzeTimeframe(symbol, candleSets.m1, '1m'),
    m5: analyzeTimeframe(symbol, candleSets.m5, '5m'),
    h1: analyzeTimeframe(symbol, candleSets.h1, '1h')
  };
  const mtfSignal = confirmMultiTimeframe(analyses);
  const anyValid = ['m1', 'm5', 'h1'].some((k) => !analyses[k].error);
  return { symbol, analyses, mtfSignal, ok: anyValid && mtfSignal !== 'NO_CONFIRMATION' };
}

/* ================================================================
 * WAIT reasons — machine-readable + human-readable (audit Task 4).
 * Every WAIT must explain itself: insufficient candles, stale feed,
 * timeframe conflict, unconfirmed lean, or plain chop.
 * ================================================================ */

/** Age of the freshest candle in seconds (or null). Uses the last-20 slice kept on each analysis. */
export function freshestCandleAge(det) {
  let newest = 0;
  for (const a of [det.analyses?.m1, det.analyses?.m5, det.analyses?.h1]) {
    const arr = a && a.candles;
    if (Array.isArray(arr) && arr.length && arr[arr.length - 1].time > newest) newest = arr[arr.length - 1].time;
  }
  return newest ? Math.max(0, Math.floor(Date.now() / 1000) - newest) : null;
}

/**
 * Build { code, detail } for a WAIT (or null reasons for BUY/SELL).
 * Codes: INSUFFICIENT_CANDLES | STALE_DATA | MTF_CONFLICT |
 *        MTF_LEAN_NOT_CONFIRMED | MTF_NO_ALIGNMENT | FEED_ERROR
 */
export function waitReason(det, opts = {}) {
  if (det.mtfSignal === 'BUY_CONFIRMED' || det.mtfSignal === 'SELL_CONFIRMED') return null; /* no reason needed */
  const a = det.analyses || {};
  const list = [a.m1, a.m5, a.h1].filter(Boolean);
  const errs = list.filter((x) => x.error);
  if (errs.length === list.length && list.length) {
    return { code: 'FEED_ERROR', detail: 'No timeframe returned usable candles just now.' };
  }
  if (errs.length) {
    const parts = errs.map((x) => x.timeframe + ': have ' + (x.have ?? 0) + ', need ' + (x.required ?? MIN_CANDLES));
    return { code: 'INSUFFICIENT_CANDLES', detail: 'Not enough fresh candles — ' + parts.join(', ') + '.' };
  }
  const age = opts.maxAgeSec ? freshestCandleAge(det) : null;
  if (age != null && age > opts.maxAgeSec) {
    return { code: 'STALE_DATA', detail: 'Newest candle is ' + Math.round(age / 60) + ' min old (limit ' + Math.round(opts.maxAgeSec / 60) + ' min) — feed may be paused or the market closed.' };
  }
  const votes = list.map((x) => x.signal);
  const hasBuy = votes.includes('BUY');
  const hasSell = votes.includes('SELL');
  if (hasBuy && hasSell) {
    return { code: 'MTF_CONFLICT', detail: 'Timeframes disagree — ' + votesSummary(a) + '. No direction has 2-of-3.' };
  }
  if (det.mtfSignal === 'BULLISH_LEAN') return { code: 'MTF_LEAN_NOT_CONFIRMED', detail: 'Timeframes lean up but none reached full BUY strength — ' + votesSummary(a) + '.' };
  if (det.mtfSignal === 'BEARISH_LEAN') return { code: 'MTF_LEAN_NOT_CONFIRMED', detail: 'Timeframes lean down but none reached full SELL strength — ' + votesSummary(a) + '.' };
  return { code: 'MTF_NO_ALIGNMENT', detail: 'No 2-of-3 confirmation and no consistent lean — ' + votesSummary(a) + '.' };
}
