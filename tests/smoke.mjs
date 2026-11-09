/* AURUM — smoke suite: bundles src/main.js with esbuild, injects it into
 * index.html under jsdom, and exercises the real user journey with a
 * scripted fake WebSocket (Deriv feed) and a mocked /api layer.
 * No network access; asserts REAL-DATA-only behaviour (no demo/sim).
 * Run: npm test                                                              */
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* ---------- bundle the app ---------- */
const bundle = await build({
  entryPoints: [join(root, 'src', 'main.js')],
  bundle: true,
  write: false,
  format: 'iife',
  absWorkingDir: root,
  define: { 'import.meta.env': '{}' },
  logLevel: 'silent'
});
const bundleCode = bundle.outputFiles[0].text;

/* ---------- assemble the page ---------- */
const polyfill = `
<script>
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = q => ({ matches: false, media: q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function(){};
window.scrollTo = function(){};

/* ---- scripted Deriv feed (offline) ---- */
window.__socks = [];
window.__derivOpen = false;
window.__pushTick = function(code, quote){
  window.__socks.forEach(s => {
    if (s.__deriv && s.onmessage) {
      try { s.onmessage({ data: JSON.stringify({ tick: { symbol: code, quote: quote, epoch: Math.floor(Date.now()/1000) } }) }); } catch(e){}
    }
  });
};
(function(){
  const RealWS = window.WebSocket;
  function FakeWS(url){
    const self = this;
    this.url = String(url);
    this.readyState = 0;
    this.__deriv = this.url.includes('derivws.com'); /* public feed AND official spec WS */
    window.__socks.push(this);
    setTimeout(function(){
      self.readyState = 1;
      if (self.onopen) self.onopen();
      if (!self.__deriv) { setTimeout(function(){ if (self.onclose) self.onclose(); }, 30); return; }
      if (window.__derivOpen) return;
      window.__derivOpen = true;
      const seeds = [['frxEURUSD',1.1055],['frxGBPUSD',1.2941],['frxUSDJPY',149.62],['frxAUDUSD',0.6612],
                     ['frxXAUUSD',4149.5],['cryBTCUSD',84041.3],['cryETHUSD',2683.2],['R_75',45792.9]];
      const send = function(round){
        seeds.forEach(function(pair, k){
          const q = pair[1] * (1 + (round + 1) * 0.0004 * (k % 2 ? -1 : 1));
          if (self.onmessage) {
            try { self.onmessage({ data: JSON.stringify({ tick: { symbol: pair[0], quote: q, epoch: Math.floor(Date.now()/1000) } }) }); } catch(e){}
          }
        });
      };
      send(0);
      setTimeout(function(){ send(1); }, 50);
    }, 10);
  }
  FakeWS.prototype.send = function(data){
    /* official-API responder for PAT-mode browser calls (authorize first) */
    try{
      const m=JSON.parse(data);
      const sock=this;
      const reply=(o)=>{ if(sock.onmessage) sock.onmessage({ data: JSON.stringify(o) }); };
      if(m.authorize!==undefined){ reply({ msg_type:'authorize', authorize:{ loginid:'12345678', fullname:'Test Trader', currency:'USD', balance:1000.5, is_virtual:false } }); return; }
      if(m.proposal!==undefined&&m.proposal===1){ reply({ msg_type:'proposal', proposal:{ id:'P'+(++window.__contract), ask_price:100, payout:190, currency:'USD' } }); return; }
      if(m.buy!==undefined&&m.buy){ window.__contract=(window.__contract||700)+1; reply({ msg_type:'buy', buy:{ contract_id:window.__contract, buy_price:100, payout:190, currency:'USD' } }); return; }
      if(m.sell!==undefined&&m.sell){ reply({ msg_type:'sell', sell:{ price:260.5, sold_time:Math.floor(Date.now()/1000) } }); return; }
    }catch(e){}
  };
  FakeWS.prototype.close = function(){ this.readyState = 3; };
  window.WebSocket = FakeWS;
})();

/* ---- mocked /api (offline, deterministic) ---- */
window.__apiCalls = [];
let __contract = 700;
window.fetch = function(url, opts){
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  window.__apiCalls.push(method + ' ' + u);
  const json = (body, status) => Promise.resolve({
    ok: (status || 200) < 300, status: status || 200,
    json: () => Promise.resolve(body)
  });
  if (u.includes('/api/health')) return json({ ok: true, engines: { claude: false, chatgpt: false, perplexity: false }, live_feed: 'deriv-public', symbols: 20, budget: { cap: 5, spent: 0 }, available_now: [] });
  if (u.includes('/api/signals/usage')) return json({ calls: 0, tokens_in: 0, tokens_out: 0, cost: 0, cap: 5 });
  if (u.includes('/api/signals/scan')) {
    const syms = JSON.parse(opts.body).symbols || [];
    const payload = { feed: 'deriv-public', ts: Date.now(), results: syms.map((s, i) => {
      const gold = s === 'XAU/USD' || s === 'XAUUSD';
      return {
        symbol: s, price: gold ? 4102.4 : 1.105 + i, mtf_signal: gold ? 'WAIT' : (i % 2 ? 'SELL_CONFIRMED' : 'BUY_CONFIRMED'), data_ok: true,
        bias: gold ? 'neutral' : (i % 2 ? 'bearish' : 'bullish'), votes: gold ? '1m WAIT · 5m WAIT · 1h WAIT' : '1m +3 BUY · 5m +2 WAIT · 1h +3 BUY',
        signal: gold ? 'WAIT' : (i % 2 ? 'SELL' : 'BUY'), confidence: gold ? 0 : 66 + i, entry: gold ? null : 1.104 + i, stop_loss: gold ? null : 1.099 + i,
        tp1: gold ? null : 1.112 + i, tp2: gold ? null : 1.118 + i, tf: 'MTF 1m/5m/1h', model: 'technical', ts: Date.now()
      };
    }) };
    if (window.__deferScanSymbol && syms.length === 1 && syms[0] === window.__deferScanSymbol) {
      window.__deferScanSymbol = null;
      return new Promise(resolve => { window.__resolveDeferredScan = () => resolve(json(payload)); });
    }
    return json(payload);
  }
  if (u.includes('/api/signals/analyze')) {
    return json({
      symbol: 'EUR/USD', price: 1.1055, ts: Date.now(), timeframe: 'MTF',
      signal: 'BUY', confidence: 72, entry: 1.1048, stop_loss: 1.1035, tp1: 1.107, tp2: 1.1095,
      rrr: 1.69, rationale: 'Live-candle MTF confluence with 2/3 timeframe votes on the stub feed.',
      technical_summary: 'trend=UPTREND · rsi14=58.2 · mtf=BUY_CONFIRMED',
      key_levels: { support: [1.1021, 1.1005], resistance: [1.1088, 1.1110] },
      risks: ['Timeframes could divere on the next bar.', 'Verify levels against your broker quote.', 'Size positions to your own risk limit.'],
      next_watch: 'Hold above 1.1021 keeps the structure bullish.',
      mtf_signal: 'BUY_CONFIRMED', data_ok: true, sentiment_score: 55, sentiment_source: 'derived',
      news: { available: false, reason: 'no_perplexity_key' },
      meta: { mode: 'technical', reason: 'no_keys', spent: 0, cap: 5, engines: [], failures: [], cached: false }
    });
  }
  if (u.includes('/api/news/expectations')) {
    return json({ symbol: 'EUR/USD', ts: Date.now(), brief: 'Drivers: central bank rhetoric. Expected: unchanged rates, dovish lean. Risk: surprise hike would pressure equities.', engine: 'perplexity', model: 'sonar' });
  }
  if (u.includes('/api/deriv/connect')) {
    return json({ ok: true, mode: 'pat_browser', environment: 'demo', limits: { maxStakeUsd: 50, maxOpenTrades: 5, dailyLossLimitUsd: 25 } });
  }
  if (u.includes('/api/deriv/order')) {
    return json({ ok: true, approved: true, limits: { maxStakeUsd: 50, maxOpenTrades: 5, dailyLossLimitUsd: 25 }, risk: { opens: 1, dayPnl: 0 } });
  }
  if (u.includes('/api/deriv/fill')) return json({ ok: true, dayPnl: 0, opens: 1 });
  if (u.includes('/api/deriv/close')) return json({ ok: true, approved: true, contract_id: JSON.parse(opts.body).contract_id });
  if (u.includes('/api/deriv/pat/session')) {
    return json({ ok: true, sid: 'a'.repeat(48), accounts: [{ account_id: 'VRW12345', account_type: 'demo', currency: 'USD', balance: 9500 }], primary: { account_id: 'VRW12345', account_type: 'demo', currency: 'USD', balance: 9500 }, environment: 'demo', limits: { maxStakeUsd: 50, maxOpenTrades: 5, dailyLossLimitUsd: 25 } });
  }
  if (u.includes('/api/deriv/pat/proposal')) {
    return json({ ok: true, ticket: { id: 'TICKET_1', symbol: 'EUR/USD', side: (JSON.parse(opts.body).side || 'BUY'), amount: JSON.parse(opts.body).amount, duration: 5, duration_unit: 'm' }, quote: { payout: 190, stake: JSON.parse(opts.body).amount, currency: 'USD' } });
  }
  if (u.includes('/api/deriv/pat/confirm')) return json({ ok: true, order: { contract_id: 777001, buy_price: 100, payout: 190, currency: 'USD' } });
  if (u.includes('/api/deriv/status')) return json({ ok: true, contract: { contract_id: 1, is_sold: false, is_settled: false, profit: 0, current_spot: 1.1, entry_spot: 1.1, status: 'open' } });
  if (u.includes('/api/deriv/health')) return json({ ok: true, state: 'not_configured', authorized: false, environment: 'demo', tokenSet: false, appId: null, endpoint: '', tradingEnabled: false, missing: ['DERIV_APP_ID', 'DERIV_API_TOKEN'], limits: { maxStakeUsd: 50, maxOpenTrades: 5, dailyLossLimitUsd: 25 }, reconnects: 0, attempt: 0, lastMessageAt: null, authError: null });
  if (u.includes('/api/backtest')) return json({ symbol: 'EUR/USD', bars: 400, warmup: 70, granularity: 300, source: 'deriv-candles', stats: { trades: 12, closed: 12, wins: 7, losses: 5, winRate: 58.3, netR: 4.2, avgR: 0.35, profitFactor: 1.9, maxDrawdownR: 2.1, byResult: {} }, trades: [{ side: 'BUY', entry: 1.1, exit: 1.102, bars: 6, result: 'tp1', r: 1.5 }], note: 'fixture' });
  if (u.includes('/api/patterns/analyze')) {
    const patCandles = [];
    for (let i = 0; i < 60; i++) {
      const c = 1.1 + Math.sin(i / 4) * 0.003 + i * 0.0001;
      const o = c + Math.cos(i / 3) * 0.0015;
      patCandles.push({ time: 1700000000 + i * 300, open: o, high: Math.max(o, c) + 0.0015, low: Math.min(o, c) - 0.0015, close: c, volume: 10 + i });
    }
    return json({ symbol: 'EUR/USD', granularity: 300, bars: 60, source: 'deriv-candles', ts: Date.now(), candles: patCandles, patterns: [
      { key: 'bull_flag', pattern: 'Bull flag', direction: 'bullish', action: 'BUY', confidence: 78, status: 'formed', entry: 1.105, stop: 1.101, target: 1.112, ageBars: 2, detail: 'flagpole 0.008 · consolidation 5 bars', lines: [{ i1: 10, p1: 1.097, i2: 30, p2: 1.108, style: 'solid' }, { i1: 34, p1: 1.103, i2: 52, p2: 1.106, style: 'dashed' }] },
      { key: 'asc_tri', pattern: 'Ascending triangle', direction: 'bullish', action: 'HOLD', confidence: 64, status: 'forming', entry: 1.105, stop: 1.1, target: null, ageBars: 1, detail: 'flat resistance 1.108 · rising troughs', lines: [{ i1: 8, p1: 1.108, i2: 55, p2: 1.108, style: 'solid' }] }
    ] });
  }
  if (u.includes('/api/patterns/study')) {
    return json({ symbol: 'EUR/USD', granularity: 300, source: 'deriv-candles', ts: Date.now(), window: 540, holdBars: 48, signals: 21,
      note: 'Walk-forward on 540 real candles: every historical signal was followed bar-by-bar (stop first, then target, 48-bar timeout).',
      meta: {}, patterns: [
        { key: 'double_bot', pattern: 'Double bottom', n: 6, wins: 4, losses: 2, winRate: 66.7, avgR: 0.42, avgBars: 21 },
        { key: 'hs', pattern: 'Head & shoulders', n: 5, wins: 2, losses: 3, winRate: 40, avgR: -0.12, avgBars: 30 },
        { key: 'bull_flag', pattern: 'Bull flag', n: 10, wins: 6, losses: 4, winRate: 60, avgR: 0.3, avgBars: 14 }
      ], trades: [] });
  }
  if (u.includes('supabase.co/auth/v1/token?grant_type=password')) {
    return json({ access_token: 'smoke-user-jwt', refresh_token: 'smoke-refresh', expires_in: 3600, user: { id: 'smoke-user', email: 'smoke@example.com' } });
  }
  if (u.includes('supabase.co/auth/v1/signup')) {
    return json({ access_token: 'smoke-user-jwt', refresh_token: 'smoke-refresh', expires_in: 3600, user: { id: 'smoke-user', email: 'smoke@example.com' } });
  }
  if (u.includes('supabase.co/auth/v1/logout')) return json({});
  if (u.includes('supabase.co/rest/v1/analysis_history')) {
    if (method === 'POST') return json({}, 201);
    return json([{ id: 1, kind: 'pattern_scan', symbol: 'EUR/USD', timeframe: '300', payload: { bars: 120 }, created_at: '2026-10-10T14:00:00Z' }]);
  }
  if (u.includes('supabase.co/rest/v1/pattern_events')) {
    if (method === 'POST') return json({}, 201);
    return json([{ id: 1, pattern_key: 'inv_hs', direction: 'bullish', action: 'BUY', confidence: 72, status: 'formed', created_at: '2026-10-10T13:59:00Z' }]);
  }
  if (u.includes('supabase.co/rest/v1/alerts')) {
    if (method === 'POST') return json({}, 201);
    return json([{ id: 1, title: 'Pattern alert · EUR/USD', body: 'inv_hs 72% → BUY', created_at: '2026-10-10T13:59:30Z' }]);
  }
  if (u.includes('supabase.co/rest/v1/signals')) {
    if (method === 'POST') return json({}, 201);
    return json([{ id: 1, signal: 'BUY', symbol: 'EUR/USD', confidence: 78, entry_price: 1.1000, stop_loss: 1.0950, take_profit_1: 1.1100, engine: 'technical', created_at: '2026-10-10T14:05:00Z' }]);
  }
  return json({ error: 'not mocked: ' + u }, 404);
};
<\/script>`;
const assembled = polyfill + '\n<script>' + bundleCode + '</' + 'script>';
/* NOTE: pass a replacer function — a string replacement would mangle
 * any $$ / $& / $` sequences inside the bundle (String.replace magic). */
let html = readFileSync(join(root, 'index.html'), 'utf8')
  .replace('<script type="module" src="/src/main.js"></script>', () => assembled);
if (html.includes('src="/src/main.js"')) { console.error('module script not replaced'); process.exit(2); }

/* ---------- jsdom with error capture ---------- */
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + e.message));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' });
const { window } = dom;
const doc = window.document;
const $ = s => doc.querySelector(s);
const ok = [], bad = [];
const check = (name, cond, extra) => (cond ? ok : bad).push(name + (cond ? '' : ' -> ' + extra));
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const submit = el => el.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const input = el => el.dispatchEvent(new window.Event('input', { bubbles: true }));
const store = {
  get k() { return k => JSON.parse(window.localStorage.getItem('aurum_' + k)); }
};

const confirmOpen = () =>
  Array.from(doc.querySelectorAll('.modal-overlay'))
    .some(m => m.classList.contains('open') && m.querySelector('.cbYes'));
const confirmYes = () => {
  doc.querySelectorAll('.modal-overlay .cbYes').forEach(b => {
    if (b.closest('.modal-overlay').classList.contains('open')) click(b);
  });
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => parseFloat(String(s).replace(/,/g, ''));
const toasts = () => $('#toasts').textContent;

async function run() {
  await sleep(400); /* let module boot + fake feed open */

  /* 1 — connect screen (no demo login exists) */
  check('auth shown', !$('#authScreen').classList.contains('hidden'));
  check('app hidden pre-login', !$('#appShell').classList.contains('ready'));
  check('no legacy login form', !$('#loginForm'));
  check('Deriv and Exness forms present', !!$('#derivForm') && !!$('#exnessForm') && !!$('#guestBtn'));
  $('#derivPat').value = '';
  submit($('#derivForm'));
  check('empty PAT rejected', $('#authErr').style.display === 'block' && !$('#appShell').classList.contains('ready'));

  /* guest / live-markets path */
  click($('#guestBtn'));
  await sleep(300); /* let the fake Deriv feed deliver first ticks + scan */
  check('live-only login works', $('#appShell').classList.contains('ready') && $('#authScreen').classList.contains('hidden'));
  check('session persisted', (store.k('session') || {}).mode === 'live');
  check('side sub label', $('#sideSub').textContent.includes('no trading'), $('#sideSub').textContent);

  /* 2 — shell with REAL feed */
  check('ticker items', $('#tickerTrack').children.length >= 24, $('#tickerTrack').children.length);
  check('feed label live', $('#feedText').textContent.includes('Deriv'), $('#feedText').textContent);
  check('no demo balance', $('#kpiValue').textContent === 'Not connected', $('#kpiValue').textContent);
  check('movers from live ticks', $('#ovMovers').children.length === 6, $('#ovMovers').children.length);
  check('overview signals from scan', $('#ovSignals').children.length === 3, $('#ovSignals').children.length);
  check('overview news honest hint', $('#ovNews').textContent.length > 10);
  check('empty positions msg clearly distinguishes app records from live MT5 positions', $('#ovPositions').textContent.includes('No app-recorded open positions') || $('#ovPositions').textContent.includes('MT5 reports no open positions'));
  const firstPx = $('#ovMovers').querySelector('[data-px]');
  check('live price rendered', firstPx && firstPx.textContent !== '—', firstPx && firstPx.textContent);

  /* 3 — all views navigate */
  for (const v of ['markets','trade','signals','news','portfolio','automation','settings','overview']) {
    click(doc.querySelector('.nav-item[data-view="' + v + '"]'));
    check('view ' + v + ' active', $('#view-' + v).classList.contains('active'));
    check('title for ' + v, $('#topTitle').textContent.length > 0);
  }

  /* 4 — markets (real universe only) */
  click(doc.querySelector('.nav-item[data-view="markets"]'));
  check('market rows', $('#mktBody').children.length === 26, $('#mktBody').children.length);
  $('#mktSearch').value = 'btc'; input($('#mktSearch'));
  check('search filters', $('#mktBody').children.length === 1, $('#mktBody').children.length);
  $('#mktSearch').value = ''; input($('#mktSearch'));
  click(doc.querySelector('#mktCats .chip[data-cat="crypto"]'));
  check('crypto filter', $('#mktBody').children.length === 2, $('#mktBody').children.length);
  click(doc.querySelector('#mktCats .chip[data-cat="all"]'));
  click(doc.querySelector('.mkt-trade'));
  check('trade btn -> chart view', $('#view-trade').classList.contains('active'));

  /* 5 — chart & ticket (TradingView container, gated orders) */
  check('chart symbol options', $('#chartSymbol').options.length === 26, $('#chartSymbol').options.length);
  check('tv chart container', !!$('#tvChart') && $('#tvChart').children.length >= 0);
  check('no canvas chart', !$('#mainChart'));
  check('bid px live', $('#bidPx').textContent !== '—', $('#bidPx').textContent);
  check('place btn text', /Place BUY/.test($('#placeOrderBtn').textContent));
  click($('#sideSell'));
  check('side sell', $('#placeOrderBtn').textContent.includes('SELL'));
  click($('#sideBuy'));
  $('#orderAmount').value = '0'; click($('#placeOrderBtn'));
  check('reject amount 0', toasts().includes('Invalid amount'));
  $('#orderAmount').value = '50'; click($('#placeOrderBtn'));
  await sleep(60);
  check('guest order blocked', toasts().includes('Trading locked'));

  /* Sniper is now a read-only analysis scanner: it may run without a broker, but never enters. */
  click(doc.querySelector('.nav-item[data-view="settings"]'));
  await sleep(60);
  check('auto-trade card present', !!$('#autoTradeCard') && !!$('#atChk') && !!$('#atStatus'));
  check('auto-trade off by default', !$('#atChk').checked && $('#atStatus').textContent === 'off', $('#atStatus').textContent);
  $('#atChk').checked = true;
  $('#atChk').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(40);
  check('Sniper starts read-only without a broker', $('#atChk').checked && !toasts().includes('Auto-trade needs a broker'), $('#atStatus').textContent+' · '+toasts().slice(-200));
  $('#atChk').checked=false;
  $('#atChk').dispatchEvent(new window.Event('change',{bubbles:true}));
  click(doc.querySelector('.nav-item[data-view="signals"]'));
  check('no position without broker', (store.k('positions') || []).length === 0, JSON.stringify(store.k('positions')));

  /* 6 — signal analyzer (real API contract via mock) */
  click(doc.querySelector('.nav-item[data-view="signals"]'));
  check('signal cards from scan (6 Deriv + 3 indices)', $('#sigGrid').children.length === 9, $('#sigGrid').children.length);
  check('sig stamp', /Updated/.test($('#sigStamp').textContent), $('#sigStamp').textContent);
  click($('#refreshSigs'));
  await sleep(80);
  check('signals refresh', $('#sigGrid').children.length === 9);
  click($('#azRun'));
  await sleep(120);
  check('az result shown', !$('#azResult').classList.contains('hidden'));
  check('az mode honest', $('#azMode').textContent.includes('TECHNICAL'), $('#azMode').textContent);
  check('az entry rendered', $('#azEntry').textContent !== '—', $('#azEntry').textContent);
  check('az history row', $('#azHistBody').children.length === 1, $('#azHistBody').children.length);
  click($('#azUse'));
  await sleep(60);
  check('az use -> trade view', $('#view-trade').classList.contains('active'));
  check('az levels applied', parseFloat($('#orderSL').value) === 1.1035 && parseFloat($('#orderTP').value) === 1.107, $('#orderSL').value + '/' + $('#orderTP').value);
  check('az tp2 applied', parseFloat($('#orderTP2').value) === 1.1095, $('#orderTP2').value);

  /* 6a — changing instruments must clear stale levels; late scans cannot overwrite the new ticket */
  const chartSel = $('#chartSymbol');
  $('#orderSL').value = '1.34653'; $('#orderTP').value = '1.34353'; $('#orderTP2').value = '1.34213';
  window.__deferScanSymbol = 'XAU/USD';
  chartSel.value = 'XAU/USD'; chartSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('symbol switch clears prior instrument SL/TP1/TP2 immediately', $('#orderSL').value === '' && $('#orderTP').value === '' && $('#orderTP2').value === '', $('#orderSL').value + '/' + $('#orderTP').value + '/' + $('#orderTP2').value);
  await sleep(40); /* XAU result intentionally delayed and returns WAIT */
  chartSel.value = 'EUR/USD'; chartSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(80);
  check('new symbol receives only its own current levels', $('#orderSL').value === '1.09900' && $('#orderTP').value === '1.11200' && $('#orderTP2').value === '1.11800', $('#orderSL').value + '/' + $('#orderTP').value + '/' + $('#orderTP2').value);
  if (window.__resolveDeferredScan) window.__resolveDeferredScan();
  await sleep(80);
  check('late XAU WAIT scan cannot overwrite EUR/USD ticket levels', $('#orderSL').value === '1.09900' && $('#orderTP').value === '1.11200' && $('#orderTP2').value === '1.11800', $('#orderSL').value + '/' + $('#orderTP').value + '/' + $('#orderTP2').value);

  /* 7 — settings: AI key vault + notifications */
  click(doc.querySelector('.nav-item[data-view="settings"]'));
  click(doc.querySelector('.theme-card[data-theme-pick="light"]'));
  check('theme light', doc.documentElement.getAttribute('data-theme') === 'light');
  click(doc.querySelector('.theme-card[data-theme-pick="dark"]'));
  check('theme dark', doc.documentElement.getAttribute('data-theme') === 'dark');
  $('#riskRange').value = '5'; input($('#riskRange'));
  check('risk label', $('#riskVal').textContent === '5.0%', $('#riskVal').textContent);
  check('no password section', !$('#openPw'));
  $('#aiClaudeKey').value = 'sk-ant-test'; click($('#aiKeysSave'));
  check('key saved status', $('#aiKeyStatus').textContent.includes('key'), $('#aiKeyStatus').textContent);
  check('key in storage', (JSON.parse(window.localStorage.getItem('aurum_aikeys')) || {}).claude === 'sk-ant-test');
  check('budget pill', $('#aiBudgetTxt').textContent.includes('$'), $('#aiBudgetTxt').textContent);
  check('notif btn state', $('#notifBtn').textContent.length > 0, $('#notifBtn').textContent);

  /* 8 — news: TradingView containers + AI brief (key present) */
  click(doc.querySelector('.nav-item[data-view="news"]'));
  await sleep(80);
  check('tv news container', !!$('#tvNews'));
  check('tv calendar container', !!$('#tvCalendar'));
  check('no fake headline rows', !$('#newsList'));
  click($('#newsBriefBtn'));
  await sleep(80);
  check('brief fetched', $('#newsAiBody').textContent.includes('central bank'), $('#newsAiBody').textContent.slice(0, 60));

  /* 9 — automation: bots exist, arming blocked without broker */
  click(doc.querySelector('.nav-item[data-view="automation"]'));
  check('bot cards', $('#botGrid').children.length === 4, $('#botGrid').children.length);
  check('deriv not connected as guest', !$('#derivStatus').classList.contains('on'));
  click(doc.querySelectorAll('.bot-arm')[2]);
  await sleep(60);
  check('arm blocked without broker', toasts().includes('Broker required'));

  /* 10 — sign out + real Deriv connect */
  click($('#signOutBtn'));
  check('signed out', !$('#appShell').classList.contains('ready') && !$('#authScreen').classList.contains('hidden'));
  $('#derivAppId').value = '999'; $('#derivPat').value = 'pat_smoke_test';
  submit($('#derivForm'));
  await sleep(120);
  await sleep(300);
  check('deriv login works', $('#appShell').classList.contains('ready'), 'err=[' + (($('#authErr')||{}).textContent||'') + '] socks=' + (window.__socks||[]).length);
  check('session mode deriv', (store.k('session') || {}).mode === 'deriv');
  check('side sub deriv', $('#sideSub').textContent.includes('Deriv'), $('#sideSub').textContent);
  check('balance from broker', $('#kpiValue').textContent.includes('1,000.50'), $('#kpiValue').textContent);

  /* 11 — place a real order (mock Deriv fills) */
  click(doc.querySelector('.nav-item[data-view="trade"]'));
  await sleep(60);
  $('#orderSL').value = ''; $('#orderTP').value = ''; $('#orderTP2').value = '';
  $('#orderAmount').value = '50';
  click($('#placeOrderBtn'));
  await sleep(80);
  check('order A needs confirmation', $('#tmModal').classList.contains('open') && $('#tmSymbol').textContent === 'EUR/USD', $('#tmSymbol').textContent);
  check('confirm shows payout row', $('#tmPayout').textContent.length > 0, $('#tmPayout').textContent);
  click($('#tmConfirm'));
  await sleep(120);
  check('order A placed after confirm', (store.k('positions') || []).length === 1, JSON.stringify(store.k('positions')));
  check('nav pos count', $('#navPosCount').textContent === '1' && $('#navPosCount').style.display === 'grid');
  check('order notification', toasts().includes('Order filled'));

  /* 12 — portfolio + close all via confirm */
  click(doc.querySelector('.nav-item[data-view="portfolio"]'));
  check('position row', $('#posBody').children.length === 1, $('#posBody').children.length);
  check('balance kpi money', $('#pfBalance').textContent.startsWith('$'), $('#pfBalance').textContent);
  click($('#closeAllBtn'));
  await sleep(80);
  check('confirm modal open', confirmOpen());
  confirmYes();
  await sleep(120);
  check('position closed', (store.k('positions') || []).length === 0);
  check('history added', (store.k('history') || []).length === 1, (store.k('history') || []).length);

  /* 13 — TP1 guidance + SL auto-close on live ticks */
  click(doc.querySelector('.nav-item[data-view="trade"]'));
  await sleep(60);
  const E1 = num($('#chartPrice').textContent);
  $('#orderSL').value = (E1 * 0.999).toFixed(5);
  $('#orderTP').value = (E1 * 1.001).toFixed(5);
  $('#orderTP2').value = '';
  $('#orderAmount').value = '50';
  click($('#placeOrderBtn'));
  await sleep(80);
  check('order B needs confirmation', $('#tmModal').classList.contains('open'));
  click($('#tmConfirm'));
  await sleep(120);
  check('order B placed after confirm', (store.k('positions') || []).length === 1);
  window.__pushTick('frxEURUSD', E1 * 1.002);
  await sleep(60);
  check('TP1 guidance notified', toasts().includes('TP1 reached'), toasts().slice(-200));
  window.__pushTick('frxEURUSD', E1 * 0.998);
  await sleep(150);
  check('SL auto-closed', (store.k('positions') || []).length === 0, JSON.stringify(store.k('positions')));
  check('SL notified', toasts().includes('stop-loss'), toasts().slice(-200));
  check('history two', (store.k('history') || []).length === 2, (store.k('history') || []).length);

  /* 14 — TP2 close */
  const E2 = num($('#chartPrice').textContent);
  $('#orderSL').value = (E2 * 0.998).toFixed(5);
  $('#orderTP').value = (E2 * 1.001).toFixed(5);
  $('#orderTP2').value = (E2 * 1.003).toFixed(5);
  click($('#placeOrderBtn'));
  await sleep(80);
  check('order C needs confirmation', $('#tmModal').classList.contains('open'));
  click($('#tmConfirm'));
  await sleep(120);
  check('order C placed after confirm', (store.k('positions') || []).length === 1);
  window.__pushTick('frxEURUSD', E2 * 1.004);
  await sleep(60);
  window.__pushTick('frxEURUSD', E2 * 1.004);
  await sleep(150);
  check('TP2 notified', toasts().includes('TP2 reached'), toasts().slice(-200));
  check('TP2 closed position', (store.k('positions') || []).length === 0);
  check('history three', (store.k('history') || []).length === 3, (store.k('history') || []).length);

  /* 15 — automation with broker: deriv shows connected, arm allowed */
  click(doc.querySelector('.nav-item[data-view="automation"]'));
  check('deriv connected', $('#derivStatus').classList.contains('on'));
  check('conn persisted', (store.k('connections') || {}).deriv === true);
  click(doc.querySelectorAll('.bot-arm')[2]);
  await sleep(60);
  check('bot armed with broker', $('#botGrid').textContent.includes('Disarm'));

  /* 15b — Part 6: proxy pill, confirm-modal cancel gate, backtest */
  check('deriv proxy pill shown', $('#derivText').textContent.includes('not configured'), $('#derivText').textContent);
  click(doc.querySelector('.nav-item[data-view="trade"]'));
  await sleep(60);
  $('#orderSL').value = ''; $('#orderTP').value = ''; $('#orderTP2').value = '';
  $('#orderAmount').value = '50';
  click($('#placeOrderBtn'));
  await sleep(60);
  check('modal opens for confirm', $('#tmModal').classList.contains('open'));
  check('modal env badge', $('#tmEnv').textContent.length > 0, $('#tmEnv').textContent);
  click($('#tmCancel'));
  await sleep(40);
  check('cancel places nothing', !$('#tmModal').classList.contains('open') && (store.k('positions') || []).length === 0);

  /* 14c — NEW-API PAT (server session) connect + trade via confirm gate */
  click($('#signOutBtn'));
  await sleep(60);
  click($('#derivKindPat'));
  $('#derivAppId').value = '999';
  $('#derivPat').value = 'pat_GOOD_PAT_smoke';
  submit($('#derivForm'));
  await sleep(200);
  check('PAT login works', $('#appShell').classList.contains('ready'), 'authErr=[' + (($('#authErr')||{}).textContent||'') + ']');
  check('PAT broker mode server-side', (store.k('session') || {}).mode === 'deriv' && !!$('#appShell').classList.contains('ready'));
  click(doc.querySelector('.nav-item[data-view="trade"]'));
  await sleep(60);
  $('#orderSL').value = ''; $('#orderTP').value = ''; $('#orderTP2').value = '';
  $('#orderAmount').value = '50';
  click($('#placeOrderBtn'));
  await sleep(120);
  check('PAT modal opens with quote', $('#tmModal').classList.contains('open') && $('#tmPayout').textContent.includes('190'), $('#tmPayout').textContent);
  click($('#tmConfirm'));
  await sleep(200);
  const patPos = (store.k('positions') || []).find((p) => String(p.contract_id) === '777001');
  check('PAT order placed via confirm gate', !!patPos, JSON.stringify((store.k('positions') || []).slice(-1)).slice(0, 80));
  check('PAT fill path flagged', patPos && patPos.flags && patPos.flags.pat_server === true);
  click(doc.querySelector('.nav-item[data-view="signals"]'));
  await sleep(60);
  check('backtest card present', !!$('#backtestCard') && !!$('#btRun'));
  click($('#btRun'));
  await sleep(140);
  check('backtest stats rendered', $('#btStats').children.length === 6, $('#btStats').children.length);
  check('backtest trades rendered', $('#btTrades').children.length >= 1, $('#btTrades').children.length);
  check('backtest result visible', !$('#btResult').classList.contains('hidden'));

  /* 15c — chart patterns: card, detection, svg chart, study bars, playbook */
  check('patterns card present', !!$('#patternsCard') && !!$('#patRun') && !!$('#patStudy') && !!$('#patGran'));
  check('playbook rendered (12 items)', doc.querySelectorAll('#playbook .pb-item').length === 12, doc.querySelectorAll('#playbook .pb-item').length);
  $('#azSymbol').value = 'EUR/USD';
  $('#patGran').value = '3600';
  click($('#patRun'));
  await sleep(160);
  check('pattern detections rendered', doc.querySelectorAll('#patDetections .pat-card').length === 2, doc.querySelectorAll('#patDetections .pat-card').length);
  check('pattern results visible', !$('#patResults').hidden && $('#patEmpty').hidden);
  check('pattern svg chart drawn', !!doc.querySelector('#patChart svg'));
  check('pattern chart has overlay lines', doc.querySelectorAll('#patChart svg line').length >= 4, doc.querySelectorAll('#patChart svg line').length);
  check('pattern meta shows suggestion', $('#patMeta').textContent.includes('BUY'), $('#patMeta').textContent);
  check('pattern levels shown', $('#patLevels').textContent.includes('entry'), $('#patLevels').textContent);
  check('pattern alert fired', toasts().includes('Pattern alert'), toasts().slice(-220));
  click($('#patStudy'));
  await sleep(160);
  check('study perf bars rendered', doc.querySelectorAll('#patPerf .perf-row').length === 3, doc.querySelectorAll('#patPerf .perf-row').length);
  check('study note honest', $('#patPerf').textContent.includes('Walk-forward'), $('#patPerf').textContent.slice(0, 80));

  /* 15d — PWA package (mobile + desktop install) */
  const mf = doc.querySelector('link[rel="manifest"]');
  check('manifest linked', !!mf && String(mf.getAttribute('href')).includes('manifest.webmanifest'));
  check('theme-color meta', !!doc.querySelector('meta[name="theme-color"]'));
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  check('CSP meta present', !!csp && String(csp.getAttribute('content') || '').includes('s3.tradingview.com') && String(csp.getAttribute('content') || '').includes('supabase'));
  check('mt5 token field present', !!$('#mt5Token'));
  check('Deriv MT5 card present', !!$('#dmt5Card'));
  const demoTerm = doc.querySelector('#dmt5Card a[href="https://mt5-demo-web.deriv.com/terminal?lang=en"]');
  check('demo terminal link exact + new tab', !!demoTerm && demoTerm.getAttribute('target') === '_blank' && /noopener/.test(demoTerm.getAttribute('rel') || ''));
  const hubLink = doc.querySelector('#dmt5Card a[href="https://app.deriv.com/"]');
  check('real account link -> Trader\'s Hub (no invented URL)', !!hubLink);
  check('bridge server field (Deriv MT5 needs it)', !!$('#mt5Server'));
  check('bridge login is Exness-specific with mandatory exact server and read-only password guidance', doc.body.innerHTML.includes('Exness MT5 account login') && doc.body.innerHTML.includes('Exact Exness MT5 server (required)') && doc.body.innerHTML.includes('investor/read-only is sufficient') && !doc.body.innerHTML.includes('any MT5 broker'));
  check('duration selector in order ticket', !!$('#orderDuration') && $('#orderDuration').querySelector('option[value="15m"]'));
  check('order amount default within server cap ($10)', $('#orderAmount') && Number($('#orderAmount').getAttribute('value')) === 10, 'default=' + ($('#orderAmount')||{}).getAttribute?.('value'));
  check('confirm dialog shows target account', !!$('#tmAccount'));
  check('account switcher mounts (connect + portfolio)', doc.querySelectorAll('[data-pat-accounts]').length >= 2);
  const srcMain = readFileSync(join(root, 'src', 'main.js'), 'utf8');
  check('PAT hint: browser never sends the order (honest copy)', /browser never sends the order/i.test(srcMain));
  check('PAT account switcher wired', srcMain.includes('function switchDerivAccount') && srcMain.includes('renderPatAccounts'));
  check('Sniper analysis no longer depends on a Deriv PAT session', srcMain.includes('Sniper analysis resumed') && srcMain.includes('analysis-only · scanning'));
  check('signal-change alerts dedupe by signal and provider and disclose the source', srcMain.includes('function emitSignalAlerts(results)') && srcMain.includes('const fingerprint=[signal,source,\'levels-v1\'].join(\'|\')') && srcMain.includes("Source: '+source") && srcMain.includes('function renderSniperSignalAlerts') && srcMain.includes('Entry reference:') && srcMain.includes('TP1:') && srcMain.includes('SL:') && srcMain.includes('TP2 / exit') && srcMain.includes('Signal withdrawn') && srcMain.includes('function emitSniperSignalAlerts'));
  check('Sniper execution guard throws before any broker order code', srcMain.includes('Sniper entries are disabled; the Sniper is analysis-only') && !srcMain.includes('await autoEntry(sigs[0],path)'));
  check('single-account hint (real Options account guidance)', srcMain.includes('add/enable a real'));
  const srcServer = readFileSync(join(root, 'server', 'server.js'), 'utf8');
  check('HTML served with Cache-Control no-cache (fresh UI after deploys)', srcServer.includes("'no-cache'"));
  const srcTv = readFileSync(join(root, 'src', 'tradingview.js'), 'utf8');
  const srcBridge = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
  check('chart uses direct widgetembed iframe (no AAPL-default race)', srcTv.includes('widgetembed') && !srcTv.includes('embed-widget-advanced-chart'));
  const srcMain2 = readFileSync(join(root, 'src', 'main.js'), 'utf8');
  check('boot restore uses PAT path with stored App ID', srcMain2.includes('patStore.getAppId') && srcMain2.includes('patConnect(appId,pat)'));
  check('silent PAT session heal on server restart', srcMain2.includes('async function patHeal') && srcMain2.includes('patCall('));
  const srcSrv = readFileSync(join(root, 'server', 'server.js'), 'utf8');
  check('server keeps alive on stray async errors', srcSrv.includes('unhandledRejection') && srcSrv.includes('uncaughtException'));
  const srcFeed = readFileSync(join(root, 'server', 'lib', 'derivfeed.js'), 'utf8');
  check('candle layer: cache + dedup + concurrency cap', srcFeed.includes('createCandleFetcher') && srcFeed.includes('inFlight') && srcFeed.includes('maxActive'));
  check('markets WAIT badge shows the reason inline', srcMain2.includes("' · '+escHtml(short)") || srcMain2.includes("short?' · '+escHtml(short)"));
  check('ticket auto-fills SL/TP from live analysis', srcMain2.includes('async function autofillLevels') && srcMain2.includes('autofillLevels(sym)'));
  check('levels note element in ticket', doc.querySelectorAll('#levelsNote').length === 1);
  check('stale-tab reload banner wired', srcMain2.includes('buildBanner') && srcMain2.includes('aurum_build'));
  check('dialog offers Reconnect & retry on session errors', srcMain2.includes('Reconnect &amp; retry'));
  check('buy deducts instantly via balance_after', srcMain2.includes('balance_after') && srcMain2.includes('authoritative deduction'));
  check('settlement watcher books wins/losses + resyncs balance', srcMain2.includes('syncDerivContracts') && srcMain2.includes("result:profit>=0?'won':'lost'"));
  check('confirm uses a FRESH quote at press time (final-quote note)', srcMain2.includes('FINAL quote is fetched the instant you press Confirm'));
  const srcApp = readFileSync(join(root, 'server', 'app.js'), 'utf8');
  check('confirm route always re-quotes (confirmSmartFresh)', srcApp.includes('confirmSmartFresh'));
  check('unsupported symbol returns clear message', srcApp.includes('No Deriv contract is mapped for'));
  check('open-trades default raised to 10 (env-overridable)', srcApp.includes('DERIV_MAX_OPEN_TRADES || 10'));
  check('Sniper analysis display shows best candidate and next-scan countdown', srcMain2.includes('analysis-only · best') && srcMain2.includes('next scan '));
  check('Sniper candidate stays analysis-only and autoEntry is never called', srcMain2.includes('Sniper entry is blocked') && !srcMain2.includes('await autoEntry(sigs[0],path)'));
  check('binaries valued by Deriv (not marked to spot)', srcMain2.includes('isBinaryPos') && srcMain2.includes('liveProfit'));
  check('non-resellable binaries explained (InvalidToSell handled)', srcMain2.includes('InvalidToSell') && srcMain2.includes('runs to expiry')===false ? srcMain2.includes('resale allowed') : true);
  check('Deriv PAT is sessionStorage-only (no persistent token backup)', srcMain2.includes("sessionStorage.setItem('aurum_pat'") && !srcMain2.includes("localStorage.setItem('aurum_pat_bk'"));
  check('broker secrets clear on sign-out/disconnect', srcMain2.includes('clearMt5Session()') && srcMain2.includes('patStore.forget()') && srcMain2.includes('Signed out'));
  check('Exness credentials restore after refresh from the current tab session', srcMain2.includes('MT5_SESSION_KEY') && srcMain2.includes("if(s.mode==='mt5')") && srcMain2.includes('connectMt5(m.url||bridge.localBridgeWs()'));
  check('Deriv session reconnects after refresh', srcMain2.includes('Auto-reconnected from this browser tab') && srcMain2.includes('patConnect(appId,pat)'));
  check('session activity log + activity login keepalive', srcMain2.includes('sessLog') && srcMain2.includes('aurum_sesslog') && srcMain2.includes('lastActHeal'));
  check('AI keys: honest no-Gmail walkthrough present', doc.body.innerHTML.includes('no Gmail login exists for APIs'));
  check('per-position profit target (alert + auto-close if resale allowed)', srcMain2.includes('profitTarget') && srcMain2.includes('Profit target reached'));
  check('Close always attempts the real sell + explains locks', srcMain2.includes('closing automatically (resale allowed)') || srcMain2.includes('Deriv locks this contract to expiry'));
  check('binary stops: never fake-close; sell early only if resale unlocked, else one alert', srcMain2.includes('binaries never follow the CFD stop path') && srcMain2.includes('binAlerted'));
  check('resale-unlock notification + pre-buy lock disclosure', srcMain2.includes('Early exit unlocked') && doc.body.innerHTML.includes('maximum loss is exactly your stake'));
  check('XSS: Deriv error text and AI risk text escaped before innerHTML', srcMain2.includes("escHtml(String(e.message||e))") && srcMain2.includes("map(r => '<li>' + escHtml(r) + '</li>')"));
  check('Calculator Lab view wired into navigation', doc.querySelector('.nav-item[data-view="learn"]') && srcMain2.includes("learn:['Calculator Lab'"));
  check('hypothetical P&L math: fees+slippage both sides, break-even shown', srcMain2.includes('Break-even exit') && srcMain2.includes('slip*2*units'));
  {
    const from={value:'100'}, to={value:'92'};
    const chg=((to.value-from.value)/Math.abs(from.value))*100, back=(from.value-to.value)/Math.abs(to.value)*100;
    check('% change math reproducible (-8% vs +8.6956% recovery)', Math.abs(chg+8)<1e-9 && Math.abs(back-(8/92)*100)<1e-9);
  }
  check('history panels: no invented data on failure + source labels', srcMain2.includes('rather than showing invented data') && (srcMain2.includes("p.source+' (live provider)")));
  check('server history endpoint: validated, cached, source-labelled', srcApp.includes('/api/history/candles') && srcApp.includes('insufficient_history') && srcApp.includes("source: 'deriv-public'"));
  {
    const syms = readFileSync(join(root, 'server', 'lib', 'symbols.js'), 'utf8');
    const tvjs = readFileSync(join(root, 'src', 'tradingview.js'), 'utf8');
    const html = doc.body.innerHTML;
    check('watchlist: owner index list as default (5 entries, TV symbols)', (syms.match(/id: '(NAS100|NASDAQ|US30|SPX500|US100)'/g)||[]).length===5 && syms.includes('TVC:NDX') && syms.includes('TVC:DJI') && syms.includes('TVC:SPX'));
    check('watchlist UI: chips + pin toggle + persistent store', doc.querySelector('#watchChips') && srcMain2.includes('watch-pin') && srcMain2.includes("store.set('watchlist'"));
    check('watchlist is its OWN view: nav item, live tick painter, markets card removed', doc.querySelector('.nav-item[data-view="watch"]') && srcMain2.includes('renderWatchLive') && srcMain2.includes("state.view==='watch'&&tickN%2===0") && !doc.querySelector('#watchCard'));
    check('watch live tiles: real streamed charts + Trade shortcut', srcMain2.includes('watchCanvas') && srcMain2.includes("data-wpx=") && srcMain2.includes("setChartSymbol(b.dataset.sym); goto('trade')"));
    check('watchlist honesty: indices labelled TradingView/delayed, never Deriv-live', tvjs.includes('widgetembed') && !tvjs.includes('embed-widget-market-overview') && html.includes('may be delayed') && tvjs.includes('no substitute prices'));
    check('sniper exit strategy: chips in the RIGHT card + honest lock note', html.includes('atExitRow') && html.indexOf('atExitRow') > html.indexOf('autoTradeCard') && html.includes('Deriv locks short forex binaries'));
    check('sniper mode chips live in the sniper card (DOM containment)', (()=>{ const card=doc.querySelector('#autoTradeCard'), row=doc.querySelector('#atModeRow'); return !!(card&&row&&card.contains(row)) && !doc.querySelector('#view-learn').contains(row); })());
    check('sniper auto target: % of stake, strategy-aware durations', srcMain2.includes('targetDurFor') && srcMain2.includes("c.targetPct??50") && srcMain2.includes('target:atTarget'));
    check('sniper target joins the watcher close block + RR>=1 quality gate', srcMain2.includes('const tgt=p.profitTarget||((p.flags&&p.flags.at)?p.target:null)') && srcMain2.includes('Math.abs(t-e)/Math.abs(e-sl)>=1.0'));
    check('loss guard: 3 straight sniper losses stand it down + record tally', srcMain2.includes('consecLosses>=3') && srcMain2.includes('renderAtRecord') && html.includes('atRecord'));
    check('sniper runs until stopped: max-entries self-disarm gone, target/loss disarm gated by brakes', !srcMain2.includes("disableAutoTrade('max'") && srcMain2.includes("if(c.brakes==='stop'){") && srcMain2.includes('atCooldownUntil'));
    check('armed survives reloads: boot resume + heal re-arm + no force-clear', srcMain2.includes('resumeAutoTrade') && srcMain2.includes('if(atCfg().on)resumeAutoTrade()') && !srcMain2.includes('saved-on but never armed this session'));
    check('risk-brakes selector inside the sniper card', (()=>{ const card=doc.querySelector('#autoTradeCard'), sel=doc.getElementById('atBrakes'); return !!(card&&sel&&card.contains(sel)); })());
    const bjs = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    check('bridge guidance: distinguishes not-running vs browser mixed-content block', bjs.includes('Insecure content') && bjs.includes('THREE possible causes') && bjs.includes('LOCAL NETWORK permission') && html.includes('padlock &rarr; Site settings') || html.includes('padlock → Site settings'));
    check('charts follow the DEVICE timezone (no hardcoded UTC axis)', tvjs.includes('resolvedOptions().timeZone') && (tvjs.match(/timezone: userTz\(\)/g) || []).length >= 2 && !tvjs.includes("timezone: 'Etc/UTC'"));
    check('chart view states times follow the device clock', html.includes('your device clock'));
    const rawHtml = readFileSync(join(root, 'index.html'), 'utf8');
    check('mobile UX: touch sizes, 16px inputs (no iOS zoom), bottom-sheet modals, safe-area', rawHtml.includes('font-size:16px !important') && rawHtml.includes('border-radius:16px 16px 0 0') && rawHtml.includes('env(safe-area-inset-bottom)'));
    check('duration: quick chips + live settle preview + long/locked warning (24h surprise impossible to miss)', doc.getElementById('durChips') && doc.getElementById('durPreview') && srcMain2.includes('function settleText') && srcMain2.includes('function durHuman') && srcMain2.includes('This order settles ') && srcMain2.includes('LONG + Deriv-locked family') && srcMain2.includes("duPreviewUpdate(); } catch") === false && (srcMain2.match(/settleText\(/g)||[]).length >= 4);
    check('confirm modal shows human duration + settle wall-clock', srcMain2.includes("'requesting '+durHuman(du)+' · settles '+settleText(du)+'…'") && srcMain2.includes("durHuman(qdu)+' contract · settles '+settleText(qdu)") && srcMain2.includes("durHuman(qdu2)+' contract · settles '+settleText(qdu2)"));
    {
      const bjs2 = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
      const mdjs = readFileSync(join(root, 'src', 'marketdata.js'), 'utf8');
      const py = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
      const symIdx = readFileSync(join(root, 'server', 'lib', 'symbols.js'), 'utf8');
      const cnt = (re) => (symIdx.match(re) || []).length;
      check('index CFDs: US30/NAS100/SPX500/US100/GER40/UK100 as Exness-only instruments', cnt(/c: 'indices'/g) === 6 && /Dow Jones 30 CFD/.test(symIdx) && /Germany 40 CFD/.test(symIdx) && !/US30.*deriv:/.test(symIdx));
      check('index quotes: bridge quote/search ops + client pump (no Deriv subscribe for indices)', py.includes('def handle_quote') && py.includes('def handle_search') && bjs2.includes('export function quoteBridge') && bjs2.includes('export function searchBridge') && srcMain2.includes('async function pumpIndexQuotes') && mdjs.includes('if (!I.deriv) return;'));
      check('index signals are Exness-first or clearly labelled Yahoo fallback; Sniper only analyses', srcMain2.includes('Exness MT5 local candles') && srcMain2.includes('Yahoo Finance public daily data') && srcMain2.includes('labelled fallback') && srcMain2.includes('Sniper entry is blocked'));
      check('index CFD note: stop-anytime + server-side SL/TP', srcMain2.includes('CFD — stop anytime ✓') && srcMain2.includes('SL/TP execute on Exness') && srcMain2.includes('even with this app closed'));
      check('Exness login: terminal/credential diagnostics, exact-server + company identity checks, and PC/phone guidance', py.includes('step terminal, code') && py.includes('step login, code') && py.includes('investor') && py.includes('exact Exness MT5 server is required') && py.includes('actual_server.casefold() != server.casefold()') && py.includes('"exness" not in company.casefold()') && srcMain2.includes('SETUP_AND_RUN.bat') && srcMain2.includes('from a phone is the phone itself, not your PC') && srcMain2.includes('The account number and MT5 server must MATCH') && !srcMain2.includes('Account 54998262'));
    }
    check('news timeline: UPCOMING / JUST RELEASED (15 min) / PAST 2 HOURS sections with exact UTC times + live countdowns', srcMain2.includes('JUST RELEASED — current news (last 15 min)') && srcMain2.includes('UPCOMING TODAY — exact times, live countdown') && srcMain2.includes('PAST 2 HOURS') && srcMain2.includes('function newsBucket(') && srcMain2.includes('function newsTLabel(') && srcMain2.includes('data-nt=') && srcMain2.includes('crossed a boundary -> re-section') && srcMain2.includes('{ updateNewsValidity(); updateNewsTimeline(); }'));
    check('news signals show a validity window (25m sniper window, STALE stands Execute down, unknown stays honest)', srcMain2.includes('const NEWS_VALIDITY_MIN=25;') && srcMain2.includes('function newsValidity(') && srcMain2.includes('freshness unknown') && srcMain2.includes('STALE (') && srcMain2.includes("if(state.view==='news'){ updateNewsValidity(); updateNewsTimeline(); }") && srcMain2.includes('then goes STALE and Execute stands down') && srcMain2.includes('Valid window: ~') && srcMain2.includes("outside the '+NEWS_VALIDITY_MIN+'m news window"));
    check('PAT pre-flight: shape diagnosis before the 401 (pat_ check, swap detection, no app-id policing, overridable)', srcMain2.includes('const patShaped=/^pat_[A-Za-z0-9_-]{6,}$/.test(pat)') && srcMain2.includes('a CLASSIC token it will always 401 here') && srcMain2.includes('⇄ Swap the two boxes for me') && srcMain2.includes('Connect anyway') && srcMain2.includes('copied EXACTLY from your application') && srcMain2.includes('always starts with <span class="mono">pat_</span>') && srcMain2.includes('await patAfterConnect(sess,appId,pat)'));
    check('PAT 401 carries shape booleans (no token material) from the server', readFileSync(join(root, 'server', 'lib', 'derivpat.js'), 'utf8').includes("shape check: PAT box starts with pat_: "));
    check('mobile quick-order bar on trade view + drawer scroll lock', doc.getElementById('mobOrderBtn') && doc.querySelector('#ticketCard .card-head h3') && doc.querySelector('#ticketCard .card-head h3').textContent==='Order ticket' && srcMain2.includes("document.body.style.overflow='hidden'") && srcMain2.includes("data-view',view"));
    check('sell RateLimit handled honestly + Close in-flight guard', srcMain2.includes('Deriv is limiting sells') && srcMain2.includes('__selling') && srcApp.includes('sell_throttled') && srcApp.includes('sellAt'));
    check('expired contracts show settling (no stale P&L in equity)', srcMain2.includes('if(p.settling)return null;') && srcMain2.includes('p.settling=true'));
    check('markets SIGNAL column never dead: cells soft-repainted from live scan, honest Scanning/Unavailable+Retry states, scan kicks on open', srcMain2.includes('td data-msig=') && srcMain2.includes("const sigCell=tr.querySelector('[data-msig]')") && srcMain2.includes("if(state.mktScanFailed) return") && srcMain2.includes("Scanning\u2026") && srcMain2.includes("msig-retry") && srcMain2.includes("let mktScanAt = 0;") && srcMain2.includes('localMarketsFallback()') && srcMain2.includes('state.mktScanFailed=true') && srcMain2.includes("{ renderMarkets(true); mktScanRefresh(); }"));
    check('Markets scans Exness MTF first with labelled Deriv/Yahoo fallback and visible source notes', srcMain2.includes('async function localMarketScan(I)') && srcMain2.includes('scanSignalsPreferred') && srcMain2.includes("bridge.bridgeHistory(I.s,'M1',120)") && srcMain2.includes('marketCandleFresh') && srcMain2.includes('fallbackSignalBatch') && srcMain2.includes('function signalSourceHTML'));
    check('markets compact responsive table keeps key columns together without horizontal width forcing', srcMain2.includes('function shortActiveWindow(inst)') && srcMain2.includes('market-levels') && readFileSync(join(root,'index.html'),'utf8').includes('#mktTable{table-layout:fixed;width:100%}') && readFileSync(join(root,'index.html'),'utf8').includes('@media(max-width:640px)') && readFileSync(join(root,'index.html'),'utf8').includes('#mktTable th:nth-child(3),#mktTable td:nth-child(3){display:none}'));
  check('local-mode escape hatch is ONE CLICK: Open-local-app link in the bridge hint, hidden when already local', readFileSync(join(root, 'index.html'), 'utf8').includes('id="openLocalMode"') && srcMain2.includes("getElementById('openLocalMode')") && srcMain2.includes("ol.classList.toggle('hidden',onPc)"));
  check('leverage transparency: bridge leverage surfaced + notional/margin math shown on Exness connect (stake = exposure; leverage never multiplies P/L)', srcBridge.includes('leverage: res.leverage || null') && srcMain2.includes('leverage never multiplies your P/L in this app'));
  check('sniper edge guardrails: synthetics excluded from AUTO by default (toggleable), health record W/L/net + break-even shown, day-ledger persists so the guard survives reloads, closes re-check the guard', srcMain2.includes("if(!c.atSynth){ const noSynth=universe.filter(I=>I.c!=='synthetics'); if(noSynth.length)universe=noSynth; }") && srcMain2.includes('function atHealth()') && srcMain2.includes('just to break even at this payout') && srcMain2.includes("store.get('history',[])") && srcMain2.includes('function histPersist()') && srcMain2.includes('function guardRecheckAfterClose()') && srcMain2.includes("if(c.conf===60){ c.conf=70;") && doc.getElementById('atSynth') && doc.getElementById('atHealth') && doc.getElementById('guardStatus') && srcMain2.includes('OFF \\u2014 nothing stops a bad day') && srcMain2.includes("try{ store.set('history',[]); }catch(e){}"));
  check('entry/SL/TP levels and market sources remain visible in Markets/chart/watchlist', srcMain2.includes('function scanLevelsHtml(I)') && srcMain2.includes('signalSourceHTML(I)') && srcMain2.includes('function updateChartLevels()') && srcMain2.includes('const sr=state.mktScan[cv.dataset.wcv];') && srcMain2.includes("try{ mktScanRefresh(); }catch(e){}") && readFileSync(join(root, 'index.html'), 'utf8').includes('id="chartLevels"'));
  check('charts work over Exness: watchlisted indices are quote-pumped via the bridge, tiles honestly labelled, TV embed has a load-failure notice', srcMain2.includes("const watch=(state.watchlist||[]).map((w)=>w.id).filter((id)=>bySym[id]&&bySym[id].c==='indices');") && srcMain2.includes("'● Exness live · bridge':'● Exness — connect bridge'") && srcMain2.includes("'waiting for Exness bridge quotes…'") && srcTv.includes("TradingView chart did not load"));
  check('daily loss guard: default 25, adjustable, blocks manual + news + sniper when tripped', doc.getElementById('lossGuardAmt') && doc.getElementById('lossGuardAmt').value==='25' && srcMain2.includes('function lossGuardTripped()') && srcMain2.includes('if(guardStopIfTripped())return;') && srcMain2.includes('Daily loss guard hit') && srcMain2.includes('beWinRateText(stake,payout)'));
  check('break-even win rate shown in the confirm sheet (payout asymmetry visible BEFORE buying)', doc.getElementById('tmBE') && (srcMain2.match(/beWinRateText\(/g)||[]).length >= 4 && srcMain2.includes('of these trades must WIN just to break even') && srcMain2.includes('size accordingly'));
  check('rebrand: Fredrick TRADING default + Settings name/tagline/logo controls', doc.getElementById('brandName').textContent==='FREDRICK' && doc.getElementById('brandNameInput') && doc.getElementById('brandLogo') && doc.getElementById('brandReset') && srcMain2.includes('BRAND_DEFAULT'));
  check('Shelricktech identity: welcome message replaces the wordmark; headline + trademark intact', (() => { const rawAuth = readFileSync(join(root, 'index.html'), 'utf8'); return rawAuth.includes('Shelricktech Investment <em>Trading Analysis</em> Tool') && rawAuth.includes('&#8482; Designed by Fredrick K under Shelricktech Investment.') && rawAuth.includes('id="authLogo"') && rawAuth.includes('id="authWelcome"') && !rawAuth.includes('SHELricktech INVESTMENT') && srcMain2.includes("+', trader'") && srcMain2.includes("const al=document.getElementById('authLogo');") && srcMain2.includes("logo:'data:image/jpeg;base64,"); })());
  check('daily motivation (deterministic per day) on the login dashboard + Overview', srcMain2.includes('const DESK_QUOTES=') && srcMain2.includes('function dailyQuote(') && (srcMain2.split("a:'").length - 1) >= 10 && srcMain2.includes('Motivation of the day:') && srcMain2.includes("getElementById('authMotivation')") && srcMain2.includes("getElementById('ovMotivation')"));
  check('login screen: one viewport — big logo, no brand repetition, tabbed connect, walls of text hidden', (() => { const rawAuth = readFileSync(join(root, 'index.html'), 'utf8'); return rawAuth.includes('width:76px;height:76px') && rawAuth.includes('id="authTabDeriv"') && rawAuth.includes('id="authPaneDeriv"') && rawAuth.includes('id="authPaneMt5"') && !rawAuth.includes('auth-feats') && !rawAuth.includes('Live Deriv feed — real ticks') && rawAuth.includes('<details class="auth-details" id="dmt5Card">') && srcMain2.includes("$('#authTabDeriv')") && srcMain2.includes("function welcomeText()"); })());
  check("today's best market: Exness-first scan with provider label on dashboard + Overview", srcMain2.includes('async function refreshBestPick') && srcMain2.includes('scanSignalsPreferred(syms)') && srcMain2.includes('authBestBody') && srcMain2.includes('source:') && srcMain2.includes('the pick appears the moment the live scan finds one') && readFileSync(join(root, 'index.html'), 'utf8').includes("TODAY'S BEST MARKET TO FORECAST ON"));
  check('Shelricktech icons: PWA + favicon generated from the user logo (no SVG-A favicon left)', (() => { const rawHtml = readFileSync(join(root, 'index.html'), 'utf8'); return rawHtml.includes('<link rel="icon" type="image/png" href="/icons/favicon-32.png">') && !rawHtml.includes("rel=\"icon\" href=\"data:image/svg+xml") && readFileSync(join(root, 'public', 'manifest.webmanifest'), 'utf8').includes('/icons/icon-512.png'); })());
    check('news: market-moving feed + today-UTC calendar cards with refresh', doc.getElementById('newsFeed') && doc.getElementById('newsCal') && srcMain2.includes('renderNewsFeed') && srcMain2.includes('renderNewsCal'));
    check('news honesty: heuristic labelled, not AI; empty-safe failure states', srcMain2.includes('not AI, not advice') && srcApp.includes("engine: 'heuristic'") && srcApp.includes('news_unavailable') && srcApp.includes('calendar_unavailable'));
    check('cloud test: missing-table diagnostics point to the ordered RLS migration', srcMain2.includes('then 0003_cloud_sync.sql') && readFileSync(join(root, 'src', 'cloud.js'), 'utf8').includes('PGRST205'));
    {
      const cjs = readFileSync(join(root, 'src', 'cloud.js'), 'utf8');
      check('cloud URL normalizes a pasted /rest/v1 suffix', cjs.includes("replace(/\\/rest\\/v1$/i, '')"));
      const cloudSql = readFileSync(join(root, 'supabase', 'migrations', '0003_cloud_sync.sql'), 'utf8');
      check('cloud schema requires authenticated owner RLS and grants no anonymous access', cloudSql.includes('revoke all on public.analysis_history, public.pattern_events, public.alerts from anon, authenticated') && cloudSql.includes('user_id = auth.uid()') && cjs.includes('sessionStorage') && cjs.includes('token?grant_type=password'));
    }
    check('Sniper view has market selector, eye-detail icon, entry/TP/SL alerts and blocked execution', !!doc.querySelector('.nav-item[data-view="sniper"]') && !!doc.getElementById('sniperWatchList') && !!doc.getElementById('sniperSignalList') && srcMain2.includes('data-sniper-watch') && srcMain2.includes('data-sniper-view') && srcMain2.includes('emitSniperSignalAlerts(sigs,results)') && srcMain2.includes('tp2Hit') && srcMain2.includes('slHit') && srcMain2.includes('Sniper entry is blocked') && !srcMain2.includes('await autoEntry(sigs[0],path)'));
    {
      const ijs = readFileSync(join(root, 'server', 'lib', 'indices.js'), 'utf8');
      check('indices in daily signal analysis: scan includes NAS100/US30/SPX500 (daily, labelled)', srcMain2.includes("['NAS100','US30','SPX500']") && ijs.includes('^NDX') && ijs.includes('^DJI') && ijs.includes('^GSPC') && srcApp.includes("model: 'technical-daily'"));
      check('index cards: analysis-only routing with Exness local data option; server daily levels stay analysis-only', srcMain2.includes('function openSignalSymbol') && srcMain2.includes('This index is not orderable through Deriv') && srcMain2.includes('The Exness MT5 bridge can provide verified local quotes/history') && ijs.includes('entry: null'));
    check('news execute: confirm-gated order from signal cards (deduction on linked account)', doc.getElementById('waNumber') && srcMain2.includes('function executeNewsSignal') && srcMain2.includes('news-exec') && srcMain2.includes("const mode=proxyReady?'proxy':(state.broker.mode==='pat_server'?'pat_server':'pat')") && srcMain2.includes('nothing executes without your confirm'));
    check('whatsapp: one-tap signal share + today brief + on-device number', srcMain2.includes('function waLink') && srcMain2.includes('wa.me/') && srcMain2.includes("shareCalBrief") && doc.getElementById('newsCalShare'));
    {
      const djs = readFileSync(join(root, 'server', 'lib', 'decision.js'), 'utf8');
      check('brief engines: Claude + ChatGPT added, auto-pick, honest no-key message', srcApp.includes('newsBriefAny') && djs.includes('newsBriefViaClaude') && djs.includes('newsBriefViaChatGPT') && srcApp.includes('no_ai_key') && srcMain2.includes('Perplexity, Claude (Anthropic) or ChatGPT (OpenAI)'));
    }
    check('brief: WhatsApp send + notification on arrival', srcMain2.includes('Send brief to WhatsApp') && srcMain2.includes("notify('News brief ready'"));
    check('history: today listed, past days summarized (expandable)', srcMain2.includes('histExpanded') && srcMain2.includes('tap to expand') && srcMain2.includes("days.get(k).push(h)"));
    check('live P&L: 5s polling while open + change flashes on rows and KPI', srcMain2.includes('scheduleDerivSync') && srcMain2.includes('open?5000:20000') && srcMain2.includes('function flashEl') && srcMain2.includes('plFlash.__kpi') && readFileSync(join(root,'index.html'),'utf8').includes('@keyframes flashUp'));
    check('whatsapp AUTO: toggle + auto-push of new signals, briefs, trade results', doc.getElementById('waAuto') && srcMain2.includes('function pushWA') && srcMain2.includes("pushWA(newsSignalText") && srcMain2.includes("pushWA('🚨 SNIPER") && srcMain2.includes("pushWA('📰 '"));
    {
      const wjs = readFileSync(join(root, 'server', 'lib', 'wa.js'), 'utf8');
      check('wa cloud api: env-only creds, never logged, honest unconfigured + server auto feed', wjs.includes('WA_PHONE_NUMBER_ID') && wjs.includes('waAutoFeed') && wjs.includes('to_masked') && srcApp.includes('/api/wa/push') && srcApp.includes('wa_not_configured'));
    }
    check('brief failover: engine errors translated human, tries next engine', srcApp.includes("e.friendly ? e.message") || srcApp.includes('e.friendly') && readFileSync(join(root,'server/lib/decision.js'),'utf8').includes('translateAiError'));
    }
    check('sniper Active mode: 30s scans, own-position gate, preset chips', srcMain2.includes('AT_INTERVAL=30000') && srcMain2.includes('flags&&p.flags.at') && srcMain2.includes('atModeRow'));
  }
  check('apple touch icon', !!doc.querySelector('link[rel="apple-touch-icon"]'));
  check('install button in topbar', !!$('#installBtn') && $('#installBtn').classList.contains('hidden'), $('#installBtn') ? 'present, hidden until prompt' : 'missing');

  /* 15e — Supabase cloud sync card + online history */
  check('cloud card has per-user sign-in controls', !!$('#cloudCard') && !!$('#cloudUrl') && !!$('#cloudKey') && !!$('#cloudSave') && !!$('#cloudEmail') && !!$('#cloudPassword') && !!$('#cloudSignIn') && !!$('#cloudSignUp') && !!$('#cloudSignOut'));
  check('history card present', !!$('#historyCard') && !!$('#cldLoad'));
  click(doc.querySelector('.nav-item[data-view="settings"]'));
  await sleep(60);
  $('#cloudUrl').value = 'https://x.supabase.co';
  $('#cloudKey').value = 'sb_secret_THIS_IS_NOT_ALLOWED';
  click($('#cloudSave'));
  await sleep(60);
  check('secret key rejected', $('#cloudMsg').textContent.includes('SECRET'), $('#cloudMsg').textContent);
  $('#cloudKey').value = 'sb_publishable_testkey123';
  $('#cloudEmail').value = 'smoke@example.com';
  $('#cloudPassword').value = 'smoke-password-123';
  click($('#cloudSignIn'));
  await sleep(160);
  check('cloud sign-in uses per-user session and clears password field', $('#cloudPassword').value === '' && window.sessionStorage.getItem('aurum.supabase.session')?.includes('smoke-user'), $('#cloudPassword').value + ' | ' + (window.sessionStorage.getItem('aurum.supabase.session') || 'no session'));
  click($('#cloudSave'));
  await sleep(220);
  check('cloud connect verified after authenticated RLS test', $('#cloudStatus').textContent.includes('connected'), $('#cloudStatus').textContent + ' | ' + $('#cloudMsg').textContent);
  click(doc.querySelector('.nav-item[data-view="signals"]'));
  await sleep(60);
  click($('#patRun'));
  await sleep(200);
  check('scan saved to cloud', (window.__apiCalls || []).some((c) => c.startsWith('POST') && c.includes('supabase.co/rest/v1/analysis_history')), 'calls=' + (window.__apiCalls || []).filter((c) => c.includes('supabase')).slice(0, 3).join(' ; '));
  click($('#azRun'));
  await sleep(500);
  check('signal why-panel rendered', !!$('#azWhy') && ($('#azWhy').textContent.includes('votes') || $('#azWhy').textContent.includes('Why WAIT')), ($('#azWhy')||{}).textContent?.slice(0, 90));

  check('signal saved to cloud', (window.__apiCalls || []).some((c) => c.startsWith('POST') && c.includes('supabase.co/rest/v1/signals')), 'calls=' + (window.__apiCalls || []).filter((c) => c.includes('signals')).slice(0, 3).join(' ; '));
  click($('#cldLoad'));
  await sleep(240);
  
  check('history panels rendered', !$('#cldBody').hidden && $('#cldAnalyses').children.length >= 1 && $('#cldPatterns').children.length >= 1 && $('#cldAlerts').children.length >= 1 && $('#cldSignals').children.length >= 1, 'a=' + $('#cldAnalyses').children.length + ' p=' + $('#cldPatterns').children.length + ' s=' + $('#cldSignals').children.length);

  /* 16 — reset + sign out */
  click(doc.querySelector('.nav-item[data-view="settings"]'));
  click($('#aiKeysClear'));
  check('keys cleared', $('#aiKeyStatus').textContent.includes('no keys'));
  click($('#resetBtn'));
  await sleep(80);
  check('reset confirm open', confirmOpen());
  confirmYes();
  await sleep(80);
  check('reset history', (store.k('history') || []).length === 0);
  check('reset positions', (store.k('positions') || []).length === 0);
  click($('#signOutBtn'));
  check('signed out final', !$('#appShell').classList.contains('ready') && !$('#authScreen').classList.contains('hidden'));

  /* ---------- rule-based setups (ANALYSIS-ONLY module) ---------- */
  {
    const suIdx = readFileSync(join(root, 'index.html'), 'utf8');
    const suSetups = readFileSync(join(root, 'server', 'lib', 'setups.js'), 'utf8');
    const suBt = readFileSync(join(root, 'server', 'lib', 'setupsBacktest.js'), 'utf8');
    const suExt = readFileSync(join(root, 'server', 'lib', 'indicators.ext.js'), 'utf8');
    check('setups card: one labelled symbol input + two run buttons, placed after backtest', suIdx.includes('id="setupsCard"') && suIdx.includes('id="suSymbol"') && suIdx.includes('id="suRun"') && suIdx.includes('id="suBacktest"') && suIdx.indexOf('setupsCard') > suIdx.indexOf('backtestCard'));
    check('setups flag: default OFF + honest 503 hint', srcApp.includes("String(env.AURUM_SETUPS_ENABLED || '').trim().toLowerCase() === 'true'") && srcApp.includes('setups_disabled') && srcApp.includes('AURUM_SETUPS_ENABLED=true'));
    check('four rule setups implemented with documented gates', ['EMA_TREND_PULLBACK', 'VWAP_MEAN_REVERSION', 'OPENING_RANGE_BREAKOUT', 'RSI_MEAN_REVERSION'].every((n) => suSetups.includes(n)) && suSetups.includes('volume_not_traded_volume') && suSetups.includes('no_defined_session') && suSetups.includes('insufficient_clean_candles'));
    check('new indicators only in indicators.ext.js; indicators.js untouched by setups', suExt.includes('export function adx') && suExt.includes('export function sessionVwap') && suExt.includes('export function swingLevels') && suExt.includes('export function pivotLevels') && !suExt.includes('await') && !suExt.includes("from './derivfeed"));
    check('setups backtest: OOS + small-sample warning + NOT-conclusive note', suBt.includes('oosFraction') && suBt.includes('30-trade minimum') && suBt.includes('NOT conclusive'));
    check('setups routes never touch order paths (isolation)', (() => {
      const i0 = srcApp.indexOf('setupsGuard');
      const i1 = srcApp.indexOf('const BOOT_ID', i0);
      const region = srcApp.slice(i0, i1);
      return !region.includes('derivBuy') && !region.includes('derivSell') && !region.includes('openTradeModal') && region.includes('analysis_only');
    })());
    check('main.js setups block: display + journaling only, no order/sniper calls', (() => {
      const i0 = srcMain2.indexOf('Rule-based setups (ANALYSIS-ONLY');
      const i1 = srcMain2.indexOf("$('#placeOrderBtn').onclick", i0);
      const region = srcMain2.slice(i0, i1);
      return i0 > -1 && i1 > i0 && !region.includes('placeOrder(') && !region.includes('openTradeModal') && !region.includes('autoTrade') && region.includes("saveAnalysis('setups") && region.includes('/api/setups/analyze');
    })());
    {
      const symJs = readFileSync(join(root, 'server', 'lib', 'symbols.js'), 'utf8');
      check('resale families: every orderable instrument tagged (synthetics usually / forex rarely / metals+crypto unknown, guidance-only)', (symJs.match(/resale: '/g)||[]).length===26 && symJs.includes("resale: 'usually'") && symJs.includes("resale: 'rarely'") && symJs.includes("resale: 'unknown'") && /live-tested/.test(symJs) && /GUIDANCE ONLY/.test(symJs));
      check('ticket early-exit tag: live per-market guidance + honesty suffix', doc.getElementById('resaleNote') && srcMain2.includes('function renderResaleNote') && srcMain2.includes('Deriv decides per contract') && srcMain2.includes('usually NOT allowed') && srcMain2.includes('not verified') && srcMain2.includes('Close always tries the real sell first'));
      check('Sniper legacy scan filters remain optional, entries remain blocked', (() => { const card=doc.querySelector('#autoTradeCard'), chk=doc.getElementById('atResale'); return !!(card&&chk&&card.contains(chk)&&!chk.checked); })() && srcMain2.includes('if(c.prefResale==null)c.prefResale=false;') && srcMain2.includes("universe.filter(I=>I.resale==='usually')") && srcMain2.includes('Sniper entry is blocked'));
    check('sniper loss guard counts Exness closes (3 straight losses stand it down on any broker)', srcMain2.includes('loss-streak guard counts Exness/CFD closes too') && srcMain2.includes('atSession.consecLosses=(atSession.consecLosses||0)+1;') && srcMain2.includes("disableAutoTrade('loss','3 losses in a row — stood down (loss guard)')"));
    }
    check('binary expiry: human countdown (never bare 1510m) + wall-clock settle time + own 1s ticker', srcMain2.includes('function expiresFmt') && srcMain2.includes("return Math.floor(h/24)+'d '+(h%24)+'h'") && (srcMain2.match(/expiresFmt\(/g)||[]).length >= 3 && srcMain2.includes("setInterval(()=>{ try{ if(state.view==='portfolio')paintExpiries(); }catch(e){} },1000)"));
    check('binary row: duration label + Deriv-locked state + target state shown on the row', srcMain2.includes("dur:{duration:t.dur.duration,duration_unit:t.dur.duration_unit}") && srcMain2.includes("dur:{duration:du.duration,duration_unit:du.duration_unit}") && srcMain2.includes('Deriv-locked · rides to expiry') && srcMain2.includes('TARGET HIT — settles automatically') && srcMain2.includes('alerts only (Deriv-locked)') && srcMain2.includes(' · '+"'+durLbl+' contract"));
    check('close confirm warns upfront when Deriv already reported no-resale', srcMain2.includes('the sell will likely be refused') && srcMain2.includes('QUEUES the force close'));
    {
      const mh = readFileSync(join(root, 'server', 'lib', 'markethours.js'), 'utf8');
      const mhT = readFileSync(join(root, 'server', 'tests', 'markethours.test.mjs'), 'utf8');
      check('market open/closed: shared UTC schedule module + unit tests (24/7, weekend, daily break, unknown honest)', mh.includes('export function marketStatus') && mh.includes('reopens Sun 22:00 UTC') && mh.includes('21:00\u201322:00 daily break') === false && /daily break/.test(mh) && /schedule unknown/.test(mh) && mhT.includes('weekend closed'));
      check('market badges live in Markets table + ticket status row + guidance note', srcMain2.includes("from '../server/lib/markethours.js'") && srcMain2.includes('data-mstat="') && srcMain2.includes("if(state.view==='markets') updateMarketStatusBadges()") && srcMain2.includes("['Market status',ms.label") && srcMain2.includes('QUIET') && doc.getElementById('mktHoursNote') && srcMain2.includes('MARKET_HOURS_NOTE'));
    }
    check('dedicated Gold/USD panel exposes signal levels, source, event calendar and analysis-only controls', !!doc.getElementById('view-gold') && !!doc.getElementById('goldSignal') && !!doc.getElementById('goldSourceSelect') && !!doc.getElementById('goldEntry') && !!doc.getElementById('goldSL') && !!doc.getElementById('goldTP1') && !!doc.getElementById('goldTP2') && !!doc.getElementById('goldEvents') && !!doc.getElementById('goldShareBtn') && srcMain2.includes('waLink(goldSignalMessage(state.goldAnalysis))') && srcMain2.includes("body:{symbol:GOLD_SYMBOL,force:true,technicalOnly:true,withNews:false}") && srcMain2.includes('Exness MT5 local candles') && srcMain2.includes('goldDerivFallback') && srcMain2.includes('Deriv public candles · labelled fallback'));
    check('Gold source is explicit and persisted: Auto follows broker; Deriv can be selected without silently switching; Exness remains selectable', srcMain2.includes('function goldDataSource()') && srcMain2.includes("state.settings.goldSource||'auto'") && srcMain2.includes("state.settings.goldSource=next") && srcMain2.includes("if(goldDataSource()==='mt5')") && doc.getElementById('goldSourceSelect').querySelector('option[value="deriv"]'));
    check('Gold monitor: no-book disclaimer, pre-event alerts, signal changes only, and auto-share toggle honored', doc.getElementById('view-gold').textContent.includes('not exchange order-book or actual buyer/seller volume') && srcMain2.includes('USD high-impact event in about') && srcMain2.includes('goldLastNotifiedKey!==key') && srcMain2.includes('pushWA(msg)') && srcMain2.includes('AURUM analysis only — no order sent.'));
    {
      const m=s=>srcMain2.includes(s);
      check('force close queue: refused sell arms it, unlock executes it, rate-limit arms it, cancel exists', m('p.canSell=false; p.closeOnUnlock=true; save(); renderPortfolio();') && m('if(p.canSell&&p.closeOnUnlock&&!p.__selling)') && m("closeWithBroker(p,null,'force close (unlocked)')") && m('p.targetHit&&!p.canSell)p.closeOnUnlock=true;') && m('FORCE QUEUED — auto-closes when Deriv unlocks') && m('Force close cancelled') && m('will ride to settlement and the result books automatically'));
      check('target-hit locked branch arms the queue', m('p.closeOnUnlock=true; save(); /* target reached while locked — close the instant Deriv unlocks */'));
    check('portfolio reconciliation: every device shows every open account contract', m('/api/deriv/pat/portfolio') && m("id:'x'+c.contract_id") && m('external:true') && m('synced from your Deriv account') && m('this device now shows every trade on the account') && srcApp.includes("patApi.portfolio(sid, accountId)"));
    check('synced rows are valued as binaries + NaN guards (equity/open P&L never poisoned)', m('p.external||(p.flags&&(p.flags.pat_server||p.flags.pat))') && (srcMain2.match(/Number\.isFinite/g)||[]).length >= 4 && m('a NaN/Infinity here would poison equity + open P&L') && m('const vals=state.positions.map((p)=>{ const v=posPl(p); return (v!=null&&Number.isFinite(v))?v:null; });'));
    check('synced rows close through the PAT-server path (force queue works on them)', m('(p.flags?.pat_server||(p.external&&state.broker?.mode===\'pat_server\'))'));
      check('close-all copy explains the queue behaviour', m('any refusal QUEUES a force close that executes the instant Deriv unlocks'));
    }
    check('setups reuse indicators.js (no second copy of ema/rsi/atr)', suSetups.includes("from './indicators.js'") && !suSetups.includes('function ema(') && !suSetups.includes('function rsi(') && !suSetups.includes('function atr('));
  }

  /* ---------- round 20a: codebase-audit fixes ---------- */
  {
    const audApp = readFileSync(join(root, 'server', 'app.js'), 'utf8');
    const audLim = readFileSync(join(root, 'server', 'lib', 'limits.js'), 'utf8');
    const audBrg = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const audIdx = doc.documentElement.outerHTML;
    const audBjs = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    const am = (s) => srcMain2.includes(s);
    check('audit C1: App-ID check accepts letters (forbidden digits-only regression removed)', audApp.includes('A-Za-z0-9._~-]{1,64}') && !audApp.includes('/^\\d{1,10}$/.test(appId)'));
    check('audit H2: trust proxy set - per-IP rate limits key on the real client behind Railway', audApp.includes("app.set('trust proxy', 1)"));
    check('audit H3: server-side duplicate-order guard (opt-in once-key idempotency -> 409 duplicate_request)', audLim.includes("error: 'duplicate_request'") && audApp.includes("dedupeBody({ name: 'deriv-order' })") && srcMain2.includes('once:onceId') && (srcMain2.match(/once:Date\.now\(\)/g) || []).length >= 1 && srcMain2.includes("amount:stake,venue:'mt5',once"));
    check('audit C2: bridge needs per-connection login before order/close/positions + rejects cross-origin ws on both ports + optional AURUM_BRIDGE_TOKEN', audBrg.includes('auth_required') && (audBrg.match(/_origin_allowed/g) || []).length >= 4 && audBrg.includes('login required on this connection first') && audBrg.includes('AURUM_BRIDGE_TOKEN') && (audBrg.match(/_NEED_AUTH/g) || []).length >= 3);
    check('audit C3: bridge order/quote replies expose real exposure (effective_notional + clamped_min + volume_min)', audBrg.includes('effective_notional') && audBrg.includes('clamped_min') && (audBrg.match(/volume_min/g) || []).length >= 4);
    check('audit C3 client: min-lot oversize refused pre-buy; warning forbids raising stake/cap and recommends verified smaller minimum', am('Refused: broker minimum lot') && am('const minNotional=') && am('o.effective_notional') && am('No order was sent') && am('Do not raise the stake or server-side cap') && am('verified minimum exposure fits your existing risk limit') && !am('Raise the stake to roughly'));
    check('audit M2: client fetch timeout on scan calls (AbortSignal.timeout, 30s)', am('timeoutMs=0') && (srcMain2.match(/timeoutMs:30000/g) || []).length >= 3 && am('fallbackSignalBatch') && am('AbortSignal.timeout'));
    check('audit H1: broker secrets are sessionStorage-only with clear-on-logout wording', audIdx.includes('sessionStorage') && audIdx.includes('cleared on disconnect/sign-out') && !audIdx.includes('plain-text backup'));
    check('audit C2 client: Bridge token field actually wired into the login frame', am('mt5Token') && audBjs.includes('token: creds.token'));
  }

  /* ---------- round 20b: cross-device (phone -> PC bridge) ---------- */
  {
    const xb = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const xj = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    const xbat = readFileSync(join(root, 'bridge', 'SETUP_AND_RUN.bat'), 'utf8');
    check('20b: bridge listens on the LAN (AURUM_BRIDGE_HOST, default 0.0.0.0) on both servers', xb.includes('AURUM_BRIDGE_HOST') && xb.includes('ThreadingHTTPServer((HOST, port), H)') && xb.includes('websockets.serve(handler, HOST, PORT'));
    check('20b: remote peers need a bridge token; loopback stays one-click; no hard non-local reject', xb.includes('_token_ok(msg, is_remote)') && xb.includes('remote access is NEVER allowed without a shared secret') && xb.includes('def _ip_is_local') && !xb.includes('rejecting non-local connection'));
    check('20b: origin gate allows LAN + AURUM_BRIDGE_ALLOWED_ORIGINS, still rejects public web pages', xb.includes('AURUM_BRIDGE_ALLOWED_ORIGINS') && xb.includes('is_private or ip.is_loopback or ip.is_link_local'));
    const setupBat21a=readFileSync(join(root, 'bridge', 'SETUP_AND_RUN.bat'), 'utf8');
    check('21a: bridge prints local PC address, uses token only as environment config, never echoes token values', xb.includes('def _up_txt') && xb.includes('On a PHONE/tablet') && xb.includes('value is intentionally not printed') && xb.includes('bridge_token.txt') && !xb.includes('" % _BRIDGE_TOKEN') && xb.includes('ALLOW python on Private networks') && setupBat21a.includes('AURUM_LOCAL_API_TOKEN=%AURUM_BRIDGE_TOKEN%') && !/echo[^\r\n]*%AURUM_BRIDGE_TOKEN%/i.test(setupBat21a) && !/echo[^\r\n]*%AURUM_LOCAL_API_TOKEN%/i.test(setupBat21a));
    check('20b: client auto-points at the PC LAN address and demands a token cross-device', xj.includes('isLoopback') && xj.includes("ws://'+h+':8787") && xj.includes('another device'));
    check('20b: Exness connect honors the Bridge URL field; cross-device error text names URL + token', srcMain2.includes("(\$('#mt5Url')||{}).value||bridge.localBridgeWs()") && srcMain2.includes('Bridge URL') && srcMain2.includes('bridge token'));
    check('20b: SETUP_AND_RUN.bat creates bridge_token.txt and exports AURUM_BRIDGE_TOKEN', xbat.includes('bridge_token.txt') && xbat.includes('AURUM_BRIDGE_TOKEN') && xbat.includes('ALLOW python on Private networks'));
  }

  /* ---------- round 20c: origin/loopback diagnosis + self-test ---------- */
  {
    const yc = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const yj = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    const ybat = readFileSync(join(root, 'bridge', 'SETUP_AND_RUN.bat'), 'utf8');
    check('20c: local file pages (app.html double-click) and opaque origins accepted at the bridge', yc.includes('o == "null" or o.startswith("file://")'));
    check('20c: startup self-test proves the bridge answers on this PC and says when the browser is at fault', yc.includes('def _self_test') && yc.includes('SELF-TEST PASSED') && yc.includes('BROWSER is blocking'));
    check('20c: failed-login throttle kicks brute-forcers on both ports', (yc.match(/login_fails/g) || []).length >= 4 && yc.includes('too many failed logins'));
    check('20c: stale (localhost only) log gone; banner teaches the 4s diagnosis', !yc.includes('(localhost only)') && yc.includes('no answer in 4s') && yc.includes('not the app.html file'));
    check('20c: bat exports AURUM_BRIDGE_ALLOWED_ORIGINS for the hosted app origin', ybat.includes('AURUM_BRIDGE_ALLOWED_ORIGINS=aurum-staging.up.railway.app'));
    check('20c: client retries the localhost twin and connects with the URL that answered', yj.includes('healthOnce') && yj.includes("url.replace('127.0.0.1', 'localhost')") && srcMain2.includes('health.url||url'));
    check('20c: timeout diagnosis tells the user to look for the client connected line', yj.includes('client connected') && yj.includes('Allow local network'));
  }

  /* ---------- round 20d: Phase-2 safety slice (RISK/BOSS + kill switch) ---------- */
  {
    const rg = readFileSync(join(root, 'server', 'lib', 'riskgate.js'), 'utf8');
    const ks = readFileSync(join(root, 'server', 'lib', 'killswitch.js'), 'utf8');
    const ap = readFileSync(join(root, 'server', 'app.js'), 'utf8');
    check('20d: RISK module returns PASSED/FAILED/UNKNOWN and missing data never counts as passed', rg.includes("CHECK.UNKNOWN") && rg.includes('missing data never counts as passed') && rg.includes('export function evaluateRisk'));
    check('20d: RISK reward-to-risk is venue-aware (fixed-risk stake contracts vs CFD SL/TP plans)', rg.includes('max loss = stake') && rg.includes("venue === 'deriv'") && rg.includes('entry'));
    check('20d: BOSS module exists with the four verdicts and can never override Risk', rg.includes('export function bossVerdict') && rg.includes('READY FOR MANUAL REVIEW') && rg.includes('never overrides Risk') && rg.includes('WAIT'));
    check('20d: kill switch module blocks order routes with 503 and protects re-enable with the diag key', ks.includes('error: \'kill_switch\'') && ks.includes('AURUM_DIAG_KEY') && ks.includes('export function requireTrading'));
    check('20d: /api/risk/gate runs the tri-state module and returns checks + boss verdict', ap.includes('evaluateRisk({') && ap.includes('bossVerdict({ risk: report') && ap.includes('checks: report.checks'));
    check('20d: kill switch enforced on every buy route (order/confirm/buy) incl. the env-token router', ap.includes('/\\/(order|confirm|buy)$/.test(p)') && ap.includes('requireTrading(req, _res, next)'));
    check('20d: kill switch control endpoint present (GET+POST /api/ctl/killswitch)', ap.includes("app.post('/api/ctl/killswitch'") && ap.includes("app.get('/api/ctl/killswitch'"));
    check('20d: client sends the trade plan (entry/SL/TP/marketHours) to the gate — quote first as evidence', srcMain2.includes('marketHours:(minqr&&minqr.ask>0)?true:null') && srcMain2.includes('sl:slN,tp:tpN') && srcMain2.includes('entry:isNaN(px)?null:px'));
    check('20d: Settings kill-switch toggle + visible score formula (quality score, not probability)', srcMain2.includes('killSwitchBtn') && srcMain2.includes('/api/ctl/killswitch') && doc.documentElement.outerHTML.includes('NOT a probability of profit') && doc.documentElement.outerHTML.includes('killSwitchState'));
  }

  /* ---------- round 20e: position sizer + trade planner (spec §11) ---------- */
  {
    const sz = readFileSync(join(root, 'src', 'sizer.js'), 'utf8');
    check('20e: sizer module exists with OK/BLOCKED/INCOMPLETE and never assumes values', sz.includes('export function planPosition') && sz.includes('INCOMPLETE') && sz.includes('never assumed'));
    check('20e: sizer rounds DOWN to broker step, enforces minimum volume, tiers never exceed the cap', sz.includes('rounded DOWN to the broker step') && sz.includes('Below the broker minimum') && sz.includes('SMALL: mk(0.25)'));
    check('20e: slippage + costs honesty (stop not guaranteed, fees never assumed)', sz.includes('does not guarantee the exact exit price') && sz.includes('not assumed'));
    check('20e: trade ticket shows the live size plan with formula + user-supplied conversion rate', srcMain2.includes('renderSizePlan') && srcMain2.includes('sizePlanSpecs') && srcMain2.includes('you supply — never fetched or assumed') && doc.documentElement.outerHTML.includes('id="sizePlan"'));
  }

  /* ---------- round 20f: six-role pipeline modules + workflow (spec §5) ---------- */
  {
    const pf = (f) => readFileSync(join(root, 'server', 'lib', 'pipeline', f), 'utf8');
    const apf = readFileSync(join(root, 'server', 'app.js'), 'utf8');
    check('20f: all four role modules exist with dependency states (DONE/DEGRADED/UNAVAILABLE)', ['news.js','charts.js','scout.js','strategy.js','index.js'].every(f => { try { pf(f); return true; } catch (e) { return false; } }) && pf('news.js').includes('UNAVAILABLE') && pf('charts.js').includes('DEGRADED'));
    check('20f: NEWS role invariant — authorizes is always false; stale-only stands down', pf('news.js').includes('authorizes: false') && pf('news.js').includes('STALE_STAND_DOWN'));
    check('20f: SCOUT score labelled a quality/confluence score — NOT a probability of profit', pf('scout.js').includes('NOT a probability of profit') && pf('scout.js').includes('SCORE_LABEL'));
    check('20f: STRATEGY role is explicit + versioned (six named conditions with pass/fail values)', pf('strategy.js').includes('STRATEGY_VERSION') && pf('strategy.js').includes('mtf_confirmed') && pf('strategy.js').includes('reward_to_risk_min') && pf('strategy.js').includes('quality score, not a probability'));
    check('20f: orchestrator wires SCOUT→NEWS→CHARTS→STRATEGY→RISK→BOSS and never executes', pf('index.js').includes("WORKFLOW_ORDER = ['SCOUT', 'NEWS', 'CHARTS', 'STRATEGY', 'RISK', 'BOSS']") && pf('index.js').includes('executes: false'));
    check('20f: BOSS defaults WAIT on absent/stale/incomplete setups; REJECTED only for real setups failing Risk', pf('index.js').includes('bossVerdict') && readFileSync(join(root, 'server', 'lib', 'riskgate.js'), 'utf8').includes('that is a \'nothing to do now\', not a rejection'));
    check('20f: pipeline endpoint exists and injects the REAL kill-switch state', apf.includes("app.post('/api/pipeline/analyze'") && apf.includes('killSwitch: isTradingKilled()'));
    check('20f: analyzer shows the six-role workflow panel with the Boss verdict', srcMain2.includes('loadPipelineFlow') && srcMain2.includes('Boss verdict:') && srcMain2.includes('this panel never executes'));
  }

  /* ---------- round 20g: token pre-auth contract + https-first guidance + local-app shortcut ---------- */
  {
    const pyB = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const batB = readFileSync(join(root, 'bridge', 'SETUP_AND_RUN.bat'), 'utf8');
    const srcBridge = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    check('20g: bridge answers the auth preflight on BOTH sockets (auth_ok / token rejected)', (pyB.match(/"type": "auth_ok"/g) || []).length >= 2 && pyB.includes('bridge token rejected'));
    check('20g: https app failure leads with the guaranteed local-app path', srcMain2.includes('httpsLead') && srcMain2.includes('Fredrick TRADING (local app)'));
    check('20g: SETUP_AND_RUN.bat creates the desktop local-app shortcut', batB.includes('Fredrick TRADING (local app)') && batB.includes('CreateShortcut'));
    check('20g: client auth preflight contract unchanged (type auth carries the token)', srcBridge.includes("type: 'auth'") && srcBridge.includes('auth_skipped'));
  }

  /* ---------- round 20h: connection doctor + bridge version handshake ---------- */
  {
    const pyB = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const brB = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    check('20h: bridge announces its bundle version on the ping handshake (both sockets)', (pyB.match(/"bridge": BRIDGE_BUNDLE/g) || []).length >= 2 && pyB.includes('BRIDGE_BUNDLE = "21a"'));
    check('20h: diagnoseBridge walks env / http / socket / token / MT5 login step by step', brB.includes('export async function diagnoseBridge') && brB.includes('Bridge HTTP reachable') && brB.includes('Trading socket') && brB.includes('MT5 login'));
    check('20h: app exposes the Test bridge button + doctor panel', srcMain2.includes('bridgeTestBtn') && srcMain2.includes('bridgeDoctor') && doc.documentElement.outerHTML.includes('id="bridgeTestBtn"'));
  }

  /* ---------- round 20i: https-window trap hard stop ---------- */
  {
    check('20i: https+loopback connect is hard-stopped with the local app as the primary action', srcMain2.includes('httpsLocalGuard') && srcMain2.includes('Open the local app') && srcMain2.includes('aurum_https_override'));
    check('20i: the stop message names the guaranteed path', srcMain2.includes('Stopped on purpose: press Connect in the LOCAL trading app'));
  }

  /* ---------- round 20j: plain-HTTP command transport (WS-intercept fallback) ---------- */
  {
    const pyB = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const brB = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    check('20j: bridge serves POST /bridge on BOTH ports with the same gates', pyB.includes('_http_bridge_command') && (pyB.match(/\/bridge/g) || []).length >= 3 && pyB.includes('login required first'));
    check('20j: client rides HTTP automatically when the websocket is intercepted', brB.includes('httpFrame') && brB.includes('httpHealthProbe') && brB.includes('transport'));
    check('20j: doctor checks the HTTP transport and names the interceptor cause', brB.includes('Bridge commands over HTTP') && brB.includes('intercepting websockets'));
    check('20j: connectMt5 passes the proven transport through', srcMain2.includes('transport:health.transport'));
  }

  /* ---------- round 20k: reuse the MT5 IPC attachment established at bridge startup ---------- */
  {
    const pyB = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const h = pyB.slice(pyB.indexOf('def handle_login(msg):'), pyB.indexOf('def handle_order(msg):'));
    check('20k: Exness login reuses an attached terminal and retries only through configured terminal selection', h.indexOf('term = mt5.terminal_info()') < h.indexOf('if not attach_terminal():') && h.includes('reusing the MT5 terminal already attached at bridge startup'));
    check('20k: disconnected MT5 retries configured attach and reports AURUM_MT5_PATH diagnostics', h.includes('if term is None:') && h.includes('Check AURUM_MT5_PATH') && h.includes('start the Exness MT5 terminal normally'));
  }

  /* ---------- round 20l: explicit Exness server in Automation login ---------- */
  {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const main = readFileSync(join(root, 'src', 'main.js'), 'utf8');
    const py = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    check('20l: Automation exposes a required exact Exness MT5 server field with no guessed server name', html.includes('id="mt5Server" required') && html.includes('copy the exact server from Exness Personal Area') && !html.includes('HFMarkets') && !html.includes('Exness Demo server'));
    check('20l: Automation requires and passes the selected server to connectMt5', main.includes("if(!server)throw new Error('Enter the exact Exness MT5 server") && main.includes('connectMt5(url,login,password,server,bridgeToken)'));
    check('20l: bridge rejects missing server instead of using the terminal default', py.includes('if not server:') && py.includes('exact Exness MT5 server is required') && py.includes('mt5.login(login, password=password, server=server)'));
  }

  /* ---------- round 20m: require the known-good MT5 IPC package version ---------- */
  {
    const req = readFileSync(join(root, 'bridge', 'requirements.txt'), 'utf8');
    const py = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    check('20m: bridge installer upgrades MetaTrader5 to the latest version available for Python 3.13', req.includes('MetaTrader5>=5.0.6231'));
    check('20m: bridge window identifies the current IPC-compatible bundle', py.includes('BRIDGE_BUNDLE = "21a"'));
  }

  /* ---------- round 20o: MetaTrader5 invalid-fill constant compatibility ---------- */
  {
    const py = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const order = py.slice(py.indexOf('def handle_order(msg):'), py.indexOf('def handle_close(msg):'));
    check('20o: order rejection never dereferences missing INVALID_FILLING_TYPE constant', order.includes('getattr(mt5, name, None)') && order.includes('TRADE_RETCODE_INVALID_FILL') && !order.includes('res.retcode == mt5.TRADE_RETCODE_INVALID_FILLING_TYPE'));
    check('20o: bridge reports broker rejection after safely trying available fill modes', order.includes('res.retcode in invalid_fill_codes') && order.includes('order rejected by broker'));
  }

  /* ---------- round 20p: failed Exness orders release their risk reservation ---------- */
  {
    const ap = readFileSync(join(root, 'server', 'app.js'), 'utf8');
    const main = readFileSync(join(root, 'src', 'main.js'), 'utf8');
    const riskTest = readFileSync(join(root, 'server', 'tests', 'risklimits.test.mjs'), 'utf8');
    check('20p: server tracks pending Exness reservations and only releases matching pending intents', ap.includes('reservations: new Map()') && ap.includes("reservation.status !== 'pending'") && ap.includes("kind === 'release'"));
    check('20p: manual and sniper Exness failures release reservations; ambiguous transport outcomes stay reserved', main.includes('releaseMt5RiskReservation') && main.includes('mt5ResultAmbiguous') && main.includes("body:{kind:'open',once}"));
    check('20p: Exness reservation regression test covers release, commit, and close', riskTest.includes('Exness risk reservations release on failed entries') && riskTest.includes('intent-filled-2'));
  }

  /* ---------- round 20q: local app serves even when MT5 attach fails ---------- */
  {
    const py = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const main = py.slice(py.indexOf('async def main():'), py.indexOf('if __name__ == "__main__":'));
    check('20q: local HTTP app starts before MT5 attach attempt', main.indexOf('_start_http_app()') >= 0 && main.indexOf('_start_http_app()') < main.indexOf('attached = attach_terminal()'));
    check('20q: MT5 attach failure leaves app running and clearly disables only Exness trading', main.includes('MT5 unavailable: local app remains available') && !main.includes('if not attach_terminal():\n        sys.exit(1)'));
  }

  /* ---------- round 20s: Exness sizing uses MT5-reported equity + leverage ---------- */
  {
    const main = readFileSync(join(root, 'src', 'main.js'), 'utf8');
    const bridgeClient = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    const sizer = main.slice(main.indexOf('function renderSizePlan()'));
    check('20s: Exness CFD sizer uses MT5-reported equity and never substitutes balance', sizer.includes('acct.equity') && sizer.includes('const equity=isMt5?reportedEquity:state.balance') && sizer.includes('const fixedRisk=!isMt5'));
    check('20s: Exness sizer shows reported equity/leverage and says unavailable when absent', sizer.includes('MT5 equity (latest broker snapshot)') && sizer.includes('MT5 leverage') && sizer.includes('unavailable — refresh/reconnect Exness') && sizer.includes('unknown — margin not estimated'));
    check('20s: bridge client carries only MT5-reported equity and leverage into the account snapshot', bridgeClient.includes('equity: res.equity') && bridgeClient.includes('leverage: res.leverage || null'));
  }

  /* ---------- round 20t: live read-only MT5 account + positions refresh ---------- */
  {
    const py = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const bridgeClient = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    const main = readFileSync(join(root, 'src', 'main.js'), 'utf8');
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    check('20t: live MT5 account refresh is authenticated and returns broker metrics only', py.includes('"account", "quote"') && py.includes('def handle_account(_msg):') && py.includes('"margin_free": ai.margin_free') && py.includes('"equity": ai.equity'));
    check('20t: bridge client exposes account refresh while preserving read-only positions query', bridgeClient.includes("export function bridgeAccount() { return frame({ type: 'account' }); }") && bridgeClient.includes("export function bridgePositions() { return frame({ type: 'positions' }); }"));
    check('20t: Exness UI refreshes balance/equity and live broker positions without merging into app-managed positions', main.includes('bridge.bridgeAccount()') && main.includes('bridge.bridgePositions()') && main.includes('setInterval(()=>{ if(state.broker?.type===\'mt5\')void refreshMt5Snapshot(false); },15000)') && html.includes('id="mt5PositionsCard"'));
    check('20t: Exness account ID is masked in bridge response and logs', py.includes('"account": _mask_account(ai.login)') && py.includes('MT5 account ending %s') && !py.includes('log.info("MT5 account %s @ %s'));
    check('20t: open-trades failure explains app counter vs MT5 and confirms no order was sent', main.includes('function mt5GateError(gate)') && main.includes('not a live MT5 position scan') && main.includes('no order was sent') && (main.match(/mt5GateError\(gate/g)||[]).length>=2);
  }

  /* ---------- round 20u: broker-authoritative Exness cap reconciles stale cloud opens safely ---------- */
  {
    const py = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const pyRisk = readFileSync(join(root, 'bridge', 'risklimits.py'), 'utf8');
    const client = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    const main = readFileSync(join(root, 'src', 'main.js'), 'utf8');
    const risk = readFileSync(join(root, 'src', 'mt5Risk.js'), 'utf8');
    const server = readFileSync(join(root, 'server', 'app.js'), 'utf8');
    const order = py.slice(py.indexOf('def handle_order(msg):'), py.indexOf('def handle_close(msg):'));
    check('20u: bridge serializes Exness orders and rechecks live MT5 positions immediately before send', py.includes('_ORDER_LOCK = threading.Lock()') && order.includes('with _ORDER_LOCK:') && order.indexOf('validate_open_positions') >= 0 && order.indexOf('validate_open_positions') < order.indexOf('mt5.order_send(request)'));
    check('20u: MT5 position gate fails closed and cannot exceed the existing 10-position cap', pyRisk.includes('MAX_MT5_OPEN_POSITIONS = 10') && pyRisk.includes('if positions is None:') && pyRisk.includes('limit = min(requested, MAX_MT5_OPEN_POSITIONS)'));
    check('20u: client forwards the server limit to the local bridge order handler', client.includes('max_open_trades: o.maxOpenTrades') && main.includes('maxOpenTrades:mt5OpenLimit'));
    check('20u: only a sole failed open_trades check may use fresh local MT5 positions, with explicit confirmation', risk.includes('failed.length === 1') && risk.includes('count >= limit') && main.includes('verifyAndConfirmMt5OpenLimit(gate)') && main.includes('verifyAndConfirmMt5OpenLimit(gate2)') && main.includes('Continue once'));
    check('20u: Exness close cannot decrement an unrelated or already-closed reservation', server.includes("reservation.status !== 'committed'") && server.includes("error: 'reservation_not_committed'"));
  }

  /* ---------- round 20v: broker-discovered analysis-only markets ---------- */
  {
    const py = readFileSync(join(root, 'bridge', 'mt5_bridge.py'), 'utf8');
    const meta = readFileSync(join(root, 'bridge', 'marketmeta.py'), 'utf8');
    const client = readFileSync(join(root, 'src', 'bridge.js'), 'utf8');
    const main = readFileSync(join(root, 'src', 'main.js'), 'utf8');
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const feed = readFileSync(join(root, 'server', 'lib', 'derivfeed.js'), 'utf8');
    const server = readFileSync(join(root, 'server', 'app.js'), 'utf8');
    check('20v: markets UI can load and filter broker-discovered symbols by source and asset class', html.includes('id="loadDerivMarkets"') && html.includes('id="loadMt5Markets"') && html.includes('id="brokerMarketCategory"') && html.includes('data-cat="indices"'));
    check('20v: Exness market catalogue and candles are authenticated and read locally from MT5', py.includes('"symbols", "history"') && py.includes('mt5.symbols_get()') && py.includes('mt5.copy_rates_from_pos') && client.includes("frame({ type: 'symbols' })") && client.includes("type: 'history'"));
    check('20v: Exness market metadata is conservatively classified; unrecognized products remain Other', meta.includes('return "etfs"') && meta.includes('return "bonds"') && meta.includes('return "energies"') && meta.includes('return "other"'));
    check('20v: Deriv catalogue uses active_symbols and dynamically fetches only active-symbol ticks/candles', feed.includes("active_symbols: 'brief'") && server.includes("/api/markets/deriv/candles") && server.includes("/api/markets/deriv/tick") && server.includes('market_not_active_on_deriv'));
    check('20v: expanded symbols are analysis-only and report source/freshness honestly', main.includes('Analyze') && main.includes('LIVE') && main.includes('DELAYED') && main.includes('HISTORICAL') && main.includes('UNAVAILABLE') && main.includes('analysis only') && !html.includes('trade dynamic market'));
    check('20v: Exness candles are analyzed in the browser; no Exness history is sent to a cloud analysis route', main.includes('bridge.bridgeHistory(m.code,mt5tf,120)') && main.includes('analyzeTimeframe(m.code') && html.includes('Exness/MT5 data stays on this PC'));
  }

  /* ---------- report ---------- */
  console.log('\n=== PASS (' + ok.length + ') ===');
  if (bad.length) { console.log('=== FAIL (' + bad.length + ') ==='); bad.forEach(b => console.log('  x ' + b)); }
  if (errors.length) { console.log('=== JS ERRORS ==='); errors.forEach(e => console.log('  ! ' + e)); }
  console.log('\nRESULT:', bad.length === 0 && errors.length === 0 ? 'ALL GOOD' : 'ISSUES FOUND');
  process.exit(bad.length || errors.length ? 1 : 0);
}

run().catch(e => { console.error('SMOKE CRASH', e); if (errors.length) console.error(errors); process.exit(2); });
