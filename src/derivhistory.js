/* ================================================================
 * AURUM — Deriv public candle history for the browser.
 *
 * Why this exists: the cloud viewer analyses the Deriv-backed markets in the
 * visitor's own browser. A scan needs three candle series per market, so the
 * way those are requested matters. This client follows Deriv's published
 * guidance for the public WebSocket API:
 *
 *   - ONE connection, reused: every request of a scan travels over the same
 *     socket and is matched to its answer by req_id;
 *   - paced: a small number of requests in flight, and a hard cap on requests
 *     per minute that stays below Deriv's published budget;
 *   - back off after a rejection instead of asking again at once.
 *
 * The live price stream (marketdata.js) keeps its own socket, so a problem
 * with history requests can never interrupt quotes.
 *
 * Real candles only: a request resolves with validated candles from Deriv or
 * rejects with a reason. Nothing is estimated, an empty answer is an error,
 * and failures are never cached.
 * ================================================================ */

import { DERIV_CODE_MAP } from '../server/lib/symbols.js';
import { DERIV_PUBLIC_URL } from './marketdata.js';

/** Candle widths Deriv serves, in seconds. */
export const GRANULARITIES = Object.freeze([60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400]);
const CODE_RE = /^[A-Za-z0-9_]{2,32}$/;
const RATE_LIMIT_RE = /rate\s*-?\s*limit|too\s*many\s*requests|throttl/i;
/* Failures that mean "the feed answered, but has nothing usable for this request". */
const DATA_FAILURES = Object.freeze(['provider', 'empty', 'unmapped', 'invalid']);

/**
 * Why a candle request failed.
 *   kind 'no-websocket' | 'connect' | 'timeout' | 'rate-limit' | 'budget'
 *        -> the feed could not be reached, or would not take the request now;
 *   kind 'provider' | 'empty' | 'unmapped' | 'invalid'
 *        -> the feed answered, but there is no usable history for this request.
 */
export class CandleError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'CandleError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/** True when a failure says "the feed is unreachable", not "there is no data". */
export function isFeedFailure(error) {
  return !DATA_FAILURES.includes(error && error.kind);
}

/** How long a fetched series is reused; follows the candle period (same values as the PC server). */
export function ttlFor(granularity) { return granularity <= 60 ? 20000 : granularity <= 300 ? 60000 : 300000; }

/**
 * True while no candle of this period has closed between two moments. A copy
 * of a series is not reused across such a close: the candle that was forming
 * when the copy was taken has finished since, and the copy still shows it as
 * it stood. Readings are made from finished candles (closedcandles.js), so
 * they need the candle as it closed.
 */
export function sameCandle(thenMs, nowMs, granularity) {
  const periodMs = Number(granularity) * 1000;
  return Math.floor(thenMs / periodMs) === Math.floor(nowMs / periodMs);
}

/**
 * Deriv candle rows -> { time, open, high, low, close, volume }.
 * Rows that are not finite, not positive, or not a consistent OHLC bar are
 * dropped. Same rule as the Cloudflare Worker, so both analyse identical bars.
 */
export function normalizeCandles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => ({
    time: Number(c && (c.epoch ?? c.time)),
    open: Number(c && c.open),
    high: Number(c && c.high),
    low: Number(c && c.low),
    close: Number(c && c.close),
    volume: Number(c && c.volume) || 0
  })).filter((c) => Number.isFinite(c.time) && c.time > 0 &&
    [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0) &&
    c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high));
}

/**
 * @param {object}   [options]
 * @param {Function} [options.WebSocketImpl]    defaults to the page's WebSocket, looked up when a connection is opened
 * @param {string}   [options.url]
 * @param {Function} [options.now]              () => epoch milliseconds
 * @param {number}   [options.maxInFlight]      requests awaiting an answer at the same time
 * @param {number}   [options.budgetPerMinute]  hard cap on requests sent in any 60 seconds
 * @param {number}   [options.connectTimeoutMs]
 * @param {number}   [options.requestTimeoutMs]
 * @param {number}   [options.lingerMs]         how long an idle connection stays open for the next request
 * @param {number}   [options.retryDelayMs]     wait before the single reconnect after a lost connection
 * @param {number}   [options.maxCacheEntries]
 */
export function createCandleClient({
  WebSocketImpl,
  url = DERIV_PUBLIC_URL,
  now = () => Date.now(),
  maxInFlight = 6,
  budgetPerMinute = 180,
  connectTimeoutMs = 8000,
  requestTimeoutMs = 8000,
  lingerMs = 4000,
  retryDelayMs = 700,
  maxCacheEntries = 160
} = {}) {
  const socketClass = () => WebSocketImpl || globalThis.WebSocket;
  const cache = new Map();      // key -> { at, candles }
  const inFlight = new Map();   // key -> Promise
  const queue = [];             // jobs not sent yet
  const pending = new Map();    // req_id -> job awaiting its answer
  const parked = [];            // jobs waiting for the reconnect timer
  const sentAt = [];            // send times inside the last minute
  const counters = { connections: 0, sent: 0, answered: 0, failed: {} };
  let socket = null;
  let socketOpen = false;
  let connectTimer = null;
  let lingerTimer = null;
  let retryTimer = null;
  let reqSeq = 7000;
  let backoffUntil = 0;
  let backoffMs = 0;
  let lastFailure = null;

  function fail(job, error) {
    clearTimeout(job.timer);
    counters.failed[error.kind] = (counters.failed[error.kind] || 0) + 1;
    lastFailure = { kind: error.kind, message: error.message, at: now() };
    job.reject(error);
  }

  function failQueued(kind, message, extra) {
    for (const job of queue.splice(0)) fail(job, new CandleError(kind, message, extra));
  }

  function withinBudget() {
    const cutoff = now() - 60000;
    while (sentAt.length && sentAt[0] <= cutoff) sentAt.shift();
    return sentAt.length < budgetPerMinute;
  }

  function cancelLinger() { if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; } }

  function closeSocket() {
    const ws = socket;
    socket = null;
    socketOpen = false;
    clearTimeout(connectTimer);
    cancelLinger();
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch (_e) { /* already closed */ }
  }

  /* The connection is lost or silent. Every job that was on it gets ONE more
     attempt on a fresh connection after a short wait; a job that already had
     its second attempt fails with the reason given. */
  function dropSocket(ws, kind, message) {
    if (!ws || socket !== ws) return;
    closeSocket();
    const affected = [...pending.values(), ...queue.splice(0)];
    pending.clear();
    for (const job of affected) {
      clearTimeout(job.timer);
      if (job.attempts < 1) { job.attempts += 1; parked.push(job); }
      else fail(job, new CandleError(kind, message));
    }
    if (!parked.length || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      queue.push(...parked.splice(0));
      pump();
    }, retryDelayMs);
  }

  function openSocket() {
    const Impl = socketClass();
    let ws;
    try { ws = new Impl(url); }
    catch (_e) { failQueued('connect', 'This browser could not open a connection to the Deriv public feed.'); return; }
    socket = ws;
    socketOpen = false;
    counters.connections += 1;
    connectTimer = setTimeout(() => {
      if (!socketOpen) dropSocket(ws, 'connect', 'The Deriv public feed did not accept a connection within ' + Math.round(connectTimeoutMs / 1000) + ' s.');
    }, connectTimeoutMs);
    ws.onopen = () => {
      if (socket !== ws) return;
      socketOpen = true;
      clearTimeout(connectTimer);
      pump();
    };
    ws.onmessage = (event) => { if (socket === ws) handleMessage(event); };
    ws.onerror = () => dropSocket(ws, 'connect', socketOpen
      ? 'The connection to the Deriv public feed failed before the candle history arrived.'
      : 'This browser could not connect to the Deriv public feed.');
    ws.onclose = (event) => {
      const code = Number(event && event.code);
      dropSocket(ws, 'connect', 'The Deriv public feed closed the connection before the candle history arrived' + (code ? ' (code ' + code + ')' : '') + '.');
    };
  }

  function send(job) {
    const ws = socket;
    job.reqId = ++reqSeq;
    pending.set(job.reqId, job);
    sentAt.push(now());
    counters.sent += 1;
    /* A request without an answer means the connection is not working: stop
       waiting on it for the other requests as well. */
    job.timer = setTimeout(() => {
      if (pending.get(job.reqId) === job) dropSocket(ws, 'timeout', 'Deriv did not answer a candle request within ' + Math.round(requestTimeoutMs / 1000) + ' s.');
    }, requestTimeoutMs);
    try { ws.send(JSON.stringify({ ...job.payload, req_id: job.reqId })); }
    catch (_e) {
      pending.delete(job.reqId);
      fail(job, new CandleError('connect', 'The candle request could not be sent to the Deriv public feed.'));
    }
  }

  function pump() {
    if (!queue.length) {
      /* Nothing to send. Keep an idle connection for a moment: the next
         request of the same scan usually follows at once. */
      if (!pending.size && socket && !lingerTimer) {
        lingerTimer = setTimeout(() => { lingerTimer = null; if (!queue.length && !pending.size) closeSocket(); }, lingerMs);
        if (typeof lingerTimer.unref === 'function') lingerTimer.unref(); /* housekeeping only: never keeps a Node process alive */
      }
      return;
    }
    cancelLinger();
    if (!socket) { openSocket(); return; }
    if (!socketOpen) return; /* onopen calls pump() again */
    while (queue.length && pending.size < maxInFlight) {
      if (!withinBudget()) {
        failQueued('budget', 'This browser reached its own limit of ' + budgetPerMinute + ' candle requests per minute; requests resume within a minute.');
        break;
      }
      send(queue.shift());
    }
    if (!queue.length && !pending.size) pump();
  }

  function handleMessage(event) {
    let msg;
    try {
      const raw = event && event.data;
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch (_e) { return; }
    if (!msg || typeof msg !== 'object') return;
    const id = Number(msg.req_id ?? (msg.echo_req && msg.echo_req.req_id));
    const job = pending.get(id);
    if (!job) return; /* not the answer to a request that is still waiting */
    pending.delete(id);
    clearTimeout(job.timer);
    if (msg.error) {
      const code = String(msg.error.code || '').slice(0, 40);
      const text = String(msg.error.message || 'Deriv refused the candle request').slice(0, 160);
      if (RATE_LIMIT_RE.test(code + ' ' + text)) {
        /* One pause per rejected burst; the pause doubles only when a later burst is rejected too. */
        if (now() >= backoffUntil) {
          backoffMs = backoffMs ? Math.min(backoffMs * 2, 300000) : 30000;
          backoffUntil = now() + backoffMs;
        }
        const wait = 'Deriv asked this browser to slow down; candle requests pause for ' + Math.round(backoffMs / 1000) + ' s.';
        fail(job, new CandleError('rate-limit', wait, { retryAt: backoffUntil }));
        failQueued('rate-limit', wait, { retryAt: backoffUntil });
      } else {
        fail(job, new CandleError('provider', text + (code ? ' [' + code + ']' : ''), { providerCode: code }));
      }
    } else {
      const candles = normalizeCandles(msg.candles || (msg.history && msg.history.candles));
      if (!candles.length) fail(job, new CandleError('empty', 'Deriv returned no usable candles for this market and timeframe.'));
      else {
        if (now() >= backoffUntil) backoffMs = 0;
        counters.answered += 1;
        job.resolve(candles);
      }
    }
    pump();
  }

  function enqueue(job) {
    if (typeof socketClass() !== 'function') {
      fail(job, new CandleError('no-websocket', 'This browser has no WebSocket support, so Deriv candle history cannot be requested.'));
      return;
    }
    if (now() < backoffUntil) {
      fail(job, new CandleError('rate-limit', 'Deriv asked this browser to slow down; candle requests resume in ' + Math.max(1, Math.ceil((backoffUntil - now()) / 1000)) + ' s.', { retryAt: backoffUntil }));
      return;
    }
    queue.push(job);
    pump();
  }

  /**
   * Candles for a Deriv market code. Resolves with at least one validated candle or rejects with a CandleError.
   *
   * Deriv counts back in time, not in candles. Asked for `count` candles up
   * to `latest`, it returns the candles that started within the last
   * `count * granularity` seconds. Hours in which the market was closed are
   * part of that time and hold no candles, so after a weekend the answer is
   * shorter than `count`: on Saturday 14 November 2026, 600 candles of
   * EUR/USD were asked for and 526 (5 minutes), 468 (15 minutes), 440
   * (1 hour) and 431 (4 hours) came back, the oldest of them cut off at the
   * second the look-back began. That is the request every caller gets
   * without options.
   *
   * With `acrossClosures` the request names the beginning of the feed's
   * history as its start. Deriv then returns the newest `count` candles
   * there are, however long ago the oldest started, each of them whole: 600
   * on all four timeframes at the same moment. `adjust_start_time` makes a
   * closed market end with the last candle before its close.
   *
   * @param {object}  [options]
   * @param {boolean} [options.acrossClosures]  the newest `count` candles, reaching back across closed hours
   */
  function fetchCandlesByCode(code, granularity = 60, count = 120, { acrossClosures = false } = {}) {
    const dsym = String(code || '');
    const g = Number(granularity), n = Number(count);
    if (!CODE_RE.test(dsym)) return Promise.reject(new CandleError('invalid', 'Invalid Deriv market code.'));
    if (!GRANULARITIES.includes(g) || !Number.isInteger(n) || n < 1 || n > 1000) return Promise.reject(new CandleError('invalid', 'Invalid Deriv candle request.'));
    /* The two kinds of request are different series: neither is handed out in place of the other. */
    const key = dsym + '|' + g + '|' + n + (acrossClosures ? '|across' : '');
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlFor(g) && sameCandle(hit.at, now(), g)) return Promise.resolve(hit.candles);
    if (inFlight.has(key)) return inFlight.get(key);
    const payload = acrossClosures
      ? { ticks_history: dsym, adjust_start_time: 1, count: n, end: 'latest', start: 1, style: 'candles', granularity: g }
      : { ticks_history: dsym, count: n, end: 'latest', style: 'candles', granularity: g };
    const promise = new Promise((resolve, reject) => {
      enqueue({ payload, resolve, reject, attempts: 0, timer: null, reqId: 0 });
    }).then((candles) => {
      cache.delete(key);
      cache.set(key, { at: now(), candles });
      while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
      return candles;
    }).finally(() => { inFlight.delete(key); });
    inFlight.set(key, promise);
    return promise;
  }

  /** Candles for one of the built-in AURUM symbols (EUR/USD, VOL 75, ...). `options` as for fetchCandlesByCode. */
  function fetchCandles(symbol, granularity = 60, count = 120, options = {}) {
    const code = DERIV_CODE_MAP[symbol];
    if (!code) return Promise.reject(new CandleError('unmapped', 'No verified Deriv candle mapping for ' + symbol + '.'));
    return fetchCandlesByCode(code, granularity, count, options);
  }

  /** Counters for diagnostics. Holds no market data and nothing that identifies a person. */
  function stats() {
    withinBudget();
    return {
      connections: counters.connections, sent: counters.sent, answered: counters.answered, failed: { ...counters.failed },
      sentLastMinute: sentAt.length, budgetPerMinute, queued: queue.length + parked.length, pending: pending.size, cached: cache.size,
      connected: !!socket && socketOpen, pausedUntil: backoffUntil > now() ? backoffUntil : 0,
      lastFailure: lastFailure ? { ...lastFailure } : null
    };
  }

  /** Drop the connection and fail whatever is still waiting (page teardown, tests). */
  function close() {
    clearTimeout(retryTimer);
    retryTimer = null;
    const waiting = [...pending.values(), ...queue.splice(0), ...parked.splice(0)];
    pending.clear();
    closeSocket();
    for (const job of waiting) fail(job, new CandleError('connect', 'The candle connection was closed.'));
  }

  return { fetchCandles, fetchCandlesByCode, stats, close, clearCache: () => cache.clear() };
}

/** The client the application uses. Nothing connects until the first request. */
export const candleHistory = createCandleClient();
