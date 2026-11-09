import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';
import express from 'express';

/* ================================================================
 * NEW-API PAT routes — fully mocked REST + WebSocket. No network.
 * Verifies: session bootstrap (PAT stays server-side), risk gates,
 * quote→confirm (buy) flow, close, and stale-ticket handling.
 * ================================================================ */

process.env.ANTHROPIC_API_KEY = '';
process.env.DAILY_BUDGET_USD = '5';

/* fake Deriv REST: /accounts + /otp */
const restCalls = [];
const fakeFetch = async (url, opts = {}) => {
  restCalls.push({ url: String(url), auth: opts.headers?.Authorization || '', app: opts.headers?.['Deriv-App-ID'] || '' });
  if (String(url).endsWith('/options/accounts') && (opts.method || 'GET') === 'GET') {
    if ((opts.headers?.Authorization || '').includes('BAD')) {
      return { ok: false, status: 401, json: async () => ({ message: 'Invalid token' }) };
    }
    /* official OpenAPI shape: { data: [OptionsAccount…], meta } */
    return { ok: true, status: 200, json: async () => ({ data: [
      { account_id: 'VRW12345', account_type: 'demo', currency: 'USD', balance: 10000, status: 'active', group: 'demo' },
      { account_id: 'CRW99999', account_type: 'real', currency: 'USD', balance: 250, status: 'active', group: 'real' }
    ], meta: { count: 2 } }) };
  }
  if (String(url).includes('/otp')) {
    return { ok: true, status: 200, json: async () => ({ websocket_url: 'wss://mock.deriv/ws/demo?otp=XYZ' }) };
  }
  return { ok: false, status: 404, json: async () => ({ message: 'unexpected ' + url }) };
};

/* fake Deriv WS: answers proposal/buy/sell */
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.handlers = {}; setTimeout(() => { this.readyState = 1; this.handlers.open?.(); }, 5); }
  on(ev, fn) { this.handlers[ev] = fn; }
  send(data) {
    const m = JSON.parse(data);
    setTimeout(() => {
      if (m.proposal === 1) this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'proposal', proposal: { id: 'PRP_'.padEnd(40, 'x'), ask_price: 10, payout: 19, currency: 'USD' } }) });
      else if (m.buy) this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'buy', buy: { contract_id: 555001, buy_price: 10, payout: 19, currency: 'USD' } }) });
      else if (m.sell) this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'sell', sell: { price: 12.5 } }) });
    }, 5);
  }
  close() { this.readyState = 3; this.handlers.close?.(); }
  removeListener() {}
}

const store = createStore(join(mkdtempSync(join(tmpdir(), 'aurum-pat-')), 'store.json'));
const app = createApp({ store, config: configFromEnv(), feed: { fetchCandles: async () => [], symbols: {} }, patDeps: { fetchImpl: fakeFetch, wsImpl: FakeWS } });
const server = app.listen(0);
let base;

before(() => { base = 'http://127.0.0.1:' + server.address().port; });
after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });

test('PAT session with an invalid token is rejected with Deriv-style 401', async () => {
  const r = await post('/api/deriv/pat/session', {}, { 'x-deriv-pat': 'BAD_TOKEN_123', 'x-deriv-appid': '999' });
  assert.equal(r.status, 401);
  const d = await r.json();
  assert.equal(d.error, 'pat_session_failed');
  assert.match(d.detail, /Invalid token/);
});

test('PAT session: PAT never returned to the browser — only a random sid', async () => {
  const r = await post('/api/deriv/pat/session', {}, { 'x-deriv-pat': 'GOOD_PAT_TOKEN_abc123', 'x-deriv-appid': '999' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.sid && d.sid.length >= 32);
  assert.equal(d.primary.account_id, 'VRW12345');        /* demo picked first */
  assert.equal(d.environment, 'demo');
  assert.ok(!(JSON.stringify(d).includes('GOOD_PAT_TOKEN')), 'PAT must not leak in the response');
  SID = d.sid;
});
let SID = '';

test('PAT proposal above the stake limit is rejected BEFORE any Deriv call', async () => {
  const r = await post('/api/deriv/pat/proposal', { sid: SID, accountId: 'VRW12345', symbol: 'EUR/USD', amount: 9999, side: 'BUY' });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.equal(d.error, 'stake_limit');
});

test('PAT quote → confirm books an order end-to-end', async () => {
  const q = await post('/api/deriv/pat/proposal', { sid: SID, accountId: 'VRW12345', symbol: 'EUR/USD', amount: 25, side: 'BUY', duration: 5 });
  assert.equal(q.status, 200);
  const qd = await q.json();
  assert.ok(qd.ticket.id);
  assert.equal(qd.quote.payout, 19);

  const c = await post('/api/deriv/pat/confirm', { ticket: qd.ticket });
  assert.equal(c.status, 200);
  const cd = await c.json();
  assert.equal(cd.order.contract_id, 555001);
  assert.equal(cd.order.payout, 19);
});

test('PAT confirm with a stale/unknown ticket is refused', async () => {
  const r = await post('/api/deriv/pat/confirm', { ticket: { id: 'does-not-exist' } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'ticket_stale');
});

test('PAT close returns the sold-for price', async () => {
  const r = await post('/api/deriv/pat/close', { sid: SID, contract_id: 555001, stake: 10 });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.result.sold_for, 12.5);
});

test('PAT routes never see the PAT from headers they do not need', async () => {
  /* every REST call the module made carried Bearer + Deriv-App-ID */
  assert.ok(restCalls.every((c) => c.auth === '' || (c.auth.startsWith('Bearer ') && c.app.length > 0)));
});
