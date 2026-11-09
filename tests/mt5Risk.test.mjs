import test from 'node:test';
import assert from 'node:assert/strict';
import { isOnlyOpenTradesGateFailure, openTradesLimitFromGate, verifyBrokerOpenTradeCount } from '../src/mt5Risk.js';

const gate = (checks) => ({ error: 'risk_blocked', checks });
const onlyOpenFailed = gate([
  { name: 'stake_limit', status: 'PASSED' },
  { name: 'open_trades', status: 'FAILED', evidence: 'opens=10 max=10' },
  { name: 'daily_loss', status: 'PASSED' },
]);

test('Exness stale-counter fallback is allowed only when open_trades is the sole mandatory failure', () => {
  assert.equal(isOnlyOpenTradesGateFailure(onlyOpenFailed), true);
  assert.equal(isOnlyOpenTradesGateFailure(gate([
    { name: 'open_trades', status: 'FAILED', evidence: 'opens=10 max=10' },
    { name: 'daily_loss', status: 'UNKNOWN' },
  ])), false);
  assert.equal(isOnlyOpenTradesGateFailure(gate([
    { name: 'open_trades', status: 'FAILED', evidence: 'opens=10 max=10' },
    { name: 'stake_limit', status: 'FAILED' },
  ])), false);
  assert.equal(isOnlyOpenTradesGateFailure({ error: 'risk_blocked' }), false);
});

test('Exness stale-counter fallback parses the server limit from evidence and fails closed if missing', () => {
  assert.equal(openTradesLimitFromGate(onlyOpenFailed), 10);
  assert.equal(openTradesLimitFromGate(gate([{ name: 'open_trades', status: 'FAILED', evidence: 'opens=4' }])), null);
});

test('fresh MT5 positions replace only stale open count; equality with cap still blocks', () => {
  assert.deepEqual(verifyBrokerOpenTradeCount(onlyOpenFailed, [{}]), { ok: true, count: 1, limit: 10 });
  const full = verifyBrokerOpenTradeCount(onlyOpenFailed, Array(10).fill({}));
  assert.equal(full.ok, false);
  assert.equal(full.count, 10);
  assert.equal(full.limit, 10);
  assert.match(full.reason, /10\/10/);
  assert.equal(verifyBrokerOpenTradeCount(onlyOpenFailed, null).ok, false);
  assert.equal(verifyBrokerOpenTradeCount(gate([{ name: 'open_trades', status: 'FAILED', evidence: 'opens=10 max=10' }, { name: 'news_event', status: 'UNKNOWN' }]), [{}]).ok, false);
});
