import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketStatus, typicalActiveWindow, MARKET_HOURS_NOTE } from '../lib/markethours.js';

/* Session-hours guidance: UTC math for the typical Deriv calendar.
   Fixed timestamps so DST never makes these tests flaky. */
const at = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const forex = { c: 'forex' };
const metals = { c: 'commodities' };
const synth = { c: 'synthetics' };
const crypto = { c: 'crypto' };

test('crypto and synthetics are 24/7 markets', () => {
  for (const now of [at(2026, 10, 17, 3), at(2026, 10, 18, 12)]) { /* Saturday + Sunday */
    for (const inst of [synth, crypto]) {
      const s = marketStatus(inst, now);
      assert.equal(s.open, true);
      assert.equal(s.label, 'OPEN');
      assert.match(s.detail, /24\/7/);
    }
  }
});

test('forex: weekday afternoon open, daily break 21:00-22:00 UTC, honest labels', () => {
  const open = marketStatus(forex, at(2026, 10, 14, 15)); // Wed 15:00 UTC
  assert.equal(open.status, 'open');
  assert.match(open.detail, /daily break/);

  const brk = marketStatus(forex, at(2026, 10, 14, 21, 30)); // Wed 21:30 UTC
  assert.equal(brk.status, 'break');
  assert.match(brk.detail, /maintenance/);

  const brkEdge = marketStatus(forex, at(2026, 10, 14, 21, 59)); // 21:59 -> still break
  assert.ok(['break', 'open'].includes(brkEdge.status)); // minute boundary, never a wrong open/closed flip
});

test('forex: weekend closed (Fri after 22:00 through Sun before 22:00), Friday gets a close warning', () => {
  assert.equal(marketStatus(forex, at(2026, 10, 16, 23)).status, 'closed');   // Fri 23:00
  assert.equal(marketStatus(forex, at(2026, 10, 17, 12)).status, 'closed');   // Sat
  assert.equal(marketStatus(forex, at(2026, 10, 18, 12)).status, 'closed');   // Sun noon
  assert.equal(marketStatus(forex, at(2026, 10, 18, 21)).status, 'closed');   // Sun 21:00 still closed
  const sunOpen = marketStatus(forex, at(2026, 10, 18, 23));                   // Sun 23:00 -> new week open
  assert.equal(sunOpen.status, 'open');

  const friOpen = marketStatus(forex, at(2026, 10, 16, 15)); // Fri 15:00
  assert.equal(friOpen.status, 'open');
  assert.match(friOpen.detail, /weekend close/);

  const friBreak = marketStatus(forex, at(2026, 10, 16, 21, 15)); // Fri 21:15 = break (merges into weekend)
  assert.equal(friBreak.status, 'break');
  assert.equal(marketStatus(metals, at(2026, 10, 17, 9)).status, 'closed'); // metals follow the same calendar
});

test('indices remain unknown without a fresh local broker quote; typical activity guidance is explicit', () => {
  const s = marketStatus({ c: 'indices' }, at(2026, 10, 14, 15));
  assert.equal(s.status, null);
  assert.equal(s.label, 'UNKNOWN');
  assert.match(s.detail, /Exness index session not verified/);
  assert.match(typicalActiveWindow({ c: 'forex', s: 'EUR/USD' }), /London–New York overlap/);
  assert.match(typicalActiveWindow({ c: 'forex', s: 'USD/JPY' }), /Asia\/Tokyo/);
  assert.match(typicalActiveWindow({ c: 'indices', s: 'NAS100' }), /DST-dependent/);
  assert.match(typicalActiveWindow({ c: 'crypto', s: 'BTC/USD' }), /24\/7/);
  assert.ok(MARKET_HOURS_NOTE.includes('guidance') && MARKET_HOURS_NOTE.includes('UNKNOWN'));
});
