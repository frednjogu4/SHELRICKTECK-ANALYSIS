import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';

const nowSec = () => Math.floor(Date.now() / 1000);
function candles(count = 120, granularity = 60) {
  const out = [];
  const end = nowSec();
  for (let i = 0; i < count; i++) {
    const close = 1.08 + i * 0.00003;
    out.push({ epoch: end - (count - i - 1) * granularity, open: close - 0.00001, high: close + 0.00008, low: close - 0.00008, close });
  }
  return out;
}
function derivMock(payload) {
  if (payload.active_symbols) return { active_symbols: [{ underlying_symbol: 'frxEURUSD', underlying_symbol_name: 'EUR/USD', market: 'forex', exchange_is_open: 1 }] };
  if (payload.ticks_history) return { candles: candles(payload.count, payload.granularity) };
  if (payload.ticks) return { tick: { quote: 1.09, epoch: nowSec() } };
  throw new Error('unexpected Deriv public request');
}
function yahooFixture() {
  const timestamp = [], open = [], high = [], low = [], close = [];
  const now = nowSec();
  for (let i = 0; i < 80; i++) {
    const c = 4000 + i * 2;
    timestamp.push(now - (79 - i) * 86400);
    open.push(c - 1); high.push(c + 3); low.push(c - 2); close.push(c);
  }
  return { chart: { result: [{ timestamp, indicators: { quote: [{ open, high, low, close, volume: close.map(() => 1000) }] } }] } };
}
function worker(options = {}) {
  return createReadOnlyWorker({ requestImpl: derivMock, fetchImpl: async () => Response.json(yahooFixture()), ...options });
}

async function call(w, path, { method = 'GET', body, headers = {}, env = {} } = {}) {
  const request = new Request('https://aurum-staging.example' + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const allow = { limit: async () => ({ success: true }) };
  return w.fetch(request, { ASSETS: { fetch: async () => new Response('app shell') }, AURUM_SIGNAL_LIMITER: allow, AURUM_MARKET_LIMITER: allow, ...env });
}

test('Cloudflare health advertises technical-only read-only mode and disabled execution', async () => {
  const res = await call(worker(), '/api/health');
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.runtime, 'cloudflare-readonly');
  assert.equal(data.execution, false);
  assert.equal(data.exness, 'PC-local only; no Exness data is sent to Cloudflare');
  assert.deepEqual(data.data_sources, ['Deriv public candles', 'Yahoo Finance public daily data']);
});

test('Cloudflare scan returns deterministic Deriv-labelled MTF signal data', async () => {
  const res = await call(worker(), '/api/signals/scan', { method: 'POST', body: { symbols: ['EUR/USD'] } });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.analysis_only, true);
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].symbol, 'EUR/USD');
  assert.equal(data.results[0].data_source, 'Deriv public candles');
  assert.equal(data.results[0].tf, 'MTF 1m/5m/1h');
  assert.ok(['BUY', 'SELL', 'WAIT'].includes(data.results[0].signal));
});

test('Cloudflare index scan uses Yahoo daily data and does not invent order levels', async () => {
  const res = await call(worker(), '/api/signals/scan', { method: 'POST', body: { symbols: ['US30'] } });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.results[0].data_source, 'Yahoo Finance public daily data');
  assert.equal(data.results[0].tf, 'DAILY (index)');
  assert.equal(data.results[0].entry, null);
  assert.equal(data.results[0].stop_loss, null);
  assert.equal(data.results[0].tp1, null);
});

test('Cloudflare analyze works as technical-only and labels the public source', async () => {
  const res = await call(worker(), '/api/signals/analyze', { method: 'POST', body: { symbol: 'EUR/USD', withNews: true } });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.data_source, 'Deriv public candles');
  assert.equal(data.meta.mode, 'technical');
  assert.equal(data.news.available, false);
  assert.equal(data.model, 'technical');
});

test('Cloudflare rejects Exness candle uploads and never calls the public provider for them', async () => {
  let calls = 0;
  const w = createReadOnlyWorker({ requestImpl: async () => { calls++; return derivMock({}); } });
  const res = await call(w, '/api/signals/analyze', {
    method: 'POST', body: { symbol: 'EUR/USD', dataSource: 'Exness MT5 local candles', candleSets: { m1: [] } }
  });
  const data = await res.json();
  assert.equal(res.status, 403);
  assert.equal(data.error, 'exness_local_only');
  assert.equal(calls, 0);
});

test('Cloudflare broker and execution endpoints stay disabled', async () => {
  const res = await call(worker(), '/api/deriv/pat/session', { method: 'POST', body: { sid: 'not-a-real-session' } });
  const data = await res.json();
  assert.equal(res.status, 403);
  assert.equal(data.error, 'broker_execution_routes_disabled');
});

test('Cloudflare signal endpoints enforce the configured rate limiter and fail closed if absent', async () => {
  const limited = await call(worker(), '/api/signals/scan', {
    method: 'POST', body: { symbols: ['EUR/USD'] },
    env: { AURUM_SIGNAL_LIMITER: { limit: async () => ({ success: false }) } }
  });
  assert.equal(limited.status, 429);

  const missing = await call(worker(), '/api/signals/scan', {
    method: 'POST', body: { symbols: ['EUR/USD'] }, env: { AURUM_SIGNAL_LIMITER: null }
  });
  assert.equal(missing.status, 503);
});

test('Cloudflare API rejects cross-origin browser requests', async () => {
  const res = await call(worker(), '/api/health', { headers: { origin: 'https://other.example' } });
  assert.equal(res.status, 403);
});

test('Cloudflare Worker delegates non-API app assets to the ASSETS binding', async () => {
  const res = await call(worker(), '/');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'app shell');
});

test('Cloudflare market catalogue and candle endpoints preserve provider labels', async () => {
  const w = worker();
  const catalog = await call(w, '/api/markets/deriv');
  const catalogData = await catalog.json();
  assert.equal(catalogData.source, 'Deriv public active_symbols');
  assert.equal(catalogData.markets[0].code, 'frxEURUSD');

  const candlesRes = await call(w, '/api/markets/deriv/candles', {
    method: 'POST', body: { code: 'frxEURUSD', granularity: 60, count: 120 }
  });
  const candlesData = await candlesRes.json();
  assert.equal(candlesRes.status, 200);
  assert.equal(candlesData.source, 'Deriv public candles');
  assert.ok(candlesData.candles.length >= 50);
});

test('Cloudflare-hosted Exness analysis is computed in-browser without posting the local candle bundle', () => {
  const source = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const match = source.match(/if\(await isCloudflareHostedApp\(\)\)\{([\s\S]*?)\}else\{/);
  assert.ok(match, 'Cloudflare-hosted branch should exist in Exness analysis');
  assert.match(match[1], /analyzed in this browser/);
  assert.doesNotMatch(match[1], /api\(/, 'the Cloudflare branch must not send local candles to an API');

  const start = source.indexOf('async function loadPipelineFlow()');
  const next = source.indexOf('\nasync function ', start + 1);
  const pipeline = source.slice(start, next > start ? next : undefined);
  assert.ok(pipeline.indexOf('if(await isCloudflareHostedApp())') >= 0);
  assert.ok(pipeline.indexOf('if(await isCloudflareHostedApp())') < pipeline.indexOf('body.candleSets'), 'pipeline must exit before attaching Exness candles');
});
