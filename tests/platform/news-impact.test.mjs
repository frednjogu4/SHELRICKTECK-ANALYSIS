/*
 * src/newsimpact.js — which markets a headline or a calendar entry concerns,
 * Nairobi time, and the stand-aside period around a high-impact release.
 *
 * Pure functions, fixed moments, made-up headlines. No assertion says which
 * way a market moves: the module does not say it either.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS } from '../../server/lib/symbols.js';
import {
  RELEASE_MEASURED, STAND_ASIDE, currenciesOf, decodeEntities, eatClock, eatDay, eatDayBounds, eatStamp, eventConcerns, eventTime,
  exposureFor, exposureForCurrency, headlineConcerns, marketsForCurrency, releaseMeasuredText, standAside, timeframeLeans, trendWords
} from '../../src/newsimpact.js';

const MIN = 60000;
const at = (iso) => Date.parse(iso);
const labels = (title) => headlineConcerns(title).subjects.map((subject) => subject.label);
const markets = (title) => headlineConcerns(title).markets;

/* ------------------------------------------------------------- markets */

test('the currencies a market is priced in', () => {
  assert.deepEqual(currenciesOf('EUR/USD'), ['EUR', 'USD']);
  assert.deepEqual(currenciesOf('GBP/JPY'), ['GBP', 'JPY']);
  assert.deepEqual(currenciesOf('XAU/USD'), ['USD']);
  assert.deepEqual(currenciesOf('BTC/USD'), ['USD']);
  assert.deepEqual(currenciesOf('NAS100'), ['USD']);
  assert.deepEqual(currenciesOf('GER40'), ['EUR']);
  assert.deepEqual(currenciesOf('UK100'), ['GBP']);
  assert.deepEqual(currenciesOf('VOL 75'), [], 'a synthetic index follows no currency');
  assert.deepEqual(currenciesOf('NOT/LISTED'), []);
  for (const instrument of INSTRUMENTS) assert.equal(currenciesOf(instrument.s).length === 0, instrument.c === 'synthetics', instrument.s);
});

test('every listed market priced in a currency, and none for a currency this application does not follow', () => {
  assert.deepEqual(marketsForCurrency('GBP'), ['GBP/USD', 'GBP/JPY', 'EUR/GBP', 'UK100']);
  assert.deepEqual(marketsForCurrency('eur'), ['EUR/USD', 'EUR/JPY', 'EUR/GBP', 'GER40']);
  assert.deepEqual(marketsForCurrency('USD'), ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF', 'USD/CAD', 'NZD/USD', 'XAU/USD', 'XAG/USD', 'BTC/USD', 'ETH/USD', 'US30', 'NAS100', 'SPX500', 'US100']);
  for (const other of ['CNY', 'All', 'XAU', '', null, undefined]) assert.deepEqual(marketsForCurrency(other), [], String(other));
});

test('a calendar entry concerns the markets priced in its currency', () => {
  assert.deepEqual(eventConcerns({ country: 'GBP' }), { currency: 'GBP', markets: ['GBP/USD', 'GBP/JPY', 'EUR/GBP', 'UK100'] });
  assert.deepEqual(eventConcerns({ country: 'CNY' }), { currency: '', markets: [] });
  assert.deepEqual(eventConcerns({ country: 'All' }), { currency: '', markets: [] });
  assert.deepEqual(eventConcerns(null), { currency: '', markets: [] });
});

/* ------------------------------------------------------------ headlines */

test('a company headline concerns the indices the company is a large part of, and says why', () => {
  for (const title of ["Analysis: Nvidia's leadership crisis tests the chipmaker", 'Jensen Huang takes the stage', 'NVDA slides after hours']) {
    const result = headlineConcerns(title);
    assert.deepEqual(result.markets, ['NAS100', 'SPX500', 'US100'], title);
    assert.deepEqual(result.subjects, [{ label: 'Nvidia', markets: ['NAS100', 'SPX500', 'US100'], explain: true,
      why: 'Nvidia is one of the largest companies in the Nasdaq-100 and the S&P 500, so news about it concerns those indices' }], title);
  }
  assert.deepEqual(labels('Apple and Microsoft lead; Tesla and Meta lag; Amazon, Google and Broadcom flat'), ['Apple', 'Microsoft', 'Amazon', 'Alphabet (Google)', 'Meta', 'Tesla', 'Broadcom']);
  assert.deepEqual(labels('An apple a day and a new meta in gaming'), [], 'the fruit and the common word are not the companies');
});

test('a pair written out is that one market; a currency or its central bank is every market priced in it', () => {
  assert.deepEqual(markets('EUR/USD holds 1.05'), ['EUR/USD']);
  assert.deepEqual(markets('USDJPY and GBP-USD in focus'), ['GBP/USD', 'USD/JPY']);
  assert.deepEqual(markets('XAU/USD tests the round figure'), ['XAU/USD']);
  assert.deepEqual(markets('Sterling steady before the Bank of England'), marketsForCurrency('GBP'));
  assert.deepEqual(markets('Yen in focus as the BoJ meets'), ['USD/JPY', 'EUR/JPY', 'GBP/JPY']);
  assert.deepEqual(labels('Fed and ECB decisions due'), ['Euro', 'US dollar']);
  assert.deepEqual(markets('Powell testifies'), marketsForCurrency('USD'));
  assert.deepEqual(labels('He was fed up with it'), [], '"fed" the verb is not the central bank');
});

test('"dollar" alone is the US dollar, but not inside the name of another dollar', () => {
  assert.deepEqual(labels('Australian dollar slides after the RBA holds'), ['Australian dollar']);
  assert.deepEqual(markets('Australian dollar slides after the RBA holds'), ['AUD/USD']);
  assert.deepEqual(labels('Canadian dollar and New Zealand dollar mixed'), ['Canadian dollar', 'New Zealand dollar']);
  assert.deepEqual(labels('Dollar firm as the Australian dollar slips'), ['Australian dollar', 'US dollar']);
});

test('metals, coins and index names; escaped titles are read as written', () => {
  assert.deepEqual(markets('Gold and silver steady'), ['XAU/USD', 'XAG/USD']);
  assert.deepEqual(markets('Goldman Sachs reports'), [], 'a bank is not the metal');
  assert.deepEqual(markets('Bitcoin and ether quiet'), ['BTC/USD', 'ETH/USD']);
  assert.deepEqual(markets('Crypto market cap unchanged'), ['BTC/USD', 'ETH/USD']);
  assert.deepEqual(markets('S&amp;P 500 and Nasdaq close mixed; Dow flat'), ['US30', 'NAS100', 'SPX500', 'US100']);
  assert.deepEqual(markets('Wall Street opens'), ['US30', 'NAS100', 'SPX500', 'US100']);
  assert.deepEqual(markets('DAX and FTSE open'), ['GER40', 'UK100']);
  assert.equal(decodeEntities('S&amp;P &#x27;500&#39; &lt;b&gt; &unknown; &#0; &amp;amp;'), "S&P '500' <b> &unknown; &#0; &amp;");
});

test('a headline that names nothing this application follows gets no market, and oil is said to be missing', () => {
  assert.deepEqual(headlineConcerns('Council opens a new park'), { subjects: [], markets: [] });
  assert.deepEqual(headlineConcerns(''), { subjects: [], markets: [] });
  assert.deepEqual(headlineConcerns(null), { subjects: [], markets: [] });
  assert.deepEqual(headlineConcerns('Oil steady as OPEC meets'), { subjects: [{ label: 'Oil', markets: [], why: 'This application has no oil market', explain: true }], markets: [] });
});

test('no result carries a direction: only names, markets and reasons', () => {
  for (const title of ['Dollar surges on hawkish Fed', 'Gold plunges', 'Nvidia soars to a record high', 'Euro falls as the dollar gains']) {
    const result = headlineConcerns(title);
    assert.deepEqual(Object.keys(result).sort(), ['markets', 'subjects']);
    for (const subject of result.subjects) assert.deepEqual(Object.keys(subject).sort(), ['explain', 'label', 'markets', 'why']);
    assert.doesNotMatch(JSON.stringify(result), /BUY|SELL|bull|bear|"up"|"down"|tone|dir/i, title);
  }
});

/* ---------------------------------------------------------- time, Nairobi */

test('the moment of a calendar entry: its own, or its day and UTC clock; none for an all-day entry', () => {
  assert.equal(eventTime({ t: 1700000000000, time_utc: '01:00', day: '2020-01-01' }), 1700000000000);
  assert.equal(eventTime({ time_utc: '13:30', day: '2026-11-10' }), at('2026-11-10T13:30:00Z'));
  assert.equal(eventTime({ time_utc: '7:05' }, '2026-11-10'), at('2026-11-10T07:05:00Z'));
  for (const odd of [null, {}, { time_utc: '' }, { time_utc: '13:30' }, { time_utc: 'soon', day: '2026-11-10' }, { time_utc: '13:30', day: '10/11/2026' }, { t: null, time_utc: '' }]) assert.equal(eventTime(odd), null);
});

test('Nairobi time is UTC+3 all year', () => {
  assert.equal(eatClock(at('2026-11-10T13:30:00Z')), '16:30');
  assert.equal(eatClock(at('2026-07-01T21:05:00Z')), '00:05');
  assert.equal(eatDay(at('2026-11-10T20:59:59Z')), '2026-11-10');
  assert.equal(eatDay(at('2026-11-10T21:00:00Z')), '2026-11-11');
  assert.deepEqual(eatDayBounds(at('2026-11-10T22:00:00Z')), [at('2026-11-10T21:00:00Z'), at('2026-11-11T21:00:00Z')]);
  const now = at('2026-11-10T12:00:00Z');
  assert.equal(eatStamp(at('2026-11-10T13:30:00Z'), now), '16:30 EAT');
  assert.equal(eatStamp(at('2026-11-10T22:30:00Z'), now), 'Wed 01:30 EAT', 'after midnight in Nairobi it is the next day');
  assert.equal(eatStamp(at('2026-11-12T07:00:00Z'), now), 'Thu 10:00 EAT');
  assert.equal(eatStamp(at('2026-11-10T13:30:00Z')), '16:30 EAT');
  assert.equal(eatStamp(null, now), '');
});

/* -------------------------------------------------------- standing aside */

test('the stand-aside period is half an hour either side of the release', () => {
  assert.deepEqual(STAND_ASIDE, { beforeMin: 30, afterMin: 30 });
  const t = at('2026-11-10T13:30:00Z');
  const from = t - 30 * MIN, until = t + 30 * MIN;
  assert.deepEqual(standAside(t, t - 95 * MIN), { from, until, phase: 'ahead', minutes: 65 });
  assert.deepEqual(standAside(t, from - 1), { from, until, phase: 'ahead', minutes: 1 });
  assert.deepEqual(standAside(t, from), { from, until, phase: 'before', minutes: 30 });
  assert.deepEqual(standAside(t, t - 1), { from, until, phase: 'before', minutes: 1 });
  assert.deepEqual(standAside(t, t), { from, until, phase: 'after', minutes: 30 });
  assert.deepEqual(standAside(t, until - 1), { from, until, phase: 'after', minutes: 1 });
  assert.deepEqual(standAside(t, until), { from, until, phase: 'over', minutes: 0 });
});

const T = at('2026-11-10T13:30:00Z');
const EVENTS = [
  { country: 'USD', impact: 'High', event: 'release one', t: T },
  { country: 'USD', impact: 'High', event: 'release two', t: T + 45 * MIN },
  { country: 'USD', impact: 'Medium', event: 'a medium release', t: T - 10 * MIN },
  { country: 'GBP', impact: 'High', event: 'a pound release', t: T + 5 * 60 * MIN },
  { country: 'USD', impact: 'High', event: 'a holiday', t: null, time_utc: '' },
  { country: 'JPY', impact: 'High', event: 'a yen release', time_utc: '09:00', day: '2026-11-10' }
];

test('what concerns a market: only high-impact releases of its own currencies, with periods that touch joined', () => {
  const names = (x) => x.events.map((event) => event.event);
  /* 3 hours before the first release: nothing yet. Then the period is announced, then it runs to the end of the second. */
  assert.equal(exposureFor('XAU/USD', EVENTS, T - 4 * 60 * MIN), null);
  const ahead = exposureFor('XAU/USD', EVENTS, T - 60 * MIN);
  assert.deepEqual({ phase: ahead.phase, from: ahead.from, until: ahead.until, t: ahead.t, names: names(ahead) },
    { phase: 'ahead', from: T - 30 * MIN, until: T + 75 * MIN, t: T, names: ['release one', 'release two'] });
  assert.equal(exposureFor('XAU/USD', EVENTS, T - 30 * MIN).phase, 'aside');
  const between = exposureFor('XAU/USD', EVENTS, T + 20 * MIN);
  assert.deepEqual({ phase: between.phase, until: between.until, t: between.t }, { phase: 'aside', until: T + 75 * MIN, t: T + 45 * MIN }, 'the next release still to come');
  const last = exposureFor('XAU/USD', EVENTS, T + 70 * MIN);
  assert.deepEqual({ phase: last.phase, until: last.until, t: last.t, names: names(last) }, { phase: 'aside', until: T + 75 * MIN, t: T + 45 * MIN, names: ['release two'] });
  assert.equal(exposureFor('XAU/USD', EVENTS, T + 75 * MIN), null, 'over, and the pound release does not concern gold');

  /* A pair is concerned by both of its currencies; a yen release by its day and UTC clock. */
  assert.equal(exposureFor('GBP/USD', EVENTS, T + 4.75 * 60 * MIN).events[0].event, 'a pound release');
  assert.equal(exposureFor('EUR/JPY', EVENTS, at('2026-11-10T08:45:00Z'), { dayUtc: '2026-11-10' }).events[0].event, 'a yen release');
  assert.equal(exposureFor('EUR/GBP', EVENTS, T), null, 'neither the dollar nor the yen');
  assert.equal(exposureFor('VOL 75', EVENTS, T), null, 'a synthetic index is concerned by no release');
  assert.equal(exposureFor('XAU/USD', null, T), null);
  assert.equal(exposureFor('XAU/USD', [], T), null);
  assert.equal(exposureFor('XAU/USD', [{ country: 'USD', impact: 'Medium', t: T }, { country: 'USD', impact: 'Low', t: T }], T), null, 'medium and low impact start no period');
});

test('the same per currency, and how far ahead a period is announced', () => {
  assert.equal(exposureForCurrency('USD', EVENTS, T - 10 * MIN).phase, 'aside');
  assert.equal(exposureForCurrency('gbp', EVENTS, T + 2 * 60 * MIN).phase, 'ahead', 'two and a half hours before its period begins');
  assert.equal(exposureForCurrency('GBP', EVENTS, T), null, 'more than three hours away');
  assert.equal(exposureForCurrency('GBP', EVENTS, T, { aheadMin: 600 }).phase, 'ahead');
  assert.equal(exposureForCurrency('CHF', EVENTS, T), null);
});

/* -------------------------------------------------- timeframes in words */

test('what each timeframe shows, from the votes of a reading', () => {
  assert.deepEqual(timeframeLeans('1m -4 SELL · 5m -3 SELL · 1h +2 WAIT'), [
    { timeframe: '1m', score: -4, vote: 'SELL', lean: 'down' }, { timeframe: '5m', score: -3, vote: 'SELL', lean: 'down' }, { timeframe: '1h', score: 2, vote: 'WAIT', lean: 'up' }
  ]);
  assert.deepEqual(timeframeLeans('1m +1 WAIT · 5m n/a · 1h \u22121 WAIT').map((entry) => entry.lean), ['flat', '', 'flat']);
  assert.equal(trendWords('1m -4 SELL · 5m -3 SELL · 1h +2 WAIT'), 'down on 1m and 5m, up on 1h');
  assert.equal(trendWords('1m +3 BUY · 5m +4 BUY · 1h +5 BUY'), 'up on 1m, 5m and 1h');
  assert.equal(trendWords('1m +1 WAIT · 5m -2 WAIT · 1h 0 WAIT'), 'down on 5m, no clear direction on 1m and 1h');
  for (const none of ['', null, 'written by the test', '1m n/a · 5m n/a']) assert.equal(trendWords(none), '', String(none));
});

/* ------------------------------------------- the measurement and its text */

test('the measured figures are the ones the README reports, and the sentence states them with their comparison', () => {
  const text = releaseMeasuredText();
  const m = RELEASE_MEASURED;
  assert.equal(text, 'Measured on gold around 379 high-impact US releases (January 2020 to March 2023): in the minute of the release the price range was 5.4 times the usual. '
    + 'Within one minute price was a full stop distance of this rule away from where it stood in 54% of the releases (5% at the same hour a week earlier, without a release); '
    + 'within 15 minutes it had been that far in both directions in 21% (2% without). Which way is not known beforehand, and a trade of this rule stays open 30 minutes at the median. '
    + 'Not a forecast; other markets were not measured.');
  const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');
  for (const figure of [m.releases + ' with prices', m.rangeAtRelease + ' times', m.stopWithinOneMinute + '% | ' + m.stopWithinOneMinuteUsual + '%', m.bothWaysWithinFifteen + '% | ' + m.bothWaysWithinFifteenUsual + '%', m.medianMinutesOpen + ' minutes at the median']) {
    assert.ok(readme.includes(figure), 'README states: ' + figure);
  }
});
