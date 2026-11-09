import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adx, sessionVwap, swingLevels, pivotLevels, wilder } from '../lib/indicators.ext.js';

/* Unit tests for the NEW indicator extensions (indicators.ext.js).
 * indicators.js itself stays byte-identical and keeps its own tests. */

const c = (t, o, h, l, cl, v = 10) => ({ time: t, open: o, high: h, low: l, close: cl, volume: v });
const T0 = 1700000000000;

test('wilder: compact output seeded with SMA, then Wilder smoothing (matches atr convention)', () => {
  const v = [2, 4, 6, 8];
  const out = wilder(v, 3);
  assert.equal(out.length, 2); // [SMA seed, ...smoothed values]
  assert.equal(out[0], 4); // SMA seed of first 3
  assert.ok(Math.abs(out[1] - (4 + (8 - 4) / 3)) < 1e-9);
  assert.equal(wilder([1, 2], 3), null); // too short
});

test('adx: trending series yields high ADX and coherent DI; choppy yields low ADX', () => {
  const trend = []; let px = 100, t = T0;
  for (let i = 0; i < 60; i++) { const cl = px + 0.5; trend.push(c(t, px, cl, px - 0.1, cl)); px = cl; t += 300000; }
  const a1 = adx(trend, 14);
  assert.ok(a1.adx > 25, 'trend adx=' + a1.adx);
  assert.ok(a1.plusDI > a1.minusDI, 'uptrend +DI > -DI');

  const chop = []; px = 100; t = T0;
  for (let i = 0; i < 60; i++) { const cl = px + (i % 2 ? 0.05 : -0.05); chop.push(c(t, px, px + 0.08, px - 0.08, cl)); px = cl; t += 300000; }
  const a2 = adx(chop, 14);
  assert.ok(a2.adx < a1.adx, 'chop adx lower than trend adx');
  assert.ok(a2.adx < 25, 'chop adx=' + a2.adx);
  assert.ok(Number.isFinite(a1.plusDI) && Number.isFinite(a1.minusDI));
});

test('adx needs 2*period+1 candles; returns NaN values below warmup', () => {
  const few = []; let px = 100;
  for (let i = 0; i < 20; i++) { few.push(c(i * 300000, px, px + 0.2, px - 0.2, px + 0.1)); px += 0.1; }
  assert.equal(adx(few, 14), null); // 20 < 2*14+1 -> honest null, no numbers invented
});

test('sessionVwap: resets at resetHourUTC, exact math, zero-volume flagged not fabricated', () => {
  // day 1: two bars after 10:00 UTC, day 2: one bar after 10:00 UTC
  const d1 = Date.UTC(2026, 9, 13, 10, 0, 0) / 1000;
  const d2 = Date.UTC(2026, 9, 14, 10, 0, 0) / 1000;
  const candles = [c(d1, 10, 11, 9, 10, 100), c(d1 + 300, 10, 12, 8, 11, 300), c(d2, 20, 21, 19, 20, 50)];
  const r = sessionVwap(candles, 10);
  assert.equal(r.bars, 1); // only the day-2 bar counts (session reset)
  // day2: typical = (21+19+20)/3 = 20; vwap = 20*50/50
  assert.ok(Math.abs(r.vwap - 20) < 1e-9);
  assert.equal(r.zeroVolume, false);

  const z = sessionVwap([c(d1, 10, 11, 9, 10, 0), c(d2, 20, 21, 19, 20, 0)], 10);
  assert.equal(z.zeroVolume, true);
  assert.equal(z.vwap, null);
});

test('swingLevels: fractal detection wins; extremes fallback when no fractal', () => {
  // fractal: clear swing high/low inside the window
  const fx = []; let t = T0;
  for (let i = 0; i < 30; i++) fx.push(c(t, 100, 100.2, 99.8, 100)); t += 300000;
  fx.push(c(t, 100, 102, 99.9, 101)); t += 300000;            // swing high (fractal)
  for (const h of [101.8, 101.4, 101, 100.6, 100.2]) { fx.push(c(t, 100.8, h, 100.1, 100.4)); t += 300000; }
  fx.push(c(t, 101, 100.4, 99, 99.5)); t += 300000;           // swing low (fractal)
  for (let i = 0; i < 4; i++) { fx.push(c(t, 99.5, 99.9, 99.3, 99.8)); t += 300000; }
  const s = swingLevels(fx, 20);
  assert.equal(s.swingHigh, 102); // most recent qualifying fractal high
  assert.equal(s.swingLow, 99);

  // monotonic decline: no fractal lows at all -> extremes fallback
  const mono = []; t = T0;
  for (let i = 0; i < 25; i++) { mono.push(c(t, 100 - i, 100.2 - i, 99.7 - i, 100 - i)); t += 300000; }
  const s2 = swingLevels(mono, 20);
  assert.equal(s2.swingLow, Math.min(...mono.slice(-20).map((x) => x.low)));
});

test('pivotLevels: classic floor-trader pivots from the previous UTC day', () => {
  const d1 = Date.UTC(2026, 9, 13, 2, 0, 0) / 1000; // prev day (resets at hour 0)
  const d2 = Date.UTC(2026, 9, 14, 2, 0, 0) / 1000;
  // prev day: H 110, L 100, C 105 -> P=105, R1=110, S1=100, R2=115, S2=95
  const candles = [
    c(Date.UTC(2026, 9, 12, 2, 0, 0) / 1000, 101, 104, 101, 103),
    c(Date.UTC(2026, 9, 12, 2, 5, 0) / 1000, 103, 105, 102, 104),
    c(Date.UTC(2026, 9, 12, 2, 10, 0) / 1000, 104, 106, 103, 105),
    c(Date.UTC(2026, 9, 12, 2, 15, 0) / 1000, 105, 105, 103, 104),
    c(Date.UTC(2026, 9, 12, 2, 20, 0) / 1000, 104, 105, 102, 103),
    c(d1, 102, 110, 100, 105), c(d1 + 300, 104, 106, 103, 105),
    c(d1 + 600, 105, 107, 104, 106), c(d1 + 900, 106, 108, 105, 105.5),
    c(d1 + 1200, 105, 106, 104, 105), c(d2, 105, 106, 104, 105.5)
  ];
  const p = pivotLevels(candles, 0);
  assert.equal(p.P, 105);
  assert.equal(p.R1, 110);
  assert.equal(p.S1, 100);
  assert.equal(p.R2, 115);
  assert.equal(p.S2, 95);
});
