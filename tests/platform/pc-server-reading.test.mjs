/*
 * The PC app without Exness reads a market the way the website does.
 *
 * On the website a Deriv market is read in the visitor's browser
 * (src/hostedscan.js) or by the Worker (cloudflare/worker.js). On the PC, while
 * Exness is not connected, the page asks the PC's own server (server/app.js).
 * Until November 2026 that server made its reading from whatever candles the
 * feed held, the three forming ones included, so the PC and the website showed
 * different scores and levels for the same market at the same minute.
 *
 * The server now makes the reading of the last 5-minute close as well
 * (server/lib/closedcandles.js). These tests give the three places the same
 * candles and compare what they answer.
 *
 * Candle values are fixtures. No assertion expects a particular signal,
 * direction or level: readings are compared with each other.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, configFromEnv } from '../../server/app.js';
import { createStore } from '../../server/lib/store.js';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';
import { buildDerivReading, SCAN_TIMEFRAMES, SCAN_CANDLES } from '../../src/hostedscan.js';
import { normalizeCandles } from '../../src/derivhistory.js';
import { DERIV_INSTRUMENTS, derivCandleRows, basePriceFor } from './helpers/market-fixtures.mjs';

const DERIV_SYMBOLS = DERIV_INSTRUMENTS.map((instrument) => instrument.s);
const codeOf = (symbol) => DERIV_INSTRUMENTS.find((instrument) => instrument.s === symbol).deriv;

/* One moment for all three places, so that none of them reads a later candle than another:
   2 minutes 10 seconds after a 5-minute close. */
const NOW_SEC = Math.floor(Date.now() / 1000 / 300) * 300 + 130;
const LAST_CLOSE = NOW_SEC - 130;
const fixtureRows = (symbol, granularity) => derivCandleRows({ count: SCAN_CANDLES, granularity, end: NOW_SEC, base: basePriceFor(codeOf(symbol)) });
/* A market that moves one way, with a wave on it. Step and wave are chosen so that the reading of
   the series is a BUY (rising) or a SELL (falling) with an entry, a stop and targets; the test that
   uses it checks that direction first, so that it cannot turn into a comparison of two WAITs. Its
   prices depend on the position of a candle in the series only, not on the time of the test run. */
function trendRows(granularity, step, wave) {
  const newest = Math.floor(NOW_SEC / granularity) * granularity;
  const rows = [];
  let price = 100;
  for (let i = 0; i < SCAN_CANDLES; i++) {
    const open = price;
    price = price * (1 + step + Math.sin(i / wave) * Math.abs(step) * 0.5);
    rows.push({ epoch: newest - (SCAN_CANDLES - 1 - i) * granularity, open, high: Math.max(open, price) * 1.0002, low: Math.min(open, price) * 0.9998, close: price });
  }
  return rows;
}
/* The candles all three places are given; a test may put a market of its own writing here. */
const written = new Map();
const rowsFor = (symbol, granularity) => (written.has(symbol) ? written.get(symbol)(granularity) : fixtureRows(symbol, granularity));

/* What a reading says about the market. Everything else in an answer is about the answer (where it was made, when, by which route). */
const READING = ['symbol', 'signal', 'bias', 'confidence', 'entry', 'stop_loss', 'tp1', 'tp2', 'rrr', 'price', 'mtf_signal', 'votes',
  'wait_reason', 'wait_detail', 'data_ok', 'latest_candle_time', 'candle_close', 'candle_current'];
const reading = (answer) => Object.fromEntries(READING.map((key) => [key, answer[key]]));

let folder, server, base;
before(async () => {
  folder = mkdtempSync(join(tmpdir(), 'aurum-pc-reading-'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', PERPLEXITY_API_KEY: '' }), { apiKey: '', backtestRatePerMin: 100000 });
  /* The PC server's own feed (server/lib/derivfeed.js) hands on Deriv's rows in this shape. */
  const feed = {
    symbols: Object.fromEntries(DERIV_INSTRUMENTS.map((instrument) => [instrument.s, instrument.deriv])),
    fetchCandles: async (symbol, granularity) => rowsFor(symbol, granularity)
      .map((c) => ({ time: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: 0 }))
  };
  const app = createApp({ store: createStore(join(folder, 'store.json')), config, feed });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => {
  if (server) server.close();
  if (folder) rmSync(folder, { recursive: true, force: true });
});

const pc = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

/* The real Worker code behind the same candles. A new Worker for every request, so that none answers
   from the copy of a series it took for an earlier test. */
const allow = { limit: async () => ({ success: true }) };
const cloud = async (path, body) => {
  const worker = createReadOnlyWorker({
    requestImpl: async (payload) => ({ candles: rowsFor(DERIV_INSTRUMENTS.find((instrument) => instrument.deriv === payload.ticks_history).s, payload.granularity) }),
    fetchImpl: async () => { throw new Error('no other provider is part of this test'); },
    log: () => {}
  });
  return (await worker.fetch(new Request('https://aurum-test.workers.dev' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }), { AURUM_SIGNAL_LIMITER: allow, AURUM_MARKET_LIMITER: allow })).json();
};

for (const symbol of DERIV_SYMBOLS) {
  test(`${symbol}: the PC server, the Worker and the browser make the same reading from the same candles`, async () => {
    const sets = Object.fromEntries(SCAN_TIMEFRAMES.map(([key, granularity]) => [key, normalizeCandles(rowsFor(symbol, granularity))]));
    const inBrowser = reading(buildDerivReading(symbol, sets, NOW_SEC * 1000));

    const fromPcScan = (await pc('/api/signals/scan', { symbols: [symbol] })).results[0];
    assert.equal(fromPcScan.error, undefined, fromPcScan.detail);
    const fromWorkerScan = (await cloud('/api/signals/scan', { symbols: [symbol] })).results[0];
    assert.equal(fromWorkerScan.error, undefined, fromWorkerScan.detail);
    assert.deepEqual(reading(fromPcScan), inBrowser, 'PC server scan against the browser');
    assert.deepEqual(reading(fromPcScan), reading(fromWorkerScan), 'PC server scan against the Worker');

    /* The full analysis of the PC server (no AI key: the technical decision) is the same reading again. */
    const fromPcAnalysis = await pc('/api/signals/analyze', { symbol, force: true });
    assert.equal(fromPcAnalysis.error, undefined, fromPcAnalysis.detail);
    assert.equal(fromPcAnalysis.model, 'technical');
    assert.deepEqual(reading(fromPcAnalysis), inBrowser, 'PC server analysis against the browser');

    /* It is the reading of the last 5-minute close, and it says so. */
    assert.equal(fromPcScan.candle_close, LAST_CLOSE);
    assert.equal(fromPcScan.candle_current, true);
    assert.equal(fromPcScan.latest_candle_time, LAST_CLOSE + 120, 'the newest candle of the feed, still forming');
    assert.equal(fromPcScan.tf, fromWorkerScan.tf);
    assert.equal(fromPcScan.model, fromWorkerScan.model);
  });
}

for (const [direction, step, wave] of [['BUY', 0.0006, 9], ['SELL', -0.0006, 5]]) {
  test(`a ${direction} with its entry, stop and targets is the same in all three places`, async () => {
    written.set('EUR/USD', (granularity) => trendRows(granularity, step, wave));
    try {
      const sets = Object.fromEntries(SCAN_TIMEFRAMES.map(([key, granularity]) => [key, normalizeCandles(rowsFor('EUR/USD', granularity))]));
      const inBrowser = reading(buildDerivReading('EUR/USD', sets, NOW_SEC * 1000));
      assert.equal(inBrowser.signal, direction, 'the fixture no longer reads ' + direction);
      for (const level of ['entry', 'stop_loss', 'tp1', 'tp2']) assert.ok(inBrowser[level] > 0, level);

      const fromPcScan = (await pc('/api/signals/scan', { symbols: ['EUR/USD'] })).results[0];
      const fromPcAnalysis = await pc('/api/signals/analyze', { symbol: 'EUR/USD', force: true });
      const fromWorkerScan = (await cloud('/api/signals/scan', { symbols: ['EUR/USD'] })).results[0];
      const fromWorkerAnalysis = await cloud('/api/signals/analyze', { symbol: 'EUR/USD' });
      assert.deepEqual(reading(fromPcScan), inBrowser);
      assert.deepEqual(reading(fromPcAnalysis), inBrowser);
      assert.deepEqual(reading(fromWorkerScan), inBrowser);
      assert.deepEqual(reading(fromWorkerAnalysis), inBrowser);

      /* The entry is the close of the last finished 1-minute candle: the two forming minutes are not in it. */
      const minutes = rowsFor('EUR/USD', 60);
      assert.equal(fromPcScan.price, minutes.filter((row) => row.epoch + 60 <= LAST_CLOSE).at(-1).close);
      assert.notEqual(fromPcScan.price, minutes.at(-1).close);
    } finally {
      written.delete('EUR/USD');
    }
  });
}

test('the Gold monitor\'s request (technical only) gets the same reading as the website\'s', async () => {
  const fromPc = await pc('/api/signals/analyze', { symbol: 'XAU/USD', force: true, technicalOnly: true, withNews: false });
  const fromWorker = await cloud('/api/signals/analyze', { symbol: 'XAU/USD', force: true, technicalOnly: true, withNews: false });
  assert.equal(fromPc.error, undefined, fromPc.detail);
  assert.deepEqual(reading(fromPc), reading(fromWorker));
  assert.equal(fromPc.timeframe, fromWorker.timeframe);
  assert.equal(fromPc.data_source, fromWorker.data_source);
  assert.equal(fromPc.candle_close, LAST_CLOSE);
});
