import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPatModule } from '../lib/derivpat.js';

/* ================================================================
 * confirmSmart — three layers of defence against the user-reported
 * [InvalidContractProposal]: Deriv proposal ids are PER-CONNECTION
 * (official docs) and the trading socket gets recycled.
 *   1. pre-emptive: quote made on a connection that is no longer
 *      current → the doomed buy is NEVER attempted; re-quote instead.
 *   2. reactive: Deriv rejects the buy as invalid on a live connection
 *      → re-quote at the SAME duration, buy again on that connection.
 *   3. deep: still invalid → force a brand-new connection and buy there.
 * ================================================================ */

let connCounter = 0;
let buysByConn = {};
let acceptBuysFromConn = 1;   /* connections below this number reject buys */
let rejectFirstBuy = false;   /* per-connection first buy rejects (layer-2 case) */
let wsInstances = [];
let otpCalls = 0;

const fakeFetch = async (url, opts = {}) => {
  if (String(url).endsWith('/options/accounts') && (opts.method || 'GET') === 'GET') {
    return { ok: true, status: 200, json: async () => ({ data: [
      { account_id: 'VRW555', account_type: 'demo', currency: 'USD', balance: 10000, status: 'active' }
    ], meta: { count: 1 } }) };
  }
  if (String(url).includes('/otp')) { otpCalls++; return { ok: true, status: 200, json: async () => ({ websocket_url: 'wss://mock.deriv/ws/demo?otp=T' + otpCalls }) }; }
  return { ok: false, status: 404, json: async () => ({ message: 'unexpected' }) };
};

class SmartMockWS {
  constructor(url) {
    connCounter += 1;
    this.conn = connCounter;
    this.buys = 0;
    this.url = url; this.readyState = 0; this.handlers = {};
    wsInstances.push(this);
    setTimeout(() => { this.readyState = 1; this.handlers.open?.(); }, 5);
  }
  on(ev, fn) { this.handlers[ev] = fn; }
  send(data) {
    const m = JSON.parse(data);
    setTimeout(() => {
      if (m.contracts_for) {
        this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'contracts_for', contracts_for: { available: [] } }) });
      } else if (m.proposal === 1) {
        const ok = m.duration === 15 && m.duration_unit === 'm';
        if (!ok) this.handlers.message?.({ toString: () => JSON.stringify({ error: { code: 'TradingDurationNotAllowed', message: 'Trading is not offered for this duration.' }, echo_req: m }) });
        else this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'proposal', proposal: { id: 'PRP-C' + this.conn + '-' + Math.random().toString(36).slice(2, 6), ask_price: 10, payout: 19, currency: 'USD' } }) });
      } else if (m.buy) {
        this.buys += 1;
        buysByConn[this.conn] = (buysByConn[this.conn] || 0) + 1; /* recorded in the constructor-scoped closure — sees every connection */
        const reject = (this.conn < acceptBuysFromConn) || (rejectFirstBuy && this.buys === 1);
        if (reject) {
          this.handlers.message?.({ toString: () => JSON.stringify({ error: { code: 'InvalidContractProposal', message: 'Unknown contract proposal' }, echo_req: m }) });
        } else {
          this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'buy', buy: { contract_id: 500000 + this.conn, buy_price: 10, payout: 19, currency: 'USD' } }) });
        }
      }
    }, 5);
  }
  close() { this.readyState = 3; this.handlers.close?.(); }
  removeListener() {}
  destroy() { this.readyState = 3; this.handlers.close?.(); } /* simulate external recycle */
}

const mk = () => {
  connCounter = 0; buysByConn = {}; acceptBuysFromConn = 1; rejectFirstBuy = false; wsInstances = []; otpCalls = 0;
  return createPatModule({ fetchImpl: fakeFetch, wsImpl: SmartMockWS });
};

const CTX = { accountId: 'VRW555', derivSymbol: 'frxEURUSD', side: 'BUY', amount: 10 };
const quoteOpts = { accountId: 'VRW555', derivSymbol: 'frxEURUSD', side: 'BUY', amount: 10, duration: 15, duration_unit: 'm' };

test('layer 1 (pre-emptive): recycled connection → doomed buy NEVER attempted', async () => {
  const m = mk();
  const { sid } = await m.createSession('PATX123456', 'App1');
  const q1 = await m.quote(sid, quoteOpts);
  assert.equal(q1.connId, 1);
  wsInstances[0].destroy(); /* connection recycled between quote and confirm */
  const { order, requoted } = await m.confirmSmart(sid, q1, CTX);
  assert.equal(requoted, true);
  assert.equal(order.contract_id, 500002, 'bought on the fresh connection');
  assert.equal(buysByConn[1] || 0, 0, 'the doomed buy on the dead connection must never be attempted');
  assert.equal(buysByConn[2], 1);
  assert.ok(!wsInstances[0].buys, 'dead connection saw zero buy attempts');
});

test('layer 2 (reactive): live connection rejects the first buy → re-quote same duration, buy again there', async () => {
  const m = mk();
  const { sid } = await m.createSession('PATX123456', 'App1');
  const q1 = await m.quote(sid, quoteOpts);
  assert.equal(q1.connId, 1);
  rejectFirstBuy = true; /* conn1: buy #1 rejects, later buys accept */
  const { order, requoted } = await m.confirmSmart(sid, q1, CTX);
  assert.equal(requoted, true);
  assert.equal(order.contract_id, 500001, 'filled on the SAME connection (layer 3 never fired)');
  assert.equal(buysByConn[1], 2);
  assert.equal(Object.keys(buysByConn).length, 1, 'no new connection needed');
});

test('layer 3 (deep): still invalid after re-quote → brand-new connection fills', async () => {
  const m = mk();
  const { sid } = await m.createSession('PATX123456', 'App1');
  const q1 = await m.quote(sid, quoteOpts);
  assert.equal(q1.connId, 1);
  acceptBuysFromConn = 2; /* conn1 rejects every buy (layer-2 retry included); the forced-fresh conn2 accepts */
  const { order, requoted } = await m.confirmSmart(sid, q1, CTX);
  assert.equal(requoted, true);
  assert.equal(order.contract_id, 500002);
  assert.equal(buysByConn[1], 2, 'honest attempt + layer-2 retry on the live connection');
  assert.equal(buysByConn[2], 1, 'final buy on the forced-fresh connection');
});
