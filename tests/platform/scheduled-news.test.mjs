import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduledNewsAlerts, scheduledNewsCurrency } from '../../src/schedulednews.js';
import { marketsForCurrency } from '../../src/newsimpact.js';

const now = Date.parse('2026-11-14T10:00:00Z');
const event = (overrides = {}) => ({
  day: '2026-11-14', time_utc: '10:15', t: now + 15 * 60000,
  country: 'USD', event: 'Employment report', impact: 'High', ...overrides
});

test('currency names are normalized conservatively', () => {
  assert.equal(scheduledNewsCurrency(event({ country: 'US' })), 'USD');
  assert.equal(scheduledNewsCurrency(event({ country: 'United Kingdom' })), 'GBP');
  assert.equal(scheduledNewsCurrency(event({ country: 'CNY' })), '');
});

test('upcoming high-impact release alert includes EAT, affected markets, and no predicted direction', () => {
  const [alert] = buildScheduledNewsAlerts([event()], now);
  assert.ok(alert);
  assert.equal(alert.milestone, 15);
  assert.equal(alert.currency, 'USD');
  assert.deepEqual(alert.markets, marketsForCurrency('USD'));
  assert.match(alert.title, /Upcoming high news · USD/);
  assert.match(alert.body, /Employment report/);
  assert.match(alert.body, /13:15 EAT \(10:15 UTC\)/);
  assert.match(alert.body, /Markets priced in USD: EUR\/USD, GBP\/USD, USD\/JPY, AUD\/USD, USD\/CHF \+ 10 more/);
  assert.match(alert.body, /does not tell you BUY or SELL/);
  assert.match(alert.body, /may move these markets either way/);
  assert.match(alert.body, /fresh price-based reading, not from this release/);
});

test('high-impact alerts are issued at 15 and 5 minutes, then deduplicated per event milestone', () => {
  const fifteen = buildScheduledNewsAlerts([event()], now);
  assert.deepEqual(fifteen.map((item) => item.milestone), [15]);
  const fiveNow = now + 10 * 60000;
  const five = buildScheduledNewsAlerts([event({ time_utc: '10:15', t: now + 15 * 60000 })], fiveNow, new Set([fifteen[0].key]));
  assert.deepEqual(five.map((item) => item.milestone), [5]);
  assert.deepEqual(buildScheduledNewsAlerts([event()], fiveNow, new Set([fifteen[0].key, five[0].key])), []);
});

test('medium events get one five-minute alert; low, expired, all-day, and unsupported events do not', () => {
  const medium = buildScheduledNewsAlerts([event({ impact: 'Medium', t: now + 5 * 60000, time_utc: '10:05' })], now);
  assert.deepEqual(medium.map((item) => item.milestone), [5]);
  for (const excluded of [
    event({ impact: 'Low' }), event({ t: now - 1 }), event({ t: null }), event({ country: 'CNY' })
  ]) assert.deepEqual(buildScheduledNewsAlerts([excluded], now), []);
});

test('alert helper contains no directional instruction or claim of news-driven trade signal', () => {
  const [alert] = buildScheduledNewsAlerts([event({ t: now + 5 * 60000, time_utc: '10:05' })], now);
  assert.doesNotMatch(alert.body, /BUY (because|on|for) .*release|SELL (because|on|for) .*release/i);
  assert.match(alert.body, /does not tell you BUY or SELL/);
});
