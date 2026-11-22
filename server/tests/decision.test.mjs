import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDecision } from '../lib/decision.js';

function det(mtfSignal = 'BUY_CONFIRMED') {
  const frame = (timeframe, biasScore = 2) => ({
    timeframe, error: null, signal: 'BUY', biasScore, trend: 'UP', currentPrice: 100,
    indicators: { atr: 2, rsi: 60, macd: { histogram: 1 }, ema20: 101, ema50: 100 },
    levels: { support: [97], resistance: [105] }
  });
  return {
    symbol: 'BTC/USD', ok: true, mtfSignal,
    analyses: { m1: frame('1m'), m5: frame('5m'), h1: frame('1h') }
  };
}

test('AI directional decision cannot override a conflicting deterministic MTF signal', () => {
  const decision = sanitizeDecision({ signal: 'SELL', confidence: 99, entry: 100, stop_loss: 102, tp1: 96, tp2: 94 }, det());
  assert.equal(decision.signal, 'WAIT');
  assert.deepEqual(decision.decision_validation.rejected_reasons, ['ai_signal_disagrees_with_deterministic_mtf', 'ai_plan_rejected_or_not_applicable']);
  assert.match(decision.rationale, /directional call withheld/);
});

test('AI cannot promote a deterministic WAIT into a directional signal', () => {
  const decision = sanitizeDecision({ signal: 'BUY', confidence: 99 }, det('NO_CONFIRMATION'));
  assert.equal(decision.signal, 'WAIT');
});

test('AI levels violating direction or minimum 1.5 RR fall back to deterministic levels', () => {
  const baseline = sanitizeDecision(null, det());
  const decision = sanitizeDecision({
    signal: 'BUY', confidence: 80, entry: 100, stop_loss: 99, tp1: 100.5, tp2: 101
  }, det());
  assert.equal(decision.signal, 'BUY');
  for (const field of ['entry', 'stop_loss', 'tp1', 'tp2']) assert.equal(decision[field], baseline[field], field);
  assert.ok(decision.rrr >= 1.5);
});

test('AI levels with valid direction and RR are accepted and RR is recomputed', () => {
  const decision = sanitizeDecision({
    signal: 'BUY', confidence: 82, entry: 100, stop_loss: 98, tp1: 103, tp2: 106
  }, det());
  assert.equal(decision.signal, 'BUY');
  assert.equal(decision.rrr, 1.5);
});
