/* GOLD MARKET STRENGTH engine — node:test coverage for the brief's
 * required conditions: bullish, bearish, neutral, mixed, unavailable,
 * plus stale/invalid/rounding/incomplete-candle handling. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { marketStrength } from '../server/lib/strength.js';

const NOW = 1764000000; /* fixed epoch (s) for deterministic staleness */

function series(n, dir, gran, seed) {
  const out = [];
  let price = seed;
  for (let i = 0; i < n; i++) {
    const step = dir === 'up' ? 0.8 : dir === 'down' ? -0.8 : dir === 'chop' ? (i % 2 ? 0.7 : -0.7) : 0;
    const open = price;
    const close = Math.max(0.5, price + step);
    out.push({ time: NOW - (n - 1 - i) * gran, open, high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3, close });
    price = close;
  }
  return out;
}
function setsFor(dirs, n = 120) {
  return { m1: series(n, dirs[0], 60, 4000), m5: series(n, dirs[1], 300, 4000), h1: series(n, dirs[2], 3600, 4000) };
}
function assertSums100(s) {
  assert.equal(s.ok, true, 'strength must be ok: ' + (s.detail || ''));
  assert.equal(s.buying + s.selling + s.neutral, 100, 'three scores must total 100');
  for (const v of [s.buying, s.selling, s.neutral]) assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, 'integer 0..100');
}

test('strong bullish technical conditions → dominant buying, totals 100', () => {
  const s = marketStrength(setsFor(['up', 'up', 'up']), { nowSec: NOW });
  assertSums100(s);
  assert.ok(s.buying > s.selling, `buying ${s.buying} must exceed selling ${s.selling}`);
  assert.match(s.classification, /buying pressure/);
  assert.ok(s.validTimeframes.length === 3);
  assert.ok(s.supporting.length > 0, 'supporting evidence listed');
  assert.equal(s.signal, undefined, 'strength never carries a trade signal');
});

test('strong bearish technical conditions → dominant selling, totals 100', () => {
  const s = marketStrength(setsFor(['down', 'down', 'down']), { nowSec: NOW });
  assertSums100(s);
  assert.ok(s.selling > s.buying);
  assert.match(s.classification, /selling pressure/);
});

test('neutral market conditions → balanced classification, totals 100', () => {
  const s = marketStrength(setsFor(['flat', 'flat', 'flat']), { nowSec: NOW });
  assertSums100(s);
  assert.equal(s.classification, 'Balanced / neutral conditions');
  assert.ok(s.neutral >= 33, `neutral share ${s.neutral} should be substantial in a flat market`);
});

test('mixed indicators across timeframes → ok, totals 100, both sides evidenced', () => {
  const s = marketStrength(setsFor(['up', 'down', 'up']), { nowSec: NOW });
  assertSums100(s);
  assert.ok(s.buying > 0 && s.selling > 0, 'mixed conditions score both sides');
  assert.ok(s.notes.length + s.supporting.length + s.contradicting.length > 0, 'evidence/notes present');
});

test('missing candles (empty sets) → INSUFFICIENT_DATA, no invented numbers', () => {
  const s = marketStrength({ m1: [], m5: [], h1: [] }, { nowSec: NOW });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'INSUFFICIENT_DATA');
  assert.equal(s.buying, undefined, 'no scores are manufactured');
  assert.match(s.detail, /INSUFFICIENT_CANDLES/);
});

test('too few candles per timeframe → INSUFFICIENT_DATA', () => {
  const s = marketStrength(setsFor(['up', 'up', 'up'], 40), { nowSec: NOW });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'INSUFFICIENT_DATA');
});

test('stale completed candles → INSUFFICIENT_DATA (STALE_DATA)', () => {
  const old = setsFor(['up', 'up', 'up']);
  for (const k of ['m1', 'm5', 'h1']) for (const c of old[k]) c.time -= 10 * 86400;
  const s = marketStrength(old, { nowSec: NOW });
  assert.equal(s.ok, false);
  assert.match(s.detail, /STALE_DATA/);
});

test('missing EMA200 (window under 200 closes) is skipped, not scored zero', () => {
  const s = marketStrength(setsFor(['up', 'up', 'up'], 120), { nowSec: NOW });
  assertSums100(s);
  const skipped = s.perTimeframe.m1.skipped.join(' ');
  assert.match(skipped, /EMA200/, 'EMA200 slot must be reported as skipped');
});

test('invalid closes (NaN) in one timeframe → that timeframe dropped, others stand', () => {
  const sets = setsFor(['up', 'up', 'up']);
  sets.m1[60].close = NaN;
  const s = marketStrength(sets, { nowSec: NOW });
  assertSums100(s);
  assert.equal(s.perTimeframe.m1.valid, false);
  assert.equal(s.perTimeframe.m5.valid, true);
  assert.ok(s.notes.some((n) => /M1/.test(n)), 'M1 exclusion is disclosed');
});

test('invalid closes in every timeframe → INSUFFICIENT_DATA', () => {
  const sets = setsFor(['up', 'up', 'up']);
  for (const k of ['m1', 'm5', 'h1']) sets[k][10].close = NaN;
  const s = marketStrength(sets, { nowSec: NOW });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'INSUFFICIENT_DATA');
});

test('zero prices remain valid and still total 100', () => {
  const sets = setsFor(['flat', 'flat', 'flat']);
  for (const k of ['m1', 'm5', 'h1']) for (const c of sets[k]) { c.open = 0; c.close = 0; c.high = 0.3; c.low = -0.3; }
  const s = marketStrength(sets, { nowSec: NOW });
  assertSums100(s);
});

test('rounding: pseudo-random walks always total exactly 100', () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let iter = 0; iter < 30; iter++) {
    const walk = (gran) => {
      const out = []; let p = 1000 + rnd() * 500;
      for (let i = 0; i < 90; i++) {
        p = Math.max(1, p + (rnd() - 0.5) * 6);
        out.push({ time: NOW - (89 - i) * gran, open: p, high: p + 1, low: p - 1, close: p });
      }
      return out;
    };
    const s = marketStrength({ m1: walk(60), m5: walk(300), h1: walk(3600) }, { nowSec: NOW });
    if (s.ok) assert.equal(s.buying + s.selling + s.neutral, 100, 'iteration ' + iter);
    else assert.equal(s.reason, 'INSUFFICIENT_DATA');
  }
});

test('forming (incomplete) candle is explicitly excluded and disclosed', () => {
  const s = marketStrength(setsFor(['up', 'up', 'up']), { nowSec: NOW, currentPresent: true });
  assertSums100(s);
  assert.match(s.currentCandle, /excluded/);
});

test('methodology and disclaimer are always present', () => {
  const s = marketStrength(setsFor(['up', 'down', 'flat']), { nowSec: NOW });
  assert.ok(s.methodology.length >= 4);
  assert.match(s.disclaimer, /not a probability of profit/i);
  assert.equal(s.weights.m1, '20%');
  assert.equal(s.rounding.includes('100'), true);
});
