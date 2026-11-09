/* SCOUT role (master §5) — market research/screening report over the real
   per-timeframe analyses. The 0–100 number is a SETUP-QUALITY/CONFLUENCE SCORE,
   labelled as such — it is NOT a calibrated probability of profit. */

export const SCORE_LABEL = 'quality/confluence score (0-100) — NOT a probability of profit';

export function scoutScreen({ symbol, det, dec, now = Date.now() } = {}) {
  const factors = [];
  const analyses = (det && det.analyses) || {};
  for (const [tf, a] of Object.entries(analyses)) {
    if (!a || a.error) {
      factors.push({ name: tf + '_data', value: null, verdict: 'MISSING', detail: String(a && a.error ? a.error : 'no data') });
      continue;
    }
    factors.push({ name: tf + '_trend', value: a.trend || null, verdict: a.trend && a.trend !== 'RANGE' ? 'ALIGNED' : 'NEUTRAL', detail: 'trend structure' });
    factors.push({ name: tf + '_bias', value: Number.isFinite(a.biasScore) ? a.biasScore : null, verdict: Number(a.biasScore) > 0 ? 'BULL' : Number(a.biasScore) < 0 ? 'BEAR' : 'NEUTRAL', detail: 'signed momentum bias' });
    if (a.indicators && Number.isFinite(a.indicators.atr)) {
      factors.push({ name: tf + '_volatility', value: a.indicators.atr, verdict: 'MEASURED', detail: 'ATR (volatility regime)' });
    }
  }
  return {
    role: 'SCOUT',
    symbol: symbol || (det && det.symbol) || null,
    ts: new Date(now).toISOString(),
    state: factors.length ? 'DONE' : 'UNAVAILABLE',
    score: dec && Number.isFinite(dec.confidence) ? dec.confidence : null,
    scoreLabel: SCORE_LABEL,
    direction: (dec && dec.signal) || null,
    bias: (dec && dec.bias) || null,
    votes: (dec && dec.votes) || null,
    factors,
    note: 'Screening summary from live technical state; the score is explainable (see Signal Analyzer formula) and is not a probability.',
  };
}
