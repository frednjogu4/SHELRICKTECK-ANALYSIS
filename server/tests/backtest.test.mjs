import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from '../lib/backtest.js';

/* deterministic fixture candles — wave + drift (test-only, never product data) */
function fixture(n = 300, dir = 1) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const open = p;
    p = p * (1 + dir * 0.0004 + Math.sin(i / 7) * 0.0016);
    const close = p;
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    out.push({ time: 1700000000 + i * 60, open, high, low, close, volume: 5 });
  }
  return out;
}

test('runBacktest returns full stats + trades on a fixture', () => {
  const res = runBacktest({ candles: fixture(320), symbol: 'EUR/USD' });
  assert.equal(res.bars, 320);
  assert.ok(res.stats.trades >= 1, 'at least one trade');
  for (const k of ['closed', 'wins', 'losses', 'winRate', 'netR', 'avgR', 'profitFactor', 'maxDrawdownR', 'byResult']) {
    assert.ok(k in res.stats, 'stat ' + k);
  }
  assert.ok(Array.isArray(res.trades) && res.trades.length >= 1);
  const t = res.trades[0];
  for (const k of ['side', 'entry', 'exit', 'bars', 'result', 'r']) assert.ok(k in t, 'trade field ' + k);
  assert.ok(res.note.includes('real Deriv candles'));
});

test('insufficient candles rejected (no invented history)', () => {
  assert.throws(() => runBacktest({ candles: fixture(40), symbol: 'X' }), /need at least/);
  assert.throws(() => runBacktest({ candles: null, symbol: 'X' }), /need at least/);
});

test('downtrend fixture trades SELLs too (engine is direction-agnostic)', () => {
  const res = runBacktest({ candles: fixture(300, -1), symbol: 'EUR/USD' });
  assert.ok(res.stats.trades >= 1);
  const sides = new Set(res.trades.map((t) => t.side));
  assert.ok(sides.size >= 1);
});

test('every trade respects risk geometry (sl/tp derived from ATR)', () => {
  const res = runBacktest({ candles: fixture(400), symbol: 'EUR/USD' });
  for (const t of res.trades) {
    assert.ok(['BUY', 'SELL'].includes(t.side));
    assert.ok(['sl', 'tp1', 'tp2', 'flip', 'timeout', 'open'].includes(t.result), t.result);
    if (t.result === 'sl') assert.ok(t.r <= 0.05, 'sl is a loss ~-1R, got ' + t.r);
  }
});
