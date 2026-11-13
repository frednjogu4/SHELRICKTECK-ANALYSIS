/*
 * The replay behind the measured figures (scripts/replay-rule.mjs).
 *
 * The price paths here are written by the test: a seeded random walk, not a
 * market. What is checked is the bookkeeping of the replay: what counts as an
 * alert, how an alert is followed, and above all that a reading never uses a
 * price from after the moment it is made. Nothing is read from disk or from
 * the network, and no assertion says what the rule concludes about a path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { follow, replay, parseBars } from '../../scripts/replay-rule.mjs';

const START = Date.UTC(2026, 10, 9, 0, 0) / 1000; /* a Monday, 00:00 UTC */

/* A repeatable path of 1-minute bars: `seed` picks the path, `from` the price it starts at. */
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
const collect = (bars, options) => { const alerts = []; const summary = replay(bars, { symbol: 'XAU/USD', ...options, onAlert: (alert) => alerts.push(alert) }); return { alerts, summary }; };
const levels = (alert) => ({ time: alert.time, signal: alert.reading.signal, entry: alert.reading.entry, stop: alert.reading.stop_loss, target: alert.reading.tp1, score: alert.reading.confidence });

test('following an alert: the stop or the target, whichever the price reaches first; the stop when both are inside one bar', () => {
  const bar = (low, high) => ({ time: 0, open: (low + high) / 2, high, low, close: (low + high) / 2 });
  const buy = { signal: 'BUY', stop_loss: 98, tp1: 103 };
  assert.deepEqual(follow([bar(99, 101), bar(99, 103.5)], 0, buy), { outcome: 'target', at: 0, bars: 2 });
  assert.deepEqual(follow([bar(99, 101), bar(97.9, 100)], 0, buy), { outcome: 'stop', at: 0, bars: 2 });
  assert.equal(follow([bar(97, 104)], 0, buy).outcome, 'stop', 'both levels inside one bar: the stop is counted');
  assert.equal(follow([bar(98, 99)], 0, buy).outcome, 'stop', 'touching the level is reaching it');
  assert.equal(follow([bar(99, 103)], 0, buy).outcome, 'target');
  assert.deepEqual(follow([bar(99, 101), bar(99.5, 102)], 0, buy), { outcome: 'open', at: 0, bars: 2 }, 'the data ended first');

  const sell = { signal: 'SELL', stop_loss: 102, tp1: 97 };
  assert.equal(follow([bar(99, 101), bar(96.5, 100)], 0, sell).outcome, 'target');
  assert.equal(follow([bar(99, 102.2)], 0, sell).outcome, 'stop');
  assert.equal(follow([bar(96, 103)], 0, sell).outcome, 'stop');

  /* Bars before `from` are not part of the exposure. */
  assert.equal(follow([bar(90, 91), bar(99, 103.5)], 1, buy).outcome, 'target');
});

test('price files: a millisecond timestamp column or an ISO date-time column; lines that do not parse are skipped', () => {
  const daily = 'timestamp,datetime_utc,open,high,low,close,volume\n1794355200000,2026-11-11 00:00:00,4038.715,4039.787,4037.327,4037.415,510\n1794355260000,2026-11-11 00:01:00,4037.787,4038.857,4037.109,4038.508,392\n';
  assert.deepEqual(parseBars(daily), [
    { time: 1794355200, open: 4038.715, high: 4039.787, low: 4037.327, close: 4037.415 },
    { time: 1794355260, open: 4037.787, high: 4038.857, low: 4037.109, close: 4038.508 }
  ]);
  const iso = 'datetime,open,high,low,close,volume\r\n2026-03-26T02:28:00+00:00,1.16642,1.16646,1.16634,1.16638,68\r\nnot a line\r\n2026-03-26T02:29:00+00:00,1.16638,1.16641,,1.16637,55\r\n';
  assert.deepEqual(parseBars(iso), [{ time: Date.UTC(2026, 2, 26, 2, 28) / 1000, open: 1.16642, high: 1.16646, low: 1.16634, close: 1.16638 }]);
  assert.throws(() => parseBars('a,b,c\n1,2,3\n'), /time column and open, high, low, close/);
});

test('a reading never uses a price from after the moment it is made', () => {
  const calm = walk(3000);
  /* The same path up to bar 2000, a different one from there on. */
  const changedFrom = 2000;
  const other = walk(1000, { seed: 99, from: calm[changedFrom - 1].close * 1.03, start: calm[changedFrom].time });
  const forked = [...calm.slice(0, changedFrom), ...other];

  for (const timing of ['close', 'minute']) {
    const a = collect(calm, { timing }).alerts, b = collect(forked, { timing }).alerts;
    /* With the look at the end of each minute, the reading made at the end of bar 1999 is the last one that saw only shared bars. */
    const shared = (alert) => alert.time <= calm[changedFrom].time;
    const before = a.filter(shared);
    assert.ok(before.length > 0, timing + ': this path gives the rule nothing to alert on any more: change the path');
    assert.deepEqual(b.filter(shared).map(levels), before.map(levels), timing + ': every reading made before the fork is the same on both paths');
    assert.notDeepEqual(b.map(levels), a.map(levels), timing + ': the fork is seen afterwards');
  }
});

test('the rule as shipped: a reading only at the first bar after a 5-minute close, and alerts only where a reading changed to BUY or SELL', () => {
  const bars = walk(3000);
  const { alerts, summary } = collect(bars, { timing: 'close' });
  assert.equal(summary.timing, 'close');
  /* 3000 minutes are 600 five-minute candles; the first 120 bars only warm the rule up. */
  assert.equal(summary.readings, 600 - 24);
  assert.equal(summary.shown.BUY + summary.shown.SELL + summary.shown.WAIT, summary.readings);
  assert.ok(alerts.length > 0, 'this path gives the rule nothing to alert on any more: change the path');
  for (const alert of alerts) {
    assert.equal(alert.time % 300, 0, 'made at a 5-minute close');
    assert.ok(alert.reading.signal === 'BUY' || alert.reading.signal === 'SELL');
    /* It is exposed from the bar that starts at that close: the outcome is `bars` bars later, counting that one. */
    if (alert.outcome !== 'open') assert.equal(alert.at - (alert.bars - 1) * 60, alert.time);
  }
  assert.ok(alerts.every((alert, index) => index === 0 || alert.time > alerts[index - 1].time));
  /* Every alert is accounted for once. */
  assert.equal(summary.alerts, alerts.length);
  assert.equal(summary.target + summary.stop + summary.stillOpen, summary.alerts);
  assert.equal(summary.bySide.BUY.alerts + summary.bySide.SELL.alerts, summary.alerts);
  assert.equal(summary.byScore.reduce((sum, bucket) => sum + bucket.alerts, 0), summary.alerts);
  assert.equal(summary.byVotes['2 of 3'].alerts + summary.byVotes['3 of 3'].alerts, summary.alerts);
  assert.equal(summary.byHour.agrees.alerts + summary.byHour.neutral.alerts + summary.byHour.against.alerts, summary.alerts);
  /* A BUY or SELL that repeats is not a new alert: there are fewer alerts than BUY and SELL readings. */
  assert.ok(summary.alerts < summary.shown.BUY + summary.shown.SELL);
  /* The entry is the price at the close the reading belongs to: the close of the bar before it. */
  for (const alert of alerts.slice(0, 20)) {
    const index = bars.findIndex((bar) => bar.time === alert.time);
    assert.equal(alert.reading.entry, bars[index - 1].close);
  }
});

test('the rule as it ran before: a reading at the end of every minute, so more of them and more alerts', () => {
  const bars = walk(3000);
  const minute = collect(bars, { timing: 'minute' }), close = collect(bars, { timing: 'close' });
  assert.equal(minute.summary.readings, 3000 - 119);
  assert.ok(minute.summary.alerts > close.summary.alerts);
  /* An alert made at the end of a minute is exposed from the next bar on, never to the bar it was made from. */
  const finished = minute.alerts.filter((alert) => alert.outcome !== 'open');
  assert.ok(finished.length > 0);
  for (const alert of finished) assert.equal(alert.at - (alert.bars - 1) * 60, alert.time, 'the first exposed bar starts when the alert was made');
});

test('only alerts inside the counted span are counted; the bars before it warm the rule up, the bars after it finish its alerts', () => {
  const bars = walk(3000);
  const from = bars[1000].time, to = bars[2000].time;
  const all = collect(bars, { timing: 'close' }).alerts.map(levels);
  const inside = collect(bars, { timing: 'close', from, to });
  assert.ok(inside.alerts.every((alert) => alert.time >= from && alert.time < to));
  /* Exactly the alerts the full run has in that span: the reading made just before the span is known
     from the warm-up, so a BUY that was already standing when the span began is not counted as new. */
  const expected = all.filter((alert) => alert.time >= from && alert.time < to);
  assert.ok(expected.length > 0 && expected.length < all.length);
  assert.deepEqual(inside.alerts.map(levels), expected);
  assert.equal(inside.summary.weekdays, 2, 'the span runs from Monday 16:40 to Tuesday 09:20');
});

test('the controls follow every alert with the same distances; an unknown timing is refused', () => {
  const { summary } = collect(walk(3000), { timing: 'close' });
  for (const name of ['opposite', 'coin']) {
    const control = summary.controls[name];
    assert.ok(control.target + control.stop > 0 && control.target + control.stop <= summary.alerts, name);
  }
  /* Same seed, same tosses: the run can be repeated. */
  assert.deepEqual(collect(walk(3000), { timing: 'close' }).summary, summary);
  assert.throws(() => replay(walk(200), { symbol: 'XAU/USD', timing: 'hourly' }), /timing must be/);
});

test('the spread is taken off every finished alert, and nothing else', () => {
  const bars = walk(3000);
  const free = collect(bars, { timing: 'close' }).summary, paid = collect(bars, { timing: 'close', spread: 0.25 }).summary;
  assert.equal(paid.perAlert, free.perAlert);
  assert.ok(Math.abs(paid.perAlertAfterSpread - (free.perAlert - 0.25)) < 1e-12);
  assert.equal(free.perAlertAfterSpread, free.perAlert);
  assert.equal(paid.targetFirstPercent, free.targetFirstPercent);
});
