import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';

/* ================================================================
 * Duration NEGOTIATION (regression for the user-reported
 * "Trading is not offered for this duration [ContractBuyValidationError]").
 * The mock Deriv socket:
 *   - answers contracts_for with AMBIGUOUS bare numbers ("5"/"10") —
 *     the parser must ignore them rather than guess units;
 *   - REJECTS 5m and 15m proposals with Deriv's duration error;
 *   - ACCEPTS 30m.
 * Expected: the server quotes at 30m, reports clamped+requested, and on
 * the next quote goes straight to the learned duration (1 attempt).
 * Proposals never buy anything — this loop is safe by construction.
 * ================================================================ */

process.env.ANTHROPIC_API_KEY = '';
process.env.DAILY_BUDGET_USD = '5';
process.env.DERIV_CONNECT_RATE_PER_MIN = '100';

const proposals = [];
const fakeFetch = async (url, opts = {}) => {
  if (String(url).endsWith('/options/accounts') && (opts.method || 'GET') === 'GET') {
    return { ok: true, status: 200, json: async () => ({ data: [
      { account_id: 'VRW777', account_type: 'demo', currency: 'USD', balance: 10000, status: 'active' },
      { account_id: 'CRW888', account_type: 'real', currency: 'USD', balance: 250, status: 'active' }
    ], meta: { count: 2 } }) };
  }
  if (String(url).includes('/otp')) {
    return { ok: true, status: 200, json: async () => ({ websocket_url: 'wss://mock.deriv/ws/demo?otp=XYZ' }) };
  }
  return { ok: false, status: 404, json: async () => ({ message: 'unexpected ' + url }) };
};

class NegotiatingWS {
  constructor(url) { this.url = url; this.readyState = 0; this.handlers = {}; setTimeout(() => { this.readyState = 1; this.handlers.open?.(); }, 5); }
  on(ev, fn) { this.handlers[ev] = fn; }
  send(data) {
    const m = JSON.parse(data);
    setTimeout(() => {
      if (m.contracts_for) {
        /* ambiguous bare-number durations — no units, must NOT be guessed */
        this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'contracts_for', contracts_for: { available: [{ contract_type: 'CALL', min_contract_duration: '5', max_contract_duration: '10' }, { contract_type: 'PUT', min_contract_duration: '5', max_contract_duration: '10' }] } }) });
      } else if (m.proposal === 1) {
        proposals.push(m.duration + m.duration_unit);
        const ok = m.duration === 30 && m.duration_unit === 'm';
        if (!ok) {
          this.handlers.message?.({ toString: () => JSON.stringify({ error: { code: 'ContractBuyValidationError', message: 'Trading is not offered for this duration.' }, echo_req: m, msg_type: 'error' }) });
        } else {
          this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'proposal', proposal: { id: 'PRP-30M-simulated', ask_price: 10, payout: 19, currency: 'USD' } }) });
        }
      } else if (m.buy) {
        this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'buy', buy: { contract_id: 555777, buy_price: 10, payout: 19, currency: 'USD' } }) });
      }
    }, 5);
  }
  close() { this.readyState = 3; this.handlers.close?.(); }
  removeListener() {}
}

const store = createStore(join(mkdtempSync(join(tmpdir(), 'aurum-durneg-')), 'store.json'));
const app = createApp({ store, config: configFromEnv(), feed: { fetchCandles: async () => [], symbols: {} }, patDeps: { fetchImpl: fakeFetch, wsImpl: NegotiatingWS } });
const server = app.listen(0);
let base, sid;
const H = { 'x-aurum-user': 'durneg', 'x-deriv-pat': 'NEGPAT1234567890', 'x-deriv-appid': 'TestAppID123' };

before(async () => {
  base = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(base + '/api/deriv/pat/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-deriv-pat': H['x-deriv-pat'], 'x-deriv-appid': H['x-deriv-appid'] }, body: '{}' });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  sid = j.sid;
});
after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...H }, body: JSON.stringify(body) });

test('first quote: metadata not guessed + NEGOTIATES past the duration error to 30m', async () => {
  const r = await post('/api/deriv/pat/proposal', { sid, accountId: 'VRW777', symbol: 'EUR/USD', amount: 10, side: 'BUY', duration: 5, duration_unit: 'm' });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.quote.ranges, undefined, 'bare-number durations must be ignored, not guessed');
  assert.equal(j.quote.duration, 30);
  assert.equal(j.quote.duration_unit, 'm');
  assert.equal(j.quote.clamped, true);
  assert.deepEqual(j.quote.requested, { duration: 5, unit: 'm' });
  assert.deepEqual(proposals, ['5m', '15m', '30m'], 'attempts: requested → ladder until Deriv accepts');
});

test('learned duration is reused first on the next quote (1 attempt)', async () => {
  const before = proposals.length;
  const r = await post('/api/deriv/pat/proposal', { sid, accountId: 'VRW777', symbol: 'EUR/USD', amount: 10, side: 'BUY', duration: 5, duration_unit: 'm' });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.quote.duration, 30);
  assert.equal(proposals.length - before, 1, 'goes straight to the known-good duration');
});

test('confirm still buys the negotiated quote', async () => {
  const q = await post('/api/deriv/pat/proposal', { sid, accountId: 'VRW777', symbol: 'EUR/USD', amount: 10, side: 'BUY', duration: 5, duration_unit: 'm' });
  const { ticket } = await q.json();
  const r = await post('/api/deriv/pat/confirm', { ticket });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.order.contract_id, 555777);
});
