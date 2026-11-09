/* CHARTS role (master §5) — thin typed adapter over the real deterministic
   analyzer (server/lib/analyzer.js). No new indicator math here: this module
   reports the technical evidence with timestamps and data-freshness state. */

import { votesSummary, freshestCandleAge } from '../analyzer.js';

export function technicalEvidence({ det, now = Date.now() } = {}) {
  if (!det || !det.analyses) {
    return { role: 'CHARTS', ts: new Date(now).toISOString(), state: 'UNAVAILABLE', note: 'No analysis input — technical evidence cannot be claimed.', timeframes: [], repainting: false };
  }
  const ageSec = freshestCandleAge(det);
  const timeframes = ['m1', 'm5', 'h1'].map((k) => {
    const a = det.analyses[k] || {};
    return {
      tf: k,
      error: a.error || null,
      trend: a.trend || null,
      signal: a.signal || null,
      biasScore: Number.isFinite(a.biasScore) ? a.biasScore : null,
      indicators: a.indicators ? {
        rsi: a.indicators.rsi ?? null, macd: a.indicators.macd ?? null,
        ema: a.indicators.ema ?? null, atr: a.indicators.atr ?? null,
      } : null,
      candleTs: a.candleTs ?? a.ts ?? null,
      forming: a.forming ?? null,
    };
  });
  return {
    role: 'CHARTS',
    ts: new Date(now).toISOString(),
    state: det.ok ? 'DONE' : 'DEGRADED',      /* det.ok false = no MTF confirmation / bad data */
    dataAgeSec: Number.isFinite(ageSec) ? ageSec : null,
    stale: Number.isFinite(ageSec) ? ageSec > (3 * 3600 + 300) : null,
    mtfSignal: det.mtfSignal || null,
    votes: votesSummary(det.analyses),
    timeframes,
    repainting: false,                        /* deterministic, closed-candle math only */
    note: 'Technical evidence from closed candles; values on still-forming candles are provisional.',
  };
}
