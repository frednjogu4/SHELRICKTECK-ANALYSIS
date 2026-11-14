/*
 * AURUM Cloudflare Worker — read-only signal API adapter.
 *
 * Deliberately separate from the Express server. Only public market-data,
 * deterministic analysis and public headline/calendar routes are exposed
 * (the last two pass on what the named sources publish and derive nothing
 * from it). No broker PAT/account/order,
 * positions, risk-gate, or Exness-bridge routes are implemented here.
 * Exness candles stay on the user's PC; this Worker uses labelled public
 * Deriv candles and labelled Yahoo daily index data as approved fallbacks.
 */
import { DERIV_CODE_MAP, INSTRUMENT_MAP } from '../server/lib/symbols.js';
import { runDeterministicAnalysis, votesSummary, waitReason } from '../server/lib/analyzer.js';
import { localDecision } from '../server/lib/localdecision.js';
import { closedCandleSets } from '../src/closedcandles.js';
import { indexDailySignal, parseYahooChart } from '../server/lib/indices.js';
import { rsi, sma } from '../server/lib/indicators.js';
import { buildProScalperSnapshot } from '../server/lib/indicators.pro.js';
import { parseFfCalendar } from '../server/lib/news.js';
import {
  CALENDAR_KEEP_MS, CALENDAR_LAST_GOOD_MS, CALENDAR_RETRY_MS, CALENDAR_SOURCE, CALENDAR_URL, HEADLINE_SOURCES, HEADLINES_KEEP_MS,
  HEADLINES_RETRY_MS, MAX_FEED_BYTES, NEWS_NOTE, calendarWeek, headlinesFrom, mergeHeadlines, readProviderText, sourceFailure
} from './news.js';
import {
  HttpError, MAX_JSON_BODY_BYTES, WORKER_SECURITY_HEADERS, allowHeader, createBoundedCache,
  describeError, isAppShellPath, logEvent, readJsonObject, withoutBody
} from './platform.js';

function proScalperValidation(candles) {
  const snapshot = buildProScalperSnapshot(candles || []);
  const keys = ['stochasticRsi', 'cci', 'williamsR', 'supertrend', 'ichimoku', 'keltner'];
  const missing = keys.filter((key) => {
    const value = snapshot.indicators && snapshot.indicators[key];
    return value == null || (typeof value === 'object'
      ? Object.values(value).some((item) => item == null || (typeof item === 'number' && !Number.isFinite(item)))
      : typeof value === 'number' && !Number.isFinite(value));
  });
  return Object.assign({}, snapshot, {
    validation: {
      priceIndicatorsValid: snapshot.ok === true && missing.length === 0,
      missingPriceIndicators: missing,
      mode: 'deterministic-candle-snapshot'
    }
  });
}

const DERIV_PUBLIC_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const GRANULARITIES = new Set([60, 300, 3600]);
const SYMBOL_RE = /^[A-Z0-9/._ -]{1,24}$/;
const CODE_RE = /^[A-Za-z0-9_]{2,32}$/;
const INDEX_YAHOO = Object.freeze({
  US30: '^DJI', NAS100: '^NDX', US100: '^NDX', SPX500: '^GSPC',
  GER40: '^GDAXI', UK100: '^FTSE'
});
/* Every route this Worker implements, with the only methods it accepts.
   Anything else under /api is answered with 403 (blocked namespace), 405
   (known route, wrong method) or 501 (route not migrated). */
const API_ROUTES = new Map([
  ['/api/health', ['GET']],
  ['/api/signals/usage', ['GET']],
  ['/api/signals/history', ['GET']],
  ['/api/markets/deriv', ['GET']],
  ['/api/news/feed', ['GET']],
  ['/api/news/calendar', ['GET']],
  ['/api/signals/scan', ['POST']],
  ['/api/signals/analyze', ['POST']],
  ['/api/markets/deriv/candles', ['POST']],
  ['/api/markets/deriv/tick', ['POST']],
  ['/api/history/candles', ['POST']]
]);
/* Broker, account, order and risk namespaces. They are refused first, for
   every method, so no later route can ever be reached underneath them. */
const BLOCKED_API_NAMESPACES = ['/api/deriv', '/api/risk', '/api/ctl'];
/* Upper bound on cached candle responses kept in one isolate's memory. */
const CANDLE_CACHE_MAX_ENTRIES = 128;
const RATE_LIMIT_PERIOD_SECONDS = 60;
const COMMON_HEADERS = {
  'cache-control': 'no-store',
  ...WORKER_SECURITY_HEADERS,
  'x-aurum-runtime': 'cloudflare-readonly'
};
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  ...COMMON_HEADERS
};

function responseJson(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function responseText(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...COMMON_HEADERS, ...extraHeaders }
  });
}

function isBlockedApiPath(pathname) {
  const path = String(pathname || '').toLowerCase();
  return BLOCKED_API_NAMESPACES.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}

function providerError(message, status = 502) {
  return responseJson({ error: 'live_data_unavailable', detail: String(message || 'Public data provider unavailable').slice(0, 160) }, status);
}

/* An upstream failure with the facts a log line needs to tell the causes
   apart: how it failed (kind), how long it took, and the WebSocket close
   code or the provider's own error code when there is one. The message sent
   to the browser is unchanged. */
function feedError(kind, message, extra = {}) {
  const error = new Error(message);
  error.kind = kind;
  return Object.assign(error, extra);
}

/** Short, non-sensitive description of a provider failure for a log line. */
function describeFeedFailure(error) {
  const out = { kind: String((error && error.kind) || 'error').slice(0, 24), message: String((error && error.message) || error || '').slice(0, 160) };
  if (error && Number.isFinite(error.elapsedMs)) out.elapsed_ms = error.elapsedMs;
  if (error && Number.isFinite(error.closeCode)) out.close_code = error.closeCode;
  if (error && error.providerCode) out.provider_code = String(error.providerCode).slice(0, 40);
  return out;
}

function makeDerivRequest(WebSocketImpl, url = DERIV_PUBLIC_URL) {
  return (payload, timeoutMs = 9000) => new Promise((resolve, reject) => {
    if (typeof WebSocketImpl !== 'function') return reject(feedError('no_websocket', 'Workers WebSocket client is unavailable'));
    let socket;
    let settled = false;
    const startedAt = Date.now();
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch (_) {}
      if (ok) { resolve(value); return; }
      const error = value instanceof Error ? value : new Error(String(value));
      if (!Number.isFinite(error.elapsedMs)) error.elapsedMs = Date.now() - startedAt;
      reject(error);
    };
    const timer = setTimeout(() => finish(false, feedError('timeout', 'Deriv public feed timed out')), timeoutMs);
    try {
      socket = new WebSocketImpl(url);
      socket.addEventListener('open', () => {
        try { socket.send(JSON.stringify(payload)); }
        catch (e) { finish(false, e); }
      });
      socket.addEventListener('message', (event) => {
        try {
          const raw = event.data;
          const message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
          if (message.error) {
            finish(false, feedError('provider', String(message.error.message || 'Deriv public feed error'), { providerCode: String(message.error.code || '').slice(0, 40) }));
            return;
          }
          if (message.candles || message.history || message.tick || message.active_symbols) finish(true, message);
        } catch (e) {
          if (!(e instanceof SyntaxError)) finish(false, e);
        }
      });
      socket.addEventListener('error', () => finish(false, feedError('connect', 'Deriv public WebSocket connection failed')));
      socket.addEventListener('close', (event) => {
        if (!settled) finish(false, feedError('closed', 'Deriv public WebSocket closed before returning data', { closeCode: Number(event && event.code) }));
      });
    } catch (e) {
      finish(false, e);
    }
  });
}

function normalizeCandles(raw) {
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

function cleanSymbol(value) {
  const symbol = String(value || '').toUpperCase().trim();
  return SYMBOL_RE.test(symbol) && INSTRUMENT_MAP[symbol] ? symbol : '';
}

function cleanCode(value) {
  const code = String(value || '').trim();
  return CODE_RE.test(code) ? code : '';
}

function publicSymbol(code, row = {}) {
  return {
    code: String(code || ''),
    name: String(row.underlying_symbol_name || row.name || code || ''),
    market: String(row.market || ''),
    submarket: String(row.submarket || ''),
    subgroup: String(row.subgroup || ''),
    symbolType: String(row.underlying_symbol_type || row.symbolType || ''),
    pipSize: Number.isFinite(Number(row.pip_size ?? row.pipSize)) ? Number(row.pip_size ?? row.pipSize) : null,
    open: (row.exchange_is_open ?? row.open) === 1 || row.open === true,
    suspended: (row.is_trading_suspended ?? row.suspended) === 1 || row.suspended === true
  };
}

/**
 * What the newest daily bar of a Yahoo chart answer is: `time` is its epoch
 * second (0 when there is none) and `final` says whether it is a close.
 *
 *   true   the bar's session had ended when the series was read
 *   false  the bar was still forming: its session was open at that moment
 *   null   Yahoo's answer does not allow either statement
 *
 * Yahoo's `meta.currentTradingPeriod.regular` is the session the exchange is
 * in, or the next one it will open. A bar from an earlier day than that
 * session is a close. A bar of the session's own day is a close once the
 * session has ended and is forming while it is open. Bars are compared with
 * the session by UTC day: the index sessions read here (New York, Frankfurt,
 * London) do not cross midnight UTC, and the comparison then holds whether
 * Yahoo stamps a bar with the session's open or with its latest trade.
 */
function dailyBarInfo(json, candles, readAtMs) {
  const newest = candles[candles.length - 1];
  const time = Number(newest && newest.time) > 0 ? Number(newest.time) : 0;
  const regular = json?.chart?.result?.[0]?.meta?.currentTradingPeriod?.regular;
  const start = Number(regular?.start);
  const end = Number(regular?.end);
  /* A missing or unusable session: `end > start` is false for anything that is not two
     ordered numbers, and a start of 0 is a day long before any bar (answered below). */
  if (!time || !(end > start)) return { time, final: null };
  const utcDay = (seconds) => Math.floor(seconds / 86400);
  const readAt = readAtMs / 1000;
  if (utcDay(time) < utcDay(start)) return { time, final: true };
  if (utcDay(time) > utcDay(start)) return { time, final: null };
  return { time, final: readAt >= end ? true : readAt >= start ? false : null };
}

function freshCandles(candles, minimum = 50) {
  if (candles.length < minimum) throw new Error('Deriv returned fewer than ' + minimum + ' usable candles');
  return candles;
}

function createReadOnlyWorker({
  requestImpl,
  fetchImpl = (...args) => fetch(...args),
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  log = logEvent
} = {}) {
  const derivRequest = requestImpl || makeDerivRequest(WebSocketImpl);
  const cache = createBoundedCache(CANDLE_CACHE_MAX_ENTRIES);
  const yahooCache = new Map();
  let activeSymbolsCache = { at: 0, rows: null };

  async function fetchActiveSymbols() {
    if (activeSymbolsCache.rows && now() - activeSymbolsCache.at < 5 * 60 * 1000) return activeSymbolsCache.rows;
    const message = await derivRequest({ active_symbols: 'brief', req_id: 1 }, 10000);
    const raw = message && message.active_symbols;
    if (!Array.isArray(raw)) throw new Error('Deriv returned no active-symbol list');
    const rows = raw.map((s) => publicSymbol(s.underlying_symbol, s))
      .filter((s) => CODE_RE.test(s.code) && s.name);
    activeSymbolsCache = { at: now(), rows };
    return rows;
  }

  /* ---- headlines and the economic calendar: what the named public sources
     publish, passed on as published. One answer is kept for a few minutes, and
     a failure for a shorter time, so that a source is not asked again for every
     request. (Requests that arrive while the first one is still waiting each
     ask once: a pending answer is not shared between requests in a Worker.) ---- */
  let headlinesKept = null;
  let calendarKept = null;
  let calendarRead = null;

  async function providerText(address, accept) {
    const res = await fetchImpl(address, { headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; aurum-news)' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw feedError('http', 'HTTP ' + res.status);
    return readProviderText(res, MAX_FEED_BYTES);
  }

  /* { ok: true, payload } or { ok: false, detail, sources }. `sources` says for each feed whether it answered. */
  async function loadHeadlines(route) {
    if (headlinesKept && now() - headlinesKept.at < (headlinesKept.ok ? HEADLINES_KEEP_MS : HEADLINES_RETRY_MS)) return headlinesKept;
    const startedAt = now();
    const settled = await Promise.allSettled(HEADLINE_SOURCES.map((source) => providerText(source.url, 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5')));
    const lists = [];
    const sources = settled.map((result, index) => {
      const name = HEADLINE_SOURCES[index].name;
      if (result.status !== 'fulfilled') {
        log('warn', 'provider_feed_failed', { route, requested: 1, failed: 1, duration_ms: Math.max(0, now() - startedAt), target: name, first: { provider: 'news', ...describeFeedFailure(result.reason) } });
        return { name, ok: false, error: sourceFailure(result.reason) };
      }
      const items = headlinesFrom(name, result.value);
      lists.push(items);
      return items.length ? { name, ok: true, headlines: items.length } : { name, ok: false, error: 'no headlines in the answer' };
    });
    const items = mergeHeadlines(lists);
    headlinesKept = items.length
      ? { at: now(), ok: true, payload: { ts: new Date(now()).toISOString(), fetched_at: now(), items, sources, note: NEWS_NOTE } }
      : { at: now(), ok: false, sources, detail: 'No headline source could be read from the cloud right now (' + sources.map((source) => source.name + ': ' + source.error).join('; ') + '). No substitute headlines are shown.' };
    return headlinesKept;
  }

  /* The rows of the calendar feed, or the reason they could not be read. The day asked for is applied per request. */
  async function loadCalendar(route) {
    if (calendarKept && now() - calendarKept.at < (calendarKept.ok && !calendarKept.retry ? CALENDAR_KEEP_MS : CALENDAR_RETRY_MS)) return calendarKept;
    const startedAt = now();
    try {
      const text = await providerText(CALENDAR_URL, 'application/json');
      let rows;
      try { rows = JSON.parse(text); } catch (_) { throw feedError('shape', 'calendar answer is not JSON'); }
      if (!Array.isArray(rows)) throw feedError('shape', 'calendar answer is not a list');
      calendarKept = calendarRead = { at: now(), readAt: now(), ok: true, rows, week: calendarWeek(rows) };
    } catch (e) {
      log('warn', 'provider_feed_failed', { route, requested: 1, failed: 1, duration_ms: Math.max(0, now() - startedAt), target: 'calendar', first: { provider: 'news', ...describeFeedFailure(e) } });
      /* The source did not answer. The copy read last is still the schedule for some hours: it is passed on with the
         time it was read, and the source is asked again after the retry time. Without such a copy the route says so. */
      calendarKept = calendarRead && now() - calendarRead.readAt < CALENDAR_LAST_GOOD_MS
        ? { ...calendarRead, at: now(), retry: true }
        : { at: now(), ok: false, detail: 'The calendar source could not be read from the cloud right now (' + CALENDAR_SOURCE + ': ' + sourceFailure(e) + '). No events are assumed.' };
    }
    return calendarKept;
  }

  /* Deriv counts back in time: without a start it answers with the candles of the last `count` candle
     widths, which are fewer than `count` when the market was closed in that time. `acrossClosures`
     asks for the newest `count` candles there are (see fetchCandlesByCode in src/derivhistory.js). */
  async function fetchCandlesByCode(code, granularity, count, acrossClosures = false) {
    const key = 'c:' + code + ':' + granularity + ':' + count + (acrossClosures ? ':across' : '');
    const hit = cache.get(key);
    if (hit && now() - hit.at < (granularity <= 60 ? 20000 : granularity <= 300 ? 60000 : 300000)) return hit.value;
    const message = await derivRequest(acrossClosures
      ? { ticks_history: code, adjust_start_time: 1, count, end: 'latest', start: 1, style: 'candles', granularity, req_id: 1 }
      : { ticks_history: code, count, end: 'latest', style: 'candles', granularity, req_id: 1 }, 10000);
    const candles = normalizeCandles(message && (message.candles || message.history?.candles));
    if (!candles.length) throw new Error('Deriv returned no usable candles');
    cache.set(key, { at: now(), value: candles });
    return candles;
  }

  async function fetchCandlesForSymbol(symbol, granularity, count) {
    const code = DERIV_CODE_MAP[symbol];
    if (!code || !CODE_RE.test(code)) throw new Error('No Deriv public candle symbol for ' + symbol);
    return fetchCandlesByCode(code, granularity, count);
  }

  async function fetchTick(code) {
    const message = await derivRequest({ ticks: code, req_id: 1 }, 9000);
    const tick = message && message.tick;
    if (!tick || !Number.isFinite(Number(tick.quote))) throw new Error('Deriv returned no current quote');
    return { quote: Number(tick.quote), epoch: Number(tick.epoch) || null };
  }

  /* The daily series of an index and what its newest bar is: `{ candles, bar }`,
     kept for 15 minutes. `bar` is worked out when the series is read, not when
     it is served, so it always describes the candles it comes with. */
  async function fetchYahooIndex(symbol) {
    const cached = yahooCache.get(symbol);
    if (cached && now() - cached.at < 15 * 60 * 1000) return cached;
    const ticker = INDEX_YAHOO[symbol];
    if (!ticker) throw new Error('No approved public daily-data fallback for ' + symbol);
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?interval=1d&range=1y';
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; aurum-indices)' }, signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error('Yahoo Finance HTTP ' + res.status);
    const json = await res.json();
    const candles = parseYahooChart(json);
    if (candles.length < 60) throw new Error('Yahoo Finance returned insufficient daily history');
    const entry = { at: now(), candles, bar: dailyBarInfo(json, candles, now()) };
    yahooCache.set(symbol, entry);
    return entry;
  }

  /* `failures`, when given, collects one entry per market that could not be
     read, so the route can write a single log line for the whole request. */
  async function scanOne(rawSymbol, failures = null) {
    const symbol = cleanSymbol(rawSymbol);
    if (!symbol) return null;
    try {
      if (INDEX_YAHOO[symbol]) {
        const { candles, bar } = await fetchYahooIndex(symbol);
        const sig = indexDailySignal(candles, { sma, rsi });
        if (!sig.ok) throw new Error('Insufficient daily history');
        const source = 'Yahoo Finance public daily data';
        return {
          symbol, price: sig.price, mtf_signal: sig.bias.toUpperCase(), data_ok: true,
          signal: sig.signal, bias: sig.bias, votes: sig.votes,
          wait_reason: sig.signal === 'WAIT' ? 'daily_no_setup' : null,
          wait_detail: sig.signal === 'WAIT' ? 'Daily indicators are mixed — no directional edge today.' : null,
          confidence: sig.confidence, entry: null, stop_loss: null, tp1: null, tp2: null,
          tf: 'DAILY (index)', model: 'technical-daily', source, data_source: source,
          /* The day this reading speaks for: the newest daily bar it was computed
             from, and whether that bar was a close or still forming. `ts` is only
             the moment of this answer. */
          daily_bar_time: bar.time, daily_bar_final: bar.final, ts: now()
        };
      }
      const [m1, m5, h1] = await Promise.all([
        fetchCandlesForSymbol(symbol, 60, 120),
        fetchCandlesForSymbol(symbol, 300, 120),
        fetchCandlesForSymbol(symbol, 3600, 120)
      ]);
      /* Finished candles only, as of the last 5-minute close: the same reading this browser makes (src/closedcandles.js). */
      const closed = closedCandleSets({ m1, m5, h1 });
      const det = runDeterministicAnalysis(symbol, closed.sets);
      const proScalper = proScalperValidation(closed.sets.m5 || []);
      const decision = localDecision(det);
      const wr = decision.signal === 'WAIT' ? waitReason(det, { maxAgeSec: 3 * 3600 + 300 }) : null;
      const source = 'Deriv public candles';
      const latest = m1[m1.length - 1];
      return {
        symbol, price: det.analyses.m1?.currentPrice ?? null,
        mtf_signal: det.mtfSignal, data_ok: det.ok,
        signal: decision.signal, bias: decision.bias,
        votes: votesSummary(det.analyses), wait_reason: wr?.code || null, wait_detail: wr?.detail || null,
        confidence: decision.confidence,
        entry: decision.entry, stop_loss: decision.stop_loss, tp1: decision.tp1, tp2: decision.tp2,
        rrr: decision.rrr, tf: 'MTF 1m/5m/1h', model: 'technical',
        source, data_source: source, latest_candle_time: Number(latest?.time || 0), candle_close: closed.close, candle_current: closed.current,
        pro_scalper: proScalper,
        aster: { status: 'NOT_VALIDATED', publishable: false, publicationBlocked: true, publicationDecision: 'BLOCK_PUBLICATION', rejectionReasons: ['This technical-only read does not include the complete ASTER evidence set.'] }, ts: now()
      };
    } catch (e) {
      const source = 'unavailable';
      if (failures) failures.push({ symbol, provider: INDEX_YAHOO[symbol] ? 'yahoo' : 'deriv', ...describeFeedFailure(e) });
      return { symbol, error: 'FEED_ERROR', detail: String(e?.message || e).slice(0, 120), source, data_source: source };
    }
  }

  /* One structured line per request in which a provider failed: which
     markets, which provider, how it failed and how long the request took.
     Market symbols and error text only — never a header, a body, an address
     or anything that identifies the visitor. */
  function logFeedFailures(route, requested, failures, startedAt) {
    if (!failures.length) return;
    const kinds = {};
    for (const f of failures) kinds[f.provider + ':' + f.kind] = (kinds[f.provider + ':' + f.kind] || 0) + 1;
    const first = failures[0];
    log('warn', 'provider_feed_failed', {
      route, requested, failed: failures.length, duration_ms: Math.max(0, now() - startedAt), kinds,
      symbols: failures.map((f) => f.symbol).slice(0, 14),
      first: { symbol: first.symbol, provider: first.provider, kind: first.kind, message: first.message, elapsed_ms: first.elapsed_ms, close_code: first.close_code, provider_code: first.provider_code }
    });
  }

  /* The same line for the routes that read one thing from Deriv. */
  function logProviderFailure(route, error, startedAt, target = '') {
    log('warn', 'provider_feed_failed', { route, requested: 1, failed: 1, duration_ms: Math.max(0, now() - startedAt), target: String(target).slice(0, 32), first: { provider: 'deriv', ...describeFeedFailure(error) } });
  }

  async function runPool(items, limit, task) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        out[index] = await task(items[index]);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async function enforceRateLimit(env, request, bindingName, scope) {
    const limiter = env && env[bindingName];
    if (!limiter || typeof limiter.limit !== 'function') {
      /* Fail closed: a public, provider-backed route must never run unmetered. */
      log('error', 'rate_limiter_not_configured', { binding: bindingName, scope });
      return responseJson({ error: 'rate_limiter_not_configured', detail: 'The Cloudflare rate-limit binding is required for this public API.' }, 503);
    }
    const ip = request.headers.get('cf-connecting-ip') || 'local-dev';
    try {
      const result = await limiter.limit({ key: 'aurum:cloudflare-staging:' + scope + ':' + ip });
      return result && result.success ? null : responseJson(
        { error: 'rate_limited', detail: 'Too many requests; wait one minute and retry.' },
        429, { 'retry-after': String(RATE_LIMIT_PERIOD_SECONDS) }
      );
    } catch (e) {
      /* Fail closed as well, but record why — a broken limiter is an outage. */
      log('error', 'rate_limiter_unavailable', { binding: bindingName, scope, ...describeError(e) });
      return responseJson({ error: 'rate_limiter_unavailable', detail: 'Rate limiting is temporarily unavailable; retry shortly.' }, 503, { 'retry-after': '30' });
    }
  }

  /* Shared request-body handling for the POST routes: size, media type and
     JSON-shape problems become 413/415/400; anything unexpected is rethrown
     to the top-level handler so it is logged and answered with a 500. */
  async function readBody(request) {
    try {
      return { body: await readJsonObject(request, MAX_JSON_BODY_BYTES) };
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return { rejected: responseJson(e.detail ? { error: e.code, detail: e.detail } : { error: e.code }, e.status, e.headers) };
    }
  }

  async function handleApi(request, env, url) {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return responseJson({ error: 'cross_origin_not_allowed' }, 403);

    if (isBlockedApiPath(url.pathname)) {
      return responseJson({ error: 'broker_execution_routes_disabled', detail: 'This Cloudflare Worker is analysis-only; broker/account/order routes are not implemented.' }, 403);
    }

    const allowedMethods = API_ROUTES.get(url.pathname);
    if (!allowedMethods) return responseJson({ error: 'cloudflare_route_not_migrated' }, 501);
    const allow = allowHeader(allowedMethods);
    /* Same-origin OPTIONS only (a foreign Origin was refused above). No
       Access-Control-Allow-* header is ever sent, so cross-origin reads stay impossible. */
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...COMMON_HEADERS, allow } });
    /* HEAD is answered as GET with the body removed by the caller. */
    const method = request.method === 'HEAD' && allowedMethods.includes('GET') ? 'GET' : request.method;
    if (!allowedMethods.includes(method)) {
      return responseJson({ error: 'method_not_allowed', detail: 'Use ' + allowedMethods.join(' or ') + ' for this route.' }, 405, { allow });
    }

    if (url.pathname === '/api/health' && method === 'GET') {
      return responseJson({
        ok: true, runtime: 'cloudflare-readonly', build: 'read-only-signal-adapter-v1',
        engines: { claude: false, chatgpt: false, perplexity: false },
        default_model: 'technical', live_feed: 'deriv-public-websocket',
        symbols: Object.keys(DERIV_CODE_MAP).filter((s) => DERIV_CODE_MAP[s]).length,
        budget: { cap: 0, spent: 0 }, available_now: [],
        data_sources: ['Deriv public candles', 'Yahoo Finance public daily data'],
        exness: 'PC-local only; no Exness data is sent to Cloudflare', execution: false
      });
    }

    if (url.pathname === '/api/signals/usage' && method === 'GET') {
      return responseJson({ cost: 0, cap: 0, day: new Date(now()).toISOString().slice(0, 10), mode: 'technical-only' });
    }
    if (url.pathname === '/api/signals/history' && method === 'GET') return responseJson({ signals: [] });

    if (url.pathname === '/api/signals/scan' && method === 'POST') {
      const limited = await enforceRateLimit(env, request, 'AURUM_SIGNAL_LIMITER', 'signals-scan');
      if (limited) return limited;
      const { body, rejected } = await readBody(request);
      if (rejected) return rejected;
      const requested = Array.isArray(body.symbols) ? body.symbols.slice(0, 14) : [];
      const symbols = [...new Set(requested.map((x) => cleanSymbol(x)).filter(Boolean))];
      if (!symbols.length) return responseJson({ error: 'symbols_required', detail: 'Provide one or more supported AURUM market symbols.' }, 400);
      const startedAt = now();
      const failures = [];
      const results = await runPool(symbols, 4, (symbol) => scanOne(symbol, failures));
      logFeedFailures(url.pathname, symbols.length, failures, startedAt);
      return responseJson({ results: results.filter(Boolean), feed: 'deriv-public', analysis_only: true, ts: now() });
    }

    if (url.pathname === '/api/signals/analyze' && method === 'POST') {
      const limited = await enforceRateLimit(env, request, 'AURUM_SIGNAL_LIMITER', 'signals-analyze');
      if (limited) return limited;
      const { body, rejected } = await readBody(request);
      if (rejected) return rejected;
      const symbol = cleanSymbol(body.symbol);
      if (!symbol) return responseJson({ error: 'invalid_symbol' }, 400);
      if (body.candleSets != null || body.dataSource === 'Exness MT5 local candles') {
        return responseJson({ error: 'exness_local_only', detail: 'Exness candles are not accepted by the Cloudflare API. Analyze them in the local browser/PC app.' }, 403);
      }
      const startedAt = now();
      if (INDEX_YAHOO[symbol]) {
        const failures = [];
        const result = await scanOne(symbol, failures);
        logFeedFailures(url.pathname, 1, failures, startedAt);
        return result?.error ? providerError(result.detail) : responseJson({ ...result, timeframe: 'DAILY', news: { available: false, reason: 'technical_only' }, meta: { mode: 'technical', reason: 'cloudflare_readonly', engines: [], spent: 0, cap: 0, cached: false, at: new Date(now()).toISOString() } });
      }
      try {
        const [m1, m5, h1] = await Promise.all([
          fetchCandlesForSymbol(symbol, 60, 120),
          fetchCandlesForSymbol(symbol, 300, 120),
          fetchCandlesForSymbol(symbol, 3600, 120)
        ]);
        const closed = closedCandleSets({ m1, m5, h1 });
        const det = runDeterministicAnalysis(symbol, closed.sets);
        const proScalper = proScalperValidation(closed.sets.m5 || []);
        const decision = localDecision(det);
        const wr = decision.signal === 'WAIT' ? waitReason(det, { maxAgeSec: 3 * 3600 + 300 }) : null;
        const latest = m1[m1.length - 1];
        const source = 'Deriv public candles';
        return responseJson({
          ...decision, symbol, timeframe: 'MTF', price: det.analyses.m1?.currentPrice ?? null,
          mtf_signal: det.mtfSignal, votes: votesSummary(det.analyses),
          wait_reason: wr?.code || null, wait_detail: wr?.detail || null,
          data_ok: det.ok, sentiment_score: 50, sentiment_source: 'derived',
          news: { available: false, reason: 'technical_only' }, data_source: source,
          latest_candle_time: Number(latest?.time || 0),
          candle_close: closed.close,
          candle_current: closed.current,
          pro_scalper: proScalper,
          aster: { status: 'NOT_VALIDATED', publishable: false, publicationBlocked: true, publicationDecision: 'BLOCK_PUBLICATION', rejectionReasons: ['This technical-only read does not include the complete ASTER evidence set.'] },
          meta: { mode: 'technical', reason: 'cloudflare_readonly', engines: [], spent: 0, cap: 0, cached: false, at: new Date(now()).toISOString() }
        });
      } catch (e) {
        logProviderFailure(url.pathname, e, startedAt, symbol);
        return providerError(e?.message || e);
      }
    }

    if (url.pathname === '/api/markets/deriv' && method === 'GET') {
      const limited = await enforceRateLimit(env, request, 'AURUM_MARKET_LIMITER', 'markets-catalog');
      if (limited) return limited;
      const startedAt = now();
      try { return responseJson({ markets: await fetchActiveSymbols(), source: 'Deriv public active_symbols', data_status: 'live_catalogue', ts: now() }); }
      catch (e) {
        logProviderFailure(url.pathname, e, startedAt, 'active_symbols');
        return responseJson({ error: 'deriv_catalog_unavailable', detail: String(e?.message || e).slice(0, 120) }, 502);
      }
    }

    if (url.pathname === '/api/news/feed' && method === 'GET') {
      const limited = await enforceRateLimit(env, request, 'AURUM_MARKET_LIMITER', 'news-feed');
      if (limited) return limited;
      const kept = await loadHeadlines(url.pathname);
      return kept.ok ? responseJson(kept.payload) : responseJson({ error: 'news_unavailable', detail: kept.detail, sources: kept.sources }, 502);
    }

    if (url.pathname === '/api/news/calendar' && method === 'GET') {
      const limited = await enforceRateLimit(env, request, 'AURUM_MARKET_LIMITER', 'news-calendar');
      if (limited) return limited;
      const kept = await loadCalendar(url.pathname);
      if (!kept.ok) return responseJson({ error: 'calendar_unavailable', detail: kept.detail }, 502);
      const today = new Date(now());
      /* `day` and `events` are the UTC day of the request, as the PC server sends them; `week` is every entry of the feed with its moment. */
      return responseJson({ ts: today.toISOString(), fetched_at: kept.readAt, day: today.toISOString().slice(0, 10), source: CALENDAR_SOURCE, events: parseFfCalendar(kept.rows, today), week: kept.week });
    }

    if ((url.pathname === '/api/markets/deriv/candles' || url.pathname === '/api/markets/deriv/tick' || url.pathname === '/api/history/candles') && method === 'POST') {
      const limited = await enforceRateLimit(env, request, 'AURUM_MARKET_LIMITER', url.pathname === '/api/history/candles' ? 'history-candles' : 'markets-data');
      if (limited) return limited;
      const { body, rejected } = await readBody(request);
      if (rejected) return rejected;
      const startedAt = now();
      if (url.pathname === '/api/history/candles') {
        const symbol = cleanSymbol(body.sym);
        const granularity = Number(body.granularity);
        const count = Math.max(50, Math.min(2000, Number(body.count) || 400));
        if (!symbol || !DERIV_CODE_MAP[symbol]) return responseJson({ error: 'unknown_symbol' }, 400);
        if (![60, 180, 300, 900, 1800, 3600, 14400, 86400].includes(granularity)) return responseJson({ error: 'bad_granularity' }, 400);
        try {
          const candles = freshCandles(await fetchCandlesByCode(DERIV_CODE_MAP[symbol], granularity, count, body.across_closures === true), 30);
          return responseJson({ source: 'deriv-public', instrument: symbol, granularity, count: candles.length, fetched_at: new Date(now()).toISOString(), candles });
        } catch (e) {
          logProviderFailure(url.pathname, e, startedAt, symbol);
          return providerError(e?.message || e);
        }
      }
      const code = cleanCode(body.code);
      if (!code) return responseJson({ error: 'invalid_market_code' }, 400);
      try {
        const markets = await fetchActiveSymbols();
        const market = markets.find((m) => m.code === code);
        if (!market) return responseJson({ error: 'market_not_active_on_deriv' }, 404);
        if (url.pathname.endsWith('/tick')) {
          const tick = await fetchTick(code);
          return responseJson({ code, name: market.name, quote: tick.quote, epoch: tick.epoch, source: 'Deriv public tick', data_status: 'live', ts: now() });
        }
        const granularity = Number(body.granularity);
        if (!GRANULARITIES.has(granularity)) return responseJson({ error: 'invalid_granularity', allowed: [60, 300, 3600] }, 400);
        const count = Math.max(50, Math.min(300, Number(body.count) || 120));
        const candles = freshCandles(await fetchCandlesByCode(code, granularity, count), 50);
        return responseJson({ code, name: market.name, market: market.market, candles, source: 'Deriv public candles', data_status: 'live', ts: now() });
      } catch (e) {
        logProviderFailure(url.pathname, e, startedAt, code);
        return responseJson({ error: url.pathname.endsWith('/tick') ? 'deriv_market_tick_unavailable' : 'deriv_market_history_unavailable', detail: String(e?.message || e).slice(0, 120) }, 502);
      }
    }

    /* Unreachable while API_ROUTES and the handlers above stay in step; kept
       so a route added to the table without a handler fails loudly, not open. */
    return responseJson({ error: 'cloudflare_route_not_migrated' }, 501);
  }

  /* Non-API requests. Files that exist in dist/ are served by Cloudflare's
     asset layer before this Worker runs, so a request arriving here matched
     no static file: plain app paths such as /app get the single-page shell,
     everything else gets a real 404 instead of a 200 HTML page. */
  async function serveApp(request, env, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return responseText('Method not allowed', 405, { allow: 'GET, HEAD' });
    }
    const assets = env.ASSETS;
    if (!assets || typeof assets.fetch !== 'function') {
      log('error', 'assets_binding_missing', { path: url.pathname });
      return responseJson({ error: 'assets_unavailable', detail: 'The static asset binding is not configured for this deployment.' }, 503);
    }
    if (!isAppShellPath(url.pathname)) return responseText('Not found', 404);
    const shell = await assets.fetch(new Request(new URL('/', url), { method: request.method, headers: request.headers }));
    /* 2xx covers a full (200) or partial (206, Range request) page; 304 is a
       cache revalidation. Anything else means the build has no index.html. */
    if (shell.ok || shell.status === 304) return shell;
    log('error', 'app_shell_unavailable', { path: url.pathname, status: shell.status });
    return responseJson({ error: 'app_shell_unavailable', detail: 'The app shell is missing from this deployment. Rebuild the UI assets and redeploy.' }, 503);
  }

  return {
    async fetch(request, env, ctx) {
      const bindings = env || {};
      let path = '';
      try {
        const url = new URL(request.url);
        path = url.pathname;
        if (path === '/api' || path.startsWith('/api/')) {
          const response = await handleApi(request, bindings, url);
          return request.method === 'HEAD' ? withoutBody(response) : response;
        }
        return await serveApp(request, bindings, url);
      } catch (e) {
        /* Last line of defence: never leak a stack trace or a platform error
           page, and never fail silently. Only the method, path and a short
           error description are logged — no headers, query string or body. */
        log('error', 'unhandled_exception', { method: request.method, path, ...describeError(e) });
        return responseJson({ error: 'internal_error', detail: 'Unexpected server error. Retry shortly.' }, 500);
      }
    }
  };
}

const worker = createReadOnlyWorker();
export default worker;
export { createReadOnlyWorker };
