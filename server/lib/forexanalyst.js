import { emaSeries, findLevels, macd, rsi } from './indicators.js';
import { INSTRUMENT_MAP } from './symbols.js';

export const FX_ANALYST_TIMEFRAMES = Object.freeze({ '1m': 60, '5m': 300, '10m': 600, '15m': 900 });
const MTF = Object.freeze(['1m', '5m', '10m']);
const MIN_CANDLES = 50;
const MAX_STOP_PIPS = 15;

const finite = value => Number.isFinite(Number(value));
const timeSec = value => {
  const n = Number(value);
  return n > 1e12 ? n / 1000 : n;
};
const round = (value, digits = 8) => Number(Number(value).toFixed(digits));

function validatedClosed(candles, seconds) {
  if (!Array.isArray(candles)) return { rows: [], error: 'Candle history is unavailable.' };
  const ordered = [];
  let previous = 0;
  for (const candle of candles) {
    if (!candle || ![candle.time, candle.open, candle.high, candle.low, candle.close].every(finite))
      return { rows: [], error: 'Candle history contains missing or non-numeric OHLC data.' };
    const time = timeSec(candle.time), open = Number(candle.open), high = Number(candle.high), low = Number(candle.low), close = Number(candle.close);
    if (!(time > previous) || !(low > 0) || high < Math.max(open, close) || low > Math.min(open, close))
      return { rows: [], error: 'Candle history is unordered or contains invalid OHLC ranges.' };
    ordered.push({ time, open, high, low, close });
    previous = time;
  }
  /* A candle is treated as closed only when a later candle proves its interval ended. */
  const closed = ordered.filter((c, i) => i + 1 < ordered.length && ordered[i + 1].time >= c.time + seconds);
  const rows = closed.slice(-MIN_CANDLES);
  return rows.length < MIN_CANDLES
    ? { rows, error: `Need ${MIN_CANDLES} closed ${seconds / 60}-minute candles; received ${rows.length}.` }
    : { rows, error: '' };
}

function pivots(rows, side, maxCount = 2) {
  const found = [];
  for (let i = rows.length - 3; i >= Math.max(2, rows.length - 26); i--) {
    const value = rows[i][side];
    const before = rows.slice(i - 2, i), after = rows.slice(i + 1, i + 3);
    const pivot = side === 'high'
      ? before.every(c => value > c.high) && after.every(c => value >= c.high)
      : before.every(c => value < c.low) && after.every(c => value <= c.low);
    if (pivot) found.push({ time: rows[i].time, value });
    if (found.length >= maxCount) break;
  }
  return found.reverse();
}

function candlePattern(previous, last) {
  if (!previous || !last) return 'none';
  const prevBull = previous.close > previous.open, bull = last.close > last.open;
  const engulf = bull !== prevBull && Math.min(last.open, last.close) <= Math.min(previous.open, previous.close)
    && Math.max(last.open, last.close) >= Math.max(previous.open, previous.close);
  if (engulf) return bull ? 'bullish_engulfing' : 'bearish_engulfing';
  const body = Math.max(Math.abs(last.close - last.open), Number.EPSILON);
  const upper = last.high - Math.max(last.open, last.close), lower = Math.min(last.open, last.close) - last.low;
  if (lower >= body * 2 && upper <= body) return 'bullish_pin_rejection';
  if (upper >= body * 2 && lower <= body) return 'bearish_pin_rejection';
  return 'none';
}

function points(series, rows, period) {
  return Array(period - 1).fill(null).concat(series || []).slice(-rows.length)
    .map((value, i) => ({ time: rows[i].time, value: value == null ? null : round(value) }));
}

function frameAnalysis(timeframe, input, error) {
  const seconds = FX_ANALYST_TIMEFRAMES[timeframe];
  const checked = validatedClosed(input, seconds);
  const why = error || checked.error;
  if (why) return { signal: 'NEUTRAL', error: why, chart: { timeframe, candles: [], ema9: [], ema21: [], support_resistance: { support: [], resistance: [] }, support_resistance_zones: { support: [], resistance: [] }, trendlines: { highs: [], lows: [] }, overlays: null } };

  const rows = checked.rows, closes = rows.map(c => c.close), last = rows.at(-1), previous = rows.at(-2);
  const e9Series = emaSeries(closes, 9), e21Series = emaSeries(closes, 21), e9 = e9Series?.at(-1), e21 = e21Series?.at(-1);
  const rsi14 = rsi(closes, 14), macd12 = macd(closes), levels = findLevels(rows, 50, 5);
  const pattern = candlePattern(previous, last);
  let score = 0;
  if (e9 > e21) score++;
  else if (e9 < e21) score--;
  if (last.close > e21) score++;
  else if (last.close < e21) score--;
  if (macd12?.histogram > 0) score++;
  else if (macd12?.histogram < 0) score--;
  if (rsi14 >= 55 && rsi14 < 70) score++;
  else if (rsi14 > 70) score--;
  else if (rsi14 <= 45 && rsi14 > 30) score--;
  else if (rsi14 < 30) score++;
  if (/^bullish_/.test(pattern)) score++;
  else if (/^bearish_/.test(pattern)) score--;
  const signal = score >= 3 ? 'BUY' : score <= -3 ? 'SELL' : 'NEUTRAL';
  const highs = pivots(rows, 'high'), lows = pivots(rows, 'low');
  const trendline = pair => pair.length === 2 ? [{ from: pair[0], to: pair[1] }] : [];
  const zones = (levelsList, side) => levelsList.map(level => {
    const candle = rows.reduce((best, c) => Math.abs((side === 'support' ? c.low : c.high) - level) < Math.abs((side === 'support' ? best.low : best.high) - level) ? c : best, rows[0]);
    return side === 'support'
      ? { price: round(level), low: round(candle.low), high: round(Math.max(candle.low, candle.open, candle.close)) }
      : { price: round(level), low: round(Math.min(candle.high, candle.open, candle.close)), high: round(candle.high) };
  });
  return {
    signal, score, last, previous, e9, e21, rsi14, macd: macd12 ? { line: round(macd12.line), signal: round(macd12.signal), histogram: round(macd12.histogram) } : null,
    pattern, levels, highs, lows,
    chart: {
      timeframe,
      candles: rows.map(c => ({ ...c, time: round(c.time, 3) })),
      ema9: points(e9Series, rows, 9),
      ema21: points(e21Series, rows, 21),
      support_resistance: { support: levels.support.map(value => round(value)), resistance: levels.resistance.map(value => round(value)) },
      support_resistance_zones: { support: zones(levels.support, 'support'), resistance: zones(levels.resistance, 'resistance') },
      trendlines: { highs: trendline(highs), lows: trendline(lows) },
      overlays: null
    }
  };
}

function pipSize(pair) { return /JPY$/.test(String(pair)) ? 0.01 : 0.0001; }
function stopPivot(frame, direction) {
  const pivotsFound = direction === 'BUY' ? frame.lows : frame.highs;
  return pivotsFound.at(-1)?.value ?? null;
}
function pickTarget(frame, direction, entry, risk) {
  const levels = direction === 'BUY' ? frame.levels.resistance : frame.levels.support;
  const eligible = levels.filter(level => direction === 'BUY' ? level > entry : level < entry)
    .filter(level => Math.abs(level - entry) >= risk * 1.5);
  return eligible.length ? eligible[0] : null;
}
function syncTradeOverlays(result) {
  const apply = chart => {
    if (!chart) return;
    const entryArrow = result.signal === 'WAIT' || !finite(result.entry) ? [] : [{
      time: chart.candles?.at(-1)?.time ?? null, direction: result.signal, price: result.entry,
      label: result.signal + ' entry'
    }];
    chart.overlays = {
      signal: result.signal,
      entry: result.signal === 'WAIT' ? null : result.entry,
      sl: result.signal === 'WAIT' ? null : result.sl,
      tp: result.signal === 'WAIT' ? null : result.tp,
      entry_arrow: entryArrow
    };
  };
  for (const tf of MTF) apply(result.chart_data[tf]);
  apply(result.chart_data.requested_context);
}

function baseResult({ pair, timeframe, frames, requestedFrame, currentPrice, currentTime, dataSources, mode, now }) {
  const alignment = Object.fromEntries(MTF.map(tf => [tf, frames[tf].signal]));
  const buys = MTF.filter(tf => alignment[tf] === 'BUY').length;
  const sells = MTF.filter(tf => alignment[tf] === 'SELL').length;
  const direction = buys >= 2 ? 'BUY' : sells >= 2 ? 'SELL' : 'WAIT';
  const agreeing = direction === 'BUY' ? buys : direction === 'SELL' ? sells : 0;
  const maxScore = direction === 'BUY'
    ? Math.max(0, ...MTF.filter(tf => alignment[tf] === 'BUY').map(tf => frames[tf].score))
    : direction === 'SELL' ? Math.max(0, ...MTF.filter(tf => alignment[tf] === 'SELL').map(tf => Math.abs(frames[tf].score))) : 0;
  const confidence = direction === 'WAIT' || !Number.isFinite(Number(currentPrice)) || Number(currentPrice) <= 0
    ? 0 : Math.min(95, 50 + agreeing * 8 + Math.min(10, maxScore * 2));
  const last = requestedFrame.last || null;
  const entry = Number(currentPrice);
  let signal = confidence >= 70 ? direction : 'WAIT', action = signal === 'WAIT' ? 'NONE' : 'NEW';
  let sl = null, tp = null, rewardRisk = null;
  const reasons = [];
  if (MTF.some(tf => frames[tf].error)) reasons.push('One or more MTF histories are unavailable; unavailable frames do not vote.');
  if (requestedFrame.error) reasons.push(`Requested ${timeframe} history is unavailable: ${requestedFrame.error}`);
  if (!Number.isFinite(entry) || entry <= 0) reasons.push('A fresh live price is unavailable; no entry level or directional signal is issued.');
  if (direction === 'WAIT') reasons.push('Fewer than two of the 1m, 5m and 10m frames agree on direction.');
  if (confidence > 0 && confidence < 70) reasons.push('The deterministic confluence quality score is below the 70-point minimum.');

  if (signal === 'BUY' || signal === 'SELL') {
    const pip = pipSize(pair), pivot = stopPivot(requestedFrame, signal);
    if (pivot == null) {
      signal = 'WAIT'; action = 'NONE'; reasons.push('No confirmed recent swing point is available for a structurally valid stop.');
    } else {
      sl = signal === 'BUY' ? pivot - pip : pivot + pip;
      const risk = signal === 'BUY' ? entry - sl : sl - entry, riskPips = risk / pip;
      if (!(risk > 0)) {
        signal = 'WAIT'; action = 'NONE'; sl = null;
        reasons.push('The live entry is on the wrong side of the confirmed swing stop; no invalid stop is issued.');
      } else if (riskPips > MAX_STOP_PIPS) {
        signal = 'WAIT'; action = 'NONE'; sl = null;
        reasons.push(`The swing-based stop would exceed the ${MAX_STOP_PIPS}-pip maximum; no tighter invented stop is substituted.`);
      } else {
        tp = pickTarget(requestedFrame, signal, entry, risk);
        if (tp == null) {
          signal = 'WAIT'; action = 'NONE'; sl = null;
          reasons.push('No verified support/resistance target provides at least 1.5:1 reward-to-risk; no synthetic target is substituted.');
        } else {
          const rr = Math.abs(tp - entry) / risk;
          rewardRisk = `1:${rr.toFixed(2)}`;
        }
      }
    }
  }

  if (!reasons.length) {
    const pattern = requestedFrame.pattern || 'none';
    const emaContext = requestedFrame.e9 != null && requestedFrame.e21 != null
      ? `${timeframe} EMA(9) ${requestedFrame.e9 > requestedFrame.e21 ? 'above' : requestedFrame.e9 < requestedFrame.e21 ? 'below' : 'at'} EMA(21)` : `${timeframe} EMA context unavailable`;
    reasons.push(`${agreeing}/3 MTF frames align ${signal}; ${emaContext}; RSI(14) ${requestedFrame.rsi14 == null ? 'unavailable' : requestedFrame.rsi14.toFixed(1)}; MACD ${requestedFrame.macd ? (requestedFrame.macd.histogram > 0 ? 'positive' : requestedFrame.macd.histogram < 0 ? 'negative' : 'flat') : 'unavailable'}; last candle pattern: ${pattern}. Quality score is not a probability of profit.`);
  }

  const entryArrow = signal === 'WAIT' ? [] : [{ time: last?.time ?? null, direction: signal, price: round(entry), label: signal === 'BUY' ? 'BUY entry' : 'SELL entry' }];
  const chartData = Object.fromEntries(MTF.map(tf => {
    const chart = frames[tf].chart;
    return [tf, { ...chart, overlays: { signal, entry: signal === 'WAIT' ? null : round(entry), sl: signal === 'WAIT' ? null : round(sl), tp: signal === 'WAIT' ? null : round(tp), entry_arrow: entryArrow } }];
  }));
  const chartOutput = {
    ...chartData,
    requested_context: timeframe === '15m' ? requestedFrame.chart : null,
    description: 'Structured chart series only. Candles, EMA lines, swing trendlines, support/resistance and any validated trade-level overlays use verified provider data. Chart is not an order.'
  };
  const sourceNames = [...new Set(Object.values(dataSources || {}).filter(Boolean).map(String))];
  return {
    mode, pair, timeframe, mtf_alignment: alignment, signal, action, entry: signal === 'WAIT' ? null : round(entry),
    sl: signal === 'WAIT' ? null : round(sl), tp: signal === 'WAIT' ? null : round(tp), risk_reward: signal === 'WAIT' ? null : rewardRisk,
    confidence: signal === 'WAIT' ? Math.min(69, confidence) : confidence,
    reason: reasons.join(' '), previous_signal_check: 'none',
    data_source: sourceNames.join(' · ') || 'unavailable', analyzed_at: new Date(now).toISOString(),
    current_quote: Number.isFinite(entry) && entry > 0 ? { price: round(entry), time: currentTime != null && finite(currentTime) ? timeSec(currentTime) : null } : null,
    latest_closed_candle: last ? { time: last.time, close: last.close } : null,
    indicators: Object.fromEntries(MTF.map(tf => [tf, {
      ema9: frames[tf].e9 == null ? null : round(frames[tf].e9), ema21: frames[tf].e21 == null ? null : round(frames[tf].e21),
      rsi14: frames[tf].rsi14 == null ? null : round(frames[tf].rsi14, 3), macd: frames[tf].macd,
      pattern: frames[tf].pattern || null, support_resistance: frames[tf].levels || { support: [], resistance: [] }, error: frames[tf].error || null
    }])),
    chart_data: chartOutput
  };
}

/** Deterministic, read-only FX workflow. Inputs must be real provider candles; no fill or synthetic series is created. */
export function analyzeForex({ pair, timeframe = '5m', candlesByTimeframe = {}, errorsByTimeframe = {}, currentPrice = null, currentTime = null, dataSources = {}, mode = 'ANALYZE', previous = null, now = Date.now() } = {}) {
  if (!INSTRUMENT_MAP[String(pair || '')] || INSTRUMENT_MAP[String(pair || '')].c !== 'forex') throw new TypeError('Choose a supported forex pair, not a metal or CFD.');
  if (!Object.hasOwn(FX_ANALYST_TIMEFRAMES, timeframe)) throw new TypeError('Timeframe must be 1m, 5m, 10m or 15m.');
  if (!['ANALYZE', 'UPDATE'].includes(mode)) throw new TypeError('Mode must be ANALYZE or UPDATE.');
  const required = [...MTF, ...(timeframe === '15m' ? ['15m'] : [])];
  const frames = Object.fromEntries(required.map(tf => [tf, frameAnalysis(tf, candlesByTimeframe[tf], errorsByTimeframe[tf])]));
  const requestedFrame = frames[timeframe] || frames[timeframe === '1m' ? '1m' : timeframe === '5m' ? '5m' : '10m'];
  const result = baseResult({ pair, timeframe, frames, requestedFrame, currentPrice, currentTime, dataSources, mode, now });

  if (mode === 'UPDATE' && previous && (previous.signal === 'BUY' || previous.signal === 'SELL') && finite(previous.entry) && finite(previous.sl) && finite(previous.tp) && finite(previous.latest_closed_candle?.time)) {
    const newTime = result.latest_closed_candle?.time;
    const oldTime = Number(previous.latest_closed_candle?.time);
    const activeDirection = previous.signal;
    if (!finite(newTime)) {
      result.signal = 'WAIT'; result.action = 'NONE'; result.entry = null; result.sl = null; result.tp = null; result.risk_reward = null;
      result.confidence = 0; result.previous_signal_check = 'none';
      result.reason = 'The requested timeframe has no verified closed candle, so the previous signal cannot be checked and no current direction is issued.';
      syncTradeOverlays(result);
      return result;
    }
    if (Number.isFinite(oldTime) && Number.isFinite(newTime) && newTime <= oldTime) {
      result.signal = activeDirection; result.action = 'HOLD'; result.entry = previous.entry ?? null; result.sl = previous.sl ?? null;
      result.tp = previous.tp ?? null; result.risk_reward = previous.risk_reward ?? null; result.confidence = Number(previous.confidence) || 0;
      result.previous_signal_check = 'valid'; result.reason = 'No newer closed candle is available; previous reading retained unchanged and not refreshed.';
      syncTradeOverlays(result);
      return result;
    }
    const latest = frames[timeframe].last;
    const stopHit = latest && (activeDirection === 'BUY' ? latest.low <= Number(previous.sl) : latest.high >= Number(previous.sl));
    const targetHit = latest && (activeDirection === 'BUY' ? latest.high >= Number(previous.tp) : latest.low <= Number(previous.tp));
    if (stopHit || targetHit) {
      result.signal = 'WAIT'; result.action = 'EXIT'; result.entry = null; result.sl = null; result.tp = null; result.risk_reward = null;
      result.confidence = 0; result.previous_signal_check = stopHit ? 'invalidated' : 'valid';
      result.reason = stopHit && targetHit
        ? 'The new closed candle touched both the previous stop and target; intrabar order is unknown, so the previous setup is closed conservatively.'
        : stopHit ? 'The new closed candle reached the previous stop level; the prior setup is invalidated.' : 'The new closed candle reached the previous target; the prior setup is complete.';
      syncTradeOverlays(result);
      return result;
    }
    if (result.signal === activeDirection) {
      result.action = 'HOLD'; result.previous_signal_check = 'valid';
      result.reason = 'The previous direction remains confirmed by fresh candle evidence. ' + result.reason;
    } else if (result.signal === (activeDirection === 'BUY' ? 'SELL' : 'BUY')) {
      result.action = 'REVERSE'; result.previous_signal_check = 'invalidated';
      result.reason = 'The previous direction is invalidated by opposing 2-of-3 confirmation. ' + result.reason;
    } else {
      result.action = 'EXIT'; result.previous_signal_check = 'invalidated';
      result.reason = 'The previous direction no longer has the required 2-of-3 confirmation; stand aside. ' + result.reason;
    }
  } else if (mode === 'UPDATE') {
    result.action = result.signal === 'WAIT' ? 'NONE' : 'NEW';
    result.previous_signal_check = 'none';
    result.reason = 'No prior directional analysis is available for this pair; treated as a fresh analysis. ' + result.reason;
  }
  syncTradeOverlays(result);
  return result;
}

export function forexAnalystFrames() { return [...MTF]; }
export function forexAnalystMinCandles() { return MIN_CANDLES; }
export function forexAnalystMaxStopPips() { return MAX_STOP_PIPS; }
