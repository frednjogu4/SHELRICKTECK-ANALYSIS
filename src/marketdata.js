/* ================================================================
 * AURUM — browser live-price engine (Deriv PUBLIC feed, no key).
 *
 * Real ticks only. No simulated prices anywhere:
 *   - status 'connecting' -> 'live'  (first tick received)
 *   - status 'unavailable' when WebSocket is missing (jsdom) or the
 *     feed cannot be reached -> UI must render '—', never invent data.
 * Reconnects with capped backoff; watchdog restarts silent sockets.
 * ================================================================ */

import { DERIV_CODE_MAP, INSTRUMENTS } from '../server/lib/symbols.js';

export const DERIV_PUBLIC_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

let historyReqId = 1000;
/** Read-only public candle history for standalone/file:// builds that have no AURUM API server. */
export function fetchPublicCandles(symbol, granularity = 60, count = 120, { timeoutMs = 12000, WebSocketImpl = globalThis.WebSocket } = {}) {
  const code = DERIV_CODE_MAP[symbol];
  if (!code) return Promise.reject(new Error('No verified Deriv candle mapping for ' + symbol));
  if (typeof WebSocketImpl !== 'function') return Promise.reject(new Error('WebSocket is unavailable for live Deriv candle history.'));
  const g = Number(granularity), n = Number(count);
  if (!Number.isInteger(g) || g < 60 || !Number.isInteger(n) || n < 50 || n > 500) return Promise.reject(new Error('Invalid Deriv candle request.'));
  return new Promise((resolve, reject) => {
    let ws, timer, settled = false;
    const reqId = ++historyReqId;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; try { ws.close(); } catch (_e) {} }
      fn(value);
    };
    try { ws = new WebSocketImpl(DERIV_PUBLIC_URL); }
    catch (e) { reject(new Error('Could not connect to Deriv public candle feed.')); return; }
    timer = setTimeout(() => done(reject, new Error('Timed out waiting for Deriv public candles.')), timeoutMs);
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ ticks_history: code, count: n, end: 'latest', style: 'candles', granularity: g, req_id: reqId })); }
      catch (_e) { done(reject, new Error('Could not request Deriv public candles.')); }
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(String(event && event.data || '')); } catch (_e) { return; }
      if (msg.req_id != null && Number(msg.req_id) !== reqId) return;
      if (msg.error) {
        const codeSuffix = msg.error.code ? ' [' + String(msg.error.code).slice(0,40) + ']' : '';
        done(reject, new Error(String(msg.error.message || 'Deriv candle request failed').slice(0,160) + codeSuffix));
        return;
      }
      const rows = msg.candles || msg.history && msg.history.candles;
      if (!Array.isArray(rows)) return;
      const candles = rows.map(c => ({ time:Number(c.epoch), open:Number(c.open), high:Number(c.high), low:Number(c.low), close:Number(c.close), volume:0 }))
        .filter(c => [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite));
      if (!candles.length) { done(reject, new Error('Deriv returned no valid candle history for ' + symbol + '.')); return; }
      done(resolve, candles);
    };
    ws.onerror = () => done(reject, new Error('Deriv public candle connection failed.'));
    ws.onclose = () => { if (!settled) done(reject, new Error('Deriv public candle connection closed before history arrived.')); };
  });
}

const prices = {};   // sym -> { px, prev, open, hist:[], time }
const tickCbs = new Set();     // (sym, quote) => void
const statusCbs = new Set();   // (status, detail) => void
let ws = null;
let status = 'idle';
let started = false;
let reconnectT = null;
let backoff = 1000;
let watchdog = null;
let openReqId = 1;

function setStatus(s, detail) {
  status = s;
  statusCbs.forEach((cb) => { try { cb(s, detail); } catch (e) { /* noop */ } });
}

export function feedStatus() { return status; }
export function onStatus(cb) { statusCbs.add(cb); cb(status); return () => statusCbs.delete(cb); }
export function onTick(cb) { tickCbs.add(cb); return () => tickCbs.delete(cb); }

/** Live quote or null (null = no data yet — callers must show '—'). */
export function quote(sym) {
  const q = prices[sym];
  return q ? { px: q.px, open: q.open, hist: q.hist, time: q.time, chg: q.open ? ((q.px - q.open) / q.open) * 100 : 0 } : null;
}

function handleTick(sym, px, time) {
  let q = prices[sym];
  if (!q) {
    q = prices[sym] = { px, prev: px, open: px, hist: [], time };
  } else {
    q.prev = q.px;
    q.px = px;
    q.time = time;
  }
  q.hist.push(px);
  if (q.hist.length > 120) q.hist.shift();
  tickCbs.forEach((cb) => { try { cb(sym, q); } catch (e) { /* noop */ } });
}

function close(code) {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (ws) {
    try { ws.onclose = null; ws.close(); } catch (e) { /* noop */ }
    ws = null;
  }
}

function scheduleReconnect(reason) {
  if (!started) return;
  close();
  setStatus('reconnecting', reason);
  clearTimeout(reconnectT);
  reconnectT = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

function connect() {
  if (!started) return;
  if (typeof WebSocket === 'undefined') { setStatus('unavailable', 'no WebSocket support'); return; }
  close();
  setStatus('connecting');
  try {
    ws = new WebSocket(DERIV_PUBLIC_URL);
  } catch (e) {
    setStatus('unavailable', String(e.message || e));
    return;
  }
  ws.onopen = () => {
    backoff = 1000;
    /* one subscribe message per symbol — batch tick requests with any
       invalid symbol poison the whole message (lesson from testing) */
    INSTRUMENTS.forEach((I) => {
      if (!I.deriv) return; /* index CFDs have no Deriv feed — quoted via the local Exness MT5 bridge */
      try {
        ws.send(JSON.stringify({ ticks_history: I.deriv, style: 'ticks', count: 120, end: 'latest', subscribe: 1, req_id: openReqId, passthrough: { sym: I.s } }));
        openReqId++;
      } catch (e) { /* noop */ }
    });
    /* watchdog: no message for 30s -> reconnect */
    let lastMsg = Date.now();
    ws.onmessage = (ev) => {
      lastMsg = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.error) return; // bad symbol or transient — skip, keep socket
      if (m.tick && m.tick.symbol) {
        /* map Deriv code back to internal symbol */
        const entry = Object.entries(DERIV_CODE_MAP).find(([, code]) => code === m.tick.symbol);
        if (entry) handleTick(entry[0], +m.tick.quote, (m.tick.epoch || 0) * 1000);
      }
    };
    if (watchdog) clearInterval(watchdog);
    watchdog = setInterval(() => {
      if (Date.now() - lastMsg > 30000) scheduleReconnect('watchdog');
    }, 10000);
    setStatus('live');
  };
  ws.onclose = () => { if (started) scheduleReconnect('closed'); };
  ws.onerror = () => { /* onclose follows */ };
}

/** Start the feed (idempotent). Returns current status. */
export function startFeed() {
  if (started) return status;
  started = true;
  backoff = 1000;
  connect();
  return status;
}

/** Stop the feed (sign-out / teardown). */
export function stopFeed() {
  started = false;
  clearTimeout(reconnectT);
  close();
  setStatus('stopped');
}
