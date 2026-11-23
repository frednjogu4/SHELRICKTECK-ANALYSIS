import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeShortOutlook, renderShortOutlook } from '../src/shortoutlook.js';

function series({ count = 300, direction = 1, base = 100, nowOffsetMs = 30000 } = {}) {
  const start = 1_800_000_000;
  const candles = Array.from({ length: count }, (_, index) => {
    const close = base + direction * index * 0.02;
    return { time: start + index * 60, open: close - direction * 0.005, high: close + 0.01, low: close - 0.02, close };
  });
  return { candles, now: (start + count * 60) * 1000 + nowOffsetMs };
}

test('fresh completed M1 candles produce all seven historical performance windows and both horizons', () => {
  const input = series();
  const result = analyzeShortOutlook(input.candles, { now: input.now });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.observations.map(item => item.key), ['1m', '5m', '30m', '1h', '2h', '3h', '4h']);
  assert.ok(result.observations.every(item => item.available && item.direction === 'UP' && item.changePct > 0));
  assert.equal(result.forecasts['5m'].direction, 'UP');
  assert.equal(result.forecasts['10m'].direction, 'UP');
  assert.equal(result.totalScore, 14);
  assert.equal(result.forecasts['5m'].score, 14);
  assert.equal(result.forecasts['5m'].alignmentPct, 100);
  assert.equal(result.forecasts['10m'].aligned, 7);
  assert.ok(result.latestCloseAt < input.now, 'the forming candle is never included');
});

test('falling verified candles report DOWN without presenting a probability of profit', () => {
  const input = series({ direction: -1, base: 200 });
  const result = analyzeShortOutlook(input.candles, { now: input.now });
  assert.equal(result.status, 'ready');
  assert.equal(result.forecasts['5m'].direction, 'DOWN');
  assert.equal(result.forecasts['10m'].direction, 'DOWN');
  const html = renderShortOutlook(result, { symbol: 'EUR/USD', source: 'Deriv public candle history' });
  assert.match(html, /Next 5m/);
  assert.match(html, /Next 10m/);
  assert.match(html, /4h/);
  assert.match(html, /not a probability/);
  assert.match(html, /not confidence or probability of profit/);
  assert.match(html, /not a guaranteed prediction/);
  assert.match(html, /4H/);
  assert.match(html, /Total timeframe score/);
});

test('insufficient lookback keeps measured periods but refuses both forecasts', () => {
  const input = series({ count: 100 });
  const result = analyzeShortOutlook(input.candles, { now: input.now });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.observations.find(item => item.key === '1h').available, true);
  assert.equal(result.observations.find(item => item.key === '4h').available, false);
  assert.equal(result.forecasts['5m'].direction, 'UNAVAILABLE');
  assert.match(renderShortOutlook(result, { symbol: 'XAU/USD' }), /All seven complete lookback windows are required/);
});

test('stale data preserves historical returns but does not forecast current 5m or 10m direction', () => {
  const input = series({ nowOffsetMs: 500000 });
  const result = analyzeShortOutlook(input.candles, { now: input.now });
  assert.equal(result.status, 'stale');
  assert.equal(result.observations.find(item => item.key === '4h').available, true);
  assert.equal(result.forecasts['5m'].direction, 'UNAVAILABLE');
  assert.match(renderShortOutlook(result, { symbol: 'GBP/USD' }), /historical performance is shown without a current outlook/);
});

test('fewer than five timeframe votes in the weighted direction withholds the directional outlook', () => {
  const start = 1_800_000_000;
  const candles = Array.from({ length: 300 }, (_, index) => {
    const close = 100 + (index < 240 ? index * 0.03 : 240 * 0.03 - (index - 240) * 0.03);
    return { time: start + index * 60, open: close, high: close + 0.02, low: close - 0.02, close };
  });
  const result = analyzeShortOutlook(candles, { now: (start + 300 * 60) * 1000 + 30000 });
  assert.equal(result.status, 'ready');
  assert.ok(result.consensus.bullish > 0 && result.consensus.bearish > 0);
  assert.equal(result.forecasts['5m'].direction, 'NEUTRAL');
  assert.equal(result.forecasts['10m'].direction, 'NEUTRAL');
});

test('flat movement is neutral and malformed or unsorted histories fail closed', () => {
  const input = series({ direction: 0 });
  const flat = analyzeShortOutlook(input.candles, { now: input.now });
  assert.equal(flat.status, 'ready');
  assert.equal(flat.forecasts['5m'].direction, 'NEUTRAL');
  const unsorted = [...input.candles];
  [unsorted[10], unsorted[11]] = [unsorted[11], unsorted[10]];
  assert.equal(analyzeShortOutlook(unsorted, { now: input.now }).status, 'unavailable');
  assert.equal(analyzeShortOutlook([], { now: input.now }).status, 'unavailable');
});
