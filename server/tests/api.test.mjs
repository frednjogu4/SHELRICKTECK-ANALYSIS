import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore, todayKey } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';

/* ================================================================
 * API tests run against a STUB feed injected via createApp({feed}).
 * No network: the real Deriv feed is exercised manually / by probes.
 * ================================================================ */

process.env.ANTHROPIC_API_KEY = '';
process.env.DAILY_BUDGET_USD = '5';

/* deterministic stub candles — clean uptrend so MTF confirms; never random */
function stubCandles(sym, granularity, count = 120) {
  const base = { 'EUR/USD': 1.1, 'GBP/USD': 1.3, 'BTC/USD': 80000, 'XAU/USD': 4000 }[sym] || 100;
  const out = [];
  let p = base;
  for (let i = 0; i < count; i++) {
    p = p * (1 + 0.0006 + Math.sin(i / 9) * 0.0004);
    out.push({ time: 1700000000 + i * granularity, open: p * 0.999, high: p * 1.002, low: p * 0.998, close: p, volume: 10 });
  }
  return out;
}
const stubFeed = {
  symbols: { 'EUR/USD': 'frxEURUSD', 'GBP/USD': 'frxGBPUSD', 'BTC/USD': 'cryBTCUSD', 'XAU/USD': 'frxXAUUSD', 'ETH/USD': 'cryETHUSD' },
  fetchCandles: async (sym, g, n) => {
    if (sym === 'FAIL/ME') throw new Error('stub: no data');
    return stubCandles(sym, g, n);
  }
};
const deadFeed = { symbols: {}, fetchCandles: async () => { throw new Error('feed down'); } };

let server;
let base;
let tmpDir;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aurum-api-'));
  const store = createStore(join(tmpDir, 'store.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '', DAILY_BUDGET_USD: '5' }), { apiKey: '' });
  const app = createApp({ store, config, feed: stubFeed });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server && server.close();
  tmpDir && rmSync(tmpDir, { recursive: true, force: true });
});

const get = (p, headers = {}) => fetch(base + p, { headers });
const post = (p, body, headers = {}) =>
  fetch(base + p, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify(body)
  });

test('health reports keyless technical mode on the deriv feed', async () => {
  const r = await (await get('/api/health')).json();
  assert.equal(r.ok, true);
  assert.ok(r.build, 'boot/build id present (stale-tab detection)');
  assert.notEqual(r.build, (await (await get('/api/health')).json()).build === undefined ? null : undefined);
  assert.deepEqual(r.engines, { claude: false, chatgpt: false, perplexity: false });
  assert.equal(r.live_feed, 'deriv-public');
  assert.equal(r.symbols, 5);
  assert.equal(r.budget.cap, 5);
  assert.deepEqual(r.available_now, []);
});

test('analyze returns the full decision contract (technical, no keys, live stub candles)', async () => {
  const r = await post('/api/signals/analyze', { symbol: 'EUR/USD' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(['BUY', 'SELL', 'WAIT'].includes(d.signal), d.signal);
  assert.ok(d.confidence >= 0 && d.confidence <= 100, 'confidence range');
  assert.ok(d.entry > 0 && d.stop_loss > 0 && d.tp1 > 0 && d.tp2 > 0, 'prices positive');
  assert.equal(typeof d.rrr, 'number');
  assert.ok(d.rrr > 0, 'rrr recomputed');
  assert.ok(d.rationale.length > 10);
  assert.ok(Array.isArray(d.risks) && d.risks.length >= 3);
  assert.ok(d.key_levels.support.length > 0 && d.key_levels.resistance.length > 0);
  assert.equal(d.timeframe, 'MTF');
  assert.equal(d.data_ok, true);
  assert.ok(['BUY_CONFIRMED', 'SELL_CONFIRMED', 'NO_CONFIRMATION'].includes(d.mtf_signal));
  /* honest labels: technical, never fake AI */
  assert.equal(d.meta.mode, 'technical');
  assert.equal(d.meta.reason, 'no_keys');
  assert.equal(d.model, 'technical');
  assert.equal(d.news.available, false);
  assert.equal(d.news.reason, 'no_perplexity_key');
});

test('technicalOnly analysis returns deterministic Gold levels without AI calls or signal-history writes', async () => {
  const before = await (await get('/api/signals/history', { 'x-aurum-user': 'gold-tech' })).json();
  const r = await post('/api/signals/analyze', { symbol: 'XAU/USD', force: true, withNews: true, technicalOnly: true }, {
    'x-aurum-user': 'gold-tech', 'x-ai-claude': 'test-key-must-not-be-used'
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.symbol, 'XAU/USD');
  assert.equal(d.model, 'technical');
  assert.equal(d.meta.reason, 'technical_only');
  assert.equal(d.data_source, 'Deriv public candles');
  assert.ok(d.latest_candle_time > 0);
  assert.equal(d.news.available, false);
  assert.ok(['BUY', 'SELL', 'WAIT'].includes(d.signal));
  assert.ok(d.entry > 0 && d.stop_loss > 0 && d.tp1 > 0 && d.tp2 > 0);
  const after = await (await get('/api/signals/history', { 'x-aurum-user': 'gold-tech' })).json();
  assert.equal(after.signals.length, before.signals.length);
  const denied = await post('/api/signals/analyze', { symbol: 'EUR/USD', technicalOnly: true });
  assert.equal(denied.status, 400);
});

function freshExnessSets(symbol='XAU/USD'){
  const now=Math.floor(Date.now()/1000);
  const make=(granularity)=>stubCandles(symbol,granularity,120).map((c,i)=>Object.assign({},c,{time:now-granularity*(120-i)}));
  return {m1:make(60),m5:make(300),h1:make(3600)};
}

test('AI analysis accepts validated read-only Exness candles and labels the actual source', async () => {
  const r=await post('/api/signals/analyze',{symbol:'XAU/USD',force:true,technicalOnly:true,candleSets:freshExnessSets(),dataSource:'Exness MT5 local candles'});
  assert.equal(r.status,200);
  const d=await r.json();
  assert.equal(d.data_source,'Exness MT5 local candles');
  assert.equal(d.symbol,'XAU/USD');
  assert.ok(d.latest_candle_time>0);
  const bad=await post('/api/signals/analyze',{symbol:'XAU/USD',force:true,technicalOnly:true,candleSets:freshExnessSets(),dataSource:'Deriv public candles'});
  assert.equal(bad.status,400);
  assert.equal((await bad.json()).error,'invalid_candle_source');
});

test('pipeline runs on Exness candles supplied by the read-only local bridge', async()=>{
  const r=await post('/api/pipeline/analyze',{symbol:'XAU/USD',candleSets:freshExnessSets(),dataSource:'Exness MT5 local candles'});
  assert.equal(r.status,200);
  const d=await r.json();
  assert.equal(d.data_source,'Exness MT5 local candles');
  assert.equal(d.pipeline.charts.dataSource,'Exness MT5 local candles');
});

test('analyze fails honestly when the live feed is down (502, no simulation)', async () => {
  const store = createStore(join(tmpDir, 'store-dead.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '' }), { apiKey: '' });
  const app = createApp({ store, config, feed: deadFeed });
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/signals/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'EUR/USD' })
    });
    assert.equal(res.status, 502);
    const d = await res.json();
    assert.equal(d.error, 'live_data_unavailable');
  } finally { s.close(); }
});

test('invalid symbol rejected', async () => {
  const r = await post('/api/signals/analyze', { symbol: '<script>x</script>' });
  assert.equal(r.status, 400);
});

test('second analyze within 5-min TTL is cached unless force=true', async () => {
  await post('/api/signals/analyze', { symbol: 'BTC/USD' }, { 'x-aurum-user': 'tester' });
  const cached = await (await post('/api/signals/analyze', { symbol: 'BTC/USD' }, { 'x-aurum-user': 'tester' })).json();
  assert.equal(cached.meta.cached, true);
  const forced = await (await post('/api/signals/analyze', { symbol: 'BTC/USD', force: true }, { 'x-aurum-user': 'tester' })).json();
  assert.equal(forced.meta.cached, false);
});

test('scan: technical-only results on live candles, no AI cost', async () => {
  const r = await post('/api/signals/scan', { symbols: ['EUR/USD', 'XAU/USD', 'NOPE/<script>'] });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.feed, 'deriv-public');
  assert.equal(d.results.length, 2); // invalid symbol dropped
  for (const s of d.results) {
    assert.ok(['BUY', 'SELL', 'WAIT'].includes(s.signal), s.signal);
    assert.equal(s.model, 'technical');
    assert.ok(s.price > 0);
  }
  const bad = await post('/api/signals/scan', { symbols: [] });
  assert.equal(bad.status, 400);
});

test('news endpoint requires ANY AI key (perplexity/claude/chatgpt)', async () => {
  const r = await post('/api/news/expectations', { symbol: 'EUR/USD' });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.equal(d.error, 'no_ai_key');
  /* an explicit engine with no matching key also fails honestly */
  const r2 = await post('/api/news/expectations', { symbol: 'EUR/USD', engine: 'claude' });
  assert.equal(r2.status, 400);
});

test('deriv connect without PAT is rejected (no token persisted anywhere)', async () => {
  const r = await post('/api/deriv/connect', {}, { 'x-deriv-pat': '' });
  assert.equal(r.status, 401);
  const d = await r.json();
  assert.equal(d.error, 'deriv_rejected');
});

test('deriv order without PAT is rejected before any network call', async () => {
  const r = await post('/api/deriv/order', { symbol: 'EUR/USD', amount: 1, side: 'BUY' });
  assert.equal(r.status, 401);
  const d = await r.json();
  assert.equal(d.error, 'no_pat');
});

test('history is per-user', async () => {
  const a = await (await get('/api/signals/history', { 'x-aurum-user': 'alice' })).json();
  const b = await (await get('/api/signals/history', { 'x-aurum-user': 'bob' })).json();
  assert.equal(a.signals.length, 0);
  assert.equal(b.signals.length, 0);
  await post('/api/signals/analyze', { symbol: 'ETH/USD' }, { 'x-aurum-user': 'alice' });
  const a2 = await (await get('/api/signals/history', { 'x-aurum-user': 'alice' })).json();
  const b2 = await (await get('/api/signals/history', { 'x-aurum-user': 'bob' })).json();
  assert.equal(a2.signals.length, 1);
  assert.equal(b2.signals.length, 0);
});

test('usage endpoint reports today spend under cap', async () => {
  const u = await (await get('/api/signals/usage', { 'x-aurum-user': 'local' })).json();
  assert.equal(typeof u.cost, 'number');
  assert.equal(u.cap, 5);
  assert.ok(u.cost < u.cap);
});

/* ---------- store-level budget enforcement ---------- */
test('budget gate: spent >= cap blocks all AI engines before any call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurum-budget-'));
  try {
    const store = createStore(join(dir, 'store.json'));
    store.recordUsage({ user: 'local', model: 'claude-opus-4-1', tokens_in: 90000, tokens_out: 30000, cost: 5.5, day: todayKey() });
    assert.equal(store.statsToday('local').cost, 5.5);
    const config = Object.assign(configFromEnv({ DAILY_BUDGET_USD: '5' }), {
      apiKey: 'sk-ant-should-not-be-used',
      openaiKey: 'sk-openai-should-not-be-used',
      dailyBudgetUsd: 5
    });
    const app = createApp({ store, config, feed: stubFeed });
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/api/signals/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'GBP/USD' })
      });
      const d = await res.json();
      /* even WITH keys set, budget must win -> technical fallback */
      assert.equal(d.meta.mode, 'technical');
      assert.equal(d.meta.reason, 'budget_exceeded');
      assert.equal(d.meta.cap, 5);
    } finally { s.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- device-wide budget: session names must not reset the cap ---------- */
test('budget gate ignores session name — switching Live/Deriv/Exness keeps one $5 cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurum-budget-x sess-'));
  try {
    const store = createStore(join(dir, 'store.json'));
    /* spent under a different session label entirely */
    store.recordUsage({ user: 'local', session: 'Deriv', model: 'gpt-4o', tokens_in: 400000, tokens_out: 100000, cost: 1.5, day: todayKey() });
    const config = Object.assign(configFromEnv({ DAILY_BUDGET_USD: '5' }), { apiKey: '', openaiKey: '', perplexityKey: '' });
    const app = createApp({ store, config, feed: stubFeed });
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    try {
      /* usage endpoint reports the device-wide total regardless of caller */
      const u = await (await fetch(`http://127.0.0.1:${s.address().port}/api/signals/usage`, { headers: { 'x-aurum-user': 'Exness' } })).json();
      assert.equal(u.cost, 1.5);
      assert.equal(u.cap, 5);
      /* gate reads the same ledger — 1.5 < 5 so analysis still runs */
      const res = await fetch(`http://127.0.0.1:${s.address().port}/api/signals/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aurum-user': 'Live' },
        body: JSON.stringify({ symbol: 'EUR/USD', force: true })
      });
      const d = await res.json();
      assert.equal(d.meta.reason, 'no_keys');
      /* now push the device ledger over the cap — every session must be blocked */
      store.recordUsage({ user: 'local', session: 'Live', model: 'claude-opus-4-1', tokens_in: 100000, tokens_out: 10000, cost: 3.6, day: todayKey() });
      const res2 = await fetch(`http://127.0.0.1:${s.address().port}/api/signals/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aurum-user': 'FreshSessionName' },
        body: JSON.stringify({ symbol: 'EUR/USD', force: true })
      });
      const d2 = await res2.json();
      assert.equal(d2.meta.mode, 'technical');
      assert.equal(d2.meta.reason, 'budget_exceeded');
      assert.equal(d2.meta.cap, 5);
    } finally { s.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
