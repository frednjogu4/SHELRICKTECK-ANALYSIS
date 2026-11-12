/*
 * Live confidence (src/signalrun.js): the score of a BUY/SELL reading, moved
 * by how far the price has gone toward the stop or toward target 1 since the
 * reading was first made.
 *
 * Every reading here is written by the test: entry, stop, target and score are
 * plain numbers chosen so the arithmetic can be checked by hand. Nothing is a
 * market price, nothing reaches the network, and no assertion says what an
 * analysis would conclude about a market.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGAINST_POINTS, WITH_POINTS, SCORE_MIN, SCORE_MAX, moveUnit, formatMove, liveConfidence, createSignalTracker, describeLive } from '../../src/signalrun.js';

/* A BUY read at 1.0850 with a 12-pip stop and an 18-pip target, scored 70. */
const BUY = { symbol: 'EUR/USD', signal: 'BUY', entry: 1.0850, stop_loss: 1.0838, tp1: 1.0868, confidence: 70 };
/* The mirror image: a SELL read at 1.0850. */
const SELL = { symbol: 'EUR/USD', signal: 'SELL', entry: 1.0850, stop_loss: 1.0862, tp1: 1.0832, confidence: 70 };
const run = (reading) => ({ ...reading, base: reading.confidence });

test('the two step sizes are the documented ones', () => {
  assert.equal(AGAINST_POINTS, 30);
  assert.equal(WITH_POINTS, 15);
  assert.equal(SCORE_MIN, 5);
  assert.equal(SCORE_MAX, 93);
});

test('moves are quoted in pips for currency pairs, dollars for gold, points for the rest', () => {
  assert.deepEqual(moveUnit('EUR/USD'), { kind: 'pips', size: 0.0001 });
  assert.deepEqual(moveUnit('usd/jpy'), { kind: 'pips', size: 0.01 });
  assert.deepEqual(moveUnit('GBP/JPY'), { kind: 'pips', size: 0.01 });
  assert.deepEqual(moveUnit('XAU/USD'), { kind: 'usd', size: 1 });
  assert.deepEqual(moveUnit('BTC/USD'), { kind: 'usd', size: 1 });
  assert.deepEqual(moveUnit('US30'), { kind: 'points', size: 1 });
  assert.deepEqual(moveUnit('VOL 75'), { kind: 'points', size: 1 });
  assert.deepEqual(moveUnit(''), { kind: 'points', size: 1 });
  assert.deepEqual(moveUnit(null), { kind: 'points', size: 1 });

  assert.equal(formatMove('EUR/USD', 0.00063), '6.3 pips');
  assert.equal(formatMove('EUR/USD', -0.00063), '6.3 pips', 'a distance has no sign');
  assert.equal(formatMove('USD/JPY', 0.125), '12.5 pips');
  assert.equal(formatMove('XAU/USD', 2.789), '$2.79');
  assert.equal(formatMove('US30', 103.4), '103.40 points');
  assert.equal(formatMove('EUR/USD', undefined), '0.0 pips');
});

test('at the entry the score is the reading\'s own', () => {
  const live = liveConfidence(run(BUY), 1.0850);
  assert.deepEqual(live, { ok: true, base: 70, confidence: 70, state: 'flat', move: 0, share: 0 });
});

test('a move toward the stop takes points off in proportion: 30 by the stop', () => {
  const half = liveConfidence(run(BUY), 1.0844);
  assert.equal(half.state, 'against');
  assert.equal(half.confidence, 55, 'half the stop distance costs 15 of the 30 points');
  assert.ok(Math.abs(half.share - 0.5) < 1e-9);
  assert.ok(half.move < 0, 'a move against the reading is negative');

  assert.equal(liveConfidence(run(BUY), 1.0846).confidence, 60, 'a third of the way: 10 points');
  const stopped = liveConfidence(run(BUY), 1.0837);
  assert.equal(stopped.state, 'stop');
  assert.equal(stopped.confidence, 40);
  assert.equal(stopped.share, 1);
  assert.equal(liveConfidence(run(BUY), 1.0700).confidence, 40, 'far beyond the stop it does not fall further');
});

test('a move toward target 1 adds points in proportion: 15 by the target', () => {
  const third = liveConfidence(run(BUY), 1.0856);
  assert.equal(third.state, 'with');
  assert.equal(third.confidence, 75, 'a third of the target distance adds 5 of the 15 points');
  assert.ok(third.move > 0);
  const reached = liveConfidence(run(BUY), 1.0869);
  assert.equal(reached.state, 'target');
  assert.equal(reached.confidence, 85);
  assert.equal(liveConfidence(run(BUY), 1.2000).confidence, 85, 'beyond the target it does not rise further');
});

test('a SELL is the mirror image: a falling price is with it, a rising one against it', () => {
  assert.equal(liveConfidence(run(SELL), 1.0844).state, 'with');
  assert.equal(liveConfidence(run(SELL), 1.0844).confidence, 75);
  assert.equal(liveConfidence(run(SELL), 1.0856).state, 'against');
  assert.equal(liveConfidence(run(SELL), 1.0856).confidence, 55);
  assert.equal(liveConfidence(run(SELL), 1.0863).state, 'stop');
  assert.equal(liveConfidence(run(SELL), 1.0831).state, 'target');
});

test('the score stays on the app\'s scale', () => {
  assert.equal(liveConfidence({ ...run(BUY), base: 90 }, 1.0869).confidence, SCORE_MAX, '90 + 15 is capped at 93');
  assert.equal(liveConfidence({ ...run(BUY), base: 20 }, 1.0837).confidence, SCORE_MIN, '20 - 30 stops at 5');
  assert.equal(liveConfidence({ ...run(BUY), base: 'not a number' }, 1.0850).confidence, SCORE_MIN);
});

test('without a live price, or without usable levels, the reading\'s score is left alone', () => {
  for (const price of [null, undefined, 0, -1, NaN, Infinity, 'x']) {
    const live = liveConfidence(run(BUY), price);
    assert.deepEqual(live, { ok: false, base: 70, confidence: 70, state: 'none', move: 0, share: 0 }, String(price));
  }
  const noLevels = { symbol: 'US30', signal: 'BUY', entry: null, stop_loss: null, tp1: null, base: 82 };
  assert.equal(liveConfidence(noLevels, 52000).state, 'none');
  assert.equal(liveConfidence(noLevels, 52000).confidence, 82);
  /* A stop on the wrong side of the entry is not a level to measure against. */
  assert.equal(liveConfidence({ ...run(BUY), stop_loss: 1.0860 }, 1.0850).state, 'none');
  assert.equal(liveConfidence({ ...run(BUY), tp1: 1.0840 }, 1.0850).state, 'none');
  assert.equal(liveConfidence({ ...run(BUY), signal: 'WAIT' }, 1.0850).state, 'none');
  assert.equal(liveConfidence(null, 1.0850).state, 'none');
});

test('tracker: a run starts at the first BUY/SELL and keeps that entry while later readings repeat the direction', () => {
  let clock = 1000;
  const tracker = createSignalTracker({ now: () => clock });
  assert.equal(tracker.read('EUR/USD', 1.0850), null, 'nothing to follow before a reading');

  tracker.observe(BUY);
  clock = 61000;
  /* One minute later the analysis repeats BUY from a new price, with new levels and a new score. */
  tracker.observe({ ...BUY, entry: 1.0856, stop_loss: 1.0844, tp1: 1.0874, confidence: 74, price: 1.0856 });
  const live = tracker.read('EUR/USD', 1.0856);
  assert.equal(live.entry, 1.0850, 'measured from the first reading\'s entry');
  assert.equal(live.stop_loss, 1.0838);
  assert.equal(live.startedAt, 1000);
  assert.equal(live.base, 74, 'the newer score is the one that is moved');
  assert.equal(live.confidence, 79);
  assert.equal(live.signal, 'BUY');
  assert.equal(live.symbol, 'EUR/USD');
  assert.equal(tracker.size, 1);
});

test('tracker: a flip starts a new run; WAIT, an error or a reading without levels ends it', () => {
  let clock = 1000;
  const tracker = createSignalTracker({ now: () => clock });
  tracker.observe(BUY);
  clock = 2000;
  tracker.observe(SELL);
  assert.equal(tracker.read('EUR/USD', 1.0850).signal, 'SELL');
  assert.equal(tracker.read('EUR/USD', 1.0850).startedAt, 2000);

  tracker.observe({ symbol: 'EUR/USD', signal: 'WAIT', confidence: 40, entry: 1.0850, stop_loss: 1.0840, tp1: 1.0860 });
  assert.equal(tracker.read('EUR/USD', 1.0850), null, 'WAIT is not followed');

  tracker.observe(BUY);
  tracker.observe({ symbol: 'EUR/USD', error: 'FEED_ERROR' });
  assert.equal(tracker.read('EUR/USD', 1.0850), null, 'a failed reading ends the run');

  tracker.observe({ symbol: 'US30', signal: 'BUY', confidence: 82, entry: null, stop_loss: null, tp1: null });
  assert.equal(tracker.read('US30', 52000), null, 'a daily index reading has no levels to follow');

  assert.equal(tracker.observe(null), null);
  assert.equal(tracker.observe({ signal: 'BUY' }), null, 'no market name, no run');
  tracker.observe(BUY);
  tracker.forget('EUR/USD');
  assert.equal(tracker.read('EUR/USD', 1.0850), null);
  assert.equal(tracker.size, 0);
});

test('tracker: once the stop is reached the run is over, and stays over until a new reading starts another', () => {
  let clock = 1000;
  const tracker = createSignalTracker({ now: () => clock });
  tracker.observe(BUY);
  clock = 5000;
  const stopped = tracker.read('EUR/USD', 1.0836);
  assert.equal(stopped.state, 'stop');
  assert.equal(stopped.endedAt, 5000);
  assert.equal(stopped.confidence, 40);

  clock = 9000;
  const later = tracker.read('EUR/USD', 1.0866);
  assert.equal(later.state, 'stop', 'a price that comes back does not revive the reading');
  assert.equal(later.endedAt, 5000);
  assert.equal(later.confidence, 40);

  /* The next analysis still says BUY: that is a new reading, followed from its own entry. */
  clock = 60000;
  tracker.observe({ ...BUY, entry: 1.0866, stop_loss: 1.0854, tp1: 1.0884, confidence: 66 });
  const fresh = tracker.read('EUR/USD', 1.0866);
  assert.equal(fresh.state, 'flat');
  assert.equal(fresh.entry, 1.0866);
  assert.equal(fresh.startedAt, 60000);
  assert.equal(fresh.confidence, 66);
  assert.equal(fresh.endedAt, 0);
});

test('tracker: target 1 ends a run the same way', () => {
  let clock = 1000;
  const tracker = createSignalTracker({ now: () => clock });
  tracker.observe(SELL);
  clock = 4000;
  assert.equal(tracker.read('EUR/USD', 1.0830).state, 'target');
  assert.equal(tracker.read('EUR/USD', 1.0850).state, 'target');
  assert.equal(tracker.read('EUR/USD', 1.0850).confidence, 85);
  assert.equal(tracker.read('EUR/USD', 1.0850).endedAt, 4000);
});

test('tracker: an analysis whose own price is already past the stop starts a new run, even if no tick showed the crossing', () => {
  let clock = 1000;
  const tracker = createSignalTracker({ now: () => clock });
  tracker.observe(BUY);
  clock = 70000;
  tracker.observe({ ...BUY, entry: 1.0830, stop_loss: 1.0818, tp1: 1.0848, confidence: 61, price: 1.0830 });
  const live = tracker.read('EUR/USD', 1.0830);
  assert.equal(live.entry, 1.0830, 'the old run ended at its stop; this is a new one');
  assert.equal(live.startedAt, 70000);
  assert.equal(live.state, 'flat');
});

test('tracker: a second key follows the same market from another source', () => {
  const tracker = createSignalTracker({ now: () => 1 });
  tracker.observe(BUY, 'monitor');
  assert.equal(tracker.read('EUR/USD', 1.0850), null);
  assert.equal(tracker.read('monitor', 1.0856).confidence, 75);
  assert.equal(tracker.read('monitor', 1.0856).symbol, 'EUR/USD', 'the unit still comes from the market');
});

test('without a live price the tracker reports the score as read', () => {
  const tracker = createSignalTracker({ now: () => 1 });
  tracker.observe(BUY);
  const live = tracker.read('EUR/USD', null);
  assert.equal(live.state, 'none');
  assert.equal(live.confidence, 70);
  assert.equal(live.ok, false);
});

test('the sentence: direction, distance, share of the way, and where the reading started', () => {
  const at = Date.UTC(2026, 10, 12, 14, 5);
  let clock = at;
  const tracker = createSignalTracker({ now: () => clock });
  tracker.observe(BUY);
  const format = { price: (value) => value.toFixed(5) };

  assert.equal(describeLive(tracker.read('EUR/USD', 1.0850), format), 'No move yet \u00b7 first read at 1.08500, 14:05');
  assert.equal(describeLive(tracker.read('EUR/USD', 1.0856), format),
    '6.0 pips with this BUY \u00b7 33% of the way to target 1 \u00b7 first read at 1.08500, 14:05 \u00b7 score as read 70%');
  assert.equal(describeLive(tracker.read('EUR/USD', 1.0844), format),
    '6.0 pips against this BUY \u00b7 50% of the way to the stop \u00b7 first read at 1.08500, 14:05 \u00b7 score as read 70%');
  assert.equal(describeLive(tracker.read('EUR/USD', null), format), 'No live price right now \u00b7 first read at 1.08500, 14:05');

  assert.equal(describeLive(tracker.read('EUR/USD', 1.0856), { short: true }), '6.0 pips with');
  assert.equal(describeLive(tracker.read('EUR/USD', 1.0844), { short: true }), '6.0 pips against');
  assert.equal(describeLive(tracker.read('EUR/USD', 1.0850), { short: true }), 'no move yet');
  assert.equal(describeLive(tracker.read('EUR/USD', null), { short: true }), '');

  clock = at + 7 * 60000;
  assert.equal(describeLive(tracker.read('EUR/USD', 1.0836), format),
    'Stop level reached at 14:12 \u00b7 this BUY reading (first read at 1.08500, 14:05) is over \u00b7 score as read 70%');
  assert.equal(describeLive(tracker.read('EUR/USD', 1.0836), { short: true }), 'stop reached');

  const sells = createSignalTracker({ now: () => clock });
  sells.observe(SELL);
  clock = at + 9 * 60000;
  assert.equal(describeLive(sells.read('EUR/USD', 1.0830), format),
    'Target 1 reached at 14:14 \u00b7 this SELL reading (first read at 1.08500, 14:12) has run its course \u00b7 score as read 70%');
  assert.equal(describeLive(sells.read('EUR/USD', 1.0830), { short: true }), 'target 1 reached');

  assert.equal(describeLive(null), '');
});

test('the sentence gives gold in dollars and an index in points', () => {
  const tracker = createSignalTracker({ now: () => Date.UTC(2026, 10, 12, 14, 9) });
  tracker.observe({ symbol: 'XAU/USD', signal: 'SELL', entry: 3886.08, stop_loss: 3901.57, tp1: 3862.84, confidence: 71 });
  const gold = tracker.read('XAU/USD', 3883.29);
  assert.equal(gold.confidence, 73);
  assert.equal(describeLive(gold, { price: (value) => value.toFixed(2) }),
    '$2.79 with this SELL \u00b7 12% of the way to target 1 \u00b7 first read at 3886.08, 14:09 \u00b7 score as read 71%');

  tracker.observe({ symbol: 'VOL 75', signal: 'BUY', entry: 1000, stop_loss: 990, tp1: 1015, confidence: 60 });
  assert.equal(describeLive(tracker.read('VOL 75', 995), { short: true }), '5.00 points against');
});
