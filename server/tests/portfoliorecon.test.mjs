import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPatModule } from '../lib/derivpat.js';

/* Portfolio reconciliation: {portfolio:1} -> normalized open-contract rows.
   This is what lets EVERY device show EVERY open Deriv contract on the
   account (Deriv is the source of truth, not the buying device). */

let otpCalls = 0;
const fakeFetch = async (url) => {
  if (String(url).endsWith('/options/accounts')) return { ok: true, status: 200, json: async () => ({ data: [{ account_id: 'VRW321', account_type: 'demo', currency: 'USD', balance: 10000, status: 'active' }], meta: { count: 1 } }) };
  if (String(url).includes('/otp')) { otpCalls++; return { ok: true, status: 200, json: async () => ({ websocket_url: 'wss://mock.deriv/ws/demo?otp=T' + otpCalls }) }; }
  return { ok: false, status: 404, json: async () => ({ message: 'unexpected' }) };
};

let portfolioRows = [
  { contract_id: 810001, underlying_symbol: 'frxUSDJPY', contract_type: 'PUT', buy_price: 10, payout: 19.77, date_expiry: 1790000000, date_settlement: 1790000100, date_start: 1789990000, currency: 'USD', longcode: 'daily put' },
  { contract_id: 810002, symbol: 'R_100', contract_type: 'CALL', buy_price: 5, payout: 9.5, date_expiry: 1790000300, currency: 'USD' }
];
class PortfolioWS {
  constructor(url) { this.readyState = 0; this.handlers = {}; setTimeout(() => { this.readyState = 1; this.handlers.open?.(); }, 5); }
  on(ev, fn) { this.handlers[ev] = fn; }
  send(data) {
    const m = JSON.parse(data);
    setTimeout(() => {
      if (m.authorize) this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'authorize', authorize: { accountid: 'VRW321', balance: 10000 } }) });
      else if (m.portfolio === 1) this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'portfolio', portfolio: { contracts: portfolioRows } }) });
      else if (m.proposal_open_contract) this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: m.contract_id, is_expired: 0, is_sold: 0, can_sell: 0, profit: -0.5 } }) });
      else this.handlers.message?.({ toString: () => JSON.stringify({ error: { code: 'UnexpectedRequest', message: 'no mock' }, echo_req: m }) });
    }, 5);
  }
  close() { this.readyState = 3; this.handlers.close?.(); }
  removeListener() {}
}

test('portfolio: normalizes contract rows (id, symbol fallback, type, times)', async () => {
  const m = createPatModule({ fetchImpl: fakeFetch, wsImpl: PortfolioWS });
  const s = await m.createSession('pat-token-test', '1089');
  const rows = await m.portfolio(s.sid, 'VRW321');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].contract_id, 810001);
  assert.equal(rows[0].symbol, 'frxUSDJPY');      // underlying_symbol preferred
  assert.equal(rows[0].contract_type, 'PUT');
  assert.equal(rows[0].buy_price, 10);
  assert.equal(rows[0].date_settlement, 1790000100);
  assert.equal(rows[1].symbol, 'R_100');           // falls back to .symbol
  assert.equal(rows[1].contract_type, 'CALL');
});

test('portfolio: empty account returns [] without throwing', async () => {
  portfolioRows = [];
  const m = createPatModule({ fetchImpl: fakeFetch, wsImpl: PortfolioWS });
  const s = await m.createSession('pat-token-test', '1089');
  const rows = await m.portfolio(s.sid, 'VRW321');
  assert.deepEqual(rows, []);
});
