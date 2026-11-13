/*
 * One reading per finished 5-minute candle (src/closedcandles.js).
 *
 * Every candle here is written by the test. The prices are plain numbers that
 * mean nothing; what is checked is which candles go into a reading, and that
 * the same candles go in whenever the reading is made before the next
 * 5-minute close. Nothing reaches the network, and no assertion says what an
 * analysis would conclude: where the rule is run, two of its answers are
 * compared with each other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { READING_PERIOD_SEC, READING_CANDLES, READING_SETTLE_MS, READING_CURRENT_SEC, lastCloseOf, closedCandleSets, nextReadingCheck } from '../../src/closedcandles.js';
import { runDeterministicAnalysis } from '../../server/lib/analyzer.js';
import { localDecision } from '../../server/lib/localdecision.js';

/* 14:35:00 UTC on 12 November 2026: a 5-minute close that is not on the hour. */
const CLOSE = Date.UTC(2026, 10, 12, 14, 35) / 1000;
const PERIOD = { m1: 60, m5: 300, h1: 3600 };

/* A market whose price is a function of time, so that a candle has the same content whenever it is asked for. */
const priceAt = (t) => 100 + 3 * Math.sin(t / 1700) + 0.4 * Math.sin(t / 130);
/* The newest `count` candles a feed holds at `now`: the last one is still forming and ends at the price of `now`. */
function held(period, now, count = 120) {
  const newest = Math.floor(now / period) * period;
  return Array.from({ length: count }, (_unused, i) => {
    const start = newest - (count - 1 - i) * period, end = Math.min(start + period, now);
    const open = priceAt(start), close = priceAt(end), middle = priceAt((start + end) / 2);
    return { time: start, open, high: Math.max(open, close, middle), low: Math.min(open, close, middle), close };
  });
}
const feedAt = (now) => ({ m1: held(60, now), m5: held(300, now), h1: held(3600, now) });
const times = (candles) => candles.map((candle) => candle.time);

test('the constants are the documented ones', () => {
  assert.equal(READING_PERIOD_SEC, 300);
  assert.equal(READING_CANDLES, 110);
  assert.equal(READING_SETTLE_MS, 5000);
  assert.equal(READING_CURRENT_SEC, 600, 'two 5-minute candles');
});

test('the last 5-minute close is read from the candles, not from a clock', () => {
  assert.equal(lastCloseOf(feedAt(CLOSE + 5)), CLOSE, 'five seconds after the close');
  assert.equal(lastCloseOf(feedAt(CLOSE + 299)), CLOSE, 'a second before the next one');
  assert.equal(lastCloseOf(feedAt(CLOSE + 300)), CLOSE + 300);
  assert.equal(lastCloseOf(feedAt(CLOSE - 1)), CLOSE - 300, 'the 14:34 candle is still forming: 14:35 has not been reached');

  /* Milliseconds are understood. */
  const inMs = (candles) => candles.map((candle) => ({ ...candle, time: candle.time * 1000 }));
  const feed = feedAt(CLOSE + 130);
  assert.equal(lastCloseOf({ m1: inMs(feed.m1), m5: inMs(feed.m5), h1: inMs(feed.h1) }), CLOSE);
  /* A series that is missing has no say; without the 5-minute series the 1-minute one decides alone. */
  assert.equal(lastCloseOf({ m1: feed.m1, m5: null, h1: undefined }), CLOSE);
  /* Nothing to go by. */
  assert.equal(lastCloseOf({ m1: [], m5: [], h1: [] }), 0);
  assert.equal(lastCloseOf({ m1: [{ open: 1 }], m5: null }), 0);
  assert.equal(lastCloseOf(null), 0);
  /* A 5-minute series with nothing finished in it: no candle for a reading to belong to. */
  assert.equal(lastCloseOf({ m1: feed.m1, m5: [feed.m5.at(-1)], h1: feed.h1 }), 0);
});

test('each series vouches only for what lies before its newest candle; the one furthest behind decides', () => {
  const fresh = feedAt(CLOSE + 130); /* 14:37:10 */
  /* A 5-minute series whose newest candle starts at 14:30: 14:35 is not vouched for. */
  assert.equal(lastCloseOf({ m1: fresh.m1, m5: feedAt(CLOSE - 10).m5, h1: fresh.h1 }), CLOSE - 300);
  /* The other way round: a 1-minute series that ends with the 14:27 candle holds the reading at 14:25. */
  assert.equal(lastCloseOf({ m1: feedAt(CLOSE - 450).m1, m5: fresh.m5, h1: fresh.h1 }), CLOSE - 600);
  /* A 1-hour series whose newest candle is the 13:00 hour vouches up to 13:55: the 14:00 reading needs that hour finished. */
  const hour14 = Date.UTC(2026, 10, 12, 14, 0) / 1000;
  assert.equal(lastCloseOf({ m1: fresh.m1, m5: fresh.m5, h1: feedAt(hour14 - 30).h1 }), hour14 - 300);
  /* With the 14:00 hour started, it vouches up to 14:55, and the other two decide. */
  assert.equal(lastCloseOf({ m1: fresh.m1, m5: fresh.m5, h1: feedAt(hour14 + 30).h1 }), CLOSE);
});

test('a copy of the 5-minute series from just before a close: the reading stays the one of the close before, and is that reading exactly', () => {
  /* 14:35:05. The 1-minute and 1-hour series are fresh; the 5-minute series was fetched at 14:34:30 and is being reused. */
  const fresh = feedAt(CLOSE + 5), old = feedAt(CLOSE - 30);
  const mixed = closedCandleSets({ m1: fresh.m1, m5: old.m5, h1: fresh.h1 });
  assert.equal(mixed.close, CLOSE - 300, 'the 14:30-14:35 candle of that copy is not known to have finished');
  /* In that copy the candle ends at the price of 14:34:30, not at the close: it must not be part of any reading. */
  assert.notEqual(old.m5.at(-1).close, fresh.m5.at(-2).close);
  assert.ok(mixed.sets.m5.every((candle) => candle.time < CLOSE - 300));
  /* What results is the reading of 14:30, the same as when it was first made. */
  assert.deepEqual(mixed.sets, closedCandleSets(feedAt(CLOSE - 295)).sets);
  /* Once the copy is renewed the reading moves on to 14:35. */
  assert.equal(closedCandleSets(fresh).close, CLOSE);
});

test('a copy of the 1-hour series from just before the full hour: no reading uses that hour until the series shows the next one', () => {
  const hour = Date.UTC(2026, 10, 12, 15, 0) / 1000;
  const fresh = feedAt(hour + 5), old = feedAt(hour - 120);
  const mixed = closedCandleSets({ m1: fresh.m1, m5: fresh.m5, h1: old.h1 });
  assert.equal(mixed.close, hour - 300);
  assert.ok(mixed.sets.h1.every((candle) => candle.time + 3600 <= hour - 300));
  assert.deepEqual(mixed.sets, closedCandleSets(feedAt(hour - 295)).sets);
  assert.equal(closedCandleSets(fresh).close, hour);
});

test('a reading is made from candles that had finished by that close: the forming ones are left out', () => {
  const now = CLOSE + 130; /* 14:37:10 */
  const feed = feedAt(now);
  const { close, sets } = closedCandleSets(feed);
  assert.equal(close, CLOSE);

  for (const key of ['m1', 'm5', 'h1']) {
    assert.equal(sets[key].length, READING_CANDLES, key + ': a fixed number of candles');
    for (const candle of sets[key]) assert.ok(candle.time + PERIOD[key] <= CLOSE, key + ': nothing that ends after the close');
    assert.ok(sets[key].every((candle) => feed[key].includes(candle)), key + ': the feed\'s own candle objects');
    assert.deepEqual(times(sets[key]), [...times(sets[key])].sort((a, b) => a - b), key + ': oldest first');
  }
  /* The newest candle of each series is the one that ended at the close, or the last whole hour before it. */
  assert.equal(sets.m1.at(-1).time, CLOSE - 60);
  assert.equal(sets.m5.at(-1).time, CLOSE - 300);
  assert.equal(sets.h1.at(-1).time, Date.UTC(2026, 10, 12, 13, 0) / 1000, 'the 14:00 hour is still forming at 14:35');
  /* Left out: the 14:35, 14:36 and 14:37 minutes, the 14:35 five minutes, the 14:00 hour. */
  assert.deepEqual(times(feed.m1).filter((time) => !times(sets.m1).includes(time) && time >= CLOSE), [CLOSE, CLOSE + 60, CLOSE + 120]);
});

test('on the hour, the hour that has just finished is part of the reading', () => {
  const hour = Date.UTC(2026, 10, 12, 15, 0) / 1000;
  const { close, sets } = closedCandleSets(feedAt(hour + 20));
  assert.equal(close, hour);
  assert.equal(sets.h1.at(-1).time, hour - 3600);
  assert.equal(sets.m5.at(-1).time, hour - 300);
});

test('the same reading whenever it is made before the next 5-minute close', () => {
  const first = closedCandleSets(feedAt(CLOSE + 5));
  for (const later of [CLOSE + 61, CLOSE + 150, CLOSE + 299]) {
    const again = closedCandleSets(feedAt(later));
    assert.equal(again.close, first.close);
    /* A feed asked later holds other candle objects: the content is what has to be equal. */
    assert.deepEqual(again.sets, first.sets, 'the same candles ' + (later - CLOSE) + ' s after the close');
    assert.deepEqual(localDecision(runDeterministicAnalysis('EUR/USD', again.sets)), localDecision(runDeterministicAnalysis('EUR/USD', first.sets)));
  }
  /* After the next close the reading is made from other candles. */
  const next = closedCandleSets(feedAt(CLOSE + 305));
  assert.equal(next.close, CLOSE + 300);
  assert.notDeepEqual(next.sets.m1, first.sets.m1);
  assert.equal(next.sets.m1.at(-1).time, CLOSE + 240);
});

test('what happens inside a forming candle cannot change the reading', () => {
  const now = CLOSE + 200;
  const calm = feedAt(now), wild = feedAt(now);
  for (const key of ['m1', 'm5', 'h1']) {
    for (const candle of wild[key]) if (candle.time + PERIOD[key] > CLOSE) Object.assign(candle, { open: 9999, high: 99999, low: 0.01, close: 5 });
  }
  assert.deepEqual(closedCandleSets(wild).sets, closedCandleSets(calm).sets);
});

test('a feed that holds fewer candles gives what it has; a missing series is passed through; no times, no candles', () => {
  const short = { m1: held(60, CLOSE + 30, 40), m5: held(300, CLOSE + 30, 8), h1: held(3600, CLOSE + 30, 3) };
  const { close, sets } = closedCandleSets(short);
  assert.equal(close, CLOSE);
  assert.equal(sets.m1.length, 39, '40 held, one forming');
  assert.equal(sets.m5.length, 7);
  assert.equal(sets.h1.length, 2);

  const missing = closedCandleSets({ m1: held(60, CLOSE + 30), m5: null, h1: undefined });
  assert.equal(missing.sets.m5, null, 'the analysis reports a missing series itself');
  assert.equal(missing.sets.h1, undefined);
  assert.equal(missing.sets.m1.length, READING_CANDLES);

  /* Without a single candle time the close is unknown, and nothing can be called finished. */
  const untimed = closedCandleSets({ m1: [{ open: 1, close: 2 }], m5: [{ close: 3 }], h1: [] });
  assert.equal(untimed.close, 0);
  assert.deepEqual(untimed.sets, { m1: [], m5: [], h1: [] });
});

test('in the normal run a reading is current: its close is less than two candles behind the feed', () => {
  for (const seconds of [5, 150, 299]) assert.equal(closedCandleSets(feedAt(CLOSE + seconds)).current, true);
  /* With a copy of the 5-minute series from before the close the reading is one candle behind, and still current. */
  const late = closedCandleSets({ ...feedAt(CLOSE + 59), m5: feedAt(CLOSE - 30).m5 });
  assert.equal(late.close, CLOSE - 300);
  assert.equal(late.current, true);
  /* No candles, no reading, nothing current. */
  assert.equal(closedCandleSets({ m1: [], m5: [], h1: [] }).current, false);
});

/* A market that gave no price between `from` and `to`. A feed has a candle only for a period with a price in it:
   one that began before the pause, or one that ends after it. */
function paused(feed, from, to) {
  const traded = (period) => (candle) => candle.time < from || candle.time + period > to;
  return { m1: feed.m1.filter(traded(60)), m5: feed.m5.filter(traded(300)), h1: feed.h1.filter(traded(3600)) };
}

test('after a pause there is no current reading until a 5-minute candle of the new session has finished', () => {
  /* The market stopped at 14:12:30 and gave its next price at 14:37:10. */
  const stopped = CLOSE - 23 * 60 + 30, resumed = CLOSE + 130;
  const feed = paused(feedAt(resumed + 20), stopped, resumed);
  assert.deepEqual(times(feed.m1).slice(-3).map((time) => (time - CLOSE) / 60), [-24, -23, 2], 'the 14:11 and 14:12 minutes, then 14:37');
  assert.deepEqual(times(feed.m5).slice(-2).map((time) => (time - CLOSE) / 60), [-25, 0], 'the 14:10 candle, then the 14:35 one');

  const justResumed = closedCandleSets(feed);
  /* The newest candle that traded and has finished is 14:10-14:15: the reading is the one of 14:15, as it was then. */
  assert.equal(justResumed.close, CLOSE - 20 * 60);
  assert.equal(justResumed.sets.m1.at(-1).time, CLOSE - 23 * 60);
  assert.ok(justResumed.sets.m5.every((candle) => candle.time + 300 <= CLOSE - 20 * 60));
  /* It describes the market before the pause, 22 minutes behind the feed: not current. */
  assert.equal(justResumed.current, false);

  /* 14:40:05: the 14:35 candle, the first of the new session, has finished. The reading is the one of 14:40. */
  const afterFirstCandle = closedCandleSets(paused(feedAt(CLOSE + 305), stopped, resumed));
  assert.equal(afterFirstCandle.close, CLOSE + 300);
  assert.equal(afterFirstCandle.current, true);
  assert.equal(afterFirstCandle.sets.m5.at(-1).time, CLOSE);
  assert.equal(afterFirstCandle.sets.m1.at(-1).time, CLOSE + 240);
});

test('a single 5-minute candle without a price: the reading stays the one before it, and is still current', () => {
  /* No price from 14:29:50 to 14:35:20: the 14:30 candle does not exist. */
  const feed = paused(feedAt(CLOSE + 40), CLOSE - 310, CLOSE + 20);
  assert.ok(!times(feed.m5).includes(CLOSE - 300));
  const { close, current, sets } = closedCandleSets(feed);
  assert.equal(close, CLOSE - 300, 'the 14:25 candle closed at 14:30; nothing traded after it until now');
  assert.equal(current, true, 'five minutes behind the feed');
  assert.equal(sets.m5.at(-1).time, CLOSE - 600);
});

test('two 5-minute candles without a price are a pause: the reading from before them is not current', () => {
  /* No price from 14:24:50 to 14:35:20: neither the 14:25 nor the 14:30 candle exists. */
  const feed = paused(feedAt(CLOSE + 40), CLOSE - 610, CLOSE + 20);
  const { close, current } = closedCandleSets(feed);
  assert.equal(close, CLOSE - 600, 'the 14:20 candle closed at 14:25');
  assert.equal(current, false, 'ten minutes behind the feed, which is two candles');
  /* Five minutes later the first candle of the new session has finished. */
  const next = closedCandleSets(paused(feedAt(CLOSE + 305), CLOSE - 610, CLOSE + 20));
  assert.equal(next.close, CLOSE + 300);
  assert.equal(next.current, true);
});

test('the next look comes right after the next 5-minute close when that is sooner than the regular check', () => {
  const closeMs = CLOSE * 1000, minute = 60000;
  /* Thirty seconds before a close: look five seconds after it, not a minute from now. */
  assert.equal(nextReadingCheck(closeMs - 30000, minute), closeMs + READING_SETTLE_MS);
  /* Just after that look: the regular minute. */
  assert.equal(nextReadingCheck(closeMs + 6000, minute), closeMs + 66000);
  /* Two seconds after a close, before the feed has had its few seconds: wait for them. */
  assert.equal(nextReadingCheck(closeMs + 2000, minute), closeMs + READING_SETTLE_MS);
  /* Exactly at the settle moment: that look is now, the next one is the regular one. */
  assert.equal(nextReadingCheck(closeMs + READING_SETTLE_MS, minute), closeMs + READING_SETTLE_MS + minute);
  /* A check interval longer than a candle never skips a close. */
  assert.equal(nextReadingCheck(closeMs + 10000, 10 * minute), closeMs + 300000 + READING_SETTLE_MS);
  /* Another settle time. */
  assert.equal(nextReadingCheck(closeMs - 30000, minute, 0), closeMs);
});
