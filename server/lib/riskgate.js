/* RISK + BOSS — two of the six pipeline roles as real, testable modules
   (master prompt §5). Pure functions: no I/O, no timers, typed by contract:
   evaluateRisk(Input) -> RiskReport, bossVerdict(Input) -> BossReport.

   RISK contract (§5): every check is PASSED | FAILED | UNKNOWN with evidence
   and reason. Missing data is UNKNOWN — never PASSED. Any FAILED or UNKNOWN
   mandatory check BLOCKS approval.

   BOSS contract (§5): verdict is WAIT | SETUP DETECTED | REJECTED |
   READY FOR MANUAL REVIEW. The Boss NEVER overrides Risk: a blocked risk
   report means REJECTED regardless of how good the setup looks. Default is
   WAIT when the setup is absent, contradictory, stale, or incomplete. */

export const CHECK = { PASSED: 'PASSED', FAILED: 'FAILED', UNKNOWN: 'UNKNOWN' };

function check(name, status, evidence, reason, mandatory = true) {
  return { name, status, evidence: String(evidence ?? ''), reason: String(reason ?? ''), mandatory };
}

/**
 * @param {object} in
 *   limits      {{maxStakeUsd:number,maxOpenTrades:number,dailyLossLimitUsd:number}}
 *   stake       number  requested stake (USD)
 *   opens       number  currently open trades for the user
 *   dayPnl      number  realized P&L today (negative = loss)
 *   killSwitch  boolean true = trading halted by the owner
 *   rr          number|null  estimated reward-to-risk (null = not supplied)
 *   marketHours boolean|null  is the instrument in hours (null = unknown)
 *   newsBlocked boolean|null  news/event restriction active (null = unknown)
 * @returns {{checks: Array, verdict: 'APPROVED'|'BLOCKED', approved: boolean,
 *            reason: string, ts: string}}
 */
export function evaluateRisk(inx) {
  const checks = [];
  const L = inx?.limits || {};

  checks.push(check('kill_switch',
    inx?.killSwitch ? CHECK.FAILED : CHECK.PASSED,
    'switch=' + String(!!inx?.killSwitch),
    inx?.killSwitch ? 'Trading is disabled by the kill switch.' : 'Kill switch off.'));

  const stake = Number(inx?.stake);
  checks.push(check('stake_limit',
    !Number.isFinite(L.maxStakeUsd) ? CHECK.UNKNOWN
      : (Number.isFinite(stake) && stake > 0 && stake <= L.maxStakeUsd ? CHECK.PASSED : CHECK.FAILED),
    'stake=' + (Number.isFinite(stake) ? stake : 'invalid') + ' max=' + L.maxStakeUsd,
    Number.isFinite(stake) && stake > 0 && stake <= L.maxStakeUsd
      ? 'Stake within the server-side per-trade limit.'
      : 'Stake $' + (Number.isFinite(stake) ? stake.toFixed(2) : '?') + ' must be > 0 and ≤ $' + L.maxStakeUsd + '.'));

  const opens = Number(inx?.opens ?? 0);
  checks.push(check('open_trades',
    !Number.isFinite(L.maxOpenTrades) ? CHECK.UNKNOWN
      : (opens < L.maxOpenTrades ? CHECK.PASSED : CHECK.FAILED),
    'opens=' + opens + ' max=' + L.maxOpenTrades,
    opens < L.maxOpenTrades
      ? 'Under the open-trades limit.'
      : 'App-side open-trades counter reached (' + opens + '/' + L.maxOpenTrades + '). This is not a live MT5 position scan; no order was authorized.'));

  const pnl = Number(inx?.dayPnl ?? 0);
  checks.push(check('daily_loss',
    !Number.isFinite(L.dailyLossLimitUsd) ? CHECK.UNKNOWN
      : (pnl <= -L.dailyLossLimitUsd ? CHECK.FAILED : CHECK.PASSED),
    'dayPnl=' + (Number.isFinite(pnl) ? pnl.toFixed(2) : '?'),
    pnl <= -L.dailyLossLimitUsd
      ? 'Daily loss limit of $' + L.dailyLossLimitUsd + ' reached (today: $' + pnl.toFixed(2) + ').'
      : 'Daily loss within limit.'));

  /* reward-to-risk. Fixed-risk stake contracts (venue 'deriv') have a defined
     maximum loss = the stake itself — that is evidence, not a missing value.
     CFD/Exness plans need a real SL/TP: derive rr from entry/sl/tp when given. */
  const venue = String(inx?.venue || 'mt5');
  let rr = Number(inx?.rr);
  let rrEvidence = inx?.rr != null ? 'rr=' + rr : null;
  if (venue === 'deriv' && inx?.rr == null) {
    checks.push(check('reward_to_risk', CHECK.PASSED,
      'fixed-risk contract: max loss = stake',
      'Stake-risked contract: the maximum loss is the stake itself (defined risk).'));
  } else {
    const e = Number(inx?.entry), sl = Number(inx?.sl), tp = Number(inx?.tp);
    if (inx?.rr == null && Number.isFinite(e) && Number.isFinite(sl) && Number.isFinite(tp) && e !== sl) {
      rr = Math.abs(tp - e) / Math.abs(e - sl);
      rrEvidence = 'rr=' + rr.toFixed(2) + ' (entry ' + e + ', SL ' + sl + ', TP ' + tp + ')';
    }
    checks.push(check('reward_to_risk',
      rrEvidence == null ? CHECK.UNKNOWN : (Number.isFinite(rr) && rr >= 1 ? CHECK.PASSED : CHECK.FAILED),
      rrEvidence || 'not supplied',
      rrEvidence == null
        ? 'No SL/TP plan supplied — reward-to-risk is UNKNOWN (missing data never counts as passed).'
        : (rr >= 1 ? 'Reward-to-risk ≥ 1.' : 'Reward-to-risk ' + rr.toFixed(2) + ' is below the minimum 1.0.')));
  }

  checks.push(check('market_hours',
    inx?.marketHours == null ? CHECK.UNKNOWN : (inx.marketHours ? CHECK.PASSED : CHECK.FAILED),
    inx?.marketHours == null ? 'not supplied' : 'open=' + inx.marketHours,
    inx?.marketHours == null
      ? 'Market-hours state not supplied — UNKNOWN.'
      : (inx.marketHours ? 'Instrument is in trading hours.' : 'Market is closed for this instrument.')));

  checks.push(check('news_event',
    inx?.newsBlocked == null ? CHECK.UNKNOWN : (inx.newsBlocked ? CHECK.FAILED : CHECK.PASSED),
    inx?.newsBlocked == null ? 'not supplied' : 'restricted=' + inx.newsBlocked,
    inx?.newsBlocked == null
      ? 'News/event restriction state not supplied — UNKNOWN.'
      : (inx.newsBlocked ? 'High-impact news restriction is active.' : 'No active news restriction.')));

  const blocking = checks.filter(c => c.mandatory && c.status !== CHECK.PASSED);
  const failed = blocking.filter(c => c.status === CHECK.FAILED);
  const verdict = blocking.length ? 'BLOCKED' : 'APPROVED';
  const reason = !blocking.length
    ? 'All mandatory checks passed.'
    : failed.length
      ? 'Blocked: ' + failed.map(c => c.name + ' — ' + c.reason).join(' ')
      : 'Blocked: mandatory checks UNKNOWN (missing data never counts as passed): '
        + blocking.map(c => c.name).join(', ') + '.';

  return { checks, verdict, approved: verdict === 'APPROVED', reason, ts: new Date().toISOString() };
}

/**
 * BOSS — final orchestration (§5). NEVER overrides RISK.
 * @param {{risk: {verdict: string}, setup: {present:boolean, stale?:boolean,
 *   contradictory?:boolean, complete?:boolean, rr?:number}}} inx
 * @returns {{verdict: 'WAIT'|'SETUP DETECTED'|'REJECTED'|'READY FOR MANUAL REVIEW',
 *            reason: string, riskVerdict: string}}
 */
export function bossVerdict(inx) {
  const risk = inx?.risk || { verdict: 'UNKNOWN' };
  const s = inx?.setup || { present: false };
  const riskVerdict = String(risk.verdict || 'UNKNOWN');

  /* Spec §5: default to WAIT when the setup is absent, contradictory, stale,
     or incomplete — that is a 'nothing to do now', not a rejection. */
  if (!s.present) {
    return { verdict: 'WAIT', reason: 'No setup present — default is WAIT.', riskVerdict };
  }
  if (s.stale || s.contradictory || s.complete === false) {
    return {
      verdict: 'WAIT',
      reason: 'Setup is ' + [s.stale && 'stale', s.contradictory && 'contradictory', s.complete === false && 'incomplete'].filter(Boolean).join(' and ')
        + ' — default is WAIT.',
      riskVerdict,
    };
  }
  /* A real setup on the table — Risk is the mandatory gate and the Boss NEVER
     overrides it: anything short of APPROVED means REJECTED. */
  if (riskVerdict !== 'APPROVED') {
    return {
      verdict: 'REJECTED',
      reason: 'Risk gate is ' + riskVerdict + ' — the Boss never overrides Risk. ' + (inx?.risk?.reason || ''),
      riskVerdict,
    };
  }
  return {
    verdict: 'READY FOR MANUAL REVIEW',
    reason: 'Risk approved and setup is complete: human decides. No automatic execution from this verdict.',
    riskVerdict,
  };
}
