import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTimeframe, confirmMultiTimeframe, waitReason, votesSummary } from '../lib/analyzer.js';

/* ================================================================
 * FIXED candle fixtures (audit Task 4.4): every WAIT reason code,
 * plus at least one BUY and one SELL. No random data — deterministic.
 * ================================================================ */

const MIN = 50;

/* Tuned deterministic fixtures (empirically scored against detectSignalBias):
   upCandles → biasScore +3 (BUY), downCandles → −3 (SELL). RSI stays in the
   55–70 band via a −0.25% dip every 5th bar. 5m granularity for all. */
function upCandles(n, start = 1.10) {
  const out = []; let p = start; let t = Math.floor(Date.now() / 1000) - n * 300;
  for (let i = 0; i < n; i++) {
    p = p * (1 + (i % 5 === 4 ? -0.0025 : 0.0011));
    out.push({ time: t + i * 300, open: p * 0.9995, high: p * 1.001, low: p * 0.9985, close: p, volume: 10 });
  }
  return out;
}
function downCandles(n, start = 1.30) {
  const out = []; let p = start; let t = Math.floor(Date.now() / 1000) - n * 300;
  for (let i = 0; i < n; i++) {
    p = p * (1 - (i % 5 === 4 ? -0.0025 : 0.0011));
    out.push({ time: t + i * 300, open: p * 1.0005, high: p * 1.0015, low: p * 0.999, close: p, volume: 10 });
  }
  return out;
}
function flatCandles(n, px = 1.10) {
  const out = []; let t = Math.floor(Date.now() / 1000) - n * 3600;
  for (let i = 0; i < n; i++) out.push({ time: t + i * 3600, open: px, high: px * 1.0002, low: px * 0.9998, close: px, volume: 10 });
  return out;
}
const det = (m1, m5, h1) => ({ analyses: { m1, m5, h1 }, mtfSignal: confirmMultiTimeframe({ m1, m5, h1 }) });

test('FIXTURE BUY: steady uptrend across all timeframes → BUY_CONFIRMED + signal BUY', () => {
  const d = det(analyzeTimeframe('T', upCandles(120), '1m'), analyzeTimeframe('T', upCandles(120), '5m'), analyzeTimeframe('T', upCandles(120), '1h'));
  assert.equal(d.mtfSignal, 'BUY_CONFIRMED', 'mtf=' + d.mtfSignal + ' votes=' + votesSummary(d.analyses));
  assert.equal(d.analyses.m5.signal, 'BUY', '5m score ' + d.analyses.m5.biasScore);
});

test('FIXTURE SELL: steady downtrend → SELL_CONFIRMED + signal SELL', () => {
  const d = det(analyzeTimeframe('T', downCandles(120), '1m'), analyzeTimeframe('T', downCandles(120), '5m'), analyzeTimeframe('T', downCandles(120), '1h'));
  assert.equal(d.mtfSignal, 'SELL_CONFIRMED', 'mtf=' + d.mtfSignal + ' votes=' + votesSummary(d.analyses));
  assert.equal(d.analyses.m5.signal, 'SELL', '5m score ' + d.analyses.m5.biasScore);
});

test('WAIT reason INSUFFICIENT_CANDLES: two short series report have/need', () => {
  const shortA = analyzeTimeframe('T', upCandles(30), '1m');
  const shortB = analyzeTimeframe('T', upCandles(42), '5m');
  assert.equal(shortA.error, 'Insufficient data');
  assert.equal(shortB.error, 'Insufficient data');
  const d = det(shortA, shortB, analyzeTimeframe('T', upCandles(120), '1h'));
  const wr = waitReason(d);
  assert.ok(wr, 'only one valid vote → WAIT expected');
  assert.equal(wr.code, 'INSUFFICIENT_CANDLES');
  assert.match(wr.detail, /have 30, need 50/);
});

test('WAIT reason MTF_CONFLICT: 1m up vs 1h down with no majority', () => {
  const d = det(analyzeTimeframe('T', upCandles(120), '1m'), analyzeTimeframe('T', flatCandles(120), '5m'), analyzeTimeframe('T', downCandles(120), '1h'));
  const wr = waitReason(d);
  assert.ok(wr, 'up vs down with a neutral middle → WAIT expected');
  assert.equal(wr.code, 'MTF_CONFLICT');
  assert.match(wr.detail, /disagree/);
  assert.match(votesSummary(d.analyses), /1m/);
});

test('WAIT reason STALE_DATA: old timestamps flagged', () => {
  const d = det(analyzeTimeframe('T', flatCandles(60), '1m'), analyzeTimeframe('T', flatCandles(60), '5m'), analyzeTimeframe('T', flatCandles(60), '1h'));
  // age the candles artificially by 4 hours
  for (const a of [d.analyses.m1, d.analyses.m5, d.analyses.h1]) {
    for (const c of a.candles) c.time -= 4 * 3600;
  }
  const wr = waitReason(d, { maxAgeSec: 3 * 3600 + 300 });
  assert.equal(wr.code, 'STALE_DATA');
  assert.match(wr.detail, /min old/);
});

test('WAIT reason MTF_LEAN_NOT_CONFIRMED or NO_ALIGNMENT: flat market never fabricates a signal', () => {
  const d = det(analyzeTimeframe('T', flatCandles(120), '1m'), analyzeTimeframe('T', flatCandles(120), '5m'), analyzeTimeframe('T', flatCandles(120), '1h'));
  assert.equal(d.mtfSignal === 'BUY_CONFIRMED' || d.mtfSignal === 'SELL_CONFIRMED', false);
  const wr = waitReason(d);
  assert.ok(['MTF_LEAN_NOT_CONFIRMED', 'MTF_NO_ALIGNMENT'].includes(wr.code));
});

test('BUY/SELL produce NO wait reason; votes line always renders', () => {
  const up = det(analyzeTimeframe('T', upCandles(120), '1m'), analyzeTimeframe('T', upCandles(120), '5m'), analyzeTimeframe('T', upCandles(120), '1h'));
  const dn = det(analyzeTimeframe('T', downCandles(120), '1m'), analyzeTimeframe('T', downCandles(120), '5m'), analyzeTimeframe('T', downCandles(120), '1h'));
  assert.equal(waitReason(up, { maxAgeSec: 10800 }), null);
  assert.equal(waitReason(dn, { maxAgeSec: 10800 }), null);
  assert.match(votesSummary(up.analyses), /1m \+\d/);
});
