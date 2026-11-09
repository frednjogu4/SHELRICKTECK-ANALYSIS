/* ================================================================
 * AURUM — Deriv OFFICIAL API from the browser (PAT mode only).
 *
 * WHY BROWSER-SIDE: Deriv's official WebSocket (ws.derivws.com) sits
 * behind Cloudflare, which blocks datacenter egress (Railway/sandbox
 * → HTTP 520) but works fine from normal home/mobile networks — that
 * is how every Deriv trader connects. In PAT mode the token already
 * lives ONLY in this browser's sessionStorage (never persisted
 * server-side, sent per-request), so account calls execute here.
 * The server REMAINS THE RISK GATE: every order is approved against
 * stake / max-open / daily-loss limits BEFORE this module is used.
 * The env-token proxy mode keeps its token server-side as before.
 * ================================================================ */

const SPEC_WS = (appId) => 'wss://ws.derivws.com/websockets/v3?app_id=' + encodeURIComponent(String(appId));

/* Classic-API error-code map (audit Task 2.2) — each code gets a specific,
   actionable message; PAT/classic mix-ups get a routing hint. */
const CLASSIC_ERR = {
  InvalidToken: 'Deriv rejected this token on the classic WebSocket. Is it a CLASSIC API token with Trade scope? If it is a new-API PAT, use the “New API · PAT” tab instead — PATs never work on the classic WebSocket.',
  InvalidAppID: 'Deriv does not recognise this App ID. Copy it EXACTLY from your Deriv application (it may contain letters).',
  AuthorizationRequired: 'Deriv requires authorization for this request — reconnect so the token is sent first.',
  SelfExclusion: 'This account is self-excluded from trading on Deriv.',
  RateLimit: 'Deriv is rate-limiting this connection — wait a moment and retry.',
  MarketIsClosed: 'That market is closed right now (forex closes Fri ~20:54 UTC, reopens Sunday night).',
  NotEnoughMoney: 'Not enough balance on this Deriv account for that stake.',
  InvalidProposal: 'Deriv could not price that contract — check symbol/stake/duration.',
  APIAuthenticationFailed: 'Deriv API authentication failed — check the token and App ID.'
};
function friendlyClassic(msg) {
  for (const [code, text] of Object.entries(CLASSIC_ERR)) {
    if (String(msg).includes('[' + code + ']')) return text;
  }
  return msg;
}

/**
 * One short-lived connection: authorize first, then send `payload`
 * and resolve the first response containing a requested top-level key.
 * @param {string} appId  user's Deriv app id (digits)
 * @param {string} pat    Deriv API token (session-only)
 * @param {object|null} payload  API request (null → authorize only)
 */
function specCall(appId, pat, payload, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(SPEC_WS(appId)); }
    catch (e) { return reject(new Error('WebSocket unavailable: ' + e.message)); }
    let settled = false;
    let authorized = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(tm); try { ws.close(); } catch (e) {} fn(v); };
    const tm = setTimeout(() => done(reject, new Error('Deriv connection timed out — check your network and try again.')), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(payload && authorized ? payload : { authorize: pat }));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.error && m.echo_req) {
        const code = m.error.code ? ' [' + m.error.code + ']' : '';
        const e = Object.assign(new Error(friendlyClassic(String(m.error.message || 'Deriv error') + code)), { code: m.error.code });
        return done(reject, e);
      }
      if (!authorized && m.msg_type === 'authorize') {
        authorized = true;
        if (payload) { ws.send(JSON.stringify(payload)); return; }
        return done(resolve, m.authorize || m);
      }
      if (authorized && payload) {
        for (const k of Object.keys(payload)) {
          if (k === 'req_id') continue;
          if (m[k] !== undefined && m[k] !== null) return done(resolve, m);
        }
      }
    };
    ws.onclose = () => { if (!settled) done(reject, new Error('Deriv connection closed before a response arrived.')); };
  });
}

/** Authorize only → account object {loginid, balance, currency, is_virtual, …}. */
export async function derivWsAuthorize(appId, pat) {
  if (typeof WebSocket === 'undefined') throw new Error('This browser cannot open Deriv connections (no WebSocket).');
  return specCall(appId, pat, null);
}

/** Quote (proposal) → {id, ask_price, payout, …}. Nothing is bought. */
export async function derivWsProposal(appId, pat, p) {
  const m = await specCall(appId, pat, {
    proposal: 1,
    amount: Number(p.amount),
    basis: 'stake',
    contract_type: p.side === 'SELL' ? 'PUT' : 'CALL',
    currency: 'USD',
    duration: Number(p.duration) || 5,
    duration_unit: p.duration_unit || 'm',
    symbol: p.derivSymbol
  });
  if (!m || !m.proposal) throw new Error('Deriv returned no quote');
  return m.proposal;
}

/** Buy at the quoted price → {contract_id, buy_price, payout, …}. */
export async function derivWsBuy(appId, pat, proposalId, price) {
  const m = await specCall(appId, pat, { buy: proposalId, price });
  if (!m || !m.buy) throw new Error('Deriv did not confirm the buy');
  return m.buy;
}

/** Close early → {price (sold for), …}. */
export async function derivWsSell(appId, pat, contractId) {
  const m = await specCall(appId, pat, { sell: Number(contractId) });
  if (!m || !m.sell) throw new Error('Deriv did not confirm the close');
  return m.sell;
}
