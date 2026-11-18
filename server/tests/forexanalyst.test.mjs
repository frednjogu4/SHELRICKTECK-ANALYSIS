import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeForex, FX_ANALYST_TIMEFRAMES } from '../lib/forexanalyst.js';

function risingBars(seconds, count = 130, slope = 0.00005) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const close = 1.1 + i * slope + Math.sin(i * 1.3) * 0.0004;
    const prior = i ? 1.1 + (i - 1) * slope + Math.sin((i - 1) * 1.3) * 0.0004 : close;
    rows.push({
      time: 1_700_000_000 + i * seconds,
      open: prior,
      high: Math.max(close, prior) + 0.00008 + Math.abs(Math.sin(i)) * 0.00004,
      low: Math.min(close, prior) - 0.00008 - Math.abs(Math.cos(i)) * 0.00004,
      close
    });
  }
  return rows;
}
function risingSet(count = 130) {
  return Object.fromEntries(['1m', '5m', '10m'].map(tf => [tf, risingBars(FX_ANALYST_TIMEFRAMES[tf], count)]));
}

test('FX analysis requires 2-of-3 aligned frames and returns 50 real-input bars plus structured chart overlays', () => {
  const candlesByTimeframe = risingSet();
  const entry = candlesByTimeframe['5m'].at(-2).close - 0.0005;
  const result = analyzeForex({ pair: 'EUR/USD', timeframe: '5m', candlesByTimeframe, currentPrice: entry, currentTime: 1_800_000_000, now: 1_800_000_000 });
  assert.equal(result.signal, 'BUY');
  assert.ok(result.confidence >= 70);
  assert.equal(result.action, 'NEW');
  assert.equal(result.mtf_alignment['1m'], 'BUY');
  assert.equal(result.mtf_alignment['5m'], 'BUY');
  assert.equal(result.mtf_alignment['10m'], 'BUY');
  for (const tf of ['1m', '5m', '10m']) {
    const chart = result.chart_data[tf];
    assert.equal(chart.candles.length, 50);
    assert.equal(chart.ema9.length, 50);
    assert.equal(chart.ema21.length, 50);
    assert.ok(chart.trendlines);
    assert.ok(chart.support_resistance);
    assert.ok(chart.support_resistance_zones.support.length);
    assert.ok(chart.support_resistance_zones.resistance.length);
    assert.equal(chart.overlays.signal, 'BUY');
    assert.ok(chart.overlays.entry_arrow.length);
  }
  assert.ok(Math.abs(result.entry - result.sl) / 0.0001 <= 15);
  assert.ok(Math.abs(result.tp - result.entry) / Math.abs(result.entry - result.sl) >= 1.5);
  assert.match(result.risk_reward, /^1:/);
});

test('15m request includes a separate closed-candle context; unsupported or non-FX instruments are refused', () => {
  const candlesByTimeframe = risingSet();
  candlesByTimeframe['15m'] = risingBars(900);
  const result = analyzeForex({ pair: 'GBP/USD', timeframe: '15m', candlesByTimeframe, currentPrice: 1.1, now: 1_800_000_000 });
  assert.equal(result.timeframe, '15m');
  assert.equal(result.chart_data.requested_context.timeframe, '15m');
  assert.equal(result.chart_data.requested_context.candles.length, 50);
  assert.throws(() => analyzeForex({ pair: 'XAU/USD', candlesByTimeframe }), /forex pair/);
  assert.throws(() => analyzeForex({ pair: 'EUR/USD', timeframe: '30m', candlesByTimeframe }), /Timeframe/);
});

test('missing live price, insufficient bars, and unaligned timeframes fail closed without invented levels', () => {
  const candlesByTimeframe = risingSet();
  const missingQuote = analyzeForex({ pair: 'EUR/USD', timeframe: '5m', candlesByTimeframe, currentPrice: null });
  assert.equal(missingQuote.signal, 'WAIT');
  assert.equal(missingQuote.entry, null);
  assert.match(missingQuote.reason, /fresh live price is unavailable/);
  const short = analyzeForex({ pair: 'EUR/USD', timeframe: '5m', candlesByTimeframe: { ...candlesByTimeframe, '1m': risingBars(60, 40) }, currentPrice: 1.1 });
  assert.equal(short.mtf_alignment['1m'], 'NEUTRAL');
  assert.equal(short.chart_data['1m'].candles.length, 0);
  assert.equal(short.signal, 'WAIT');
  assert.equal(short.entry, null);
});

test('UPDATE retains an unchanged prior reading without a new closed bar and exits when its stop is crossed', () => {
  const candlesByTimeframe = risingSet();
  const currentPrice = candlesByTimeframe['5m'].at(-2).close - 0.0005;
  const first = analyzeForex({ pair: 'EUR/USD', timeframe: '5m', candlesByTimeframe, currentPrice, now: 1_800_000_000 });
  assert.equal(first.signal, 'BUY');
  const same = analyzeForex({ pair: 'EUR/USD', timeframe: '5m', candlesByTimeframe, currentPrice, mode: 'UPDATE', previous: first, now: 1_800_000_010 });
  assert.equal(same.signal, 'BUY');
  assert.equal(same.action, 'HOLD');
  assert.equal(same.previous_signal_check, 'valid');
  assert.match(same.reason, /No newer closed candle/);

  const crossed = Object.fromEntries(Object.entries(candlesByTimeframe).map(([tf, rows]) => [tf, rows.map(row => ({ ...row }))]));
  const seconds = FX_ANALYST_TIMEFRAMES['5m'];
  const priorBar = crossed['5m'].at(-1);
  priorBar.low = Math.min(priorBar.low, first.sl - 0.0001);
  const newClose = priorBar.close + 0.00002;
  crossed['5m'].push({ time: priorBar.time + seconds, open: priorBar.close, high: newClose + 0.00005, low: Math.min(priorBar.close - 0.00005, first.sl - 0.0001), close: newClose });
  const exit = analyzeForex({ pair: 'EUR/USD', timeframe: '5m', candlesByTimeframe: crossed, currentPrice, mode: 'UPDATE', previous: first, now: 1_800_000_020 });
  assert.equal(exit.signal, 'WAIT');
  assert.equal(exit.action, 'EXIT');
  assert.equal(exit.previous_signal_check, 'invalidated');
  assert.match(exit.reason, /reached the previous stop/);
  assert.equal(exit.chart_data['1m'].overlays.entry, null);
});
