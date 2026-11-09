import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';

/* ================================================================
 * Live-failure regressions from the user's real PAT session:
 *   1) crypto on Deriv's new options API has NO Rise/Fall contracts
 *      (verified vs active_symbols) → immediate honest error;
 *   2) proposal ids are PER-CONNECTION (official docs) → when Deriv
 *      answers [InvalidContractProposal] at confirm, the server must
 *      re-quote at the SAME accepted duration and buy in one breath
 *      on the current connection (requoted:true), not fail the order.
 * ================================================================ */

process.env.ANTHROPIC_API_KEY = '';
process.env.DAILY_BUDGET_USD = '5';
process.env.DERIV_CONNECT_RATE_PER_MIN = '100';

let buyAttempts = 0;
const proposals = []; /* every proposal request the mock saw */
const fakeFetch = async (url, opts = {}) => {
  if (String(url).endsWith('/options/accounts') && (opts.method || 'GET') === 'GET') {
    return { ok: true, status: 200, json: async () => ({ data: [
      { account_id: 'VRW999', account_type: 'demo', currency: 'USD', balance: 10000, status: 'active' }
    ], meta: { count: 1 } }) };
  }
  if (String(url).includes('/otp')) {
    return { ok: true, status: 200, json: async () => ({ websocket_url: 'wss://mock.deriv/ws/demo?otp=XYZ' }) };
  }
  return { ok: false, status: 404, json: async () => ({ message: 'unexpected ' + url }) };
};

class FlakyBuyWS {
  constructor(url) { this.url = url; this.readyState = 0; this.handlers = {}; setTimeout(() => { this.readyState = 1; this.handlers.open?.(); }, 5); }
  on(ev, fn) { this.handlers[ev] = fn; }
  send(data) {
    const m = JSON.parse(data);
    setTimeout(() => {
      if (m.contracts_for) {
        this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'contracts_for', contracts_for: { available: [] } }) });
      } else if (m.proposal === 1) {
        proposals.push(m.duration + m.duration_unit + '@' + m.underlying_symbol);
        const ok = m.underlying_symbol === 'frxEURUSD'
          ? (m.duration === 30 && m.duration_unit === 'm')
          : (m.duration === 1 && m.duration_unit === 'd'); /* GBP/USD: limited lineup — only 1d */
        if (!ok) this.handlers.message?.({ toString: () => JSON.stringify({ error: { code: 'TradingDurationNotAllowed', message: 'Trading is not offered for this duration.' }, echo_req: m }) });
        else this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'proposal', proposal: { id: 'PRP-' + Math.random().toString(36).slice(2, 10), ask_price: 10, payout: 19, currency: 'USD' } }) });
      } else if (m.buy) {
        buyAttempts++;
        if (buyAttempts === 1) {
          /* id from a recycled connection — the exact user-reported failure */
          this.handlers.message?.({ toString: () => JSON.stringify({ error: { code: 'InvalidContractProposal', message: 'Unknown contract proposal' }, echo_req: m }) });
        } else {
          this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'buy', buy: { contract_id: 555888, buy_price: 10, payout: 19, balance_after: 9990, transaction_id: 77, currency: 'USD' } }) });
        }
      } else if (m.proposal_open_contract === 1) {
        /* mock a settled contract: expired + sold with +9 profit */
        this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: m.contract_id, buy_price: '10', payout: '19', bid_price: '19', profit: '9', is_expired: 1, is_sold: 1, exit_spot: '1.11502', currency: 'USD', longcode: 'settled' } }) });
      }
    }, 5);
  }
  close() { this.readyState = 3; this.handlers.close?.(); }
  removeListener() {}
}

const store = createStore(join(mkdtempSync(join(tmpdir(), 'aurum-rq-')), 'store.json'));
const app = createApp({ store, config: configFromEnv(), feed: { fetchCandles: async () => [], symbols: {} }, patDeps: { fetchImpl: fakeFetch, wsImpl: FlakyBuyWS } });
const server = app.listen(0);
let base, sid;
const H = { 'x-aurum-user': 'rq', 'x-deriv-pat': 'RQPAT1234567890', 'x-deriv-appid': 'TestAppID123' };

before(async () => {
  base = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(base + '/api/deriv/pat/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-deriv-pat': H['x-deriv-pat'], 'x-deriv-appid': H['x-deriv-appid'] }, body: '{}' });
  sid = (await r.json()).sid;
});
after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...H }, body: JSON.stringify(body) });

test('crypto: immediate honest error (no Rise/Fall on the new options API)', async () => {
  const r = await post('/api/deriv/pat/proposal', { sid, accountId: 'VRW999', symbol: 'BTC/USD', amount: 10, side: 'SELL', duration: 15, duration_unit: 'm' });
  const j = await r.json();
  assert.equal(r.status, 502);
  assert.match(j.detail, /no Rise\/Fall contracts for crypto/);
  assert.match(j.detail, /MT5 bridge/);
});

test('confirm on a stale per-connection id: re-quotes at the same duration and fills', async () => {
  const q = await post('/api/deriv/pat/proposal', { sid, accountId: 'VRW999', symbol: 'EUR/USD', amount: 10, side: 'SELL', duration: 5, duration_unit: 'm' });
  const { ticket } = await q.json();
  assert.ok(ticket?.id);
  assert.equal(buyAttempts, 0);
  const r = await post('/api/deriv/pat/confirm', { ticket });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.requoted, true, 'must transparently re-quote on InvalidContractProposal');
  assert.equal(j.order.contract_id, 555888);
  assert.equal(buyAttempts, 2, 'first buy rejected (stale id) + retried buy filled');
});

test('quote surfaces the limited-lineup note when the jump is huge', async () => {
  const r = await post('/api/deriv/pat/proposal', { sid, accountId: 'VRW999', symbol: 'GBP/USD', amount: 10, side: 'BUY', duration: 15, duration_unit: 'm' });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.match(String(j.quote.lineup_note || ''), /lineup.*limited/, '15m → 1d must warn the user');
});

/* ---- balance lifecycle (user request: execute + deduct/credit on the selected account) ---- */

test('buy response carries the authoritative balance_after (instant deduction)', async () => {
  const r = await post('/api/deriv/pat/proposal', { sid, accountId: 'VRW777', symbol: 'EUR/USD', amount: 10, side: 'SELL', duration: 5, duration_unit: 'm' });
  const { ticket } = await r.json();
  const c = await post('/api/deriv/pat/confirm', { ticket });
  const j = await c.json();
  assert.equal(j.order.balance_after, 9990);
  assert.equal(j.order.transaction_id, 77);
});

test('contract_status reports settlement state (expired+sold+profit)', async () => {
  const r = await post('/api/deriv/pat/contract_status', { sid, accountId: 'VRW777', contract_id: 555888 });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.contract.is_expired, true);
  assert.equal(j.contract.is_sold, true);
  assert.equal(j.contract.profit, 9);
  assert.equal(j.contract.exit_spot, 1.11502);
});

/* ---- user-directed confirm flow: ALWAYS fresh proposal right before the buy ---- */

test('confirm fetches a FRESH proposal and buys only that id (never the displayed one)', async () => {
  const proposalsBefore = proposals.length;
  const q = await post('/api/deriv/pat/proposal', { sid, accountId: 'VRW777', symbol: 'EUR/USD', amount: 10, side: 'SELL', duration: 5, duration_unit: 'm' });
  const { ticket } = await q.json();
  const displayedId = ticket.id;
  const before = proposals.length;
  assert.ok(before > proposalsBefore, 'the ticket quote itself was one proposal');
  const c = await post('/api/deriv/pat/confirm', { ticket });
  const j = await c.json();
  assert.equal(c.status, 200, JSON.stringify(j));
  assert.equal(j.requoted, true, 'confirm always re-quotes by design');
  assert.ok(j.fresh && j.fresh.duration === 30, 'fresh quote metadata returned');
  assert.equal(proposals.length, before + 1, 'exactly ONE fresh proposal fetched at confirm');
  assert.notEqual(displayedId, j.order.contract_id); /* id vs contract_id sanity */
});

test('unsupported symbol → clear human message listing supported symbols', async () => {
  const r = await post('/api/deriv/pat/proposal', { sid, accountId: 'VRW777', symbol: 'NOPE/USD', amount: 10, side: 'BUY', duration: 15, duration_unit: 'm' });
  const j = await r.json();
  assert.equal(r.status, 400);
  assert.equal(j.error, 'unsupported_symbol');
  assert.match(j.detail, /No Deriv contract is mapped for "NOPE\/USD"/);
  assert.match(j.detail, /EUR\/USD/);
});

test('a ticket quoted long ago still confirms — the old id is never trusted anyway', async () => {
  const q = await post('/api/deriv/pat/proposal', { sid, accountId: 'VRW777', symbol: 'EUR/USD', amount: 10, side: 'SELL', duration: 5, duration_unit: 'm' });
  const { ticket } = await q.json();
  const c = await post('/api/deriv/pat/confirm', { ticket });
  assert.equal(c.status, 200, 'confirm re-quotes, so ticket age is irrelevant');
});
