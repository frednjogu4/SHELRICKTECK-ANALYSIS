/*
 * scripts/news-window.mjs — the measurement behind the stand-aside period.
 *
 * Made-up 1-minute bars and a made-up calendar: a quiet market with one large
 * bar at each release. The tests check the arithmetic and the clocks, not what
 * any real market did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { controlTimes, eetToUtc, isTalk, newYorkToUtc, parseEvents, profile, quantile, releaseTimes } from '../../scripts/news-window.mjs';

const utc = (iso) => Date.parse(iso) / 1000;

test('a New York clock time becomes UTC with the summer time of its date', () => {
  assert.equal(newYorkToUtc(2021, 1, 8, 8, 30), utc('2021-01-08T13:30:00Z'));
  assert.equal(newYorkToUtc(2021, 7, 2, 8, 30), utc('2021-07-02T12:30:00Z'));
  assert.equal(newYorkToUtc(2021, 3, 19, 8, 30), utc('2021-03-19T12:30:00Z'), 'the United States change their clocks before Europe');
  assert.equal(newYorkToUtc(2022, 11, 2, 14, 0), utc('2022-11-02T18:00:00Z'));
  assert.equal(newYorkToUtc(2022, 12, 14, 14, 0), utc('2022-12-14T19:00:00Z'));
});

test('a bar stamped with the Athens clock becomes UTC: two hours in winter, three in summer, by the European dates', () => {
  assert.equal(eetToUtc(utc('2021-01-08T15:30:00Z')), utc('2021-01-08T13:30:00Z'));
  assert.equal(eetToUtc(utc('2021-07-02T15:30:00Z')), utc('2021-07-02T12:30:00Z'));
  assert.equal(eetToUtc(utc('2021-03-19T14:30:00Z')), utc('2021-03-19T12:30:00Z'), 'Europe is still on winter time');
  assert.equal(eetToUtc(utc('2021-03-29T15:30:00Z')), utc('2021-03-29T12:30:00Z'), 'the day after Europe changed');
  assert.equal(eetToUtc(utc('2021-10-29T15:30:00Z')), utc('2021-10-29T12:30:00Z'));
  assert.equal(eetToUtc(utc('2021-11-01T15:30:00Z')), utc('2021-11-01T13:30:00Z'));
});

const CSV = [
  'ID,Currency,Impact,title,previous,forcast,actual,timeofevent,positive',
  '1,USD,3,Fixture Payrolls,1,2,3,21/1/8 8:30,',
  '2,USD,3,Fixture Payrolls,1,2,3,21/7/2 8:30,',
  '3,USD,3,"Fixture, with a comma",,,,21/7/2 8:30,',
  '4,USD,3,Fixture Chair Speaks,,,,21/7/2 10:00,',
  '5,EUR,3,Fixture Rate Decision,,,,21/7/8 7:45,',
  '6,USD,2,Fixture Medium,,,,21/7/2 8:30,',
  '7,USD,3,Fixture Bank Holiday,,,,21/7/5 0:00,',
  '8,USD,3,Fixture Without Time,,,,,',
  '9,All,3,Fixture Meetings,,,,21/7/9 3:00,'
].join('\r\n');

test('the calendar file is read with its New York times, and releases are picked by currency, impact and kind', () => {
  const events = parseEvents(CSV);
  assert.equal(events.length, 8, 'a row without a time is left out');
  assert.deepEqual(events[0], { t: utc('2021-01-08T13:30:00Z'), currency: 'USD', impact: 3, title: 'Fixture Payrolls', allDay: false });
  assert.equal(events[2].title, 'Fixture, with a comma');
  assert.equal(events[6].allDay, true);
  assert.deepEqual(releaseTimes(events), [utc('2021-01-08T13:30:00Z'), utc('2021-07-02T12:30:00Z')], 'two entries at one moment are one release');
  assert.deepEqual(releaseTimes(events, { talk: true }), [utc('2021-07-02T14:00:00Z')]);
  assert.deepEqual(releaseTimes(events, { talk: null }).length, 3);
  assert.deepEqual(releaseTimes(events, { impact: 2 }), [utc('2021-07-02T12:30:00Z')]);
  assert.deepEqual(releaseTimes(events, { currency: 'EUR' }), [utc('2021-07-08T11:45:00Z')]);
  assert.deepEqual(releaseTimes(events, { currency: '*', talk: null, from: utc('2021-07-01T00:00:00Z') }).length, 3, 'every currency, without the entries for "All"');
  assert.deepEqual(releaseTimes(events, { from: utc('2021-02-01T00:00:00Z'), to: utc('2021-07-02T12:30:00Z') }), [], 'the end of the period is not part of it');
  assert.throws(() => parseEvents('a,b\n1,2'), /needs the columns/);
  assert.deepEqual(parseEvents(''), []);
  assert.ok(isTalk('Fed Chair Powell Speaks') && isTalk('FOMC Meeting Minutes') && isTalk('FOMC Press Conference'));
  assert.ok(!isTalk('Non-Farm Employment Change') && !isTalk('Federal Funds Rate') && !isTalk(null));
});

test('the comparison moments are a week earlier, without those near any release', () => {
  const week = 7 * 86400;
  const a = utc('2021-07-09T12:30:00Z'), b = utc('2021-07-16T12:30:00Z'), c = utc('2021-08-06T12:30:00Z');
  assert.deepEqual(controlTimes([a, b, c], [a, b, c]), [a - week, c - week], 'a week before b is a itself: left out');
  assert.deepEqual(controlTimes([a], [a - week + 3600]), [], 'within an hour of another release');
  assert.deepEqual(controlTimes([a], [a - week + 3601]), [a - week]);
});

/* A quiet market: every minute opens and closes at 100 with a range of 1. */
function quietBars(from, minutes, special = {}) {
  const bars = [];
  for (let i = 0; i < minutes; i++) {
    const time = from + i * 60;
    bars.push({ time, open: 100, high: 100.5, low: 99.5, close: 100, ...(special[time] || {}) });
  }
  return bars;
}

test('the profile of a release: range against the usual, and how often price went a stop distance away', () => {
  const from = utc('2021-07-02T06:00:00Z');
  const one = utc('2021-07-02T12:30:00Z'), two = utc('2021-07-02T16:00:00Z'), three = utc('2021-07-02T19:00:00Z');
  const bars = quietBars(from, 16 * 60, {
    [one]: { high: 104, low: 98 },            /* 4 up and 2 down in the minute of the release */
    [two]: { high: 100.5, low: 99.5 },         /* nothing at the release ... */
    [two + 180]: { high: 100.5, low: 97 },     /* ... and 3 down in the fourth minute */
    [three + 600]: { high: 102, low: 99.5 }    /* 2 up in the eleventh minute */
  });
  const missing = utc('2021-07-03T12:30:00Z');
  const p = profile(bars, [one, two, three, missing]);
  assert.equal(p.releases, 4);
  assert.equal(p.withPrices, 3, 'a release without prices is counted as asked for, not as measured');
  assert.equal(p.withStop, 3);
  /* The usual range is 1; the quiet market's true range is 1, so the stop distance is 1.5. */
  assert.equal(p.range(0, 0), 1, 'the median of the three release minutes: 6, 1 and 1');
  assert.equal(p.range(-30, -1), 1);
  assert.deepEqual(p.releaseOverStop, { median: 1 / 1.5, p75: 4, p90: 4 });
  assert.deepEqual(p.stopWithin, { 1: 33, 5: 67, 15: 100, 30: 100 });
  assert.deepEqual(p.bothWaysWithin, { 5: 33, 15: 33, 30: 33 }, 'only the first went a stop distance both ways');
  assert.equal(p.onTheMinute, 1, 'the largest bar of the surrounding hours falls on the listed minute once');

  const single = profile(bars, [one]);
  assert.equal(single.range(0, 0), 6);
  assert.deepEqual(single.stopWithin, { 1: 100, 5: 100, 15: 100, 30: 100 });
  assert.deepEqual(profile(bars, []).stopWithin, { 1: NaN, 5: NaN, 15: NaN, 30: NaN }, 'nothing measured is not zero');
});

test('a release is left out when the hour before it has too few bars, or the 5-minute candles before it are incomplete', () => {
  const release = utc('2021-07-02T12:30:00Z');
  /* The usual range needs 50 of the 60 minutes that end half an hour before the release: 11:00 to 11:59. */
  assert.equal(profile(quietBars(utc('2021-07-02T11:11:00Z'), 120), [release]).withPrices, 0, '49 of the 60 minutes');
  assert.equal(profile(quietBars(utc('2021-07-02T11:10:00Z'), 120), [release]).withPrices, 1, '50 of the 60 minutes');
  const bars = quietBars(utc('2021-07-02T06:00:00Z'), 10 * 60).filter((bar) => bar.time < release - 40 * 60 || bar.time >= release - 35 * 60);
  const gap = profile(bars, [release]);
  assert.equal(gap.withPrices, 1);
  assert.equal(gap.withStop, 0, 'no stop distance without fifteen whole candles');
});

test('quantile ignores what is not a number', () => {
  assert.equal(quantile([3, 1, NaN, 2], 0.5), 2);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});
