import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAsterSignal, ASTER_WEIGHTS } from '../lib/astergate.js';

const allEvidence = Object.fromEntries([
  'marketDataFresh','symbolValid','bidAskValid','spreadValid','ohlcValid',
  'd1Trend','h4Trend','h1Setup','m15Confirmation','indicatorsValid',
  'structureValid','newsValidated','stopLossValid','measuredTargetsValid',
  'positionSizingValid','brokerConstraintsValid','candleCloseConfirmed','riskWithinLimit'
].map((k) => [k, true]));
const allConfluence = Object.fromEntries(Object.keys(ASTER_WEIGHTS).map((k) => [k, 1]));
const valid = {
  symbol: 'EURUSD', direction: 'LONG', setupDetected: true, evidence: allEvidence,
  confluence: allConfluence, rrAtTp1: 2.1, accountRiskPercent: 0.5,
  configuredRiskLimitPercent: 1,
};

test('ASTER permits manual review only when every mandatory check and score pass', () => {
  const r = validateAsterSignal(valid, { now: 0 });
  assert.equal(r.status, 'READY FOR MANUAL REVIEW');
  assert.equal(r.publishable, true);
  assert.equal(r.executionAuthorized, false);
  assert.equal(r.score, 100);
});

test('ASTER fails closed on missing evidence', () => {
  const evidence = { ...allEvidence };
  delete evidence.newsValidated;
  const r = validateAsterSignal({ ...valid, evidence });
  assert.equal(r.status, 'VALIDATING');
  assert.equal(r.publishable, false);
  assert.ok(r.rejectionReasons.includes('newsValidated: UNKNOWN'));
});

test('ASTER rejects RR below 1:2 regardless of confluence score', () => {
  const r = validateAsterSignal({ ...valid, rrAtTp1: 1.99 });
  assert.equal(r.status, 'REJECTED');
  assert.equal(r.score, 100);
  assert.equal(r.publishable, false);
});

test('ASTER caps account risk at the lower of 1% and configured limit', () => {
  const r = validateAsterSignal({ ...valid, accountRiskPercent: 0.6, configuredRiskLimitPercent: 0.5 });
  assert.equal(r.status, 'REJECTED');
  assert.ok(r.rejectionReasons.includes('account_risk_percent: FAILED'));
});

test('ASTER waits for a completed confirmation candle', () => {
  const evidence = { ...allEvidence, candleCloseConfirmed: false };
  const r = validateAsterSignal({ ...valid, evidence });
  assert.equal(r.status, 'AWAITING CONFIRMATION');
  assert.equal(r.publishable, false);
});

test('ASTER never authorizes execution and rejects invalid direction', () => {
  const r = validateAsterSignal({ ...valid, direction: 'BUY' });
  assert.equal(r.status, 'NO TRADE');
  assert.equal(r.executionAuthorized, false);
});

test('ASTER exposes weighted confluence breakdown', () => {
  const r = validateAsterSignal({ ...valid, confluence: { ...allConfluence, newsConditions: 0 } });
  assert.equal(r.score, 90);
  assert.equal(r.scoreBreakdown.newsConditions, 0);
});

test('ASTER treats null RR and account risk as UNKNOWN, never as zero risk', () => {
  const r = validateAsterSignal({
    ...valid, rrAtTp1: null, accountRiskPercent: null,
    configuredRiskLimitPercent: 1
  });
  assert.equal(r.status, 'VALIDATING');
  assert.ok(r.rejectionReasons.includes('minimum_rr_at_tp1: UNKNOWN'));
  assert.ok(r.rejectionReasons.includes('account_risk_percent: UNKNOWN'));
  assert.equal(r.publishable, false);
});

test('ASTER exposes the specific reason a mandatory evidence item is UNKNOWN', () => {
  const evidence = { ...allEvidence, bidAskValid: null };
  const r = validateAsterSignal({
    ...valid, evidence,
    evidenceDetails: { bidAskValid: 'Feed does not expose independent bid and ask prices.' }
  });
  const check = r.checks.find((item) => item.name === 'bidAskValid');
  assert.equal(check.status, 'UNKNOWN');
  assert.equal(check.evidence, 'Feed does not expose independent bid and ask prices.');
  assert.equal(r.executionAuthorized, false);
});
