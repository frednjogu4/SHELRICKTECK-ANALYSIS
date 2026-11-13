/*
 * The replay behind the measured figures of the Market state view
 * (scripts/state-replay.mjs).
 *
 * The price paths here are written by the test: a seeded random walk, not a
 * market. What is checked is the bookkeeping: that a state of the replay is
 * the state the page would have shown at that close, that an alert is matched
 * with states that existed when it was made and with nothing later, and how
 * the rows of a table are counted. Nothing is read from disk or from the
 * network, and no assertion says what the states mean for a trade.
 *
 * The figures in the README come from a run of this script over a price
 * archive that is not in the repository. These tests cannot show that those
 * figures are right; they show that the counting behind them does what the
 * README says it does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { candlesFrom, statesOver, stateAt, relation, shares, runLengths, measure, VARIANTS } from '../../scripts/state-replay.mjs';
import { STATE_TIMEFRAMES, STATE_CANDLES, ADX_TREND, ADX_RANGE, timeframeState } from '../../src/marketstate.js';

const START = Date.UTC(2026, 10, 9, 0, 0) / 1000; /* a Monday, 00:00 UTC */
const M5 = STATE_TIMEFRAMES.find((timeframe) => timeframe.key === 'm5');
const M15 = STATE_TIMEFRAMES.find((timeframe) => timeframe.key === 'm15');

/* A repeatable path of 1-minute bars: `seed` picks the path. */
function walk(count, { seed = 7, from = 100, start = START } = {}) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const bars = [];
  let price = from;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = open * (1 + (random() - 0.5) * 0.0016 + 0.0004 * Math.sin(i / 180));
    const high = Math.max(open, close) * (1 + random() * 0.0003), low = Math.min(open, close) * (1 - random() * 0.0003);
    bars.push({ time: start + i * 60, open, high, low, close });
    price = close;
  }
  return bars;
}

test('candles from 1-minute bars: first open, highest high, lowest low, last close; no candle where there is no bar', () => {
  const bar = (minute, open, high, low, close) => ({ time: START + minute * 60, open, high, low, close });
  const candles = candlesFrom([bar(0, 10, 12, 9, 11), bar(1, 11, 15, 10, 14), bar(4, 14, 14.5, 8, 9), bar(5, 9, 9.5, 8.5, 9.2), /* 10 to 14: no bar */ bar(17, 9.2, 9.9, 9.1, 9.7)], 300);
  assert.deepEqual(candles, [
    { time: START, open: 10, high: 15, low: 8, close: 9 },
    { time: START + 300, open: 9, high: 9.5, low: 8.5, close: 9.2 },
    { time: START + 900, open: 9.2, high: 9.9, low: 9.1, close: 9.7 }
  ]);
});

test('a state of the replay is the state the page shows at that close: the last 599 finished candles, and nothing after them', () => {
  const candles = candlesFrom(walk(660 * 5), 300);
  assert.equal(candles.length, 660);
  const states = statesOver(candles, M5);
  /* The first state belongs to the close of the 599th candle; from there on every close has one. */
  assert.equal(states.length, candles.length - (STATE_CANDLES - 2));
  assert.equal(states[0].end, candles[STATE_CANDLES - 2].time + 300);
  for (const [index, state] of states.entries()) {
    const last = STATE_CANDLES - 2 + index;
    assert.equal(state.end, candles[last].time + 300);
    /* What the page computes from a feed whose newest candle is the one forming after that close. */
    const forming = { time: candles[last].time + 300, open: 1, high: 2, low: 0.5, close: 1.5 };
    const page = timeframeState([...candles.slice(last - (STATE_CANDLES - 2), last + 1), forming], M5);
    assert.equal(page.ok, true);
    assert.equal(page.asOf, state.end);
    assert.deepEqual([state.trend, state.structure, state.volatility], [page.trend.state, page.structure.state, page.volatility.state], 'at candle ' + last);
  }
  /* No later candle changes an earlier state: the states of a shorter history are the first states of the longer one. */
  assert.deepEqual(statesOver(candles.slice(0, 630), M5), states.slice(0, 630 - (STATE_CANDLES - 2)));
  /* Fewer candles than the page asks for: no state at all. */
  assert.deepEqual(statesOver(candles.slice(0, STATE_CANDLES - 2), M5), []);
});

test('the thresholds tried beside the page\'s: the first variant is the page\'s own and gives the page\'s state', () => {
  assert.deepEqual(VARIANTS[0], ['ADX 25 / 20 (the page)', { adxTrend: ADX_TREND, adxRange: ADX_RANGE }]);
  const states = statesOver(candlesFrom(walk(640 * 5, { seed: 11 }), 300), M5);
  assert.ok(states.length > 30);
  for (const state of states) assert.equal(state.variants[0], state.trend);
});

test('the state an alert is matched with: the newest one whose close is not later, and none before the first', () => {
  const states = [{ end: 1000, trend: 'UP' }, { end: 1300, trend: 'RANGE' }, { end: 1600, trend: 'DOWN' }];
  assert.equal(stateAt(states, 999), null);
  assert.equal(stateAt(states, 1000).trend, 'UP');
  assert.equal(stateAt(states, 1299).trend, 'UP');
  assert.equal(stateAt(states, 1300).trend, 'RANGE');
  assert.equal(stateAt(states, 5000).trend, 'DOWN');
  assert.equal(stateAt([], 5000), null);
});

test('with and against: a BUY in an uptrend or a SELL in a downtrend is with the trend; the other states keep their names', () => {
  assert.equal(relation('BUY', 'UP'), 'with');
  assert.equal(relation('SELL', 'UP'), 'against');
  assert.equal(relation('SELL', 'DOWN'), 'with');
  assert.equal(relation('BUY', 'DOWN'), 'against');
  assert.equal(relation('BUY', 'RANGE'), 'range');
  assert.equal(relation('SELL', 'UNCLEAR'), 'unclear');
  assert.equal(relation('BUY', 'WIDENING'), 'widening');
});

test('shares and runs: percent of all states, and for how many candles in a row a state lasts', () => {
  const states = ['UP', 'UP', 'UP', 'RANGE', 'UP', 'DOWN', 'DOWN', 'RANGE', 'RANGE', 'RANGE'].map((trend) => ({ trend }));
  assert.deepEqual(shares(states, (state) => state.trend), { DOWN: 20, RANGE: 40, UP: 40 });
  assert.deepEqual(runLengths(states, (state) => state.trend), {
    DOWN: { runs: 1, medianCandles: 2, meanCandles: 2 },
    RANGE: { runs: 2, medianCandles: 3, meanCandles: 2 },
    UP: { runs: 2, medianCandles: 3, meanCandles: 2 }
  });
});

test('every alert is matched with states that existed when it was made: as of its 5-minute close or earlier, computed from candles before it', () => {
  /* Two timeframes are enough to check the matching, and keep the path short: 599 candles of 15 minutes and some days more. */
  const bars = walk(13200, { seed: 5 });
  const timeframes = [M5, M15];
  const matches = [];
  const result = measure(bars, { symbol: 'XAU/USD', spread: 0.25, timeframes, onMatch: (match) => matches.push(match) });

  assert.ok(result.rule.alerts > 20, 'the path gives alerts: ' + result.rule.alerts);
  assert.equal(result.rule.matched + result.rule.unmatched, result.rule.alerts);
  assert.equal(matches.length, result.rule.matched);
  assert.ok(result.rule.matched > 10 && result.rule.unmatched > 10, 'alerts before and after the first 15-minute state: ' + result.rule.unmatched + ' / ' + result.rule.matched);

  const candles = Object.fromEntries(timeframes.map((timeframe) => [timeframe.key, candlesFrom(bars, timeframe.seconds)]));
  for (const match of matches) {
    /* The alert is made on the first bar after a 5-minute close; that close is what it is matched by. */
    assert.equal(match.close, Math.floor(match.time / 300) * 300);
    assert.ok(match.close <= match.time);
    for (const timeframe of timeframes) {
      const state = match.states[timeframe.key];
      assert.ok(state.end <= match.close, timeframe.label + ': the state is as of a close that had happened');
      assert.ok(match.close - state.end < timeframe.seconds, timeframe.label + ': and the newest such close');
      /* The same state from nothing but the candles that had finished by then. */
      const finished = candles[timeframe.key].filter((candle) => candle.time + timeframe.seconds <= match.close);
      assert.ok(finished.length >= STATE_CANDLES - 1);
      const forming = { time: finished[finished.length - 1].time + timeframe.seconds, open: 1, high: 1, low: 1, close: 1 };
      const page = timeframeState([...finished.slice(-(STATE_CANDLES - 1)), forming], timeframe);
      assert.deepEqual([state.trend, state.structure, state.volatility], [page.trend.state, page.structure.state, page.volatility.state], timeframe.label + ' at ' + match.close);
    }
  }
  /* An alert before the first 15-minute state is left out of every row, not put into one with half its states. */
  const first15 = candles.m15[STATE_CANDLES - 2].time + 900;
  assert.ok(matches.every((match) => match.close >= first15));

  /* Every matched alert is in exactly one row per timeframe, and in "all alerts". */
  for (const table of [result.alertsByTrend, result.alertsByStructure, result.alertsByVolatility]) {
    assert.deepEqual(Object.keys(table), ['M5', 'M15']);
    for (const rows of Object.values(table)) assert.equal(Object.values(rows).reduce((sum, row) => sum + row.alerts, 0), result.rule.matched);
  }
  assert.equal(result.alertsCombined['all alerts'].alerts, result.rule.matched);
  /* The groups about the 1-hour and the 4-hour trend, and about all four timeframes, need those timeframes. */
  assert.deepEqual(Object.keys(result.alertsCombined).sort(), ['all alerts', 'no timeframe against the alert']);
});

test('a row of a table: the share that reached target 1 first, what is needed after the spread, and the result per alert', () => {
  const bars = walk(13200, { seed: 5 });
  const matches = [];
  const free = measure(bars, { symbol: 'XAU/USD', timeframes: [M5, M15], onMatch: (match) => matches.push(match) });
  const paid = measure(bars, { symbol: 'XAU/USD', timeframes: [M5, M15], spread: 0.25 });
  const row = free.alertsCombined['all alerts'], rowPaid = paid.alertsCombined['all alerts'];
  /* The outcomes of the alerts themselves give the share. */
  const target = matches.filter((match) => match.outcome === 'target').length, stop = matches.filter((match) => match.outcome === 'stop').length;
  assert.ok(target > 0 && stop > 0);
  assert.deepEqual([row.alerts, row.target, row.stop], [matches.length, target, stop]);
  assert.equal(row.targetFirstPercent, Math.round((target / (target + stop)) * 1000) / 10);
  /* For every single alert a win pays 1.5 times what a loss costs, which is 40% to break even before the spread. */
  for (const match of matches) assert.ok(Math.abs(Math.abs(match.target - match.entry) / Math.abs(match.entry - match.stop) - 1.5) < 1e-9);
  /* For a row it is taken from the average win of its winners and the average loss of its losers, which need not be
     alerts of the same size: here they are not, and the row's figure is not 40. The spread comes on top. */
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const win = mean(matches.filter((match) => match.outcome === 'target').map((match) => Math.abs(match.target - match.entry)));
  const loss = mean(matches.filter((match) => match.outcome === 'stop').map((match) => Math.abs(match.entry - match.stop)));
  assert.equal(row.breakEvenPercent, Math.round((loss / (win + loss)) * 1000) / 10);
  assert.equal(rowPaid.breakEvenPercent, Math.round(((loss + 0.25) / (win + loss)) * 1000) / 10);
  assert.ok(rowPaid.breakEvenPercent > row.breakEvenPercent);
  /* At exactly that share the row's result after the spread is nil: share x (win - spread) = (1 - share) x (loss + spread). */
  const share = (loss + 0.25) / (win + loss);
  assert.ok(Math.abs(share * (win - 0.25) - (1 - share) * (loss + 0.25)) < 1e-9);
  /* The spread changes no outcome. It comes off every finished alert. */
  assert.deepEqual([rowPaid.alerts, rowPaid.target, rowPaid.stop, rowPaid.targetFirstPercent], [row.alerts, row.target, row.stop, row.targetFirstPercent]);
  assert.equal(rowPaid.perAlert, row.perAlert);
  assert.ok(Math.abs(rowPaid.perAlertAfterSpread - (row.perAlert - 0.25)) < 0.0011);
  assert.equal(row.perAlertAfterSpread, row.perAlert);
});

test('without the alerts: the shares of each state, which add up to all of them', () => {
  const result = measure(walk(660 * 5, { seed: 3 }), { symbol: 'XAU/USD', alerts: false, timeframes: [M5] });
  assert.deepEqual(Object.keys(result), ['symbol', 'timeframes']);
  const m5 = result.timeframes.M5;
  assert.equal(m5.candles, 660);
  assert.equal(m5.states, 660 - (STATE_CANDLES - 2));
  for (const part of [m5.trend, m5.structure, m5.volatility]) {
    const total = Object.values(part).reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(total - 100) < 0.31, 'shares add up: ' + JSON.stringify(part));
  }
  assert.deepEqual(Object.keys(m5.variants), VARIANTS.map(([name]) => name));
  assert.deepEqual(m5.variants[VARIANTS[0][0]].shares, m5.trend);
});
