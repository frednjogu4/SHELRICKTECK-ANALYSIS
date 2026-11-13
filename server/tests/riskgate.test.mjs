import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRisk, bossVerdict, CHECK } from '../lib/riskgate.js';

const L = { maxStakeUsd: 5, maxOpenTrades: 10, dailyLossLimitUsd: 20 };
const base = { limits: L, stake: 2, opens: 0, dayPnl: 0, killSwitch: false, venue: 'mt5', entry: 100, sl: 99, tp: 102, marketHours: true, newsBlocked: false };

test('evaluateRisk: full plan passes -> APPROVED, every check PASSED', () => {
  const r = evaluateRisk(base);
  assert.equal(r.verdict, 'APPROVED');
  assert.equal(r.approved, true);
  assert.ok(r.checks.every(c => c.status === CHECK.PASSED));
  const rr = r.checks.find(c => c.name === 'reward_to_risk');
  assert.match(rr.evidence, /rr=2\.00/); // |102-100|/|100-99| = 2
});

test('evaluateRisk: MISSING DATA is UNKNOWN and BLOCKS (never counts as passed)', () => {
  const r = evaluateRisk({ ...base, rr: undefined, entry: undefined, sl: undefined, tp: undefined, marketHours: undefined, newsBlocked: undefined });
  assert.equal(r.verdict, 'BLOCKED');
  const names = r.checks.filter(c => c.status === CHECK.UNKNOWN).map(c => c.name).sort();
  assert.deepEqual(names, ['market_hours', 'news_event', 'reward_to_risk']);
  assert.match(r.reason, /UNKNOWN/);
});

test('evaluateRisk: kill switch alone blocks; stake/open/daily failures block', () => {
  assert.equal(evaluateRisk({ ...base, killSwitch: true }).verdict, 'BLOCKED');
  assert.equal(evaluateRisk({ ...base, stake: 6 }).verdict, 'BLOCKED');
  assert.equal(evaluateRisk({ ...base, opens: 10 }).verdict, 'BLOCKED');
  assert.equal(evaluateRisk({ ...base, dayPnl: -25 }).verdict, 'BLOCKED');
});

test('evaluateRisk: open-trade block identifies app counter, not a live MT5 position scan', () => {
  const r = evaluateRisk({ ...base, opens: 10 });
  const gate = r.checks.find(c => c.name === 'open_trades');
  assert.equal(gate.status, CHECK.FAILED);
  assert.match(gate.reason, /App-side open-trades counter reached \(10\/10\)/);
  assert.match(gate.reason, /not a live MT5 position scan/);
  assert.match(gate.reason, /no order was authorized/);
});

test('evaluateRisk: rr below 1 blocks; market closed blocks; news restriction blocks', () => {
  assert.equal(evaluateRisk({ ...base, entry: 100, sl: 99, tp: 100.5 }).verdict, 'BLOCKED'); // rr 0.5
  assert.equal(evaluateRisk({ ...base, marketHours: false }).verdict, 'BLOCKED');
  assert.equal(evaluateRisk({ ...base, newsBlocked: true }).verdict, 'BLOCKED');
});

test('evaluateRisk: fixed-risk venue deriv passes without an SL/TP plan (max loss = stake)', () => {
  const r = evaluateRisk({ ...base, venue: 'deriv', entry: undefined, sl: undefined, tp: undefined, rr: undefined });
  assert.equal(r.verdict, 'APPROVED');
  const rr = r.checks.find(c => c.name === 'reward_to_risk');
  assert.equal(rr.status, CHECK.PASSED);
  assert.match(rr.evidence, /max loss = stake/);
});

test('bossVerdict: NEVER overrides Risk — blocked risk forces REJECTED even with a perfect setup', () => {
  const risk = evaluateRisk({ ...base, killSwitch: true });
  const b = bossVerdict({ risk, setup: { present: true, complete: true, rr: 3 } });
  assert.equal(b.verdict, 'REJECTED');
  assert.match(b.reason, /never overrides Risk/);
});

test('bossVerdict: default WAIT when setup absent, stale, contradictory, or incomplete', () => {
  const risk = evaluateRisk(base);
  assert.equal(bossVerdict({ risk, setup: { present: false } }).verdict, 'WAIT');
  assert.equal(bossVerdict({ risk, setup: { present: true, stale: true } }).verdict, 'WAIT');
  assert.equal(bossVerdict({ risk, setup: { present: true, contradictory: true } }).verdict, 'WAIT');
  assert.equal(bossVerdict({ risk, setup: { present: true, complete: false } }).verdict, 'WAIT');
});

test('bossVerdict: approved risk + complete setup -> READY FOR MANUAL REVIEW (never auto-executes)', () => {
  const b = bossVerdict({ risk: evaluateRisk(base), setup: { present: true, complete: true } });
  assert.equal(b.verdict, 'READY FOR MANUAL REVIEW');
  assert.match(b.reason, /human decides/);
});


test('evaluateRisk: client-style newsBlocked=false without server trust remains UNKNOWN and blocks', () => {
  const r = evaluateRisk({ ...base, newsEvidenceTrusted: false });
  const news = r.checks.find(c => c.name === 'news_event');
  assert.equal(news.status, CHECK.UNKNOWN);
  assert.equal(r.verdict, 'BLOCKED');
});
