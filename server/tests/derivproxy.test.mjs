import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';

/* ================================================================
 * /api/deriv proxy routes against an INJECTED stub connection.
 * No network, no real token: the router only talks to conn.*.
 * ================================================================ */

process.env.ANTHROPIC_API_KEY = '';

function stubCandles(sym, g, count = 80) {
  return Array.from({ length: count }, (_, i) => ({
    time: 1700000000 + i * g, open: 1.1, high: 1.11, low: 1.09, close: 1.105, volume: 4
  }));
}

function makeConn(overrides = {}) {
  const state = {
    tradingEnabled: true, authorized: true, environment: 'demo',
    limits: { maxStakeUsd: 50, maxOpenTrades: 5, dailyLossLimitUsd: 25 },
    ...overrides
  };
  const conn = {
    wsOpen: true,
    health: () => ({
      state: state.authorized ? 'authorized' : 'connecting',
      authorized: state.authorized, environment: state.environment,
      tokenSet: true, appId: '77', endpoint: 'wss://stub', tradingEnabled: state.tradingEnabled,
      missing: [], reconnects: 0, attempt: 0, lastMessageAt: null, authError: null,
      limits: state.limits
    }),
    fetchCandles: async () => stubCandles(),
    request: async (payload) => {
      if (payload.proposal !== undefined) {
        return { msg_type: 'proposal', proposal: { id: 'p-proto-1', ask_price: payload.amount, payout: Math.round(payload.amount * 1.94 * 100) / 100, currency: 'USD' } };
      }
      if (payload.buy !== undefined) return { msg_type: 'buy', buy: { contract_id: 555001, buy_price: 10, payout: 19.4 } };
      if (payload.sell !== undefined) return { msg_type: 'sell', sell: { price: 12.5 } };
      throw new Error('unexpected payload ' + JSON.stringify(payload));
    },
    forget: async () => ({ ok: 1 }), forgetAll: async () => ({ ok: 1 }),
    on: () => conn, _send: () => true,
    start: () => {}, stop: () => {}
  };
  return conn;
}

let server, base, tmpDir, conn;
before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aurum-deriv-'));
  const store = createStore(join(tmpDir, 'store.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '' }), { apiKey: '' });
  conn = makeConn();
  const app = createApp({ store, config, feed: { symbols: {}, fetchCandles: async () => stubCandles() }, derivConn: conn });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); rmSync(tmpDir, { recursive: true, force: true }); });

const get = (p) => fetch(base + p);
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('health reports authorized state without any token material', async () => {
  const r = await get('/api/deriv/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.authorized, true);
  assert.equal(j.environment, 'demo');
  assert.equal(j.tokenSet, true);
  assert.equal(JSON.stringify(j).includes('token_'), false);
});

test('candles validated: bad symbol/granularity rejected before any upstream call', async () => {
  assert.equal((await get('/api/deriv/candles?symbol=NOTREAL&granularity=60')).status, 400);
  assert.equal((await get('/api/deriv/candles?symbol=EURUSD&granularity=7')).status, 400);
});

test('candles normalized shape from connection', async () => {
  const j = await (await get('/api/deriv/candles?symbol=EURUSD&granularity=300&count=80')).json();
  assert.ok(['deriv-auth', 'deriv-public'].includes(j.source));
  assert.ok(j.candles.length > 0);
  assert.deepEqual(Object.keys(j.candles[0]), ['time', 'open', 'high', 'low', 'close', 'volume']);
});

test('proposal -> confirm -> close flow (explicit confirm step)', async () => {
  const p = await (await post('/api/deriv/proposal', { symbol: 'EURUSD', side: 'BUY', amount: 10 })).json();
  assert.ok(p.ticket, 'ticket issued');
  assert.equal(p.requires_confirm, true);
  assert.equal(p.demo, true);
  assert.equal(p.quote.payout, 19.4);

  const bad = await post('/api/deriv/confirm', { ticket: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'ticket_expired');

  const c = await (await post('/api/deriv/confirm', { ticket: p.ticket })).json();
  assert.equal(c.ok, true);
  assert.equal(c.order.contract_id, 555001);

  const cl = await (await post('/api/deriv/close', { contract_id: 555001 })).json();
  assert.equal(cl.ok, true);
  assert.equal(cl.result.sold_for, 12.5);
});

test('server-side stake limit enforced', async () => {
  const r = await post('/api/deriv/proposal', { symbol: 'EURUSD', side: 'BUY', amount: 500 });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'stake_limit');
});

test('max open trades limit enforced', async () => {
  /* previous test opened 1 contract in this ledger; tighten limit to 1 */
  conn.health = () => makeConn().health(); // fresh conn shape
  const tight = makeConn({ limits: { maxStakeUsd: 50, maxOpenTrades: 1, dailyLossLimitUsd: 25 } });
  const { mkdtempSync: mk } = await import('fs');
  const t2 = mk(join(tmpdir(), 'aurum-deriv2-'));
  const store = createStore(join(t2, 's.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '' }), { apiKey: '' });
  const app = createApp({ store, config, feed: { symbols: {}, fetchCandles: async () => stubCandles() }, derivConn: tight });
  const s2 = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const p1 = await (await fetch(b2 + '/api/deriv/proposal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'EURUSD', side: 'BUY', amount: 5 }) })).json();
  await fetch(b2 + '/api/deriv/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: p1.ticket }) });
  const r2 = await fetch(b2 + '/api/deriv/proposal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'EURUSD', side: 'BUY', amount: 5 }) });
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).error, 'max_open_trades');
  s2.close();
  rmSync(t2, { recursive: true, force: true });
});

test('trading OFF by default -> proposal 403 trading_disabled', async () => {
  const off = makeConn({ tradingEnabled: false });
  const t3 = mkdtempSync(join(tmpdir(), 'aurum-deriv3-'));
  const store = createStore(join(t3, 's.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '' }), { apiKey: '' });
  const app = createApp({ store, config, feed: { symbols: {}, fetchCandles: async () => stubCandles() }, derivConn: off });
  const s3 = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const b3 = `http://127.0.0.1:${s3.address().port}`;
  const r = await fetch(b3 + '/api/deriv/proposal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'EURUSD', side: 'BUY', amount: 5 }) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'trading_disabled');
  /* health still available */
  assert.equal((await (await fetch(b3 + '/api/deriv/health')).json()).tradingEnabled, false);
  s3.close();
  rmSync(t3, { recursive: true, force: true });
});

test('unconfigured app: health lists missing vars, proposal 503', async () => {
  const store = createStore(join(tmpDir, 's4.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '' }), { apiKey: '' });
  const app = createApp({ store, config, feed: { symbols: {}, fetchCandles: async () => stubCandles() }, derivConn: null });
  const s4 = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const b4 = `http://127.0.0.1:${s4.address().port}`;
  const h = await (await fetch(b4 + '/api/deriv/health')).json();
  assert.equal(h.state, 'not_configured');
  assert.ok(h.missing.includes('DERIV_APP_ID') && h.missing.includes('DERIV_API_TOKEN'));
  const r = await fetch(b4 + '/api/deriv/proposal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'EURUSD', side: 'BUY', amount: 5 }) });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'not_configured');
  s4.close();
});

test('rate limit returns 429 past the per-minute cap', async () => {
  const store = createStore(join(tmpDir, 's5.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '', DERIV_PROXY_RATE_PER_MIN: '2' }), { apiKey: '' });
  const app = createApp({ store, config, feed: { symbols: {}, fetchCandles: async () => stubCandles() }, derivConn: makeConn() });
  const s5 = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const b5 = `http://127.0.0.1:${s5.address().port}`;
  const hit = () => fetch(b5 + '/api/deriv/health');
  assert.equal((await hit()).status, 200);
  assert.equal((await hit()).status, 200);
  assert.equal((await hit()).status, 429);
  s5.close();
});

test('backtest endpoint works with injected feed and rejects bad input', async () => {
  const good = await fetch(base + '/api/backtest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'EURUSD', granularity: 300, bars: 200 }) });
  assert.equal(good.status, 200);
  const j = await good.json();
  assert.ok(j.stats && j.stats.trades >= 0);
  assert.ok(j.source === 'deriv-candles' || j.source);
  const bad = await fetch(base + '/api/backtest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'FAKEX', granularity: 300 }) });
  assert.equal(bad.status, 400);
  const badG = await fetch(base + '/api/backtest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'EURUSD', granularity: 123 }) });
  assert.equal(badG.status, 400);
});
