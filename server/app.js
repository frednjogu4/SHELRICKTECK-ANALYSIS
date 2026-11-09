/* ================================================================
 * AURUM — Express app (factory for testability)
 *   POST /api/signals/analyze   { symbol, force?, withNews? } -> decision JSON
 *   POST /api/news/expectations { symbol }                    -> news brief (Perplexity)
 *   GET  /api/signals/history   ?limit=20
 *   GET  /api/signals/usage     -> today's AI spend (all engines)
 *   GET  /api/health            -> engines/feed/budget
 *
 * Market data: read-only Exness MT5 candles may be supplied by the local
 * browser bridge for MTF analysis; otherwise the explicitly labelled public
 * Deriv/Yahoo analysis fallback is used. No simulation; unavailable data fails closed.
 * AI keys: server env (ANTHROPIC/OPENAI/PERPLEXITY_API_KEY) or per-request
 * x-ai-* headers from the Settings vault. Budget DAILY_BUDGET_USD shared.
 * Identity: `x-aurum-user` header (default 'local') until Supabase Auth.
 * ================================================================ */

import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';
import { log } from './lib/log.js';
import { runDeterministicAnalysis, votesSummary, waitReason } from './lib/analyzer.js';
import { localDecision } from './lib/localdecision.js';
import { makeDecision, availableEngines, newsBriefViaPerplexity, newsBriefAny } from './lib/decision.js';
import { waSend, waStatus, waRateOk } from './lib/wa.js';
import { evaluateRisk, bossVerdict } from './lib/riskgate.js';
import { isTradingKilled, setTradingKilled, requireTrading } from './lib/killswitch.js';
import { runPipeline } from './lib/pipeline/index.js';
import { parseRss, biasFor, calendarTodayUtc, parseFfCalendar, RSS_SOURCES } from './lib/news.js';
import { INDEX_MAP, parseYahooChart, indexDailySignal } from './lib/indices.js';
import { sma, rsi } from './lib/indicators.js';
import { fetchCandles as derivFetchCandles, fetchCandlesByCode as derivFetchCandlesByCode, fetchActiveSymbols as derivFetchActiveSymbols, fetchTickByCode as derivFetchTickByCode, DERIV_SYMBOLS } from './lib/derivfeed.js';
import { createDerivRouter, attachDerivWs } from './derivproxy.js';
import { runBacktest } from './lib/backtest.js';
import { evaluateSetups, DEFAULT_SETUP_CONFIG } from './lib/setups.js';
import { runSetupsBacktest } from './lib/setupsBacktest.js';
import { detectPatterns, studyPatterns, PATTERN_KEYS, PATTERN_META } from './lib/patterns.js';
import { rateLimit, dedupeBody, parseGranularity, parseIntInRange, GRANULARITIES } from './lib/limits.js';
import { resolveSymbolInput, INSTRUMENT_MAP } from './lib/symbols.js';
import { derivAuthorize, derivBuy, derivSell, derivContractStatus } from './lib/tradederiv.js';
import { createPatModule } from './lib/derivpat.js';
import { todayKey } from './lib/store.js';

export function configFromEnv(env = process.env) {
  return {
    apiKey: env.ANTHROPIC_API_KEY || '',
    openaiKey: env.OPENAI_API_KEY || '',
    perplexityKey: env.PERPLEXITY_API_KEY || '',
    model: env.CLAUDE_MODEL || 'claude-opus-4-1',
    openaiModel: env.OPENAI_MODEL || 'gpt-4o',
    perplexityModel: env.PERPLEXITY_MODEL || 'sonar',
    maxTokens: Number(env.CLAUDE_MAX_TOKENS || 800),
    dailyBudgetUsd: Number(env.DAILY_BUDGET_USD || 5),
    timeoutMs: Number(env.CLAUDE_TIMEOUT_MS || 30000),
    port: Number(env.PORT || 4100),
    corsOrigin: String(env.CORS_ORIGIN || '').trim(),
    derivRatePerMin: Number(env.DERIV_PROXY_RATE_PER_MIN || 60),
    backtestRatePerMin: Number(env.BACKTEST_RATE_PER_MIN || 12),
    /* setups module: ANALYSIS-ONLY, opt-in. Default OFF — the endpoints below
       return 503 setups_disabled until AURUM_SETUPS_ENABLED=true. */
    setupsEnabled: String(env.AURUM_SETUPS_ENABLED || '').trim().toLowerCase() === 'true'
  };
}

const SYM_RE = /^[A-Z0-9/._ -]{1,24}$/;
const GRAN = { '1m': 60, '5m': 300, '1h': 3600 };
function cleanSuppliedCandleSets(supplied) {
  if (!supplied || typeof supplied !== 'object') throw new Error('Candle sets are required.');
  const cleanRows = (rows, tf) => {
    if (!Array.isArray(rows) || rows.length < 50 || rows.length > 200) throw new Error(tf + ' candle count must be 50–200.');
    const clean = rows.map((c) => {
      const time = Number(c && c.time), open = Number(c && c.open), high = Number(c && c.high), low = Number(c && c.low), close = Number(c && c.close);
      if (![time, open, high, low, close].every(Number.isFinite) || time <= 0 || Math.min(open, high, low, close) <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high)) throw new Error('Invalid ' + tf + ' OHLC candle.');
      return { time, open, high, low, close, volume: Number(c.volume) || 0 };
    }).sort((a, b) => a.time - b.time);
    const last = clean[clean.length - 1].time, now = Date.now() / 1000;
    const maxAge = tf === 'm1' ? 180 : tf === 'm5' ? 660 : 7260;
    if (last > now + 30 || now - last > maxAge) throw new Error('Exness ' + tf + ' candles are stale.');
    return clean;
  };
  return { m1: cleanRows(supplied.m1, 'm1'), m5: cleanRows(supplied.m5, 'm5'), h1: cleanRows(supplied.h1, 'h1') };
}

export function createApp({ store, config, feed, derivConn = null, patDeps = {} }) {
  const app = express();
  app.set('trust proxy', 1); /* behind the Railway LB: req.ip = real client so per-IP rate limits key correctly */
  const dataFeed = feed || { fetchCandles: derivFetchCandles, symbols: DERIV_SYMBOLS };
  const marketFeed = feed || { fetchCandlesByCode: derivFetchCandlesByCode, fetchActiveSymbols: derivFetchActiveSymbols, fetchTickByCode: derivFetchTickByCode };
  app.use(express.json({ limit: '512kb' }));

  /* ---- security headers (audit finding: none were present) ---- */
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    /* report-only until the single-file inline build gets a strict CSP audit */
    res.set('Content-Security-Policy-Report-Only', "default-src 'self' https: wss: data: blob: 'unsafe-inline'");
    next();
  });

  /* permissive CORS: the single-file export runs from file:// and this
     is a local single-user tool. Revisit when it becomes multi-host. */
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', config.corsOrigin || '*');
    res.set('Access-Control-Allow-Headers', 'content-type,x-aurum-user,x-ai-claude,x-ai-openai,x-ai-perplexity,x-deriv-pat,x-deriv-appid');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const userOf = (req) => String(req.get('x-aurum-user') || 'local').slice(0, 64);
  const aiKeysOf = (req) => ({
    claude: req.get('x-ai-claude') || '',
    openai: req.get('x-ai-openai') || '',
    perplexity: req.get('x-ai-perplexity') || ''
  });

  /* ---- chart pattern recognition (real candles, pure engine) ---- */
  const patternRL = rateLimit({ max: config.backtestRatePerMin, name: 'patterns' });

  app.post('/api/patterns/analyze', patternRL, async (req, res) => {
    const symbol = resolveSymbolInput(req.body?.symbol);
    if (!symbol) return res.status(400).json({ error: 'invalid_symbol', hint: 'e.g. EURUSD or EUR/USD' });
    const granularity = parseGranularity(req.body?.granularity ?? 300);
    if (!granularity) return res.status(400).json({ error: 'invalid_granularity', allowed: [60, 180, 300, 900, 1800, 3600, 14400, 86400] });
    const bars = parseIntInRange(req.body?.bars, 40, 240, 120);
    try {
      const all = await dataFeed.fetchCandles(symbol, granularity, Math.max(bars, 100));
      if (!all || all.length < 30) return res.status(502).json({ error: 'insufficient_history', got: all?.length ?? 0 });
      const window = all.slice(-bars);
      const patterns = detectPatterns(window);
      res.json({ symbol, granularity, bars: window.length, patterns, candles: window, source: 'deriv-candles', ts: Date.now() });
    } catch (e) {
      res.status(502).json({ error: 'patterns_data_unavailable', detail: String(e.message || e).slice(0, 160) });
    }
  });

  app.post('/api/patterns/study', patternRL, async (req, res) => {
    const symbol = resolveSymbolInput(req.body?.symbol);
    if (!symbol) return res.status(400).json({ error: 'invalid_symbol' });
    const granularity = parseGranularity(req.body?.granularity ?? 300);
    if (!granularity) return res.status(400).json({ error: 'invalid_granularity' });
    const bars = parseIntInRange(req.body?.bars, 120, 1200, 600);
    const holdBars = parseIntInRange(req.body?.holdBars, 6, 120, 48);
    const keys = Array.isArray(req.body?.patterns) && req.body.patterns.length
      ? req.body.patterns.filter((k) => PATTERN_KEYS.includes(k)) : null;
    try {
      const candles = await dataFeed.fetchCandles(symbol, granularity, bars);
      if (!candles || candles.length < 80) return res.status(502).json({ error: 'insufficient_history', got: candles?.length ?? 0 });
      const study = studyPatterns(candles, { holdBars, keys });
      res.json(Object.assign({ symbol, granularity, source: 'deriv-candles', ts: Date.now(), meta: PATTERN_META }, study));
    } catch (e) {
      res.status(502).json({ error: 'study_data_unavailable', detail: String(e.message || e).slice(0, 160) });
    }
  });

  /* ---- Deriv secure proxy (server-side token; browser never sees it) ---- */
  /* kill switch (master §16): blocks every BUY-capable route (order/confirm/buy)
     on the env-token router too. Closes/quotes/portfolio stay open — reducing
     risk is always allowed. */
  app.use('/api/deriv', (req, _res, next) => {
    const p = String(req.path || '').replace(/\/+$/, '');
    return /\/(order|confirm|buy)$/.test(p) ? requireTrading(req, _res, next) : next();
  }, createDerivRouter({ conn: derivConn, config }));

  /* ---- backtest: walk-forward on REAL Deriv candles, indicator engine only ---- */
  app.post('/api/backtest',
    rateLimit({ max: config.backtestRatePerMin, name: 'backtest' }),
    async (req, res) => {
      const symbol = resolveSymbolInput(req.body?.symbol);
      if (!symbol) return res.status(400).json({ error: 'invalid_symbol', hint: 'e.g. EURUSD or EUR/USD' });
      const granularity = parseGranularity(req.body?.granularity ?? 300);
      if (!granularity) return res.status(400).json({ error: 'invalid_granularity', allowed: [60, 180, 300, 900, 1800, 3600, 14400, 86400] });
      const bars = parseIntInRange(req.body?.bars, 100, 1500, 500);
      try {
        const candles = await dataFeed.fetchCandles(symbol, granularity, bars);
        if (!candles || candles.length < 70) return res.status(502).json({ error: 'insufficient_history', got: candles?.length ?? 0 });
        const out = runBacktest({ candles, symbol });
        res.json(Object.assign({ granularity, source: 'deriv-candles', ts: Date.now() }, out));
      } catch (e) {
        res.status(502).json({ error: 'backtest_data_unavailable', detail: String(e.message || e).slice(0, 160) });
      }
    });

  /* ---- rule-based setups (ANALYSIS-ONLY): condition breakdown + walk-forward
          scoring. Flag OFF by default (AURUM_SETUPS_ENABLED=true to enable).
          These routes NEVER place orders, touch the sniper, or mutate state —
          display + journaling only. ---- */
  const setupsRL = rateLimit({ windowMs: 60000, max: 12, name: 'setups' });
  /* category: explicit body value wins, else the instrument universe's own
     class (forex/commodities/crypto/synthetics) — never guessed silently */
  const setupsCategory = (raw, symbol) => {
    const v = String(raw || '').toLowerCase().trim();
    if (['forex', 'commodities', 'indices', 'crypto', 'synthetic', 'synthetics'].includes(v)) return v;
    const inst = INSTRUMENT_MAP[symbol];
    if (inst) return inst.c;
    return 'forex';
  };
  const setupsGuard = (req, res) => {
    if (!config.setupsEnabled) { res.status(503).json({ error: 'setups_disabled', hint: 'Set AURUM_SETUPS_ENABLED=true to enable the analysis-only setups module.' }); return false; }
    return true;
  };
  app.post('/api/setups/analyze', setupsRL, (req, res) => {
    if (!setupsGuard(req, res)) return;
    const symbol = resolveSymbolInput(req.body?.symbol);
    if (!symbol) return res.status(400).json({ error: 'invalid_symbol', hint: 'e.g. EURUSD or EUR/USD' });
    const granularity = parseGranularity(req.body?.granularity ?? 300);
    if (!granularity) return res.status(400).json({ error: 'invalid_granularity', allowed: [60, 180, 300, 900, 1800, 3600, 14400, 86400] });
    const sessionStartUTC = Math.max(0, Math.min(23, parseIntInRange(req.body?.sessionStartUTC ?? DEFAULT_SETUP_CONFIG.orb.sessionStartUTC, 0, 23, DEFAULT_SETUP_CONFIG.orb.sessionStartUTC)));
    const category = setupsCategory(req.body?.category, symbol);
    (async () => {
      const candles = await dataFeed.fetchCandles(symbol, granularity, 400);
      const out = evaluateSetups({ symbol, candles, granularity, category, sessionStartUTC });
      res.json(Object.assign({ symbol, granularity, category, sessionStartUTC, source: 'deriv-candles', analysis_only: true, ts: Date.now() }, out));
    })().catch((e) => res.status(502).json({ error: 'setups_data_unavailable', detail: String(e.message || e).slice(0, 160) }));
  });
  app.post('/api/setups/backtest', setupsRL, (req, res) => {
    if (!setupsGuard(req, res)) return;
    const symbol = resolveSymbolInput(req.body?.symbol);
    if (!symbol) return res.status(400).json({ error: 'invalid_symbol', hint: 'e.g. EURUSD or EUR/USD' });
    const granularity = parseGranularity(req.body?.granularity ?? 300);
    if (!granularity) return res.status(400).json({ error: 'invalid_granularity', allowed: [60, 180, 300, 900, 1800, 3600, 14400, 86400] });
    const bars = parseIntInRange(req.body?.bars, 150, 1500, 800);
    const scoring = req.body?.scoring === 'r' ? 'r' : 'binary';
    const category = setupsCategory(req.body?.category, symbol);
    const sessionStartUTC = Math.max(0, Math.min(23, parseIntInRange(req.body?.sessionStartUTC ?? DEFAULT_SETUP_CONFIG.orb.sessionStartUTC, 0, 23, DEFAULT_SETUP_CONFIG.orb.sessionStartUTC)));
    (async () => {
      const candles = await dataFeed.fetchCandles(symbol, granularity, bars);
      const out = runSetupsBacktest({
        symbol, category, candles, granularity, scoring,
        horizonBars: DEFAULT_SETUP_CONFIG.horizonBars,
        spreadPips: Math.max(0, Number(req.body?.spreadPips ?? 2)),
        slippagePips: Math.max(0, Number(req.body?.slippagePips ?? 1)),
        pipSize: Number(req.body?.pipSize ?? 0.0001),
        sessionStartUTC
      });
      res.json(Object.assign({ symbol, granularity, category, source: 'deriv-candles', analysis_only: true, ts: Date.now() }, out));
    })().catch((e) => res.status(502).json({ error: 'setups_backtest_data_unavailable', detail: String(e.message || e).slice(0, 160) }));
  });

  const BOOT_ID = crypto.randomBytes(8).toString('hex'); /* changes on every (re)start — lets the UI detect stale tabs */
  app.get('/api/health', (req, res) => {
    const stats = store.statsToday('local');
    res.json({
      ok: true,
      build: BOOT_ID,
      engines: { claude: Boolean(config.apiKey), chatgpt: Boolean(config.openaiKey), perplexity: Boolean(config.perplexityKey) },
      default_model: config.model,
      live_feed: 'deriv-public',
      symbols: Object.keys(dataFeed.symbols || {}).length,
      budget: { cap: config.dailyBudgetUsd, spent: stats.cost, day: todayKey() },
      available_now: availableEngines(config, {}).engines
    });
  });

  /* ---- MTF analysis on validated local Exness candles, or public Deriv fallback ---- */
  app.post('/api/signals/analyze', async (req, res) => {
    try {
      const body = req.body || {};
      const symbol = String(body.symbol || '').toUpperCase().trim();
      if (!SYM_RE.test(symbol)) return res.status(400).json({ error: 'invalid symbol' });
      if (body.technicalOnly === true && symbol !== 'XAU/USD') return res.status(400).json({ error: 'technical_only_symbol_not_allowed', detail: 'This technical-only route is reserved for the dedicated XAU/USD monitor.' });
      const force = Boolean(body.force);
      const withNews = Boolean(body.withNews);
      const technicalOnly = body.technicalOnly === true;
      const user = userOf(req);
      const reqKeys = aiKeysOf(req);

      /* 5-min active-signal cache (cost guard) unless force */
      const active = store.getActive(user, symbol);
      if (!technicalOnly && active && !force) {
        return res.json(Object.assign({}, active.payload, { meta: Object.assign({}, active.meta, { cached: true }) }));
      }

      /* Prefer validated read-only MT5 candles supplied by the local browser bridge.
         Legacy/server callers retain the public Deriv path as the labelled fallback. */
      let candleSets, dataSource = 'Deriv public candles';
      if (body.candleSets != null) {
        const supplied = body.candleSets;
        if (body.dataSource !== 'Exness MT5 local candles' || !supplied || typeof supplied !== 'object')
          return res.status(400).json({ error: 'invalid_candle_source' });
        try {
          candleSets = cleanSuppliedCandleSets(supplied);
          dataSource = 'Exness MT5 local candles';
        } catch (e) {
          return res.status(400).json({ error: 'invalid_exness_candles', detail: String(e.message || e).slice(0, 160) });
        }
      } else {
        try {
          const [m1, m5, h1] = await Promise.all([
            dataFeed.fetchCandles(symbol, GRAN['1m'], 120),
            dataFeed.fetchCandles(symbol, GRAN['5m'], 120),
            dataFeed.fetchCandles(symbol, GRAN['1h'], 120)
          ]);
          if (!m1?.length || !m5?.length || !h1?.length) throw new Error('empty candles');
          candleSets = { m1, m5, h1 };
        } catch (e) {
          return res.status(502).json({ error: 'live_data_unavailable', detail: String(e.message || e).slice(0, 160) });
        }
      }

      const det = runDeterministicAnalysis(symbol, candleSets);
      const price = det.analyses.m1?.currentPrice ?? null;
      const sentiment = det.sentiment || { score: 50, bias: 'neutral', source: 'derived' };

      /* optional news brief via Perplexity (needs key) */
      let newsBrief = '';
      if (withNews && !technicalOnly) {
        const perpKey = reqKeys.perplexity || config.perplexityKey;
        if (perpKey) {
          try {
            const brief = await newsBriefViaPerplexity(symbol, perpKey, config.perplexityModel, Math.min(config.timeoutMs, 20000));
            newsBrief = brief.text;
            store.recordUsage({ user: 'local', session: user, model: brief.model, tokens_in: brief.tokens_in, tokens_out: brief.tokens_out, cost: (brief.tokens_in + brief.tokens_out) / 1e6, endpoint: '/api/news', engine: 'perplexity' });
          } catch { newsBrief = ''; }
        }
      }

      const { decision, meta } = technicalOnly
        ? { decision: localDecision(det), meta: { mode: 'technical', reason: 'technical_only', engines: [], spent: 0, cap: config.dailyBudgetUsd } }
        : await makeDecision({ det, symbol, sentiment, config, store, user, reqKeys, newsBrief });

      const wr = decision.signal === 'WAIT' ? waitReason(det, { maxAgeSec: 3 * 3600 + 300 }) : null;
      const payload = Object.assign({}, decision, {
        symbol,
        timeframe: 'MTF',
        price,
        mtf_signal: det.mtfSignal,
        votes: votesSummary(det.analyses),
        wait_reason: wr ? wr.code : null,
        wait_detail: wr ? wr.detail : null,
        data_ok: det.ok,
        sentiment_score: sentiment.score,
        sentiment_source: sentiment.source,
        news: newsBrief ? { available: true, brief: newsBrief } : { available: false, reason: technicalOnly ? 'technical_only' : 'no_perplexity_key' },
        data_source: dataSource,
        latest_candle_time: Number(det.analyses.m1?.candles?.slice(-1)[0]?.time || 0)
      });
      const fullMeta = Object.assign({}, meta, { cached: false, at: new Date().toISOString() });

      if (!technicalOnly) store.addSignal({
        user, symbol, timeframe: 'MTF',
        signal: payload.signal, confidence: payload.confidence, entry: payload.entry,
        active: true, created_at: new Date().toISOString(),
        model: payload.model, meta: fullMeta, payload
      });

      res.json(Object.assign({}, payload, { meta: fullMeta }));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  /* ---- technical-only scan on REAL candles (no AI cost) ----
     Used by the scanner grid: honest deterministic signals, $0 AI. */
  const idxCache = new Map(); /* index -> {at, candles} (15-min TTL) */
  app.post('/api/signals/scan', rateLimit({ max: config.backtestRatePerMin, name: 'scan' }), async (req, res) => {
    const wanted = Array.isArray(req.body?.symbols) ? req.body.symbols.slice(0, 14) : [];
    if (!wanted.length) return res.status(400).json({ error: 'symbols_required' });
    const out = await Promise.all(wanted.map(async (rawSym) => {
      const symbol = String(rawSym || '').toUpperCase().trim();
      if (!SYM_RE.test(symbol)) return null;
      try {
        /* US stock indices: Deriv does not carry them (probe-verified) — daily
           candles from Yahoo's public endpoint, one-timeframe technical read,
           labelled 'technical-daily'. Analysis-only: no order levels invented. */
        if (INDEX_MAP[symbol]) {
          let rows = idxCache.get(symbol);
          if (!rows || Date.now() - rows.at > 900000) {
            const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(INDEX_MAP[symbol].yahoo) + '?interval=1d&range=1y', { signal: AbortSignal.timeout(9000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; aurum-indices)' } });
            if (!r.ok) throw new Error('index feed HTTP ' + r.status);
            rows = { at: Date.now(), candles: parseYahooChart(await r.json()) };
            idxCache.set(symbol, rows);
          }
          const sig = indexDailySignal(rows.candles, { sma, rsi });
          if (!sig.ok) throw new Error('insufficient history for ' + symbol);
          return {
            symbol, price: sig.price, mtf_signal: sig.bias.toUpperCase(), data_ok: true,
            signal: sig.signal, bias: sig.bias, votes: sig.votes,
            wait_reason: sig.signal === 'WAIT' ? 'daily_no_setup' : null,
            wait_detail: sig.signal === 'WAIT' ? 'Daily indicators are mixed - no directional edge today.' : null,
            confidence: sig.confidence, entry: null, stop_loss: null, tp1: null, tp2: null,
            tf: 'DAILY (index)', model: 'technical-daily', source: 'Yahoo Finance public daily data', ts: Date.now()
          };
        }
        const [m1, m5, h1] = await Promise.all([
          dataFeed.fetchCandles(symbol, GRAN['1m'], 120),
          dataFeed.fetchCandles(symbol, GRAN['5m'], 120),
          dataFeed.fetchCandles(symbol, GRAN['1h'], 120)
        ]);
        const det = runDeterministicAnalysis(symbol, { m1, m5, h1 });
        const dec = localDecision(det);
        const price = det.analyses.m1?.currentPrice ?? null;
        const wr = dec.signal === 'WAIT' ? waitReason(det, { maxAgeSec: 3 * 3600 + 300 }) : null;
        return {
          symbol, price, mtf_signal: det.mtfSignal, data_ok: det.ok,
          signal: dec.signal, bias: dec.bias, votes: votesSummary(det.analyses),
          wait_reason: wr ? wr.code : null, wait_detail: wr ? wr.detail : null,
          confidence: dec.confidence,
          entry: dec.entry, stop_loss: dec.stop_loss, tp1: dec.tp1, tp2: dec.tp2,
          tf: 'MTF 1m/5m/1h', model: 'technical', ts: Date.now()
        };
      } catch (e) {
        return { symbol, error: 'FEED_ERROR', detail: String(e.message || e).slice(0, 120) };
      }
    }));
    res.json({ results: out.filter(Boolean), feed: 'deriv-public', ts: Date.now() });
  });


  /* ---- broker-discovered Deriv market catalogue (read-only data) ---- */
  const marketRL = rateLimit({ max: config.backtestRatePerMin, name: 'markets' });
  app.get('/api/markets/deriv', marketRL, async (_req, res) => {
    try {
      if (typeof marketFeed.fetchActiveSymbols !== 'function') return res.status(503).json({ error: 'deriv_catalog_unavailable' });
      const markets = await marketFeed.fetchActiveSymbols();
      res.json({ markets, source: 'Deriv public active_symbols', data_status: 'live_catalogue', ts: Date.now() });
    } catch (e) {
      res.status(502).json({ error: 'deriv_catalog_unavailable', detail: String(e.message || e).slice(0, 120) });
    }
  });
  app.post('/api/markets/deriv/candles', marketRL, async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!/^[A-Za-z0-9_]{2,32}$/.test(code)) return res.status(400).json({ error: 'invalid_market_code' });
    const granularity = parseGranularity(req.body?.granularity);
    if (![60, 300, 3600].includes(granularity)) return res.status(400).json({ error: 'invalid_granularity', allowed: [60, 300, 3600] });
    try {
      if (typeof marketFeed.fetchActiveSymbols !== 'function' || typeof marketFeed.fetchCandlesByCode !== 'function') return res.status(503).json({ error: 'deriv_market_history_unavailable' });
      const markets = await marketFeed.fetchActiveSymbols();
      const market = markets.find((m) => m.code === code);
      if (!market) return res.status(404).json({ error: 'market_not_active_on_deriv' });
      const count = parseIntInRange(req.body?.count, 50, 300, 120);
      const candles = await marketFeed.fetchCandlesByCode(code, granularity, count);
      if (!Array.isArray(candles) || candles.length < 50) return res.status(502).json({ error: 'insufficient_history', got: candles?.length ?? 0 });
      res.json({ code, name: market.name, market: market.market, candles, source: 'Deriv public candles', data_status: 'live', ts: Date.now() });
    } catch (e) {
      res.status(502).json({ error: 'deriv_market_history_unavailable', detail: String(e.message || e).slice(0, 120) });
    }
  });
  app.post('/api/markets/deriv/tick', marketRL, async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!/^[A-Za-z0-9_]{2,32}$/.test(code)) return res.status(400).json({ error: 'invalid_market_code' });
    try {
      if (typeof marketFeed.fetchActiveSymbols !== 'function' || typeof marketFeed.fetchTickByCode !== 'function') return res.status(503).json({ error: 'deriv_market_tick_unavailable' });
      const markets = await marketFeed.fetchActiveSymbols();
      const market = markets.find((m) => m.code === code);
      if (!market) return res.status(404).json({ error: 'market_not_active_on_deriv' });
      const tick = await marketFeed.fetchTickByCode(code);
      res.json({ code, name: market.name, quote: tick.quote, epoch: tick.epoch, source: 'Deriv public tick', data_status: 'live', ts: Date.now() });
    } catch (e) {
      res.status(502).json({ error: 'deriv_market_tick_unavailable', detail: String(e.message || e).slice(0, 120) });
    }
  });

  /* ---- Deriv REAL account (PAT validated per request, never stored) ---- */
  const connectRL = rateLimit({ windowMs: 60000, max: Number(process.env.DERIV_CONNECT_RATE_PER_MIN || 12), name: 'deriv-connect' });
  /* ---- six-role analysis pipeline (master §5): SCOUT→NEWS→CHARTS→STRATEGY→RISK→BOSS.
     Analysis + verdict only — this route NEVER executes anything. ---- */
  app.post('/api/pipeline/analyze', connectRL, async (req, res) => {
    try {
      const symbol = String(req.body?.symbol || '');
      if (!symbol) return res.status(400).json({ error: 'bad_symbol' });
      let candleSets, dataSource = 'Deriv public candles';
      if (req.body?.candleSets != null) {
        if (req.body.dataSource !== 'Exness MT5 local candles') return res.status(400).json({ error: 'invalid_candle_source' });
        try { candleSets = cleanSuppliedCandleSets(req.body.candleSets); dataSource = 'Exness MT5 local candles'; }
        catch (e) { return res.status(400).json({ error: 'invalid_exness_candles', detail: String(e.message || e).slice(0, 160) }); }
      } else {
        const [m1, m5, h1] = await Promise.all([
          dataFeed.fetchCandles(symbol, GRAN['1m'], 120),
          dataFeed.fetchCandles(symbol, GRAN['5m'], 120),
          dataFeed.fetchCandles(symbol, GRAN['1h'], 120),
        ]);
        candleSets = { m1, m5, h1 };
      }
      const det = runDeterministicAnalysis(symbol, candleSets);
      const dec = localDecision(det);
      const pipeline = runPipeline({
        symbol, det, dec,
        newsItems: Array.isArray(req.body?.newsItems) ? req.body.newsItems : null,
        rule: req.body?.rule || {},
        riskInput: Object.assign({ killSwitch: isTradingKilled() }, req.body?.riskInput || {}),
      });
      pipeline.charts.dataSource = dataSource;
      res.json({ ok: true, pipeline, data_source: dataSource });
    } catch (e) {
      res.status(502).json({ error: 'pipeline_failed', detail: String(e.message || e).slice(0, 160) });
    }
  });
  const derivPatOf = (req) => String(req.get('x-deriv-pat') || req.body?.pat || '').trim();
  /* secrets never appear in logs — mask to shape only */
  const maskSecret = (v) => { const t = String(v || ''); return t ? (t.slice(0, 3) + '…(' + t.length + ' chars)') : '(none)'; };
  const derivLog = (event, fields) => log.info('deriv.audit', Object.assign({ event }, fields));
  /* App ID for account calls: per-session header -> body -> server env (never hard-coded). */
  const derivAppOf = (req) => String(req.get('x-deriv-appid') || req.body?.appId || process.env.DERIV_APP_ID || '').trim();

  /* ---- PAT-mode risk gates --------------------------------------
     Deriv's official WS is Cloudflare-walled against datacenter IPs
     (520 from Railway), so account calls execute in the USER'S BROWSER
     (PAT is session-only by design). The server validates, enforces the
     stake / max-open / daily-loss limits BEFORE every order, and books
     reported fills. The env-token proxy mode stays fully server-side. */
  const derivLimits = () => ({
    maxStakeUsd: Number(process.env.DERIV_MAX_STAKE_USD || 50),
    maxOpenTrades: Number(process.env.DERIV_MAX_OPEN_TRADES || 10),
    dailyLossLimitUsd: Number(process.env.DERIV_DAILY_LOSS_LIMIT_USD || 25)
  });
  const patRisk = { opens: new Map(), day: new Map(), reservations: new Map() };
  const ticketCtx = new Map(); // ticketId -> { accountId, derivSymbol, side, amount } (for confirm-side re-quote) // user -> count / {d,pnl}
  const patUser = (req) => userOf(req) || 'local';
  const patDayPnl = (u) => {
    const rec = patRisk.day.get(u);
    const today = new Date().toISOString().slice(0, 10);
    if (!rec || rec.d !== today) return 0;
    return rec.pnl;
  };
  const patBookPnl = (u, pnl) => {
    const today = new Date().toISOString().slice(0, 10);
    const rec = patRisk.day.get(u);
    if (!rec || rec.d !== today) patRisk.day.set(u, { d: today, pnl: Number(pnl) || 0 });
    else rec.pnl += Number(pnl) || 0;
  };

  /* NEW-API PAT sessions: PAT lives in server memory; browser only holds sid */
  const patApi = createPatModule(patDeps);

  app.post('/api/deriv/connect', (req, res) => {
    const pat = derivPatOf(req);
    const appId = derivAppOf(req);
    if (!/^[A-Za-z0-9._~-]{4,200}$/.test(pat)) {
      return res.status(401).json({ error: 'deriv_rejected', detail: 'Enter the API token from home.deriv.com → profile → API Management → API Tokens (Trade scope), or switch to the New API · PAT tab.' });
    }
    if (!/^[A-Za-z0-9._~-]{1,64}$/.test(appId)) {
      return res.status(401).json({ error: 'deriv_rejected', detail: 'Paste the Deriv App ID exactly as shown — it may contain letters (free: api.deriv.com → Register app).' });
    }
    res.json({ ok: true, mode: 'pat_browser', environment: process.env.ENVIRONMENT || 'demo', limits: derivLimits() });
  });

  app.post('/api/deriv/order', connectRL, dedupeBody({ name: 'deriv-order' }), (req, res) => {
    const { amount } = req.body || {};
    const pat = derivPatOf(req);
    if (!pat) return res.status(401).json({ error: 'no_pat', hint: 'Connect your Deriv account first.' });
    /* classic path executes FROM THE BROWSER, so real-money execution must be
       explicitly enabled by the operator (server cannot verify fills itself). */
    const realMode = String(process.env.ENVIRONMENT || 'demo').toLowerCase() === 'real';
    const browserExecAllowed = String(process.env.DERIV_ALLOW_BROWSER_EXEC || 'false').toLowerCase() === 'true';
    if (realMode && !browserExecAllowed) {
      return res.status(403).json({ error: 'classic_exec_disabled', detail: 'Classic (browser-executed) orders are disabled for REAL accounts. Use the PAT tab (server-executed) or set DERIV_ALLOW_BROWSER_EXEC=true on the server.' });
    }
    derivLog('classic_gate', { pat: maskSecret(pat), amount: Number(amount) || 0 });
    const u = patUser(req);
    const L = derivLimits();
    const stake = Number(amount);
    if (!Number.isFinite(stake) || stake <= 0) return res.status(400).json({ error: 'bad_amount' });
    if (stake > L.maxStakeUsd) return res.status(400).json({ error: 'stake_limit', detail: 'Stake $' + stake.toFixed(2) + ' exceeds the server-side limit of $' + L.maxStakeUsd + ' per trade.' });
    const opens = patRisk.opens.get(u) || 0;
    if (opens >= L.maxOpenTrades) return res.status(400).json({ error: 'open_trades_limit', detail: 'Server-side limit: at most ' + L.maxOpenTrades + ' open trades (currently ' + opens + ').' });
    const loss = patDayPnl(u);
    if (loss <= -L.dailyLossLimitUsd) return res.status(400).json({ error: 'daily_loss_limit', detail: 'Daily loss limit of $' + L.dailyLossLimitUsd + ' reached (today: $' + loss.toFixed(2) + '). Trading pauses until tomorrow.' });
    patRisk.opens.set(u, opens + 1);
    res.json({ ok: true, approved: true, limits: L, risk: { opens: opens + 1, dayPnl: loss } });
  });

  /* fill report from the browser-executed trade (books realized P/L) */
  app.post('/api/deriv/fill', (req, res) => {
    const u = patUser(req);
    const { kind, pnl } = req.body || {};
    if (kind === 'close') {
      patRisk.opens.set(u, Math.max(0, (patRisk.opens.get(u) || 1) - 1));
      if (pnl != null && Number.isFinite(Number(pnl))) patBookPnl(u, Number(pnl));
    }
    res.json({ ok: true, dayPnl: patDayPnl(u), opens: patRisk.opens.get(u) || 0 });
  });

  app.post('/api/deriv/close', (req, res) => {
    const pat = derivPatOf(req);
    const contractId = Number(req.body?.contract_id);
    if (!pat) return res.status(401).json({ error: 'no_pat' });
    if (!contractId) return res.status(400).json({ error: 'contract_id_required' });
    res.json({ ok: true, approved: true, contract_id: contractId });
  });

  /* ---- NEW-API PAT routes (server-executed, limits-gated) ---- */
  app.post('/api/deriv/pat/session', connectRL, async (req, res) => {
    const pat = derivPatOf(req);
    const appId = derivAppOf(req);
    if (!/^[A-Za-z0-9._~-]{4,200}$/.test(pat) || /\s/.test(pat)) {
      return res.status(401).json({ error: 'deriv_rejected', detail: 'Enter the PAT you generated in your Deriv dashboard (no spaces).' });
    }
    /* Per Deriv: the App ID is copied EXACTLY from the registered application —
       it is NOT documented as digits-only, so accept alphanumeric ids verbatim. */
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(appId) || /\s/.test(appId)) {
      return res.status(401).json({ error: 'deriv_rejected', detail: 'Your Deriv-App-ID is required — copy it EXACTLY from your Deriv application (it may contain letters).' });
    }
    try {
      derivLog('session_attempt', { app_id: maskSecret(appId), pat: maskSecret(pat) });
      const sess = await patApi.createSession(pat, appId);
      const u = patUser(req);
      derivLog('session_ok', { app_id: maskSecret(appId), accounts: sess.accounts.length, primary: String(sess.primary.account_id).slice(0, 3) + '…' });
      res.json({ ok: true, sid: sess.sid, accounts: sess.accounts, primary: sess.primary, environment: sess.environment, limits: derivLimits(), user: u });
    } catch (e) {
      derivLog('session_fail', { app_id: maskSecret(appId), code: e.code || 'unknown' });
      res.status(e.code === 'bad_pat' ? 401 : 502).json({ error: 'pat_session_failed', detail: String(e.message || e) });
    }
  });

  /* ---- admin diagnostics (audit Task 1.6): masked, key-gated ---- */
  app.post('/api/deriv/diagnose', connectRL, async (req, res) => {
    const key = String(req.get('x-diag-key') || '');
    const expected = String(process.env.AURUM_DIAG_KEY || '');
    if (!expected || !key || key.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
      return res.status(403).json({ error: 'diag_disabled_or_forbidden', hint: 'Set AURUM_DIAG_KEY on the server and send it as the x-diag-key header.' });
    }
    const pat = derivPatOf(req);
    const appId = derivAppOf(req);
    const out = { ts: new Date().toISOString(), pat: maskSecret(pat), app_id: maskSecret(appId), checks: {} };
    /* 1) REST accounts probe (same request the connect flow makes) */
    try {
      const sess = await patApi.createSession(pat, appId);
      out.checks.rest_accounts = { ok: true, accounts: sess.accounts.map((a) => ({ account_id: String(a.account_id).slice(0, 3) + '…', account_type: a.account_type, balance: a.balance, currency: a.currency, status: a.status })) };
      patApi.drop(sess.sid); /* probe session discarded immediately */
    } catch (e) {
      out.checks.rest_accounts = { ok: false, code: e.code || 'rest_error', detail: String(e.message || e).slice(0, 300) };
    }
    /* 2) public WS reachability (feed) — no auth */
    out.checks.public_ws = await new Promise((resolve) => {
      try {
        const ws = new WebSocket(process.env.DERIV_PUBLIC_URL_OVERRIDE || 'wss://api.derivws.com/trading/v1/options/ws/public');
        const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ ok: false, detail: 'timeout' }); }, 6000);
        ws.on('open', () => { ws.send(JSON.stringify({ ping: 1 })); });
        ws.on('message', () => { clearTimeout(t); try { ws.close(); } catch (e) {} resolve({ ok: true }); });
        ws.on('error', (e) => { clearTimeout(t); resolve({ ok: false, detail: String(e.message || e).slice(0, 120) }); });
      } catch (e) { resolve({ ok: false, detail: String(e.message || e).slice(0, 120) }); }
    });
    /* 3) scope hints per Deriv docs */
    if (out.checks.rest_accounts && out.checks.rest_accounts.ok === false && /403|scope/i.test(out.checks.rest_accounts.detail || '')) {
      out.checks.scope_hint = 'Deriv signalled a scope problem — the PAT must include the Trade scope (and Read where offered) for accounts + OTP.';
    }
    res.json(out);
  });

  /* ---- generic server-side risk gate (audit Task 5): used by Exness bridge path ---- */
  app.post('/api/risk/gate', connectRL, (req, res) => {
    const u = patUser(req);
    const L = derivLimits();
    const stake = Number(req.body?.amount);
    if (!Number.isFinite(stake) || stake <= 0) return res.status(400).json({ error: 'bad_amount' });
    if (stake > L.maxStakeUsd) return res.status(400).json({ error: 'stake_limit', detail: 'Stake $' + stake.toFixed(2) + ' exceeds the server-side limit of $' + L.maxStakeUsd + ' per trade.' });
    const once = String(req.body?.once || '').trim().slice(0, 128);
    const reservationKey = once ? (u + ':' + once) : null;
    if (reservationKey && patRisk.reservations.has(reservationKey)) {
      return res.status(409).json({ error: 'duplicate_order', detail: 'This order intent was already reserved; use a fresh idempotency key for a new intent.' });
    }
    const report = evaluateRisk({
      limits: L,
      stake,
      opens: patRisk.opens.get(u) || 0,
      dayPnl: patDayPnl(u),
      killSwitch: isTradingKilled(),
      venue: String(req.body?.venue || 'mt5'),
      rr: req.body?.rr,
      entry: req.body?.entry,
      sl: req.body?.sl,
      tp: req.body?.tp,
      marketHours: req.body?.marketHours,
      newsBlocked: req.body?.newsBlocked,
    });
    const boss = bossVerdict({ risk: report, setup: req.body?.setup || { present: false } });
    derivLog('risk_gate', { user: u, amount: stake, verdict: report.verdict });
    if (!report.approved) {
      return res.status(400).json({ error: 'risk_blocked', detail: report.reason, checks: report.checks, verdict: report.verdict, boss, killSwitch: isTradingKilled() });
    }
    patRisk.opens.set(u, (patRisk.opens.get(u) || 0) + 1);
    if (reservationKey) {
      patRisk.reservations.set(reservationKey, { user: u, once, status: 'pending', at: Date.now() });
      if (patRisk.reservations.size > 10000) {
        for (const [k, v] of patRisk.reservations) {
          if (v.status === 'released' || v.status === 'closed') patRisk.reservations.delete(k);
          if (patRisk.reservations.size <= 8000) break;
        }
      }
    }
    res.json({
      ok: true, approved: true, limits: L, reservation: once || null,
      risk: { opens: patRisk.opens.get(u) || 0, dayPnl: patDayPnl(u) },
      checks: report.checks, verdict: report.verdict, reason: report.reason, boss,
      killSwitch: isTradingKilled(),
    });
  });

  /* kill switch control (§16): disabling trading is always allowed;
     RE-ENABLING requires the AURUM_DIAG_KEY when one is configured. */
  app.get('/api/ctl/killswitch', connectRL, (_req, res) => {
    res.json({ ok: true, enabled: isTradingKilled() });
  });
  app.post('/api/ctl/killswitch', connectRL, (req, res) => {
    const on = req.body?.on === true || req.body?.on === 'true' || req.body?.on === 1;
    const r = setTradingKilled(on, req.headers['x-aurum-diag'] || req.body?.diag);
    derivLog('killswitch', { on, ok: r.ok });
    if (!r.ok) return res.status(403).json({ error: 'diag_key_required', detail: r.detail, enabled: r.enabled });
    res.json({ ok: true, enabled: r.enabled });
  });

  app.post('/api/risk/fill', (req, res) => {
    const u = patUser(req);
    const { kind, pnl } = req.body || {};
    const once = String(req.body?.once || '').trim().slice(0, 128);
    const key = once ? (u + ':' + once) : null;
    const reservation = key ? patRisk.reservations.get(key) : null;
    if (kind === 'release') {
      if (!reservation || reservation.status !== 'pending') {
        return res.status(409).json({ error: 'reservation_not_pending', detail: 'No releasable pending order reservation matches this intent.' });
      }
      reservation.status = 'released';
      patRisk.opens.set(u, Math.max(0, (patRisk.opens.get(u) || 0) - 1));
    } else if (kind === 'open' && reservation && reservation.status === 'pending') {
      reservation.status = 'committed';
      reservation.at = Date.now();
    } else if (kind === 'close') {
      if (!reservation || reservation.status !== 'committed') {
        return res.status(409).json({ error: 'reservation_not_committed', detail: 'No committed Exness order reservation matches this close.' });
      }
      reservation.status = 'closed';
      patRisk.opens.set(u, Math.max(0, (patRisk.opens.get(u) || 0) - 1));
      if (pnl != null && Number.isFinite(Number(pnl))) patBookPnl(u, Number(pnl));
    }
    res.json({ ok: true, dayPnl: patDayPnl(u), opens: patRisk.opens.get(u) || 0 });
  });

  app.post('/api/deriv/pat/proposal', async (req, res) => {
    const { sid, accountId, symbol, amount, side, duration, duration_unit } = req.body || {};
    if (!patApi.has(String(sid || ''))) return res.status(401).json({ error: 'no_session', detail: 'Reconnect your Deriv PAT session.' });
    const u = patUser(req);
    const L = derivLimits();
    const stake = Number(amount);
    if (!Number.isFinite(stake) || stake <= 0) return res.status(400).json({ error: 'bad_amount' });
    if (stake > L.maxStakeUsd) return res.status(400).json({ error: 'stake_limit', detail: 'Stake $' + stake.toFixed(2) + ' exceeds the server-side limit of $' + L.maxStakeUsd + ' per trade.' });
    const opens = patRisk.opens.get(u) || 0;
    if (opens >= L.maxOpenTrades) return res.status(400).json({ error: 'open_trades_limit', detail: 'Server-side limit: at most ' + L.maxOpenTrades + ' open trades.' });
    if (patDayPnl(u) <= -L.dailyLossLimitUsd) return res.status(400).json({ error: 'daily_loss_limit', detail: 'Daily loss limit of $' + L.dailyLossLimitUsd + ' reached.' });
    const code = (DERIV_SYMBOLS || {})[String(symbol || '')];
    if (!code) {
      const supported = Object.keys(DERIV_SYMBOLS || {}).sort().join(', ');
      return res.status(400).json({ error: 'unsupported_symbol', detail: 'No Deriv contract is mapped for "' + String(symbol || '') + '". Supported symbols: ' + supported + '.' });
    }
    try {
      const quote = await patApi.quote(String(sid), { accountId: String(accountId || ''), derivSymbol: code, side, amount: stake, duration: Number(duration) || 5, duration_unit: duration_unit || 'm' });
      const tid = crypto.randomUUID();
      patApi.stashTicket(tid, String(sid), quote);
      /* context so confirm can re-quote on a fresh connection — proposal ids
         are PER-CONNECTION (official docs), so a recycled socket invalidates them */
      ticketCtx.set(tid, { accountId: String(accountId || ''), derivSymbol: code, side, amount: stake });
      res.json({ ok: true, ticket: { id: tid, symbol, side, amount: stake, duration: quote.duration, duration_unit: quote.duration_unit }, quote: { payout: quote.payout, stake, currency: quote.currency, duration: quote.duration, duration_unit: quote.duration_unit, clamped: !!quote.clamped, requested: quote.requested, lineup_note: quote.lineup_note, ranges: quote.ranges } });
    } catch (e) {
      let detail = String(e.message || e);
      if (/duration/i.test(detail)) detail += ' — pick another duration in the trade ticket (Deriv offers different ranges per symbol; forex usually starts at 15 minutes).';
      res.status(502).json({ error: 'pat_quote_failed', detail });
    }
  });

  /* fresh balances for the account switcher (PAT held server-side; browser has only the sid) */
  app.post('/api/deriv/pat/refresh', connectRL, async (req, res) => {
    const sid = String((req.body || {}).sid || '');
    if (!patApi.has(sid)) return res.status(401).json({ error: 'no_session', detail: 'Reconnect your Deriv PAT session.' });
    try {
      res.json({ ok: true, accounts: await patApi.listAccounts(sid) });
    } catch (e) {
      res.status(502).json({ error: 'pat_refresh_failed', detail: String(e.message || e) });
    }
  });

  app.post('/api/deriv/pat/confirm', async (req, res) => {
    const ticketId = String(req.body?.ticket?.id || '');
    const t = patApi.takeTicketAny(ticketId);
    const ctx = ticketCtx.get(ticketId); ticketCtx.delete(ticketId); /* single-use */
    if (!t || !ctx) return res.status(400).json({ error: 'ticket_stale', detail: 'Quote expired — place the order again (the ticket only decides symbol/side/stake/duration; the buy always uses a brand-new quote).' });
    try {
      /* ALWAYS a fresh proposal right before the buy — only that id is used.
         The stashed quote's id is never sent, so recycled-id failures cannot happen. */
      const { order, requoted, freshQuote } = await patApi.confirmSmartFresh(t.sid, { duration: t.quote.duration, duration_unit: t.quote.duration_unit }, ctx);
      const u = patUser(req);
      patRisk.opens.set(u, (patRisk.opens.get(u) || 0) + 1);
      derivLog('confirm_fresh_quote', { ticket: '…' + ticketId.slice(-6), payout: freshQuote.payout, duration: freshQuote.duration + freshQuote.duration_unit });
      res.json({ ok: true, order, requoted: true, fresh: { payout: freshQuote.payout, duration: freshQuote.duration, duration_unit: freshQuote.duration_unit } });
    } catch (e) {
      res.status(502).json({ error: 'pat_buy_failed', detail: String(e.message || e) });
    }
  });

  /* settlement tracking for open Deriv binary contracts (docs-verified shape) */
  app.post('/api/deriv/pat/contract_status', async (req, res) => {
    const sid = String((req.body || {}).sid || '');
    const contractId = Number((req.body || {}).contract_id);
    const accountId = String((req.body || {}).accountId || '');
    if (!patApi.has(sid)) return res.status(401).json({ error: 'no_session', detail: 'Reconnect your Deriv PAT session.' });
    if (!contractId) return res.status(400).json({ error: 'contract_id_required' });
    try {
      res.json({ ok: true, contract: await patApi.contractStatus(sid, accountId, contractId) });
    } catch (e) {
      res.status(502).json({ error: 'contract_status_failed', detail: String(e.message || e) });
    }
  });

  app.post('/api/deriv/pat/portfolio', async (req, res) => {
    const sid = String((req.body || {}).sid || '');
    const accountId = String((req.body || {}).accountId || '');
    if (!patApi.has(sid)) return res.status(401).json({ error: 'no_session', detail: 'Reconnect your Deriv PAT session.' });
    try {
      res.json({ ok: true, contracts: await patApi.portfolio(sid, accountId) });
    } catch (e) {
      res.status(502).json({ error: 'portfolio_failed', detail: String(e.message || e) });
    }
  });

  app.post('/api/deriv/pat/close', async (req, res) => {
    const sid = String(req.body?.sid || '');
    const contractId = Number(req.body?.contract_id);
    if (!patApi.has(sid)) return res.status(401).json({ error: 'no_session' });
    if (!contractId) return res.status(400).json({ error: 'contract_id_required' });
    const lastSell = Number((patRisk.sellAt && patRisk.sellAt.get(sid)) || 0);
    if (Date.now() - lastSell < 1200) {
      return res.status(429).json({ error: 'sell_throttled', detail: 'Sells are limited to one per moment - this contract will settle at expiry regardless and the result books automatically.' });
    }
    if (!patRisk.sellAt) patRisk.sellAt = new Map();
    patRisk.sellAt.set(sid, Date.now());
    try {
      const result = await patApi.close(sid, contractId);
      const u = patUser(req);
      patRisk.opens.set(u, Math.max(0, (patRisk.opens.get(u) || 1) - 1));
      if (Number.isFinite(result.price)) patBookPnl(u, result.price - Number(req.body?.stake || 0));
      res.json({ ok: true, result: { contract_id: contractId, sold_for: result.price } });
    } catch (e) {
      res.status(502).json({ error: 'pat_close_failed', detail: String(e.message || e) });
    }
  });

  app.post('/api/deriv/status', async (req, res) => {
    const pat = derivPatOf(req);
    const contractId = Number(req.body?.contract_id);
    if (!pat || !contractId) return res.status(400).json({ error: 'pat_and_contract_id_required' });
    try {
      res.json({ ok: true, contract: await derivContractStatus(pat, derivAppOf(req), contractId) });
    } catch (e) {
      res.status(400).json({ error: 'deriv_status_failed', detail: String(e.message || e) });
    }
  });

  /* ---- news + expected outcomes (Perplexity) ---- */
  app.post('/api/news/expectations', async (req, res) => {
    const symbol = String(req.body?.symbol || '').toUpperCase().trim();
    if (!SYM_RE.test(symbol)) return res.status(400).json({ error: 'invalid symbol' });
    const user = userOf(req);
    const k = aiKeysOf(req);
    const keys = {
      engine: String(req.body?.engine || 'auto'),
      perplexity: k.perplexity || config.perplexityKey || '',
      claude: k.claude || config.claudeKey || '',
      openai: k.openai || config.openaiKey || '',
      perplexityModel: config.perplexityModel,
      claudeModel: config.defaultModel,
      openaiModel: 'gpt-4o-mini'
    };
    if (!keys.perplexity && !keys.claude && !keys.openai) {
      return res.status(400).json({ error: 'no_ai_key', hint: 'Add ANY of: Perplexity, Claude (Anthropic) or ChatGPT (OpenAI) key in Settings.' });
    }
    try {
      const brief = await newsBriefAny(symbol, keys, config.timeoutMs);
      store.recordUsage({ user: 'local', session: user, model: brief.model, tokens_in: brief.tokens_in, tokens_out: brief.tokens_out, cost: (brief.tokens_in + brief.tokens_out) / 1e6, endpoint: '/api/news/expectations', engine: brief.engine });
      res.json({ symbol, ts: Date.now(), brief: brief.text, engine: brief.engine, model: brief.model });
    } catch (e) {
      const friendly = e && e.friendly ? e.message : String(e.message || e).slice(0, 160);
      res.status(502).json({ error: 'brief_unavailable', detail: friendly });
    }
  });

  /* ---- historical candles for the educational analytics (verified live feed,
         server-fetched, cached 60s; feeds the Learn/Calculator lab) ---- */
  const histCache = new Map(); /* sym|g|count -> {at, payload} */
  app.post('/api/history/candles', rateLimit({ max: config.backtestRatePerMin, name: 'history' }), async (req, res) => {
    try {
      const wanted = String(req.body.sym || '').toUpperCase();
      const known = Object.keys(dataFeed.symbols || {}).find((d) => String(d).toUpperCase() === wanted);
      if (!known) return res.status(400).json({ error: 'unknown_symbol' });
      const granularity = parseGranularity(req.body.granularity);
      if (!granularity) return res.status(400).json({ error: 'bad_granularity', allowed: GRANULARITIES });
      const count = parseIntInRange(req.body.count, 50, 2000, 400);
      const key = known + '|' + granularity + '|' + count;
      const hit = histCache.get(key);
      if (hit && Date.now() - hit.at < 60000) return res.json(hit.payload);
      const raw = await dataFeed.fetchCandles(known, granularity, count);
      /* validate the provider response before it can be displayed (brief Phase 3.3) */
      const candles = (Array.isArray(raw) ? raw : [])
        .map((c) => ({ time: Number(c && c.time), open: Number(c && c.open), high: Number(c && c.high), low: Number(c && c.low), close: Number(c && c.close), volume: Number(c && c.volume) || 0 }))
        .filter((c) => Number.isFinite(c.time) && c.time > 0 && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0));
      if (candles.length < 30) return res.status(502).json({ error: 'insufficient_history', got: candles.length });
      const payload = { source: 'deriv-public', instrument: known, granularity, count: candles.length, fetched_at: new Date().toISOString(), candles };
      histCache.set(key, { at: Date.now(), payload });
      if (histCache.size > 40) histCache.delete(histCache.keys().next().value);
      res.json(payload);
    } catch (e) {
      res.status(502).json({ error: 'feed_unavailable', detail: 'The live data provider did not return history for this request. Try again shortly.' });
    }
  });

  /* ---- market-moving headlines (public RSS, keyless) + conservative
         keyword-tone bias, ALWAYS labelled 'heuristic' (not AI, not advice) ---- */
  let newsCache = { at: 0, payload: null };
  app.get('/api/news/feed', async (req, res) => {
    if (newsCache.payload && Date.now() - newsCache.at < 300000) return res.json(newsCache.payload);
    const items = [];
    for (const src of RSS_SOURCES) {
      if (items.length >= 12) break;
      try {
        const r = await fetch(src.url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; aurum-news)' } });
        if (!r.ok) continue;
        for (const it of parseRss(await r.text())) {
          if (items.length >= 12) break;
          items.push({ title: it.title, link: it.link, source: src.name, published: it.published, t: it.t != null ? it.t : null, bias: biasFor(it.title) });
        }
      } catch (e) { /* try next source */ }
    }
    if (!items.length) return res.status(502).json({ error: 'news_unavailable', detail: 'No headline source reachable right now. The TradingView timeline in the News view is independent and may still work.' });
    const payload = { ts: new Date().toISOString(), engine: 'heuristic', note: 'Direction chips are a keyword heuristic — not AI, not advice. Add an AI key in Settings for real AI calls.', items, fetched_at: Date.now() };
    newsCache = { at: Date.now(), payload };
    res.json(payload);
  });

  /* ---- economic calendar, today UTC (TradingEconomics documented guest access;
         may be rate-limited — honest 502 and the TV widget stays as fallback) ---- */
  let calCache = { at: 0, payload: null };
  app.get('/api/news/calendar', async (req, res) => {
    if (calCache.payload && Date.now() - calCache.at < 600000) return res.json(calCache.payload);
    try {
      const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; aurum-calendar)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const rows = parseFfCalendar(await r.json(), new Date());
      const payload = { ts: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), source: 'ForexFactory public weekly calendar', events: rows };
      calCache = { at: Date.now(), payload };
      res.json(payload);
    } catch (e) {
      res.status(502).json({ error: 'calendar_unavailable', detail: 'Calendar feed unreachable. The TradingView calendar below is independent and may still work.' });
    }
  });

  /* ---- WhatsApp Cloud API: status + push (env: WA_PHONE_NUMBER_ID, WA_TOKEN, WA_TO,
          WA_AUTO_SHARE=true for the server-side auto feed; token NEVER logged) ---- */
  app.get('/api/wa/status', (req, res) => res.json(waStatus()));
  app.post('/api/wa/push', rateLimit({ windowMs: 60000, max: 12, name: 'wa-push' }), async (req, res) => {
    const text = String(req.body?.text || '').slice(0, 1200);
    if (!text.trim()) return res.status(400).json({ error: 'text_required' });
    const st = waStatus();
    if (!st.configured) return res.status(503).json({ error: 'wa_not_configured', hint: st.hint });
    if (!waRateOk()) return res.status(429).json({ error: 'wa_throttled', detail: 'Too many WhatsApp messages in a minute - throttled.' });
    try {
      const r = await waSend(text);
      res.json({ ok: true, id: r && r.messages && r.messages[0] && r.messages[0].id ? 'sent' : 'sent' });
    } catch (e) {
      res.status(502).json({ error: 'wa_send_failed', detail: String(e.message || e).slice(0, 160) });
    }
  });

  app.get('/api/signals/history', (req, res) => {
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const rows = store.listSignals({ user: userOf(req), limit });
    res.json({
      signals: rows.map((r) => ({
        created_at: r.created_at, symbol: r.symbol, signal: r.signal,
        confidence: r.confidence, entry: r.entry, model: r.model
      }))
    });
  });

  app.get('/api/signals/usage', (req, res) => {
    /* device-wide budget view — the cap never resets between sessions */
    const stats = store.statsToday('local');
    res.json(Object.assign({}, stats, { cap: config.dailyBudgetUsd }));
  });

  app.locals.derivConn = derivConn;
  return app;
}
