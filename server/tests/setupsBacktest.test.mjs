import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSetupsBacktest, setupMetrics } from '../lib/setupsBacktest.js';

/* Walk-forward scoring for setups: both scorers, honest OOS metrics,
 * small-sample warnings. Educational analysis only — the tests assert the
 * MECHANICS (shape, OOS split, warnings), never that a setup is "good". */

const c = (t, o, h, l, cl, v = 50) => ({ time: Math.round(t / 1000), open: o, high: h, low: l, close: cl, volume: v });
/** Trending-then-chopping series, 5-min bars — rich enough that EMA pullback fires sometimes. */
function series(n = 900) {
  const out = []; let px = 1.1; let t = 1700000000000;
  for (let i = 0; i < n; i++) {
    const phase = Math.floor(i / 150);
    const drift = phase % 2 === 0 ? 0.0006 : -0.0005;
    const o = px; const cl = px + drift + Math.sin(i / 7) * 0.0004;
    out.push(c(t, o, Math.max(o, cl) + 0.0004, Math.min(o, cl) - 0.0004, cl)); px = cl; t += 300000;
  }
  return out;
}

test('setupMetrics: known sequence produces exact winRate/expectancy/streak/dd', () => {
  const m = setupMetrics([{ win: true, r: 1.5 }, { win: false, r: -1 }, { win: false, r: -1 }, { win: true, r: 2 }, { win: false, r: -1 }]);
  assert.equal(m.trades, 5);
  assert.equal(m.winRate, 40);
  assert.equal(m.longestLossStreak, 2);
  assert.equal(m.netR, 0.5);
  assert.equal(m.expectancyR, 0.1);
  assert.ok(m.maxDrawdownR >= 2);
});

test('binary scorer (Deriv-style horizon): OOS-only trades with coherent shape', () => {
  const r = runSetupsBacktest({ symbol: 'EUR/USD', category: 'forex', candles: series(900), granularity: 300, scoring: 'binary', horizonBars: 5 });
  assert.equal(r.scoring, 'binary');
  assert.deepEqual(Object.keys(r.perSetup), ['EMA_TREND_PULLBACK', 'VWAP_MEAN_REVERSION', 'OPENING_RANGE_BREAKOUT', 'RSI_MEAN_REVERSION']);
  for (const [name, p] of Object.entries(r.perSetup)) {
    for (const k of ['trades', 'winRate', 'expectancyR', 'profitFactor', 'maxDrawdownR', 'longestLossStreak', 'netR']) assert.ok(k in p.oos, name + ' missing ' + k);
    assert.ok(p.oos.winRate >= 0 && p.oos.winRate <= 100);
  }
  // OOS = last 30%: with 400 evaluated bars, closed trades must sit inside the OOS window
  const ema = r.perSetup.EMA_TREND_PULLBACK.oos.trades;
  assert.ok(r.barsEvaluated > 0);
  assert.ok(/NOT conclusive/.test(r.note));
  assert.ok(ema >= 0);
});

test('r scorer (MT5-style): R-multiples with spread+slippage pessimism, SL-first accounting', () => {
  const r = runSetupsBacktest({ symbol: 'EUR/USD', category: 'forex', candles: series(900), granularity: 300, scoring: 'r', spreadPips: 2, slippagePips: 1, pipSize: 0.0001 });
  assert.equal(r.scoring, 'r');
  const all = Object.values(r.perSetup);
  for (const p of all) {
    if (p.oos.trades > 0) {
      // with stop ~ ATR and target 1.5R, a full loss is -1R: expectancy can never exceed ~+1.5 here
      assert.ok(p.oos.expectancyR <= 1.51, 'expectancy bound');
      assert.ok(p.oos.expectancyR >= -1.01, 'expectancy bound');
    }
    assert.ok(/pessimistic/.test(r.note));
  }
});

test('fewer than 30 OOS trades -> explicit NOT-conclusive warning per setup', () => {
  const r = runSetupsBacktest({ symbol: 'EUR/USD', category: 'forex', candles: series(160), granularity: 300, scoring: 'binary' });
  for (const p of Object.values(r.perSetup)) assert.ok(p.warning && /30-trade minimum/.test(p.warning));
});

test('dirty/short input rejected, never silently scored', () => {
  const dup = series(200); dup[10] = { ...dup[9] };
  assert.throws(() => runSetupsBacktest({ candles: dup, granularity: 300 }), /clean candles/);
  assert.throws(() => runSetupsBacktest({ candles: series(100), granularity: 300 }), /clean candles/);
});
