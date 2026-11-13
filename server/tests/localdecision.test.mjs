import test from 'node:test';
import assert from 'node:assert/strict';
import { localDecision } from '../lib/localdecision.js';

const analysis = {
  trend: 'UP', signal: 'BUY', biasScore: 2,
  currentPrice: 100,
  indicators: { atr: null, rsi: 55, macd: { histogram: 0.2 } },
  levels: { support: [98], resistance: [102] }
};

test('localDecision fails closed when ATR is missing and does not fabricate levels', () => {
  const result = localDecision({
    symbol: 'EURUSD', mtfSignal: 'BUY_CONFIRMED',
    analyses: { m1: analysis, m5: analysis, h1: analysis }
  });
  assert.equal(result.signal, 'WAIT');
  assert.equal(result.entry, null);
  assert.equal(result.stop_loss, null);
  assert.equal(result.tp1, null);
  assert.equal(result.tp2, null);
  assert.equal(result.rrr, null);
  assert.match(result.rationale, /ATR or current price is unavailable/);
});
