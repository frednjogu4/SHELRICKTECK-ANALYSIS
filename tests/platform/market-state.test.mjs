/*
 * src/marketstate.js: trend, structure and volatility of one timeframe.
 *
 * What these tests hold:
 *
 *   - the figures are the ones a chart shows. The expected numbers of the
 *     first test were not produced by the code under test: they come from a
 *     separate re-computation of the textbook definitions (in Python: EMA
 *     seeded with a simple average, ATR and ADX with Wilder's smoothing, swing
 *     points, ranks) on the fixed series built here;
 *   - the candle that may still be forming is never used, and a swing that
 *     has been found never moves;
 *   - every state has one definition and an edge that is tested;
 *   - what cannot be read gives no state at all.
 *
 * The series are arithmetic, not market data. No test says that a state is a
 * reason to trade: the module is a description (see its header).
 *
 * The last tests are about wording: the page, the README and the module give
 * the same thresholds and the same measured figures. They cannot show that the
 * figures are right; those come from the replay run described in the README
 * (scripts/state-replay.mjs), whose price data is not in this repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATE_TIMEFRAMES, STATE_CANDLES, MIN_FINISHED, ADX_TREND, ADX_RANGE, SWING_SPAN, VOL_WINDOW, VOL_QUIET, VOL_HIGH, VOL_EXTREME, SKETCH_CANDLES,
  cleanCandles, emaAligned, atrSeries, adxSeries, trendStateOf, stackOf, swingPoints, alternatingSwings, markSwings, structureOf, volatilityOf,
  timeframeState, summarizeStates, summaryText, feedFreshness, structureWords, eatMoment, TREND_WORDS, VOLATILITY_WORDS, STATE_MEASURED, STATE_MEASURED_TEXT
} from '../../src/marketstate.js';
import { ema } from '../../server/lib/indicators.js';
import { adx } from '../../server/lib/indicators.ext.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H1 = STATE_TIMEFRAMES.find((timeframe) => timeframe.key === 'h1');
const BASE = 1_700_006_400; /* a full 4-hour boundary, so the series is aligned on every timeframe */

/**
 * 600 one-hour candles from a formula: a drift, a wave whose size may grow or
 * shrink, and a small fixed jitter. The last one stands for the candle that is
 * still forming.
 */
function series({ drift = 0, wave = 1, period = 6, start = 100, grow = 0, n = STATE_CANDLES } = {}) {
  const closes = Array.from({ length: n }, (_, i) => start + drift * i + Math.sin(i / period) * wave * (1 + grow * i) + (((i * 7919) % 13) - 6) * 0.11);
  return closes.map((close, i) => {
    const open = i ? closes[i - 1] : close;
    return { time: BASE + i * H1.seconds, open, high: Math.max(open, close) + 0.3 + ((i * 31) % 5) * 0.1, low: Math.min(open, close) - 0.25 - ((i * 17) % 4) * 0.1, close };
  });
}
const RISING = series({ drift: 0.25, wave: 1.5, period: 6 });
const FALLING = series({ drift: -0.25, wave: 1.5, period: 6, start: 300 });
const LEVEL = series({ drift: 0, wave: 1, period: 4 });
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 5e-7, `${label}: ${actual} against ${expected}`);

/* ---------------------------------------------------------------- the figures */

test('EMA 20/50/200, ADX 14 with +DI and -DI, ATR 14 and its rank equal an independent calculation', () => {
  const expected = [
    [RISING, { trend: 'UP', held: 400, ema20: 246.377306911, ema50: 243.078529072, ema200: 224.558944599, adx: 53.479223596, plusDI: 20.888853005, minusDI: 7.260354622, atr: 1.418450309, rank: 41, ratio: 0.984813384, change: 0.008045774, close: 247.699040162 }],
    [FALLING, { trend: 'DOWN', held: 400, ema20: 152.127306911, ema50: 156.328529072, ema200: 175.308944599, adx: 75.770831304, plusDI: 2.917150397, minusDI: 29.653403599, atr: 1.289938095, rank: 75.5, ratio: 1.024180117, change: 0.035444728, close: 148.699040162 }],
    [LEVEL, { trend: 'RANGE', held: 400, ema20: 99.741424605, ema50: 99.919312164, ema200: 99.984660137, adx: 13.881390161, plusDI: 11.477551724, minusDI: 17.68140906, atr: 1.262860481, rank: 40, ratio: 0.989837328, change: -0.03816181, close: 98.377398217 }]
  ];
  for (const [candles, want] of expected) {
    const reading = timeframeState(candles, H1);
    assert.equal(reading.ok, true);
    assert.equal(reading.trend.state, want.trend);
    assert.equal(reading.trend.candlesInState, want.held);
    for (const key of ['ema20', 'ema50', 'ema200', 'adx', 'plusDI', 'minusDI']) near(reading.trend[key], want[key], want.trend + ' ' + key);
    near(reading.volatility.atr, want.atr, want.trend + ' ATR');
    near(reading.volatility.rank, want.rank, want.trend + ' rank');
    near(reading.volatility.ratio, want.ratio, want.trend + ' ratio');
    near(reading.volatility.changePct, want.change, want.trend + ' change');
    near(reading.price, want.close, want.trend + ' close');
  }
});

test('the swings and the structure read from them equal the independent calculation', () => {
  const expected = [
    [RISING, { state: 'UP', lastHigh: [584, 247.3340144032108], prevHigh: [544, 237.66825809300138], lastLow: [586, 244.97439666416216], prevLow: [547, 235.44898126762672], position: 'above' }],
    [FALLING, { state: 'DOWN', lastHigh: [572, 159.4923903280057], prevHigh: [539, 168.12709350233493], lastLow: [559, 157.71627726814398], prevLow: [534, 166.7852728367073], position: 'below' }],
    [LEVEL, { state: 'UP', lastHigh: [584, 102.24646917312177], prevHigh: [559, 102.2050781108584], lastLow: [573, 97.9916546391261], prevLow: [547, 97.80265833179944], position: 'inside' }]
  ];
  for (const [candles, want] of expected) {
    const { structure } = timeframeState(candles, H1);
    assert.equal(structure.state, want.state);
    assert.equal(structure.position, want.position);
    for (const key of ['lastHigh', 'prevHigh', 'lastLow', 'prevLow']) {
      assert.equal(structure[key].index, want[key][0], key + ' is the candle the independent calculation found');
      near(structure[key].price, want[key][1], key);
      assert.equal(structure[key].time, candles[want[key][0]].time, key + ' carries the start of its candle');
    }
  }
});

test('the series are the chart definitions: EMA as in indicators.js, ADX as in indicators.ext.js, ATR with Wilder smoothing', () => {
  const finished = RISING.slice(0, -1), closes = finished.map((candle) => candle.close), last = finished.length - 1;
  for (const period of [20, 50, 200]) {
    const aligned = emaAligned(closes, period);
    assert.equal(aligned.length, closes.length);
    assert.equal(aligned[period - 2], null, 'no EMA ' + period + ' before ' + period + ' closes');
    assert.equal(aligned[last], ema(closes, period));
  }
  const dmi = adxSeries(finished), whole = adx(finished);
  assert.equal(dmi.adx[last], whole.adx);
  assert.equal(dmi.plusDI[last], whole.plusDI);
  assert.equal(dmi.minusDI[last], whole.minusDI);
  assert.equal(dmi.adx[26], null, 'ADX 14 needs 28 candles');
  assert.equal(typeof dmi.adx[27], 'number');
  /* Wilder: the plain average of the first 14 true ranges, then each new one enters with weight 1/14. */
  const ranges = finished.slice(1).map((candle, i) => Math.max(candle.high - candle.low, Math.abs(candle.high - finished[i].close), Math.abs(candle.low - finished[i].close)));
  let value = ranges.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  for (const range of ranges.slice(14)) value = (value * 13 + range) / 14;
  const atr = atrSeries(finished);
  near(atr[last], value, 'ATR 14');
  assert.equal(atr[13], null, 'ATR 14 needs 15 candles');
  assert.equal(typeof atr[14], 'number');
});

/* ---------------------------------------------------------------- finished candles only */

test('the newest candle is never used: whatever it holds, the state is the same', () => {
  const base = timeframeState(RISING, H1);
  const last = RISING[RISING.length - 1];
  for (const forming of [
    { ...last, high: last.high * 3, close: last.high * 3 },
    { ...last, low: last.low / 3, close: last.low / 3 },
    { ...last, open: 1, high: 1, low: 1, close: 1 }
  ]) {
    assert.deepEqual(timeframeState([...RISING.slice(0, -1), forming], H1), base);
  }
  assert.equal(base.asOf, RISING[RISING.length - 2].time + H1.seconds, 'the state belongs to the close of the candle before the newest');
  assert.equal(base.newestStart, last.time);
  assert.equal(base.candles, STATE_CANDLES - 1);
});

test('one more finished candle moves the state on by one candle and no further', () => {
  const next = { time: RISING[RISING.length - 1].time + H1.seconds, open: 250, high: 251, low: 249, close: 250 };
  const before = timeframeState(RISING, H1), after = timeframeState([...RISING, next], H1);
  assert.equal(after.asOf, before.asOf + H1.seconds);
  assert.equal(after.candles, before.candles + 1);
  assert.equal(after.price, RISING[RISING.length - 1].close, 'the candle that was forming has finished and is now the last one read');
});

test('a swing that has been found never moves: every longer history starts with the swings of the shorter one', () => {
  for (const candles of [RISING, FALLING, LEVEL]) {
    const finished = candles.slice(0, -1);
    let previous = swingPoints(finished.slice(0, 300));
    assert.ok(previous.length > 5, 'the series has swings to speak of');
    for (let length = 301; length <= finished.length; length++) {
      const now = swingPoints(finished.slice(0, length));
      assert.deepEqual(now.slice(0, previous.length), previous, 'at ' + length + ' candles');
      for (const added of now.slice(previous.length)) assert.equal(added.index, length - 1 - SWING_SPAN, 'a new swing is exactly ' + SWING_SPAN + ' candles old when it appears');
      previous = now;
    }
  }
});

test('a swing high stands above the five candles before it and is not passed by the five after it', () => {
  const flat = (high, low = 90) => ({ open: 95, high, low, close: 95 });
  const row = (highs) => highs.map((high, i) => ({ time: BASE + i * 3600, ...flat(high) }));
  const found = (highs) => swingPoints(row(highs)).filter((point) => point.kind === 'high').map((point) => point.index);
  assert.deepEqual(found([100, 100, 100, 100, 100, 105, 100, 100, 100, 100, 100]), [5]);
  assert.deepEqual(found([100, 100, 100, 100, 100, 105, 100, 100, 100, 100]), [], 'four candles after it are not enough');
  assert.deepEqual(found([100, 100, 100, 100, 100, 105, 100, 100, 105, 100, 100, 100, 100, 100]), [5], 'of two equal highs the earlier one counts');
  assert.deepEqual(found([100, 100, 100, 100, 100, 105, 100, 100, 106, 100, 100, 100, 100, 100]), [8], 'a higher high within five candles takes its place');
  assert.deepEqual(found([100, 100, 100, 100, 100, 105, 105, 100, 100, 100, 100, 100]), [5], 'level with the candle before it is not above it: the second of the two is no swing');
  assert.deepEqual(found([100, 100, 100, 100, 105, 100, 100, 100, 100, 100, 100]), [], 'four candles before it are not enough either');
});

test('swings in turn: of two highs with no low between them the higher stays, of two such lows the lower', () => {
  const point = (kind, price, index) => ({ kind, price, index, time: BASE + index * 3600 });
  const kept = alternatingSwings([point('high', 10, 1), point('high', 12, 2), point('high', 11, 3), point('low', 5, 4), point('low', 4, 5), point('low', 6, 6), point('high', 9, 7)]);
  assert.deepEqual(kept.map((swing) => [swing.kind, swing.price]), [['high', 12], ['low', 4], ['high', 9]]);
  assert.deepEqual(markSwings(kept).map((swing) => swing.mark), ['H', 'L', 'LH'], 'the first of each kind has nothing to be compared with');
  assert.deepEqual(markSwings([point('high', 5, 1), point('low', 1, 2), point('high', 6, 3), point('low', 0.5, 4), point('high', 6, 5), point('low', 2, 6)]).map((swing) => swing.mark), ['H', 'L', 'HH', 'LL', 'EH', 'HL']);
  for (const candles of [RISING, FALLING, LEVEL]) {
    const swings = alternatingSwings(swingPoints(candles.slice(0, -1)));
    for (let i = 1; i < swings.length; i++) assert.notEqual(swings[i].kind, swings[i - 1].kind);
  }
});

/* ---------------------------------------------------------------- the three states, edge by edge */

test('trend: range below ADX 20, a trend from ADX 25 with the averages in order, unclear in between and otherwise', () => {
  const up = { close: 110, ema20: 108, ema50: 105, ema200: 100 }, down = { close: 90, ema20: 92, ema50: 95, ema200: 100 };
  assert.equal(ADX_TREND, 25);
  assert.equal(ADX_RANGE, 20);
  assert.equal(trendStateOf({ ...up, adx: 25 }), 'UP');
  assert.equal(trendStateOf({ ...down, adx: 25 }), 'DOWN');
  assert.equal(trendStateOf({ ...up, adx: 24.999 }), 'UNCLEAR', 'averages in order, ADX short of 25');
  assert.equal(trendStateOf({ ...up, adx: 20 }), 'UNCLEAR', 'ADX 20 is no longer a range');
  assert.equal(trendStateOf({ ...up, adx: 19.999 }), 'RANGE', 'below 20 it is a range whatever order the averages are in');
  assert.equal(trendStateOf({ ...down, adx: 5 }), 'RANGE');
  assert.equal(trendStateOf({ ...up, close: 104, adx: 40 }), 'UNCLEAR', 'a strong move with the close under EMA 50');
  assert.equal(trendStateOf({ ...up, ema20: 105, adx: 40 }), 'UNCLEAR', 'EMA 20 level with EMA 50 is not above it');
  assert.equal(trendStateOf({ ...up, ema200: 106, adx: 40 }), 'UNCLEAR', 'EMA 200 above EMA 50');
  for (const missing of ['close', 'ema20', 'ema50', 'ema200', 'adx']) assert.equal(trendStateOf({ ...up, adx: 30, [missing]: null }), null, 'no state without ' + missing);
  assert.equal(trendStateOf({ ...up, adx: NaN }), null);
  assert.equal(stackOf(up), 'up');
  assert.equal(stackOf(down), 'down');
  assert.equal(stackOf({ ...up, close: 104 }), 'mixed');
  /* The replay script tries other thresholds through the same function. */
  assert.equal(trendStateOf({ ...up, adx: 22 }, { adxTrend: 20, adxRange: 20 }), 'UP');
});

test('trend: the state says for how many candles it has held, and when the count may be short', () => {
  const rising = timeframeState(RISING, H1).trend;
  assert.equal(rising.state, 'UP');
  assert.equal(rising.stack, 'up');
  assert.equal(rising.candlesInState, STATE_CANDLES - 1 - 199, 'from the first candle that has an EMA 200');
  assert.equal(rising.sinceOpen, true, 'the run reaches the first candle with a state: it may be longer');
  assert.equal(rising.since, RISING[199].time + H1.seconds);

  /* A level market that starts to climb: the uptrend is a few candles old, and its start is a close time. */
  const turn = series({ drift: 0, wave: 1, period: 4 }).map((candle, i) => {
    if (i < 520) return candle;
    const lift = (i - 519) * 1.2;
    return { ...candle, open: candle.open + (i > 520 ? lift - 1.2 : 0), high: candle.high + lift, low: candle.low + (i > 520 ? lift - 1.2 : 0), close: candle.close + lift };
  });
  const turned = timeframeState(turn, H1).trend;
  assert.equal(turned.state, 'UP');
  assert.equal(turned.sinceOpen, false);
  assert.ok(turned.candlesInState > 5 && turned.candlesInState < 80, 'held for ' + turned.candlesInState + ' candles');
  assert.equal(turned.since, turn[turn.length - 2].time + H1.seconds - (turned.candlesInState - 1) * H1.seconds);
});

test('structure: the last two swing highs and the last two swing lows, in six states', () => {
  const swings = (...pairs) => pairs.map(([kind, price], index) => ({ kind, price, index, time: BASE + index * 3600 }));
  const read = (highBefore, lowBefore, high, low, close = 100) => structureOf(swings(['high', highBefore], ['low', lowBefore], ['high', high], ['low', low]), close);
  assert.equal(read(110, 90, 115, 95).state, 'UP');
  assert.equal(read(110, 90, 105, 85).state, 'DOWN');
  assert.equal(read(110, 90, 115, 85).state, 'WIDENING');
  assert.equal(read(110, 90, 105, 95).state, 'NARROWING');
  assert.equal(read(110, 90, 110, 95).state, 'MIXED', 'a level pair of highs');
  assert.equal(read(110, 90, 115, 90).state, 'MIXED', 'a level pair of lows');
  assert.deepEqual([read(110, 90, 115, 95).highs, read(110, 90, 115, 95).lows], ['higher', 'higher']);
  assert.equal(structureWords(read(110, 90, 115, 95)), 'Higher highs, higher lows');
  assert.equal(structureWords(read(110, 90, 105, 95)), 'Lower highs, higher lows');
  assert.equal(structureWords(read(110, 90, 110, 85)), 'Equal highs, lower lows');
  /* Where the last close stands against the last swing high and the last swing low. */
  assert.equal(read(110, 90, 115, 95, 116).position, 'above');
  assert.equal(read(110, 90, 115, 95, 94).position, 'below');
  assert.equal(read(110, 90, 115, 95, 115).position, 'inside', 'at the high is not above it');
  const few = structureOf(swings(['high', 110], ['low', 90], ['high', 115]), 100);
  assert.equal(few.state, 'UNKNOWN');
  assert.equal(few.position, null);
  assert.equal(structureWords(few), 'Not enough swings');
  assert.equal(structureOf([], 100).state, 'UNKNOWN');
});

test('structure: a market whose swings spread is widening, one whose swings shrink is narrowing', () => {
  assert.equal(timeframeState(series({ wave: 2, period: 9, grow: 0.003 }), H1).structure.state, 'WIDENING');
  assert.equal(timeframeState(series({ wave: 8, period: 9, grow: -0.0014 }), H1).structure.state, 'NARROWING');
  assert.equal(timeframeState(RISING, H1).structure.state, 'UP');
  assert.equal(timeframeState(FALLING, H1).structure.state, 'DOWN');
});

test('volatility: the ATR of the last candle against the 200 candles before it', () => {
  const closes = new Array(VOL_WINDOW + 1).fill(100);
  /* 200 earlier values 1, 2, ... 200, then the present one. */
  const at = (now) => volatilityOf([...Array.from({ length: VOL_WINDOW }, (_, i) => i + 1), now], closes);
  assert.deepEqual([VOL_QUIET, VOL_HIGH, VOL_EXTREME], [20, 80, 95]);
  assert.equal(at(0.5).rank, 0);
  assert.equal(at(0.5).state, 'QUIET');
  assert.equal(at(40).rank, 19.5, '39 of 200 were smaller');
  assert.equal(at(40).state, 'QUIET');
  assert.equal(at(40.5).rank, 20);
  assert.equal(at(40.5).state, 'NORMAL', 'from 20 in 100 it is normal');
  assert.equal(at(160).state, 'NORMAL');
  assert.equal(at(160.5).rank, 80);
  assert.equal(at(160.5).state, 'HIGH');
  assert.equal(at(190.5).rank, 95);
  assert.equal(at(190.5).state, 'EXTREME');
  assert.equal(at(500).rank, 100);
  assert.equal(at(100.5).ratio, 1, 'the middle value of 1 to 200 is 100.5');
  assert.equal(at(50).atrPct, 50, 'ATR in percent of the last close');
  /* Against its value 14 candles earlier (here 187): more than a tenth apart is rising or falling. */
  assert.equal(at(187 * 1.11).change, 'rising');
  assert.equal(at(187 * 1.09).change, 'steady');
  assert.equal(at(187 * 0.91).change, 'steady');
  assert.equal(at(187 * 0.89).change, 'falling');
  /* Not enough to compare with: no state. */
  assert.equal(volatilityOf(Array.from({ length: VOL_WINDOW }, (_, i) => i + 1), closes), null);
  assert.equal(volatilityOf([null, ...Array.from({ length: VOL_WINDOW - 1 }, (_, i) => i + 1), 5], closes), null);
});

test('volatility: wider candles at the end of a history are extreme, narrower ones quiet', () => {
  /* The wicks of the candles from `from` on are made `factor` times as long. */
  const scaled = (from, factor) => LEVEL.map((candle, i) => (i < from ? candle : { ...candle, high: Math.max(candle.open, candle.close) + (candle.high - Math.max(candle.open, candle.close)) * factor, low: Math.min(candle.open, candle.close) - (Math.min(candle.open, candle.close) - candle.low) * factor }));
  const wide = timeframeState(scaled(588, 12), H1).volatility;
  assert.equal(wide.state, 'EXTREME');
  assert.equal(wide.rank, 100, 'larger than in every one of the 200 candles before');
  assert.equal(wide.change, 'rising', 'the candle 14 back was still an ordinary one');
  assert.ok(wide.ratio > 1.5, 'ATR at ' + wide.ratio.toFixed(1) + ' times the middle value');
  /* Wicks that have been long for 40 candles: still extreme against the 200 before, and no longer rising. */
  const settled = timeframeState(scaled(559, 12), H1).volatility;
  assert.equal(settled.state, 'EXTREME');
  assert.equal(settled.change, 'steady');
  const narrow = timeframeState(scaled(559, 0.01), H1).volatility;
  assert.equal(narrow.state, 'QUIET');
  assert.ok(narrow.rank < 5, 'smaller than in nearly all of the 200 candles before (rank ' + narrow.rank + ')');
  const ordinary = timeframeState(LEVEL, H1).volatility;
  assert.equal(ordinary.state, 'NORMAL');
  assert.equal(ordinary.change, 'steady');
});

/* ---------------------------------------------------------------- nothing is estimated */

test('too few finished candles give no state, with the count and the number needed', () => {
  assert.equal(MIN_FINISHED, 400);
  const short = timeframeState(RISING.slice(-(MIN_FINISHED)), H1);
  assert.equal(short.ok, false);
  assert.equal(short.reason, 'NOT_ENOUGH_CANDLES');
  assert.equal(short.have, MIN_FINISHED - 1, 'the newest of the 400 may still be forming');
  assert.equal(short.need, MIN_FINISHED);
  assert.equal(short.newestStart, RISING[RISING.length - 1].time, 'the feed time is still known');
  assert.equal(short.trend, undefined);
  assert.equal(timeframeState(RISING.slice(-(MIN_FINISHED + 1)), H1).ok, true);
});

test('no candles, unusable rows and candles out of order give no state', () => {
  for (const nothing of [null, undefined, [], 'candles', {}]) {
    const reading = timeframeState(nothing, H1);
    assert.equal(reading.ok, false);
    assert.equal(reading.reason, 'NO_CANDLES');
  }
  const swapped = [...RISING];
  [swapped[300], swapped[301]] = [swapped[301], swapped[300]];
  assert.equal(timeframeState(swapped, H1).reason, 'OUT_OF_ORDER');
  const repeated = [...RISING.slice(0, 301), RISING[300], ...RISING.slice(301)];
  assert.equal(timeframeState(repeated, H1).reason, 'OUT_OF_ORDER', 'the same candle twice');
  for (const reading of [timeframeState(swapped, H1), timeframeState(repeated, H1)]) {
    assert.equal(reading.ok, false);
    assert.equal(reading.label, 'H1');
  }
});

test('rows that are not candles are dropped and counted; what is left decides', () => {
  const bad = [
    { time: BASE - 1, open: NaN, high: 2, low: 1, close: 1.5 },
    { time: BASE - 1, open: 1, high: 2, low: 0, close: 1.5 },
    { time: BASE - 1, open: 1, high: 2, low: -1, close: 1.5 },
    { time: BASE - 1, open: 1, high: 1.2, low: 1, close: 1.5 },   /* the close above the high */
    { time: BASE - 1, open: 1, high: 2, low: 1.2, close: 1.1 },   /* the close below the low */
    { time: 0, open: 1, high: 2, low: 1, close: 1.5 },
    { open: 1, high: 2, low: 1, close: 1.5 },
    null, 'row', 7
  ];
  const cleaned = cleanCandles([...bad, ...RISING]);
  assert.equal(cleaned.dropped, bad.length);
  assert.equal(cleaned.candles.length, RISING.length);
  assert.equal(cleaned.ordered, true);
  const withBad = timeframeState([...bad, ...RISING], H1);
  assert.deepEqual({ ...withBad, dropped: 0 }, timeframeState(RISING, H1));
  assert.equal(withBad.dropped, bad.length);
  /* Times in milliseconds are the same candles. */
  assert.deepEqual(timeframeState(RISING.map((candle) => ({ ...candle, time: candle.time * 1000 })), H1), timeframeState(RISING, H1));
  /* Prices as text, the way a feed may send them. */
  assert.deepEqual(timeframeState(RISING.map((candle) => ({ ...candle, open: String(candle.open), close: String(candle.close) })), H1), timeframeState(RISING, H1));
});

/* ---------------------------------------------------------------- the four timeframes together */

function reading(label, state, extra = {}) {
  const timeframe = STATE_TIMEFRAMES.find((entry) => entry.label === label);
  return state ? { ok: true, label, seconds: timeframe.seconds, trend: { state }, ...extra } : { ok: false, label, seconds: timeframe.seconds, reason: 'FEED', ...extra };
}
const together = (m5, m15, h1, h4) => summarizeStates([reading('M5', m5), reading('M15', m15), reading('H1', h1), reading('H4', h4)]);

test('the four timeframes together: agreement is said, disagreement is named and not resolved', () => {
  assert.deepEqual(STATE_TIMEFRAMES.map((timeframe) => [timeframe.label, timeframe.seconds]), [['M5', 300], ['M15', 900], ['H1', 3600], ['H4', 14400]]);
  const cases = [
    [['UP', 'UP', 'UP', 'UP'], 'ALIGNED_UP', 'All timeframes: uptrend.'],
    [['DOWN', 'DOWN', 'DOWN', 'DOWN'], 'ALIGNED_DOWN', 'All timeframes: downtrend.'],
    [['DOWN', 'DOWN', 'UNCLEAR', 'UP'], 'CONFLICT', 'The timeframes disagree. H4: uptrend. H1: unclear. M15 and M5: downtrend.'],
    [['UP', 'RANGE', 'RANGE', 'DOWN'], 'CONFLICT', 'The timeframes disagree. H4: downtrend. H1 and M15: range. M5: uptrend.'],
    [['DOWN', 'RANGE', 'RANGE', 'UNCLEAR'], 'PARTIAL_DOWN', 'H4: unclear. H1 and M15: range. M5: downtrend.'],
    [['RANGE', 'UP', 'RANGE', 'UP'], 'PARTIAL_UP', 'H4: uptrend. H1: range. M15: uptrend. M5: range.'],
    [['RANGE', 'RANGE', 'RANGE', 'UNCLEAR'], 'NO_TREND', 'No timeframe is in a trend. H4: unclear. H1, M15 and M5: range.'],
    [['RANGE', 'RANGE', 'RANGE', 'RANGE'], 'NO_TREND', 'No timeframe is in a trend. H4, H1, M15 and M5: range.']
  ];
  for (const [states, state, words] of cases) {
    const summary = together(...states);
    assert.equal(summary.state, state, states.join(' '));
    assert.equal(summaryText(summary), words);
  }
  /* The order the readings are handed over in does not matter. */
  assert.equal(summaryText(summarizeStates([reading('H4', 'UNCLEAR'), reading('M5', 'DOWN'), reading('H1', 'RANGE'), reading('M15', 'RANGE')])), 'H4: unclear. H1 and M15: range. M5: downtrend.');
});

test('one timeframe without a state: nothing is said about the whole', () => {
  const summary = together('UP', 'UP', 'UP', null);
  assert.equal(summary.state, 'INCOMPLETE');
  assert.deepEqual(summary.missing, ['H4']);
  assert.equal(summaryText(summary), 'No summary: H4 has no state.');
  assert.equal(summaryText(together('UP', null, 'UP', null)), 'No summary: H4 and M15 have no state.');
  assert.equal(summarizeStates([]).state, 'INCOMPLETE');
  assert.equal(summarizeStates(null).state, 'INCOMPLETE');
  assert.equal(summarizeStates([reading('M5', 'UP'), null]).state, 'INCOMPLETE');
});

test('is the feed current? the newest candle of the shortest timeframe read started less than two candle widths ago', () => {
  const now = BASE + 7 * 3600;
  const at = (label, newestStart, state = 'UP') => reading(label, state, { newestStart });
  const fresh = feedFreshness([at('M5', now - 599), at('H4', now - 9000)], now);
  assert.deepEqual(fresh, { current: true, newestStart: now - 599, ageSec: 599, label: 'M5' });
  assert.equal(feedFreshness([at('M5', now - 600), at('H4', now - 9000)], now).current, false, 'two 5-minute candles without a new one');
  /* The order does not matter, and a timeframe without a state still says how far the feed has come. */
  assert.equal(feedFreshness([at('H4', now - 100), at('M5', now - 700)], now).label, 'M5');
  assert.equal(feedFreshness([at('M5', now - 60, null), at('H1', now - 60)], now).current, true);
  /* Without the 5-minute series the next shortest decides, by its own width. */
  assert.deepEqual(feedFreshness([reading('M5', null), at('M15', now - 1700), at('H1', now - 1700)], now), { current: true, newestStart: now - 1700, ageSec: 1700, label: 'M15' });
  assert.equal(feedFreshness([reading('M5', null), at('M15', now - 1800)], now).current, false);
  /* A market closed for two days. */
  const closed = feedFreshness([at('M5', now - 2 * 86400)], now);
  assert.equal(closed.current, false);
  assert.equal(closed.ageSec, 2 * 86400);
  /* Nothing read, or no clock: not current, and no age is claimed. */
  for (const nothing of [feedFreshness([], now), feedFreshness(null, now), feedFreshness([reading('M5', null)], now), feedFreshness([at('M5', now - 60)], 0)]) {
    assert.deepEqual(nothing, { current: false, newestStart: 0, ageSec: null, label: null });
  }
  assert.equal(feedFreshness([at('M5', now + 120)], now).ageSec, 0, 'a device clock that is behind the feed gives no negative age');
});

/* ---------------------------------------------------------------- what the page is handed */

test('the sketch holds the last 120 candles, their two averages and the swings with their marks', () => {
  for (const candles of [RISING, FALLING, LEVEL]) {
    const state = timeframeState(candles, H1);
    const { sketch, structure } = state;
    assert.equal(sketch.candles.length, SKETCH_CANDLES);
    assert.equal(sketch.ema50.length, SKETCH_CANDLES);
    assert.equal(sketch.ema200.length, SKETCH_CANDLES);
    assert.deepEqual(sketch.candles[SKETCH_CANDLES - 1], candles[candles.length - 2], 'it ends with the last finished candle');
    assert.ok(sketch.swings.length >= 4);
    for (const swing of sketch.swings) {
      assert.ok(swing.index >= 0 && swing.index < SKETCH_CANDLES);
      assert.equal(sketch.candles[swing.index].time, swing.time, 'a swing sits on its own candle');
      assert.equal(swing.price, swing.kind === 'high' ? sketch.candles[swing.index].high : sketch.candles[swing.index].low);
      assert.match(swing.mark, /^(HH|LH|EH|HL|LL|EL|H|L)$/);
    }
    /* The four swings the structure was read from are in the picture. */
    for (const key of ['lastHigh', 'prevHigh', 'lastLow', 'prevLow']) assert.ok(sketch.swings.some((swing) => swing.time === structure[key].time && swing.kind === structure[key].kind), key + ' is drawn');
    const last = sketch.swings.filter((swing) => swing.kind === 'high').pop();
    assert.equal(last.mark, { higher: 'HH', lower: 'LH', equal: 'EH' }[structure.highs]);
  }
});

test('the sketch reaches back to older swings when the structure was read from them, up to 240 candles', () => {
  /* A calm climb without a swing, from candle `from` on: the structure still rests on the swings before it. */
  const calmFrom = (from) => RISING.map((candle, i) => {
    if (i < from) return candle;
    const close = RISING[from - 1].close + (i - from + 1) * 0.5, open = close - 0.5;
    return { time: candle.time, open, high: close + 0.05, low: open - 0.05, close };
  });
  const near = timeframeState(calmFrom(480), H1);
  const oldest = Math.min(near.structure.prevHigh.index, near.structure.prevLow.index);
  const back = near.candles - 1 - oldest;
  assert.ok(back > SKETCH_CANDLES && back < 2 * SKETCH_CANDLES - SWING_SPAN, 'the older swings are ' + back + ' candles back');
  assert.equal(near.sketch.candles.length, near.candles - (oldest - SWING_SPAN), 'the sketch starts five candles before the oldest of them');
  for (const key of ['lastHigh', 'prevHigh', 'lastLow', 'prevLow']) assert.ok(near.sketch.swings.some((swing) => swing.time === near.structure[key].time && swing.kind === near.structure[key].kind), key + ' is drawn');
  assert.equal(near.sketch.ema50.length, near.sketch.candles.length);

  /* Older than that: the sketch stops at 240 candles, and the structure still names its swings with their times. */
  const far = timeframeState(calmFrom(300), H1);
  assert.ok(far.candles - 1 - far.structure.prevHigh.index > 2 * SKETCH_CANDLES);
  assert.equal(far.sketch.candles.length, 2 * SKETCH_CANDLES);
  assert.equal(far.sketch.swings.length, 0);
  assert.ok(far.structure.prevHigh.time > 0 && far.structure.prevLow.time > 0);
  assert.equal(far.structure.position, 'above', 'the climb has left the last swing high behind');
});

test('a moment on the Nairobi clock: the time alone today, with the date on any other day', () => {
  const now = Date.parse('2026-11-13T19:30:00Z') / 1000; /* 22:30 in Nairobi */
  assert.equal(eatMoment(Date.parse('2026-11-13T17:00:00Z') / 1000, now), '20:00');
  assert.equal(eatMoment(Date.parse('2026-11-12T22:00:00Z') / 1000, now), '01:00', '01:00 on the 13th in Nairobi is today there');
  assert.equal(eatMoment(Date.parse('2026-11-12T20:59:00Z') / 1000, now), '12 Nov 23:59');
  assert.equal(eatMoment(Date.parse('2026-10-30T16:00:00Z') / 1000, now), '30 Oct 19:00');
  assert.equal(eatMoment(Date.parse('2026-11-13T17:00:00Z') / 1000), '13 Nov 20:00', 'without a "now" the date is always given');
  assert.equal(eatMoment(0, now), '');
  assert.equal(eatMoment(NaN, now), '');
});

test('the words of every state exist, and none of them is an instruction', () => {
  assert.deepEqual(TREND_WORDS, { UP: 'Uptrend', DOWN: 'Downtrend', RANGE: 'Range', UNCLEAR: 'Unclear' });
  assert.deepEqual(VOLATILITY_WORDS, { QUIET: 'Quiet', NORMAL: 'Normal', HIGH: 'High', EXTREME: 'Extreme', UNKNOWN: 'Unknown' });
  const words = [...Object.values(TREND_WORDS), ...Object.values(VOLATILITY_WORDS), structureWords({ highs: 'higher', lows: 'lower' })].join(' ');
  assert.doesNotMatch(words, /\b(buy|sell|enter|exit|long|short|trade)\b/i);
});

test('the page explains each line with the numbers the code uses', () => {
  const page = readFileSync(join(root, 'index.html'), 'utf8');
  const legend = page.slice(page.indexOf('<div class="card ms-legend">'), page.indexOf('</section>', page.indexOf('<div class="card ms-legend">')));
  assert.ok(legend.includes('ADX 14 at ' + ADX_TREND + ' or more'), 'the trend threshold');
  assert.ok(legend.includes('ADX below ' + ADX_RANGE), 'the range threshold');
  assert.ok(SWING_SPAN === 5 && legend.includes('the five candles before it') && legend.includes('the five after it'), 'the swing span');
  assert.ok(legend.includes('the ' + VOL_WINDOW + ' candles before it'), 'the volatility window');
  assert.ok(legend.includes('fewer than ' + VOL_QUIET + ' in 100') && legend.includes('from ' + VOL_HIGH) && legend.includes('from ' + VOL_EXTREME), 'the volatility thresholds');
  assert.ok(page.includes('It is a description, not a signal:'), 'the view says what it is not');
});

test('the README gives the same thresholds as the code and the page', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const start = readme.indexOf('### Market state: trend, structure and volatility on four timeframes');
  assert.ok(start > 0, 'the README has the section');
  const section = readme.slice(start, readme.indexOf('\n### ', start + 10));
  const flat = section.replace(/\s+/g, ' ');
  assert.ok(flat.includes('ADX 14 at ' + ADX_TREND + ' or more') && flat.includes('ADX below ' + ADX_RANGE), 'trend thresholds');
  assert.ok(SWING_SPAN === 5 && flat.includes('above the five candles before it and is not passed by the five after it'), 'swing span');
  assert.ok(flat.includes('against the ' + VOL_WINDOW + ' candles before it') && flat.includes('fewer than ' + VOL_QUIET + ' in 100') && flat.includes('high from ' + VOL_HIGH) && flat.includes('extreme from ' + VOL_EXTREME), 'volatility thresholds');
  assert.ok(flat.includes(STATE_CANDLES + ' candles per timeframe'), 'candles asked for');
  assert.ok(flat.includes('Fewer than ' + MIN_FINISHED + ' finished candles'), 'candles needed');
  assert.ok(flat.includes('**It is a description, not a signal.**'));
});

test('what the replay measured: the module, the sentence on the page and the README table carry the same figures, and none of them promises anything', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const thousands = (count) => count.toLocaleString('en-US');
  const row = (label, figure) => '| ' + label + ' | ' + thousands(figure.alerts) + ' | ' + figure.percent + '% | ' + figure.needed + '% |';
  for (const [label, key] of [['All alerts', 'all'], ['With the 4-hour trend', 'h4With'], ['Against the 4-hour trend', 'h4Against'], ['With the 1-hour and the 4-hour trend', 'h1h4With'], ['With the trend on all four timeframes', 'allFourWith']]) {
    assert.ok(readme.includes(row(label, STATE_MEASURED[key])), 'README row: ' + row(label, STATE_MEASURED[key]));
  }
  assert.ok(readme.includes('Needed after a $' + STATE_MEASURED.spread.toFixed(2) + ' spread'), 'the spread of the table');

  /* The sentence under the heading of the view: the two 4-hour groups, what is needed, and that both lost. */
  const with4 = STATE_MEASURED.h4With, against4 = STATE_MEASURED.h4Against;
  assert.equal(STATE_MEASURED_TEXT, 'Measured in a replay on gold (Jan 2020 \u2013 Nov 2026): of the alerts of the 1m/5m/1h rule, '
    + with4.percent + '% of the ' + thousands(with4.alerts) + ' that pointed with the 4-hour trend reached target 1 before the stop, and '
    + against4.percent + '% of the ' + thousands(against4.alerts) + ' that pointed against it. About ' + Math.round(with4.needed)
    + '% is needed to break even after a spread of $0.25, so both groups lost. Not a forecast.');
  /* "Both groups lost" is said only while it is what the figures say. */
  assert.ok(with4.percent < with4.needed && against4.percent < against4.needed);
  assert.ok(Math.round(with4.needed) >= Math.round(against4.needed), 'the share named as needed is not the lower of the two');
  assert.doesNotMatch(STATE_MEASURED_TEXT, /\b(profit|guarantee|probab|will|should|edge|win rate)\b/i);

  /* The page shows it where its heading says what the view is not. */
  const page = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(page, /<b>It is a description, not a signal:<\/b>[^<]*<span id="msMeasured"><\/span>/);
});

test('nothing that makes a signal, an alert or an order reads the market state', () => {
  /* The page says so under its heading ("the Buy, Sell and Wait of the signal pages are computed without it"),
     and this is what keeps the sentence true. Only two files of the application import the module: the page's
     own script, for this view, and the replay script that measures it. */
  const importers = [];
  for (const folder of ['src', 'server', 'server/lib', 'cloudflare', 'scripts', 'bridge']) {
    for (const name of readdirSync(join(root, folder))) {
      if (!/\.(js|mjs|py)$/.test(name)) continue;
      if (/from\s+['"][^'"]*marketstate\.js['"]/.test(readFileSync(join(root, folder, name), 'utf8'))) importers.push(folder + '/' + name);
    }
  }
  assert.deepEqual(importers.sort(), ['scripts/state-replay.mjs', 'src/main.js']);

  /* In the page's script, what is imported from the module is used inside the view's own block and nowhere else... */
  const page = readFileSync(join(root, 'src', 'main.js'), 'utf8');
  const importLine = /^import \{ ([^}]+) \} from '\.\/marketstate\.js';$/m.exec(page);
  assert.ok(importLine, 'the import of the module, on one line');
  const names = importLine[1].split(',').map((name) => name.trim());
  assert.ok(names.includes('timeframeState') && names.includes('summarizeStates'), 'the import was understood');
  const from = page.indexOf('   MARKET STATE: trend, structure and volatility on four timeframes.'), to = page.indexOf('\nfunction render(view){');
  assert.ok(from > 0 && to > from, 'the block of the view was found');
  const outside = (page.slice(0, from) + page.slice(to)).replace(importLine[0], '');
  for (const name of names) assert.ok(!new RegExp('\\b' + name + '\\b').test(outside), name + ' is used outside the Market state block');

  /* ...and of that block, the rest of the script calls two functions: open the view, and its once-a-second tick. */
  const block = page.slice(from, to);
  const declared = [...block.matchAll(/^(?:async )?function (ms[A-Z]\w*)\(|^const (ms[A-Z]\w*|MS_[A-Z_]+)=/gm)].map((match) => match[1] || match[2]);
  assert.ok(declared.includes('msLoad') && declared.includes('msView') && declared.includes('msTick'), 'the block was understood: ' + declared.join(', '));
  const usedOutside = declared.filter((name) => new RegExp('\\b' + name + '\\b').test(outside));
  assert.deepEqual(usedOutside.sort(), ['msInit', 'msTick']);

  /* The block itself places no order, raises no alert and starts no scan: none of the script's functions for those is called in it. */
  const acting = ['placeOrder', 'notify', 'saveAlert', 'saveSignal', 'scanSignals', 'scanSignalsPreferred', 'apiSignalScan', 'emitSignalAlerts', 'emitSniperSignalAlerts', 'mktScanRefresh', 'derivWsBuy', 'derivConfirm'];
  for (const name of acting) {
    assert.ok(new RegExp('\\b' + name + '\\(').test(outside), name + '() exists in the script (this list is current)');
    assert.ok(!new RegExp('\\b' + name + '\\b').test(block), name + ' is used in the Market state block');
  }
  assert.doesNotMatch(block, /\bbridge(Mod)?\./, 'the block does not talk to the Exness bridge');
});
