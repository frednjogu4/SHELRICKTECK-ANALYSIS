/*
 * Signal scan of the cloud viewer (src/hostedscan.js).
 *
 * What is checked, for every instrument of the "No data" report:
 *   - who computes its reading (this browser first, the AURUM cloud as a
 *     labelled fallback, the cloud alone for index CFDs);
 *   - that the browser's reading is field for field what the Worker returns
 *     for the same candles;
 *   - that every outcome has exactly one state: live, daily, stale, no-data
 *     or unavailable, and that only live and daily readings carry a signal.
 *
 * Candle sources are stubs; nothing reaches the network. Candle values are
 * fixtures. No assertion expects a particular signal, direction or level:
 * readings are compared with each other, or checked for being absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHostedScanner, buildDerivReading, withheldReading, isDerivBacked, signalState, summarizeReadings, candleAgeSec, ageText,
  BROWSER_LABEL, CLOUD_SUFFIX, DERIV_SOURCE, YAHOO_SOURCE, LIVE_MAX_AGE_SEC, SCAN_TIMEFRAMES, SCAN_CANDLES, BROWSER_RETRY_MS
} from '../../src/hostedscan.js';
import { CandleError, normalizeCandles } from '../../src/derivhistory.js';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';
import { DERIV_INSTRUMENTS, INDEX_INSTRUMENTS, derivCandleRows, basePriceFor, yahooChartFixture, nowSec } from './helpers/market-fixtures.mjs';

const DERIV_SYMBOLS = DERIV_INSTRUMENTS.map((instrument) => instrument.s);
const INDEX_SYMBOLS = INDEX_INSTRUMENTS.map((instrument) => instrument.s);
const ALL_SYMBOLS = [...DERIV_SYMBOLS, ...INDEX_SYMBOLS];
const codeOf = (symbol) => DERIV_INSTRUMENTS.find((instrument) => instrument.s === symbol).deriv;
/* Fields that only a reading with a signal has. A stale, empty or unavailable reading must carry none of them. */
const SIGNAL_FIELDS = ['signal', 'bias', 'confidence', 'entry', 'stop_loss', 'tp1', 'tp2', 'rrr', 'price', 'votes', 'mtf_signal'];

/** Raw Deriv rows for one market and timeframe; `ageSec` moves the newest candle into the past. */
const rowsFor = (symbol, granularity, ageSec = 0) => derivCandleRows({ count: SCAN_CANDLES, granularity, end: nowSec() - ageSec, base: basePriceFor(codeOf(symbol)) });

/** A browser candle source: answers every request with fixtures, or fails the way `failure(symbol, granularity)` says. */
function browserFeed({ ageSec = 0, failure = null } = {}) {
  const calls = [];
  const fetchCandles = async (symbol, granularity, count) => {
    calls.push({ symbol, granularity, count });
    const error = failure && failure(symbol, granularity);
    if (error) throw error;
    return normalizeCandles(rowsFor(symbol, granularity, ageSec));
  };
  return { fetchCandles, calls };
}

/** The real Worker code behind a stub provider, called the way the page calls /api/signals/scan. */
function cloud({ deriv = 'ok', yahoo = 'ok', ageSec = 0 } = {}) {
  const requests = [];
  const worker = createReadOnlyWorker({
    requestImpl: async (payload) => {
      if (deriv !== 'ok') throw new Error('Deriv public WebSocket connection failed');
      const symbol = DERIV_INSTRUMENTS.find((instrument) => instrument.deriv === payload.ticks_history).s;
      return { candles: rowsFor(symbol, payload.granularity, ageSec) };
    },
    fetchImpl: async () => {
      if (yahoo !== 'ok') throw new Error('Yahoo Finance HTTP 503');
      return Response.json(yahooChartFixture());
    },
    log: () => {}
  });
  const allow = { limit: async () => ({ success: true }) };
  const post = async (path, body) => worker.fetch(new Request('https://aurum-test.workers.dev' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }), { AURUM_SIGNAL_LIMITER: allow, AURUM_MARKET_LIMITER: allow });
  const cloudScan = async (symbols) => {
    requests.push([...symbols]);
    const found = new Map();
    for (let i = 0; i < symbols.length; i += 14) {
      const response = await post('/api/signals/scan', { symbols: symbols.slice(i, i + 14) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error);
      for (const reading of data.results) found.set(reading.symbol, reading);
    }
    return found;
  };
  return { cloudScan, requests, post };
}

const feedDown = () => new CandleError('connect', 'This browser could not connect to the Deriv public feed.');

/* ---------------------------------------------------------------- which instruments are which */

test('exactly the 20 Deriv-backed instruments are analysed in the browser; the six index CFDs are not', () => {
  assert.equal(DERIV_SYMBOLS.length, 20);
  assert.equal(INDEX_SYMBOLS.length, 6);
  for (const symbol of DERIV_SYMBOLS) assert.equal(isDerivBacked(symbol), true, symbol);
  for (const symbol of INDEX_SYMBOLS) assert.equal(isDerivBacked(symbol), false, symbol);
  assert.equal(isDerivBacked('NOT/LISTED'), false);
  assert.equal(isDerivBacked(''), false);
  assert.deepEqual(SCAN_TIMEFRAMES.map(([key, granularity]) => key + ':' + granularity), ['m1:60', 'm5:300', 'h1:3600']);
});

/* ---------------------------------------------------------------- every affected instrument */

for (const symbol of DERIV_SYMBOLS) {
  test(`${symbol}: read in this browser when the AURUM cloud cannot reach Deriv`, async () => {
    const feed = browserFeed();
    const aurum = cloud({ deriv: 'down' });
    const scanner = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan: aurum.cloudScan });
    const [reading] = await scanner.scan([symbol]);

    assert.equal(reading.symbol, symbol);
    assert.equal(reading.error, undefined, 'a reading, not an error');
    assert.equal(signalState(reading), 'live');
    assert.equal(reading.computed, 'browser');
    assert.equal(reading.data_source, BROWSER_LABEL);
    assert.equal(reading.source, BROWSER_LABEL);
    assert.equal(reading.tf, 'MTF 1m/5m/1h');
    assert.equal(reading.model, 'technical');
    assert.equal(reading.latest_candle_time, rowsFor(symbol, 60).at(-1).epoch, 'the reading says which candle it ends on');
    assert.ok(['BUY', 'SELL', 'WAIT'].includes(reading.signal));
    assert.deepEqual(feed.calls, SCAN_TIMEFRAMES.map(([, granularity]) => ({ symbol, granularity, count: SCAN_CANDLES })), 'three series: 1m, 5m, 1h');
    assert.deepEqual(aurum.requests, [], 'the AURUM cloud is not asked for a market this browser can read');
  });

  test(`${symbol}: the browser's reading equals the Worker's for the same candles`, async () => {
    const sets = Object.fromEntries(SCAN_TIMEFRAMES.map(([key, granularity]) => [key, normalizeCandles(rowsFor(symbol, granularity))]));
    const inBrowser = buildDerivReading(symbol, sets, Date.now());
    const aurum = cloud();

    const scan = (await (await aurum.post('/api/signals/scan', { symbols: [symbol] })).json()).results[0];
    assert.equal(scan.error, undefined);
    for (const key of Object.keys(scan).filter((name) => name !== 'ts')) {
      assert.deepEqual(inBrowser[key], scan[key], `scan field "${key}"`);
    }

    const analyze = await (await aurum.post('/api/signals/analyze', { symbol })).json();
    for (const key of Object.keys(analyze).filter((name) => name !== 'meta')) {
      assert.deepEqual(inBrowser[key], analyze[key], `analysis field "${key}"`);
    }
    /* All three name the 5-minute close the reading was made at, and it is the same one. */
    assert.ok(inBrowser.candle_close > 0 && inBrowser.candle_close % 300 === 0);
    assert.ok(inBrowser.candle_close <= inBrowser.latest_candle_time, 'a close the feed has already passed');
    assert.equal(scan.candle_close, inBrowser.candle_close);
    assert.equal(analyze.candle_close, inBrowser.candle_close);
    /* ...and that the reading is current: the feed did not just resume after a pause. */
    assert.equal(inBrowser.candle_current, true);
    assert.equal(scan.candle_current, true);
    assert.equal(analyze.candle_current, true);
    assert.equal(inBrowser.meta.mode, 'technical');
    assert.deepEqual(inBrowser.meta.engines, []);
  });
}

/* ---------------------------------------------------------------- the whole table at once */

test('the reported fault: the cloud cannot reach Deriv, the browser can — 20 live readings, 6 daily index readings, nothing unavailable', async () => {
  const feed = browserFeed();
  const aurum = cloud({ deriv: 'down' });
  const reports = [];
  const scanner = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan: aurum.cloudScan, onScan: (report) => reports.push(report) });
  const readings = await scanner.scan(ALL_SYMBOLS);

  assert.deepEqual(readings.map((reading) => reading.symbol), ALL_SYMBOLS, 'one reading per symbol, in the order asked');
  for (const reading of readings.slice(0, 20)) {
    assert.equal(signalState(reading), 'live', reading.symbol);
    assert.equal(reading.data_source, BROWSER_LABEL, reading.symbol);
  }
  for (const reading of readings.slice(20)) {
    assert.equal(signalState(reading), 'daily', reading.symbol);
    assert.equal(reading.data_source, YAHOO_SOURCE + CLOUD_SUFFIX, reading.symbol);
    assert.equal(reading.computed, 'cloud');
    assert.equal(reading.tf, 'DAILY (index)');
  }
  assert.deepEqual(aurum.requests, [INDEX_SYMBOLS], 'one cloud request, for the index CFDs only');
  assert.equal(feed.calls.length, 60);

  assert.equal(reports.length, 1);
  const { at, ms, ...counts } = reports[0];
  assert.ok(at > 0 && ms >= 0);
  assert.deepEqual(counts, { total: 26, live: 20, daily: 6, stale: 0, noData: 0, unavailable: 0, browser: 20, cloud: 6, usedBrowser: true, browserPaused: false, askedCloudForDeriv: 0, problems: [] });
});

test('neither side can reach Deriv: every Deriv market is "unavailable" with both reasons, and carries no signal', async () => {
  const feed = browserFeed({ failure: feedDown });
  const aurum = cloud({ deriv: 'down' });
  const reports = [];
  const scanner = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan: aurum.cloudScan, onScan: (report) => reports.push(report) });
  const readings = await scanner.scan(ALL_SYMBOLS);

  for (const reading of readings.slice(0, 20)) {
    assert.equal(signalState(reading), 'unavailable', reading.symbol);
    assert.equal(reading.error, 'FEED_ERROR');
    assert.equal(reading.data_source, 'Deriv public feed unreachable');
    assert.match(reading.detail, /^This browser: This browser could not connect to the Deriv public feed\. AURUM cloud: Deriv public WebSocket connection failed$/);
    for (const field of SIGNAL_FIELDS) assert.equal(reading[field], undefined, `${reading.symbol} must not carry "${field}"`);
  }
  for (const reading of readings.slice(20)) assert.equal(signalState(reading), 'daily', 'index readings do not depend on Deriv');
  assert.deepEqual(aurum.requests, [INDEX_SYMBOLS, DERIV_SYMBOLS], 'the cloud is asked for the Deriv markets only after this browser failed');
  assert.equal(reports[0].unavailable, 20);
  assert.equal(reports[0].askedCloudForDeriv, 20);
  assert.equal(reports[0].problems.length, 20);
  assert.deepEqual(Object.keys(reports[0].problems[0]).sort(), ['detail', 'state', 'symbol'], 'a problem entry is a market name, a state and a reason');
});

test('this browser is blocked but the cloud is healthy: readings come from the cloud and say so', async () => {
  for (const kind of ['connect', 'timeout', 'rate-limit', 'budget', 'no-websocket']) {
    const feed = browserFeed({ failure: () => new CandleError(kind, 'browser-side failure: ' + kind) });
    const aurum = cloud();
    const scanner = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan: aurum.cloudScan });
    const readings = await scanner.scan(DERIV_SYMBOLS);
    for (const reading of readings) {
      assert.equal(signalState(reading), 'live', `${reading.symbol} after a "${kind}" failure`);
      assert.equal(reading.computed, 'cloud');
      assert.equal(reading.data_source, DERIV_SOURCE + CLOUD_SUFFIX);
    }
    assert.deepEqual(aurum.requests, [DERIV_SYMBOLS]);
  }
});

test('a browser that cannot reach Deriv is not asked again for a minute: the cloud is asked directly, and no more often than needed', async () => {
  const world = { browserDown: true, cloudDown: false, shiftMs: 0 };
  const feed = browserFeed({ failure: () => (world.browserDown ? feedDown() : null) });
  const healthy = cloud();
  const broken = cloud({ deriv: 'down' });
  const requests = [];
  const cloudScan = (symbols) => { requests.push([...symbols]); return (world.cloudDown ? broken : healthy).cloudScan(symbols); };
  const reports = [];
  const scanner = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan, now: () => Date.now() + world.shiftMs, onScan: (report) => reports.push(report) });
  const fromCloud = (reading) => signalState(reading) === 'live' && reading.source === DERIV_SOURCE + CLOUD_SUFFIX && reading.computed === 'cloud';
  const fromBrowser = (reading) => signalState(reading) === 'live' && reading.source === BROWSER_LABEL && reading.computed === 'browser';
  const sizes = () => requests.map((symbols) => symbols.length);

  /* 0 s — the browser is tried, fails for every market, and the cloud answers instead. */
  let readings = await scanner.scan(ALL_SYMBOLS);
  assert.equal(feed.calls.length, 60, 'the browser was tried for the 20 markets');
  assert.deepEqual(sizes(), [6, 20], 'the index CFDs, then the 20 markets the browser could not read');
  assert.ok(readings.slice(0, 20).every(fromCloud));
  assert.equal(reports.at(-1).usedBrowser, true);
  assert.equal(reports.at(-1).browserPaused, false);

  /* Moments later — a second scan (another panel of the page) costs nothing: not a connection
     attempt from the browser, not a request of the cloud's rate limit. */
  readings = await scanner.scan(ALL_SYMBOLS);
  assert.equal(feed.calls.length, 60, 'no second attempt from the browser');
  assert.deepEqual(sizes(), [6, 20], 'the cloud\'s readings of a moment ago are reused');
  assert.ok(readings.slice(0, 20).every(fromCloud), 'still the cloud\'s readings, and labelled so');
  assert.deepEqual(readings.slice(20).map(signalState), Array(6).fill('daily'));
  assert.equal(reports.at(-1).usedBrowser, false);
  assert.equal(reports.at(-1).browserPaused, true);
  assert.equal(reports.at(-1).askedCloudForDeriv, 20);

  /* 25 s — readings on minute candles are older than 20 s and are asked for again: one request,
     straight to the cloud. Index readings are reused for a minute. */
  world.shiftMs = 25000;
  readings = await scanner.scan(ALL_SYMBOLS);
  assert.equal(feed.calls.length, 60);
  assert.deepEqual(sizes(), [6, 20, 20]);
  assert.ok(readings.slice(0, 20).every(fromCloud));

  /* 50 s — the cloud fails as well: both reasons are given, the browser's being the one it gave when it was tried. */
  world.shiftMs = 50000;
  world.cloudDown = true;
  const [euro] = await scanner.scan(['EUR/USD']);
  assert.equal(signalState(euro), 'unavailable');
  assert.equal(euro.detail, 'This browser: This browser could not connect to the Deriv public feed. AURUM cloud: Deriv public WebSocket connection failed');
  assert.equal(euro.data_source, 'Deriv public feed unreachable');
  assert.equal(feed.calls.length, 60);
  assert.deepEqual(sizes(), [6, 20, 20, 1]);
  world.cloudDown = false;

  /* A scan that is told to stay away from Deriv (the sign-in screen) neither uses nor changes the
     pause — and the failure of a moment ago was not kept: the cloud is asked again. */
  const [again] = await scanner.scan(['EUR/USD'], { browser: false });
  assert.ok(fromCloud(again));
  assert.deepEqual(sizes(), [6, 20, 20, 1, 1], 'a failure is never reused');
  assert.equal(reports.at(-1).usedBrowser, false);
  assert.equal(reports.at(-1).browserPaused, false);
  assert.equal(feed.calls.length, 60);

  /* 59 s — the feed is back, but the minute is not over. 61 s — the browser is tried again, and it works. */
  world.browserDown = false;
  world.shiftMs = BROWSER_RETRY_MS - 1000;
  await scanner.scan(['EUR/USD']);
  assert.equal(feed.calls.length, 60, 'still inside the minute');
  world.shiftMs = BROWSER_RETRY_MS + 1000;
  readings = await scanner.scan(DERIV_SYMBOLS);
  assert.equal(feed.calls.length, 120, 'the browser is tried again after a minute');
  assert.ok(readings.every(fromBrowser), 'and its readings replace the cloud\'s');
  assert.equal(reports.at(-1).usedBrowser, true);
  assert.equal(reports.at(-1).askedCloudForDeriv, 0);
  assert.deepEqual(sizes(), [6, 20, 20, 1, 1], 'the cloud was not asked for a market this browser can read');
});

test('a reused cloud reading is still judged by its candle time: it turns stale on schedule, not when it is asked for again', async () => {
  const world = { shiftMs: 0 };
  let asked = 0;
  /* The cloud's reading was made from candles that were already 290 seconds old. */
  const candleTime = Math.floor(Date.now() / 1000) - 290;
  const cloudScan = async (symbols) => { asked += 1; return new Map(symbols.map((symbol) => [symbol, { symbol, signal: 'WAIT', confidence: 20, source: DERIV_SOURCE, latest_candle_time: candleTime }])); };
  const scanner = createHostedScanner({ fetchCandles: browserFeed({ failure: feedDown }).fetchCandles, cloudScan, now: () => Date.now() + world.shiftMs });

  assert.equal(signalState((await scanner.scan(['EUR/USD']))[0]), 'live', '290 s old');
  world.shiftMs = 15000;
  const [reused] = await scanner.scan(['EUR/USD']);
  assert.equal(asked, 1, 'inside 20 seconds the reading is reused');
  assert.equal(signalState(reused), 'stale', 'but the candle is now 305 s old, and the reading says so');
  assert.equal(reused.signal, undefined);
});

test('the pause is for a browser that reaches nothing: one unreachable market, a market without data, or an index-only scan do not start it', async () => {
  const down = new Set(['EUR/USD']);
  const feed = browserFeed({ failure: (symbol) => (down.has(symbol) ? feedDown() : symbol === 'XAG/USD' ? new CandleError('empty', 'Deriv returned no usable candles for this market and timeframe.') : null) });
  const reports = [];
  const scanner = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan: cloud().cloudScan, onScan: (report) => reports.push(report) });

  await scanner.scan(['EUR/USD', 'GBP/USD', 'XAG/USD']);
  await scanner.scan(['XAG/USD']);          /* no data is an answer from Deriv, not an unreachable feed */
  await scanner.scan(INDEX_SYMBOLS);        /* nothing to ask Deriv */
  const before = feed.calls.length;
  const [pound] = await scanner.scan(['GBP/USD']);
  assert.equal(feed.calls.length, before + 3, 'the browser is still asked');
  assert.equal(pound.source, BROWSER_LABEL);
  assert.ok(reports.every((report) => report.browserPaused === false));
});

test('a retry asked for by a person tries the browser again at once', async () => {
  const world = { browserDown: true };
  const feed = browserFeed({ failure: () => (world.browserDown ? feedDown() : null) });
  const scanner = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan: cloud({ deriv: 'down' }).cloudScan });

  assert.equal(signalState((await scanner.scan(['EUR/USD']))[0]), 'unavailable');
  world.browserDown = false;
  assert.equal(signalState((await scanner.scan(['EUR/USD']))[0]), 'unavailable', 'paused: the browser is not asked, and the cloud is down');
  assert.equal(feed.calls.length, 3);

  scanner.retryBrowser();
  const [reading] = await scanner.scan(['EUR/USD']);
  assert.equal(signalState(reading), 'live');
  assert.equal(reading.source, BROWSER_LABEL);
  assert.equal(feed.calls.length, 6);
});

/* ---------------------------------------------------------------- stale */

test('stale: candles older than five minutes give no reading, whichever side read them', async () => {
  const twoHours = 2 * 3600;
  const inBrowser = createHostedScanner({ fetchCandles: browserFeed({ ageSec: twoHours }).fetchCandles, cloudScan: cloud().cloudScan });
  for (const reading of await inBrowser.scan(DERIV_SYMBOLS)) {
    assert.equal(signalState(reading), 'stale', reading.symbol);
    assert.equal(reading.error, 'STALE_DATA');
    assert.equal(reading.computed, 'browser');
    assert.equal(reading.data_source, DERIV_SOURCE + ' · last candle 2 h ago');
    assert.match(reading.detail, /is 2 h old, so the market is closed or the feed is paused\. No current reading is shown\.$/);
    assert.ok(reading.latest_candle_time > 0, 'the time of the last candle is kept for display');
    for (const field of SIGNAL_FIELDS) assert.equal(reading[field], undefined, `${reading.symbol} must not carry "${field}"`);
  }

  const fromCloud = createHostedScanner({ fetchCandles: browserFeed({ failure: feedDown }).fetchCandles, cloudScan: cloud({ ageSec: twoHours }).cloudScan });
  for (const reading of await fromCloud.scan(DERIV_SYMBOLS)) {
    assert.equal(signalState(reading), 'stale', reading.symbol);
    assert.equal(reading.computed, 'cloud');
    for (const field of SIGNAL_FIELDS) assert.equal(reading[field], undefined);
  }
});

test('stale: the limit is the age of the newest 1-minute candle, 300 seconds', async () => {
  assert.equal(LIVE_MAX_AGE_SEC, 300);
  const fixedNow = 1_800_000_000_000;
  const readingEndingAt = async (ageSec) => {
    const newest = fixedNow / 1000 - ageSec;
    const fetchCandles = async (symbol, granularity) => normalizeCandles(derivCandleRows({ count: 120, granularity, end: newest, base: 100 }))
      /* exact age for the 1-minute series, whatever the candle grid */
      .map((candle, index, all) => (granularity === 60 && index === all.length - 1 ? { ...candle, time: newest } : candle));
    const scanner = createHostedScanner({ fetchCandles, cloudScan: async () => new Map(), now: () => fixedNow });
    return (await scanner.scan(['EUR/USD']))[0];
  };
  assert.equal(signalState(await readingEndingAt(0)), 'live');
  assert.equal(signalState(await readingEndingAt(299)), 'live');
  assert.equal(signalState(await readingEndingAt(300)), 'live', 'exactly five minutes is still live');
  assert.equal(signalState(await readingEndingAt(301)), 'stale');
  assert.equal(signalState(await readingEndingAt(86400)), 'stale');
});

test('stale: a cloud reading without a candle time cannot be confirmed as current', async () => {
  const cloudScan = async (symbols) => new Map(symbols.map((symbol) => [symbol, { symbol, signal: 'WAIT', confidence: 20, source: DERIV_SOURCE }]));
  const scanner = createHostedScanner({ fetchCandles: browserFeed({ failure: feedDown }).fetchCandles, cloudScan });
  const [reading] = await scanner.scan(['EUR/USD']);
  assert.equal(signalState(reading), 'stale');
  assert.match(reading.detail, /carries no candle time/);
  assert.equal(reading.signal, undefined);
});

test('freshness is judged on Deriv\'s clock when live ticks show it, so a wrong device clock does not mislabel markets', async () => {
  const realNow = Date.now();
  const twentyMinutes = 20 * 60 * 1000;

  /* Device clock 20 minutes fast, candles current: without the tick clock everything would look stale. */
  const fastDevice = () => realNow + twentyMinutes;
  const tickSeenJustNow = () => ({ epochMs: realNow - 1000, seenAtMs: fastDevice() - 1000 });
  let scanner = createHostedScanner({ fetchCandles: browserFeed().fetchCandles, cloudScan: cloud().cloudScan, now: fastDevice, feedClock: tickSeenJustNow });
  assert.equal(signalState((await scanner.scan(['EUR/USD']))[0]), 'live');
  scanner = createHostedScanner({ fetchCandles: browserFeed().fetchCandles, cloudScan: cloud().cloudScan, now: fastDevice });
  assert.equal(signalState((await scanner.scan(['EUR/USD']))[0]), 'stale', 'no tick to go by: the device clock is all there is');

  /* Device clock 20 minutes slow, candles 10 minutes old: the device clock alone would call them live. */
  const slowDevice = () => realNow - twentyMinutes;
  const tenMinutesOld = browserFeed({ ageSec: 600 });
  scanner = createHostedScanner({ fetchCandles: tenMinutesOld.fetchCandles, cloudScan: cloud().cloudScan, now: slowDevice, feedClock: () => ({ epochMs: realNow, seenAtMs: slowDevice() }) });
  assert.equal(signalState((await scanner.scan(['EUR/USD']))[0]), 'stale');

  /* A tick seen long ago says nothing about the present: ignored. */
  scanner = createHostedScanner({ fetchCandles: browserFeed().fetchCandles, cloudScan: cloud().cloudScan, now: fastDevice, feedClock: () => ({ epochMs: realNow - 600000, seenAtMs: fastDevice() - 600000 }) });
  assert.equal(signalState((await scanner.scan(['EUR/USD']))[0]), 'stale');
});

test('a slow device clock and no tick: a market that has just closed is still told apart from the ones that are open', async () => {
  const realNow = Date.now();
  const slowDevice = () => realNow - 20 * 60 * 1000;
  /* USD/CAD stopped 8 minutes ago, VOL 75 is current. On this device's clock both newest candles
     lie in the future, so the device clock alone would call both of them current. */
  const fetchCandles = async (symbol, granularity) => normalizeCandles(rowsFor(symbol, granularity, symbol === 'USD/CAD' ? 480 : 0));
  const scanner = createHostedScanner({ fetchCandles, cloudScan: cloud().cloudScan, now: slowDevice });
  const [closed, open] = await scanner.scan(['USD/CAD', 'VOL 75']);
  assert.equal(signalState(open), 'live');
  assert.equal(signalState(closed), 'stale', 'compared with the newest candle of the same scan');
  assert.match(closed.detail, /^The newest 1-minute candle for USD\/CAD is 8 min old/);
  for (const field of SIGNAL_FIELDS) assert.equal(closed[field], undefined, `${field} is not shown for a closed market`);

  /* The same holds when the readings come from the cloud. */
  const viaCloud = createHostedScanner({
    fetchCandles: browserFeed({ failure: feedDown }).fetchCandles, now: slowDevice,
    cloudScan: async (symbols) => new Map(symbols.map((symbol) => [symbol, {
      symbol, signal: 'WAIT', confidence: 20, source: DERIV_SOURCE, latest_candle_time: Math.floor(realNow / 1000) - (symbol === 'USD/CAD' ? 480 : 0)
    }]))
  });
  const [closedThere, openThere] = await viaCloud.scan(['USD/CAD', 'VOL 75']);
  assert.equal(signalState(openThere), 'live');
  assert.equal(signalState(closedThere), 'stale');

  /* An index reading carries no candle time and never moves the comparison. */
  const mixed = await scanner.scan(['VOL 75', 'US30']);
  assert.deepEqual(mixed.map(signalState), ['live', 'daily']);
});

/* ---------------------------------------------------------------- no data */

/* A market that gave no price for the `pauseSec` seconds before its newest candle: the feed holds the candles from
   before the pause and the one of the price that ended it, and nothing in between. */
function resumedSets(symbol, pauseSec) {
  const now = nowSec();
  return Object.fromEntries(SCAN_TIMEFRAMES.map(([key, granularity]) => {
    const newest = Math.floor(now / granularity) * granularity;
    const candles = normalizeCandles(rowsFor(symbol, granularity)).filter((candle) => candle.time >= newest || candle.time < newest - pauseSec);
    return [key, candles];
  }));
}

test('a market that has just resumed after a pause: no live reading until a 5-minute candle of the new session has closed', async () => {
  /* EUR/USD gave its first price a moment ago, after 40 minutes without one. USD/JPY ran through. */
  const sets = { 'EUR/USD': resumedSets('EUR/USD', 2400) };
  const fetchCandles = async (symbol, granularity) => {
    const key = SCAN_TIMEFRAMES.find(([, period]) => period === granularity)[0];
    return sets[symbol] ? sets[symbol][key] : normalizeCandles(rowsFor(symbol, granularity));
  };
  const scanner = createHostedScanner({ fetchCandles, cloudScan: cloud({ deriv: 'down' }).cloudScan });
  const [eur, jpy] = await scanner.scan(['EUR/USD', 'USD/JPY']);

  /* The newest candle is seconds old, so the feed is current; but every finished candle is 40 minutes old or more. */
  assert.equal(signalState(eur), 'stale');
  assert.equal(eur.error, 'STALE_DATA');
  assert.equal(eur.computed, 'browser');
  assert.match(eur.detail, /^EUR\/USD has just resumed after a pause: no 5-minute candle has closed since, so a reading would describe the market before the pause\. The first reading comes with the next 5-minute close\.$/);
  assert.equal(eur.data_source, DERIV_SOURCE + ' \u00b7 resumed, waiting for a finished candle');
  assert.ok(eur.latest_candle_time > 0);
  for (const field of SIGNAL_FIELDS) assert.equal(eur[field], undefined, 'no ' + field + ' from before the pause');
  assert.equal(signalState(jpy), 'live');

  /* What the reading would have been: made at a close from before the pause, and it says so itself. */
  const withheld = buildDerivReading('EUR/USD', sets['EUR/USD'], Date.now());
  assert.equal(withheld.candle_current, false);
  assert.ok(withheld.latest_candle_time - withheld.candle_close >= 2400);
});

test('the same from the AURUM cloud: a reading it made from before a pause is not shown as live', async () => {
  const candleTime = nowSec();
  const cloudScan = async (symbols) => new Map(symbols.map((symbol) => [symbol, {
    symbol, signal: 'BUY', confidence: 70, entry: 1, stop_loss: 0.9, tp1: 1.15, source: DERIV_SOURCE,
    latest_candle_time: candleTime, candle_close: candleTime - 2400, candle_current: symbol !== 'EUR/USD'
  }]));
  const scanner = createHostedScanner({ fetchCandles: async () => { throw feedDown(); }, cloudScan });
  const [eur, gbp] = await scanner.scan(['EUR/USD', 'GBP/USD']);
  assert.equal(signalState(eur), 'stale');
  assert.equal(eur.computed, 'cloud');
  assert.match(eur.detail, /has just resumed after a pause/);
  assert.equal(eur.signal, undefined);
  assert.equal(signalState(gbp), 'live');
  assert.equal(gbp.signal, 'BUY');
});

/* `candle_current: false` alone does not say why a reading is not current. With the close it belongs to, the market
   has just resumed after a pause. Without one (candle_close 0) the history holds no finished 5-minute candle: that
   is missing history, and the reading is a WAIT that says so itself. */
test('a history without a finished 5-minute candle is not a pause: its WAIT is shown with its own reason, by this browser and from the cloud', async () => {
  /* EUR/USD: one candle per timeframe, the one that is forming. USD/JPY has its whole history. */
  const fetchCandles = async (symbol, granularity) => {
    const candles = normalizeCandles(rowsFor(symbol, granularity));
    return symbol === 'EUR/USD' ? candles.slice(-1) : candles;
  };
  const made = buildDerivReading('EUR/USD', Object.fromEntries(await Promise.all(SCAN_TIMEFRAMES.map(async ([key, granularity]) => [key, await fetchCandles('EUR/USD', granularity)]))), Date.now());
  assert.equal(made.candle_close, 0);
  assert.equal(made.candle_current, false);
  assert.equal(made.signal, 'WAIT');
  assert.equal(made.data_ok, false);
  assert.ok(made.wait_reason, 'the WAIT names its reason');
  assert.equal(withheldReading(made), null, 'shown as it is');

  const inBrowser = createHostedScanner({ fetchCandles, cloudScan: cloud({ deriv: 'down' }).cloudScan });
  const [eur, jpy] = await inBrowser.scan(['EUR/USD', 'USD/JPY']);
  assert.equal(signalState(eur), 'live');
  assert.equal(eur.error, undefined);
  assert.equal(eur.signal, 'WAIT');
  assert.equal(eur.wait_reason, made.wait_reason);
  assert.equal(eur.wait_detail, made.wait_detail);
  assert.equal(eur.data_ok, false);
  assert.equal(eur.data_source, BROWSER_LABEL);
  assert.equal(signalState(jpy), 'live');

  /* The same answer coming from the AURUM cloud. */
  const cloudScan = async (symbols) => new Map(symbols.map((symbol) => [symbol, { ...made, symbol }]));
  const fromCloud = createHostedScanner({ fetchCandles: async () => { throw feedDown(); }, cloudScan });
  const [viaCloud] = await fromCloud.scan(['EUR/USD']);
  assert.equal(signalState(viaCloud), 'live');
  assert.equal(viaCloud.signal, 'WAIT');
  assert.equal(viaCloud.wait_reason, made.wait_reason);
  assert.doesNotMatch(String(viaCloud.detail || '') + String(viaCloud.data_source || ''), /resumed/);
});

test('a reading marked as not current: what is shown in its place', () => {
  const at = nowSec();
  const buy = { symbol: 'EUR/USD', signal: 'BUY', confidence: 70, entry: 1, stop_loss: 0.9, tp1: 1.15, tp2: 1.3, source: DERIV_SOURCE, latest_candle_time: at, computed: 'cloud' };

  /* Nothing to withhold. */
  assert.equal(withheldReading(null), null);
  assert.equal(withheldReading({ ...buy, candle_close: at - 120, candle_current: true }), null);
  assert.equal(withheldReading(buy), null, 'an answer without the two candle fields (a server from before the 5-minute rule)');

  /* It names its close: from before a pause. */
  const resumed = withheldReading({ ...buy, candle_close: at - 2400, candle_current: false });
  assert.equal(resumed.error, 'STALE_DATA');
  assert.equal(signalState(resumed), 'stale');
  assert.match(resumed.detail, /^EUR\/USD has just resumed after a pause: /);
  assert.equal(resumed.data_source, DERIV_SOURCE + ' \u00b7 resumed, waiting for a finished candle');
  assert.equal(resumed.computed, 'cloud');
  /* The row the PC's own server sends for that state is shown as the same row. */
  const fromPcServer = { symbol: 'EUR/USD', error: 'STALE_DATA', data_state: 'stale', detail: resumed.detail, source: DERIV_SOURCE, data_source: resumed.data_source, latest_candle_time: at, candle_close: at - 2400, candle_current: false };
  assert.deepEqual(withheldReading(fromPcServer), { ...resumed, computed: undefined });

  /* It names no close and is a WAIT, or an error: shown as it is. */
  assert.equal(withheldReading({ symbol: 'EUR/USD', signal: 'WAIT', wait_reason: 'FEED_ERROR', data_ok: false, candle_close: 0, candle_current: false }), null);
  assert.equal(withheldReading({ symbol: 'EUR/USD', error: 'FEED_ERROR', detail: 'written by the test', candle_current: false }), null);

  /* It names no close and gives a direction: no server of this project sends that. It is withheld, and not called a pause. */
  for (const close of [0, undefined, null, 'not a time']) {
    const unconfirmed = withheldReading({ ...buy, candle_close: close, candle_current: false });
    assert.equal(unconfirmed.error, 'STALE_DATA');
    assert.equal(signalState(unconfirmed), 'stale');
    assert.equal(unconfirmed.detail, 'The reading for EUR/USD is marked as not current and names no 5-minute close, so it cannot be confirmed. No reading is shown.');
    assert.equal(unconfirmed.data_source, DERIV_SOURCE + ' \u00b7 not confirmed as current');
    for (const field of SIGNAL_FIELDS) assert.equal(unconfirmed[field], undefined, 'no ' + field);
  }
});

test('no data: Deriv answered but has no usable history — reported as such, and the cloud is not asked', async () => {
  for (const failure of [new CandleError('empty', 'Deriv returned no usable candles for this market and timeframe.'), new CandleError('provider', 'Symbol is not available. [InvalidSymbol]')]) {
    const feed = browserFeed({ failure: (symbol) => (symbol === 'XAG/USD' ? failure : null) });
    const aurum = cloud();
    const scanner = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan: aurum.cloudScan });
    const [silver, gold] = await scanner.scan(['XAG/USD', 'XAU/USD']);
    assert.equal(signalState(silver), 'no-data');
    assert.equal(silver.error, 'NO_DATA');
    assert.equal(silver.data_source, DERIV_SOURCE + ' · no usable history');
    assert.ok(silver.detail.includes(failure.message), 'the provider\'s own reason is passed on');
    for (const field of SIGNAL_FIELDS) assert.equal(silver[field], undefined);
    assert.equal(signalState(gold), 'live', 'one market without data does not affect the next');
    assert.deepEqual(aurum.requests, []);
  }
});

test('a market with one series missing because the feed failed is not called "no data": the cloud is asked', async () => {
  const feed = browserFeed({
    failure: (symbol, granularity) => (granularity === 60 ? new CandleError('empty', 'no candles') : granularity === 3600 ? new CandleError('timeout', 'Deriv did not answer a candle request within 8 s.') : null)
  });
  const aurum = cloud();
  const scanner = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan: aurum.cloudScan });
  const [reading] = await scanner.scan(['GBP/JPY']);
  assert.equal(signalState(reading), 'live');
  assert.equal(reading.computed, 'cloud');
  assert.deepEqual(aurum.requests, [['GBP/JPY']]);
});

/* ---------------------------------------------------------------- index CFDs and the cloud */

test('index CFDs: read by the cloud, reused for a minute, and "unavailable" with the reason when the cloud fails', async () => {
  let time = 1_800_000_000_000;
  const aurum = cloud();
  const scanner = createHostedScanner({ fetchCandles: browserFeed().fetchCandles, cloudScan: aurum.cloudScan, now: () => time });
  const first = await scanner.scan(INDEX_SYMBOLS);
  assert.ok(first.every((reading) => signalState(reading) === 'daily'));
  time += 59000;
  await scanner.scan(INDEX_SYMBOLS);
  assert.equal(aurum.requests.length, 1, 'a daily reading is not asked for again within a minute');
  time += 2000;
  await scanner.scan(INDEX_SYMBOLS);
  assert.equal(aurum.requests.length, 2);

  const yahooDown = cloud({ yahoo: 'down' });
  const failing = createHostedScanner({ fetchCandles: browserFeed().fetchCandles, cloudScan: yahooDown.cloudScan });
  for (const reading of await failing.scan(INDEX_SYMBOLS)) {
    assert.equal(signalState(reading), 'unavailable');
    assert.equal(reading.detail, 'AURUM cloud: Yahoo Finance HTTP 503');
    assert.equal(reading.signal, undefined);
  }
  await failing.scan(INDEX_SYMBOLS);
  assert.equal(yahooDown.requests.length, 2, 'a failure is never reused');
});

test('index CFDs: the day a daily reading is from reaches the page as the cloud sent it', async () => {
  const barTime = Math.floor(Date.UTC(2026, 10, 11, 14, 30) / 1000);
  const fromCloud = (symbol, final) => ({
    symbol, signal: 'WAIT', bias: 'neutral', confidence: 50, votes: 'fixture', tf: 'DAILY (index)', model: 'technical-daily',
    source: YAHOO_SOURCE, data_source: YAHOO_SOURCE, daily_bar_time: barTime, daily_bar_final: final, ts: 1
  });
  const scanner = createHostedScanner({
    fetchCandles: browserFeed().fetchCandles,
    cloudScan: async () => new Map([['US30', fromCloud('US30', true)], ['NAS100', fromCloud('NAS100', false)], ['SPX500', fromCloud('SPX500', null)]])
  });
  const [us30, nas100, spx500] = await scanner.scan(['US30', 'NAS100', 'SPX500']);
  for (const reading of [us30, nas100, spx500]) {
    assert.equal(signalState(reading), 'daily', reading.symbol);
    assert.equal(reading.data_source, YAHOO_SOURCE + CLOUD_SUFFIX, reading.symbol);
    assert.equal(reading.daily_bar_time, barTime, reading.symbol);
  }
  assert.equal(us30.daily_bar_final, true);
  assert.equal(nas100.daily_bar_final, false);
  assert.equal(spx500.daily_bar_final, null);

  /* A reading from a cloud that does not send the day yet is still a daily reading, without one. */
  const older = createHostedScanner({
    fetchCandles: browserFeed().fetchCandles,
    cloudScan: async () => new Map([['US30', { symbol: 'US30', signal: 'WAIT', confidence: 50, tf: 'DAILY (index)', model: 'technical-daily', source: YAHOO_SOURCE }]])
  });
  const [plain] = await older.scan(['US30']);
  assert.equal(signalState(plain), 'daily');
  assert.equal('daily_bar_time' in plain, false);
});

test('the day of an index reading is not a clock: a daily bar never decides whether a Deriv market is live', async () => {
  /* The newest 1-minute candles are four minutes old: live. An index reading in the same scan
     names a daily bar a full day ahead of them; were that taken for "now", every market here
     would be called stale. */
  const feed = browserFeed({ ageSec: 240 });
  const ahead = nowSec() + 86400;
  const scanner = createHostedScanner({
    fetchCandles: feed.fetchCandles,
    cloudScan: async () => new Map([['US30', { symbol: 'US30', signal: 'WAIT', confidence: 50, tf: 'DAILY (index)', model: 'technical-daily', source: YAHOO_SOURCE, daily_bar_time: ahead, daily_bar_final: false }]])
  });
  const readings = await scanner.scan(['EUR/USD', 'VOL 100', 'US30']);
  assert.equal(signalState(readings[0]), 'live');
  assert.equal(signalState(readings[1]), 'live');
  assert.equal(signalState(readings[2]), 'daily');
  assert.equal(readings[2].daily_bar_time, ahead);
});

test('the cloud refuses or does not answer (rate limit, network): index readings say why, Deriv readings are unaffected', async () => {
  const scanner = createHostedScanner({
    fetchCandles: browserFeed().fetchCandles,
    cloudScan: async () => { throw new Error('Too many requests; wait one minute and retry.'); }
  });
  const readings = await scanner.scan(['EUR/USD', 'US30', 'VOL 75', 'NAS100']);
  assert.deepEqual(readings.map(signalState), ['live', 'unavailable', 'live', 'unavailable']);
  assert.equal(readings[1].detail, 'AURUM cloud: no answer (Too many requests; wait one minute and retry.).');
  assert.equal(readings[1].data_source, 'unavailable');
});

test('a symbol the cloud does not know, duplicates and empty entries: one answer per symbol asked, never a rejection', async () => {
  const aurum = cloud();
  const scanner = createHostedScanner({ fetchCandles: browserFeed().fetchCandles, cloudScan: aurum.cloudScan });
  const readings = await scanner.scan(['EUR/USD', 'NASDAQ', 'EUR/USD', '', null, 'US30']);
  assert.deepEqual(readings.map((reading) => reading.symbol), ['EUR/USD', 'NASDAQ', 'EUR/USD', 'US30']);
  assert.equal(readings[0], readings[2], 'a symbol asked twice is read once');
  assert.equal(signalState(readings[1]), 'unavailable');
  assert.equal(readings[1].detail, 'AURUM cloud: no reading returned for NASDAQ.');
  assert.deepEqual(await scanner.scan([]), []);
  assert.deepEqual(await scanner.scan(null), []);
});

/* ---------------------------------------------------------------- sign-in screen */

test('browser: false (sign-in screen) — this browser asks Deriv nothing; one cloud request carries every symbol', async () => {
  const feed = browserFeed();
  const aurum = cloud();
  const reports = [];
  const scanner = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan: aurum.cloudScan, onScan: (report) => reports.push(report) });
  const symbols = [...DERIV_SYMBOLS.slice(0, 6), 'NAS100', 'US30', 'SPX500'];
  const readings = await scanner.scan(symbols, { browser: false });
  assert.deepEqual(feed.calls, [], 'no candle request from this browser');
  assert.deepEqual(aurum.requests, [symbols], 'a single request to the AURUM cloud');
  for (const reading of readings.slice(0, 6)) {
    assert.equal(signalState(reading), 'live');
    assert.equal(reading.data_source, DERIV_SOURCE + CLOUD_SUFFIX);
  }
  assert.equal(reports[0].usedBrowser, false);

  const down = createHostedScanner({ fetchCandles: feed.fetchCandles, cloudScan: cloud({ deriv: 'down' }).cloudScan });
  const [reading] = await down.scan(['EUR/USD'], { browser: false });
  assert.equal(signalState(reading), 'unavailable');
  assert.equal(reading.detail, 'AURUM cloud: Deriv public WebSocket connection failed');
  assert.deepEqual(feed.calls, []);
});

/* ---------------------------------------------------------------- reporting helpers */

test('a failure inside the report callback never breaks a scan', async () => {
  const scanner = createHostedScanner({ fetchCandles: browserFeed().fetchCandles, cloudScan: cloud().cloudScan, onScan: () => { throw new Error('reporting broke'); } });
  assert.equal(signalState((await scanner.scan(['EUR/USD']))[0]), 'live');
});

test('summaries count states and places of computation; readings from elsewhere have no state', () => {
  const counts = summarizeReadings([
    { symbol: 'A', data_state: 'live', computed: 'browser' }, { symbol: 'B', data_state: 'live', computed: 'cloud' },
    { symbol: 'C', data_state: 'daily', computed: 'cloud' }, { symbol: 'D', data_state: 'stale', error: 'STALE_DATA', computed: 'browser' },
    { symbol: 'E', data_state: 'no-data', error: 'NO_DATA' }, { symbol: 'F', data_state: 'unavailable', error: 'FEED_ERROR' },
    { symbol: 'G', signal: 'WAIT' }, null
  ]);
  assert.deepEqual(counts, { total: 7, live: 2, daily: 1, stale: 1, noData: 1, unavailable: 1, browser: 1, cloud: 2 });
  assert.equal(signalState({ symbol: 'G', signal: 'WAIT' }), '', 'a PC-app reading carries no cloud-viewer state');
  assert.equal(signalState(null), '');
  assert.deepEqual(summarizeReadings(null), { total: 0, live: 0, daily: 0, stale: 0, noData: 0, unavailable: 0, browser: 0, cloud: 0 });
});

test('candle age is read in seconds or milliseconds and worded for people', () => {
  const now = 1_800_000_000_000;
  assert.equal(candleAgeSec({ latest_candle_time: now / 1000 - 90 }, now), 90);
  assert.equal(candleAgeSec({ latest_candle_time: now - 90000 }, now), 90, 'a millisecond timestamp is understood');
  assert.equal(candleAgeSec({ latest_candle_time: now / 1000 + 30 }, now), 0, 'a candle from the near future is "now", not negative');
  assert.equal(candleAgeSec({ latest_candle_time: 0 }, now), null);
  assert.equal(candleAgeSec({}, now), null);
  assert.deepEqual([45, 89, 90, 600, 5399, 5400, 7200, 172799, 172800].map(ageText), ['45 s', '89 s', '2 min', '10 min', '90 min', '2 h', '2 h', '48 h', '2 days']);
});
