/* ================================================================
 * AURUM — Deriv live feed (server side)
 * TWO endpoints, on purpose:
 *   - PUBLIC feed (no keys): wss://api.derivws.com/trading/v1/options/ws/public
 *     live ticks + candles + active symbols.
 *     NOTE: this socket does NOT accept authorize/account methods —
 *     "no recognized method in request" — verified empirically.
 *   - SPEC endpoint (account calls): wss://ws.derivws.com/websockets/v3?app_id=…
 *     authorize / proposal / buy / sell / proposal_open_contract.
 *     Used only for user-token trading flows (tradederiv.js).
 * ================================================================ */

import WebSocket from 'ws';
import { DERIV_CODE_MAP } from './symbols.js';

export const DERIV_PUBLIC_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

/** internal symbol -> Deriv code (single source: lib/symbols.js) */
export const DERIV_SYMBOLS = DERIV_CODE_MAP;

/** One-shot request over a short-lived socket. */
export function derivRequest(payload, timeoutMs = 8000, wsUrl = DERIV_PUBLIC_URL) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(t); try { ws.close(); } catch (e) {} fn(v); };
    const t = setTimeout(() => done(reject, new Error('deriv timeout')), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify(payload)));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.error && m.echo_req) {
        const code = m.error.code ? ' [' + m.error.code + ']' : '';
        return done(reject, new Error(String(m.error.message || 'deriv error') + code));
      }
      if (m.msg_type === 'candles' || m.candles) return done(resolve, m.candles);
      if (m.tick && !payload.subscribe) return done(resolve, m.tick);
      for (const k of ['proposal', 'buy', 'sell', 'proposal_open_contract', 'active_symbols']) {
        if (m[k] !== undefined && m[k] !== null) return done(resolve, m);
      }
      if (m.authorize) return done(resolve, m.authorize);
      if (m.balance) return done(resolve, m.balance);
    });
    ws.on('error', (e) => done(reject, e));
  });
}

let activeSymbolsCache = { at: 0, rows: null };
export async function fetchTickByCode(code, { requestImpl = derivRequest } = {}) {
  const dsym = String(code || '');
  if (!/^[A-Za-z0-9_]{2,32}$/.test(dsym)) throw new Error('invalid Deriv market code');
  const tick = await requestImpl({ ticks: dsym, req_id: 1 }, 8000);
  if (!tick || !Number.isFinite(Number(tick.quote))) throw new Error('Deriv returned no current tick for ' + dsym);
  return { code: dsym, quote: Number(tick.quote), epoch: Number(tick.epoch) || null };
}

export async function fetchActiveSymbols({ force = false, requestImpl = derivRequest } = {}) {
  if (!force && activeSymbolsCache.rows && Date.now() - activeSymbolsCache.at < 5 * 60 * 1000) return activeSymbolsCache.rows;
  const response = await requestImpl({ active_symbols: 'brief', req_id: 1 }, 10000);
  const raw = response && response.active_symbols;
  if (!Array.isArray(raw)) throw new Error('Deriv returned no active-symbol list');
  const rows = raw.map((s) => ({
    code: String(s.underlying_symbol || ''),
    name: String(s.underlying_symbol_name || s.underlying_symbol || ''),
    market: String(s.market || ''),
    submarket: String(s.submarket || ''),
    subgroup: String(s.subgroup || ''),
    symbolType: String(s.underlying_symbol_type || ''),
    pipSize: Number.isFinite(Number(s.pip_size)) ? Number(s.pip_size) : null,
    open: s.exchange_is_open === 1,
    suspended: s.is_trading_suspended === 1,
  })).filter((s) => /^[A-Za-z0-9_]{2,32}$/.test(s.code) && s.name);
  activeSymbolsCache = { at: Date.now(), rows };
  return rows;
}

/* ----------------------------------------------------------------
 * Candle data layer: TTL cache + in-flight dedup + concurrency cap.
 * ---------------------------------------------------------------- */
export function ttlFor(granularity) { return granularity <= 60 ? 20000 : granularity <= 300 ? 60000 : 300000; }

export function createCandleFetcher({ requestImpl = derivRequest, maxActive = 4, ttlOverrideMs = null } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  let active = 0;
  const waiters = [];
  async function withSlot(fn) {
    while (active >= maxActive) await new Promise((r) => waiters.push(r));
    active++;
    try { return await fn(); }
    finally { active--; const w = waiters.shift(); if (w) w(); }
  }
  function stats() { return { cached: cache.size, inFlight: inFlight.size, active }; }

  /* Deriv counts back in time, not in candles. Asked for `count` candles up to `latest`, it answers
     with the candles that started within the last `count * granularity` seconds. Hours in which the
     market was closed are part of that time and hold no candles, so after a weekend the answer is
     shorter than `count` (measured on Saturday 14 November 2026: 468 of 600 fifteen-minute candles
     of EUR/USD). That is the request every caller gets without options.

     With `acrossClosures: true` the request names the beginning of the feed's history as its start.
     Deriv then answers with the newest `count` candles there are, however long ago the oldest
     started (600 of 600 at the same moment), and `adjust_start_time` makes a closed market end with
     the last candle before its close. The two are different series: each has its own copy here.
     The website sends the same two requests (src/derivhistory.js, cloudflare/worker.js). */
  async function fetchCandlesByCode(code, granularity = 300, count = 120, retries = 2, options = {}) {
    const dsym = String(code || '');
    if (!/^[A-Za-z0-9_]{2,32}$/.test(dsym)) throw new Error('invalid Deriv market code');
    const acrossClosures = !!options && options.acrossClosures === true;
    const key = dsym + '|' + granularity + '|' + count + (acrossClosures ? '|across' : '');
    const ttl = ttlOverrideMs != null ? ttlOverrideMs : ttlFor(granularity);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.candles;
    if (inFlight.has(key)) return inFlight.get(key);
    const p = withSlot(async () => {
      let raw = null, lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          raw = await requestImpl(acrossClosures
            ? { ticks_history: dsym, adjust_start_time: 1, count, end: 'latest', start: 1, style: 'candles', granularity }
            : { ticks_history: dsym, count, end: 'latest', style: 'candles', granularity });
          if (Array.isArray(raw) && raw.length) break;
          lastErr = new Error('empty candles for ' + dsym);
        } catch (e) { lastErr = e; }
        if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1) + Math.random() * 250));
      }
      if (!Array.isArray(raw) || !raw.length) throw (lastErr || new Error('empty candles for ' + dsym));
      const candles = raw.map((c) => ({ time: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: 0 }))
        .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite));
      if (!candles.length) throw new Error('no valid candle history for ' + dsym);
      cache.set(key, { t: Date.now(), candles });
      return candles;
    }).finally(() => { inFlight.delete(key); });
    inFlight.set(key, p);
    return p;
  }
  /* `options` as for fetchCandlesByCode. */
  async function fetchCandles(sym, granularity = 300, count = 120, retries = 2, options = {}) {
    const dsym = DERIV_SYMBOLS[sym];
    if (!dsym) throw new Error('no live feed for ' + sym);
    return fetchCandlesByCode(dsym, granularity, count, retries, options);
  }
  return { fetchCandles, fetchCandlesByCode, stats, clear: () => { cache.clear(); inFlight.clear(); } };
}

const defaultFetcher = createCandleFetcher();
export const fetchCandles = defaultFetcher.fetchCandles;
export const fetchCandlesByCode = defaultFetcher.fetchCandlesByCode;
export const feedStats = defaultFetcher.stats;

export async function probeSymbol(sym) {
  const dsym = DERIV_SYMBOLS[sym];
  if (!dsym) return false;
  try { await derivRequest({ ticks_history: dsym, count: 1, end: 'latest', style: 'ticks' }, 5000); return true; }
  catch (e) { return false; }
}
