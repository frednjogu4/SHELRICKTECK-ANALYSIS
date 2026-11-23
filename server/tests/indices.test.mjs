import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYahooChart, indexDailySignal, INDEX_MAP } from '../lib/indices.js';
import { sma, rsi } from '../lib/indicators.js';
const ind = { sma, rsi };

const mk = (n, drift) => Array.from({ length: n }, (_, i) => {
  const p = 100 * Math.pow(1 + drift, i);
  return { time: 1700000000 + i * 86400, open: p * 0.99, high: p * 1.01, low: p * 0.98, close: p, volume: 10 };
});

test('parseYahooChart drops null bars, normalizes numerics', () => {
  const j = { chart: { result: [{ timestamp: [1, 2, 3], indicators: { quote: [{ open: [1, null, 3], high: [2, 4, 5], low: [0.5, 2, 2.5], close: [1.5, 3, 4], volume: [7, null, 9] }] } }] } };
  const rows = parseYahooChart(j);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].close, 4);
  assert.equal(rows[1].volume, 9);
  assert.equal(rows[0].volume, 7);
  assert.deepEqual(parseYahooChart({}), []);
  const missingVolume = parseYahooChart({ chart: { result: [{ timestamp: [4], indicators: { quote: [{ open: [3], high: [4], low: [2], close: [3.5], volume: [null] }] } }] } });
  assert.equal(missingVolume[0].volume, null, 'unreported volume is not coerced to a real zero');
});

test('daily index direction is context only and never a BUY/SELL confidence without trade levels', () => {
  const up = indexDailySignal(mk(120, 0.004), ind);
  assert.equal(up.ok, true);
  assert.equal(up.context_signal, 'BUY');
  assert.equal(up.bias, 'bullish');
  assert.equal(up.signal, 'WAIT');
  assert.equal(up.analysis_status, 'CONTEXT_ONLY');
  assert.equal(up.tradeable, false);
  assert.equal(up.confidence, null);
  for (const level of ['entry', 'stop_loss', 'tp1', 'tp2']) assert.equal(up[level], null, `${level} unavailable`);
  const down = indexDailySignal(mk(120, -0.004), ind);
  assert.equal(down.context_signal, 'SELL');
  assert.equal(down.signal, 'WAIT');
  assert.equal(down.confidence, null);
  const flat = indexDailySignal(mk(120, 0.0001), ind);
  assert.equal(flat.signal, 'WAIT');
  assert.equal(flat.confidence, null);
  const short = indexDailySignal(mk(30, 0.01), ind);
  assert.equal(short.ok, false);
});

test('daily index history and indicator integrity fail closed', () => {
  const valid = mk(120, 0.001);
  const corrupt = valid.map(c => ({ ...c }));
  corrupt[20].high = corrupt[20].close - 1;
  assert.deepEqual(indexDailySignal(corrupt, ind), { ok: false, reason: 'invalid_daily_history' });
  const outOfOrder = valid.map(c => ({ ...c }));
  [outOfOrder[20].time, outOfOrder[21].time] = [outOfOrder[21].time, outOfOrder[20].time];
  assert.deepEqual(indexDailySignal(outOfOrder, ind), { ok: false, reason: 'invalid_daily_history' });
  assert.deepEqual(indexDailySignal(valid, { sma: () => null, rsi: () => null }), { ok: false, reason: 'invalid_indicator_output' });
});

test('INDEX_MAP covers the three unique US indices', () => {
  assert.deepEqual(Object.keys(INDEX_MAP).sort(), ['NAS100', 'SPX500', 'US30']);
});
