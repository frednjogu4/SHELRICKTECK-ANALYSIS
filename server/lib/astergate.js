/* ASTER — deterministic pre-publication signal gate.
 * Missing evidence is UNKNOWN and never passes. This module does not execute orders.
 */
export const ASTER_WEIGHTS = Object.freeze({
  htfStructure: 20,
  priceAction: 20,
  setupQuality: 20,
  indicators: 15,
  entryConfirmation: 15,
  newsConditions: 10,
});
export const ASTER_STATUSES = Object.freeze([
  'SCANNING', 'SETUP DETECTED', 'AWAITING CONFIRMATION', 'VALIDATING',
  'READY FOR MANUAL REVIEW', 'REJECTED', 'NO TRADE', 'EXPIRED',
]);
const REQUIRED = Object.freeze([
  'marketDataFresh', 'symbolValid', 'bidAskValid', 'spreadValid', 'ohlcValid',
  'd1Trend', 'h4Trend', 'h1Setup', 'm15Confirmation', 'indicatorsValid',
  'structureValid', 'newsValidated', 'stopLossValid', 'measuredTargetsValid',
  'positionSizingValid', 'brokerConstraintsValid', 'candleCloseConfirmed',
  'riskWithinLimit',
]);
const isBool = (v) => typeof v === 'boolean';
const scorePart = (v) => {
  if (v === true) return 1;
  if (v === false || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
};
const round = (n) => Math.round(n * 100) / 100;

/**
 * evidence must contain explicit booleans for each required check.
 * confluence values are booleans or fractions in [0,1], weighted exactly as
 * specified by ASTER. Account risk is capped at min(1%, configured limit).
 */
export function validateAsterSignal(input = {}, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const minScore = Number.isFinite(options.minimumConfluenceScore)
    ? Math.max(0, Math.min(100, options.minimumConfluenceScore)) : 70;
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const direction = String(input.direction || '').trim().toUpperCase();
  const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : {};
  const confluence = input.confluence && typeof input.confluence === 'object' ? input.confluence : {};
  const checks = REQUIRED.map((name) => {
    const value = name === 'symbolValid' && !symbol ? false : evidence[name];
    return {
      name,
      status: value === true ? 'PASSED' : value === false ? 'FAILED' : 'UNKNOWN',
      evidence: value === true ? 'verified true' : value === false ? 'verified false' : String(input.evidenceDetails?.[name] || 'missing or unverified').slice(0, 240),
    };
  });

  const rr = input.rrAtTp1 == null || input.rrAtTp1 === '' ? NaN : Number(input.rrAtTp1);
  const rrCheck = Number.isFinite(rr) && rr >= 2;
  checks.push({
    name: 'minimum_rr_at_tp1',
    status: Number.isFinite(rr) ? (rrCheck ? 'PASSED' : 'FAILED') : 'UNKNOWN',
    evidence: Number.isFinite(rr) ? 'RR=' + round(rr) : 'RR not supplied',
  });

  const riskPct = input.accountRiskPercent == null || input.accountRiskPercent === '' ? NaN : Number(input.accountRiskPercent);
  const configuredLimit = Number(input.configuredRiskLimitPercent);
  const riskLimitKnown = Number.isFinite(configuredLimit) && configuredLimit > 0;
  const riskLimit = riskLimitKnown ? Math.min(1, configuredLimit) : null;
  const riskKnown = Number.isFinite(riskPct) && riskPct >= 0;
  const riskPass = riskKnown && riskLimitKnown && riskPct <= riskLimit;
  checks.push({
    name: 'account_risk_percent',
    status: !riskKnown || !riskLimitKnown ? 'UNKNOWN' : riskPass ? 'PASSED' : 'FAILED',
    evidence: riskKnown && riskLimitKnown ? riskPct + '%; allowed ≤ ' + riskLimit + '%' : 'account risk or configured limit unavailable',
  });

  const weights = ASTER_WEIGHTS;
  const score = round(Object.keys(weights).reduce((sum, key) =>
    sum + weights[key] * scorePart(confluence[key]), 0));
  const blockers = checks.filter((c) => c.status !== 'PASSED');
  const unknown = blockers.some((c) => c.status === 'UNKNOWN');
  const failed = blockers.some((c) => c.status === 'FAILED');
  const closeState = evidence.candleCloseConfirmed;
  const setupDetected = input.setupDetected === true;
  let status = 'NO TRADE';
  if (direction !== 'LONG' && direction !== 'SHORT') {
    status = 'NO TRADE';
  } else if (closeState === false) {
    status = 'AWAITING CONFIRMATION';
  } else if (failed) {
    status = 'REJECTED';
  } else if (unknown) {
    status = setupDetected ? 'VALIDATING' : 'NO TRADE';
  } else if (score < minScore) {
    status = 'REJECTED';
  } else {
    status = 'READY FOR MANUAL REVIEW';
  }

  const publishable = status === 'READY FOR MANUAL REVIEW';
  const rejectionReasons = blockers.map((c) => c.name + ': ' + c.status);
  if (score < minScore) rejectionReasons.push('confluence_score_below_minimum');
  if (!symbol) rejectionReasons.push('symbol_missing');
  return {
    engine: 'ASTER',
    status,
    publishable,
    executionAuthorized: false,
    symbol: symbol || null,
    direction: direction === 'LONG' || direction === 'SHORT' ? direction : null,
    timestamp: new Date(now).toISOString(),
    score,
    minimumScore: minScore,
    scoreBreakdown: Object.fromEntries(Object.keys(weights).map((key) =>
      [key, round(weights[key] * scorePart(confluence[key]))])),
    checks,
    rejectionReasons,
    finalInstruction: publishable ? 'READY FOR MANUAL REVIEW — no execution authorized.'
      : 'NO TRADE — WAIT FOR A VALIDATED SETUP.',
  };
}
