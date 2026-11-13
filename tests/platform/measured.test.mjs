/*
 * The replay figures shown beside signals (src/measured.js).
 *
 * The readings here are written by the test. The figures are the ones in
 * src/measured.js, which come from the replay runs described in the README;
 * these tests check which figure is shown for which reading, how it is
 * worded, and that the README, the page and the module give the same numbers.
 * Nothing reaches the network, and no assertion says what an analysis would
 * conclude.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BREAK_EVEN_PERCENT, MEASURED, isDailyReading, isMeasuredKind, measuredFor, measuredRange, measuredText, measuredLine } from '../../src/measured.js';

const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

/* A BUY of the 1m/5m/1h rule as the page makes it from finished candles: it names its 5-minute close. */
const atClose = (symbol, extra = {}) => ({ symbol, signal: 'BUY', confidence: 70, entry: 100, stop_loss: 99, tp1: 101.5, model: 'technical', tf: 'MTF 1m/5m/1h', candle_close: 1794494100, ...extra });
/* The same from the PC's server, which looks every minute and names no close. */
const everyMinute = (symbol, extra = {}) => { const reading = atClose(symbol, extra); delete reading.candle_close; return reading; };
const daily = (signal) => ({ symbol: 'US30', signal, confidence: 82, entry: null, stop_loss: null, tp1: null, model: 'technical-daily', tf: 'DAILY (index)' });

test('break-even: a win pays 1.5 times what a loss costs, so 40 in 100 are needed before the spread', () => {
  assert.equal(BREAK_EVEN_PERCENT, 40);
  assert.equal(Math.round((1 / (1 + 2.25 / 1.5)) * 100), BREAK_EVEN_PERCENT);
});

test('ten markets were replayed; each has a figure for both timings', () => {
  assert.deepEqual(Object.keys(MEASURED), ['XAU/USD', 'EUR/USD', 'GBP/USD', 'AUD/USD', 'USD/JPY', 'USD/CHF', 'USD/CAD', 'US30', 'NAS100', 'SPX500']);
  for (const [symbol, market] of Object.entries(MEASURED)) {
    for (const timing of ['close', 'minute']) {
      const figure = market[timing];
      assert.ok(figure.percent > 30 && figure.percent < 50, symbol + ' ' + timing + ': a share of signals, in percent');
      assert.ok(Number.isInteger(figure.alerts) && figure.alerts > 1000, symbol + ' ' + timing);
      assert.ok(figure.perDay > 10, symbol + ' ' + timing);
    }
    /* One reading per 5-minute candle gives about half as many alerts as a look every minute. */
    assert.ok(market.close.alerts < 0.55 * market.minute.alerts && market.close.alerts > 0.4 * market.minute.alerts, symbol);
    assert.ok(Object.isFrozen(market) && Object.isFrozen(market.close));
  }
  assert.equal(measuredRange('close'), '37\u201341%');
  assert.equal(measuredRange('minute'), '37\u201341%');
});

test('what is measured: a BUY or SELL of the 1m/5m/1h rule with its stop and target; nothing else', () => {
  assert.equal(isMeasuredKind(atClose('EUR/USD')), true);
  assert.equal(isMeasuredKind(atClose('EUR/USD', { signal: 'SELL', model: 'technical-exness' })), true);
  assert.equal(isMeasuredKind(atClose('EUR/USD', { model: undefined })), true, 'the Gold monitor\'s own analyses carry no model name');
  assert.equal(isMeasuredKind(atClose('EUR/USD', { signal: 'WAIT' })), false);
  assert.equal(isMeasuredKind(atClose('EUR/USD', { tp1: null })), false, 'no target, nothing to reach');
  assert.equal(isMeasuredKind(atClose('EUR/USD', { model: 'claude-opus-4-1' })), false, 'a decision written by an AI model is not the rule');
  assert.equal(isMeasuredKind({ symbol: 'EUR/USD', error: 'FEED_ERROR' }), false);
  assert.equal(isMeasuredKind(daily('BUY')), false);
  assert.equal(isMeasuredKind(null), false);

  assert.equal(isDailyReading(daily('WAIT')), true);
  assert.equal(isDailyReading({ symbol: 'US30', data_state: 'daily' }), true);
  assert.equal(isDailyReading({ symbol: 'US30', tf: 'DAILY (index)' }), true);
  assert.equal(isDailyReading(atClose('US30')), false, 'an index read from Exness minute candles is not a daily reading');
  assert.equal(isDailyReading(null), false);
});

test('the figure is the one of the reading\'s own market and of the timing that made it', () => {
  assert.deepEqual(measuredFor(atClose('XAU/USD')), { name: 'gold', span: 'Jan 2020 \u2013 Nov 2026', timing: 'close', percent: 39.6, alerts: 82069, perDay: 46 });
  assert.deepEqual(measuredFor(everyMinute('XAU/USD')), { name: 'gold', span: 'Jan 2020 \u2013 Nov 2026', timing: 'minute', percent: 39.8, alerts: 177715, perDay: 100 });
  assert.equal(measuredFor(atClose('GBP/USD')).percent, 36.9);
  assert.equal(measuredFor(everyMinute('GBP/USD')).percent, 36.8);
  assert.equal(measuredFor(atClose('US30')).percent, 39.7, 'an index read by the 1m/5m/1h rule (Exness in the PC app)');
  assert.equal(measuredFor(atClose('BTC/USD')), null, 'not replayed');
  assert.equal(measuredFor(atClose('EUR/USD', { signal: 'WAIT' })), null);
  assert.equal(measuredFor(daily('BUY')), null);
});

test('the sentence under a score', () => {
  assert.equal(measuredText(atClose('XAU/USD')),
    'Measured in a replay on gold (Jan 2020 \u2013 Nov 2026): 39.6% of 82,069 signals of this rule reached target 1 before the stop; 40% is needed to break even, before the spread. Not a forecast.');
  assert.equal(measuredText(everyMinute('EUR/USD')),
    'Measured in a replay on EUR/USD (Mar \u2013 Sep 2026): 39.9% of 13,990 signals of this rule reached target 1 before the stop; 40% is needed to break even, before the spread. Not a forecast.');
  assert.equal(measuredText(atClose('BTC/USD')),
    'Not measured on this market. On the 10 markets replayed, signals of this rule reached target 1 before the stop 37\u201341% of the time; 40% is needed to break even, before the spread.');
  /* Nothing for what was not measured as a kind; a daily reading is explained by its own sentence on the page. */
  assert.equal(measuredText(atClose('EUR/USD', { signal: 'WAIT' })), '');
  assert.equal(measuredText(daily('BUY')), '');
  assert.equal(measuredText({ symbol: 'EUR/USD', error: 'STALE_DATA' }), '');
  assert.equal(measuredText(null), '');
});

test('the short form for a table cell', () => {
  assert.equal(measuredText(atClose('USD/CAD'), { short: true }), 'measured 40.9%');
  assert.equal(measuredText(everyMinute('USD/CAD'), { short: true }), 'measured 41.2%');
  assert.equal(measuredText(atClose('BTC/USD'), { short: true }), 'not measured');
  assert.equal(measuredText(daily('BUY'), { short: true }), 'not measured');
  assert.equal(measuredText(daily('WAIT'), { short: true }), 'not measured');
  assert.equal(measuredText(atClose('EUR/USD', { signal: 'WAIT' }), { short: true }), '');
});

test('the line that ends an alert or a shared message', () => {
  assert.equal(measuredLine(atClose('XAU/USD', { signal: 'SELL' })), 'Measured in a replay on gold: 39.6% of such signals reached TP1 before the SL (break-even 40% before the spread). Not a forecast.');
  assert.equal(measuredLine(atClose('BTC/USD')), 'Not measured on this market; on 10 others 37\u201341% of such signals reached TP1 before the SL (break-even 40% before the spread).');
  assert.equal(measuredLine(daily('BUY')), 'Not measured: a daily reading has no stop or target.');
  assert.equal(measuredLine(atClose('EUR/USD', { signal: 'WAIT' })), '');
  assert.equal(measuredLine(null), '');
});

test('no sentence promises anything: each says "measured" or "not measured", and none speaks of chance or profit', () => {
  const sentences = [
    ...Object.keys(MEASURED).flatMap((symbol) => [measuredText(atClose(symbol)), measuredText(everyMinute(symbol)), measuredLine(atClose(symbol))]),
    measuredText(atClose('BTC/USD')), measuredLine(atClose('BTC/USD')), measuredLine(daily('BUY'))
  ];
  for (const sentence of sentences) {
    assert.match(sentence, /^(Measured in a replay|Not measured)/);
    assert.doesNotMatch(sentence, /chance|probab|profit|will |expect|guarantee/i, sentence);
  }
});

test('the README table and the page carry the same figures as the module', () => {
  const readme = read('README.md'), html = read('index.html');
  const count = (value) => value.toLocaleString('en-US');
  for (const [symbol, market] of Object.entries(MEASURED)) {
    const label = symbol === 'XAU/USD' ? 'Gold (XAU/USD)' : symbol;
    const row = '| ' + label + ' | ' + market.span + ' | ' + count(market.close.alerts) + ' | ' + market.close.perDay + ' | **' + market.close.percent + '%** | '
      + count(market.minute.alerts) + ' | ' + market.minute.perDay + ' | ' + market.minute.percent + '% |';
    assert.ok(readme.includes(row), 'README row: ' + row);
  }
  const gold = MEASURED['XAU/USD'].close;
  assert.match(html, new RegExp('<span data-measured-range>' + measuredRange('close') + '</span>'));
  assert.match(html, new RegExp('<span data-measured-gold>' + String(gold.percent).replace('.', '\\.') + '% of ' + count(gold.alerts) + '</span>'));
});
