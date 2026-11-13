/* Six-role pipeline orchestrator (master §5):
   SCOUT -> NEWS -> CHARTS -> STRATEGY -> RISK -> BOSS.
   Each role returns a timestamped report with a clear dependency state
   (DONE | DEGRADED | UNAVAILABLE). Missing data never counts as passed:
   RISK turns unknowns into UNKNOWN checks and BOSS then defaults to WAIT or
   REJECTED — never 'READY FOR MANUAL REVIEW'. The Boss never overrides Risk. */

import { newsContext } from './news.js';
import { technicalEvidence } from './charts.js';
import { scoutScreen } from './scout.js';
import { evaluateStrategy } from './strategy.js';
import { evaluateRisk, bossVerdict } from '../riskgate.js';

export const WORKFLOW_ORDER = ['SCOUT', 'NEWS', 'CHARTS', 'STRATEGY', 'RISK', 'BOSS'];

/**
 * @param {object} in
 *   symbol, det, dec            real analyzer/decision outputs (CHARTS/SCOUT)
 *   newsItems                   provider items or null (dependency state)
 *   rule                        strategy thresholds/levels (entry, sl, tp, minScore...)
 *   riskInput                   optional user/limits state for the RISK role
 *   now                         testability
 */
export function runPipeline(inx) {
  const now = inx?.now || Date.now();
  const charts = technicalEvidence({ det: inx?.det, now });
  const scout = scoutScreen({ symbol: inx?.symbol, det: inx?.det, dec: inx?.dec, now });
  const news = newsContext({ items: inx?.newsItems, now, validityMin: inx?.rule?.validityWindowMin });
  const strategy = evaluateStrategy({ scout, evidence: charts, rule: Object.assign({
    entry: inx?.dec?.entry ?? null, sl: inx?.dec?.stop_loss ?? null, tp: inx?.dec?.tp1 ?? null,
  }, inx?.rule || {}), now });

  /* RISK (independent mandatory gate). Missing user/limits state -> the checks
     that need it are UNKNOWN and the verdict is BLOCKED (never a silent pass). */
  const risk = evaluateRisk(Object.assign({
    stake: inx?.riskInput?.stake,
    limits: inx?.riskInput?.limits,
    opens: inx?.riskInput?.opens,
    dayPnl: inx?.riskInput?.dayPnl,
    killSwitch: !!inx?.riskInput?.killSwitch,
    venue: inx?.riskInput?.venue || 'mt5',
    rr: strategy.rr,
    entry: strategy.entry ?? undefined,
    sl: strategy.stop_loss ?? undefined,
    tp: strategy.tp ?? undefined,
    marketHours: inx?.riskInput?.marketHours ?? (charts.state === 'DONE' && charts.stale === false ? true : null),
    newsBlocked: news.restriction === 'STALE_STAND_DOWN' ? true : (news.state === 'DONE' ? false : null),
    newsEvidenceTrusted: news.state === 'DONE' || news.restriction === 'STALE_STAND_DOWN',
  }, {}));

  /* news may only RESTRICT, never authorize (invariant enforced downstream too) */
  const boss = bossVerdict({ risk, setup: { present: !!strategy.setup, complete: !!strategy.setup, stale: charts.stale === true } });

  const workflow = WORKFLOW_ORDER.map((role) => {
    const rep = { SCOUT: scout, NEWS: news, CHARTS: charts, STRATEGY: strategy, RISK: risk, BOSS: boss }[role];
    const state = rep && (rep.state || (rep.verdict ? 'DONE' : 'UNKNOWN'));
    const summary = role === 'BOSS' ? boss.verdict + ' — ' + boss.reason
      : role === 'RISK' ? risk.verdict + ' — ' + risk.reason
      : (rep && (rep.note || rep.reason)) || '';
    return { role, state, summary, ts: (rep && (rep.ts)) || new Date(now).toISOString() };
  });

  return {
    symbol: inx?.symbol || null,
    ts: new Date(now).toISOString(),
    workflow,
    scout, news, charts, strategy, risk, boss,
    /* the pipeline produces analysis + a verdict — it never executes anything */
    executes: false,
  };
}
