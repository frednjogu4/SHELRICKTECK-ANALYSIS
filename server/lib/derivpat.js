/* ================================================================
 * AURUM — Deriv NEW-API PAT sessions (server-side only).
 *
 * Per Deriv's new API (developers.deriv.com):
 *   REST  https://api.derivws.com  with headers:
 *         Authorization: Bearer <PAT>   +   Deriv-App-ID: <id>
 *   OTP   POST /trading/v1/options/accounts/{accountId}/otp
 *         → response contains a ready-to-use WebSocket URL
 *   WS    wss://api.derivws.com/trading/v1/options/ws/{demo|real}?otp=…
 *         (same message envelope as classic, BUT proposal uses
 *          `underlying_symbol` and proposal ids are strings)
 *
 * SECURITY: the PAT is held HERE, in server memory only. The browser
 * receives a random session id (sid) and never stores/sees the PAT.
 * All orders still pass the server-side risk gates BEFORE execution.
 * ================================================================ */

import crypto from 'crypto';
import WebSocket from 'ws';

/* audit logging — secrets NEVER appear: masked shapes only (audit rule) */
const mask = (v) => { const t = String(v || ''); return t ? (t.slice(0, 3) + '…(' + t.length + ')') : '(none)'; };
function auditLog(event, fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'deriv.pat', event, ...fields }));
}

const REST = 'https://api.derivws.com';

/* buy_request.schema.json: the proposal id sent to `buy` must match this
   (or be the literal "1"). Irregular ids must use the parameters form. */
const ID_PATTERN = /^[\w-]{32,128}$/;

/* ---- duration helpers (pure, unit-tested) -------------------------------
   Deriv offers different duration ranges per symbol/account. Rather than
   guessing, we ask Deriv (contracts_for on the authorized session socket —
   request shape verified against the official v3 schema: {contracts_for})
   and clamp the requested duration to the nearest offered value. */
const UNIT_SEC = { s: 1, m: 60, h: 3600, d: 86400 };
export function durToSec(n, unit) { const u = UNIT_SEC[unit]; return u ? Number(n) * u : null; }

export function parseContractsFor(body) {
  const cf = body && body.contracts_for;
  const list = cf && (Array.isArray(cf.available) ? cf.available
    : Array.isArray(cf.available_contracts) ? cf.available_contracts : null);
  if (!list) return null;
  const out = {};
  const addRange = (type, unit, min, max) => {
    /* 't' (ticks) has no seconds semantics — kept as a plain numeric range so
       tick-only lineups (BOOM/CRASH) survive parsing instead of vanishing. */
    if ((!UNIT_SEC[unit] && unit !== 't') || !Number.isFinite(Number(min)) || !Number.isFinite(Number(max))) return;
    out[type] = out[type] || {};
    const cur = out[type][unit];
    out[type][unit] = { min: Math.min(Number(min), cur ? cur.min : Infinity), max: Math.max(Number(max), cur ? cur.max : -Infinity) };
  };
  /* embedded-unit strings like "15m" / "1d"; bare numbers are ambiguous → ignored */
  const parseDur = (v) => { const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(String(v == null ? '' : v).trim()); return m ? { n: Number(m[1]), u: m[2].toLowerCase() } : null; };
  for (const it of list) {
    const type = String((it && it.contract_type) || '').toUpperCase();
    if (type !== 'CALL' && type !== 'PUT') continue;
    if (Array.isArray(it.open_in)) for (const oi of it.open_in) addRange(type, oi && oi.duration_unit, oi && oi.min, oi && oi.max);
    const a = parseDur(it.min_contract_duration), b = parseDur(it.max_contract_duration);
    if (a && b) {
      if (a.u === b.u) addRange(type, a.u, a.n, b.n);
      else { /* mixed units ("15m"…"365d") — convert the max into the min's unit (exact for s/m/h/d) */
        const conv = durToSec(b.n, b.u) / UNIT_SEC[a.u];
        if (Number.isFinite(conv)) addRange(type, a.u, a.n, conv);
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

export function clampDuration(ranges, duration, unit) {
  const d = Number(duration) || 5, u = unit || 'm';
  const r = ranges && (ranges.CALL || ranges.PUT);
  if (!r) return { duration: d, unit: u, clamped: false };
  if (u === 't' && r.t) {
    const v = Math.min(Math.max(d, r.t.min), r.t.max);
    return { duration: v, unit: 't', clamped: v !== d };
  }
  if (r[u]) {
    const v = Math.min(Math.max(d, r[u].min), r[u].max);
    return { duration: v, unit: u, clamped: v !== d };
  }
  /* requested unit not offered: pick a unit whose [min,max] contains the request (in seconds), else the closest bound */
  const want = durToSec(d, u);
  let best = null;
  for (const [ru, rr] of Object.entries(r)) {
    const lo = durToSec(rr.min, ru), hi = durToSec(rr.max, ru);
    if (lo == null || hi == null) continue;
    if (want >= lo && want <= hi) {
      const v = Math.round(want / UNIT_SEC[ru]);
      return { duration: v, unit: ru, clamped: v !== d || ru !== u };
    }
    const cand = want < lo ? { u: ru, v: rr.min, dist: lo - want } : { u: ru, v: rr.max, dist: want - hi };
    if (!best || cand.dist < best.dist) best = cand;
  }
  if (best) return { duration: best.v, unit: best.u, clamped: true };
  /* nothing time-based matches (e.g. tick-only lineup): offer Deriv's minimum ticks */
  if (r.t) return { duration: r.t.min, unit: 't', clamped: true };
  return { duration: d, unit: u, clamped: false };
}

/* human summary of what Deriv actually offers, for the rejection message */
export function rangesSummary(ranges) {
  const r = ranges && (ranges.CALL || ranges.PUT);
  if (!r) return null;
  const parts = [];
  for (const [u, rr] of Object.entries(r)) {
    if (u === 't') parts.push(rr.min === rr.max ? rr.min + ' tick' + (rr.min === 1 ? '' : 's') : rr.min + '\u2013' + rr.max + ' ticks');
    else if (u === 'm') parts.push(rr.min + '\u2013' + rr.max + 'm');
    else if (u === 'h') parts.push(rr.min + '\u2013' + rr.max + 'h');
    else if (u === 'd') parts.push(rr.min + '\u2013' + rr.max + 'd');
    else if (u === 's') parts.push(rr.min + '\u2013' + rr.max + 's');
  }
  return parts.length ? parts.join(', ') : null;
}

/* OptionsAccount normalization — shared by createSession and listAccounts */
export function normalizeAccounts(list) {
  return (Array.isArray(list) ? list : []).map((a) => ({
    account_id: String(a.account_id ?? a.id ?? ''),
    account_type: String(a.account_type ?? a.type ?? (a.is_virtual === 1 || a.is_virtual === true ? 'demo' : 'real')),
    currency: a.currency || 'USD',
    balance: a.balance != null ? Number(a.balance) : null,
    status: a.status || null
  })).filter((a) => a.account_id);
}

export function createPatModule(deps = {}) {
  const doFetch = deps.fetchImpl || ((u, o) => fetch(u, o));
  const WS = deps.wsImpl || WebSocket;

  const sessions = new Map(); // sid -> { pat, appId, createdAt }
  const sockets = new Map();  // sid -> { accountId, ws, url, expiresAt, iv, gen }
  let connGen = 0;            /* bumped on every NEW trading connection — lets confirm() detect recycled proposal ids BEFORE buying */
  const tickets = new Map();  // ticketId -> { sid, quote, createdAt }
  const cfCache = new Map();  // sid|symbol -> { ranges, at } (10 min TTL)
  const knownDur = new Map(); // sid|symbol -> { duration, unit } that Deriv ACCEPTED (empirical)

  /* find the first string in a JSON structure that looks like a WS URL */
  const findWsUrl = (v) => {
    if (typeof v === 'string') return v.includes('/ws/') && v.startsWith('wss') ? v : null;
    if (Array.isArray(v)) { for (const x of v) { const r = findWsUrl(x); if (r) return r; } return null; }
    if (v && typeof v === 'object') { for (const x of Object.values(v)) { const r = findWsUrl(x); if (r) return r; } return null; }
    return null;
  };

  async function patRest(sid, path, method = 'GET') {
    const s = sessions.get(sid);
    if (!s) throw Object.assign(new Error('Deriv PAT session expired — connect again.'), { code: 'no_session' });
    const r = await doFetch(REST + path, {
      method,
      headers: { 'Authorization': 'Bearer ' + s.pat, 'Deriv-App-ID': s.appId, 'Content-Type': 'application/json' }
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (body && (body.message || body.detail || body.error)) || ('Deriv REST ' + r.status);
      throw Object.assign(new Error(String(msg)), { code: r.status === 401 ? 'bad_pat' : 'rest_error' });
    }
    return body;
  }

  /* socket reuse: one authenticated WS per session+account, ~90 s idle life,
     kept warm with official {ping:1} frames so quotes don't re-OTP constantly */
  function getSocket(sid, accountId, wsUrl) {
    return new Promise((resolve, reject) => {
      const ex = sockets.get(sid);
      if (ex && ex.accountId === accountId && ex.ws.readyState === 1 && ex.expiresAt > Date.now()) return resolve(ex.ws);
      if (ex && ex.ws) { if (ex.iv) clearInterval(ex.iv); try { ex.ws.close(); } catch (e) {} }
      const ws = new WS(wsUrl);
      let iv = null;
      const t = setTimeout(() => { if (iv) clearInterval(iv); try { ws.close(); } catch (e) {} reject(new Error('Timed out connecting to Deriv (OTP socket).')); }, 10000);
      ws.on('open', () => {
        clearTimeout(t);
        iv = setInterval(() => {
          if (ws.readyState !== 1) return;
          try {
            ws.send(JSON.stringify({ ping: 1 }));
            const cur = sockets.get(sid);
            if (cur && cur.ws === ws) cur.expiresAt = Date.now() + 90000;
          } catch (e) {}
        }, 45000);
        if (iv.unref) iv.unref(); /* never keep the process alive just for pings */
        connGen += 1;
        sockets.set(sid, { accountId, ws, url: wsUrl, expiresAt: Date.now() + 90000, iv, gen: connGen });
        resolve(ws);
      });
      ws.on('error', (e) => { clearTimeout(t); reject(new Error('Deriv socket error: ' + String(e.message || e).slice(0, 120))); });
      ws.on('close', () => {
        const cur = sockets.get(sid);
        if (cur && cur.ws === ws) { if (cur.iv) clearInterval(cur.iv); sockets.delete(sid); }
        else if (iv) clearInterval(iv);
      });
    });
  }

  function wsCall(ws, payload, key, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onMsg = (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        if (m.error && m.echo_req) {
          cleanup();
          const err = new Error(String(m.error.message || 'Deriv error') + (m.error.code ? ' [' + m.error.code + ']' : ''));
          err.code = m.error.code; /* precise branching (InvalidContractProposal, TradingDurationNotAllowed, …) */
          return reject(err);
        }
        if (m[key] !== undefined && m[key] !== null) { cleanup(); return resolve(m); }
      };
      const t = setTimeout(() => { cleanup(); reject(new Error('Deriv did not answer the ' + key + ' request in time.')); }, timeoutMs);
      function cleanup() { clearTimeout(t); ws.removeListener('message', onMsg); }
      ws.on('message', onMsg);
      ws.send(JSON.stringify(payload));
    });
  }

  async function otpUrl(sid, accountId) {
    const body = await patRest(sid, '/trading/v1/options/accounts/' + encodeURIComponent(accountId) + '/otp', 'POST');
    const url = findWsUrl(body);
    if (!url) throw new Error('Deriv OTP response did not include a WebSocket URL.');
    return url;
  }

    /* ---- instrument metadata: ask Deriv which durations this symbol+account offers ---- */
    async function contractsForInner(sid, accountId, derivSymbol) {
      const k = sid + '|' + derivSymbol;
      const c = cfCache.get(k);
      if (c && Date.now() - c.at < 600000) return c.ranges;
      const url = await otpUrl(sid, accountId);
      const ws = await getSocket(sid, accountId, url);
      try {
        const m = await wsCall(ws, { contracts_for: String(derivSymbol) }, 'contracts_for');
        const ranges = parseContractsFor(m);
        cfCache.set(k, { ranges, at: Date.now() });
        return ranges;
      } catch (e) {
        auditLog('contracts_for', { status: 'error', detail: String(e.message || e).slice(0, 100) });
        return null; /* metadata is best-effort — never block quoting */
      }
    }

  const api = {
    /* ---- session ---- */
    async createSession(pat, appId) {
      const r = await doFetch(REST + '/trading/v1/options/accounts', {
        headers: { 'Authorization': 'Bearer ' + pat, 'Deriv-App-ID': appId }
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const raw = body && (body.message || body.detail || body.error);
        let msg = 'Deriv rejected the PAT (REST ' + r.status + ')';
        if (raw) msg += ': ' + (typeof raw === 'string' ? raw : JSON.stringify(raw));
        if (r.status === 401) {
          msg += ' — checklist: token active? created with the Trade scope? App-ID copied EXACTLY from your Deriv application? (a Classic token will always 401 here — it must be a new-API PAT)';
          /* shape booleans only — no token material, ever */
          msg += ' (shape check: PAT box starts with pat_: ' + (/^pat_/.test(String(pat)) ? 'yes' : 'NO — likely a Classic token') + ' · boxes possibly swapped: ' + (/^pat_/.test(String(appId)) ? 'YES — a pat_ token is in the App-ID box' : 'not detected') + ')';
        }
        else if (r.status === 403) msg += ' — Deriv refused the request: verify PAT scopes (Trade + Read) and any IP restrictions on your application.';
        auditLog('accounts', { status: r.status, deriv_code: null, pat: mask(pat), app_id: mask(appId) });
        throw Object.assign(new Error(msg), { code: r.status === 401 ? 'bad_pat' : 'rest_error', status: r.status });
      }
      auditLog('accounts', { status: r.status, count: Array.isArray(body?.data) ? body.data.length : null, pat: mask(pat), app_id: mask(appId) });
      /* Official shape (OpenAPI): { data: [OptionsAccount…], meta }.
         OptionsAccount = { account_id, balance, currency, group, status, account_type }. */
      const list = Array.isArray(body?.data) ? body.data
        : Array.isArray(body?.accounts) ? body.accounts
        : Array.isArray(body?.data?.accounts) ? body.data.accounts
        : Array.isArray(body?.options_accounts) ? body.options_accounts
        : Array.isArray(body) ? body : [];
      const norm = normalizeAccounts(list);
      if (!norm.length) {
        const keys = body && typeof body === 'object' ? Object.keys(body).join(', ') : typeof body;
        throw new Error('Authenticated OK, but Deriv returned no Options trading accounts (response keys: ' + keys + '). If your Deriv account has never created an Options account, open app.deriv.com once and create one (a free demo Options account is fine), then reconnect.');
      }
      const demo = norm.find((a) => /demo|virtual/i.test(a.account_type));
      const primary = demo || norm[0];
      const sid = crypto.randomBytes(24).toString('hex');
      sessions.set(sid, { pat: String(pat), appId: String(appId), createdAt: Date.now() });
      return { sid, accounts: norm, primary, environment: /demo|virtual/i.test(primary.account_type) ? 'demo' : 'real' };
    },

    has(sid) { return sessions.has(sid); },
    /* fresh account list (balances) for the switcher — PAT never leaves the server */
    async listAccounts(sid) {
      const body = await patRest(sid, '/trading/v1/options/accounts', 'GET');
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.accounts) ? body.accounts : Array.isArray(body) ? body : [];
      const norm = normalizeAccounts(list);
      if (!norm.length) throw new Error('Deriv returned no Options accounts for this PAT.');
      return norm;
    },
    drop(sid) { sessions.delete(sid); const s = sockets.get(sid); if (s) { try { s.ws.close(); } catch (e) {} sockets.delete(sid); } },

    /* ---- quote (nothing bought) ----
       Strategy: metadata first (contracts_for clamp), then NEGOTIATE with
       Deriv itself — harmless proposals (never an order) until Deriv accepts
       a duration, remembering what worked. This stays honest regardless of
       the contracts_for response shape: every accept/reject is Deriv's own. */
    async quote(sid, { accountId, derivSymbol, side, amount, duration, duration_unit }) {
      const url = await otpUrl(sid, accountId);
      const ws = await getSocket(sid, accountId, url);
      const connId = (sockets.get(sid) || {}).gen || 0;
      const key = sid + '|' + derivSymbol;
      let ranges = null;
      try { ranges = await contractsForInner(sid, accountId, derivSymbol); } catch (e) { ranges = null; }
      const use = clampDuration(ranges, duration, duration_unit);
      const req = { duration: Number(duration) || 5, unit: duration_unit || 'm' };
      const cands = [];
      const seen = new Set();
      const push = (d, u) => { const k2 = d + u; if (!seen.has(k2)) { seen.add(k2); cands.push({ duration: d, unit: u }); } };
      /* Deriv's new options API offers NO Rise/Fall contracts for crypto
         (verified: every duration rejected + no BTC in active_symbols) —
         fail fast with the honest path instead of a duration-error loop. */
      if (/^cry/i.test(String(derivSymbol || ''))) {
        throw new Error('Deriv\'s new options API offers no Rise/Fall contracts for crypto (verified against active_symbols). Trade ' + String(derivSymbol || 'it') + ' via the MT5 bridge, or pick a forex/synthetic symbol for Deriv binaries.');
      }
      const known = knownDur.get(key);
      if (known) push(known.duration, known.unit);
      push(use.duration, use.unit);
      for (const [d, u] of [[15, 'm'], [30, 'm'], [1, 'h'], [2, 'h'], [4, 'h'], [10, 'm'], [5, 'm'], [1, 'm'], [1, 'd'], [5, 't'], [10, 't']]) push(d, u);
      let lastErr = null, tried = 0;
      const triedList = [];
      for (const c of cands) {
        if (triedList.length >= 12) break; /* safety net only — the full ladder fits */
        tried++;
        triedList.push(c.duration + c.unit);
        let m;
        try {
          m = await wsCall(ws, {
            proposal: 1,
            amount: Number(amount),
            basis: 'stake',
            contract_type: side === 'SELL' ? 'PUT' : 'CALL',
            currency: 'USD',
            duration: c.duration,
            duration_unit: c.unit,
            underlying_symbol: derivSymbol
          }, 'proposal');
        } catch (e) {
          lastErr = e;
          if (/duration|not offered|ContractBuyValidation/i.test(String(e.message || e))) continue; /* duration rejected → try the next candidate */
          throw e; /* anything else surfaces immediately */
        }
        const p = m.proposal || {};
        const id = p.id ?? p.proposal_id;
        if (!id) throw new Error('Deriv returned no proposal id.');
        auditLog('quote_id_shape', { len: String(id).length, pattern_ok: ID_PATTERN.test(String(id)) ? 1 : 0, symbol: String(derivSymbol || '') });
        const changed = c.duration !== req.duration || c.unit !== req.unit;
        if (changed) auditLog('duration_negotiated', { symbol: String(derivSymbol || ''), requested: req.duration + req.unit, accepted: c.duration + c.unit, attempts: tried });
        knownDur.set(key, { duration: c.duration, unit: c.unit });
        /* big jump (≥4x or switched to days) → the account lineup is limited for this symbol; surface it */
        const reqSec = durToSec(req.duration, req.unit) || 0, gotSec = durToSec(c.duration, c.unit) || 0;
        const lineupNote = changed && (reqSec > 0 && gotSec / reqSec >= 4)
          ? 'Your Deriv account\'s lineup for ' + String(derivSymbol || '') + ' is limited — it only offered ' + c.duration + c.unit + ' (you asked for ' + req.duration + req.unit + ').'
          : undefined;
        return {
          id: String(id),
          connId,
          ask: Number(p.ask_price ?? p.quote ?? 0),
          payout: Number(p.payout ?? 0),
          currency: p.currency || 'USD',
          duration: c.duration,
          duration_unit: c.unit,
          clamped: changed,
          requested: changed ? { duration: req.duration, unit: req.unit } : undefined,
          lineup_note: lineupNote,
          ranges: ranges || undefined
        };
      }
      const offered = rangesSummary(ranges);
      const e = new Error('Deriv rejected every duration offered for this symbol on your account (tried: ' + triedList.join(', ') + ').'
        + (offered ? ' Deriv lists for this symbol: ' + offered + ' \u2014 pick that in the ticket.' : ' Newer demo accounts can have a limited contract lineup.')
        + ' Try another symbol (forex 15m+ or synthetics work best) or a 1-day duration.');
      e.code = 'no_duration_offered';
      throw (lastErr && /duration/i.test(String(lastErr.message)) ? new Error(String(lastErr.message) + ' — ' + e.message) : e);
    },

    /* ---- buy at quoted price ---- */
    async confirm(sid, quote, params) {
      const s = sockets.get(sid);
      /* proposal ids are PER-CONNECTION (official docs): if the quote came
         from a connection that is no longer current, the buy is guaranteed
         to fail — refuse it here and let confirmSmart re-quote instead. */
      if (!s || s.ws.readyState !== 1 || (quote.connId && s.gen !== quote.connId)) {
        throw Object.assign(new Error('Quote connection was recycled — the proposal id is no longer valid.'), { code: 'stale_proposal_connection' });
      }
      /* The buy schema demands the id match ^[\w-]{32,128}$ (or literal "1").
         If the proposal id is irregular, buy with the documented `parameters`
         form instead — { buy: 1, price, parameters: {…} } — and if an
         id-shaped buy is rejected as InvalidContractProposal, fall back to
         the parameters form once before giving up. */
      const idOk = ID_PATTERN.test(String(quote.id));
      let m;
      if (!idOk && params) {
        auditLog('buy_form', { form: 'parameters_direct', id_len: String(quote.id).length });
        m = await wsCall(s.ws, { buy: 1, price: Number(quote.ask), parameters: params }, 'buy');
      } else {
        auditLog('buy_form', { form: 'id', id_len: String(quote.id).length });
        try {
          m = await wsCall(s.ws, { buy: String(quote.id), price: Number(quote.ask) }, 'buy');
        } catch (e) {
          if (e.code !== 'InvalidContractProposal' || !params) throw e;
          auditLog('buy_form', { form: 'parameters_retry', reason: 'InvalidContractProposal on id buy' });
          m = await wsCall(s.ws, { buy: 1, price: Number(quote.ask), parameters: params }, 'buy');
        }
      }
      const b = m.buy || {};
      return {
        contract_id: b.contract_id,
        buy_price: Number(b.buy_price ?? b.purchase_price ?? quote.ask),
        payout: Number(b.payout ?? quote.payout ?? 0),
        balance_after: b.balance_after != null ? Number(b.balance_after) : null, /* authoritative post-buy balance (docs: buy response) */
        transaction_id: b.transaction_id ?? null,
        longcode: b.longcode || null,
        currency: b.currency || quote.currency || 'USD'
      };
    },

    /* ---- contract lifecycle (settlement tracking) ----
       Request shape verified against developers.deriv.com/llms/proposal-open-contract.md:
       { proposal_open_contract: 1, contract_id } → .proposal_open_contract
       { is_expired, is_sold, profit, payout, buy_price, bid_price, exit_spot, … } */
    async contractStatus(sid, accountId, contractId) {
      const url = await otpUrl(sid, accountId);
      const ws = await getSocket(sid, accountId, url);
      const m = await wsCall(ws, { proposal_open_contract: 1, contract_id: Number(contractId) }, 'proposal_open_contract');
      const c = m.proposal_open_contract || {};
      return {
        contract_id: c.contract_id != null ? Number(c.contract_id) : Number(contractId),
        buy_price: c.buy_price != null ? Number(c.buy_price) : null,
        payout: c.payout != null ? Number(c.payout) : null,
        bid_price: c.bid_price != null ? Number(c.bid_price) : null,
        profit: c.profit != null ? Number(c.profit) : null,
        is_expired: c.is_expired === 1 || c.is_expired === true,
        is_sold: c.is_sold === 1 || c.is_sold === true,
        can_sell: c.is_valid_to_sell === 1 || c.is_valid_to_sell === true,   /* Deriv refuses resale on many short binaries [InvalidToSell] */
        date_expiry: c.date_expiry != null ? Number(c.date_expiry) : null,
        date_settlement: c.date_settlement != null ? Number(c.date_settlement) : null,
        exit_spot: (c.exit_spot != null && c.exit_spot !== '') ? Number(c.exit_spot) : null,
        currency: c.currency || 'USD',
        longcode: c.longcode || null
      };
    },

    /* ---- open contracts on the account (portfolio reconciliation) ----
       { portfolio: 1 } -> .portfolio.contracts[] — lets every device show
       EVERY open Deriv contract on the account, not just ones it bought. */
    async portfolio(sid, accountId) {
      const url = await otpUrl(sid, accountId);
      const ws = await getSocket(sid, accountId, url);
      const m = await wsCall(ws, { portfolio: 1 }, 'portfolio');
      const rows = (m.portfolio && m.portfolio.contracts) || [];
      return rows.map((c) => ({
        contract_id: c.contract_id != null ? Number(c.contract_id) : null,
        symbol: c.underlying_symbol || c.symbol || null,      /* e.g. frxUSDJPY */
        contract_type: c.contract_type || null,                /* CALL / PUT */
        buy_price: c.buy_price != null ? Number(c.buy_price) : null,
        payout: c.payout != null ? Number(c.payout) : null,
        date_expiry: c.date_expiry != null ? Number(c.date_expiry) : null,
        date_settlement: c.date_settlement != null ? Number(c.date_settlement) : null,
        date_start: c.date_start != null ? Number(c.date_start) : null,
        currency: c.currency || 'USD',
        longcode: c.longcode || null
      })).filter((c) => c.contract_id);
    },

    /* ---- close early at market ---- */
    async close(sid, contractId) {
      const s = sockets.get(sid);
      if (!s || s.ws.readyState !== 1) throw new Error('Deriv trading socket closed — cannot close right now.');
      const m = await wsCall(s.ws, { sell: Number(contractId), price: 0 }, 'sell');
      return { price: Number(m.sell?.price ?? 0) };
    },

    /* ticket store for the confirm gate */
    stashTicket(tid, sid, quote) { tickets.set(tid, { sid, quote, createdAt: Date.now() }); },
    takeTicket(tid) {
      const t = tickets.get(tid);
      tickets.delete(tid);
      if (!t) return null;
      if (Date.now() - t.createdAt > 120000) return null; /* quotes go stale */
      return t;
    },
    /* context peek without the TTL rule — confirm no longer trusts the old
       id at all (it always re-quotes), so age is irrelevant */
    takeTicketAny(tid) {
      const t = tickets.get(tid);
      tickets.delete(tid);
      return t || null;
    },

    /* drop ONLY the trading socket (keep the session) so the next call
       opens a brand-new connection (fresh OTP, fresh generation) */
    dropSocket(sid) {
      const s = sockets.get(sid);
      if (s) { if (s.iv) clearInterval(s.iv); try { s.ws.close(); } catch (e) {} sockets.delete(sid); }
    }
  };

  /* Confirm with self-healing. Proposal ids are per-connection (official
     docs) and quote sockets get recycled, so a buy can die between quote
     and confirm. Defence in depth:
       1. pre-emptive — confirm() refuses to buy when the quote's connection
          is no longer current (stale_proposal_connection);
       2. reactive  — on any invalid/expired-proposal error, re-quote at the
          SAME accepted duration on the current connection and buy again;
       3. deep      — last resort: force a brand-new connection (fresh OTP)
          and quote+buy there.
  */
  api.confirmSmart = async function (sid, quote, ctx) {
    const isStale = (e) => e && (e.code === 'stale_proposal_connection' || /InvalidContractProposal|InvalidProposal|expired|not available|stale|socket closed/i.test(String(e.message || e)));
    let requoted = false;
    let q = quote;
    const requote = async (fresh) => {
      if (!ctx || !ctx.accountId) throw new Error('Cannot re-quote without ticket context.');
      if (fresh) api.dropSocket(sid);
      q = await api.quote(sid, { accountId: ctx.accountId, derivSymbol: ctx.derivSymbol, side: ctx.side, amount: ctx.amount, duration: quote.duration, duration_unit: quote.duration_unit });
      requoted = true;
    };
    const buyParams = () => ({
      amount: Number(ctx.amount),
      basis: 'stake',
      contract_type: ctx.side === 'SELL' ? 'PUT' : 'CALL',
      currency: q.currency || 'USD',
      duration: q.duration,
      duration_unit: q.duration_unit,
      underlying_symbol: String(ctx.derivSymbol)
    });
    let order;
    try {
      order = await api.confirm(sid, q, buyParams());
    } catch (e) {
      if (!isStale(e)) throw e;
      await requote(false);
      try {
        order = await api.confirm(sid, q, buyParams());
      } catch (e2) {
        if (!isStale(e2)) throw e2;
        await requote(true);
        order = await api.confirm(sid, q, buyParams());
      }
    }
    return { order, requoted };
  };

  /* Confirm the way the user's flow demands: the displayed quote only fixes
     symbol/side/amount/duration — a FRESH proposal is requested the instant
     confirm runs, and ONLY that new id is bought (same connection, same
     breath). The old id is never sent, so InvalidContractProposal from
     recycled ids is impossible by construction. Escalation (confirmSmart)
     stays as the backstop for anything unexpected. */
  api.confirmSmartFresh = async function (sid, dur, ctx) {
    if (!ctx || !ctx.accountId) throw new Error('Cannot confirm without ticket context.');
    const q = await api.quote(sid, {
      accountId: ctx.accountId, derivSymbol: ctx.derivSymbol, side: ctx.side,
      amount: ctx.amount, duration: dur.duration, duration_unit: dur.duration_unit
    });
    const res = await api.confirmSmart(sid, q, ctx); /* fresh id is current → straight through */
    return { ...res, freshQuote: q };
  };

  return api;
}
