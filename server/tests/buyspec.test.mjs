import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPatModule } from '../lib/derivpat.js';
import { localDecision } from '../lib/localdecision.js';

/* ================================================================
 * BUY-spec hardening for the still-failing [InvalidContractProposal]:
 * official buy_request.schema.json requires the proposal id to match
 * ^[\w-]{32,128}$ (or "1"). If the new-API proposal returns an irregular
 * id, the buy must use the documented parameters form
 * { buy: 1, price, parameters: {…} } — and fall back to it when an
 * id-form buy is rejected. Ground truth (id shape) is audit-logged.
 * ================================================================ */

let otpCalls = 0;
const fakeFetch = async (url, opts = {}) => {
  if (String(url).endsWith('/options/accounts') && (opts.method || 'GET') === 'GET') {
    return { ok: true, status: 200, json: async () => ({ data: [
      { account_id: 'VRW321', account_type: 'demo', currency: 'USD', balance: 10000, status: 'active' }
    ], meta: { count: 1 } }) };
  }
  if (String(url).includes('/otp')) { otpCalls++; return { ok: true, status: 200, json: async () => ({ websocket_url: 'wss://mock.deriv/ws/demo?otp=T' + otpCalls }) }; }
  return { ok: false, status: 404, json: async () => ({ message: 'unexpected' }) };
};

/* mode: what kind of proposal id the mock hands out / how buys behave */
let idMode = 'long';          // 'long' (48 chars) | 'short' (12 chars)
let idBuyBehavior = 'accept'; // 'accept' | 'reject' (InvalidContractProposal)
let paramsBuyBehavior = 'accept';
const seenBuys = [];

class BuySpecWS {
  constructor(url) { this.readyState = 0; this.handlers = {}; setTimeout(() => { this.readyState = 1; this.handlers.open?.(); }, 5); }
  on(ev, fn) { this.handlers[ev] = fn; }
  send(data) {
    const m = JSON.parse(data);
    setTimeout(() => {
      if (m.contracts_for) {
        this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'contracts_for', contracts_for: { available: [] } }) });
      } else if (m.proposal === 1) {
        const ok = m.duration === 15 && m.duration_unit === 'm';
        if (!ok) this.handlers.message?.({ toString: () => JSON.stringify({ error: { code: 'TradingDurationNotAllowed', message: 'Trading is not offered for this duration.' }, echo_req: m }) });
        else {
          const id = idMode === 'long'
            ? 'uw2mk7no3oktoRVVsB4Dz7TQnFfABuFDgO95dlxfMxRuPUsz'
            : 'SHORTID12345';
          this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'proposal', proposal: { id, ask_price: 10, payout: 17.7, currency: 'USD' } }) });
        }
      } else if (m.buy === 1 && m.parameters) {
        seenBuys.push({ form: 'parameters', contract_type: m.parameters.contract_type, duration: m.parameters.duration, symbol: m.parameters.underlying_symbol });
        if (paramsBuyBehavior === 'accept') this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'buy', buy: { contract_id: 700001, buy_price: 10, payout: 17.7, balance_after: 9990, currency: 'USD' } }) });
        else this.handlers.message?.({ toString: () => JSON.stringify({ error: { code: 'InvalidContractProposal', message: 'Unknown contract proposal' }, echo_req: m }) });
      } else if (m.buy) {
        seenBuys.push({ form: 'id', idLen: String(m.buy).length, price: m.price });
        if (idBuyBehavior === 'accept') this.handlers.message?.({ toString: () => JSON.stringify({ msg_type: 'buy', buy: { contract_id: 700002, buy_price: 10, payout: 17.7, balance_after: 9990, currency: 'USD' } }) });
        else this.handlers.message?.({ toString: () => JSON.stringify({ error: { code: 'InvalidContractProposal', message: 'Unknown contract proposal' }, echo_req: m }) });
      }
    }, 5);
  }
  close() { this.readyState = 3; this.handlers.close?.(); }
  removeListener() {}
}

const CTX = { accountId: 'VRW321', derivSymbol: 'frxGBPUSD', side: 'SELL', amount: 10 };
const quoteOpts = { accountId: 'VRW321', derivSymbol: 'frxGBPUSD', side: 'SELL', amount: 10, duration: 15, duration_unit: 'm' };
const fresh = () => { idMode = 'long'; idBuyBehavior = 'accept'; paramsBuyBehavior = 'accept'; seenBuys.length = 0; otpCalls = 0; };

test('irregular proposal id (<32 chars) → buys with the documented parameters form', async () => {
  fresh(); idMode = 'short';
  const m = createPatModule({ fetchImpl: fakeFetch, wsImpl: BuySpecWS });
  const { sid } = await m.createSession('BSPAT123456', 'App1');
  const q = await m.quote(sid, quoteOpts);
  const { order } = await m.confirmSmart(sid, q, CTX);
  assert.equal(order.contract_id, 700001);
  assert.equal(seenBuys.filter(b => b.form === 'id').length, 0, 'id-form buy must never be attempted with an irregular id');
  const pb = seenBuys.find(b => b.form === 'parameters');
  assert.ok(pb, 'parameters-form buy used');
  assert.equal(pb.contract_type, 'PUT');            /* SELL → PUT */
  assert.equal(pb.duration, 15);
  assert.equal(pb.symbol, 'frxGBPUSD');             /* display name → Deriv code */
});

test('regular id accepted by Deriv → plain id-form buy, no fallback', async () => {
  fresh();
  const m = createPatModule({ fetchImpl: fakeFetch, wsImpl: BuySpecWS });
  const { sid } = await m.createSession('BSPAT123456', 'App1');
  const q = await m.quote(sid, quoteOpts);
  const { order } = await m.confirmSmart(sid, q, CTX);
  assert.equal(order.contract_id, 700002);
  assert.deepEqual(seenBuys.map(b => b.form), ['id']);
});

test('id-form rejected → falls back to parameters form on the same connection', async () => {
  fresh(); idBuyBehavior = 'reject';
  const m = createPatModule({ fetchImpl: fakeFetch, wsImpl: BuySpecWS });
  const { sid } = await m.createSession('BSPAT123456', 'App1');
  const q = await m.quote(sid, quoteOpts);
  const { order } = await m.confirmSmart(sid, q, CTX);
  assert.equal(order.contract_id, 700001);
  assert.deepEqual(seenBuys.map(b => b.form), ['id', 'parameters']);
});

/* ---- stop-distance noise floor (user pre-real-money review) ---- */

const mkDet = (symbol, atr, price) => ({
  symbol,
  mtfSignal: 'SELL_CONFIRMED',
  analyses: {
    m1: { error: null, signal: 'SELL', biasScore: -3, indicators: { atr }, currentPrice: price },
    m5: { error: null, signal: 'SELL', biasScore: -3, indicators: { atr }, currentPrice: price },
    h1: { error: null, signal: 'SELL', biasScore: -3, indicators: { atr }, currentPrice: price }
  },
  ok: true
});

test('stop floor: tiny 1m ATR on EUR/USD is lifted to ≥8 pips', () => {
  const d = localDecision(mkDet('EUR/USD', 0.00012, 1.11569)); /* 1.2-pip ATR */
  const stopDist = Math.abs(d.stop_loss - d.entry);
  assert.ok(stopDist >= 0.0008 - 1e-9, 'stop distance ' + stopDist + ' below the 8-pip floor');
  assert.ok(d.signal === 'SELL');
});

test('stop floor: JPY pairs use the 0.01 pip size', () => {
  const d = localDecision(mkDet('USD/JPY', 0.0015, 158.428)); /* 15 pips? 0.0015/0.01=0.15 pip → floor to 0.08 */
  const stopDist = Math.abs(d.stop_loss - d.entry);
  assert.ok(stopDist >= 0.08 - 1e-9, 'stop distance ' + stopDist + ' below the 8-pip JPY floor');
});

test('stop floor: synthetics (no pip definition) keep the raw ATR', () => {
  const d = localDecision(mkDet('CRASH 1000', 5, 6210));
  const stopDist = Math.abs(d.stop_loss - d.entry);
  assert.ok(Math.abs(stopDist - 1.5 * 5) < 1e-9, 'synthetics must keep 1.5×ATR stops');
});
