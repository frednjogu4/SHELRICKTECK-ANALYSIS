/* ================================================================
 * AURUM — local deterministic decision (key-free fallback)
 *
 * Produces the SAME JSON contract as the Claude decision, but from the
 * computed evidence alone. Used when:
 *   - ANTHROPIC_API_KEY is not set (our default until keys arrive)
 *   - the daily Opus budget is exhausted
 *   - the API request times out / errors
 *   - the frontend cannot reach the server (single-file export)
 * Always clearly labelled via `model: 'technical'` — deterministic
 * analysis on live candles; never presented as AI output.
 * ================================================================ */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function localDecision(det) {
  const { analyses, mtfSignal, symbol } = det;
  const valid = [analyses.m1, analyses.m5, analyses.h1].filter((a) => a && !a.error && a.signal);
  const primary = [analyses.m5, analyses.h1, analyses.m1].find((a) => a && !a.error) || null;

  const avgBias = valid.length ? valid.reduce((s, a) => s + a.biasScore, 0) / valid.length : 0;
  /* leans get direction-aware LEVELS but never a BUY/SELL call — only a
     true 2-of-3 confirmation can produce a tradeable signal */
  const dir = mtfSignal === 'BUY_CONFIRMED' ? 1
    : mtfSignal === 'SELL_CONFIRMED' ? -1
    : mtfSignal === 'BULLISH_LEAN' ? 1
    : mtfSignal === 'BEARISH_LEAN' ? -1 : 0;
  const confirmed = (mtfSignal === 'BUY_CONFIRMED' || mtfSignal === 'SELL_CONFIRMED') && valid.length >= 2;

  const atr = primary?.indicators?.atr;
  const price = primary?.currentPrice ?? null;
  let a = atr || (price ? price * 0.002 : 1);
  /* noise floor on the stop distance (user pre-real-money review): a 1m ATR
     on majors can be 1–2 pips, which normal noise stops out instantly.
     Enforce a sane minimum ATR unit per instrument class (pips → price). */
  {
    const s = String(symbol || '');
    const pip = /JPY$/.test(s.replace('/', '')) ? 0.01 : /XAU|XAG|BTC|ETH|VOL|BOOM|CRASH|stp/i.test(s) ? 0 : 0.0001;
    if (pip > 0) a = Math.max(a, pip * 8); /* ≥ 8 pips on fx (0.0008 / 0.08 JPY) */
  }

  const entry = price;
  const sl = confirmed ? (dir > 0 ? entry - 1.5 * a : entry + 1.5 * a) : entry - a;
  const tp1 = confirmed ? (dir > 0 ? entry + 2.25 * a : entry - 2.25*a) : entry + a;
  const tp2 = confirmed ? (dir > 0 ? entry + 4 * a : entry - 4 * a) : entry + 2 * a;

  const signal = confirmed ? (dir > 0 ? 'BUY' : 'SELL') : 'WAIT';
  let confidence = 15 + valid.length * 7 + Math.min(Math.abs(avgBias), 5) * 5 + (confirmed ? 20 : 0);
  if (signal === 'WAIT') confidence = Math.min(confidence, 45);
  confidence = Math.round(clamp(confidence, 5, 93));

  const rrr = Math.abs(tp1 - sl) > 0 ? Math.round((Math.abs(tp1 - entry) / Math.abs(entry - sl)) * 100) / 100 : null;
  const trend = primary?.trend || 'CONSOLIDATION';
  const rsiVal = primary?.indicators?.rsi;
  const hist = primary?.indicators?.macd?.histogram;

  const votes = valid.map((v) => `${v.timeframe} ${v.biasScore >= 0 ? '+' : ''}${v.biasScore} ${v.signal}`).join(', ') || 'no valid timeframes';
  const bias = mtfSignal === 'BUY_CONFIRMED' || mtfSignal === 'BULLISH_LEAN' ? 'bullish'
    : mtfSignal === 'SELL_CONFIRMED' || mtfSignal === 'BEARISH_LEAN' ? 'bearish' : 'neutral';
  const rationale = confirmed
    ? `${mtfSignal.replace('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())} with ${valid.length}/3 timeframe votes (${votes}). ${trend} on the analysis timeframe; entry at market with risk capped at 1.5x ATR.`
    : `No 2-of-3 timeframe confirmation (${votes}) — standing aside. ${trend} conditions but the vote is split or incomplete; wait for alignment before committing risk.`;

  const technical = [
    `trend=${trend}`,
    `rsi14=${rsiVal === null || rsiVal === undefined ? 'n/a' : rsiVal.toFixed(1)}`,
    `macd_hist=${hist === undefined || hist === null ? 'n/a' : hist.toFixed(5)}`,
    `ema20=${primary?.indicators?.ema20?.toFixed?.(4) ?? 'n/a'}`,
    `ema50=${primary?.indicators?.ema50?.toFixed?.(4) ?? 'n/a'}`,
    `atr=${atr?.toFixed?.(5) ?? 'n/a'}`,
    `mtf=${mtfSignal}`
  ].join(' · ');

  const risks = [];
  if (!confirmed) risks.push('Timeframes do not agree (no 2-of-3 confirmation) — direction is unproven.');
  if (valid.length < 3) risks.push('One or more timeframes lacked sufficient data; the vote was incomplete.');
  risks.push('Levels derived from live Deriv candles — verify against your broker quote before entry.');
  risks.push('Sentiment is neutral (50) unless a news brief is supplied.');
  risks.push('Entry, 1.5x-ATR stop and targets are model defaults — apply your own position-size limits.');

  const levels = primary?.levels || { support: [], resistance: [] };
  const nextWatch = confirmed && dir > 0
    ? `Reclaim of ${levels.resistance[0] ?? 'prior high'} extends the move; lose ${levels.support[0] ?? 'the entry zone'} invalidates.`
    : confirmed && dir < 0
      ? `Break of ${levels.support[0] ?? 'prior low'} extends lower; reclaim ${levels.resistance[0] ?? 'the entry zone'} invalidates.`
      : `Revisit when 2 of 3 timeframes align; next levels: S ${levels.support[0] ?? '-'} / R ${levels.resistance[0] ?? '-'}.`;

  return {
    symbol,
    signal,
    bias,
    confidence,
    entry,
    stop_loss: sl,
    tp1,
    tp2,
    rrr,
    rationale,
    technical_summary: technical,
    key_levels: { support: levels.support, resistance: levels.resistance },
    risks,
    next_watch: nextWatch,
    model: 'technical'
  };
}
