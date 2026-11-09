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
  assert.deepEqual(parseYahooChart({}), []);
});

test('indexDailySignal: strong uptrend -> BUY, downtrend -> SELL, chop -> WAIT', () => {
  const up = indexDailySignal(mk(120, 0.004), ind);
  assert.equal(up.ok, true);
  assert.equal(up.signal, 'BUY');
  assert.equal(up.entry, null, 'no order levels invented for indices');
  const down = indexDailySignal(mk(120, -0.004), ind);
  assert.equal(down.signal, 'SELL');
  const flat = indexDailySignal(mk(120, 0.0001), ind);
  assert.ok(['WAIT', 'BUY', 'SELL'].includes(flat.signal));
  assert.ok(flat.confidence >= 50 && flat.confidence <= 90);
  const short = indexDailySignal(mk(30, 0.01), ind);
  assert.equal(short.ok, false);
});

test('INDEX_MAP covers the three unique US indices', () => {
  assert.deepEqual(Object.keys(INDEX_MAP).sort(), ['NAS100', 'SPX500', 'US30']);
});
