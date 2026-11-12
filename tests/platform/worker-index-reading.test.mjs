/*
 * Cloudflare Worker — a daily index reading says which day it is from.
 *
 * An index CFD (US30, NAS100, ...) is read from Yahoo daily bars. The reading
 * only changes when a daily bar does, but it used to carry nothing except the
 * moment of the answer (`ts`), so the page could only show the time it last
 * asked. Now the reading names its newest daily bar (`daily_bar_time`) and
 * says whether that bar was a close or still forming (`daily_bar_final`).
 *
 * Yahoo is a stub and the Worker's clock is set by the test; nothing reaches
 * the network. The daily bars are fixtures and no assertion looks at a signal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';
import { derivCandleRows, yahooChartFixture } from './helpers/market-fixtures.mjs';

const ORIGIN = 'https://aurum-staging.example';
const MIN = 60;
const DAY = 86400;
/* Wednesday 11 November 2026, New York regular session: 14:30 to 21:00 UTC. */
const OPEN = Date.UTC(2026, 10, 11, 14, 30) / 1000;
const CLOSE = Date.UTC(2026, 10, 11, 21, 0) / 1000;
const SESSION = { start: OPEN, end: CLOSE };

/**
 * A Worker whose clock is `clock.sec` and whose Yahoo answers with whatever
 * `yahoo()` returns at that moment. `asked` counts the requests to Yahoo.
 */
function setup({ at, yahoo }) {
  const clock = { sec: at };
  const state = { yahoo, asked: 0 };
  const worker = createReadOnlyWorker({
    now: () => clock.sec * 1000,
    fetchImpl: async () => { state.asked += 1; return Response.json(state.yahoo()); },
    requestImpl: async (payload) => {
      if (payload.ticks_history) return { candles: derivCandleRows({ count: payload.count, granularity: payload.granularity, end: clock.sec }) };
      throw new Error('unexpected Deriv request in this test');
    },
    log: () => {}
  });
  const allow = { limit: async () => ({ success: true }) };
  const env = { AURUM_SIGNAL_LIMITER: allow, AURUM_MARKET_LIMITER: allow, ASSETS: { fetch: async () => new Response('shell') } };
  const post = async (path, body) => {
    const response = await worker.fetch(new Request(ORIGIN + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
    return { status: response.status, body: await response.json() };
  };
  const scan = async (...symbols) => (await post('/api/signals/scan', { symbols })).body.results;
  return { clock, state, post, scan };
}

/* ---------------------------------------------------------------- which bar */

test('an index reading names its newest daily bar; `ts` stays the moment of the answer', async () => {
  const at = CLOSE + 2 * 3600;
  const { scan } = setup({ at, yahoo: () => yahooChartFixture({ newestBarAt: OPEN, session: SESSION }) });
  const [reading] = await scan('US30');

  assert.equal(reading.daily_bar_time, OPEN, 'the bar of Wednesday 11 November');
  assert.equal(reading.daily_bar_final, true, 'read two hours after the close');
  assert.equal(reading.ts, at * 1000, 'the moment of the answer, not of the data');
  assert.notEqual(reading.ts, reading.daily_bar_time * 1000);

  /* Everything the page already used is still there, unchanged. */
  assert.equal(reading.symbol, 'US30');
  assert.equal(reading.tf, 'DAILY (index)');
  assert.equal(reading.model, 'technical-daily');
  assert.equal(reading.source, 'Yahoo Finance public daily data');
  assert.equal(reading.data_source, 'Yahoo Finance public daily data');
  assert.equal(reading.data_ok, true);
  for (const level of ['entry', 'stop_loss', 'tp1', 'tp2']) assert.equal(reading[level], null, `${level}: no level is invented for an index`);
  assert.equal('latest_candle_time' in reading, false, 'not a 1-minute candle time: nothing may mistake a daily bar for one');
});

test('every index the Worker reads carries the two fields', async () => {
  const { scan } = setup({ at: CLOSE + 600, yahoo: () => yahooChartFixture({ newestBarAt: OPEN, session: SESSION }) });
  const symbols = ['US30', 'NAS100', 'US100', 'SPX500', 'GER40', 'UK100'];
  const readings = await scan(...symbols);
  assert.deepEqual(readings.map((reading) => reading.symbol), symbols);
  for (const reading of readings) {
    assert.equal(reading.daily_bar_time, OPEN, reading.symbol);
    assert.equal(reading.daily_bar_final, true, reading.symbol);
  }
});

test('a Deriv market reading is untouched: it carries its 1-minute candle time and no daily bar', async () => {
  const { scan } = setup({ at: CLOSE + 600, yahoo: () => yahooChartFixture({ newestBarAt: OPEN, session: SESSION }) });
  const [reading] = await scan('EUR/USD');
  assert.equal(reading.error, undefined);
  assert.ok(reading.latest_candle_time > 0);
  assert.equal('daily_bar_time' in reading, false);
  assert.equal('daily_bar_final' in reading, false);
});

test('a day without prices at the end of Yahoo\'s list is not the newest bar', async () => {
  /* Thursday before the open: Yahoo lists Thursday with empty prices; the session it reports is Thursday's. */
  const thursday = { start: OPEN + DAY, end: CLOSE + DAY };
  const { scan } = setup({ at: OPEN + DAY - 3600, yahoo: () => yahooChartFixture({ newestBarAt: OPEN, newestClose: null, session: thursday }) });
  const [reading] = await scan('US30');
  assert.equal(reading.daily_bar_time, OPEN, 'still Wednesday: the empty Thursday bar is not used');
  assert.equal(reading.daily_bar_final, true, 'and Wednesday is a close');
});

/* ---------------------------------------------------------------- close, forming, or not said */

test('read after the session of the bar has ended: a close', async () => {
  for (const [label, at] of [['at the closing bell', CLOSE], ['a minute later', CLOSE + MIN], ['the next morning, Yahoo still reporting Wednesday', OPEN + DAY - 3600]]) {
    const { scan } = setup({ at, yahoo: () => yahooChartFixture({ newestBarAt: OPEN, session: SESSION }) });
    const [reading] = await scan('US30');
    assert.equal(reading.daily_bar_final, true, label);
  }
});

test('read while the session of the bar is open: still forming', async () => {
  for (const [label, at, barAt] of [
    ['at the opening bell', OPEN, OPEN],
    ['mid-session, bar stamped with the open', OPEN + 3 * 3600, OPEN],
    ['mid-session, bar stamped with its latest trade', OPEN + 3 * 3600, OPEN + 3 * 3600 - 5],
    ['a second before the close', CLOSE - 1, OPEN]
  ]) {
    const { scan } = setup({ at, yahoo: () => yahooChartFixture({ newestBarAt: barAt, session: SESSION }) });
    const [reading] = await scan('US30');
    assert.equal(reading.daily_bar_final, false, label);
    assert.equal(reading.daily_bar_time, barAt, label);
  }
});

test('the newest bar is from an earlier day than the session Yahoo reports: a close, whatever the time', async () => {
  const friday = OPEN + 2 * DAY;
  const monday = { start: OPEN + 5 * DAY, end: CLOSE + 5 * DAY };
  for (const [label, at] of [['Saturday', friday + DAY], ['Sunday night', friday + 2 * DAY + 8 * 3600], ['Monday before the open', monday.start - 600]]) {
    const { scan } = setup({ at, yahoo: () => yahooChartFixture({ newestBarAt: friday, session: monday }) });
    const [reading] = await scan('US30');
    assert.equal(reading.daily_bar_time, friday, label);
    assert.equal(reading.daily_bar_final, true, label);
  }
  /* The same when Yahoo reports the session of the day itself although it is a holiday. */
  const { scan } = setup({ at: friday + DAY + 3600, yahoo: () => yahooChartFixture({ newestBarAt: friday, session: { start: friday + DAY, end: friday + DAY + 6.5 * 3600 } }) });
  assert.equal((await scan('US30'))[0].daily_bar_final, true, 'a session day without a bar of its own');
});

test('nothing is claimed when Yahoo\'s answer does not allow it', async () => {
  const cases = [
    ['no session in the answer', OPEN + 3600, () => yahooChartFixture({ newestBarAt: OPEN })],
    ['a session without an end', OPEN + 3600, () => yahooChartFixture({ newestBarAt: OPEN, session: { start: OPEN } })],
    ['a session without a start', OPEN + 3600, () => yahooChartFixture({ newestBarAt: OPEN, session: { end: CLOSE } })],
    ['a session whose start is empty', OPEN + 3600, () => yahooChartFixture({ newestBarAt: OPEN, session: { start: null, end: CLOSE } })],
    ['a session whose start is zero', CLOSE + 3600, () => yahooChartFixture({ newestBarAt: OPEN, session: { start: 0, end: CLOSE } })],
    ['a session that ends before it starts', OPEN + 3600, () => yahooChartFixture({ newestBarAt: OPEN, session: { start: CLOSE, end: OPEN } })],
    ['session times that are not numbers', OPEN + 3600, () => yahooChartFixture({ newestBarAt: OPEN, session: { start: 'soon', end: 'later' } })],
    ['a bar of the session\'s day, read before that session opened', OPEN - 600, () => yahooChartFixture({ newestBarAt: OPEN - 1800, session: SESSION })],
    ['a bar newer than the session Yahoo reports', CLOSE + DAY, () => yahooChartFixture({ newestBarAt: OPEN + DAY, session: SESSION })]
  ];
  for (const [label, at, yahoo] of cases) {
    const { scan } = setup({ at, yahoo });
    const [reading] = await scan('US30');
    assert.equal(reading.error, undefined, label + ': the reading itself is still given');
    assert.equal(reading.daily_bar_final, null, label);
    assert.ok(reading.daily_bar_time > 0, label + ': the bar is still named');
  }
});

test('a newest bar that carries no time: no day is named, and nothing is claimed about it', async () => {
  /* Prices without a timestamp: the reading can still be computed, but not dated. */
  for (const stamp of [null, 0, 'yesterday']) {
    const { scan } = setup({
      at: CLOSE + 3600,
      yahoo: () => {
        const json = yahooChartFixture({ newestBarAt: OPEN, session: SESSION });
        json.chart.result[0].timestamp[79] = stamp;
        return json;
      }
    });
    const [reading] = await scan('US30');
    assert.equal(reading.error, undefined, 'the reading itself is still given');
    assert.equal(reading.daily_bar_time, 0, String(stamp));
    assert.equal(reading.daily_bar_final, null, String(stamp));
  }
});

/* ---------------------------------------------------------------- the 15-minute cache */

test('the description belongs to the candles it was read with: a series read during the session says "forming" until it is read again', async () => {
  const { clock, state, scan } = setup({ at: CLOSE - 5 * MIN, yahoo: () => yahooChartFixture({ newestBarAt: OPEN, session: SESSION }) });

  assert.equal((await scan('US30'))[0].daily_bar_final, false, 'five minutes before the close');
  assert.equal(state.asked, 1);

  /* Five minutes after the close the Worker still answers from the series it read before it. */
  clock.sec = CLOSE + 5 * MIN;
  const reused = (await scan('US30'))[0];
  assert.equal(state.asked, 1, 'Yahoo is not asked again within 15 minutes');
  assert.equal(reused.daily_bar_final, false, 'those candles were read while the bar was forming, and still say so');
  assert.equal(reused.ts, clock.sec * 1000);

  /* Once the series is read again, it is a close. */
  clock.sec = CLOSE + 11 * MIN;
  const fresh = (await scan('US30'))[0];
  assert.equal(state.asked, 2, 'read again 16 minutes after the first read');
  assert.equal(fresh.daily_bar_final, true);
  assert.equal(fresh.daily_bar_time, OPEN);
});

test('each index keeps its own series: asking for a second one does not relabel the first', async () => {
  const { clock, state, scan } = setup({ at: OPEN + 3600, yahoo: () => yahooChartFixture({ newestBarAt: OPEN, session: SESSION }) });
  assert.equal((await scan('US30'))[0].daily_bar_final, false);
  clock.sec = CLOSE + 2 * MIN; /* US30 is 5.5 hours old by now and is read again; NAS100 is read for the first time */
  const [us30, nas100] = await scan('US30', 'NAS100');
  assert.equal(us30.daily_bar_final, true);
  assert.equal(nas100.daily_bar_final, true);
  assert.equal(state.asked, 3);
});

/* ---------------------------------------------------------------- the single-market route */

test('/api/signals/analyze for an index carries the same two fields', async () => {
  const { post } = setup({ at: OPEN + 2 * 3600, yahoo: () => yahooChartFixture({ newestBarAt: OPEN, session: SESSION }) });
  const { status, body } = await post('/api/signals/analyze', { symbol: 'NAS100' });
  assert.equal(status, 200);
  assert.equal(body.symbol, 'NAS100');
  assert.equal(body.timeframe, 'DAILY');
  assert.equal(body.daily_bar_time, OPEN);
  assert.equal(body.daily_bar_final, false);
});

test('when Yahoo cannot be read, the failure is reported as before and carries no bar', async () => {
  const { scan } = setup({ at: OPEN + 3600, yahoo: () => { throw new Error('Yahoo Finance HTTP 503'); } });
  const [reading] = await scan('US30');
  assert.equal(reading.error, 'FEED_ERROR');
  assert.equal(reading.source, 'unavailable');
  assert.equal('daily_bar_time' in reading, false);
  assert.equal('daily_bar_final' in reading, false);
});
