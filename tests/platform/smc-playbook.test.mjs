import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSmcSetups, smcHigherTimeframeBias } from '../../src/smcplaybook.js';

const trend = (state) => ({ ok: true, trend: { state } });
const upBias = { h1: trend('UP'), h4: trend('UP') };
const downBias = { h1: trend('DOWN'), h4: trend('DOWN') };
const candle = (index, open, high, low, close) => ({ time: 1_800_000_000 + index * 300, open, high, low, close });
const flatBars = (count = 40) => Array.from({ length: count }, (_unused, i) => candle(i, 100, 100.2, 99.8, 100));

test('SMC directional filter requires both H1 and H4 to agree on a trend', () => {
  assert.deepEqual(smcHigherTimeframeBias(trend('UP'), trend('UP')), { direction: 'BUY', reason: 'H1 and H4 agree on up.' });
  assert.deepEqual(smcHigherTimeframeBias(trend('DOWN'), trend('DOWN')), { direction: 'SELL', reason: 'H1 and H4 agree on down.' });
  assert.equal(smcHigherTimeframeBias(trend('UP'), trend('DOWN')).direction, 'WAIT');
  assert.equal(smcHigherTimeframeBias(trend('RANGE'), trend('RANGE')).direction, 'WAIT');
  assert.equal(smcHigherTimeframeBias(null, trend('UP')).direction, 'WAIT');
});

test('SMC uses only ordered completed candles and fails closed on insufficient or unordered history', () => {
  assert.equal(evaluateSmcSetups(flatBars(20), upBias).available, false);
  const unordered = flatBars(40); unordered[10] = { ...unordered[10], time: unordered[9].time };
  assert.match(evaluateSmcSetups(unordered, upBias).reason, /not strictly increasing/);
  const result = evaluateSmcSetups(flatBars(), upBias);
  assert.equal(result.available, true);
  assert.deepEqual(result.setups.map((setup) => setup.key), ['break-retest', 'liquidity-mss', 'fvg-retest']);
  assert.ok(result.setups.every((setup) => setup.status === 'NONE'));
  assert.equal(result.confluence.status, 'WAIT');
});

test('break-and-retest waits for a rejection close above the broken swing, and only confirms the closed retest', () => {
  const bars = flatBars();
  bars[30] = candle(30, 100, 100.8, 99.8, 100);
  bars.push(candle(40, 100.3, 101.1, 100.3, 101), candle(41, 100.6, 100.9, 100.5, 100.8));
  const waiting = evaluateSmcSetups(bars, upBias).setups.find((setup) => setup.key === 'break-retest');
  assert.equal(waiting.status, 'WAIT');
  assert.match(waiting.detail, /wait for a retest and rejection/);

  bars[41] = candle(41, 100.6, 100.95, 100.5, 100.85);
  const confirmed = evaluateSmcSetups(bars, upBias).setups.find((setup) => setup.key === 'break-retest');
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.direction, 'BUY');
  assert.equal(confirmed.time, bars[41].time);
});

test('a swept swing only confirms after a close through the internal M5 swing (MSS)', () => {
  const bars = flatBars();
  bars[30] = candle(30, 100, 100.2, 99.2, 100);
  bars[36] = candle(36, 100, 100.8, 99.8, 100);
  bars.push(candle(40, 99.8, 100, 99, 99.4), candle(41, 99.5, 101, 99.5, 100.9));
  const result = evaluateSmcSetups(bars, upBias).setups.find((setup) => setup.key === 'liquidity-mss');
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.direction, 'BUY');
  assert.match(result.detail, /Sweep and reclaim.*followed by an M5 close through internal swing/);

  const opposed = evaluateSmcSetups(bars, downBias).setups.find((setup) => setup.key === 'liquidity-mss');
  assert.equal(opposed.status, 'CONFLICT');
});

test('a bullish three-candle FVG is only confirmed after a closed retest reaction and matching H1/H4 bias', () => {
  const bars = flatBars();
  bars.push(
    candle(40, 100, 100.5, 99.9, 100.2),
    candle(41, 100.2, 102.5, 100.2, 102.2),
    candle(42, 102.4, 103, 101.2, 102.8),
    candle(43, 101.2, 102, 101.1, 101.8)
  );
  const result = evaluateSmcSetups(bars, upBias);
  const fvg = result.setups.find((setup) => setup.key === 'fvg-retest');
  assert.equal(fvg.status, 'CONFIRMED');
  assert.equal(fvg.direction, 'BUY');
  assert.match(fvg.detail, /FVG .* was revisited and rejected/);
  assert.equal(fvg.time, bars[43].time);

  const opposed = evaluateSmcSetups(bars, downBias).setups.find((setup) => setup.key === 'fvg-retest');
  assert.equal(opposed.status, 'CONFLICT');
  assert.match(opposed.detail, /Opposes the H1\/H4 SELL bias/);
});

test('a detected FVG without H1/H4 agreement stays WAIT, never a BUY/SELL instruction', () => {
  const bars = flatBars();
  bars.push(candle(40, 100, 100.5, 99.9, 100.2), candle(41, 100.2, 102.5, 100.2, 102.2), candle(42, 102.4, 103, 101.2, 102.8), candle(43, 101.2, 102, 101.1, 101.8));
  const result = evaluateSmcSetups(bars, { h1: trend('UP'), h4: trend('RANGE') });
  const fvg = result.setups.find((setup) => setup.key === 'fvg-retest');
  assert.equal(fvg.status, 'WAIT');
  assert.match(fvg.detail, /H1 and H4 both need/);
  assert.notEqual(result.confluence.status, 'ALIGNED');
});
