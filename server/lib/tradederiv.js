/* ================================================================
 * AURUM — Deriv REAL execution (requires user's PAT, trade scope).
 * The PAT is supplied per-request by the client from sessionStorage
 * (runtime-only) and NEVER persisted server-side.
 * Flow: authorize -> proposal -> buy -> contract status.
 * All calls ride the same verified public endpoint as the feed.
 * ================================================================ */

import { derivRequest } from './derivfeed.js';
import { DEFAULT_SPEC_WS } from './derivconn.js';
import { DERIV_CODE_MAP } from './symbols.js';

/* Account-level calls MUST use the official spec endpoint; the public feed
   socket rejects authorize ("no recognized method in request").
   App ID precedence: user's connect form (per session) -> server env. */
function specUrl(appId) {
  const a = String(appId || '').trim();
  if (!/^\d{1,10}$/.test(a)) {
    throw new Error('Your Deriv App ID is required to sign in — enter it in Settings (free: api.deriv.com → Register app).');
  }
  return DEFAULT_SPEC_WS(a);
}

function mustDerivCode(sym) {
  const code = DERIV_CODE_MAP[sym];
  if (!code) throw new Error('unsupported symbol for Deriv trading: ' + sym);
  return code;
}

/* Real Deriv API tokens are created at app.deriv.com -> Settings -> API token.
   Formats seen in the wild: "a1-xxxxxxxxxxxx", plain alphanumeric (often 15-32
   chars). The old pat_-prefix requirement rejected every REAL token. */
const DERIV_TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** Authorize and return account summary (validates the token). */
export async function derivAuthorize(pat, appId) {
  const tok = String(pat || '').trim();
  if (!DERIV_TOKEN_RE.test(tok)) throw new Error('A valid Deriv API token is required — create one at app.deriv.com (Settings → API token, scopes: read + trade).');
  const auth = await derivRequest({ authorize: tok }, 12000, specUrl(appId));
  if (!auth || !auth.authorize) throw new Error('Deriv rejected the token');
  return {
    loginid: auth.loginid,
    fullname: auth.fullname || '',
    currency: auth.currency,
    balance: auth.balance,
    is_virtual: !!auth.is_virtual
  };
}

/**
 * Propose + buy a contract on Deriv.
 * @param {object} p { pat, symbol, amount, side:'BUY'|'SELL', duration, duration_unit }
 * amount = stake in account currency; side maps CALL/PUT.
 */
export async function derivBuy({ pat, appId, symbol, amount, side, duration = 5, duration_unit = 'm' }) {
  const code = mustDerivCode(symbol);
  const stake = Number(amount);
  if (!Number.isFinite(strikeGuard(stake))) throw new Error('invalid stake');
  if (stake < 0.35) throw new Error('stake too low (min ~0.35 USD)');
  const contract = side === 'SELL' ? 'PUT' : 'CALL';

  await derivAuthorize(pat, appId); // early, clear token errors

  const proposal = await derivRequest({
    proposal: 1,
    amount: stake,
    basis: 'stake',
    contract_type: contract,
    currency: 'USD',
    duration,
    duration_unit,
    symbol: code
  }, 10000, specUrl(appId));
  if (!proposal || !proposal.proposal) throw new Error('Deriv proposal failed: ' + (proposal?.error?.message || 'no proposal'));
  const p = proposal.proposal;

  const buy = await derivRequest({ buy: p.id, price: p.ask_price }, 10000, specUrl(appId))
    .catch(() => derivRequest({ buy: p.id }, 10000, specUrl(appId)));
  if (!buy || !buy.buy) throw new Error('Deriv buy failed: ' + (buy?.error?.message || 'no fill'));

  const b = buy.buy;
  return {
    contract_id: b.contract_id,
    symbol,
    side,
    stake: b.buy_price,
    payout: b.payout,
    entry_spot: b.start_spot || b.display_name,
    currency: b.currency || 'USD',
    duration,
    duration_unit,
    bought_at: Date.now()
  };
}

/** Sell / close an open contract early. */
export async function derivSell(pat, appId, contractId) {
  await derivAuthorize(pat, appId); // spec endpoint: account calls need auth first
  const res = await derivRequest({ sell: Number(contractId) }, 10000, specUrl(appId));
  if (!res || typeof res.sell?.price !== 'number') throw new Error('Deriv sell failed: ' + (res?.error?.message || 'no price'));
  return { contract_id: Number(contractId), sold_for: res.sell.price, sold_at: (res.sell.sold_time || 0) * 1000 || Date.now() };
}

/** Current contract status (for SL/TP-style monitoring of open contracts). */
export async function derivContractStatus(pat, appId, contractId) {
  await derivAuthorize(pat, appId);
  const res = await derivRequest({ proposal_open_contract: 1, contract_id: Number(contractId) }, 10000, specUrl(appId));
  const pc = res && res.proposal_open_contract;
  if (!pc) throw new Error('contract status unavailable');
  return {
    contract_id: pc.contract_id,
    is_sold: !!pc.is_sold,
    is_settled: !!pc.is_settled,
    profit: Number(pc.profit || 0),
    current_spot: Number(pc.current_spot || 0),
    entry_spot: Number(pc.entry_spot || 0),
    status: pc.status
  };
}
