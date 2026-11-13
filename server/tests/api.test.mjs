import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore, todayKey } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';
import { runDeterministicAnalysis } from '../lib/analyzer.js';
import { localDecision } from '../lib/localdecision.js';
import { closedCandleSets } from '../lib/closedcandles.js';

/* ================================================================
 * API tests run against a STUB feed injected via createApp({feed}).
 * No network: the real Deriv feed is exercised manually / by probes.
 * ================================================================ */

process.env.ANTHROPIC_API_KEY = '';
process.env.DAILY_BUDGET_USD = '5';

/* deterministic stub candles — clean uptrend so MTF confirms; never random.
   Like the feed's own, the series of one market end at the same moment: the newest candle of each
   timeframe is the one that is forming at STUB_NOW. A reading is made from the candles that had
   finished by the last 5-minute close (server/lib/closedcandles.js); series that end hours apart, as this
   stub's once did, leave the 5-minute timeframe with too few of them. */
const STUB_NOW = 1700006530; /* 2 min 10 s after a full hour (1700006400) */
const STUB_CLOSE = 1700006400; /* the last 5-minute close before STUB_NOW */
function stubCandles(sym, granularity, count = 120) {
  const base = { 'EUR/USD': 1.1, 'GBP/USD': 1.3, 'BTC/USD': 80000, 'XAU/USD': 4000 }[sym] || 100;
  const newest = Math.floor(STUB_NOW / granularity) * granularity;
  const out = [];
  let p = base;
  for (let i = 0; i < count; i++) {
    p = p * (1 + 0.0006 + Math.sin(i / 9) * 0.0004);
    out.push({ time: newest - (count - 1 - i) * granularity, open: p * 0.999, high: p * 1.002, low: p * 0.998, close: p, volume: 10 });
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
  /* the reading belongs to the last 5-minute close; the newest 1-minute candle is the one still forming */
  assert.equal(d.candle_close, STUB_CLOSE);
  assert.equal(d.candle_current, true);
  assert.equal(d.latest_candle_time, STUB_CLOSE + 120);
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

/* Candles as the PC page sends them from MetaTrader 5: the newest of each timeframe is the one forming now. */
function freshExnessSets(symbol='XAU/USD'){
  const now=Math.floor(Date.now()/1000);
  const make=(granularity)=>stubCandles(symbol,granularity,120).map((c,i)=>Object.assign({},c,{time:Math.floor(now/granularity)*granularity-granularity*(119-i)}));
  return {m1:make(60),m5:make(300),h1:make(3600)};
}

test('AI analysis accepts validated read-only Exness candles and labels the actual source', async () => {
  const r=await post('/api/signals/analyze',{symbol:'XAU/USD',force:true,technicalOnly:true,candleSets:freshExnessSets(),dataSource:'Exness MT5 local candles'});
  assert.equal(r.status,200);
  const d=await r.json();
  assert.equal(d.data_source,'Exness MT5 local candles');
  assert.equal(d.symbol,'XAU/USD');
  assert.ok(d.latest_candle_time>0);
  /* made from the candles that had finished by the last 5-minute close, like every other reading */
  const now=Math.floor(Date.now()/1000);
  assert.ok(d.latest_candle_time>now-120&&d.latest_candle_time<=now,'the newest candle MetaTrader 5 sent');
  assert.equal(d.candle_close%300,0);
  assert.ok(d.candle_close<=d.latest_candle_time&&d.latest_candle_time-d.candle_close<600);
  assert.equal(d.candle_current,true);
  const bad=await post('/api/signals/analyze',{symbol:'XAU/USD',force:true,technicalOnly:true,candleSets:freshExnessSets(),dataSource:'Deriv public candles'});
  assert.equal(bad.status,400);
  assert.equal((await bad.json()).error,'invalid_candle_source');
});

test('pipeline runs on Exness candles supplied by the read-only local bridge', async()=>{
  const sets=freshExnessSets();
  const r=await post('/api/pipeline/analyze',{symbol:'XAU/USD',candleSets:sets,dataSource:'Exness MT5 local candles'});
  assert.equal(r.status,200);
  const d=await r.json();
  assert.equal(d.data_source,'Exness MT5 local candles');
  assert.equal(d.pipeline.charts.dataSource,'Exness MT5 local candles');
  /* The six roles speak of the candles the reading above them was made from: same close, same votes. */
  const reading=await (await post('/api/signals/analyze',{symbol:'XAU/USD',force:true,technicalOnly:true,candleSets:sets,dataSource:'Exness MT5 local candles'})).json();
  assert.equal(d.candle_close,reading.candle_close);
  assert.equal(d.candle_current,true);
  assert.equal(d.pipeline.charts.votes,reading.votes);
  assert.equal(d.pipeline.charts.mtfSignal,reading.mtf_signal);
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
    assert.equal(s.candle_close, STUB_CLOSE);
    assert.equal(s.candle_current, true);
    assert.equal(s.latest_candle_time, STUB_CLOSE + 120);
  }
  const bad = await post('/api/signals/scan', { symbols: [] });
  assert.equal(bad.status, 400);
});

/* ---- one reading per finished 5-minute candle (server/lib/closedcandles.js) ---- */

/* A second server whose feed the test can change between two requests. */
async function withFeed(fetchCandles, run) {
  const dir = mkdtempSync(join(tmpdir(), 'aurum-api-close-'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '', DAILY_BUDGET_USD: '5' }), { apiKey: '', backtestRatePerMin: 1000 });
  const app = createApp({ store: createStore(join(dir, 'store.json')), config, feed: { symbols: stubFeed.symbols, fetchCandles } });
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const origin = `http://127.0.0.1:${s.address().port}`;
  const send = (path, body, headers = {}) => fetch(origin + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  const call = (path, body) => send(path, body).then((r) => r.json());
  /* the answer with its HTTP status */
  call.full = (path, body, headers) => send(path, body, headers).then(async (r) => ({ status: r.status, body: await r.json() }));
  call.get = (path) => fetch(origin + path).then((r) => r.json());
  try { return await run(call); }
  finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
}
const READING_FIELDS = ['signal', 'bias', 'confidence', 'entry', 'stop_loss', 'tp1', 'tp2', 'rrr', 'price', 'mtf_signal', 'votes', 'wait_reason', 'wait_detail', 'data_ok', 'candle_close', 'candle_current', 'latest_candle_time'];
const pick = (reading) => Object.fromEntries(READING_FIELDS.map((key) => [key, reading[key]]));

test('scan and analyze: the candle that is still forming does not change the reading', async () => {
  /* The newest candle of each timeframe is the forming one. `move` is where its price stands now. */
  let move = 1;
  const fetchCandles = async (sym, g, n) => stubCandles(sym, g, n).map((c, i, all) => (i === all.length - 1
    ? { ...c, close: c.close * move, high: c.high * Math.max(1, move), low: c.low * Math.min(1, move) }
    : c));
  await withFeed(fetchCandles, async (call) => {
    const scanBefore = (await call('/api/signals/scan', { symbols: ['EUR/USD'] })).results[0];
    const goldBefore = await call('/api/signals/analyze', { symbol: 'XAU/USD', force: true, technicalOnly: true });
    const fullBefore = await call('/api/signals/analyze', { symbol: 'EUR/USD', force: true });
    const rolesBefore = await call('/api/pipeline/analyze', { symbol: 'EUR/USD' });

    move = 0.97; /* a fall of 3% inside the forming candles: enough to turn every vote of the old reading */
    const scanAfter = (await call('/api/signals/scan', { symbols: ['EUR/USD'] })).results[0];
    const goldAfter = await call('/api/signals/analyze', { symbol: 'XAU/USD', force: true, technicalOnly: true });
    const fullAfter = await call('/api/signals/analyze', { symbol: 'EUR/USD', force: true });
    const rolesAfter = await call('/api/pipeline/analyze', { symbol: 'EUR/USD' });

    assert.deepEqual(pick(scanAfter), pick(scanBefore));
    assert.deepEqual(pick(goldAfter), pick(goldBefore));
    assert.deepEqual(pick(fullAfter), pick(fullBefore));
    /* the six-role panel under a reading is made from the same finished candles */
    const roles = (answer) => ({ close: answer.candle_close, current: answer.candle_current, votes: answer.pipeline.charts.votes, mtf: answer.pipeline.charts.mtfSignal, score: answer.pipeline.scout.score, direction: answer.pipeline.scout.direction, verdict: answer.pipeline.boss.verdict });
    assert.deepEqual(roles(rolesAfter), roles(rolesBefore));
    assert.equal(rolesBefore.pipeline.charts.votes, fullBefore.votes);
    assert.equal(rolesBefore.pipeline.charts.mtfSignal, fullBefore.mtf_signal);
    assert.equal(rolesBefore.candle_close, STUB_CLOSE);
    assert.equal(rolesBefore.candle_current, true);
    /* the price of a reading is the close of the last finished 1-minute candle, not the forming one */
    const finished = stubCandles('EUR/USD', 60, 120).filter((c) => c.time + 60 <= STUB_CLOSE);
    assert.equal(scanBefore.price, finished.at(-1).close);
    assert.equal(fullBefore.price, finished.at(-1).close);
    /* scan and analyze give one and the same reading of a market */
    assert.deepEqual(pick(fullBefore), pick(scanBefore));
    assert.equal(scanBefore.candle_close, STUB_CLOSE);
  });
});

test('a market that has just resumed after a pause: scan, analysis and the six-role panel hand out no reading from before it', async () => {
  /* Nothing traded for the 40 minutes before the newest candle. */
  const afterPause = (sym, g, n) => {
    const newest = Math.floor(STUB_NOW / g) * g;
    return stubCandles(sym, g, n).filter((c) => c.time >= newest || c.time < newest - 2400);
  };
  /* What the rule makes of those candles: a BUY with the entry, the stop and the target of the market before the
     pause. This is what the routes returned, marked candle_current:false, before they withheld it. */
  const before = closedCandleSets({ m1: afterPause('EUR/USD', 60, 120), m5: afterPause('EUR/USD', 300, 120), h1: afterPause('EUR/USD', 3600, 120) });
  assert.equal(before.current, false);
  assert.ok(STUB_CLOSE - before.close >= 2400, 'the close is from before the pause');
  const stale = localDecision(runDeterministicAnalysis('EUR/USD', before.sets));
  assert.equal(stale.signal, 'BUY', 'the stub no longer reads as a BUY before the pause: the test needs a signal to withhold');
  assert.ok(stale.entry > 0 && stale.stop_loss > 0 && stale.tp1 > 0);

  /* Requests this server makes to the outside (the news brief, an AI engine) while the test runs. */
  const outbound = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
    outbound.push(url);
    return Promise.reject(new Error('written by the test: no network'));
  };
  let paused = false;
  try {
    await withFeed(async (sym, g, n) => (paused ? afterPause(sym, g, n) : stubCandles(sym, g, n)), async (call) => {
      const withNews = { symbol: 'EUR/USD', force: true, withNews: true };
      const newsKey = { 'x-ai-perplexity': 'written-by-the-test' };

      /* While the market runs: a reading, a news request for it, and the reading is kept. */
      const running = await call.full('/api/signals/analyze', withNews, newsKey);
      assert.equal(running.status, 200);
      assert.equal(running.body.candle_current, true);
      assert.deepEqual(outbound, ['https://api.perplexity.ai/chat/completions']);
      assert.equal((await call.get('/api/signals/history?limit=20')).signals.length, 1);

      paused = true;
      const scan = await call.full('/api/signals/scan', { symbols: ['EUR/USD'] });
      const gold = await call.full('/api/signals/analyze', { symbol: 'XAU/USD', force: true, technicalOnly: true });
      const full = await call.full('/api/signals/analyze', withNews, newsKey);
      const roles = await call.full('/api/pipeline/analyze', { symbol: 'EUR/USD' });

      /* The scan still answers for its other markets; this market's row holds no reading. */
      assert.equal(scan.status, 200);
      assert.deepEqual([gold.status, full.status, roles.status], [409, 409, 409]);
      for (const [name, symbol, answer] of [['scan', 'EUR/USD', scan.body.results[0]], ['gold monitor', 'XAU/USD', gold.body], ['analysis', 'EUR/USD', full.body], ['six roles', 'EUR/USD', roles.body]]) {
        assert.equal(answer.error, 'STALE_DATA', name);
        assert.equal(answer.data_state, 'stale', name);
        assert.equal(answer.symbol, symbol, name);
        assert.equal(answer.detail, symbol + ' has just resumed after a pause: no 5-minute candle has closed since, so a reading would describe the market before the pause. The first reading comes with the next 5-minute close.', name);
        assert.equal(answer.candle_current, false, name);
        assert.equal(answer.latest_candle_time, STUB_CLOSE + 120, name + ': the feed itself is current');
        assert.equal(answer.candle_close, before.close, name + ': the close it would have been read at');
        for (const field of ['signal', 'bias', 'confidence', 'entry', 'stop_loss', 'tp1', 'tp2', 'rrr', 'price', 'mtf_signal', 'votes', 'pipeline', 'meta']) {
          assert.equal(field in answer, false, name + ': no ' + field + ' from before the pause');
        }
      }
      /* Nothing was paid for and nothing was kept: no second news request, no second stored signal. */
      assert.deepEqual(outbound, ['https://api.perplexity.ai/chat/completions']);
      assert.equal((await call.get('/api/signals/history?limit=20')).signals.length, 1);

      /* With a finished candle of the new session the market is read again. */
      paused = false;
      const again = (await call('/api/signals/scan', { symbols: ['EUR/USD'] })).results[0];
      assert.equal(again.error, undefined);
      assert.equal(again.candle_current, true);
      assert.equal(again.candle_close, STUB_CLOSE);
    });
  } finally { globalThis.fetch = realFetch; }
});

test('a feed without one finished 5-minute candle is left to the analysis: a WAIT that says it has no candles, not a pause', async () => {
  const one = (sym, g) => stubCandles(sym, g, 120).slice(-1);
  await withFeed(async (sym, g) => one(sym, g), async (call) => {
    const scan = await call.full('/api/signals/scan', { symbols: ['EUR/USD'] });
    assert.equal(scan.status, 200);
    const row = scan.body.results[0];
    assert.equal(row.error, undefined);
    assert.equal(row.signal, 'WAIT');
    assert.equal(row.data_ok, false);
    assert.equal(row.wait_reason, 'FEED_ERROR');
    assert.equal(row.candle_close, 0);
    assert.equal(row.candle_current, false);
  });
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
      apiKey: 'test-claude-key-not-real',
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
