/*
 * Candle history client of the cloud viewer (src/derivhistory.js).
 *
 * The cloud viewer analyses the Deriv-backed markets in the browser, so this
 * client is what stands between a visitor and "No data". The tests check the
 * transport: which market code is requested for which instrument, that one
 * connection carries a whole scan, that answers are matched by req_id, and
 * what happens when the feed fails, refuses or stays silent.
 *
 * The socket is a stand-in driven by the test; nothing reaches the network.
 * Candle values are fixtures and no assertion looks at an analysis result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandleClient, normalizeCandles, isFeedFailure, ttlFor, CandleError, GRANULARITIES } from '../../src/derivhistory.js';
import { DERIV_PUBLIC_URL } from '../../src/marketdata.js';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';
import { DERIV_INSTRUMENTS, INDEX_INSTRUMENTS, derivCandleRows, basePriceFor, fakeSocketClass, nowSec } from './helpers/market-fixtures.mjs';

const SCAN_GRANULARITIES = [60, 300, 3600];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A feed that answers every candle request on the next macrotask with that market's fixture series. */
function answeringFeed(options = {}) {
  return fakeSocketClass({
    ...options,
    onRequest: (socket, message) => setTimeout(() => socket.reply({
      msg_type: 'candles', req_id: message.req_id, echo_req: message,
      candles: derivCandleRows({ count: message.count, granularity: message.granularity, base: basePriceFor(message.ticks_history) })
    }), 0)
  });
}

/** A clock the test moves by hand. */
function manualClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/* ---------------------------------------------------------------- the 20 instruments */

test('the instruments of the "No data" report are the 20 built-in markets with a Deriv public feed', () => {
  assert.deepEqual(DERIV_INSTRUMENTS.map((instrument) => instrument.s).sort(), [
    'AUD/USD', 'BOOM 1000', 'BTC/USD', 'CRASH 1000', 'ETH/USD', 'EUR/GBP', 'EUR/JPY', 'EUR/USD', 'GBP/JPY', 'GBP/USD',
    'NZD/USD', 'STEP', 'USD/CAD', 'USD/CHF', 'USD/JPY', 'VOL 100', 'VOL 25', 'VOL 75', 'XAG/USD', 'XAU/USD'
  ]);
  assert.equal(new Set(DERIV_INSTRUMENTS.map((instrument) => instrument.deriv)).size, 20, 'every instrument has its own Deriv market code');
  for (const instrument of DERIV_INSTRUMENTS) assert.match(instrument.deriv, /^[A-Za-z0-9_]{2,32}$/, instrument.s);
});

for (const instrument of DERIV_INSTRUMENTS) {
  test(`${instrument.s}: 1m, 5m and 1h candles are requested as ${instrument.deriv} and come back validated`, async () => {
    const { FakeSocket, sockets } = answeringFeed();
    const client = createCandleClient({ WebSocketImpl: FakeSocket, lingerMs: 5 });
    try {
      const series = await Promise.all(SCAN_GRANULARITIES.map((granularity) => client.fetchCandles(instrument.s, granularity, 120)));
      assert.equal(sockets.length, 1, 'one connection for the three series');
      assert.equal(sockets[0].url, DERIV_PUBLIC_URL);
      assert.deepEqual(sockets[0].sent.map((message) => message.ticks_history), [instrument.deriv, instrument.deriv, instrument.deriv]);
      assert.deepEqual(sockets[0].sent.map((message) => message.granularity), SCAN_GRANULARITIES);
      for (const message of sockets[0].sent) {
        assert.deepEqual(Object.keys(message).sort(), ['count', 'end', 'granularity', 'req_id', 'style', 'ticks_history'], 'a public, read-only history request and nothing else');
        assert.equal(message.style, 'candles');
        assert.equal(message.end, 'latest');
        assert.equal(message.count, 120);
      }
      for (const [index, candles] of series.entries()) {
        assert.equal(candles.length, 120);
        const expected = derivCandleRows({ count: 120, granularity: SCAN_GRANULARITIES[index], base: basePriceFor(instrument.deriv) });
        assert.deepEqual(candles.at(-1), { time: expected.at(-1).epoch, open: expected.at(-1).open, high: expected.at(-1).high, low: expected.at(-1).low, close: expected.at(-1).close, volume: 0 });
      }
    } finally { client.close(); }
  });
}

test('index CFDs have no Deriv candle feed: refused without opening a connection', async () => {
  const { FakeSocket, sockets } = answeringFeed();
  const client = createCandleClient({ WebSocketImpl: FakeSocket });
  assert.equal(INDEX_INSTRUMENTS.length, 6);
  for (const instrument of INDEX_INSTRUMENTS) {
    await assert.rejects(client.fetchCandles(instrument.s, 60, 120), (error) => error instanceof CandleError && error.kind === 'unmapped' && !isFeedFailure(error));
  }
  await assert.rejects(client.fetchCandles('NOT/LISTED', 60, 120), { kind: 'unmapped' });
  assert.equal(sockets.length, 0);
});

/* ---------------------------------------------------------------- one connection, matched by req_id */

test('a full scan (20 markets x 3 timeframes) uses ONE connection, at most six requests in flight, and matches answers by req_id', async () => {
  const waiting = [];
  let mostInFlight = 0;
  const { FakeSocket, sockets } = fakeSocketClass({
    onRequest: (socket, message) => {
      waiting.push(message);
      mostInFlight = Math.max(mostInFlight, waiting.length);
      /* Answer in the opposite order to the one the requests arrived in. */
      setTimeout(() => {
        for (const request of waiting.splice(0).reverse()) {
          socket.reply({ msg_type: 'candles', req_id: request.req_id, candles: derivCandleRows({ count: request.count, granularity: request.granularity, base: basePriceFor(request.ticks_history) }) });
        }
      }, 0);
    }
  });
  const client = createCandleClient({ WebSocketImpl: FakeSocket, lingerMs: 5 });
  try {
    const jobs = [];
    for (const instrument of DERIV_INSTRUMENTS) for (const granularity of SCAN_GRANULARITIES) jobs.push({ instrument, granularity });
    const results = await Promise.all(jobs.map((job) => client.fetchCandles(job.instrument.s, job.granularity, 120)));

    assert.equal(sockets.length, 1, 'sixty series, one connection');
    assert.equal(sockets[0].sent.length, 60);
    assert.ok(mostInFlight <= 6, `never more than six requests awaiting an answer (saw ${mostInFlight})`);
    assert.equal(new Set(sockets[0].sent.map((message) => message.req_id)).size, 60, 'every request has its own req_id');
    for (const [index, job] of jobs.entries()) {
      const expected = derivCandleRows({ count: 120, granularity: job.granularity, base: basePriceFor(job.instrument.deriv) });
      assert.equal(results[index].at(-1).close, expected.at(-1).close, `${job.instrument.s} ${job.granularity}s got its own series, not a neighbour's`);
      assert.equal(results[index].at(-1).time, expected.at(-1).epoch);
    }
    const stats = client.stats();
    assert.equal(stats.connections, 1);
    assert.equal(stats.sent, 60);
    assert.equal(stats.answered, 60);
    assert.deepEqual(stats.failed, {});
  } finally { client.close(); }
});

test('an answer is accepted by echo_req.req_id too; unknown ids, other traffic and broken frames are ignored', async () => {
  const { FakeSocket, sockets } = fakeSocketClass({
    onRequest: (socket, message) => setTimeout(() => {
      socket.reply('not json at all');
      socket.reply({ msg_type: 'tick', tick: { symbol: 'frxEURUSD', quote: 1 } });
      socket.reply({ msg_type: 'candles', req_id: 999999, candles: derivCandleRows({ count: 60, base: 1 }) });
      socket.reply({ msg_type: 'candles', echo_req: { req_id: message.req_id }, candles: derivCandleRows({ count: 60, base: 7 }) });
    }, 0)
  });
  const client = createCandleClient({ WebSocketImpl: FakeSocket, lingerMs: 5 });
  try {
    const candles = await client.fetchCandles('EUR/USD', 60, 60);
    assert.equal(candles.length, 60);
    assert.equal(candles.at(-1).close, derivCandleRows({ count: 60, base: 7 }).at(-1).close, 'the series addressed to this request');
    assert.equal(sockets.length, 1);
  } finally { client.close(); }
});

/* ---------------------------------------------------------------- cache, dedup, linger */

test('identical requests share one fetch; a series is reused for its period and fetched again afterwards', async () => {
  const clock = manualClock();
  const { FakeSocket, sockets } = answeringFeed();
  const client = createCandleClient({ WebSocketImpl: FakeSocket, now: clock.now, lingerMs: 5 });
  const sent = () => sockets.reduce((total, socket) => total + socket.sent.length, 0);
  try {
    assert.deepEqual([ttlFor(60), ttlFor(300), ttlFor(3600)], [20000, 60000, 300000], 'the same reuse periods as the PC server');
    const [a, b, c] = await Promise.all([client.fetchCandles('EUR/USD', 60, 120), client.fetchCandles('EUR/USD', 60, 120), client.fetchCandles('EUR/USD', 60, 120)]);
    assert.equal(sent(), 1, 'three callers, one request');
    assert.equal(a, b);
    assert.equal(b, c);

    clock.advance(19000);
    assert.equal(await client.fetchCandles('EUR/USD', 60, 120), a, 'still inside the 20 second period');
    assert.equal(sent(), 1);

    clock.advance(2000);
    await client.fetchCandles('EUR/USD', 60, 120);
    assert.equal(sent(), 2, 'older than the period: asked again');

    await client.fetchCandles('GBP/USD', 60, 120);
    await client.fetchCandles('EUR/USD', 300, 120);
    assert.equal(sent(), 4, 'another market or timeframe is its own request');
  } finally { client.close(); }
});

test('an idle connection is kept briefly for the next request and then closed', async () => {
  const { FakeSocket, sockets } = answeringFeed();
  const client = createCandleClient({ WebSocketImpl: FakeSocket, lingerMs: 40 });
  try {
    await client.fetchCandles('EUR/USD', 60, 120);
    assert.equal(sockets[0].closedByPage, false, 'kept open after the answer');
    await client.fetchCandles('GBP/USD', 60, 120);
    assert.equal(sockets.length, 1, 'the next request reuses it');
    await sleep(90);
    assert.equal(sockets[0].closedByPage, true, 'closed once nothing more was asked');
    assert.equal(client.stats().connected, false);
    await client.fetchCandles('USD/JPY', 60, 120);
    assert.equal(sockets.length, 2, 'a later request opens a new connection');
  } finally { client.close(); }
});

/* ---------------------------------------------------------------- answers without usable data */

test('a provider error, an empty answer and malformed bars are reported as "no data", never cached and never invented', async () => {
  let mode = 'error';
  const { FakeSocket, sockets } = fakeSocketClass({
    onRequest: (socket, message) => setTimeout(() => {
      if (mode === 'error') socket.reply({ msg_type: 'candles', req_id: message.req_id, error: { code: 'MarketIsClosed', message: 'This market is presently closed.' } });
      else if (mode === 'empty') socket.reply({ msg_type: 'candles', req_id: message.req_id, candles: [] });
      else if (mode === 'malformed') socket.reply({ msg_type: 'candles', req_id: message.req_id, candles: [{ epoch: nowSec(), open: 'x', high: 2, low: 1, close: 1.5 }, { epoch: nowSec(), open: 2, high: 1, low: 3, close: 2 }, { epoch: 0, open: 1, high: 1, low: 1, close: 1 }, null] });
      else socket.reply({ msg_type: 'candles', req_id: message.req_id, candles: derivCandleRows({ count: 60 }) });
    }, 0)
  });
  const client = createCandleClient({ WebSocketImpl: FakeSocket, lingerMs: 5 });
  try {
    await assert.rejects(client.fetchCandles('XAU/USD', 60, 120), (error) => error.kind === 'provider' && /presently closed/.test(error.message) && /\[MarketIsClosed\]/.test(error.message) && !isFeedFailure(error));
    mode = 'empty';
    await assert.rejects(client.fetchCandles('XAU/USD', 60, 120), (error) => error.kind === 'empty' && !isFeedFailure(error));
    mode = 'malformed';
    await assert.rejects(client.fetchCandles('XAU/USD', 60, 120), { kind: 'empty' });
    mode = 'ok';
    assert.equal((await client.fetchCandles('XAU/USD', 60, 120)).length, 60, 'a failure is never cached: the next call asks again');
    assert.equal(sockets.reduce((total, socket) => total + socket.sent.length, 0), 4);
  } finally { client.close(); }
});

test('bars are validated by the same rule as the Cloudflare Worker', async () => {
  const good = derivCandleRows({ count: 40, base: 1.2 });
  const raw = [
    ...good,
    { epoch: nowSec(), open: '1.2', high: '1.3', low: '1.1', close: '1.25' },   /* numbers as text: accepted */
    { epoch: nowSec(), open: 1, high: 0.5, low: 0.4, close: 0.9 },             /* high below open */
    { epoch: nowSec(), open: 1, high: 2, low: 1.5, close: 1.2 },               /* low above open */
    { epoch: nowSec(), open: -1, high: 2, low: -2, close: 1 },                 /* not positive */
    { epoch: 'never', open: 1, high: 2, low: 0.5, close: 1 },                  /* no time */
    { epoch: nowSec(), open: 1, high: 2, low: 0.5 },                           /* no close */
    null
  ];
  const worker = createReadOnlyWorker({ requestImpl: async () => ({ candles: raw }), fetchImpl: async () => { throw new Error('not used'); }, log: () => {} });
  const allow = { limit: async () => ({ success: true }) };
  const response = await worker.fetch(new Request('https://aurum-test.workers.dev/api/history/candles', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sym: 'EUR/USD', granularity: 60, count: 400 })
  }), { AURUM_SIGNAL_LIMITER: allow, AURUM_MARKET_LIMITER: allow });
  assert.equal(response.status, 200);
  const fromWorker = (await response.json()).candles;
  const fromBrowser = normalizeCandles(raw);
  assert.equal(fromBrowser.length, 41, 'forty fixture bars plus the one written as text');
  assert.deepEqual(fromBrowser, fromWorker);
  assert.deepEqual(normalizeCandles(null), []);
  assert.deepEqual(normalizeCandles('candles'), []);
});

test('invalid requests are refused before anything is sent', async () => {
  const { FakeSocket, sockets } = answeringFeed();
  const client = createCandleClient({ WebSocketImpl: FakeSocket });
  assert.ok(GRANULARITIES.includes(60) && GRANULARITIES.includes(300) && GRANULARITIES.includes(3600));
  await assert.rejects(client.fetchCandles('EUR/USD', 30, 120), { kind: 'invalid' });
  await assert.rejects(client.fetchCandles('EUR/USD', 61, 120), { kind: 'invalid' });
  await assert.rejects(client.fetchCandles('EUR/USD', 60, 0), { kind: 'invalid' });
  await assert.rejects(client.fetchCandles('EUR/USD', 60, 5000), { kind: 'invalid' });
  await assert.rejects(client.fetchCandlesByCode('frx EURUSD; drop', 60, 120), { kind: 'invalid' });
  await assert.rejects(client.fetchCandlesByCode('', 60, 120), { kind: 'invalid' });
  assert.equal(sockets.length, 0);
});

/* ---------------------------------------------------------------- the feed refuses, fails or stays silent */

test('rate limit: the rejected burst stops, later requests wait out a pause, and a second rejection doubles the pause', async () => {
  const clock = manualClock();
  let refuse = true;
  const { FakeSocket, sockets } = fakeSocketClass({
    onRequest: (socket, message) => setTimeout(() => {
      if (refuse) socket.reply({ msg_type: 'candles', req_id: message.req_id, error: { code: 'RateLimit', message: 'You have reached the rate limit for ticks_history.' } });
      else socket.reply({ msg_type: 'candles', req_id: message.req_id, candles: derivCandleRows({ count: 60 }) });
    }, 0)
  });
  const client = createCandleClient({ WebSocketImpl: FakeSocket, now: clock.now, maxInFlight: 2, lingerMs: 5 });
  const sent = () => sockets.reduce((total, socket) => total + socket.sent.length, 0);
  try {
    const burst = await Promise.allSettled(DERIV_INSTRUMENTS.slice(0, 8).map((instrument) => client.fetchCandles(instrument.s, 60, 120)));
    assert.ok(burst.every((result) => result.status === 'rejected' && result.reason.kind === 'rate-limit' && isFeedFailure(result.reason)), 'the whole burst is reported as rate limited');
    assert.equal(sent(), 2, 'the six requests still queued were never sent');
    const paused = client.stats().pausedUntil;
    assert.equal(paused, clock.now() + 30000, 'one 30 second pause for the rejected burst, not one per rejected request');

    await assert.rejects(client.fetchCandles('STEP', 60, 120), { kind: 'rate-limit' });
    assert.equal(sent(), 2, 'nothing is sent during the pause');

    clock.advance(30001);
    await assert.rejects(client.fetchCandles('STEP', 60, 120), { kind: 'rate-limit' });
    assert.equal(sent(), 3, 'asked again once the pause is over');
    assert.equal(client.stats().pausedUntil, clock.now() + 60000, 'rejected again: the pause doubles');

    clock.advance(60001);
    refuse = false;
    assert.equal((await client.fetchCandles('STEP', 60, 120)).length, 60);
    assert.equal(client.stats().pausedUntil, 0);
    refuse = true;
    await assert.rejects(client.fetchCandles('VOL 75', 60, 120), { kind: 'rate-limit' });
    assert.equal(client.stats().pausedUntil, clock.now() + 30000, 'after a success the pause starts from 30 seconds again');
  } finally { client.close(); }
});

test('the client never sends more than its own per-minute budget, whatever the page asks for', async () => {
  const clock = manualClock();
  const { FakeSocket, sockets } = answeringFeed();
  const client = createCandleClient({ WebSocketImpl: FakeSocket, now: clock.now, budgetPerMinute: 5, lingerMs: 5 });
  const sent = () => sockets.reduce((total, socket) => total + socket.sent.length, 0);
  try {
    const results = await Promise.allSettled(DERIV_INSTRUMENTS.slice(0, 9).map((instrument) => client.fetchCandles(instrument.s, 60, 120)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 5);
    const refused = results.filter((result) => result.status === 'rejected');
    assert.equal(refused.length, 4);
    assert.ok(refused.every((result) => result.reason.kind === 'budget' && isFeedFailure(result.reason)));
    assert.equal(sent(), 5);
    assert.equal(client.stats().sentLastMinute, 5);

    clock.advance(61000);
    assert.equal((await client.fetchCandles('STEP', 60, 120)).length, 120, 'a minute later the budget is free again');
    assert.equal(sent(), 6);
  } finally { client.close(); }
  assert.ok(createCandleClient({ WebSocketImpl: FakeSocket }).stats().budgetPerMinute < 220, 'the default budget stays below the 220 requests per minute Deriv publishes');
});

test('a connection that fails once is retried once on a fresh connection', async () => {
  let attempt = 0;
  const sockets = [];
  class FlakySocket {
    constructor(url) {
      this.url = url; this.sent = []; this.readyState = 0; sockets.push(this);
      const first = attempt++ === 0;
      queueMicrotask(() => {
        if (first) { this.readyState = 3; this.onerror && this.onerror({}); return; }
        this.readyState = 1; this.onopen && this.onopen({});
      });
    }
    send(raw) {
      const message = JSON.parse(raw); this.sent.push(message);
      setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ msg_type: 'candles', req_id: message.req_id, candles: derivCandleRows({ count: 60 }) }) }), 0);
    }
    close() { this.readyState = 3; }
  }
  const client = createCandleClient({ WebSocketImpl: FlakySocket, retryDelayMs: 5, lingerMs: 5 });
  try {
    const series = await Promise.all(SCAN_GRANULARITIES.map((granularity) => client.fetchCandles('EUR/USD', granularity, 120)));
    assert.ok(series.every((candles) => candles.length === 60));
    assert.equal(sockets.length, 2, 'the first connection failed, the second one served all three requests');
    assert.equal(sockets[0].sent.length, 0);
    assert.equal(sockets[1].sent.length, 3);
  } finally { client.close(); }
});

test('a feed that cannot be reached: two connection attempts, then a clear failure and nothing left waiting', async () => {
  const { FakeSocket, sockets } = fakeSocketClass({ failOnConnect: true });
  const client = createCandleClient({ WebSocketImpl: FakeSocket, retryDelayMs: 5, lingerMs: 5 });
  const results = await Promise.allSettled(DERIV_INSTRUMENTS.map((instrument) => client.fetchCandles(instrument.s, 60, 120)));
  assert.equal(results.length, 20);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.kind === 'connect' && isFeedFailure(result.reason)));
  assert.match(results[0].reason.message, /could not connect to the Deriv public feed/);
  assert.equal(sockets.length, 2, 'one attempt and one retry, not one connection per market');
  const stats = client.stats();
  assert.equal(stats.queued, 0);
  assert.equal(stats.pending, 0);
  assert.equal(stats.failed.connect, 20);
  assert.equal(stats.lastFailure.kind, 'connect');
  client.close();
});

test('a connection that opens but never answers is given up after the request timeout, with one retry', async () => {
  const { FakeSocket, sockets } = fakeSocketClass({ onRequest: () => { /* silence */ } });
  const client = createCandleClient({ WebSocketImpl: FakeSocket, requestTimeoutMs: 25, retryDelayMs: 5, lingerMs: 5 });
  const started = Date.now();
  const results = await Promise.allSettled(DERIV_INSTRUMENTS.map((instrument) => client.fetchCandles(instrument.s, 60, 120)));
  const elapsed = Date.now() - started;
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.kind === 'timeout' && isFeedFailure(result.reason)));
  assert.match(results[0].reason.message, /did not answer/);
  assert.equal(sockets.length, 2, 'the silent connection is replaced once');
  assert.ok(sockets.every((socket) => socket.closedByPage), 'silent connections are closed, not left open');
  assert.ok(elapsed < 1000, `twenty requests fail together, not one timeout after another (${elapsed} ms)`);
  client.close();
});

test('a connection that never opens is given up after the connect timeout, with one retry', async () => {
  const { FakeSocket, sockets } = fakeSocketClass({ autoOpen: false });
  const client = createCandleClient({ WebSocketImpl: FakeSocket, connectTimeoutMs: 20, retryDelayMs: 5, lingerMs: 5 });
  await assert.rejects(client.fetchCandles('EUR/USD', 60, 120), (error) => error.kind === 'connect' && /did not accept a connection/.test(error.message));
  assert.equal(sockets.length, 2);
  assert.ok(sockets.every((socket) => socket.closedByPage));
  client.close();
});

test('a connection closed by the feed mid-scan: unanswered and unsent requests continue on a new connection', async () => {
  let served = 0;
  const { FakeSocket, sockets } = fakeSocketClass({
    onRequest: (socket, message) => setTimeout(() => {
      /* The first connection answers two requests and is then closed by the server. */
      if (sockets.indexOf(socket) === 0 && served >= 2) { if (socket.readyState === 1) socket.drop(1011); return; }
      served += 1;
      socket.reply({ msg_type: 'candles', req_id: message.req_id, candles: derivCandleRows({ count: 60, base: basePriceFor(message.ticks_history) }) });
    }, 0)
  });
  const client = createCandleClient({ WebSocketImpl: FakeSocket, maxInFlight: 3, retryDelayMs: 5, lingerMs: 5 });
  try {
    const wanted = DERIV_INSTRUMENTS.slice(0, 7);
    const results = await Promise.all(wanted.map((instrument) => client.fetchCandles(instrument.s, 60, 120)));
    assert.equal(sockets.length, 2);
    for (const [index, instrument] of wanted.entries()) {
      assert.equal(results[index].at(-1).close, derivCandleRows({ count: 60, base: basePriceFor(instrument.deriv) }).at(-1).close, instrument.s);
    }
  } finally { client.close(); }
});

test('an answer that arrives after its request was given up is ignored', async () => {
  let firstSocket = null;
  let heldBack = null;
  const { FakeSocket, sockets } = fakeSocketClass({
    onRequest: (socket, message) => {
      if (!firstSocket) { firstSocket = socket; heldBack = message; return; } /* first connection: silence */
      setTimeout(() => socket.reply({ msg_type: 'candles', req_id: message.req_id, candles: derivCandleRows({ count: 60, base: 9 }) }), 0);
    }
  });
  const client = createCandleClient({ WebSocketImpl: FakeSocket, requestTimeoutMs: 20, retryDelayMs: 5, lingerMs: 5 });
  try {
    const candles = await client.fetchCandles('EUR/USD', 60, 120);
    assert.equal(sockets.length, 2);
    assert.equal(candles.at(-1).close, derivCandleRows({ count: 60, base: 9 }).at(-1).close);
    /* The abandoned connection finally answers the old request id: nothing may change. */
    firstSocket.reply({ msg_type: 'candles', req_id: heldBack.req_id, candles: derivCandleRows({ count: 60, base: 1 }) });
    assert.equal(await client.fetchCandles('EUR/USD', 60, 120), candles, 'the cached series is untouched');
    assert.equal(client.stats().answered, 1);
  } finally { client.close(); }
});

test('without a WebSocket implementation the failure is immediate and says so', async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  t.after(() => { globalThis.WebSocket = original; });
  const client = createCandleClient();
  await assert.rejects(client.fetchCandles('EUR/USD', 60, 120), (error) => error.kind === 'no-websocket' && isFeedFailure(error));
});

test('close() fails whatever is still waiting; the diagnostics carry counters only', async () => {
  const { FakeSocket } = fakeSocketClass({ onRequest: () => { /* never answers */ } });
  const client = createCandleClient({ WebSocketImpl: FakeSocket, requestTimeoutMs: 5000 });
  const waiting = Promise.allSettled([client.fetchCandles('EUR/USD', 60, 120), client.fetchCandles('GBP/USD', 60, 120)]);
  await sleep(5);
  client.close();
  const results = await waiting;
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.kind === 'connect'));
  const stats = client.stats();
  assert.deepEqual(Object.keys(stats).sort(), ['answered', 'budgetPerMinute', 'cached', 'connected', 'connections', 'failed', 'lastFailure', 'pausedUntil', 'pending', 'queued', 'sent', 'sentLastMinute']);
  assert.ok(!/frx|EUR|GBP/.test(JSON.stringify(stats)), 'no market, price or candle in the diagnostics');
});
