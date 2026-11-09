import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDerivConn, connConfigFromEnv, PING_INTERVAL_MS } from '../lib/derivconn.js';

/* ---------- WebSocket stub: emulates Deriv without any network ---------- */
class StubWS {
  static instances = [];
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.handlers = { open: [], message: [], close: [], error: [] };
    StubWS.instances.push(this);
    setTimeout(() => { this.readyState = 1; this.emit('open'); }, 5);
  }
  on(ev, cb) { (this.handlers[ev] ||= []).push(cb); }
  emit(ev, arg) { (this.handlers[ev] || []).forEach((cb) => cb(arg)); }
  send(raw) {
    const msg = JSON.parse(raw);
    const reply = (obj) => setTimeout(() => this.readyState === 1 && this.emit('message', JSON.stringify(obj)), 3);
    if (msg.authorize !== undefined) {
      reply({ msg_type: 'authorize', authorize: { loginid: 'VRTC1', currency: 'USD', fullname: 'Stub' }, echo_req: msg, req_id: msg.req_id });
    } else if (msg.proposal !== undefined) {
      reply({ msg_type: 'proposal', proposal: { id: 'p-9', ask_price: msg.amount, payout: Math.round(msg.amount * 1.94 * 100) / 100, currency: 'USD' }, req_id: msg.req_id });
    } else if (msg.ticks_history !== undefined) {
      reply({ msg_type: 'candles', candles: [{ epoch: 1700000000, open: 1.1, high: 1.11, low: 1.09, close: 1.105, volume: 3 }], req_id: msg.req_id });
    } else if (msg.forget !== undefined) {
      reply({ msg_type: 'forget', req_id: msg.req_id });
    } else {
      reply({ msg_type: 'echo', req_id: msg.req_id });
    }
  }
  close() { this.readyState = 3; this.emit('close', { code: 1006, reason: 'stub drop' }); }
}

const quiet = { info() {}, warn() {}, error() {} };

/* ---------- config / fail-fast ---------- */
test('missing vars reported by name (fail-fast state)', () => {
  const cfg = connConfigFromEnv({});
  assert.equal(cfg.configured, false);
  assert.ok(cfg.missing.includes('DERIV_APP_ID'));
  assert.ok(cfg.missing.includes('DERIV_API_TOKEN'));
});

test('token-only and app-only configs list the other var', () => {
  assert.deepEqual(connConfigFromEnv({ DERIV_APP_ID: '99' }).missing, ['DERIV_API_TOKEN']);
  assert.deepEqual(connConfigFromEnv({ DERIV_API_TOKEN: 'tok' }).missing, ['DERIV_APP_ID']);
});

test('env-only config note: classic spec endpoint recorded with fallback', () => {
  const cfg = connConfigFromEnv({ DERIV_APP_ID: '1', DERIV_API_TOKEN: 't' });
  assert.equal(cfg.configured, true);
  assert.ok(cfg.primaryUrl.includes('ws.derivws.com'));
  assert.ok(cfg.primaryUrl.includes('app_id=1'));
  assert.ok(cfg.fallbackUrl.includes('api.derivws.com'));
});

/* ---------- live behaviour against the stub ---------- */
test('connect -> authorize -> request by req_id (injected WS)', async () => {
  const conn = createDerivConn({ DERIV_APP_ID: '77', DERIV_API_TOKEN: 'tok_secret_abc', DERIV_ENVIRONMENT: 'demo' },
    { WebSocketImpl: StubWS, logger: quiet, pingIntervalMs: 60000 });
  conn.start();
  const t0 = Date.now();
  while (conn.health().state !== 'authorized' && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
  const h = conn.health();
  assert.equal(h.state, 'authorized');
  assert.equal(h.authorized, true);
  assert.ok(String(h.appId).startsWith('77'), 'appId present (masked): ' + h.appId);
  assert.equal(h.tokenSet, true);
  /* spec: health must never expose the token */
  assert.ok(!JSON.stringify(h).includes('tok_secret_abc'));
  const msg = await conn.request({ proposal: 1, amount: 10, contract_type: 'CALL', currency: 'USD', symbol: 'frxEURUSD' });
  assert.equal(msg.proposal.id, 'p-9');
  conn.stop();
});

test('not_configured request rejects before any socket exists', async () => {
  const before = StubWS.instances.length;
  const conn = createDerivConn({}, { WebSocketImpl: StubWS, logger: quiet });
  await assert.rejects(() => conn.request({ ping: 1 }), (e) => e.notConfigured === true);
  assert.equal(StubWS.instances.length, before);
  assert.equal(conn.health().state, 'not_configured');
});

test('fetchCandles normalizes to {time,open,high,low,close,volume}', async () => {
  const conn = createDerivConn({ DERIV_APP_ID: '77', DERIV_API_TOKEN: 't' },
    { WebSocketImpl: StubWS, logger: quiet, pingIntervalMs: 60000 });
  conn.start();
  const t0 = Date.now();
  while (conn.health().state !== 'authorized' && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
  const rows = await conn.fetchCandles('frxEURUSD', 300, 10);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), ['time', 'open', 'high', 'low', 'close', 'volume']);
  assert.equal(rows[0].time, 1700000000);
  conn.stop();
});

test('spec constants: ping every 30s, granularities, backoff bounds', async () => {
  assert.equal(PING_INTERVAL_MS, 30000);
  const m = await import('../lib/derivconn.js');
  assert.equal(m.BACKOFF_BASE_MS, 1000);
  assert.equal(m.BACKOFF_MAX_MS, 30000);
  assert.equal(m.DEFAULT_SPEC_WS('42'), 'wss://ws.derivws.com/websockets/v3?app_id=42');
  assert.equal(m.REQUEST_TIMEOUT_MS, 12000);
});

test('friendly errors never contain the token', async () => {
  const { friendlyDerivError } = await import('../lib/log.js');
  const e = friendlyDerivError('InvalidSymbol', 'details tok_secret_abc');
  assert.equal(typeof e, 'string');
  assert.ok(!e.includes('tok_secret_abc'));
  assert.match(e, /symbol/i);
  const generic = friendlyDerivError('SomeNewCode', 'tok_secret_abc leaked?');
  assert.ok(!generic.includes('tok_secret_abc'), 'generic message must not echo raw payload');
});
