import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPatterns, studyPatterns, PATTERN_META, PATTERN_KEYS } from '../lib/patterns.js';

/* ================================================================
 * Chart-pattern engine tests. FIXTURES are parametric textbook
 * shapes (zigzag generator) — TEST-ONLY synthetic geometry to prove
 * the detectors; live runs always use real Deriv candles.
 * ================================================================ */

function zigzag(swings, { ripple = 0.0004, start = 1.000, vol = 0.0012 } = {}) {
  const bars = [];
  let prev = start, t = 1700000000;
  const push = (o, h, l, c) => { bars.push({ time: t++, open: +o.toFixed(6), high: +h.toFixed(6), low: +l.toFixed(6), close: +c.toFixed(6), volume: 0 }); };
  for (const sw of swings) {
    const n = Math.max(2, sw.bars || 5);
    for (let k = 1; k <= n; k++) {
      const f = k / (n + 1);
      const base = prev + (sw.p - prev) * f;
      const isEnd = k === n;
      const w = isEnd ? 0 : ((k % 2) ? ripple : -ripple);
      const c = base + w * 0.5;
      const h = base + Math.abs(w) + vol * 0.4;
      const l = base - Math.abs(w) - vol * 0.4;
      push(base, Math.max(h, c, base) + vol * 0.15, Math.min(l, c, base) - vol * 0.15, c);
    }
    const dir = sw.p > prev ? 1 : -1;
    push(sw.p - dir * vol * 0.2, dir > 0 ? sw.p : sw.p + vol * 0.3, dir > 0 ? sw.p - vol * 0.3 : sw.p, sw.p - dir * vol * 0.1);
    prev = sw.p;
  }
  const tail = swings.length ? swings[swings.length - 1].tail ?? 4 : 4;
  for (let k = 1; k <= tail; k++) {
    const drift = (swings.length ? (swings[swings.length - 1].after ?? 0) : 0) * (k / tail);
    const base = prev + drift;
    push(base, base + vol * 0.4, base - vol * 0.4, base + drift * 0.3);
  }
  return bars;
}
function FIX_INV(arr) {
  return arr.map((b) => ({ time: b.time, open: 2 - b.open, high: 2 - b.low, low: 2 - b.high, close: 2 - b.close, volume: 0 }));
}
const FIXTURES = {
  double_bot: () => zigzag([
    { p: 1.040, bars: 6, after: 0 }, { p: 1.000, bars: 6 }, { p: 1.016, bars: 5 },
    { p: 1.001, bars: 5 }, { p: 1.024, bars: 5, after: 0.004, tail: 3 }
  ], { start: 1.048 }),
  double_top: () => FIX_INV(FIXTURES.double_bot()),
  hs: () => zigzag([
    { p: 1.000, bars: 5 }, { p: 1.024, bars: 5 }, { p: 1.008, bars: 5 }, { p: 1.048, bars: 6 },
    { p: 1.010, bars: 5 }, { p: 1.025, bars: 5 }, { p: 1.004, bars: 5, after: -0.003, tail: 3 }
  ], { start: 0.994 }),
  inv_hs: () => FIX_INV(FIXTURES.hs()),
  bull_flag: () => zigzag([
    { p: 0.998, bars: 4 }, { p: 1.040, bars: 9, tail: 0 }, { p: 1.034, bars: 5 }, { p: 1.037, bars: 4 },
    { p: 1.032, bars: 4 }, { p: 1.036, bars: 3 }, { p: 1.048, bars: 5, after: 0.003, tail: 3 }
  ], { start: 0.990 }),
  bear_flag: () => FIX_INV(FIXTURES.bull_flag()),
  asc_tri: () => zigzag([
    { p: 1.000, bars: 5 }, { p: 1.041, bars: 7 }, { p: 1.027, bars: 5 }, { p: 1.042, bars: 6 },
    { p: 1.032, bars: 5 }, { p: 1.043, bars: 5 }, { p: 1.037, bars: 4 }, { p: 1.050, bars: 5, after: 0.003, tail: 3 }
  ], { start: 0.994 }),
  desc_tri: () => FIX_INV(FIXTURES.asc_tri()),
  fall_wedge: () => zigzag([
    { p: 1.052, bars: 5 }, { p: 1.040, bars: 5 }, { p: 1.048, bars: 5 }, { p: 1.036, bars: 5 },
    { p: 1.043, bars: 5 }, { p: 1.033, bars: 4 }, { p: 1.039, bars: 4 }, { p: 1.031, bars: 4 },
    { p: 1.047, bars: 5, after: 0.004, tail: 3 }
  ], { start: 1.054 }),
  rise_wedge: () => FIX_INV(FIXTURES.fall_wedge()),
  symm_up: () => zigzag([
    { p: 0.990, bars: 4 }, { p: 1.016, bars: 6 }, { p: 0.998, bars: 5 }, { p: 1.012, bars: 5 },
    { p: 1.002, bars: 4 }, { p: 1.009, bars: 4 }, { p: 1.005, bars: 3 }, { p: 1.020, bars: 5, after: 0.004, tail: 3 }
  ], { start: 0.986 }),
  symm_down: () => FIX_INV(FIXTURES.symm_up())
};

test('metadata: 12 patterns, complete education', () => {
  assert.equal(PATTERN_KEYS.length, 12);
  for (const k of PATTERN_KEYS) {
    const m = PATTERN_META[k];
    assert.ok(m && m.name && m.dir && m.action && m.how && m.why && m.trade, k);
    assert.ok(['BUY', 'SELL', 'HOLD'].includes(m.action), k);
  }
});

test('every textbook fixture is recognized (12/12)', () => {
  for (const k of PATTERN_KEYS) {
    const bars = FIXTURES[k]();
    const dets = detectPatterns(bars);
    const hit = dets.find((d) => d.key === k);
    assert.ok(hit, `${k} not detected — got [${dets.map((d) => d.key).join(',')}]`);
    assert.ok(hit.confidence >= 40 && hit.confidence <= 92, k + ' conf ' + hit.confidence);
    assert.ok(['BUY', 'SELL', 'HOLD'].includes(hit.action), k);
    assert.ok(['formed', 'forming'].includes(hit.status), k);
    assert.ok(Array.isArray(hit.lines) && hit.lines.length >= 1, k + ' lines');
    assert.ok(Number.isFinite(hit.entry), k + ' entry');
    assert.ok(Number.isFinite(hit.stop), k + ' stop');
    if (hit.status === 'formed') assert.ok(hit.target != null, k + ' target on formed');
  }
});

test('direction twins carry correct suggested actions', () => {
  /* bearish set: formed -> SELL / bearish */
  for (const k of ['double_top', 'hs', 'bear_flag', 'desc_tri', 'rise_wedge', 'symm_down']) {
    const hit = detectPatterns(FIXTURES[k]()).find((d) => d.key === k);
    assert.ok(hit, k);
    if (hit.status === 'formed') assert.equal(hit.action, 'SELL', k);
    assert.ok(hit.direction === 'bearish' || hit.direction === 'neutral', k);
  }
  /* bullish set (incl. falling wedge = upside break) */
  for (const k of ['double_bot', 'inv_hs', 'bull_flag', 'asc_tri', 'fall_wedge', 'symm_up']) {
    const hit = detectPatterns(FIXTURES[k]()).find((d) => d.key === k);
    assert.ok(hit, k);
    if (hit.status === 'formed') assert.equal(hit.action, 'BUY', k);
    assert.ok(hit.direction === 'bullish' || hit.direction === 'neutral', k);
  }
});

test('short input returns [] (input-length gate, not an error)', () => {
  assert.deepEqual(detectPatterns(FIXTURES.double_bot().slice(0, 20)), []);
  assert.deepEqual(detectPatterns([]), []);
});

test('non-pattern noise: no runaway detections', () => {
  const sine = [];
  let px = 1.1;
  for (let i = 0; i < 90; i++) {
    const c = px * (1 + Math.sin(i / 5) * 0.0011);
    sine.push({ time: 1700000000 + i, open: px, high: Math.max(px, c) * 1.0008, low: Math.min(px, c) * 0.9992, close: c, volume: 0 });
    px = c;
  }
  const r = detectPatterns(sine);
  assert.ok(r.length <= 3, 'noise produced ' + r.length + ' detections');
  for (const d of r) assert.ok(d.confidence <= 92);
});

test('studyPatterns: honest walk-forward structure', () => {
  const bars = [
    ...FIXTURES.double_bot(), ...FIXTURES.hs(), ...FIXTURES.bull_flag(),
    ...FIXTURES.asc_tri(), ...FIXTURES.fall_wedge(), ...FIXTURES.symm_up()
  ].map((b, i) => ({ ...b, time: 1700000000 + i * 300 }));
  const st = studyPatterns(bars, { holdBars: 24 });
  assert.ok(st.window >= 100, 'window ' + st.window);
  assert.equal(st.holdBars, 24);
  assert.ok(typeof st.signals === 'number' && st.signals >= 0);
  assert.ok(Array.isArray(st.patterns) && st.patterns.length <= 12);
  assert.ok(st.patterns.length > 0, 'expected some triggered patterns in battery window');
  assert.ok(/Walk-forward|Small sample/.test(st.note), st.note);
  let sum = 0;
  for (const p of st.patterns) {
    assert.ok(PATTERN_KEYS.includes(p.key));
    assert.equal(p.n, p.wins + p.losses, p.key);
    assert.ok(p.winRate >= 0 && p.winRate <= 100, p.key);
    sum += p.n;
  }
  assert.equal(sum, st.signals, 'signals = sum of per-pattern n');
  /* cooldown: no overlapping entries of the same pattern */
  const byKey = {};
  for (const t of st.trades) (byKey[t.key] = byKey[t.key] || []).push(t);
  for (const [k, list] of Object.entries(byKey)) {
    for (let i = 1; i < list.length; i++) assert.ok(list[i].i >= list[i - 1].exitI, k + ' overlap');
  }
});

test('study respects keys filter and empty windows', () => {
  const bars = FIXTURES.bull_flag().map((b, i) => ({ ...b, time: 1700000000 + i * 300 }));
  const st = studyPatterns(bars, { holdBars: 12, keys: ['bull_flag'] });
  assert.ok(st.patterns.every((p) => p.key === 'bull_flag'));
});
