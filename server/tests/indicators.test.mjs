import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, ema, emaSeries, rsi, macd, bollingerBands, atr, findLevels
} from '../lib/indicators.js';

/* ---------- helpers ---------- */
const rising = (n, start = 100, step = 1) =>
  Array.from({ length: n }, (_, i) => start + i * step);
const falling = (n, start = 200, step = 1) =>
  Array.from({ length: n }, (_, i) => start - i * step);
const alternating = (n, base = 100) =>
  Array.from({ length: n }, (_, i) => (i % 2 ? base + 1 : base));
const candlesFrom = (closes) =>
  closes.map((c, i) => ({
    open: c, close: c, high: c + 0.5, low: c - 0.5, volume: 1000, time: i
  }));

/* ---------- SMA / EMA ---------- */
test('sma returns the mean of the last N values', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4);
  assert.equal(sma([1, 2], 3), null); // insufficient
  assert.equal(sma([], 3), null);
});

test('ema matches the hand-computed textbook example', () => {
  // seed=(1+2+3)/3=2, k=0.5 -> 4*0.5+2*0.5=3 -> 5*0.5+3*0.5=4
  assert.equal(ema([1, 2, 3, 4, 5], 3), 4);
  assert.equal(ema([1, 2], 3), null);
});

test('emaSeries length = n - period + 1 and last value equals ema()', () => {
  const closes = rising(60, 100, 0.5);
  const series = emaSeries(closes, 20);
  assert.equal(series.length, closes.length - 20 + 1);
  assert.equal(series[series.length - 1], ema(closes, 20));
});

/* ---------- RSI ---------- */
test('RSI on a strictly rising series is 100 (no losses)', () => {
  const val = rsi(rising(30), 14);
  assert.equal(val, 100);
});

test('RSI on a strictly falling series is 0 (no gains)', () => {
  const val = rsi(falling(30), 14);
  assert.equal(val, 0);
});

test('Wilder RSI on alternating gains and losses matches its recursive average', () => {
  assert.ok(Math.abs(rsi(alternating(30), 14) - 52.461158602229915) < 1e-10);
});

test('RSI on a flat market (zero variance) is 50, not the 0/0 NaN trap', () => {
  assert.equal(rsi(new Array(30).fill(100), 14), 50);
});

test('RSI returns null when data is shorter than period+1', () => {
  assert.equal(rsi(rising(10), 14), null); // the draft's own test data!
  assert.equal(rsi(null, 14), null);
});

/* ---------- MACD ---------- */
test('MACD is null on insufficient data (needs 34 closes)', () => {
  assert.equal(macd(rising(20), 12, 26, 9), null);
  assert.equal(macd([], 12, 26, 9), null);
});

test('MACD on a rising market has positive line and defined signal', () => {
  const m = macd(rising(60), 12, 26, 9);
  assert.ok(m && typeof m.line === 'number');
  assert.ok(m.line > 0, 'fast EMA above slow EMA in an uptrend');
  assert.ok(Number.isFinite(m.signal));
  assert.ok(Number.isFinite(m.histogram));
  assert.equal(m.histogram, m.line - m.signal);
});

test('MACD signal line is an EMA of the MACD series, not of prices', () => {
  // If the draft formula were used, signal would be price-magnitude (~100+)
  // while MACD line is a small difference — a tell-tale mismatch.
  const m = macd(rising(60, 100, 1), 12, 26, 9);
  assert.ok(Math.abs(m.signal) < 20, `signal=${m.signal} must be MACD-scale, not price-scale`);
});

/* ---------- Bollinger ---------- */
test('Bollinger bands bracket price and stay ordered', () => {
  const closes = rising(30, 100, 1);
  const bb = bollingerBands(closes, 20, 2);
  assert.ok(bb.upper > bb.mid && bb.mid > bb.lower);
  assert.ok(bb.bandwidth > 0);
  assert.equal(bollingerBands([1, 2], 20), null);
});

/* ---------- ATR ---------- */
test('ATR is positive on real candles and null on short input', () => {
  const candles = candlesFrom(rising(30));
  const a = atr(candles, 14);
  assert.ok(a !== null && a > 0);
  assert.equal(atr(candles.slice(0, 5), 14), null);
});

/* ---------- Support / Resistance ---------- */
test('findLevels finds the obvious swing high and swing low', () => {
  // Zero-wick candles so level values equal the closes exactly.
  const flatWick = (closes) => closes.map((c, i) => ({ open: c, close: c, high: c, low: c, volume: 1, time: i }));
  // Shape: flat -> deep dip (support 90) -> rally to peak (resistance 110) -> mild pullback
  const closes = [
    ...rising(10, 100, 0),      // flat around 100
    95, 90, 92,                 // swing low at 90
    96, 101, 106, 110, 106,     // swing high at 110
    105, 104, 103               // ends below the peak, above the trough
  ];
  const { support, resistance } = findLevels(flatWick(closes), 50);
  assert.ok(support.length > 0, 'support found');
  assert.ok(resistance.length > 0, 'resistance found');
  assert.ok(support.includes(90), `support=${JSON.stringify(support)}`);
  assert.ok(resistance.includes(110), `resistance=${JSON.stringify(resistance)}`);
});

test('findLevels falls back to lookback min/max with no interior swings', () => {
  const candles = candlesFrom(rising(20, 100, 1)); // monotonic: no interior swings
  const { support, resistance } = findLevels(candles, 20);
  assert.ok(support.length > 0);
  assert.ok(resistance.length > 0);
  assert.ok(resistance[0] > support[0]);
});

test('findLevels handles degenerate input', () => {
  assert.deepEqual(findLevels([]), { support: [], resistance: [] });
  assert.deepEqual(findLevels(null), { support: [], resistance: [] });
});


test('RSI uses Wilder smoothing across changes, not a last-N simple average', () => {
  const value = rsi([100, 102, 101, 103, 102, 104], 3);
  assert.ok(Math.abs(value - 77.2727272727) < 1e-8, String(value));
});

test('ATR uses Wilder smoothing across true ranges', () => {
  const ranges = [2, 4, 6, 8, 10];
  const candles = [{ close: 100, high: 101, low: 99 }].concat(ranges.map((range) => ({
    open: 100, close: 100, high: 100 + range / 2, low: 100 - range / 2
  })));
  assert.ok(Math.abs(atr(candles, 3) - (62 / 9)) < 1e-8);
});
