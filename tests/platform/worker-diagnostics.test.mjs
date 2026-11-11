/*
 * Cloudflare Worker — diagnostic logging of provider failures.
 *
 * When Deriv or Yahoo cannot be read, the Worker writes one structured line
 * saying which markets, which provider, how it failed and how long it took,
 * so that "source: unavailable" can be explained from the Worker's logs.
 *
 * Checked here: the line is written when and only when a provider fails, it
 * tells the failure modes apart, the answer sent to the browser is unchanged,
 * and no header, body, address or key ever reaches a log line.
 *
 * Providers are stubs; nothing reaches the network. Candle values are
 * fixtures and no assertion looks at an analysis result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';
import { DERIV_INSTRUMENTS, derivCandleRows, yahooChartFixture } from './helpers/market-fixtures.mjs';

const ORIGIN = 'https://aurum-staging.example';
const SECRETS = { ip: '203.0.113.77', key: 'sk-TEST-SECRET-KEY-VALUE', cookie: 'session=TEST-COOKIE-VALUE', auth: 'Bearer TEST-AUTH-VALUE', query: 'TEST-QUERY-VALUE' };

function setup(options = {}) {
  const logs = [];
  const worker = createReadOnlyWorker({ log: (level, event, fields = {}) => logs.push({ level, event, ...fields }), ...options });
  const allow = { limit: async () => ({ success: true }) };
  const env = { AURUM_SIGNAL_LIMITER: allow, AURUM_MARKET_LIMITER: allow, ASSETS: { fetch: async () => new Response('shell') } };
  /* Every request carries things that must never be logged. */
  const sensitive = { 'cf-connecting-ip': SECRETS.ip, 'x-ai-claude-key': SECRETS.key, cookie: SECRETS.cookie, authorization: SECRETS.auth };
  const post = (path, body) => worker.fetch(new Request(ORIGIN + path + '?token=' + SECRETS.query, {
    method: 'POST', headers: { 'content-type': 'application/json', ...sensitive }, body: JSON.stringify(body)
  }), env);
  const get = (path) => worker.fetch(new Request(ORIGIN + path + '?token=' + SECRETS.query, { headers: sensitive }), env);
  return { logs, post, get };
}

const derivOk = async (payload) => {
  if (payload.ticks_history) return { candles: derivCandleRows({ count: payload.count, granularity: payload.granularity }) };
  if (payload.active_symbols) return { active_symbols: [{ underlying_symbol: 'frxEURUSD', underlying_symbol_name: 'EUR/USD', market: 'forex', exchange_is_open: 1 }] };
  if (payload.ticks) return { tick: { quote: 1.1, epoch: Math.floor(Date.now() / 1000) } };
  throw new Error('unexpected request');
};
const derivDown = async () => { const error = new Error('Deriv public WebSocket connection failed'); error.kind = 'connect'; error.elapsedMs = 12; throw error; };
const yahooOk = async () => Response.json(yahooChartFixture());
const yahooDown = async () => { throw new Error('Yahoo Finance HTTP 503'); };

function assertNoSecret(logs) {
  const text = JSON.stringify(logs);
  for (const [name, value] of Object.entries(SECRETS)) assert.ok(!text.includes(value), `the ${name} of a request never reaches a log line`);
  assert.ok(!/cf-connecting-ip|authorization|cookie|x-ai-/i.test(text), 'no header name either');
}

/* ---------------------------------------------------------------- scan */

test('scan: when Deriv cannot be read, one line names the markets, the provider and the way it failed', async () => {
  const { logs, post } = setup({ requestImpl: derivDown, fetchImpl: yahooOk });
  const symbols = [...DERIV_INSTRUMENTS.slice(0, 11).map((instrument) => instrument.s), 'US30', 'NAS100', 'SPX500'];
  const response = await post('/api/signals/scan', { symbols });
  assert.equal(response.status, 200);
  const results = (await response.json()).results;
  assert.equal(results.filter((result) => result.error === 'FEED_ERROR').length, 11);
  assert.equal(results.filter((result) => !result.error).length, 3, 'index readings are unaffected');

  assert.equal(logs.length, 1, 'one line for the request, not one per market');
  const [line] = logs;
  assert.equal(line.level, 'warn');
  assert.equal(line.event, 'provider_feed_failed');
  assert.equal(line.route, '/api/signals/scan');
  assert.equal(line.requested, 14);
  assert.equal(line.failed, 11);
  assert.deepEqual(line.kinds, { 'deriv:connect': 11 });
  assert.deepEqual([...line.symbols].sort(), symbols.slice(0, 11).sort());
  assert.ok(Number.isFinite(line.duration_ms) && line.duration_ms >= 0);
  assert.equal(line.first.provider, 'deriv');
  assert.equal(line.first.kind, 'connect');
  assert.equal(line.first.message, 'Deriv public WebSocket connection failed');
  assert.equal(line.first.elapsed_ms, 12);
  assert.ok(JSON.stringify(line).length < 2000, 'a log line stays small');
  assertNoSecret(logs);
});

test('scan: the answer to the browser is the same with or without logging', async () => {
  const withLog = setup({ requestImpl: derivDown, fetchImpl: yahooOk });
  const silent = { post: (path, body) => createReadOnlyWorker({ requestImpl: derivDown, fetchImpl: yahooOk, log: () => {} }).fetch(new Request(ORIGIN + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { AURUM_SIGNAL_LIMITER: { limit: async () => ({ success: true }) }, AURUM_MARKET_LIMITER: { limit: async () => ({ success: true }) } }) };
  const body = { symbols: ['EUR/USD', 'XAU/USD'] };
  const a = (await (await withLog.post('/api/signals/scan', body)).json()).results;
  const b = (await (await silent.post('/api/signals/scan', body)).json()).results;
  assert.deepEqual(a, b);
  assert.deepEqual(a[0], { symbol: 'EUR/USD', error: 'FEED_ERROR', detail: 'Deriv public WebSocket connection failed', source: 'unavailable', data_source: 'unavailable' }, 'the response shape the page already understands');
});

test('scan: nothing is logged when every provider answers', async () => {
  const { logs, post } = setup({ requestImpl: derivOk, fetchImpl: yahooOk });
  const response = await post('/api/signals/scan', { symbols: ['EUR/USD', 'VOL 75', 'US30'] });
  assert.equal((await response.json()).results.filter((result) => result.error).length, 0);
  assert.deepEqual(logs, []);
});

test('scan: Deriv and Yahoo failures are counted apart', async () => {
  const { logs, post } = setup({ requestImpl: derivDown, fetchImpl: yahooDown });
  await post('/api/signals/scan', { symbols: ['EUR/USD', 'GBP/USD', 'US30'] });
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].kinds, { 'deriv:connect': 2, 'yahoo:error': 1 });
  assert.equal(logs[0].failed, 3);
  assertNoSecret(logs);
});

/* ---------------------------------------------------------------- how the Deriv connection failed */

/** A stand-in for the Workers WebSocket client: `behave(socket)` decides what the connection does. */
function workerSocket(behave) {
  return class {
    constructor(url) { this.url = url; this.listeners = {}; this.sent = []; queueMicrotask(() => behave(this)); }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    emit(type, event = {}) { for (const listener of this.listeners[type] || []) listener(event); }
    send(raw) { this.sent.push(JSON.parse(raw)); this.emit('sent'); }
    close() {}
  };
}

test('the log tells a refused connection, a closed one, a provider error and a timeout apart; the browser gets the same text as before', async (t) => {
  const cases = [
    { name: 'refused', behave: (socket) => socket.emit('error'), kind: 'connect', detail: 'Deriv public WebSocket connection failed' },
    { name: 'closed', behave: (socket) => socket.emit('close', { code: 1013 }), kind: 'closed', detail: 'Deriv public WebSocket closed before returning data', extra: { close_code: 1013 } },
    {
      name: 'provider error',
      behave: (socket) => { socket.emit('open'); socket.emit('message', { data: JSON.stringify({ error: { code: 'RateLimit', message: 'You have reached the rate limit for ticks_history.' } }) }); },
      kind: 'provider', detail: 'You have reached the rate limit for ticks_history.', extra: { provider_code: 'RateLimit' }
    }
  ];
  for (const scenario of cases) {
    const { logs, post } = setup({ WebSocketImpl: workerSocket(scenario.behave), fetchImpl: yahooOk });
    const response = await post('/api/signals/scan', { symbols: ['EUR/USD'] });
    const [result] = (await response.json()).results;
    assert.equal(result.detail, scenario.detail, `${scenario.name}: text sent to the browser`);
    assert.equal(logs.length, 1, scenario.name);
    assert.equal(logs[0].first.kind, scenario.kind, scenario.name);
    assert.deepEqual(logs[0].kinds, { ['deriv:' + scenario.kind]: 1 }, scenario.name);
    for (const [key, value] of Object.entries(scenario.extra || {})) assert.equal(logs[0].first[key], value, `${scenario.name}: ${key}`);
    assert.ok(Number.isFinite(logs[0].first.elapsed_ms), `${scenario.name}: how long the attempt took`);
  }

  /* A connection that opens and then says nothing: the Worker gives up after 10 seconds. */
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { logs, post } = setup({ WebSocketImpl: workerSocket((socket) => socket.emit('open')), fetchImpl: yahooOk });
  const pending = post('/api/signals/scan', { symbols: ['EUR/USD'] });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(10000);
  const [result] = (await (await pending).json()).results;
  assert.equal(result.detail, 'Deriv public feed timed out');
  assert.equal(logs[0].first.kind, 'timeout');
});

/* ---------------------------------------------------------------- the single-read routes */

test('analyze, catalogue, history, candles and tick each log their own failure with the route and what was asked for', async () => {
  const { logs, post, get } = setup({ requestImpl: derivDown, fetchImpl: yahooDown });

  assert.equal((await post('/api/signals/analyze', { symbol: 'XAU/USD' })).status, 502);
  assert.equal((await post('/api/signals/analyze', { symbol: 'US30' })).status, 502);
  assert.equal((await get('/api/markets/deriv')).status, 502);
  assert.equal((await post('/api/history/candles', { sym: 'EUR/USD', granularity: 3600, count: 400 })).status, 502);
  assert.equal((await post('/api/markets/deriv/candles', { code: 'frxEURUSD', granularity: 60, count: 120 })).status, 502);
  assert.equal((await post('/api/markets/deriv/tick', { code: 'frxEURUSD' })).status, 502);

  assert.deepEqual(logs.map((line) => [line.event, line.route, line.target || (line.symbols && line.symbols[0])]), [
    ['provider_feed_failed', '/api/signals/analyze', 'XAU/USD'],
    ['provider_feed_failed', '/api/signals/analyze', 'US30'],
    ['provider_feed_failed', '/api/markets/deriv', 'active_symbols'],
    ['provider_feed_failed', '/api/history/candles', 'EUR/USD'],
    ['provider_feed_failed', '/api/markets/deriv/candles', 'frxEURUSD'],
    ['provider_feed_failed', '/api/markets/deriv/tick', 'frxEURUSD']
  ]);
  for (const line of logs) {
    assert.equal(line.level, 'warn');
    assert.equal(line.failed, 1);
    assert.ok(line.first.kind && line.first.message, 'kind and message of the failure');
  }
  assert.equal(logs[1].first.provider, 'yahoo');
  assertNoSecret(logs);
});

test('the single-read routes log nothing when the provider answers, and nothing for a request they refuse themselves', async () => {
  const { logs, post, get } = setup({ requestImpl: derivOk, fetchImpl: yahooOk });
  assert.equal((await post('/api/signals/analyze', { symbol: 'EUR/USD' })).status, 200);
  assert.equal((await get('/api/markets/deriv')).status, 200);
  assert.equal((await post('/api/history/candles', { sym: 'EUR/USD', granularity: 3600, count: 400 })).status, 200);
  assert.equal((await post('/api/markets/deriv/tick', { code: 'frxEURUSD' })).status, 200);
  assert.equal((await post('/api/signals/analyze', { symbol: 'NOT A SYMBOL' })).status, 400);
  assert.equal((await post('/api/history/candles', { sym: 'EUR/USD', granularity: 7, count: 400 })).status, 400);
  assert.equal((await post('/api/markets/deriv/tick', { code: 'not-listed' })).status, 400);
  assert.deepEqual(logs, []);
});
