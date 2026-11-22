/* ================================================================
 * AURUM — US stock-index daily signals (educational analytics).
 * Deriv's feed does NOT carry stock indices (probe-verified:
 * US30/NAS100/SPX500 -> InvalidSymbol), so daily candles come from
 * Yahoo Finance's public chart endpoint (keyless), and the signal is
 * a DAILY-TIMEFRAME technical read: deterministic indicator votes
 * (SMA position, trend, 20d momentum, RSI14). One timeframe only —
 * it is NOT the 1m/5m/1h MTF confluence used for Deriv instruments,
 * and it is labelled as such everywhere it is shown.
 * ================================================================ */

export const INDEX_MAP = {
  NAS100: { yahoo: '^NDX', n: 'NASDAQ 100 Index' },
  US30:   { yahoo: '^DJI', n: 'Dow Jones Industrial Average' },
  SPX500: { yahoo: '^GSPC', n: 'S&P 500 Index' }
};

/** Parse Yahoo chart JSON into [{time,open,high,low,close,volume}] (nulls dropped). */
export function parseYahooChart(json) {
  const r = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
  const ts = r && r.timestamp;
  const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
  if (!ts || !q) return [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
    const time = Number(ts[i]);
    if (![time, o, h, l, c].every((v) => Number.isFinite(v) && v > 0) ||
      h < Math.max(o, c, l) || l > Math.min(o, c, h)) continue;
    const rawVolume = q.volume && q.volume[i];
    const volume = rawVolume == null ? null : Number(rawVolume);
    out.push({ time, open: o, high: h, low: l, close: c,
      volume: Number.isFinite(volume) && volume >= 0 ? volume : null });
  }
  return out;
}

const last = (a) => a[a.length - 1];

/** Deterministic daily context read. Needs >= 60 valid, ordered daily bars. */
export function indexDailySignal(candles, ind) {
  if (!Array.isArray(candles) || candles.length < 60) return { ok: false, reason: 'insufficient_history' };
  let previous = 0;
  for (const candle of candles) {
    const time = Number(candle?.time), open = Number(candle?.open), high = Number(candle?.high);
    const low = Number(candle?.low), close = Number(candle?.close);
    const volumeOk = candle?.volume == null || (Number.isFinite(Number(candle.volume)) && Number(candle.volume) >= 0);
    if (![time, open, high, low, close].every(Number.isFinite) || time <= previous ||
      Math.min(open, high, low, close) <= 0 || high < Math.max(open, close, low) ||
      low > Math.min(open, close, high) || !volumeOk)
      return { ok: false, reason: 'invalid_daily_history' };
    previous = time;
  }
  if (!ind || typeof ind.sma !== 'function' || typeof ind.rsi !== 'function')
    return { ok: false, reason: 'indicators_unavailable' };
  const closes = candles.map((c) => Number(c.close));
  const px = last(closes);
  const s20 = ind.sma(closes, 20), s50 = ind.sma(closes, 50);
  const s200 = closes.length >= 200 ? ind.sma(closes, 200) : null;
  const r = ind.rsi(closes, 14);
  const mom20 = ((px - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;
  if (![px, s20, s50, r, mom20].every(Number.isFinite) || px <= 0 || s20 <= 0 || s50 <= 0 ||
      r < 0 || r > 100 || (s200 != null && (!Number.isFinite(s200) || s200 <= 0)))
    return { ok: false, reason: 'invalid_indicator_output' };

  const votes = [];
  let score = 0;
  /* symmetric votes: above/below each contribute +1/-1 so clean downtrends
     can actually reach SELL (a one-sided scale would make SELL unreachable) */
  const vote = (name, v) => { votes.push(name + ' ' + (v > 0 ? '✓' : v < 0 ? '✗' : '· neutral')); score += v; };
  vote('above SMA20', px > s20 ? 1 : -1);
  vote('above SMA50', px > s50 ? 1 : -1);
  if (s200 != null) vote('SMA50 > SMA200', s50 > s200 ? 1 : -1);
  else vote('SMA20 > SMA50', s20 > s50 ? 1 : -1);
  vote('mom20 ' + mom20.toFixed(1) + '%', mom20 > 0 ? 1 : mom20 < 0 ? -1 : 0);
  vote('RSI14 ' + r.toFixed(0), r > 55 ? 1 : r < 45 ? -1 : 0);

  const contextSignal = score >= 3 ? 'BUY' : score <= -3 ? 'SELL' : 'WAIT';
  const bias = score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
  return {
    ok: true, price: px,
    /* Daily index candles alone do not establish an executable, risk-validated
       setup. Keep the directional vote as context only; never publish it as a
       BUY/SELL or assign it a confidence percentage without valid trade levels. */
    signal: 'WAIT', context_signal: contextSignal, analysis_status: 'CONTEXT_ONLY',
    tradeable: false, bias, context_score: score, confidence: null,
    votes: votes.join(' · '),
    entry: null, stop_loss: null, tp1: null, tp2: null,
    wait_reason: 'daily_context_only',
    wait_detail: 'Daily index trend is context only. No validated entry, stop, target, or trade-confidence score is available from this daily feed.'
  };
}
