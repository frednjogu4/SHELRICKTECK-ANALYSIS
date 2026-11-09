/* ================================================================
 * AURUM — persistent Deriv connection manager (server-side only).
 *
 * Security model (per spec):
 *   - APP_ID + DERIV_API_TOKEN + ENVIRONMENT come from ENV only.
 *   - The browser NEVER sees the token: this manager owns the socket,
 *     injects {authorize} first, and never exposes the token in
 *     health, logs (redacted) or relayed messages.
 *   - Fail-fast: missing config => state 'not_configured' with the
 *     exact missing variable names (the platform itself keeps
 *     running keyless for public data/analysis).
 *
 * Reliability:
 *   - ping every 30s, exponential backoff 1s→30s + jitter,
 *   - re-authorize + re-subscribe after every reconnect,
 *   - request_id registry matches every response to its request.
 * ================================================================ */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { log, friendlyDerivError } from './log.js';

export const DEFAULT_SPEC_WS = (appId) => `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
/* endpoint verified reachable from all environments (authorize included) */
export const FALLBACK_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
export const PING_INTERVAL_MS = 30000;
export const REQUEST_TIMEOUT_MS = 12000;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30000;

export function connConfigFromEnv(env = process.env) {
  const appId = String(env.DERIV_APP_ID || '').trim();
  const token = String(env.DERIV_API_TOKEN || '').trim();
  const environment = String(env.ENVIRONMENT || 'demo').toLowerCase() === 'real' ? 'real' : 'demo';
  const primaryUrl = String(env.DERIV_WS_URL || '').trim() || (appId ? DEFAULT_SPEC_WS(appId) : '');
  const missing = [];
  if (!appId) missing.push('DERIV_APP_ID');
  if (!token) missing.push('DERIV_API_TOKEN');
  return {
    appId, token, environment, primaryUrl,
    fallbackUrl: FALLBACK_WS,
    tradingEnabled: String(env.DERIV_TRADING_ENABLED || 'false').toLowerCase() === 'true',
    limits: {
      maxStakeUsd: Number(env.DERIV_MAX_STAKE_USD || 50),
      maxOpenTrades: Number(env.DERIV_MAX_OPEN_TRADES || 5),
      dailyLossLimitUsd: Number(env.DERIV_DAILY_LOSS_LIMIT_USD || 25)
    },
    missing,
    configured: missing.length === 0
  };
}

export function createDerivConn(env = process.env, opts = {}) {
  const cfg = connConfigFromEnv(env);
  const WS = opts.WebSocketImpl || WebSocket;
  const pingMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
  const reqTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const backoffBase = opts.backoffBaseMs ?? BACKOFF_BASE_MS;

  const ee = new EventEmitter();
  let ws = null;
  let state = cfg.configured ? 'idle' : 'not_configured';
  let authorized = false;
  let attempt = 0;
  let usingFallback = false;
  let started = false;
  let stopped = false;
  let pingTimer = null;
  let reconnectTimer = null;
  let reqSeq = 1;
  let lastMessageAt = null;
  let reconnects = 0;
  let authError = null;
  const pending = new Map();          // req_id -> {resolve,reject,timer,kind}
  const subscriptions = new Set();    // payloads to re-send after reconnect
  const streamIds = new Map();        // stream_id -> owning socket tag

  const snapshot = () => ({
    state, authorized, environment: cfg.environment,
    endpoint: usingFallback ? cfg.fallbackUrl : cfg.primaryUrl,
    endpointIsFallback: usingFallback,
    appId: cfg.appId ? String(cfg.appId).slice(0, 4) + '…' : null,
    tokenSet: Boolean(cfg.token),          // presence only — never the value
    tradingEnabled: cfg.tradingEnabled,
    limits: cfg.limits,
    missing: cfg.missing,
    reconnects, attempt, lastMessageAt,
    authError
  });

  function setState(next, extra) {
    state = next;
    log.info('deriv.conn', Object.assign({ state: next }, extra || {}));
    ee.emit('status', snapshot());
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function failPending(reason) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(reason), { deriv: true }));
    }
    pending.clear();
  }

  function scheduleReconnect(reason) {
    if (stopped || !started) return;
    clearTimers();
    if (ws) { try { ws.removeAllListeners(); ws.close(); } catch { /* noop */ } ws = null; }
    authorized = false;
    attempt += 1;
    const delay = Math.min(BACKOFF_MAX_MS, backoffBase * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * Math.min(1500, delay * 0.3)); // ≤30% jitter
    log.warn('deriv.conn', { event: 'reconnect', attempt, delayMs: delay + jitter, reason });
    setState('reconnecting', { delayMs: delay + jitter, reason });
    reconnectTimer = setTimeout(connect, delay + jitter);
  }

  function send(obj) {
    if (!ws || ws.readyState !== WS.OPEN) return false;
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    return true;
  }

  function handleMessage(raw) {
    lastMessageAt = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    /* match response -> request via req_id */
    const rid = msg.req_id;
    if (rid != null && pending.has(rid)) {
      const p = pending.get(rid);
      pending.delete(rid);
      clearTimeout(p.timer);
      if (msg.error) {
        const friendly = friendlyDerivError(msg.error.code, msg.error.message);
        p.reject(Object.assign(new Error(friendly), { deriv: true, code: msg.error.code }));
      } else {
        p.resolve(msg);
      }
      if (msg.msg_type === 'authorize') {
        authorized = true;
        authError = null;
        attempt = 0;                 // stable connection: reset backoff
        setState('authorized', { loginid: msg.authorize?.loginid, currency: msg.authorize?.currency });
      }
    } else if (msg.error && (rid == null)) {
      log.warn('deriv.conn', { event: 'unsolicited_error', code: msg.error.code });
    }

    /* remember subscription stream ids for clean forget on close */
    if (msg.subscription && msg.subscription.id) streamIds.set(msg.subscription.id, true);

    ee.emit('message', msg);         // relay subscribers
  }

  function startPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      send({ ping: 1, req_id: 'ping_' + reqSeq++ });
    }, pingMs);
    pingTimer.unref?.();
  }

  function connect() {
    if (stopped) return;
    if (!cfg.configured && !opts.allowUnconfigured) {
      /* fail fast — clear, actionable, and never crash the platform */
      setState('not_configured');
      log.error('deriv.conn', { event: 'fail_fast', missing: cfg.missing, hint: 'set these in .env.local (see .env.example)' });
      return;
    }
    const url = (!usingFallback && cfg.primaryUrl) ? cfg.primaryUrl : (usingFallback ? cfg.fallbackUrl : cfg.primaryUrl || cfg.fallbackUrl);
    setState('connecting', { endpoint: url, attempt });
    try {
      ws = new WS(url);
    } catch (e) {
      scheduleReconnect('construct_failed');
      return;
    }
    ws.on('open', () => {
      log.info('deriv.conn', { event: 'open', attempt, endpoint: url });
      /* authorize FIRST, before any account-level request */
      if (cfg.token) {
        const authReq = { authorize: cfg.token, req_id: reqSeq++ };
        const p = expect(authReq.req_id, 'authorize');
        send(authReq);
        p.catch((e) => {
          authError = String(e.message || e);
          setState('error', { authError });
          scheduleReconnect('authorize_failed');
        });
      } else {
        setState('connected');
      }
      /* re-subscribe everything registered before the drop */
      for (const payload of subscriptions) send(Object.assign({}, payload, { req_id: reqSeq++ }));
      startPing();
    });
    ws.on('message', (raw) => handleMessage(String(raw)));
    ws.on('close', () => { if (!stopped) scheduleReconnect('socket_closed'); });
    ws.on('error', (e) => {
      /* classic endpoint unreachable? try the verified fallback once */
      if (!usingFallback && cfg.primaryUrl && /econn|timeout|520|522|524/i.test(String(e.message || e))) {
        usingFallback = true;
        log.warn('deriv.conn', { event: 'endpoint_fallback', from: cfg.primaryUrl, to: cfg.fallbackUrl });
        scheduleReconnect('primary_unreachable');
        return;
      }
      log.error('deriv.conn', { event: 'socket_error', message: String(e.message || e).slice(0, 120) });
    });
  }

  /** send a request and await its req_id-matched response */
  function request(payload, timeoutMs = reqTimeoutMs) {
    if (!cfg.configured) {
      return Promise.reject(Object.assign(
        new Error('Deriv module not configured — missing: ' + cfg.missing.join(', ')),
        { deriv: true, notConfigured: true }
      ));
    }
    if (!ws || ws.readyState !== WS.OPEN) {
      return Promise.reject(Object.assign(new Error('Deriv connection not ready — state: ' + state), { deriv: true }));
    }
    const req_id = reqSeq++;
    const body = Object.assign({}, payload, { req_id });
    if (payload.subscribe) {
      subscriptions.add(JSON.parse(JSON.stringify(Object.assign({}, payload, { subscribe: true }))));
    }
    const p = expect(req_id, payload.subscribe ? 'subscribe' : 'request', timeoutMs);
    if (!send(body)) {
      pending.delete(req_id);
      return Promise.reject(Object.assign(new Error('Deriv connection closed before send'), { deriv: true }));
    }
    return p;
  }

  /** promise wired to req_id; SENDS nothing (caller sends) */
  function expect(req_id, kind, timeoutMs = reqTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(req_id);
        reject(Object.assign(new Error('Deriv request timed out'), { deriv: true, timeout: true }));
      }, timeoutMs);
      timer.unref?.();
      pending.set(req_id, { kind, timer, resolve, reject });
    });
  }

  /* convenience wrappers ------------------------------------------------ */
  async function fetchCandles(symbol, granularity, count) {
    const msg = await request({
      ticks_history: symbol, adjust_start_time: 1,
      count, end: 'latest', start: 1, style: 'candles', granularity
    }, 15000);
    const rows = msg.candles || [];
    return rows.map((c) => ({
      time: c.epoch ?? c.time, open: +c.open, high: +c.high,
      low: +c.low, close: +c.close, volume: +(c.volume || 0)
    }));
  }

  function forget(streamId) { send({ forget: streamId, req_id: reqSeq++ }); }
  function forgetAll() { send({ forget_all: '*', req_id: reqSeq++ }); }

  /* lifecycle ----------------------------------------------------------- */
  function start() {
    if (started) return snapshot();
    started = true; stopped = false;
    connect();
    return snapshot();
  }
  function stop() {
    stopped = true; started = false;
    clearTimers();
    failPending('shutting down');
    if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
    authorized = false;
    state = 'stopped';
    ee.emit('status', snapshot());
  }

  return Object.assign(ee, {
    cfg, start, stop, request, fetchCandles, forget, forgetAll,
    health: snapshot,
    get wsOpen() { return Boolean(ws && ws.readyState === WS.OPEN); },
    /* test seam: inject an outbound sender */
    _send: send,
    _internal: { expect, handleMessage, scheduleReconnect, subscriptions, pending }
  });
}
