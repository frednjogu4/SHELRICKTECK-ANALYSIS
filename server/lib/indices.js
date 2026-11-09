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
    if (![o, h, l, c].every((v) => Number.isFinite(v) && v > 0)) continue;
    out.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: (q.volume && q.volume[i]) || 0 });
  }
  return out;
}

const last = (a) => a[a.length - 1];

/** Deterministic daily technical read. Needs >= 60 closes. */
export function indexDailySignal(candles, ind) {
  const closes = (candles || []).map((c) => c.close);
  if (closes.length < 60) return { ok: false, reason: 'insufficient_history' };
  const px = last(closes);
  const s20 = ind.sma(closes, 20), s50 = ind.sma(closes, 50);
  const s200 = closes.length >= 200 ? ind.sma(closes, 200) : null;
  const r = ind.rsi(closes, 14);
  const mom20 = ((px - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;

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

  const signal = score >= 3 ? 'BUY' : score <= -3 ? 'SELL' : 'WAIT';
  const confidence = Math.min(90, 50 + Math.abs(score) * 8);
  return {
    ok: true, price: px, signal,
    bias: score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral',
    confidence, votes: votes.join(' · '), score,
    entry: null, stop_loss: null, tp1: null, tp2: null /* indices: analysis-only, no order levels invented */
  };
}
