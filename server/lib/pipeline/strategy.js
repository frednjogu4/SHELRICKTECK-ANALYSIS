/* STRATEGY role (master §5) — explicit, reproducible rule evaluation over the
   SCOUT + CHARTS reports. Every condition is listed with pass/fail and value.
   Versioned so a result is auditable; thresholds are config, not vibes. */

export const STRATEGY_VERSION = 'std-mtf-v1';
/* §8: automation entry needs quality score >= threshold (default 70/100) and R:R >= 1.0.
   The 70-point threshold is a strategy-quality score, not a 70% probability of profit. */
export const DEFAULT_MIN_SCORE = 70;

export function evaluateStrategy({ scout, evidence, rule = {}, now = Date.now() } = {}) {
  const minScore = Number.isFinite(rule.minScore) ? Number(rule.minScore) : DEFAULT_MIN_SCORE;
  const maxDataAgeSec = Number.isFinite(rule.maxDataAgeSec) ? Number(rule.maxDataAgeSec) : 3 * 3600 + 300;
  const validityWindowMin = Number.isFinite(rule.validityWindowMin) ? Number(rule.validityWindowMin) : 25;

  const mtf = evidence && evidence.mtfSignal;
  const score = scout && scout.score;
  const dir = mtf === 'BUY_CONFIRMED' ? 'BUY' : mtf === 'SELL_CONFIRMED' ? 'SELL' : null;

  /* levels come from the scout/decision report when the caller threads them */
  const entry = rule.entry ?? null, sl = rule.sl ?? null, tp = rule.tp ?? null;
  const rr = (Number.isFinite(entry) && Number.isFinite(sl) && Number.isFinite(tp) && Number(entry) !== Number(sl))
    ? Math.abs(Number(tp) - Number(entry)) / Math.abs(Number(entry) - Number(sl))
    : null;

  const conditions = [
    { rule: 'mtf_confirmed', required: true, pass: !!dir, value: mtf || 'none', detail: '2-of-3 timeframe confirmation is required for a tradeable direction.' },
    { rule: 'quality_score_min', required: true, pass: Number.isFinite(score) && score >= minScore, value: Number.isFinite(score) ? score : 'missing', detail: 'quality score must be ≥ ' + minScore + '/100 (quality score, not a probability).' },
    { rule: 'reward_to_risk_min', required: true, pass: Number.isFinite(rr) && rr >= 1, value: Number.isFinite(rr) ? Math.round(rr * 100) / 100 : 'no SL/TP plan', detail: 'reward-to-risk must be ≥ 1.0.' },
    { rule: 'data_fresh', required: true, pass: Number.isFinite(evidence && evidence.dataAgeSec) && evidence.dataAgeSec <= maxDataAgeSec, value: Number.isFinite(evidence && evidence.dataAgeSec) ? evidence.dataAgeSec + 's' : 'unknown', detail: 'candle data must be fresh (no stale decisions).' },
    { rule: 'no_wait_state', required: true, pass: !!(scout && scout.direction && scout.direction !== 'WAIT'), value: (scout && scout.direction) || 'missing', detail: 'a WAIT decision is never a setup.' },
    { rule: 'news_not_authorizing', required: true, pass: true, value: 'n/a', detail: 'news may restrict entries but never authorizes one (invariant).' },
  ];
  const setup = conditions.every(c => !c.required || c.pass);
  return {
    role: 'STRATEGY',
    ts: new Date(now).toISOString(),
    version: STRATEGY_VERSION,
    config: { minScore, maxDataAgeSec, validityWindowMin },
    state: 'DONE',
    setup,
    direction: setup ? dir : null,
    entry: setup ? entry : null,
    invalidation: setup ? sl : null,
    stop_loss: setup ? sl : null,
    tp: setup ? tp : null,
    rr: setup ? rr : null,
    expiry: new Date(now + validityWindowMin * 60000).toISOString(), /* setup validity window */
    conditions,
    note: 'Rule evaluation is explicit and reproducible: every condition above carries its own pass/fail and value.',
  };
}
