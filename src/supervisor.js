/* ================================================================
 * SHELRICKTECH — Signal Freshness, 7-Timeframe Confluence,
 * AI Market Intelligence & Independent AI Trade Supervisor.
 *
 * Deterministic, auditable, zero-fabrication quantitative engine:
 * - Never invents prices, news, or broker confirmations.
 * - Never calls technical confluence a "probability of profit".
 * - Prevents stale or reversed BUY<->SELL signals from executing.
 * ================================================================ */

let _signalSeq = 1000;

export const SUPPORTED_TIMEFRAMES = [
  { key: '1m', label: '1m', sec: 60, weight: 0.08, ttlSec: 90 },
  { key: '5m', label: '5m', sec: 300, weight: 0.16, ttlSec: 300 },
  { key: '15m', label: '15m', sec: 900, weight: 0.18, ttlSec: 900 },
  { key: '30m', label: '30m', sec: 1800, weight: 0.14, ttlSec: 1800 },
  { key: '1h', label: '1h', sec: 3600, weight: 0.20, ttlSec: 3600 },
  { key: '4h', label: '4h', sec: 14400, weight: 0.14, ttlSec: 7200 },
  { key: '1d', label: '1D', sec: 86400, weight: 0.10, ttlSec: 21600 },
];

/* ---------------- Core indicator math (completed candles only) ---------------- */

export function calcSMA(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function calcEMA(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i];
  ema /= period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calcMACD(closes, fast = 12, slow = 26, sigPeriod = 9) {
  if (!Array.isArray(closes) || closes.length < slow + sigPeriod) return null;
  const kFast = 2 / (fast + 1), kSlow = 2 / (slow + 1);
  let emaFast = 0, emaSlow = 0;
  for (let i = 0; i < slow; i++) emaSlow += closes[i];
  emaSlow /= slow;
  for (let i = slow - fast; i < slow; i++) emaFast += closes[i];
  emaFast /= fast;
  const macdSeries = [emaFast - emaSlow];
  for (let i = slow; i < closes.length; i++) {
    emaFast = closes[i] * kFast + emaFast * (1 - kFast);
    emaSlow = closes[i] * kSlow + emaSlow * (1 - kSlow);
    macdSeries.push(emaFast - emaSlow);
  }
  const signal = calcEMA(macdSeries, sigPeriod);
  const macd = macdSeries[macdSeries.length - 1];
  if (signal == null) return null;
  return { macd, signal, histogram: macd - signal };
}

export function calcBollinger(closes, period = 20, mult = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: mid + mult * std,
    middle: mid,
    lower: mid - mult * std,
    bandwidthPct: mid > 0 ? ((2 * mult * std) / mid) * 100 : 0,
  };
}

export function calcATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    trs.push(tr);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

export function calcFibAndLevels(candles, lookback = 60) {
  if (!Array.isArray(candles) || candles.length < 10) return null;
  const slice = candles.slice(-lookback);
  let swingHigh = -Infinity, swingLow = Infinity;
  for (const c of slice) {
    if (c.high > swingHigh) swingHigh = c.high;
    if (c.low < swingLow) swingLow = c.low;
  }
  if (!Number.isFinite(swingHigh) || !Number.isFinite(swingLow) || swingHigh <= swingLow) return null;
  const range = swingHigh - swingLow;
  const pivotsHigh = [], pivotsLow = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    if (c.high > slice[i - 1].high && c.high > slice[i - 2].high && c.high >= slice[i + 1].high && c.high >= slice[i + 2].high) {
      pivotsHigh.push(c.high);
    }
    if (c.low < slice[i - 1].low && c.low < slice[i - 2].low && c.low <= slice[i + 1].low && c.low <= slice[i + 2].low) {
      pivotsLow.push(c.low);
    }
  }
  const structure = (() => {
    if (pivotsHigh.length >= 2 && pivotsLow.length >= 2) {
      const hh = pivotsHigh[pivotsHigh.length - 1] > pivotsHigh[pivotsHigh.length - 2];
      const hl = pivotsLow[pivotsLow.length - 1] > pivotsLow[pivotsLow.length - 2];
      const lh = pivotsHigh[pivotsHigh.length - 1] < pivotsHigh[pivotsHigh.length - 2];
      const ll = pivotsLow[pivotsLow.length - 1] < pivotsLow[pivotsLow.length - 2];
      if (hh && hl) return 'BULLISH_HH_HL';
      if (lh && ll) return 'BEARISH_LH_LL';
    }
    return 'RANGING';
  })();
  return {
    swingHigh,
    swingLow,
    fib236: swingHigh - range * 0.236,
    fib382: swingHigh - range * 0.382,
    fib500: swingHigh - range * 0.5,
    fib618: swingHigh - range * 0.618,
    fib786: swingHigh - range * 0.786,
    resistances: pivotsHigh.slice(-3).sort((a, b) => a - b),
    supports: pivotsLow.slice(-3).sort((a, b) => b - a),
    structure,
  };
}

/** Resample 1m or 5m candles into a coarser timeframe (e.g. 15m, 30m, 4h) when direct series is absent. */
export function resampleCandles(candles, targetSec) {
  if (!Array.isArray(candles) || candles.length < 2 || !targetSec) return [];
  const buckets = new Map();
  for (const c of candles) {
    const rawT = Number(c.time);
    const tSec = rawT > 1e12 ? Math.floor(rawT / 1000) : Math.floor(rawT);
    if (!Number.isFinite(tSec) || !Number.isFinite(c.open) || !Number.isFinite(c.close)) continue;
    const bKey = Math.floor(tSec / targetSec) * targetSec;
    const existing = buckets.get(bKey);
    if (!existing) {
      buckets.set(bKey, {
        time: bKey,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0),
      });
    } else {
      existing.high = Math.max(existing.high, Number(c.high));
      existing.low = Math.min(existing.low, Number(c.low));
      existing.close = Number(c.close);
      existing.volume += Number(c.volume || 0);
    }
  }
  const sorted = [...buckets.values()].sort((a, b) => a.time - b.time);
  // Drop the newest bucket if it may still be forming
  return sorted.length > 2 ? sorted.slice(0, -1) : sorted;
}

/** Evaluate a single timeframe's completed candles -> BUY/SELL/WAIT + 0..100 confluence scores. */
export function evaluateSingleTimeframe(rawCandles, tfLabel = '5m') {
  const valid = (Array.isArray(rawCandles) ? rawCandles : []).filter(
    (c) => c && Number.isFinite(Number(c.close)) && Number.isFinite(Number(c.high)) && Number.isFinite(Number(c.low)) && Number(c.close) > 0
  ).map((c) => ({
    time: Number(c.time) > 1e12 ? Math.floor(Number(c.time) / 1000) : Math.floor(Number(c.time)),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume || 0),
  })).sort((a, b) => a.time - b.time);

  if (valid.length < 30) {
    return {
      timeframe: tfLabel,
      available: false,
      direction: 'WAIT',
      buyStrength: 0,
      sellStrength: 0,
      score: 0,
      reason: `Insufficient completed candles (${valid.length}/30 minimum)`,
    };
  }

  const closes = valid.map((c) => c.close);
  const last = valid[valid.length - 1];
  const prev = valid[valid.length - 2];
  const ema9 = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, Math.min(50, closes.length));
  const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : null;
  const sma50 = closes.length >= 50 ? calcSMA(closes, 50) : null;
  const sma200 = closes.length >= 200 ? calcSMA(closes, 200) : null;
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes, 12, 26, 9);
  const bb = calcBollinger(closes, 20, 2);
  const atr = calcATR(valid, 14);
  const fib = calcFibAndLevels(valid, Math.min(80, valid.length));

  const vols = valid.slice(-21, -1).map((c) => c.volume).filter((v) => v > 0);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const volRatio = avgVol > 0 && last.volume > 0 ? last.volume / avgVol : null;

  let buyPts = 0, sellPts = 0, totalPossible = 0;
  const addVote = (w, condBuy, condSell) => {
    totalPossible += w;
    if (condBuy) buyPts += w;
    else if (condSell) sellPts += w;
  };

  if (ema9 != null && ema20 != null) addVote(16, ema9 > ema20 && last.close > ema9, ema9 < ema20 && last.close < ema9);
  if (ema20 != null && ema50 != null) addVote(18, ema20 > ema50 && last.close > ema50, ema20 < ema50 && last.close < ema50);
  if (ema200 != null) addVote(16, last.close > ema200, last.close < ema200);
  if (sma50 != null && sma200 != null) addVote(10, sma50 > sma200, sma50 < sma200);
  if (rsi != null) addVote(12, rsi > 52 && rsi < 74, rsi < 48 && rsi > 26);
  if (macd != null) addVote(14, macd.histogram > 0 && macd.macd > macd.signal, macd.histogram < 0 && macd.macd < macd.signal);
  if (bb != null) addVote(8, last.close > bb.middle && last.close < bb.upper * 1.002, last.close < bb.middle && last.close > bb.lower * 0.998);
  if (fib != null) addVote(10, fib.structure === 'BULLISH_HH_HL', fib.structure === 'BEARISH_LH_LL');
  // Price action candle body confirmation
  addVote(6, last.close > last.open && last.close > prev.close, last.close < last.open && last.close < prev.close);

  const buyStrength = totalPossible > 0 ? Math.round((buyPts / totalPossible) * 100) : 0;
  const sellStrength = totalPossible > 0 ? Math.round((sellPts / totalPossible) * 100) : 0;
  const lead = Math.abs(buyStrength - sellStrength);
  let direction = 'WAIT';
  if (buyStrength >= 55 && buyStrength - sellStrength >= 18) direction = 'BUY';
  else if (sellStrength >= 55 && sellStrength - buyStrength >= 18) direction = 'SELL';

  const score = direction === 'BUY' ? buyStrength : direction === 'SELL' ? sellStrength : Math.max(buyStrength, sellStrength);
  const atrPct = atr && last.close > 0 ? (atr / last.close) * 100 : 0;
  const volatilityRegime = atrPct > 0.65 ? 'HIGH' : atrPct < 0.12 ? 'QUIET' : 'NORMAL';

  return {
    timeframe: tfLabel,
    available: true,
    bars: valid.length,
    asOfSec: last.time,
    close: last.close,
    direction,
    buyStrength,
    sellStrength,
    neutralStrength: Math.max(0, 100 - buyStrength - sellStrength),
    score,
    lead,
    volatilityRegime,
    indicators: {
      ema9, ema20, ema50, ema200, sma50, sma200,
      rsi, macd, bb, atr, fib, volRatio,
    },
  };
}

/** Evaluate all supported timeframes (`1m, 5m, 15m, 30m, 1h, 4h, 1D`) and aggregate confluence. */
export function computeMultiTimeframeConfluence(seriesMap = {}) {
  const m1 = seriesMap['1m'] || seriesMap.m1 || [];
  const m5 = seriesMap['5m'] || seriesMap.m5 || [];
  const h1 = seriesMap['1h'] || seriesMap.h1 || [];
  const resolved = {
    '1m': m1,
    '5m': m5.length >= 30 ? m5 : resampleCandles(m1, 300),
    '15m': (seriesMap['15m'] || seriesMap.m15 || []).length >= 30 ? (seriesMap['15m'] || seriesMap.m15) : resampleCandles(m5.length >= 90 ? m5 : m1, 900),
    '30m': (seriesMap['30m'] || seriesMap.m30 || []).length >= 30 ? (seriesMap['30m'] || seriesMap.m30) : resampleCandles(m5.length >= 180 ? m5 : h1, 1800),
    '1h': h1,
    '4h': (seriesMap['4h'] || seriesMap.h4 || []).length >= 30 ? (seriesMap['4h'] || seriesMap.h4) : resampleCandles(h1, 14400),
    '1d': seriesMap['1d'] || seriesMap.d1 || [],
  };

  const frames = SUPPORTED_TIMEFRAMES.map((tf) => ({
    ...tf,
    ...evaluateSingleTimeframe(resolved[tf.key], tf.label),
  }));

  const available = frames.filter((f) => f.available);
  if (available.length < 2) {
    return {
      ok: false,
      verdict: 'NO TRADE',
      buyConfluence: 0,
      sellConfluence: 0,
      qualityScore: 0,
      frames,
      conflicts: ['Fewer than 2 completed timeframe series are available.'],
      formulaNote: 'Weighted technical confluence across completed timeframes (0–100). Quality score only — NOT a probability of profit or win-rate guarantee.',
    };
  }

  let wSum = 0, wBuy = 0, wSell = 0, buyVotes = 0, sellVotes = 0;
  for (const f of available) {
    wSum += f.weight;
    wBuy += f.buyStrength * f.weight;
    wSell += f.sellStrength * f.weight;
    if (f.direction === 'BUY') buyVotes++;
    if (f.direction === 'SELL') sellVotes++;
  }
  const buyConfluence = Math.round(wBuy / wSum);
  const sellConfluence = Math.round(wSell / wSum);

  const conflicts = [];
  if (buyVotes > 0 && sellVotes > 0) {
    const bList = available.filter((f) => f.direction === 'BUY').map((f) => f.timeframe).join('/');
    const sList = available.filter((f) => f.direction === 'SELL').map((f) => f.timeframe).join('/');
    conflicts.push(`Conflicting timeframes: BUY on ${bList} vs SELL on ${sList}.`);
  }
  const weakTrend = available.filter((f) => f.lead < 15).map((f) => f.timeframe);
  if (weakTrend.length >= Math.ceil(available.length / 2)) {
    conflicts.push(`Trend weakness / range conditions on ${weakTrend.join(', ')}.`);
  }

  let verdict = 'WAIT';
  if (buyConfluence >= 56 && buyConfluence - sellConfluence >= 16 && buyVotes >= 2 && buyVotes > sellVotes) {
    verdict = 'BUY';
  } else if (sellConfluence >= 56 && sellConfluence - buyConfluence >= 16 && sellVotes >= 2 && sellVotes > buyVotes) {
    verdict = 'SELL';
  } else if (available.length >= 3 && buyConfluence < 40 && sellConfluence < 40) {
    verdict = 'NO TRADE';
  }

  const qualityScore = verdict === 'BUY'
    ? Math.min(95, buyConfluence)
    : verdict === 'SELL'
    ? Math.min(95, sellConfluence)
    : Math.min(45, Math.max(buyConfluence, sellConfluence));

  return {
    ok: true,
    verdict,
    buyConfluence,
    sellConfluence,
    qualityScore,
    buyVotes,
    sellVotes,
    waitVotes: available.length - buyVotes - sellVotes,
    frames,
    conflicts,
    formulaNote: 'Weighted technical confluence (EMA 9/20/50/200, SMA 50/200, RSI 14, MACD, Bollinger, ATR, Fib & HH/HL structure) normalized 0–100. Quality score — NOT a probability of profit.',
  };
}

/* ---------------- Signal Freshness Envelope & Countdown ---------------- */

export function stampSignalEnvelope(rawSig, { nowMs = Date.now(), clockOffsetMs = 0, bid = null, ask = null, timeframe = '5m' } = {}) {
  if (!rawSig || typeof rawSig !== 'object') return null;
  const syncNow = nowMs + (Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0);
  const tfDef = SUPPORTED_TIMEFRAMES.find((t) => t.key === String(timeframe || '5m').toLowerCase()) || SUPPORTED_TIMEFRAMES[1];
  const generatedAtMs = Number(rawSig.generatedAtMs) > 0 ? Number(rawSig.generatedAtMs) : syncNow;
  const ttlMs = (Number(rawSig.ttlSec) > 0 ? Number(rawSig.ttlSec) : tfDef.ttlSec) * 1000;
  const expiresAtMs = Number(rawSig.expiresAtMs) > generatedAtMs ? Number(rawSig.expiresAtMs) : generatedAtMs + ttlMs;

  const entry = Number(rawSig.entry);
  const sl = Number(rawSig.stop_loss ?? rawSig.sl);
  const tp1 = Number(rawSig.tp1 ?? rawSig.take_profit);
  const tp2 = Number(rawSig.tp2 ?? 0);
  const riskDist = Number.isFinite(entry) && Number.isFinite(sl) && entry > 0 && sl > 0 ? Math.abs(entry - sl) : 0;
  const rewardDist = Number.isFinite(entry) && Number.isFinite(tp1) && entry > 0 && tp1 > 0 ? Math.abs(tp1 - entry) : 0;
  const rrRatio = riskDist > 0 && rewardDist > 0 ? Number((rewardDist / riskDist).toFixed(2)) : null;

  // Acceptable entry band: +/- 35% of stop distance (or 0.15% of price when stop is absent)
  const bandHalf = riskDist > 0 ? riskDist * 0.35 : (Number.isFinite(entry) && entry > 0 ? entry * 0.0015 : 0);
  const entryRange = Number.isFinite(entry) && entry > 0
    ? [Number((entry - bandHalf).toFixed(6)), Number((entry + bandHalf).toFixed(6))]
    : null;

  const liveBid = Number.isFinite(Number(bid)) && Number(bid) > 0 ? Number(bid) : null;
  const liveAsk = Number.isFinite(Number(ask)) && Number(ask) > 0 ? Number(ask) : null;
  const spread = liveBid != null && liveAsk != null && liveAsk >= liveBid ? Number((liveAsk - liveBid).toFixed(6)) : null;

  _signalSeq += 1;
  const signal = String(rawSig.signal || 'WAIT').toUpperCase();
  const signalId = rawSig.signalId || `${rawSig.symbol || 'SYM'}:${signal}:${timeframe}:${Math.floor(generatedAtMs / 60000)}`;

  return {
    ...rawSig,
    signal,
    signalId,
    versionId: rawSig.versionId || _signalSeq,
    timeframe: tfDef.label,
    generatedAtMs,
    expiresAtMs,
    entry: Number.isFinite(entry) && entry > 0 ? entry : null,
    entryRange,
    stop_loss: Number.isFinite(sl) && sl > 0 ? sl : null,
    tp1: Number.isFinite(tp1) && tp1 > 0 ? tp1 : null,
    tp2: Number.isFinite(tp2) && tp2 > 0 ? tp2 : null,
    rrRatio,
    bid: liveBid,
    ask: liveAsk,
    spread,
    invalidatedReason: rawSig.invalidatedReason || null,
  };
}

/** Synchronized validity + countdown evaluation (countdown measures signal validity, never profit guarantee). */
export function getSignalValidityState(envelope, { nowMs = Date.now(), clockOffsetMs = 0, liveBid = null, liveAsk = null, quoteTsMs = null, latestSignal = null, maxQuoteAgeMs = 30_000 } = {}) {
  if (!envelope) {
    return { valid: false, status: 'UNAVAILABLE', remainingSec: 0, countdownText: 'No signal', reason: 'No active signal envelope.' };
  }
  const syncNow = nowMs + (Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0);
  const remainingMs = envelope.expiresAtMs - syncNow;
  const remainingSec = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = String(Math.floor(remainingSec / 60)).padStart(2, '0');
  const ss = String(remainingSec % 60).padStart(2, '0');

  if (envelope.invalidatedReason) {
    return { valid: false, status: 'INVALIDATED', remainingSec: 0, countdownText: 'INVALIDATED', reason: envelope.invalidatedReason };
  }
  if (envelope.signal !== 'BUY' && envelope.signal !== 'SELL') {
    return { valid: false, status: envelope.signal === 'NO TRADE' ? 'NO TRADE' : 'WAIT', remainingSec, countdownText: `${mm}:${ss}`, reason: 'Signal is WAIT / NO TRADE — no directional setup.' };
  }
  if (latestSignal && latestSignal !== envelope.signal) {
    const reason = `Signal invalidated: market direction changed from ${envelope.signal} to ${latestSignal}.`;
    envelope.invalidatedReason = reason;
    return { valid: false, status: 'INVALIDATED', remainingSec: 0, countdownText: 'REVERSED', reason };
  }
  if (remainingMs <= 0) {
    return { valid: false, status: 'EXPIRED', remainingSec: 0, countdownText: '00:00 (EXPIRED)', reason: `Signal expired at ${new Date(envelope.expiresAtMs).toISOString().slice(11, 19)} UTC.` };
  }
  if (quoteTsMs != null && syncNow - quoteTsMs > maxQuoteAgeMs) {
    return { valid: false, status: 'STALE', remainingSec, countdownText: `${mm}:${ss} (STALE QUOTE)`, reason: `Live broker quote is stale (${Math.round((syncNow - quoteTsMs) / 1000)}s old > ${Math.round(maxQuoteAgeMs / 1000)}s limit).` };
  }
  const execPx = envelope.signal === 'BUY' ? (liveAsk ?? liveBid) : (liveBid ?? liveAsk);
  if (execPx != null && Array.isArray(envelope.entryRange) && envelope.entryRange.length === 2) {
    const [lo, hi] = envelope.entryRange;
    if (execPx < lo || execPx > hi) {
      return {
        valid: false,
        status: 'OUT_OF_RANGE',
        remainingSec,
        countdownText: `${mm}:${ss} (DRIFTED)`,
        reason: `Executable quote (${execPx}) moved outside acceptable entry range [${lo} – ${hi}].`,
      };
    }
  }
  if (execPx != null && envelope.stop_loss != null) {
    if ((envelope.signal === 'BUY' && execPx <= envelope.stop_loss) || (envelope.signal === 'SELL' && execPx >= envelope.stop_loss)) {
      const reason = `Signal invalidated: price (${execPx}) crossed stop-loss (${envelope.stop_loss}).`;
      envelope.invalidatedReason = reason;
      return { valid: false, status: 'INVALIDATED', remainingSec: 0, countdownText: 'STOPPED', reason };
    }
  }
  return {
    valid: true,
    status: 'VALID',
    remainingSec,
    countdownText: `${mm}:${ss}`,
    reason: `Signal valid for ${mm}:${ss} (validity window only — not a profit guarantee).`,
  };
}

/* ---------------- Independent AI Trade Supervisor (Section 19) ---------------- */

/**
 * Deterministic supervisory validation layer before ANY automated entry or signal-backed manual order.
 * Returns verdict: 'APPROVED' | 'REJECTED' | 'WAIT' | 'STALE SIGNAL' + structured audit trail.
 */
export function evaluateTradeSupervisor(ctx = {}) {
  const {
    intendedSide,
    symbol,
    signalEnvelope = null,
    latestRecalculatedSignal = null,
    brokerConnected = false,
    expectedBroker = null,
    activeBroker = null,
    expectedAccountId = null,
    activeAccountId = null,
    expectedEnvironment = null,
    activeEnvironment = null,
    marketOpen = true,
    liveBid = null,
    liveAsk = null,
    quoteTsMs = null,
    nowMs = Date.now(),
    clockOffsetMs = 0,
    maxQuoteAgeMs = 30_000,
    maxSpreadRatio = 0.35, // spread <= 35% of stop distance when SL present
    freeMargin = null,
    requiredMargin = null,
    requestedLots = null,
    brokerMinLots = null,
    requestedUsd = null,
    brokerMinNotionalUsd = null,
    strictMinVolume = false,
    openPositionsCount = 0,
    maxConcurrentPositions = 5,
    dailyTradesCount = 0,
    maxDailyTrades = 20,
    dailyRealizedPl = 0,
    maxDailyLossUsd = 0,
    dailyProfitTargetUsd = 0,
    currentDrawdownPct = 0,
    maxDrawdownPct = 20,
    totalOpenExposureUsd = 0,
    maxExposureUsd = 0,
    duplicateSignalIds = new Set(),
    openSymbols = new Set(),
    preventSameSymbolDuplicate = false,
    highImpactNewsActive = false,
    highImpactEventTitle = '',
    requireSignalValidation = false,
  } = ctx;

  const checks = [];
  const push = (name, status, detail) => checks.push({ name, status, detail });

  // 1. Broker & exact Account Identity check
  if (!brokerConnected || !activeBroker) {
    push('accountIdentity', 'FAILED', 'No authenticated broker account is connected.');
    return { verdict: 'REJECTED', reasons: ['No authenticated broker account is connected.'], checks };
  }
  if (expectedBroker && expectedBroker !== activeBroker) {
    const msg = `Selected broker changed (${expectedBroker} -> ${activeBroker}); silent broker switching is blocked.`;
    push('accountIdentity', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  if (expectedAccountId && activeAccountId && String(expectedAccountId) !== String(activeAccountId)) {
    const msg = `Active account (${activeAccountId}) no longer matches authorized account (${expectedAccountId}).`;
    push('accountIdentity', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  if (expectedEnvironment && activeEnvironment && expectedEnvironment !== activeEnvironment) {
    const msg = `Account mode mismatch (${expectedEnvironment.toUpperCase()} vs ${activeEnvironment.toUpperCase()}); silent DEMO/REAL switching is blocked.`;
    push('accountIdentity', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  push('accountIdentity', 'PASSED', `${activeBroker.toUpperCase()} · ${(activeEnvironment || 'verified').toUpperCase()}`);

  // 2. Market status & fresh executable quote
  if (!marketOpen) {
    push('marketStatus', 'FAILED', `${symbol || 'Market'} is currently closed.`);
    return { verdict: 'REJECTED', reasons: [`${symbol || 'Market'} is currently closed.`], checks };
  }
  const syncNow = nowMs + (Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0);
  const hasQuote = (Number.isFinite(liveBid) && liveBid > 0) || (Number.isFinite(liveAsk) && liveAsk > 0);
  if (!hasQuote) {
    push('quoteFreshness', 'FAILED', 'No live executable quote from selected feed/broker.');
    return { verdict: 'STALE SIGNAL', reasons: ['No live executable quote is available; order blocked.'], checks };
  }
  if (quoteTsMs != null && syncNow - quoteTsMs > maxQuoteAgeMs) {
    const msg = `Quote is stale (${Math.round((syncNow - quoteTsMs) / 1000)}s old > ${Math.round(maxQuoteAgeMs / 1000)}s max).`;
    push('quoteFreshness', 'FAILED', msg);
    return { verdict: 'STALE SIGNAL', reasons: [msg], checks };
  }
  push('quoteFreshness', 'PASSED', 'Executable quote is fresh.');

  // 3. Direction & Signal Freshness Validation (CRITICAL BUG FIX — Section 7)
  if (intendedSide !== 'BUY' && intendedSide !== 'SELL') {
    push('signalValidity', 'FAILED', 'Intended direction must be BUY or SELL.');
    return { verdict: 'WAIT', reasons: ['No BUY or SELL direction selected.'], checks };
  }
  if (latestRecalculatedSignal && (latestRecalculatedSignal === 'BUY' || latestRecalculatedSignal === 'SELL') && latestRecalculatedSignal !== intendedSide) {
    const msg = `Direction reversed before execution: intended ${intendedSide}, but live recalculated signal is now ${latestRecalculatedSignal}. Old ${intendedSide} setup invalidated.`;
    if (signalEnvelope) signalEnvelope.invalidatedReason = msg;
    push('signalValidity', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  if (requireSignalValidation) {
    if (!signalEnvelope) {
      push('signalValidity', 'FAILED', 'No validated signal envelope supplied.');
      return { verdict: 'WAIT', reasons: ['Awaiting a fresh validated signal setup.'], checks };
    }
    if (latestRecalculatedSignal === 'WAIT' || latestRecalculatedSignal === 'NO TRADE') {
      const msg = `Setup weakened to ${latestRecalculatedSignal} on fresh candle re-check; ${intendedSide} entry blocked.`;
      push('signalValidity', 'FAILED', msg);
      return { verdict: 'WAIT', reasons: [msg], checks };
    }
    const val = getSignalValidityState(signalEnvelope, {
      nowMs, clockOffsetMs, liveBid, liveAsk, quoteTsMs,
      latestSignal: latestRecalculatedSignal || signalEnvelope.signal,
      maxQuoteAgeMs,
    });
    if (!val.valid) {
      push('signalValidity', 'FAILED', val.reason);
      const vCode = (val.status === 'EXPIRED' || val.status === 'STALE' || val.status === 'OUT_OF_RANGE') ? 'STALE SIGNAL' : 'REJECTED';
      return { verdict: vCode, reasons: [val.reason], checks };
    }
    if (signalEnvelope.signal !== intendedSide) {
      const msg = `Order side (${intendedSide}) contradicts active signal (${signalEnvelope.signal}).`;
      push('signalValidity', 'FAILED', msg);
      return { verdict: 'REJECTED', reasons: [msg], checks };
    }
    if (duplicateSignalIds && signalEnvelope.signalId && duplicateSignalIds.has(signalEnvelope.signalId)) {
      const msg = `Duplicate execution prevented: signal ${signalEnvelope.signalId} was already acted upon.`;
      push('duplicateGuard', 'FAILED', msg);
      return { verdict: 'REJECTED', reasons: [msg], checks };
    }
    push('signalValidity', 'PASSED', val.reason);
  }

  // 4. Spread vs Stop-Loss sanity check
  if (Number.isFinite(liveBid) && Number.isFinite(liveAsk) && liveAsk >= liveBid && signalEnvelope?.entry && signalEnvelope?.stop_loss) {
    const spread = liveAsk - liveBid;
    const stopDist = Math.abs(signalEnvelope.entry - signalEnvelope.stop_loss);
    if (stopDist > 0 && spread / stopDist > maxSpreadRatio) {
      const msg = `Current spread (${spread.toFixed(5)}) exceeds ${Math.round(maxSpreadRatio * 100)}% of stop distance (${stopDist.toFixed(5)}).`;
      push('spreadLiquidity', 'FAILED', msg);
      return { verdict: 'REJECTED', reasons: [msg], checks };
    }
  }
  push('spreadLiquidity', 'PASSED', 'Spread within acceptable threshold.');

  // 5. Minimum Volume & Margin validation (never secretly inflate order size!)
  if (Number.isFinite(requestedLots) && Number.isFinite(brokerMinLots) && requestedLots > 0 && requestedLots + 1e-12 < brokerMinLots) {
    const msg = `Requested volume (${requestedLots} lots) is below broker minimum (${brokerMinLots} lots). Order size is never secretly increased.`;
    push('positionSizing', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  if (strictMinVolume && Number.isFinite(requestedUsd) && Number.isFinite(brokerMinNotionalUsd) && requestedUsd + 1e-6 < brokerMinNotionalUsd) {
    const msg = `Requested exposure ($${requestedUsd.toFixed(2)}) is below broker minimum notional ($${brokerMinNotionalUsd.toFixed(2)}). Order size is never secretly increased.`;
    push('positionSizing', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  if (Number.isFinite(freeMargin) && Number.isFinite(requiredMargin) && requiredMargin > freeMargin * 0.95) {
    const msg = `Insufficient free margin: required $${requiredMargin.toFixed(2)} exceeds 95% of free margin ($${freeMargin.toFixed(2)}).`;
    push('marginCheck', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  push('marginCheck', 'PASSED', 'Sizing & margin within account bounds.');

  // 6. Portfolio, Drawdown, Daily Loss, Exposure & Duplicate Symbol Guards
  if (maxConcurrentPositions > 0 && openPositionsCount >= maxConcurrentPositions) {
    const msg = `Max concurrent positions reached (${openPositionsCount}/${maxConcurrentPositions}).`;
    push('exposureLimits', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  if (preventSameSymbolDuplicate && symbol && openSymbols && openSymbols.has(symbol)) {
    const msg = `Position already open on ${symbol}; duplicate symbol entry blocked.`;
    push('duplicateGuard', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  if (maxDailyTrades > 0 && dailyTradesCount >= maxDailyTrades) {
    const msg = `Maximum daily trades reached (${dailyTradesCount}/${maxDailyTrades}).`;
    push('dailyLimits', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  if (maxDailyLossUsd > 0 && dailyRealizedPl <= -Math.abs(maxDailyLossUsd)) {
    const msg = `Maximum daily loss limit reached ($${dailyRealizedPl.toFixed(2)} <= -$${Math.abs(maxDailyLossUsd).toFixed(2)}).`;
    push('dailyLimits', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  if (dailyProfitTargetUsd > 0 && requireSignalValidation && dailyRealizedPl >= dailyProfitTargetUsd) {
    const msg = `Daily profit target achieved (+$${dailyRealizedPl.toFixed(2)} >= +$${dailyProfitTargetUsd.toFixed(2)}); Sniper stands down.`;
    push('dailyLimits', 'FAILED', msg);
    return { verdict: 'WAIT', reasons: [msg], checks };
  }
  if (maxDrawdownPct > 0 && currentDrawdownPct >= maxDrawdownPct) {
    const msg = `Account drawdown (${currentDrawdownPct.toFixed(2)}%) reached maximum drawdown limit (${maxDrawdownPct.toFixed(2)}%).`;
    push('drawdownGuard', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }
  if (maxExposureUsd > 0 && Number.isFinite(requestedUsd) && totalOpenExposureUsd + requestedUsd > maxExposureUsd) {
    const msg = `Projected open exposure ($${(totalOpenExposureUsd + requestedUsd).toFixed(2)}) exceeds maximum exposure cap ($${maxExposureUsd.toFixed(2)}).`;
    push('exposureLimits', 'FAILED', msg);
    return { verdict: 'REJECTED', reasons: [msg], checks };
  }

  // 7. Scheduled High-Impact Economic Event Restriction
  if (highImpactNewsActive) {
    const msg = `Paused during high-impact economic event risk window${highImpactEventTitle ? ` (${highImpactEventTitle})` : ''}.`;
    push('economicEventGuard', 'FAILED', msg);
    return { verdict: 'WAIT', reasons: [msg], checks };
  }
  push('economicEventGuard', 'PASSED', 'No active high-impact news embargo.');

  return {
    verdict: 'APPROVED',
    reasons: ['All account, quote freshness, signal direction, spread, sizing, margin, exposure, and news-window checks passed.'],
    checks,
  };
}

/* ---------------- AI Market Intelligence Builder (Section 12) ---------------- */

export function buildMarketIntelligenceBrief({ symbol, quote = null, mtf = null, calendarEvents = [], headlines = [], dataSource = 'Live feed', nowMs = Date.now() } = {}) {
  const price = quote?.mid ?? quote?.bid ?? quote?.price ?? null;
  const bid = quote?.bid ?? null;
  const ask = quote?.ask ?? null;
  const spread = bid != null && ask != null && ask >= bid ? ask - bid : null;
  const quoteAgeSec = quote?.tsMs ? Math.max(0, Math.round((nowMs - quote.tsMs) / 1000)) : null;

  const h1Frame = mtf?.frames?.find((f) => f.key === '1h' && f.available) || mtf?.frames?.find((f) => f.available) || null;
  const m15Frame = mtf?.frames?.find((f) => f.key === '15m' && f.available) || h1Frame;
  const atr = m15Frame?.indicators?.atr || null;
  const fib = h1Frame?.indicators?.fib || null;
  const rsi = m15Frame?.indicators?.rsi || null;

  const observedFacts = [];
  if (price != null) observedFacts.push(`Latest observed quote for ${symbol}: ${price}${spread != null ? ` (Bid ${bid} / Ask ${ask}, spread ${spread.toFixed(5)})` : ''}.`);
  else observedFacts.push(`No live tick currently buffered for ${symbol}; awaiting verified provider update.`);

  if (mtf?.ok) {
    observedFacts.push(`Multi-timeframe technical alignment: BUY ${mtf.buyConfluence}/100 (${mtf.buyVotes} TFs) vs SELL ${mtf.sellConfluence}/100 (${mtf.sellVotes} TFs) across ${mtf.frames.filter((f) => f.available).length} completed timeframes.`);
  }
  if (rsi != null) observedFacts.push(`${m15Frame.timeframe} RSI(14) stands at ${rsi.toFixed(1)}; volatility regime is ${m15Frame.volatilityRegime || 'NORMAL'}${atr ? ` (ATR ${atr.toFixed(5)})` : ''}.`);
  if (fib) observedFacts.push(`Recent swing range: Support ${fib.swingLow.toFixed(5)} – Resistance ${fib.swingHigh.toFixed(5)} (${fib.structure.replace(/_/g, ' ')}); Fib 38.2% = ${fib.fib382.toFixed(5)}, 61.8% = ${fib.fib618.toFixed(5)}.`);

  const relevantEvents = (Array.isArray(calendarEvents) ? calendarEvents : []).slice(0, 3);
  if (relevantEvents.length) {
    observedFacts.push(`${relevantEvents.length} scheduled economic release(s) tracked in the macro calendar window.`);
  }

  let entryZone = null, stopLoss = null, tp1 = null, tp2 = null, invalidation = null, rr = null;
  if (price != null && atr != null && atr > 0 && mtf?.ok && (mtf.verdict === 'BUY' || mtf.verdict === 'SELL')) {
    const dir = mtf.verdict === 'BUY' ? 1 : -1;
    entryZone = [Number((price - atr * 0.25).toFixed(5)), Number((price + atr * 0.25).toFixed(5))];
    stopLoss = Number((price - dir * atr * 1.5).toFixed(5));
    tp1 = Number((price + dir * atr * 2.25).toFixed(5));
    tp2 = Number((price + dir * atr * 3.5).toFixed(5));
    invalidation = stopLoss;
    rr = 1.5;
  }

  const bullishScenario = fib && price != null
    ? `Sustained closes above ${fib.fib382.toFixed(5)} keep upside structure constructive toward ${fib.swingHigh.toFixed(5)}${atr ? ` and extension ${(fib.swingHigh + atr).toFixed(5)}` : ''}. Invalidated below ${fib.fib618.toFixed(5)}.`
    : 'Requires completed multi-timeframe candle history above key moving averages to confirm upside continuation.';

  const bearishScenario = fib && price != null
    ? `Failure below ${fib.fib618.toFixed(5)} opens downside pressure toward swing support ${fib.swingLow.toFixed(5)}${atr ? ` and extension ${(fib.swingLow - atr).toFixed(5)}` : ''}. Invalidated above ${fib.fib382.toFixed(5)}.`
    : 'Requires completed multi-timeframe candle breakdown below EMA 50/200 to confirm downside continuation.';

  const interpretation = mtf?.ok
    ? (mtf.verdict === 'BUY' || mtf.verdict === 'SELL'
        ? `Technical confluence leans ${mtf.verdict} (quality score ${mtf.qualityScore}/100). ${mtf.conflicts.length ? 'Caution: ' + mtf.conflicts.join(' ') : 'Timeframes show directional agreement; confirm spread and macro calendar before sizing.'}`
        : `Evidence is mixed or range-bound (${mtf.verdict}, score ${mtf.qualityScore}/100). Standing aside preserves capital until multi-timeframe structure aligns.`)
    : 'Insufficient completed candles to form a directional technical thesis; stand aside.';

  return {
    symbol,
    asOfIso: new Date(nowMs).toISOString(),
    dataSource,
    freshness: quoteAgeSec == null ? 'UNVERIFIED' : quoteAgeSec <= 30 ? `LIVE (${quoteAgeSec}s ago)` : `STALE (${quoteAgeSec}s ago)`,
    verdict: mtf?.ok ? mtf.verdict : 'WAIT',
    qualityScore: mtf?.ok ? mtf.qualityScore : 0,
    observedFacts,
    interpretation,
    bullishScenario,
    bearishScenario,
    levels: {
      supports: fib?.supports || [],
      resistances: fib?.resistances || [],
      entryZone,
      invalidation,
      stopLoss,
      tp1,
      tp2,
      rr,
    },
    headlinesCount: Array.isArray(headlines) ? headlines.length : 0,
    limitations: 'Deterministic technical & macro synthesis on provider-supplied data. Confluence score is NOT a probability of profit. Headlines never trigger orders on their own.',
  };
}
