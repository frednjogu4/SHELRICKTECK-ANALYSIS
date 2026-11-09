import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_CANDLES, identifyTrend, detectSignalBias,
  analyzeTimeframe, confirmMultiTimeframe, formatAnalysis, runDeterministicAnalysis
} from '../lib/analyzer.js';

/* ---------- candle builders ---------- */
const mk = (closes) => closes.map((c, i) => ({ open: c, close: c, high: c + 0.4, low: c - 0.4, volume: 500, time: i }));

// accelerating up: convex curve keeps MACD histogram positive
const accelUp = (n) => Array.from({ length: n }, (_, i) => 100 + 0.05 * i * i);
// accelerating down
const accelDown = (n) => Array.from({ length: n }, (_, i) => 300 - 0.05 * i * i);
const flat = (n) => new Array(n).fill(100);

/* ---------- trend ---------- */
test('identifyTrend classifies up / down / flat', () => {
  assert.equal(identifyTrend(accelUp(30)), 'UPTREND');
  assert.equal(identifyTrend(accelDown(30)), 'DOWNTREND');
  assert.equal(identifyTrend(flat(30)), 'CONSOLIDATION');
  assert.equal(identifyTrend([1, 2]), 'CONSOLIDATION'); // guard
});

/* ---------- bias ---------- */
test('strong uptrend yields BUY, strong downtrend yields SELL', () => {
  const up = analyzeTimeframe('TEST', mk(accelUp(60)), '5m');
  const down = analyzeTimeframe('TEST', mk(accelDown(60)), '5m');
  assert.ok(!up.error, JSON.stringify(up));
  assert.ok(!down.error, JSON.stringify(down));
  assert.equal(up.signal, 'BUY', `up biasScore=${up.biasScore}`);
  assert.equal(down.signal, 'SELL', `down biasScore=${down.biasScore}`);
});

test('flat market yields WAIT', () => {
  const r = analyzeTimeframe('TEST', mk(flat(60)), '5m');
  assert.ok(!r.error);
  assert.equal(r.signal, 'WAIT', `flat biasScore=${r.biasScore}`);
});

/* ---------- analyzeTimeframe contract ---------- */
test('returns an explicit error object below MIN_CANDLES (signal null)', () => {
  const r = analyzeTimeframe('TEST', mk(flat(20)), '5m');
  assert.equal(r.error, 'Insufficient data');
  assert.equal(r.signal, null);
  assert.equal(r.required, MIN_CANDLES);
  assert.equal(r.have, 20);
  assert.equal(analyzeTimeframe('TEST', null, '5m').error, 'Insufficient data');
});

test('full analysis carries indicators, levels, trend and 20 context candles', () => {
  const r = analyzeTimeframe('TEST', mk(accelUp(120)), '1h');
  assert.equal(r.error, undefined);
  assert.ok(r.indicators.rsi !== null);
  assert.ok(r.indicators.macd !== null);
  assert.ok(r.indicators.bb !== null);
  assert.ok(r.indicators.ema20 !== null);
  assert.equal(r.indicators.ema200, null, 'EMA200 documented as null below 200 candles');
  assert.ok(r.levels.support.length > 0 && r.levels.resistance.length > 0);
  assert.equal(r.candles.length, 20);
  assert.ok(['BUY', 'SELL', 'WAIT'].includes(r.signal));
});

/* ---------- MTF confirmation (the draft's core bug) ---------- */
const tf = (signal, extra = {}) => ({ signal, error: undefined, ...extra });

test('2-of-3 majority confirms BUY / SELL', () => {
  assert.equal(confirmMultiTimeframe({ m1: tf('BUY'), m5: tf('BUY'), h1: tf('SELL') }), 'BUY_CONFIRMED');
  assert.equal(confirmMultiTimeframe({ m1: tf('SELL'), m5: tf('SELL'), h1: tf('BUY') }), 'SELL_CONFIRMED');
});

test('mixed votes with no majority => NO_CONFIRMATION', () => {
  assert.equal(confirmMultiTimeframe({ m1: tf('BUY'), m5: tf('SELL'), h1: tf('WAIT') }), 'NO_CONFIRMATION');
});

test('error / missing timeframes abstain; fewer than 2 valid => NO_CONFIRMATION', () => {
  // the draft's failure mode: signal was undefined everywhere
  assert.equal(confirmMultiTimeframe({
    m1: { error: 'Insufficient data', signal: null },
    m5: { error: 'Insufficient data', signal: null },
    h1: { error: 'Insufficient data', signal: null }
  }), 'NO_CONFIRMATION');
  assert.equal(confirmMultiTimeframe({
    m1: tf('BUY'), m5: { error: 'Insufficient data', signal: null }, h1: undefined
  }), 'NO_CONFIRMATION');
});

/* ---------- prompt formatting ---------- */
test('formatAnalysis renders indicator lines for the Claude prompt', () => {
  const r = analyzeTimeframe('TEST', mk(accelUp(80)), '5m');
  const text = formatAnalysis(r);
  assert.match(text, /RSI/);
  assert.match(text, /MACD/);
  assert.match(text, /Support/);
  assert.match(text, /Signal vote: (BUY|SELL|WAIT)/);
  assert.match(formatAnalysis({ error: 'Insufficient data', have: 10, required: 50 }), /Insufficient data/);
});

/* ---------- end-to-end deterministic pipeline ---------- */
test('runDeterministicAnalysis: aligned uptrend confirms, garbage data refuses', () => {
  const good = runDeterministicAnalysis('TEST', {
    m1: mk(accelUp(60)), m5: mk(accelUp(60)), h1: mk(accelUp(60))
  });
  assert.equal(good.mtfSignal, 'BUY_CONFIRMED');
  assert.equal(good.ok, true);

  const starved = runDeterministicAnalysis('TEST', { m1: mk(flat(10)), m5: null, h1: undefined });
  assert.equal(starved.mtfSignal, 'NO_CONFIRMATION');
  assert.equal(starved.ok, false);
});
