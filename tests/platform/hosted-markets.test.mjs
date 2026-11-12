/*
 * The cloud viewer's Markets table, instrument by instrument.
 *
 * The report these tests answer: 20 instruments showed "No data · source:
 * unavailable · AURUM cloud analysis" while their markets were open. Each
 * scenario boots the real application bundle in jsdom on a Cloudflare host,
 * with the real Worker code answering its API requests, and checks every one
 * of the 20 rows:
 *
 *   - the cloud cannot reach Deriv but the browser can  -> a live reading, analysed in the browser
 *   - neither can                                       -> "Feed unavailable", with both reasons and a Retry
 *   - candles are old (market closed, feed paused)      -> "Stale data", and no signal
 *   - Deriv has no history for the market               -> "No data"
 *   - the browser is blocked but the cloud is healthy   -> a live reading, labelled as the cloud's
 *
 * and that the PC app is untouched by all of it.
 *
 * Deriv and Yahoo are stubs: the WebSocket and the Worker's providers are
 * replaced, and nothing reaches the network. Candle values are fixtures. No
 * assertion expects a particular signal, direction or level; rows are checked
 * for which state they are in and where they say the data came from.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';
import { DERIV_INSTRUMENTS, INDEX_INSTRUMENTS, derivCandleRows, basePriceFor, yahooChartFixture, nowSec } from './helpers/market-fixtures.mjs';
import { tradingDayText } from '../../src/bestpick.js';
import { runDeterministicAnalysis } from '../../server/lib/analyzer.js';
import { localDecision } from '../../server/lib/localdecision.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
const MODULE_TAG = '<script type="module" src="/src/main.js"></script>';
const HOSTED_ORIGIN = 'https://aurum-test.workers.dev';
const PC_ORIGIN = 'http://127.0.0.1:8788';
const PUBLIC_FEED = 'wss://api.derivws.com/trading/v1/options/ws/public';
const DERIV_SYMBOLS = DERIV_INSTRUMENTS.map((instrument) => instrument.s);
const INDEX_SYMBOLS = INDEX_INSTRUMENTS.map((instrument) => instrument.s);
const TEST_KEYS = { claude: 'TEST-CLAUDE-KEY-VALUE', openai: 'TEST-OPENAI-KEY-VALUE', perplexity: 'TEST-PPLX-KEY-VALUE' };

const BROWSER_SOURCE = 'source: Deriv public candles · analysed in this browser';
const CLOUD_DERIV_SOURCE = 'source: Deriv public candles · AURUM cloud analysis';
const CLOUD_INDEX_SOURCE = 'source: Yahoo Finance public daily data · AURUM cloud analysis';
/* The best-market panel: the six live markets it ranks, the three indices of its daily line, and its sentences. */
const PICK_MARKETS = DERIV_SYMBOLS.slice(0, 6);
const PICK_INDICES = ['NAS100', 'US30', 'SPX500'];
const NO_SETUP = 'No directional setup right now \u2014 the pick appears the moment the live scan finds one.';
const TEN_MINUTES = 10 * 60 * 1000;
const NOT_ESTIMATED = ' Nothing is estimated \u2014 the pick appears when the scan finds one.';
const READ_INSIDE = ' Inside the workspace this browser reads the live markets itself.';
/* What a row with a reading starts with. Which of these it is depends on the fixture and is not asserted. */
const READING = /^(Buy \d+%|Sell \d+%|▲ Lean up|▼ Lean down|Wait)/;

let bundleCode = '';
before(async () => {
  const bundle = await build({
    entryPoints: [join(root, 'src', 'main.js')], bundle: true, write: false, format: 'iife',
    absWorkingDir: root, define: { 'import.meta.env': '{}' }, logLevel: 'silent'
  });
  bundleCode = bundle.outputFiles[0].text;
});

/**
 * Boots the real application bundle in jsdom.
 *
 * `world` describes the outside and may be changed while the test runs:
 *   browserDeriv  'ok' | 'down' | 'empty'   what this browser's connections to Deriv do
 *   cloudDeriv    'ok' | 'down'             what the Worker's Deriv provider does
 *   yahoo         'ok' | 'down'             what the Worker's Yahoo provider does
 *   candleAgeSec  how old the newest candle is, on both sides
 *   ticks         answer every price subscription with one tick
 *   yahooBars     options for the Yahoo fixture: { newestBarAt, session } (see market-fixtures.mjs)
 *   rewriteScan   (results) => results, applied to what the Worker answers to /api/signals/scan:
 *                 lets a test hand the page a reading of its own writing for one market
 *   scanTakesMs   page time that passes while a scan request is answered
 *   scanGate      () => Promise, awaited before a scan request is answered
 * `pcApi`, when given, replaces the Worker: the page then runs as the PC app
 * and `pcApi(path, body)` answers its API requests with { status, body }.
 */
async function bootApp({ origin = HOSTED_ORIGIN, world = {}, pcApi = null, bridgeApi = null } = {}) {
  const state = { browserDeriv: 'ok', cloudDeriv: 'ok', yahoo: 'ok', candleAgeSec: 0, ticks: false, yahooBars: {}, rewriteScan: null, scanTakesMs: 0, scanGate: null, ...world };
  const problems = [];
  const warnings = [];
  const requests = [];
  const sockets = [];
  const intervals = [];
  const clock = { shiftMs: 0 };
  let closing = false;

  const symbolOf = (code) => DERIV_INSTRUMENTS.find((instrument) => instrument.deriv === code);
  const rows = (code, granularity, count) => derivCandleRows({ count, granularity, end: nowSec() + clock.shiftMs / 1000 - state.candleAgeSec, base: basePriceFor(code) });

  const worker = createReadOnlyWorker({
    requestImpl: async (payload) => {
      if (state.cloudDeriv !== 'ok') throw new Error('Deriv public WebSocket connection failed');
      if (payload.ticks_history) return { candles: rows(payload.ticks_history, payload.granularity, payload.count) };
      throw new Error('unexpected Deriv request in this test');
    },
    fetchImpl: async () => {
      if (state.yahoo !== 'ok') throw new Error('Yahoo Finance HTTP 503');
      return Response.json(yahooChartFixture(state.yahooBars));
    },
    /* One clock for the page and the cloud: when a test moves the page's time on, the
       Worker's caches age with it instead of answering with what they read "minutes ago". */
    now: () => Date.now() + clock.shiftMs,
    log: () => {}
  });
  const allow = { limit: async () => ({ success: true }) };
  const env = { AURUM_SIGNAL_LIMITER: allow, AURUM_MARKET_LIMITER: allow, ASSETS: { fetch: async () => new Response('shell') } };

  const consoleLines = new VirtualConsole();
  consoleLines.on('jsdomError', (error) => problems.push('jsdomError: ' + ((error.detail && error.detail.stack) || error.message)));
  consoleLines.on('error', (...args) => problems.push('console.error: ' + args.join(' ')));
  consoleLines.on('warn', (...args) => warnings.push(args.join(' ')));

  /* Function replacement: a string replacement would expand `$&`-style sequences inside the bundle. */
  const html = indexHtml.replace(MODULE_TAG, () => '<script>' + bundleCode + '</' + 'script>');
  assert.ok(!html.includes(MODULE_TAG), 'module tag replaced by the bundle');

  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: consoleLines, url: origin + '/',
    beforeParse(window) {
      window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.Element.prototype.scrollIntoView = function () {};
      window.scrollTo = function () {};
      window.localStorage.setItem('aurum_aikeys', JSON.stringify(TEST_KEYS));
      /* The page's clock can be moved forward by the test, and its repeating timers are
         recorded so a test can run one now instead of waiting for it. */
      const realNow = window.Date.now.bind(window.Date);
      window.Date.now = () => realNow() + clock.shiftMs;
      const realSetInterval = window.setInterval.bind(window);
      window.setInterval = (fn, delay, ...rest) => { intervals.push({ fn, delay }); return realSetInterval(fn, delay, ...rest); };

      /* Stand-in for Deriv's public WebSocket, for the price stream and the candle connection alike. */
      window.WebSocket = function (url) {
        const entry = { url: String(url), sent: [], socket: this };
        sockets.push(entry);
        /* The local MT5 bridge listens on the PC app's own address; a test that needs it passes
           `bridgeApi(frame)`, which answers one bridge frame. Every other socket is Deriv's. */
        const toBridge = !!bridgeApi && new URL(entry.url).host === new URL(origin).host;
        this.readyState = 0;
        this.close = () => { this.readyState = 3; };
        this.send = (raw) => {
          const message = JSON.parse(raw);
          entry.sent.push(message);
          window.setTimeout(() => {
            if (this.readyState !== 1) return;
            if (toBridge) {
              const answer = bridgeApi(message) || { type: 'error', message: 'not part of this test' };
              if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: message.id, ...answer }) });
              return;
            }
            /* The feed has gone down since this connection opened: it is dropped instead of answering. */
            if (state.browserDeriv === 'down') { this.readyState = 3; if (this.onclose) this.onclose({ code: 1006 }); return; }
            if (!this.onmessage) return;
            if (message.style === 'candles') {
              const candles = state.browserDeriv === 'empty' ? [] : rows(message.ticks_history, message.granularity, message.count);
              this.onmessage({ data: JSON.stringify({ msg_type: 'candles', req_id: message.req_id, echo_req: message, candles }) });
            } else if (state.ticks && message.subscribe === 1) {
              this.onmessage({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: message.ticks_history, quote: basePriceFor(message.ticks_history), epoch: nowSec() } }) });
            }
          }, 0);
        };
        window.setTimeout(() => {
          if (this.readyState !== 0) return;
          if (!toBridge && state.browserDeriv === 'down') { this.readyState = 3; if (this.onerror) this.onerror({}); if (this.onclose) this.onclose({ code: 1006 }); return; }
          this.readyState = 1;
          if (this.onopen) this.onopen({});
        }, 0);
      };

      window.fetch = async (input, init = {}) => {
        const url = new URL(String(input), origin);
        const headers = {};
        for (const [name, value] of Object.entries(init.headers || {})) headers[name.toLowerCase()] = String(value);
        let body = null;
        try { body = init.body ? JSON.parse(init.body) : null; } catch (_e) { body = null; }
        const record = { path: url.pathname, method: init.method || 'GET', body, status: null, afterEntering: entered };
        requests.push(record);
        if (url.origin !== origin) throw new TypeError('network is disabled in tests');
        const isScan = url.pathname === '/api/signals/scan';
        if (isScan) {
          clock.shiftMs += state.scanTakesMs;
          if (state.scanGate) await state.scanGate();
        }
        let response;
        if (pcApi) {
          const answer = pcApi(url.pathname, body) || { status: 404, body: { error: 'not_part_of_this_test' } };
          response = new Response(JSON.stringify(answer.body), { status: answer.status || 200, headers: { 'content-type': 'application/json' } });
        } else {
          response = await worker.fetch(new Request(url, { method: record.method, headers: { ...headers, origin }, body: init.body }), env);
          if (isScan && state.rewriteScan && response.ok) {
            const answer = await response.json();
            response = Response.json({ ...answer, results: state.rewriteScan(answer.results) });
          }
        }
        record.status = response.status;
        /* Once the test is tearing the page down, leave late requests pending
           so application code never resumes against a closed document. */
        if (closing) return new Promise(() => {});
        return response;
      };
    }
  });
  let entered = false;
  const { window } = dom;
  const doc = window.document;
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const waitFor = async (condition, label, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (condition()) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for: ' + label + '\n' + problems.join('\n'));
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await waitFor(() => window.__aurumAppStarted === true, 'application start marker');

  const cell = (symbol) => doc.querySelector('#mktBody td[data-msig="' + symbol + '"]');
  const row = (symbol) => {
    const td = cell(symbol);
    const badge = td && td.querySelector('.badge');
    const source = td && [...td.querySelectorAll('div.tiny')].find((el) => el.textContent.startsWith('source: '));
    const retry = td && td.querySelector('.msig-retry');
    /* The badge text without the Retry button's label. */
    const copy = badge ? badge.cloneNode(true) : null;
    if (copy) copy.querySelectorAll('button').forEach((button) => button.remove());
    return {
      badge: copy ? copy.textContent.trim() : '',
      title: badge ? badge.getAttribute('title') || '' : '',
      source: source ? source.textContent : '',
      hasRetry: !!retry, retry,
      levels: !!(td && td.querySelector('.market-levels'))
    };
  };
  /* The best-market panel ('authBestBody' on the sign-in screen, 'ovBest' in the workspace), line by line. */
  const panel = (id) => {
    const el = doc.getElementById(id);
    const liveLine = el && el.querySelector('.bp-live');
    const dailyLine = el && el.querySelector('.bp-daily');
    const describe = (line) => ({
      text: line ? line.textContent : '',
      symbol: line && line.querySelector('b') ? line.querySelector('b').textContent : '',
      direction: line && line.querySelector('.badge.buy') ? 'BUY' : line && line.querySelector('.badge.sell') ? 'SELL' : '',
      title: line ? line.getAttribute('title') || '' : ''
    });
    return { text: el ? el.textContent : '', ready: !!liveLine, live: describe(liveLine), daily: describe(dailyLine), hasDaily: !!dailyLine };
  };
  return {
    window, doc, state, requests, sockets, problems, warnings, click, waitFor, row, panel,
    /** Moves the page's clock forward. */
    advanceClock(ms) { clock.shiftMs += ms; },
    /** Runs the page's repeating timers of the given period once, as if the period had passed. */
    runIntervals(delay) { for (const timer of intervals.filter((entry) => entry.delay === delay)) timer.fn(); },
    /** Past the sign-in screen without an account ("live markets, no trading"). */
    async enter() {
      entered = true;
      click(doc.getElementById('guestBtn'));
      await waitFor(() => doc.getElementById('authScreen').classList.contains('hidden'), 'workspace after the sign-in screen');
    },
    async open(view) {
      click(doc.querySelector('.nav-item[data-view="' + view + '"]'));
      await waitFor(() => doc.getElementById('view-' + view).classList.contains('active'), 'the ' + view + ' view');
    },
    /** Into the Markets view, and until every one of the 26 rows has left "Scanning…". */
    async openMarkets() {
      await this.enter();
      await this.open('markets');
      await waitFor(() => [...DERIV_SYMBOLS, ...INDEX_SYMBOLS].every((symbol) => row(symbol).badge && !/Scanning/.test(row(symbol).badge)), 'a reading or a state in every row');
    },
    visibleText(scope) {
      const copy = (scope || doc.body).cloneNode(true);
      copy.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
      return copy.textContent;
    },
    /** Symbols sent to the AURUM signal API after the visitor entered the workspace. */
    scannedByApiAfterEntering() {
      return requests.filter((r) => r.path === '/api/signals/scan' && r.afterEntering).flatMap((r) => (r.body && r.body.symbols) || []);
    },
    async close() {
      closing = true;
      await new Promise((r) => setTimeout(r, 50));
      window.close();
    }
  };
}

/* ---------------------------------------------------------------- the reported fault */

test('the reported fault — the AURUM cloud cannot reach Deriv, the browser can: all 20 instruments show a live reading', async () => {
  const app = await bootApp({ world: { cloudDeriv: 'down' } });
  try {
    await app.openMarkets();

    for (const symbol of DERIV_SYMBOLS) {
      const row = app.row(symbol);
      assert.match(row.badge, READING, `${symbol}: a reading, not a placeholder (saw "${row.badge}")`);
      assert.equal(row.source, BROWSER_SOURCE, `${symbol}: says where the reading was computed`);
      assert.equal(row.hasRetry, false, `${symbol}: nothing to retry`);
    }
    for (const symbol of INDEX_SYMBOLS) {
      const row = app.row(symbol);
      assert.match(row.badge, READING, `${symbol}: index reading`);
      assert.equal(row.source, CLOUD_INDEX_SOURCE, symbol);
    }

    const table = app.visibleText(app.doc.getElementById('mktBody'));
    for (const placeholder of ['No data', 'Feed unavailable', 'Stale data', 'Scan unavailable', 'source: unavailable']) {
      assert.ok(!table.includes(placeholder), `"${placeholder}" appears nowhere in the table`);
    }

    const status = app.doc.getElementById('mktScanStatus');
    assert.ok(!status.classList.contains('hidden'), 'the status line is shown');
    assert.match(status.textContent, /^Signal column: 20 live · 6 daily index readings · scanned \d\d:\d\d:\d\d\. Deriv markets are analysed in this browser from Deriv public candles; index readings come from the AURUM cloud\. Nothing is estimated\.$/);

    const sentToApi = app.scannedByApiAfterEntering();
    assert.ok(sentToApi.length > 0, 'the cloud is still asked for the index CFDs');
    for (const symbol of sentToApi) assert.ok(INDEX_SYMBOLS.includes(symbol), `${symbol} was sent to the AURUM cloud although this browser can read it`);

    assert.equal(app.doc.getElementById('aboutAnalysis').textContent, 'Deriv markets: this browser, from Deriv public candles · indices: AURUM cloud');

    /* The only fault on record is the one the sign-in screen saw, where the cloud was asked alone. */
    const reports = app.warnings.filter((line) => line.startsWith('[aurum] ')).map((line) => JSON.parse(line.slice('[aurum] '.length)));
    assert.equal(reports.length, 1, 'one line: the cloud could not reach Deriv for the sign-in screen scan');
    assert.equal(reports[0].usedBrowser, false);
    assert.ok(reports[0].problems.every((problem) => problem.detail === 'AURUM cloud: Deriv public WebSocket connection failed'));

    /* ... and the pick made there is read again once the visitor is inside. Scans so far: the
       sign-in screen pick, the signal cards, the repeated pick and the Markets table. The
       repeated pick costs no request (candles and index readings are reused), so the count
       of scans is the only place it shows. */
    await app.waitFor(() => app.window.__aurumDiagnostics().scans >= 4, 'the best-market pick repeated after entering');
    const diagnostics = app.window.__aurumDiagnostics();
    assert.equal(diagnostics.hosted, true);
    assert.equal(diagnostics.lastScan.usedBrowser, true);
    assert.equal(diagnostics.candles.connections, 1);
    assert.equal(Object.keys(diagnostics.candles.failed).length, 0, 'no candle request failed');
    for (const secret of Object.values(TEST_KEYS)) assert.ok(!JSON.stringify(diagnostics).includes(secret), 'no saved key in the diagnostics');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('entering the workspace: its first scan is already read in this browser — the signal cards need no Refresh', async () => {
  const app = await bootApp({ world: { cloudDeriv: 'down' } });
  try {
    await app.enter();
    /* Nobody presses Refresh. The cards are those of the scan the workspace starts on entering;
       opening the Signals view shows that scan's results and does not scan again. If that scan
       were left to the cloud, which cannot reach Deriv here, these six markets would have no
       card until someone pressed Refresh. */
    await app.open('signals');
    const grid = app.doc.getElementById('sigGrid');
    await app.waitFor(() => grid.querySelectorAll('.sig-card').length > 0, 'signal cards from the scan started on entering');
    const cards = [...grid.querySelectorAll('.sig-card')].map((card) => ({ symbol: card.querySelector('.sym-name').textContent, why: card.querySelector('.sig-why').textContent }));
    const fromDeriv = cards.filter((card) => DERIV_SYMBOLS.includes(card.symbol));
    assert.equal(fromDeriv.length, 6, 'each of the six Deriv markets of that scan has a card');
    for (const card of fromDeriv) assert.match(card.why, / · source: Deriv public candles · analysed in this browser$/, card.symbol);
    assert.equal(cards.length - fromDeriv.length, 3, 'plus the three daily index readings');
    assert.match(app.doc.getElementById('sigStamp').textContent, /^Updated \d\d:\d\d:\d\d · technical · live candles$/, 'nothing is reported as stale, missing or unavailable');
    for (const symbol of app.scannedByApiAfterEntering()) assert.ok(INDEX_SYMBOLS.includes(symbol), `${symbol} was sent to the AURUM cloud although this browser can read it`);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('one candle connection serves the whole table: the browser opens two sockets in all, not one per market', async () => {
  const app = await bootApp({ world: { cloudDeriv: 'down' } });
  try {
    await app.openMarkets();
    assert.equal(app.sockets.length, 2, 'the price stream and one candle connection');
    for (const socket of app.sockets) assert.equal(socket.url, PUBLIC_FEED);
    const [prices, candles] = app.sockets;
    assert.ok(prices.sent.every((message) => message.subscribe === 1 && message.style === 'ticks'), 'the first socket is the price stream');
    assert.ok(candles.sent.length >= 60, 'the second socket carried the 20 x 3 candle requests');
    assert.ok(candles.sent.every((message) => message.style === 'candles' && message.subscribe === undefined), 'history requests only, no subscription');
    const asked = new Set(candles.sent.map((message) => message.ticks_history + '|' + message.granularity));
    for (const instrument of DERIV_INSTRUMENTS) for (const granularity of [60, 300, 3600]) {
      assert.ok(asked.has(instrument.deriv + '|' + granularity), `${instrument.s} ${granularity}s was requested as ${instrument.deriv}`);
    }
    assert.equal(candles.sent.length, asked.size, 'no series was requested twice');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- unavailable */

test('neither the browser nor the cloud can reach Deriv: all 20 instruments say "Feed unavailable", with both reasons and a Retry', async () => {
  const app = await bootApp({ world: { browserDeriv: 'down', cloudDeriv: 'down' } });
  try {
    await app.openMarkets();

    for (const symbol of DERIV_SYMBOLS) {
      const row = app.row(symbol);
      assert.equal(row.badge, 'Feed unavailable', symbol);
      assert.equal(row.source, 'source: Deriv public feed unreachable', symbol);
      assert.match(row.title, /^This browser: .*Deriv public feed.* AURUM cloud: Deriv public WebSocket connection failed$/, `${symbol}: the tooltip gives both reasons`);
      assert.equal(row.hasRetry, true, `${symbol}: a Retry is offered`);
      assert.equal(row.levels, false, `${symbol}: no levels without data`);
    }
    for (const symbol of INDEX_SYMBOLS) assert.equal(app.row(symbol).source, CLOUD_INDEX_SOURCE, `${symbol}: index readings do not depend on Deriv`);
    assert.match(app.doc.getElementById('mktScanStatus').textContent, /^Signal column: 6 daily index readings · 20 unavailable · /);

    /* One structured line for support, with market names and reasons only. */
    const lines = app.warnings.filter((line) => line.startsWith('[aurum] '));
    assert.ok(lines.length >= 1, 'the fault is written to the console once');
    const report = JSON.parse(lines.at(-1).slice('[aurum] '.length));
    assert.equal(report.event, 'hosted_scan_trouble');
    assert.ok(report.unavailable >= 1);
    assert.ok(report.problems.every((problem) => DERIV_SYMBOLS.includes(problem.symbol) && problem.state === 'unavailable'));
    for (const secret of Object.values(TEST_KEYS)) assert.ok(!lines.join('\n').includes(secret), 'no saved key in a diagnostic line');
    assert.ok(lines.length <= 3, 'not one line per scan: only when the set of affected markets changes');

    /* The feed comes back: Retry gives every market its reading. */
    app.state.browserDeriv = 'ok';
    app.click(app.row('EUR/USD').retry);
    await app.waitFor(() => DERIV_SYMBOLS.every((symbol) => READING.test(app.row(symbol).badge)), 'readings after Retry');
    for (const symbol of DERIV_SYMBOLS) assert.equal(app.row(symbol).source, BROWSER_SOURCE, symbol);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- stale */

test('old candles (market closed or feed paused): all 20 instruments say "Stale data" and show no signal', async () => {
  const app = await bootApp({ world: { candleAgeSec: 2 * 3600 } });
  try {
    await app.openMarkets();

    for (const symbol of DERIV_SYMBOLS) {
      const row = app.row(symbol);
      assert.equal(row.badge, 'Stale data', symbol);
      assert.equal(row.source, 'source: Deriv public candles · last candle 2 h ago', symbol);
      assert.match(row.title, /is 2 h old, so the market is closed or the feed is paused\. No current reading is shown\.$/, symbol);
      assert.equal(row.hasRetry, false, `${symbol}: a retry cannot make a closed market current`);
      assert.equal(row.levels, false, `${symbol}: no entry, stop or target from old candles`);
    }
    assert.match(app.doc.getElementById('mktScanStatus').textContent, /^Signal column: 6 daily index readings · 20 stale \(market closed or feed paused\) · /);

    const toasts = [...app.doc.querySelectorAll('#toasts .toast b')].map((el) => el.textContent);
    for (const symbol of DERIV_SYMBOLS) assert.ok(!toasts.some((title) => title.includes(symbol)), `no signal notice for ${symbol} from old candles`);
    assert.deepEqual(app.warnings.filter((line) => line.startsWith('[aurum]')), [], 'a closed market is a normal state, not a fault to log');

    await app.open('signals');
    await app.waitFor(() => /Updated/.test(app.doc.getElementById('sigStamp').textContent), 'the signal scan');
    assert.match(app.doc.getElementById('sigStamp').textContent, / · 6 stale \(market closed or feed paused\)$/);
    const cards = [...app.doc.querySelectorAll('#sigGrid .sig-card .sym-name')].map((el) => el.textContent);
    for (const symbol of DERIV_SYMBOLS) assert.ok(!cards.includes(symbol), `no signal card for ${symbol}`);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('nothing live anywhere: the Signals view says so and why, instead of "no setups"', async () => {
  const app = await bootApp({ world: { candleAgeSec: 3 * 86400, yahoo: 'down' } });
  try {
    await app.enter();
    await app.open('signals');
    await app.waitFor(() => /No live readings right now/.test(app.doc.getElementById('sigGrid').textContent), 'the explanation');
    const text = app.doc.getElementById('sigGrid').textContent;
    assert.match(text, /No live readings right now6 stale \(market closed or feed paused\) · 3 unavailable\. Nothing is estimated — press refresh to check again\./);
    assert.ok(!text.includes('No signals right now'));
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Signals view: once the feed is back, Refresh reads the markets in this browser at once instead of waiting out the pause', async () => {
  const app = await bootApp({ world: { browserDeriv: 'down', cloudDeriv: 'down', yahoo: 'down' } });
  try {
    await app.enter();
    await app.open('signals');
    const grid = app.doc.getElementById('sigGrid');
    await app.waitFor(() => /No live readings right now/.test(grid.textContent), 'the explanation');
    assert.match(grid.textContent, /No live readings right now9 unavailable\. Nothing is estimated — press refresh to check again\./);

    /* After a scan in which this browser reached nothing, the next scans ask the cloud alone for a
       minute. A refresh asked for by a person does not wait for that. */
    app.state.browserDeriv = 'ok';
    app.click(app.doc.getElementById('refreshSigs'));
    await app.waitFor(() => grid.querySelectorAll('.sig-card').length === 6, 'six signal cards after Refresh');
    for (const card of grid.querySelectorAll('.sig-card')) {
      assert.match(card.querySelector('.sig-why').textContent, / · source: Deriv public candles · analysed in this browser$/);
    }
    assert.match(app.doc.getElementById('sigStamp').textContent, /^Updated \d\d:\d\d:\d\d · technical · live candles · 3 unavailable$/);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- no data */

test('Deriv answers without candles: all 20 instruments say "No data", and the cloud is not asked for them', async () => {
  const app = await bootApp({ world: { browserDeriv: 'empty' } });
  try {
    await app.openMarkets();
    for (const symbol of DERIV_SYMBOLS) {
      const row = app.row(symbol);
      assert.equal(row.badge, 'No data', symbol);
      assert.equal(row.source, 'source: Deriv public candles · no usable history', symbol);
      assert.match(row.title, new RegExp('^Deriv has no usable candle history for ' + symbol.replace(/[/ ]/g, (c) => '\\' + c) + ' right now \\('), symbol);
      assert.equal(row.hasRetry, true, symbol);
      assert.equal(row.levels, false, symbol);
    }
    assert.match(app.doc.getElementById('mktScanStatus').textContent, /^Signal column: 6 daily index readings · 20 with no data · /);
    for (const symbol of app.scannedByApiAfterEntering()) assert.ok(INDEX_SYMBOLS.includes(symbol), `${symbol}: Deriv said it has no history, so the cloud is not asked the same question`);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- cloud as the fallback */

test('this browser is blocked from Deriv but the cloud is healthy: all 20 instruments show the cloud\'s reading, labelled as such', async () => {
  const app = await bootApp({ world: { browserDeriv: 'down' } });
  try {
    await app.openMarkets();
    for (const symbol of DERIV_SYMBOLS) {
      const row = app.row(symbol);
      assert.match(row.badge, READING, symbol);
      assert.equal(row.source, CLOUD_DERIV_SOURCE, symbol);
    }
    assert.match(app.doc.getElementById('mktScanStatus').textContent, /^Signal column: 20 live · 6 daily index readings · /);

    /* These visitors depend on the cloud for every reading, and the Worker allows each visitor
       8 scan requests a minute (wrangler.jsonc). The four scans of entering the workspace and
       opening this table (sign-in pick, signal cards, repeated pick, the table itself) must
       leave room under that: readings of a moment ago are reused, and after the first failed
       attempt the browser is not tried before every request. */
    await app.waitFor(() => app.window.__aurumDiagnostics().scans >= 4, 'the four scans of entering and opening Markets');
    await new Promise((r) => setTimeout(r, 300));
    const scanRequests = app.requests.filter((r) => r.path === '/api/signals/scan');
    assert.ok(scanRequests.length <= 6, `${scanRequests.length} scan requests to the cloud, of the 8 a minute it allows`);
    assert.ok(app.window.__aurumDiagnostics().candles.connections <= 2, 'one attempt and one reconnect from this browser, not one per scan');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- sign-in screen */

test('sign-in screen: no connection to Deriv is opened; the first scan is answered by the cloud', async () => {
  const app = await bootApp();
  try {
    await app.waitFor(() => app.requests.some((r) => r.path === '/api/signals/scan' && r.status === 200), 'the sign-in screen scan');
    assert.deepEqual(app.sockets, [], 'no socket before the visitor enters the workspace');
    const asked = app.requests.filter((r) => r.path === '/api/signals/scan').flatMap((r) => r.body.symbols);
    assert.ok(asked.some((symbol) => DERIV_SYMBOLS.includes(symbol)), 'Deriv markets are read by the cloud here');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- the best-market panel */

/*
 * The report: the panel showed "US30 BUY 82%" from morning to night. US30 is
 * read once a day from daily closes, and a directional daily reading scores
 * 74, 82 or 90, more than a live 1m/5m/1h reading can reach. The pick is now
 * made among the live markets; the index has a line of its own, dated by the
 * daily bar it comes from.
 *
 * The Yahoo fixture rises by the same amount every day, so its daily reading
 * is a BUY by plain arithmetic; that direction is relied on, a score never is.
 */

test('best-market panel: the daily index reading has a line of its own, dated by its bar — it no longer stands where the pick goes', async () => {
  /* The newest daily bar is two days old and its session ended that day: a close. */
  const DAY = 86400;
  const barAt = Math.floor(nowSec() / DAY) * DAY - 2 * DAY + 14.5 * 3600;
  const app = await bootApp({ world: { yahooBars: { newestBarAt: barAt, session: { start: barAt, end: barAt + 6.5 * 3600 } } } });
  try {
    const check = (id, where) => {
      const panel = app.panel(id);
      /* First line: a live market, or the sentence that none has a setup. Which of the two
         depends on the fixture and is not asserted. An index it is not. */
      for (const symbol of INDEX_SYMBOLS) assert.ok(!panel.live.text.includes(symbol), `${where}: ${symbol} is not on the first line`);
      assert.ok(!/index CFD|Yahoo|Daily index trend/.test(panel.live.text), `${where}: nothing of a daily reading on the first line`);
      if (panel.live.direction) {
        assert.ok(PICK_MARKETS.includes(panel.live.symbol), `${where}: the pick is one of the live markets`);
        assert.match(panel.live.text, /source: Deriv public candles .+ · \d\d:\d\d:\d\d$/, `${where}: the pick says when it was read`);
      } else assert.equal(panel.live.text, NO_SETUP, where);

      /* Second line: the index, with the day of its data instead of a clock time. */
      assert.ok(panel.hasDaily, `${where}: the daily line is shown`);
      assert.ok(PICK_INDICES.includes(panel.daily.symbol), `${where}: one of the three indices`);
      assert.equal(panel.daily.direction, 'BUY', where);
      assert.match(panel.daily.text, new RegExp('^Daily index trend · daily close of ' + tradingDayText(barAt) + ' ' + panel.daily.symbol
        + ' BUY \\d+% index CFD · analysis only votes .+ · source: Yahoo Finance public daily data · AURUM cloud analysis$'), where);
      assert.ok(!/\d\d:\d\d:\d\d/.test(panel.daily.text), `${where}: no clock time on the daily line`);
      assert.match(panel.daily.title, /^A once-a-day reading from daily closing prices\./, `${where}: the line explains itself on hover`);
    };

    await app.waitFor(() => app.panel('authBestBody').ready, 'the sign-in screen panel');
    check('authBestBody', 'sign-in screen');
    assert.deepEqual(app.sockets, [], 'still no connection to Deriv from the sign-in screen');

    /* Inside the workspace the pick is read again, in this browser. The index line is the same. */
    await app.enter();
    await app.waitFor(() => app.window.__aurumDiagnostics().scans >= 3, 'the pick repeated after entering');
    await new Promise((r) => setTimeout(r, 40));
    check('ovBest', 'workspace');
    assert.equal(app.doc.getElementById('authBestBody').textContent, app.doc.getElementById('ovBest').textContent, 'both panels show the same lines');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('best-market panel, the reported case: an index that scores higher than every live market is no longer the pick', async () => {
  /* On the sign-in screen every reading is the cloud's. This test writes them itself: GBP/USD
     is SELL 61 and the other five live markets wait. Its candle time stays the fixture's, so
     it is live. The three indices are left as the Worker read them: BUY, and — like every
     directional daily reading — at 74 or more. Before the change the pick was the index. */
  const rewriteScan = (results) => results.map((reading) => {
    if (reading.error || INDEX_SYMBOLS.includes(reading.symbol)) return reading;
    if (reading.symbol === 'GBP/USD') return { ...reading, signal: 'SELL', bias: 'bearish', confidence: 61, votes: 'written by the test' };
    return { ...reading, signal: 'WAIT', bias: 'neutral', confidence: 30, votes: 'written by the test' };
  });
  const app = await bootApp({ world: { rewriteScan } });
  try {
    await app.waitFor(() => app.panel('authBestBody').ready, 'the sign-in screen panel');
    const panel = app.panel('authBestBody');
    assert.equal(panel.live.symbol, 'GBP/USD');
    assert.equal(panel.live.direction, 'SELL');
    assert.match(panel.live.text, /^GBP\/USD SELL 61% votes written by the test · source: Deriv public candles · AURUM cloud analysis · \d\d:\d\d:\d\d$/);

    assert.ok(PICK_INDICES.includes(panel.daily.symbol));
    assert.equal(panel.daily.direction, 'BUY');
    const indexScore = Number(/ BUY (\d+)% /.exec(panel.daily.text)[1]);
    assert.ok(indexScore > 61, `the index scores ${indexScore}, more than the pick, and is still not the pick`);
    assert.match(panel.daily.text, /^Daily index trend /);

    /* The panel's read still raises the signal alerts it always did: the new direction is
       remembered per market, so that it is announced once and not at every read. */
    assert.equal(app.window.localStorage.getItem('aurum_signalAlert_GBP/USD'), JSON.stringify('SELL|Deriv public candles \u00b7 AURUM cloud analysis|levels-v1'));
    assert.equal(app.window.localStorage.getItem('aurum_signalAlert_EUR/USD'), JSON.stringify('WAIT|Deriv public candles \u00b7 AURUM cloud analysis|levels-v1'));
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('best-market panel: while the index session is open the line says the bar is not final; without a session from Yahoo it only names the bar', async () => {
  const forming = nowSec() - 60;
  const fixedDay = Math.floor(Date.UTC(2026, 10, 11, 14, 30) / 1000);
  const cases = [
    [{ newestBarAt: forming, session: { start: forming, end: forming + 3600 } }, tradingDayText(forming) + ', session open \u2014 not final'],
    [{ newestBarAt: fixedDay }, 'daily bar of Wed 11 Nov']
  ];
  for (const [yahooBars, day] of cases) {
    const app = await bootApp({ world: { yahooBars } });
    try {
      await app.waitFor(() => app.panel('authBestBody').ready, 'the sign-in screen panel');
      const { daily } = app.panel('authBestBody');
      assert.ok(daily.text.startsWith('Daily index trend · ' + day + ' ' + daily.symbol + ' BUY '), `"${day}" in: ${daily.text}`);
      assert.ok(!daily.text.includes('daily close of'), 'a bar that is not known to be final is not called a close');
      assert.deepEqual(app.problems, []);
    } finally { await app.close(); }
  }
});

test('best-market panel: markets that could not be read are reported as such on their own line, not as "no setup"', async () => {
  const app = await bootApp({ world: { cloudDeriv: 'down', yahoo: 'down' } });
  try {
    /* Sign-in screen: the cloud is the only source here and reaches neither Deriv nor Yahoo. */
    await app.waitFor(() => app.panel('authBestBody').ready, 'the sign-in screen panel');
    const onSignIn = app.panel('authBestBody');
    /* The cloud could not reach the feed: the line also says who reads these markets next. */
    assert.equal(onSignIn.live.text, 'No live market could be read right now: 6 unavailable.' + NOT_ESTIMATED + READ_INSIDE);
    assert.equal(onSignIn.daily.text, 'Daily index trend: not read right now (3 unavailable). Nothing is estimated.');
    assert.deepEqual(app.sockets, [], 'still no connection to Deriv from the sign-in screen');

    /* Inside the workspace the pick is read again, this time with this browser's own candles:
       the six live markets are readable now, the three index CFDs still are not. The first
       line shows a pick or says that there is no setup; it reports nothing as unread. */
    await app.enter();
    await app.waitFor(() => !/No live market could be read/.test(app.panel('ovBest').live.text), 'the pick repeated after entering');
    const inside = app.panel('ovBest');
    if (!inside.live.direction) assert.equal(inside.live.text, NO_SETUP);
    assert.ok(!/Not read|could be read/.test(inside.live.text));
    assert.equal(inside.daily.text, 'Daily index trend: not read right now (3 unavailable). Nothing is estimated.');
    assert.equal(app.doc.getElementById('authBestBody').textContent, app.doc.getElementById('ovBest').textContent, 'both panels show the same lines');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('best-market panel: "this browser reads them inside" is said only where entering can change something', async () => {
  /* Markets that are closed (old candles) on the sign-in screen: entering does not open them, so nothing is promised. */
  const closed = await bootApp({ world: { candleAgeSec: 2 * 86400 } });
  try {
    await closed.waitFor(() => closed.panel('authBestBody').ready, 'the sign-in screen panel');
    assert.equal(closed.panel('authBestBody').live.text, 'No live market could be read right now: 6 stale (market closed or feed paused).' + NOT_ESTIMATED);
    assert.match(closed.panel('authBestBody').daily.text, /^Daily index trend /, 'the daily line does not depend on the live feed');
    assert.deepEqual(closed.problems, []);
  } finally { await closed.close(); }

  /* Neither the cloud nor this browser reaches the feed. On the sign-in screen the sentence
     is there; inside, where the browser has tried and failed as well, it is gone. */
  const app = await bootApp({ world: { cloudDeriv: 'down', browserDeriv: 'down' } });
  try {
    await app.waitFor(() => app.panel('authBestBody').ready, 'the sign-in screen panel');
    assert.equal(app.panel('authBestBody').live.text, 'No live market could be read right now: 6 unavailable.' + NOT_ESTIMATED + READ_INSIDE);
    await app.enter();
    await app.waitFor(() => app.window.__aurumDiagnostics().scans >= 3, 'the pick repeated after entering');
    await app.waitFor(() => !app.panel('ovBest').live.text.includes(READ_INSIDE), 'the sentence is withdrawn inside');
    assert.equal(app.panel('ovBest').live.text, 'No live market could be read right now: 6 unavailable.' + NOT_ESTIMATED);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('best-market panel: nothing to name on either line — each says what was read, what was not, and which day the indices are from', async () => {
  /* Written by the test: two live markets could not be read and the other four wait;
     two indices have no direction and the third could not be read. */
  const DAY = 86400;
  const barAt = Math.floor(nowSec() / DAY) * DAY - 3 * DAY + 14.5 * 3600;
  const failed = (symbol) => ({ symbol, error: 'FEED_ERROR', detail: 'written by the test', source: 'unavailable', data_source: 'unavailable' });
  const rewriteScan = (results) => results.map((reading) => {
    if (reading.error) return reading;
    if (['EUR/USD', 'USD/CAD', 'SPX500'].includes(reading.symbol)) return failed(reading.symbol);
    return { ...reading, signal: 'WAIT', bias: 'neutral', confidence: 30 };
  });
  const app = await bootApp({ world: { rewriteScan, yahooBars: { newestBarAt: barAt, session: { start: barAt, end: barAt + 6.5 * 3600 } } } });
  try {
    await app.waitFor(() => app.panel('authBestBody').ready, 'the sign-in screen panel');
    const panel = app.panel('authBestBody');
    assert.equal(panel.live.text, 'No directional setup in the live markets that could be read. Not read: 2 unavailable.' + NOT_ESTIMATED + READ_INSIDE);
    assert.equal(panel.daily.text, 'Daily index trend \u00b7 daily close of ' + tradingDayText(barAt) + ': no direction on NAS100, US30. Not read: 1 unavailable.');
    assert.equal(panel.live.direction + panel.daily.direction, '', 'no BUY or SELL badge anywhere');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('best-market panel: indices read from different days — the "no direction" line names no day rather than one of them', async () => {
  /* Each index has its own daily series in the cloud, kept for 15 minutes: around the opening
     bell one can still be yesterday's close while another is already today's forming bar. */
  const DAY = 86400;
  const barAt = Math.floor(nowSec() / DAY) * DAY - 3 * DAY + 14.5 * 3600;
  const rewriteScan = (results) => results.map((reading) => {
    if (reading.error) return reading;
    const waiting = { ...reading, signal: 'WAIT', bias: 'neutral', confidence: 30 };
    return reading.symbol === 'US30' ? { ...waiting, daily_bar_time: barAt + DAY, daily_bar_final: false } : waiting;
  });
  const app = await bootApp({ world: { rewriteScan, yahooBars: { newestBarAt: barAt, session: { start: barAt, end: barAt + 6.5 * 3600 } } } });
  try {
    await app.waitFor(() => app.panel('authBestBody').ready, 'the sign-in screen panel');
    assert.equal(app.panel('authBestBody').daily.text, 'Daily index trend: no direction on NAS100, US30, SPX500.');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('best-market panel: read again at every tick of its 10-minute timer — not at every second one', async () => {
  /* A read takes 4 seconds here. The page's timer ticks once per period, so a tick comes
     10 minutes after the previous read STARTED, which is 9 min 56 s after it ended. The
     panel used to ask for "10 minutes since the last result" as well, found each such tick
     4 seconds short and skipped it: it was read every 20 minutes. */
  const app = await bootApp({ world: { scanTakesMs: 4000 } });
  try {
    const asked = () => app.requests.filter((r) => r.path === '/api/signals/scan').length;
    const finished = () => app.window.__aurumDiagnostics().scans;
    const settle = () => new Promise((r) => setTimeout(r, 60));
    await app.waitFor(() => app.panel('authBestBody').ready, 'the first read');
    assert.equal(asked(), 1, 'no read besides the first before the timer ticks');
    await settle();
    assert.equal(asked(), 1);

    for (const reads of [2, 3, 4]) {
      app.advanceClock(TEN_MINUTES - 4000); /* the 4 seconds of the read itself have already passed */
      app.runIntervals(TEN_MINUTES);
      await app.waitFor(() => asked() === reads, `read ${reads}: at the tick, 10 minutes after the previous read started`);
      await app.waitFor(() => finished() === reads, `read ${reads} has finished`);
      await settle();
      assert.equal(asked(), reads, 'one read per tick');
      /* Each read brought current readings: the first line reports nothing as stale or unread. */
      const panel = app.panel('authBestBody');
      if (!panel.live.direction) assert.equal(panel.live.text, NO_SETUP, `read ${reads}`);
      assert.match(panel.daily.text, /^Daily index trend /, `read ${reads}`);
      assert.equal(app.window.__aurumDiagnostics().lastScan.live, 6, `read ${reads}: six live readings`);
    }
    assert.deepEqual(app.sockets, [], 'all of it on the sign-in screen, without a connection to Deriv');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('best-market panel: a repeated read keeps the previous lines, with their time, until its own result replaces them; a tick during a read starts no second one', async () => {
  /* Readings written by the test, so that the first line has a pick and a time to watch. */
  const written = (pick, direction, score) => (results) => results.map((reading) => {
    if (reading.error || INDEX_SYMBOLS.includes(reading.symbol)) return reading;
    if (reading.symbol === pick) return { ...reading, signal: direction, bias: direction === 'BUY' ? 'bullish' : 'bearish', confidence: score, votes: 'written by the test' };
    return { ...reading, signal: 'WAIT', bias: 'neutral', confidence: 30, votes: 'written by the test' };
  });
  const app = await bootApp({ world: { rewriteScan: written('GBP/USD', 'SELL', 61) } });
  try {
    const asked = () => app.requests.filter((r) => r.path === '/api/signals/scan').length;
    const settle = () => new Promise((r) => setTimeout(r, 60));
    const timeOf = (text) => /(\d\d:\d\d:\d\d)$/.exec(text)[1];
    await app.waitFor(() => app.panel('authBestBody').ready, 'the first read');
    const before = app.panel('authBestBody');
    assert.equal(before.live.symbol, 'GBP/USD');
    assert.ok(before.hasDaily);

    /* The next read is held back by the test, and will name another market. */
    let release = () => {};
    app.state.scanGate = () => new Promise((resolve) => { release = resolve; });
    app.state.rewriteScan = written('AUD/USD', 'BUY', 66);
    app.advanceClock(TEN_MINUTES);
    app.runIntervals(TEN_MINUTES);
    await app.waitFor(() => asked() === 2, 'the repeated read is under way');
    await settle();
    assert.equal(app.panel('authBestBody').text, before.text, 'the lines of the previous read are still shown, with the time of that read');

    /* Another tick while that read is still running: no second request, nothing redrawn differently. */
    app.runIntervals(TEN_MINUTES);
    await settle();
    assert.equal(asked(), 2);
    assert.equal(app.panel('authBestBody').text, before.text);

    app.state.scanGate = null;
    release();
    await app.waitFor(() => app.panel('authBestBody').live.symbol === 'AUD/USD', 'the new result replaces the lines');
    const after = app.panel('authBestBody');
    assert.equal(after.live.direction, 'BUY');
    assert.match(after.live.text, /^AUD\/USD BUY 66% /);
    assert.notEqual(timeOf(after.live.text), timeOf(before.live.text), 'and carries the time of the new read');
    assert.ok(after.hasDaily);
    assert.equal(app.doc.getElementById('ovBest').textContent, after.text, 'the workspace copy of the panel follows');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('best-market panel: before the very first result it says that it is reading, and shows no line', async () => {
  const app = await bootApp({ world: { scanGate: () => new Promise(() => {}) } });
  try {
    await app.waitFor(() => app.requests.some((r) => r.path === '/api/signals/scan'), 'the first read is under way');
    const panel = app.panel('authBestBody');
    assert.equal(panel.text, 'Scanning live markets\u2026');
    assert.equal(panel.ready, false);
    assert.equal(panel.hasDaily, false);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- other consumers of the same reading */

test('order ticket and analyzer use the browser reading: no "levels unavailable", and the cloud is not asked to analyse', async () => {
  const app = await bootApp({ world: { cloudDeriv: 'down' } });
  try {
    await app.enter();
    await app.open('trade');
    const select = app.doc.getElementById('chartSymbol');
    select.value = 'GBP/USD';
    select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    const note = app.doc.getElementById('levelsNote');
    await app.waitFor(() => /^(Levels from live analysis|No confirmed setup for GBP\/USD yet)/.test(note.textContent), 'the ticket note for GBP/USD');
    assert.ok(!/unavailable/i.test(note.textContent), 'levels are available');

    await app.open('signals');
    const symbol = app.doc.getElementById('azSymbol');
    symbol.value = 'USD/JPY';
    app.click(app.doc.getElementById('azRun'));
    await app.waitFor(() => !app.doc.getElementById('azResult').classList.contains('hidden'), 'the analysis result');
    assert.match(app.doc.getElementById('azMtf').textContent, / · source: Deriv public candles · analysed in this browser$/);
    assert.ok(app.doc.getElementById('azRationale').textContent.length > 20, 'the full technical write-up is shown');
    assert.equal(app.doc.getElementById('azMode').textContent, 'TECHNICAL');

    assert.deepEqual(app.requests.filter((r) => r.path === '/api/signals/analyze'), [], 'no analysis request to the cloud');
    for (const sent of app.scannedByApiAfterEntering()) assert.ok(INDEX_SYMBOLS.includes(sent), `${sent} was not sent to the cloud`);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('analyzer on a closed market: says the candles are old, does not blame the cloud, estimates nothing', async () => {
  const app = await bootApp({ world: { candleAgeSec: 4 * 3600 } });
  try {
    await app.enter();
    await app.open('signals');
    app.doc.getElementById('azSymbol').value = 'EUR/USD';
    app.click(app.doc.getElementById('azRun'));
    const empty = app.doc.getElementById('azEmpty');
    await app.waitFor(() => /Analysis unavailable/.test(empty.textContent), 'the analyzer message');
    assert.match(empty.textContent, /Analysis unavailableThe newest 1-minute candle for EUR\/USD is 4 h old, so the market is closed or the feed is paused\. No current reading is shown\. Nothing is estimated\.$/);
    assert.ok(!/cloud analysis service/.test(empty.textContent));
    assert.ok(app.doc.getElementById('azResult').classList.contains('hidden'), 'no result panel');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('analyzer when neither side reaches Deriv: both reasons, in sentences, and nothing estimated', async () => {
  const app = await bootApp({ world: { browserDeriv: 'down', cloudDeriv: 'down' } });
  try {
    await app.enter();
    await app.open('signals');
    app.doc.getElementById('azSymbol').value = 'EUR/USD';
    app.click(app.doc.getElementById('azRun'));
    const empty = app.doc.getElementById('azEmpty');
    await app.waitFor(() => /Analysis unavailable/.test(empty.textContent), 'the analyzer message');
    assert.match(empty.textContent, /Analysis unavailableThis browser: [^.]*Deriv public feed[^.]*\. AURUM cloud: Deriv public WebSocket connection failed\. Nothing is estimated\. Try again in a minute\.$/);
    assert.ok(app.doc.getElementById('azResult').classList.contains('hidden'), 'no result panel');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('calculator history is read by the browser when the cloud cannot reach Deriv', async () => {
  const app = await bootApp({ world: { cloudDeriv: 'down' } });
  try {
    await app.enter();
    await app.open('learn');
    app.click(app.doc.getElementById('volBtn'));
    const out = app.doc.getElementById('volOut');
    await app.waitFor(() => /Annualized realized volatility/.test(out.textContent), 'the volatility comparison');
    assert.ok(!/unavailable/.test(out.textContent), 'every ticked instrument has history');
    assert.deepEqual(app.requests.filter((r) => r.path === '/api/history/candles'), [], 'no history request to the cloud was needed');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- readings must not outlive their data */

test('a feed that goes silent: the table is scanned again on a clock and stops showing the old readings as live', async () => {
  const app = await bootApp({ world: { cloudDeriv: 'down' } });
  try {
    await app.openMarkets();
    for (const symbol of DERIV_SYMBOLS) assert.match(app.row(symbol).badge, READING, symbol);
    const scansBefore = app.window.__aurumDiagnostics().scans;

    /* No tick ever arrives in this test, so nothing but the clock can start another scan. */
    app.runIntervals(30000);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(app.window.__aurumDiagnostics().scans, scansBefore, 'not more than one scan per 90 seconds');

    app.state.browserDeriv = 'down';
    app.advanceClock(91000);
    app.runIntervals(30000);
    await app.waitFor(() => DERIV_SYMBOLS.every((symbol) => app.row(symbol).badge === 'Feed unavailable'), 'the table after the clock-driven scan');
    for (const symbol of DERIV_SYMBOLS) assert.equal(app.row(symbol).levels, false, `${symbol}: the old levels are gone`);

    /* Coming back to the tab asks again at once. */
    app.state.browserDeriv = 'ok';
    app.advanceClock(91000);
    app.doc.dispatchEvent(new app.window.Event('visibilitychange'));
    await app.waitFor(() => DERIV_SYMBOLS.every((symbol) => READING.test(app.row(symbol).badge)), 'readings after returning to the tab');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('a market that closes while its levels are on the order ticket: the levels are withdrawn, not left as "live"', async () => {
  const app = await bootApp({ world: { cloudDeriv: 'down' } });
  try {
    await app.enter();
    await app.open('trade');
    const select = app.doc.getElementById('chartSymbol');
    const choose = (symbol) => { select.value = symbol; select.dispatchEvent(new app.window.Event('change', { bubbles: true })); };
    const strip = app.doc.getElementById('chartLevels');
    choose('USD/CAD');
    await app.waitFor(() => /LIVE SIGNAL LEVELS/.test(strip.textContent), 'levels on the chart strip while the market is live');

    /* The market closes: the candles stop where they are, and time moves on. */
    app.state.candleAgeSec = 3600;
    app.advanceClock(120000);
    choose('EUR/USD');
    choose('USD/CAD');
    const note = app.doc.getElementById('levelsNote');
    await app.waitFor(() => /No current reading is shown/.test(note.textContent), 'the ticket note for a closed market');
    assert.match(note.textContent, /^The newest 1-minute candle for USD\/CAD is \d+ min old, so the market is closed or the feed is paused\. No current reading is shown\.$/);
    assert.ok(!/LIVE SIGNAL LEVELS/.test(strip.textContent), 'the strip no longer calls the old levels live');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- the PC app is unchanged */

test('PC app: scans go to the local API as before — no candle connection from the browser, the old labels, "No data" on failure', async () => {
  const failing = new Set(['EUR/USD', 'VOL 75']);
  const scanned = [];
  const pcApi = (path, body) => {
    if (path === '/api/health') return { status: 200, body: { ok: true } };
    if (path === '/api/signals/scan') {
      scanned.push(...body.symbols);
      return {
        status: 200,
        body: {
          results: body.symbols.map((symbol) => (failing.has(symbol)
            ? { symbol, error: 'FEED_ERROR', detail: 'deriv timeout' }
            : { symbol, signal: 'WAIT', bias: 'neutral', confidence: 20, votes: 'fixture', wait_reason: 'MTF_NO_ALIGNMENT', wait_detail: 'fixture', data_ok: true, tf: 'MTF 1m/5m/1h', model: 'technical' }))
        }
      };
    }
    return null;
  };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi });
  try {
    await app.openMarkets();

    for (const symbol of DERIV_SYMBOLS) {
      const row = app.row(symbol);
      if (failing.has(symbol)) {
        assert.equal(row.badge, 'No data', `${symbol}: the PC wording for a failed market is unchanged`);
        assert.equal(row.source, 'source: Deriv public candles · fallback (Exness unavailable: Exness bridge is not connected in this tab.)', symbol);
        assert.equal(row.title, 'deriv timeout', 'the local API\'s own reason is the tooltip');
        assert.equal(row.hasRetry, true);
      } else {
        assert.match(row.badge, /^Wait/, symbol);
        assert.equal(row.source, 'source: Deriv public candles · fallback (Exness unavailable: Exness bridge is not connected in this tab.)', symbol);
      }
    }
    for (const symbol of DERIV_SYMBOLS) assert.ok(scanned.includes(symbol), `${symbol} was scanned by the local API`);

    /* The cloud viewer's clock-driven scan does nothing here. */
    const scansByApi = scanned.length;
    app.advanceClock(91000);
    app.runIntervals(30000);
    app.doc.dispatchEvent(new app.window.Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(scanned.length, scansByApi, 'no extra scan on the PC app');

    assert.equal(app.sockets.length, 1, 'the price stream only: the PC app opens no candle connection');
    assert.ok(app.sockets[0].sent.every((message) => message.style === 'ticks'));
    assert.ok(app.doc.getElementById('mktScanStatus').classList.contains('hidden'), 'the cloud viewer status line stays hidden');
    assert.equal(app.doc.getElementById('aboutAnalysis').textContent, 'Exness MT5 first · labelled Deriv / Yahoo fallback');
    /* The best-market panel keeps the PC wording on its first line, although one of its markets
       failed: the local API said WAIT for the others. The three indices are labelled as the
       daily fallback they are in the PC app, and stand on the second line. */
    assert.equal(app.panel('authBestBody').live.text, NO_SETUP);
    assert.equal(app.panel('authBestBody').daily.text, 'Daily index trend: no direction on NAS100, US30, SPX500.');
    assert.deepEqual(app.warnings.filter((line) => line.startsWith('[aurum]')), []);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('PC app, best-market panel: the pick is a live market; a daily index reading from the local API gets its own line', async () => {
  /* Readings written by the test, in the two shapes the local API answers with. US30 scores
     90 on the daily scale; the strongest live market is GBP/USD at 61. */
  const mtf = (symbol, signal, confidence) => ({
    symbol, signal, bias: signal === 'BUY' ? 'bullish' : signal === 'SELL' ? 'bearish' : 'neutral', confidence, votes: 'live reading written by the test',
    data_ok: true, tf: 'MTF 1m/5m/1h', model: 'technical', source: 'Deriv public candles',
    wait_reason: signal === 'WAIT' ? 'MTF_NO_ALIGNMENT' : null, wait_detail: signal === 'WAIT' ? 'written by the test' : null
  });
  const daily = (symbol, signal, confidence) => ({
    symbol, signal, bias: signal === 'BUY' ? 'bullish' : signal === 'SELL' ? 'bearish' : 'neutral', confidence, votes: 'daily reading written by the test',
    data_ok: true, entry: null, stop_loss: null, tp1: null, tp2: null, tf: 'DAILY (index)', model: 'technical-daily', source: 'Yahoo Finance public daily data',
    wait_reason: signal === 'WAIT' ? 'daily_no_setup' : null, wait_detail: signal === 'WAIT' ? 'written by the test' : null
  });
  const answers = {
    'GBP/USD': mtf('GBP/USD', 'SELL', 61), 'AUD/USD': mtf('AUD/USD', 'BUY', 57),
    NAS100: daily('NAS100', 'WAIT', 58), US30: daily('US30', 'BUY', 90), SPX500: daily('SPX500', 'BUY', 74)
  };
  const pcApi = (path, body) => {
    if (path === '/api/health') return { status: 200, body: { ok: true } };
    if (path === '/api/signals/scan') return { status: 200, body: { results: body.symbols.map((symbol) => answers[symbol] || mtf(symbol, 'WAIT', 20)) } };
    return null;
  };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi });
  try {
    await app.waitFor(() => app.panel('authBestBody').ready, 'the sign-in screen panel');
    const panel = app.panel('authBestBody');
    const fallback = ' · fallback (Exness unavailable: Exness bridge is not connected in this tab.)';

    assert.equal(panel.live.symbol, 'GBP/USD', 'the strongest live market, not the index that scores 90');
    assert.equal(panel.live.direction, 'SELL');
    assert.ok(panel.live.text.startsWith('GBP/USD SELL 61% votes live reading written by the test · source: Deriv public candles' + fallback + ' · '), panel.live.text);
    assert.match(panel.live.text, / · \d\d:\d\d:\d\d$/);

    /* The local API does not send the day of its daily bar: the line names no day, and no clock time either. */
    assert.equal(panel.daily.text, 'Daily index trend US30 BUY 90% index CFD · analysis only votes daily reading written by the test · source: Yahoo Finance public daily data' + fallback);
    assert.equal(panel.daily.symbol, 'US30');
    assert.equal(panel.daily.direction, 'BUY');

    assert.equal(app.sockets.length, 0, 'the sign-in screen opens no socket in the PC app either');
    assert.deepEqual(app.warnings.filter((line) => line.startsWith('[aurum]')), []);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('best-market panel: text from a reading is shown as text — markup in it is never parsed, a score that is not a number shows as 0', async () => {
  const votes = 'votes <b id="injected-by-votes">bold</b> <img src=x onerror="window.__injected=1">';
  const pcApi = (path, body) => {
    if (path === '/api/health') return { status: 200, body: { ok: true } };
    if (path === '/api/signals/scan') {
      return {
        status: 200,
        body: {
          results: body.symbols.map((symbol) => (PICK_INDICES.includes(symbol)
            ? { symbol, signal: 'BUY', bias: 'bullish', confidence: '<i id="injected-by-score">90</i>', votes, data_ok: true, tf: 'DAILY (index)', model: 'technical-daily', source: 'Yahoo <u id="injected-by-source">Finance</u>' }
            : { symbol, signal: 'SELL', bias: 'bearish', confidence: '<i id="injected-by-score-2">61</i>', votes, data_ok: true, tf: 'MTF 1m/5m/1h', model: 'technical', source: 'Deriv <u id="injected-by-source-2">candles</u>' }))
        }
      };
    }
    return null;
  };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi });
  try {
    await app.waitFor(() => app.panel('authBestBody').ready, 'the sign-in screen panel');
    const panel = app.panel('authBestBody');
    assert.ok(panel.live.direction && panel.daily.direction, 'both lines show a reading');
    for (const id of ['injected-by-votes', 'injected-by-score', 'injected-by-score-2', 'injected-by-source', 'injected-by-source-2']) {
      assert.equal(app.doc.getElementById(id), null, `${id}: no element was created from a reading`);
    }
    for (const el of [app.doc.getElementById('authBestBody'), app.doc.getElementById('ovBest')]) {
      assert.equal(el.querySelectorAll('img, i, u, script').length, 0);
    }
    assert.equal(app.window.__injected, undefined, 'no handler from a reading ran');
    assert.ok(panel.live.text.includes(votes), 'the text itself is shown, tags and all');
    assert.ok(panel.daily.text.includes(votes));
    assert.match(panel.live.text, / SELL 0% /, 'a score that is not a number is shown as 0, not inserted');
    assert.match(panel.daily.text, / BUY 0% /);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('PC app, best-market panel: an index the local API could not read is said so on the daily line; the first line keeps the PC wording', async () => {
  const reading = (symbol) => ({
    symbol, signal: 'WAIT', bias: 'neutral', confidence: 20, votes: 'written by the test', data_ok: true,
    tf: PICK_INDICES.includes(symbol) ? 'DAILY (index)' : 'MTF 1m/5m/1h', model: PICK_INDICES.includes(symbol) ? 'technical-daily' : 'technical',
    source: PICK_INDICES.includes(symbol) ? 'Yahoo Finance public daily data' : 'Deriv public candles', wait_reason: 'written by the test', wait_detail: 'written by the test'
  });
  const failed = (symbol) => ({ symbol, error: 'FEED_ERROR', detail: 'written by the test', source: 'unavailable', data_source: 'unavailable' });
  const cases = [
    [['SPX500'], 'Daily index trend: no direction on NAS100, US30. Not read: 1 unavailable.'],
    [PICK_INDICES, 'Daily index trend: not read right now (3 unavailable). Nothing is estimated.']
  ];
  for (const [unreadable, dailyLine] of cases) {
    const pcApi = (path, body) => {
      if (path === '/api/health') return { status: 200, body: { ok: true } };
      if (path === '/api/signals/scan') return { status: 200, body: { results: body.symbols.map((symbol) => (unreadable.includes(symbol) || symbol === 'USD/JPY' ? failed(symbol) : reading(symbol))) } };
      return null;
    };
    const app = await bootApp({ origin: PC_ORIGIN, pcApi });
    try {
      await app.waitFor(() => app.panel('authBestBody').ready, 'the sign-in screen panel');
      const panel = app.panel('authBestBody');
      /* USD/JPY failed as well: the PC app's first line does not count unread markets, as before. */
      assert.equal(panel.live.text, NO_SETUP);
      assert.equal(panel.daily.text, dailyLine);
      assert.deepEqual(app.problems, []);
    } finally { await app.close(); }
  }
});

/* ---------------------------------------------------------------- live confidence */

/* The score of a BUY/SELL reading moves with the price since the reading was first made
   (src/signalrun.js). These tests run the PC app, where the local API stand-in answers
   with readings written by the test and the stand-in feed ticks at a known price, so the
   distance between a reading's entry and the live price is known. None of the numbers
   is a market price, and no assertion says what an analysis would conclude. */
const EUR_TICK = basePriceFor('frxEURUSD');
const GOLD_TICK = basePriceFor('frxXAUUSD');
const PIP = 0.0001;
/* A BUY scored 70, read 6 pips below the price the feed ticks at: 12-pip stop, 18-pip target. */
const LIVE_BUY = {
  symbol: 'EUR/USD', signal: 'BUY', bias: 'bullish', confidence: 70, mtf_signal: 'BUY_CONFIRMED', votes: 'written by the test', data_ok: true,
  entry: EUR_TICK - 6 * PIP, price: EUR_TICK - 6 * PIP, stop_loss: EUR_TICK - 18 * PIP, tp1: EUR_TICK + 12 * PIP, tp2: EUR_TICK + 26 * PIP,
  tf: 'MTF 1m/5m/1h', model: 'technical', source: 'Deriv public candles'
};
const LIVE_DAILY = {
  symbol: 'US30', signal: 'BUY', bias: 'bullish', confidence: 90, votes: 'daily reading written by the test', data_ok: true,
  entry: null, stop_loss: null, tp1: null, tp2: null, tf: 'DAILY (index)', model: 'technical-daily', source: 'Yahoo Finance public daily data'
};
const liveWait = (symbol) => ({ symbol, signal: 'WAIT', bias: 'neutral', confidence: 20, votes: 'written by the test', wait_reason: 'MTF_NO_ALIGNMENT', wait_detail: 'written by the test', data_ok: true, tf: 'MTF 1m/5m/1h', model: 'technical', source: 'Deriv public candles' });
const liveScanApi = (path, body) => {
  if (path === '/api/health') return { status: 200, body: { ok: true } };
  if (path === '/api/signals/scan') return { status: 200, body: { results: body.symbols.map((symbol) => (symbol === 'EUR/USD' ? LIVE_BUY : symbol === 'US30' ? LIVE_DAILY : liveWait(symbol))) } };
  return null;
};
/* One more tick on the price stream, as Deriv would send it. */
const pushTick = (app, code, quote) => {
  const stream = app.sockets.find((entry) => entry.sent.some((message) => message.style === 'ticks'));
  assert.ok(stream, 'the price stream is open');
  stream.socket.onmessage({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: code, quote, epoch: nowSec() } }) });
};
const NO_LEVELS = 'Daily reading with no entry, stop or target: this score moves only when one of its daily votes changes.';
const CLOCK = '\\d\\d:\\d\\d:\\d\\d';

test('live confidence, scanner cards: the score moves with the price since the reading, and the card says by how much', async () => {
  const app = await bootApp({ origin: PC_ORIGIN, pcApi: liveScanApi, world: { ticks: true } });
  try {
    await app.enter();
    await app.open('signals');
    const card = (symbol) => [...app.doc.querySelectorAll('#sigGrid .sig-card')].find((el) => el.querySelector('.sym-name').textContent === symbol);
    const shown = (symbol) => {
      const el = card(symbol);
      return el ? { score: el.querySelector('[data-live-conf]').textContent, bar: el.querySelector('.conf-bar i').style.width, note: el.querySelector('.sig-live').textContent } : null;
    };
    /* The reading says 70. The feed ticks 6 pips above its entry, a third of the way to the target: 70 + 5. */
    await app.waitFor(() => shown('EUR/USD') && shown('EUR/USD').score === '75%', 'the card to show the score at the live price');
    assert.equal(shown('EUR/USD').bar, '75%');
    assert.match(shown('EUR/USD').note, new RegExp('^6\\.0 pips with this BUY \u00b7 33% of the way to target 1 \u00b7 first read at 49\\.99940, ' + CLOCK + ' \u00b7 score as read 70%$'));

    /* The price falls to 6 pips below the entry, half-way to the stop: 70 - 15. No new scan is needed. */
    const scans = app.requests.filter((r) => r.path === '/api/signals/scan').length;
    pushTick(app, 'frxEURUSD', EUR_TICK - 12 * PIP);
    assert.equal(shown('EUR/USD').score, '55%');
    assert.equal(shown('EUR/USD').bar, '55%');
    assert.match(shown('EUR/USD').note, /^6\.0 pips against this BUY \u00b7 50% of the way to the stop \u00b7 first read at 49\.99940, /);
    assert.equal(app.requests.filter((r) => r.path === '/api/signals/scan').length, scans, 'the tick alone moved the score');

    /* Through the stop: the reading is over, and a price that comes back does not revive it. */
    pushTick(app, 'frxEURUSD', EUR_TICK - 19 * PIP);
    assert.equal(shown('EUR/USD').score, '40%');
    assert.match(shown('EUR/USD').note, new RegExp('^Stop level reached at ' + CLOCK + ' \u00b7 this BUY reading \\(first read at 49\\.99940, ' + CLOCK + '\\) is over \u00b7 score as read 70%$'));
    pushTick(app, 'frxEURUSD', EUR_TICK);
    assert.equal(shown('EUR/USD').score, '40%');
    assert.match(shown('EUR/USD').note, /^Stop level reached at /);

    /* The next analysis says BUY again: a new reading, followed from its own entry. */
    app.click(app.doc.getElementById('refreshSigs'));
    await app.waitFor(() => shown('EUR/USD') && shown('EUR/USD').score === '75%', 'a new reading after the refresh');
    assert.match(shown('EUR/USD').note, /^6\.0 pips with this BUY /);

    /* A daily index reading has no levels: its score is the reading's own, and the card says why it stands still. */
    assert.deepEqual(shown('US30'), { score: '90%', bar: '90%', note: NO_LEVELS });
    /* WAIT has nothing to follow. */
    assert.deepEqual(shown('GBP/USD'), { score: '20%', bar: '20%', note: '' });
    /* Both are left as they are when the next tick repaints the page. */
    pushTick(app, 'frxEURUSD', EUR_TICK);
    assert.deepEqual(shown('US30'), { score: '90%', bar: '90%', note: NO_LEVELS });
    assert.deepEqual(shown('GBP/USD'), { score: '20%', bar: '20%', note: '' });
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('live confidence, Markets and Overview: the same reading shows the same score everywhere', async () => {
  const app = await bootApp({ origin: PC_ORIGIN, pcApi: liveScanApi, world: { ticks: true } });
  try {
    await app.openMarkets();
    await app.waitFor(() => app.row('EUR/USD').badge === 'Buy 75%', 'the Markets badge at the live price');
    pushTick(app, 'frxEURUSD', EUR_TICK - 12 * PIP);
    assert.equal(app.row('EUR/USD').badge, 'Buy 55%', 'the badge follows the tick');
    assert.match(app.row('GBP/USD').badge, /^Wait/);

    await app.open('signals');
    await app.waitFor(() => app.doc.querySelector('#sigGrid .sig-card [data-live-conf="EUR/USD"]'), 'the scanner card');
    assert.equal(app.doc.querySelector('#sigGrid .sig-card [data-live-conf="EUR/USD"]').textContent, '55%');
    await app.open('overview');
    await app.waitFor(() => app.doc.querySelector('#ovSignals [data-live-conf="EUR/USD"]'), 'the Overview signal list');
    assert.equal(app.doc.querySelector('#ovSignals [data-live-conf="EUR/USD"]').textContent, '55%');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('live confidence, Sniper alerts: both tables carry a Confidence column, and the detail line gives the full sentence', async () => {
  /* One more reading: a SELL that arrives without a score. */
  const noScore = { symbol: 'AUD/USD', signal: 'SELL', bias: 'bearish', mtf_signal: 'SELL_CONFIRMED', votes: 'written by the test', data_ok: true, entry: 60, price: 60, stop_loss: 60.0012, tp1: 59.9982, tp2: 59.9968, tf: 'MTF 1m/5m/1h', model: 'technical', source: 'Deriv public candles' };
  let eur = LIVE_BUY;
  const pcApi = (path, body) => {
    const answer = liveScanApi(path, body);
    return path === '/api/signals/scan' ? { ...answer, body: { results: answer.body.results.map((r) => (r.symbol === 'AUD/USD' ? noScore : r.symbol === 'EUR/USD' ? eur : r)) } } : answer;
  };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi, world: { ticks: true } });
  try {
    await app.enter();
    await app.open('sniper');
    const doc = app.doc;
    const headers = (table) => [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    const watchTable = doc.getElementById('sniperWatchList').closest('table');
    assert.deepEqual(headers(watchTable), ['Notify', 'Market', 'Signal', 'Confidence', 'Timeframe', 'Entry', 'SL', 'TP1', 'Source', 'View']);

    /* Choose four markets: one with a BUY, one the scan reads as WAIT, one whose reading has no score,
       and an index with a daily BUY that has no entry, stop or target. */
    app.click(doc.getElementById('sniperPickerToggle'));
    const rowOf = (symbol) => { const box = doc.querySelector('[data-sniper-watch="' + symbol + '"]'); return box ? box.closest('tr') : null; };
    await app.waitFor(() => rowOf('EUR/USD') && rowOf('EUR/USD').querySelector('[data-live-conf]'), 'a scanned row for EUR/USD');
    for (const symbol of ['EUR/USD', 'GBP/USD', 'AUD/USD', 'US30']) {
      const box = doc.querySelector('[data-sniper-watch="' + symbol + '"]');
      box.checked = true;
      box.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    }
    const cells = (symbol) => [...rowOf(symbol).children].map((td) => td.textContent);
    await app.waitFor(() => cells('EUR/USD')[3] === '75%6.0 pips with', 'the live score in the selected-markets table');
    assert.equal(cells('EUR/USD').length, headers(watchTable).length, 'one cell under every header');
    assert.equal(cells('GBP/USD')[3], '20%', 'a WAIT shows the score as read, with nothing to follow');
    assert.equal(cells('AUD/USD')[3], '\u2014', 'a reading without a score shows a dash, not 0%');
    assert.equal(cells('US30')[3], '90%', 'a daily reading shows its score as read: there is no level to measure from');

    /* The setups table lists the BUYs and the SELL, not the WAIT. */
    const setups = () => doc.querySelector('#sniperSignalList table');
    assert.deepEqual(headers(setups()), ['Market', 'Signal', 'Confidence', 'Timeframe', 'Entry', 'SL', 'TP1', 'Source']);
    const setupCells = (symbol) => { const tr = [...setups().querySelectorAll('tbody tr')].find((el) => el.children[0].textContent === symbol); return tr ? [...tr.children].map((td) => td.textContent) : null; };
    assert.equal(setups().querySelectorAll('tbody tr').length, 3);
    assert.equal(setupCells('EUR/USD').length, 8);
    assert.equal(setupCells('EUR/USD')[2], '75%6.0 pips with');
    assert.equal(setupCells('AUD/USD')[2], '\u2014');
    assert.equal(setupCells('US30')[2], '90%');
    assert.equal(setupCells('GBP/USD'), null);

    /* The eye icon: the detail line. */
    app.click(doc.querySelector('[data-sniper-view="EUR/USD"]'));
    const detail = doc.getElementById('sniperSelectedDetail');
    assert.match(detail.textContent, /Confidence: 75% \u00b7 Source: /);
    /* This box styles <b> as a heading on a line of its own: the score stays inside its sentence. */
    assert.equal(detail.querySelector('.hint [data-live-conf]').tagName, 'SPAN');
    assert.match(detail.querySelector('[data-live-note]').textContent, /^6\.0 pips with this BUY \u00b7 33% of the way to target 1 \u00b7 first read at 49\.99940, /);

    /* One tick against the reading moves all three. */
    pushTick(app, 'frxEURUSD', EUR_TICK - 12 * PIP);
    assert.equal(cells('EUR/USD')[3], '55%6.0 pips against');
    assert.equal(setupCells('EUR/USD')[2], '55%6.0 pips against');
    assert.match(detail.textContent, /Confidence: 55% \u00b7 Source: /);
    assert.match(detail.querySelector('[data-live-note]').textContent, /^6\.0 pips against this BUY \u00b7 50% of the way to the stop /);
    assert.equal(cells('US30')[3], '90%', 'the daily reading is left as it was');
    assert.equal(setupCells('US30')[2], '90%');
    assert.equal(cells('GBP/USD')[3], '20%');

    /* The scanner reads EUR/USD again, as WAIT. These tables still hold the BUY of the last market scan:
       its row shows the score as read and says that it is not the newest reading. */
    eur = liveWait('EUR/USD');
    await app.open('signals');
    app.click(doc.getElementById('refreshSigs'));
    await app.waitFor(() => liveCard(app, 'EUR/USD') && liveCard(app, 'EUR/USD').direction === 'WAIT', 'the newer reading on the scanner card');
    pushTick(app, 'frxEURUSD', EUR_TICK);
    assert.equal(cells('EUR/USD')[2], 'BUY', 'the row is still the BUY');
    assert.equal(cells('EUR/USD')[3], '70%not the newest reading');
    assert.equal(setupCells('EUR/USD')[2], '70%not the newest reading');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('live confidence, Gold monitor: the score is shown, moves with the gold price, and is withdrawn with the analysis', async () => {
  /* A SELL scored 71, read 3 dollars above the price the feed ticks at: 15-dollar stop, 22.5-dollar target. */
  const sell = {
    symbol: 'XAU/USD', signal: 'SELL', bias: 'bearish', confidence: 71, mtf_signal: 'SELL_CONFIRMED', votes: '1m -3 SELL \u00b7 5m -3 SELL \u00b7 1h -3 SELL', data_ok: true,
    entry: GOLD_TICK + 3, price: GOLD_TICK + 3, stop_loss: GOLD_TICK + 18, tp1: GOLD_TICK - 19.5, tp2: GOLD_TICK - 37,
    rationale: 'written by the test', risks: [], model: 'technical', source: 'Deriv public candles'
  };
  const wait = { symbol: 'XAU/USD', signal: 'WAIT', bias: 'neutral', confidence: 38, mtf_signal: 'NO_CONFIRMATION', votes: '1m +1 WAIT \u00b7 5m -1 WAIT \u00b7 1h +0 WAIT', data_ok: true, entry: GOLD_TICK, stop_loss: GOLD_TICK - 4, tp1: GOLD_TICK + 4, tp2: GOLD_TICK + 8, rationale: 'written by the test', risks: [], model: 'technical' };
  let answer = sell;
  const pcApi = (path, body) => {
    if (path === '/api/signals/analyze') return answer ? { status: 200, body: { ...answer, latest_candle_time: nowSec() } } : { status: 503, body: { error: 'written by the test' } };
    return liveScanApi(path, body);
  };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi, world: { ticks: true } });
  try {
    await app.enter();
    const doc = app.doc;
    const text = (id) => doc.getElementById(id).textContent;
    assert.equal(text('goldConfidence'), '\u2014', 'nothing before the first analysis');
    /* The monitor analyses only once it has a fresh gold price: let the feed's first ticks arrive. */
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    await app.open('gold');
    await app.waitFor(() => text('goldSignal') === 'SELL', 'the first gold analysis');

    /* 3 dollars with the SELL, 13% of the way to the target: 71 + 2. */
    assert.equal(text('goldConfidence'), '73%');
    assert.equal(doc.getElementById('goldConfidenceBar').style.width, '73%');
    assert.match(text('goldConfidenceNote'), new RegExp('^\\$3\\.00 with this SELL \u00b7 13% of the way to target 1 \u00b7 first read at 183\\.00, ' + CLOCK + ' \u00b7 score as read 71%$'));

    /* Gold rises to 7.5 dollars above the entry, half-way to the stop: 71 - 15. */
    pushTick(app, 'frxXAUUSD', GOLD_TICK + 10.5);
    assert.equal(text('goldConfidence'), '56%');
    assert.equal(doc.getElementById('goldConfidenceBar').style.width, '56%');
    assert.match(text('goldConfidenceNote'), /^\$7\.50 against this SELL \u00b7 50% of the way to the stop \u00b7 first read at 183\.00, /);

    /* The next analysis is WAIT: the score as read, and nothing to follow. */
    answer = wait;
    app.click(doc.getElementById('goldAnalyzeBtn'));
    await app.waitFor(() => text('goldSignal') === 'WAIT', 'the WAIT analysis');
    assert.equal(text('goldConfidence'), '38%');
    assert.equal(text('goldConfidenceNote'), 'No confirmed direction, so there is no entry, stop or target to follow.');

    /* The analysis fails (the local API, and the browser's own read of Deriv behind it): no score is left standing. */
    answer = null;
    app.state.browserDeriv = 'down';
    app.click(doc.getElementById('goldAnalyzeBtn'));
    await app.waitFor(() => text('goldSignalBadge') === 'UNAVAILABLE', 'the failed analysis');
    assert.equal(text('goldConfidence'), '\u2014');
    assert.equal(doc.getElementById('goldConfidenceBar').style.width, '0%');
    assert.equal(text('goldConfidenceNote'), 'No current analysis, so no score is shown.');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('live confidence, Gold monitor: a gold price that has gone stale no longer moves the score', async () => {
  const sell = {
    symbol: 'XAU/USD', signal: 'SELL', bias: 'bearish', confidence: 71, mtf_signal: 'SELL_CONFIRMED', votes: 'written by the test', data_ok: true,
    entry: GOLD_TICK + 3, price: GOLD_TICK + 3, stop_loss: GOLD_TICK + 18, tp1: GOLD_TICK - 19.5, tp2: GOLD_TICK - 37, rationale: 'written by the test', risks: [], model: 'technical'
  };
  const pcApi = (path, body) => (path === '/api/signals/analyze' ? { status: 200, body: { ...sell, latest_candle_time: nowSec() } } : liveScanApi(path, body));
  const app = await bootApp({ origin: PC_ORIGIN, pcApi, world: { ticks: true } });
  try {
    await app.enter();
    const doc = app.doc;
    const text = (id) => doc.getElementById(id).textContent;
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    await app.open('gold');
    await app.waitFor(() => text('goldSignal') === 'SELL', 'the first gold analysis');
    assert.equal(text('goldConfidence'), '73%', 'moved by the fresh price');

    /* Auto-refresh off, so the analysis stays on screen; then no tick for more than two minutes. */
    const auto = doc.getElementById('goldAuto');
    auto.checked = false;
    auto.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    app.advanceClock(130000);
    app.runIntervals(10000);
    assert.equal(text('goldSignal'), 'SELL', 'the analysis is still shown');
    assert.equal(text('goldConfidence'), '71%', 'the score as read: an old price is not a live price');
    assert.match(text('goldConfidenceNote'), /^No live price right now \u00b7 first read at 183\.00, /);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* The scanner cards are a snapshot until Refresh; other views analyse the same markets again in the meantime. */
const liveCard = (app, symbol) => {
  const el = [...app.doc.querySelectorAll('#sigGrid .sig-card')].find((card) => card.querySelector('.sym-name').textContent === symbol);
  return el ? { direction: el.querySelector('.badge').textContent, score: el.querySelector('[data-live-conf]').textContent, bar: el.querySelector('.conf-bar i').style.width, note: el.querySelector('.sig-live').textContent } : null;
};
/* The local API stand-in, with the EUR/USD reading chosen by the test at each moment. */
const liveApiWith = (eurusd) => (path, body) => {
  const answer = liveScanApi(path, body);
  return path === '/api/signals/scan' ? { ...answer, body: { results: answer.body.results.map((r) => (r.symbol === 'EUR/USD' ? eurusd() : r)) } } : answer;
};

test('live confidence: a card older than the newest analysis of its market keeps its own score and says so', async () => {
  let eur = LIVE_BUY;
  const app = await bootApp({ origin: PC_ORIGIN, pcApi: liveApiWith(() => eur), world: { ticks: true } });
  try {
    await app.enter();
    await app.open('signals');
    await app.waitFor(() => liveCard(app, 'EUR/USD') && liveCard(app, 'EUR/USD').score === '75%', 'the BUY card at the live price');

    /* The Markets table analyses every market again, and now reads EUR/USD as WAIT. The card still says BUY. */
    const superseded = { direction: 'BUY', score: '70%', bar: '70%', note: 'This BUY reading is no longer the newest for this market: refresh to see the latest.' };
    eur = liveWait('EUR/USD');
    await app.open('markets');
    await app.waitFor(() => /^Wait/.test(app.row('EUR/USD').badge), 'the newer reading in the Markets table');
    pushTick(app, 'frxEURUSD', EUR_TICK + 3 * PIP);
    assert.deepEqual(liveCard(app, 'EUR/USD'), superseded, 'the next tick does not leave the old sentence standing');
    await app.open('signals');
    assert.deepEqual(liveCard(app, 'EUR/USD'), superseded, 'nor does drawing the card again');

    /* Later the market is read as SELL: the BUY card does not borrow the SELL reading's numbers. */
    eur = { ...LIVE_BUY, signal: 'SELL', bias: 'bearish', mtf_signal: 'SELL_CONFIRMED', confidence: 64, entry: EUR_TICK + 6 * PIP, price: EUR_TICK + 6 * PIP, stop_loss: EUR_TICK + 18 * PIP, tp1: EUR_TICK - 12 * PIP, tp2: EUR_TICK - 26 * PIP };
    app.advanceClock(91000);
    await app.open('markets');
    await app.waitFor(() => /^Sell/.test(app.row('EUR/USD').badge), 'the SELL reading in the Markets table');
    pushTick(app, 'frxEURUSD', EUR_TICK);
    assert.equal(app.row('EUR/USD').badge, 'Sell 69%', 'the Markets row shows the SELL at the live price: 64 + 5');
    assert.deepEqual(liveCard(app, 'EUR/USD'), superseded);

    /* Refresh: the card is the SELL now, with its own numbers. */
    await app.open('signals');
    app.click(app.doc.getElementById('refreshSigs'));
    await app.waitFor(() => liveCard(app, 'EUR/USD') && liveCard(app, 'EUR/USD').direction === 'SELL', 'the refreshed card');
    assert.equal(liveCard(app, 'EUR/USD').score, '69%');
    assert.match(liveCard(app, 'EUR/USD').note, /^6\.0 pips with this SELL \u00b7 33% of the way to target 1 /);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('live confidence: a stop crossed while the market is nowhere on screen still ends the reading', async () => {
  const app = await bootApp({ origin: PC_ORIGIN, pcApi: liveScanApi, world: { ticks: true } });
  try {
    await app.enter();
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxEURUSD')), 'the price stream');
    await app.waitFor(() => app.doc.querySelector('[data-live-conf="EUR/USD"]'), 'the first scan of the workspace');
    /* Whether a reading has ended must not depend on a card or a row happening to be in the
       document when the price crosses its stop. The Overview lists only three readings and the
       other views draw a market once they are opened: stand on a view that draws none, and take
       every element of this market away. */
    await app.open('learn');
    const onPage = () => app.doc.querySelectorAll('[data-live-conf="EUR/USD"], [data-live-bar="EUR/USD"], [data-live-note="EUR/USD"]');
    onPage().forEach((el) => el.remove());
    assert.equal(onPage().length, 0);

    /* The price goes through the stop, and comes back to where it was. */
    pushTick(app, 'frxEURUSD', EUR_TICK - 19 * PIP);
    pushTick(app, 'frxEURUSD', EUR_TICK);
    assert.equal(onPage().length, 0, 'nothing was drawn in between');

    /* The card is drawn again from the same reading: it is over, not "6 pips with". */
    await app.open('signals');
    await app.waitFor(() => liveCard(app, 'EUR/USD'), 'the card');
    assert.equal(liveCard(app, 'EUR/USD').score, '40%');
    assert.match(liveCard(app, 'EUR/USD').note, /^Stop level reached at /);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('live confidence, Gold monitor: a stop crossed while another view is open still ends the reading', async () => {
  const sell = {
    symbol: 'XAU/USD', signal: 'SELL', bias: 'bearish', confidence: 71, mtf_signal: 'SELL_CONFIRMED', votes: 'written by the test', data_ok: true,
    entry: GOLD_TICK + 3, price: GOLD_TICK + 3, stop_loss: GOLD_TICK + 18, tp1: GOLD_TICK - 19.5, tp2: GOLD_TICK - 37, rationale: 'written by the test', risks: [], model: 'technical'
  };
  const pcApi = (path, body) => (path === '/api/signals/analyze' ? { status: 200, body: { ...sell, latest_candle_time: nowSec() } } : liveScanApi(path, body));
  const app = await bootApp({ origin: PC_ORIGIN, pcApi, world: { ticks: true } });
  try {
    await app.enter();
    const text = (id) => app.doc.getElementById(id).textContent;
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    await app.open('gold');
    await app.waitFor(() => text('goldSignal') === 'SELL', 'the first gold analysis');
    assert.equal(text('goldConfidence'), '73%');

    /* On another view, gold goes through the stop and comes back. The monitor's score is not being drawn. */
    await app.open('learn');
    pushTick(app, 'frxXAUUSD', GOLD_TICK + 19);
    pushTick(app, 'frxXAUUSD', GOLD_TICK);
    assert.equal(text('goldConfidence'), '73%', 'the Gold view is not redrawn while it is closed');

    await app.open('gold');
    assert.equal(text('goldSignal'), 'SELL', 'the same analysis is still on screen');
    assert.equal(text('goldConfidence'), '41%');
    assert.match(text('goldConfidenceNote'), /^Stop level reached at /);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---- the PC app with Exness connected ----
   The local MT5 bridge is written by the test. It knows the markets a test gives it, each with
   candles on a price level of its own (EUR/USD near 1.08 and gold near 4000, while the stand-in
   Deriv stream quotes them at 50 and a few hundred). The reading is then made by the
   application's real rule from those candles.

   These tests are about which price a reading is measured against, not about what the rule
   concludes. They need a reading with a direction, so they ask the rule itself which of a few
   plain series it reads as BUY or SELL, and take the entry, the target and the score from its
   answer. */
const BRIDGE_TF = { M1: 60, M5: 300, H1: 3600 };
const BRIDGE_SHAPES = [{ slope: -0.0004, wobble: 0.002 }, { slope: 0.0008, wobble: 0 }, { slope: -0.0008, wobble: 0 }, { slope: 0.0004, wobble: 0.002 }];
function bridgeCandles(timeframe, shape, level) {
  const period = BRIDGE_TF[timeframe], newest = Math.floor(nowSec() / period) * period;
  return Array.from({ length: 120 }, (_unused, i) => {
    const mid = level * (1 + shape.slope * i + shape.wobble * Math.sin(i / 7));
    const open = mid * 0.9998, close = mid * 1.0002;
    return { time: newest - (119 - i) * period, open: Number(open.toFixed(6)), high: Number((close * 1.0004).toFixed(6)), low: Number((open * 0.9996).toFixed(6)), close: Number(close.toFixed(6)) };
  });
}
/* A market for the bridge: the first series the rule reads as a direction, and what the rule says about it. */
function bridgeMarket(symbol, { name, level, digits }) {
  for (const shape of BRIDGE_SHAPES) {
    const sets = { m1: bridgeCandles('M1', shape, level), m5: bridgeCandles('M5', shape, level), h1: bridgeCandles('H1', shape, level) };
    const decision = localDecision(runDeterministicAnalysis(symbol, sets));
    if (decision.signal === 'BUY' || decision.signal === 'SELL') {
      /* `price` is the terminal's quote at this moment (a test moves it); `known` is whether the terminal has the market. */
      return { name, level, digits, shape, decision, price: decision.entry, known: true, third: decision.entry + (decision.tp1 - decision.entry) / 3 };
    }
  }
  return assert.fail('the rule reads none of the bridge fixtures as BUY or SELL any more: add a series that it does');
}
/* `markets` is keyed by the name the application asks the bridge for. */
const exnessBridge = (markets) => (frame) => {
  const account = { balance: 1000, equity: 1000, margin_free: 1000, currency: 'USD', leverage: 100 };
  const market = (asked) => (markets[asked] && markets[asked].known ? markets[asked] : null);
  if (frame.type === 'ping') return { type: 'pong' };
  if (frame.type === 'login') return { type: 'logged', account: '10000001', server: frame.server, ...account };
  if (frame.type === 'account') return { type: 'account', ...account };
  if (frame.type === 'positions') return { type: 'positions', list: [] };
  if (frame.type === 'history') {
    const m = market(frame.symbol);
    return m ? { type: 'history', symbol: m.name, timeframe: frame.timeframe, candles: bridgeCandles(frame.timeframe, m.shape, m.level) }
      : { type: 'error', message: 'Symbol is not available in the connected MT5 terminal.' };
  }
  if (frame.type === 'quote') {
    const half = (m) => 10 ** -m.digits;
    return { type: 'quotes', quotes: (frame.symbols || []).map(market).filter(Boolean).map((m) => ({ symbol: m.name, bid: m.price - half(m), ask: m.price + half(m), time: nowSec(), digits: m.digits })) };
  }
  return null;
};
async function connectExness(app) {
  await app.open('settings');
  app.doc.getElementById('mt5Login').value = '10000001';
  app.doc.getElementById('mt5Server').value = 'Written-By-The-Test';
  app.doc.getElementById('mt5Pass').value = 'written by the test';
  app.click(app.doc.querySelector('.conn-btn[data-conn="mt5"]'));
  await app.waitFor(() => /^\s*Connected/.test(app.doc.getElementById('mt5Status').textContent), 'the Exness connection');
}
const EXNESS_SAMPLED = ' \u00b7 measured at the Exness price of ' + CLOCK + ', updated at each analysis$';

test('live confidence, Exness connected: a reading made from Exness candles is measured at the Exness price of its analysis, never at a Deriv tick', async () => {
  const eur = bridgeMarket('EUR/USD', { name: 'EURUSDm', level: 1.08, digits: 5 });
  const { signal: direction, confidence: base } = eur.decision;
  const app = await bootApp({ origin: PC_ORIGIN, pcApi: liveScanApi, bridgeApi: exnessBridge({ 'EUR/USD': eur }), world: { ticks: true } });
  try {
    await app.enter();
    await connectExness(app);
    const source = () => { const el = [...app.doc.querySelectorAll('#sigGrid .sig-card')].find((card) => card.querySelector('.sym-name').textContent === 'EUR/USD'); return el ? el.querySelector('.sig-why').textContent : ''; };
    const rescan = async (wanted, label) => {
      app.click(app.doc.getElementById('refreshSigs'));
      await app.waitFor(() => wanted(liveCard(app, 'EUR/USD') || {}), label);
    };
    await app.open('signals');
    await rescan(() => /source: Exness MT5 local candles/.test(source()), 'the EUR/USD card read from Exness candles');

    /* The terminal quotes the entry itself: no move yet, and the card says which price it was measured at. */
    const first = liveCard(app, 'EUR/USD');
    assert.equal(first.direction, direction);
    assert.equal(first.score, base + '%');
    assert.match(first.note, new RegExp('^No move yet \u00b7 first read at ' + eur.decision.entry.toFixed(5).replace('.', '\\.') + ', ' + CLOCK + EXNESS_SAMPLED));

    /* The Deriv stream quotes this market at 50: far beyond any level of the Exness reading. Nothing moves. */
    pushTick(app, 'frxEURUSD', EUR_TICK + 3 * PIP);
    pushTick(app, 'frxEURUSD', EUR_TICK);
    assert.deepEqual(liveCard(app, 'EUR/USD'), first);

    /* The next analysis comes with an Exness price a third of the way to target 1: 15 x 1/3 = 5 points on. */
    eur.price = eur.third;
    await rescan((card) => / 33% of the way to target 1 /.test(card.note || ''), 'the score moved by the Exness price of the second analysis');
    const second = liveCard(app, 'EUR/USD');
    assert.equal(second.direction, direction);
    assert.equal(second.score, (base + 5) + '%');
    assert.equal(second.bar, (base + 5) + '%');
    assert.match(second.note, new RegExp('^\\d+\\.\\d pips with this ' + direction + ' \u00b7 33% of the way to target 1 \u00b7 first read at .* \u00b7 score as read ' + base + '%' + EXNESS_SAMPLED));

    /* The terminal loses the market: the next reading comes from the fallback, on the stream's venue.
       It is a new reading with its own levels, and from here on it moves with the stream. */
    eur.known = false;
    await rescan(() => /fallback \(Exness unavailable/.test(source()), 'the fallback reading');
    const third = liveCard(app, 'EUR/USD');
    assert.equal(third.direction, 'BUY');
    assert.equal(third.score, '75%', '70 as read, 6 of 18 pips toward its own target');
    assert.match(third.note, new RegExp('^6\\.0 pips with this BUY \u00b7 33% of the way to target 1 \u00b7 first read at 49\\.99940, ' + CLOCK + ' \u00b7 score as read 70%$'));
    pushTick(app, 'frxEURUSD', EUR_TICK - 12 * PIP);
    assert.equal(liveCard(app, 'EUR/USD').score, '55%', '6 of 12 pips toward its stop: 70 - 15');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('live confidence, Exness connected: a card read on the stream\'s venue does not take over the numbers of a newer Exness reading', async () => {
  const eur = bridgeMarket('EUR/USD', { name: 'EURUSDm', level: 1.08, digits: 5 });
  /* Same direction on both venues, so that only the venue tells the two readings apart. */
  const direction = eur.decision.signal, side = direction === 'BUY' ? 1 : -1;
  /* The stream-venue reading, written by the test: scored 70, read 6 pips before the price the feed ticks at. */
  const streamReading = {
    ...LIVE_BUY, signal: direction, bias: side > 0 ? 'bullish' : 'bearish', mtf_signal: direction + '_CONFIRMED',
    entry: EUR_TICK - side * 6 * PIP, price: EUR_TICK - side * 6 * PIP, stop_loss: EUR_TICK - side * 18 * PIP, tp1: EUR_TICK + side * 12 * PIP, tp2: EUR_TICK + side * 26 * PIP
  };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi: liveApiWith(() => streamReading), bridgeApi: exnessBridge({ 'EUR/USD': eur }), world: { ticks: true } });
  try {
    await app.enter();
    await app.open('signals');
    await app.waitFor(() => liveCard(app, 'EUR/USD') && liveCard(app, 'EUR/USD').score === '75%', 'the stream-venue card at the live price');
    assert.equal(liveCard(app, 'EUR/USD').direction, direction);

    /* Exness is connected, and the Markets table reads the market again: from Exness candles this time. */
    await connectExness(app);
    await app.open('markets');
    await app.waitFor(() => /Exness MT5 local candles/.test(app.row('EUR/USD').source), 'the Exness reading in the Markets table');
    assert.equal(app.row('EUR/USD').badge, (direction === 'BUY' ? 'Buy ' : 'Sell ') + eur.decision.confidence + '%', 'the same direction, read on the other venue');

    /* The card is still the stream-venue reading. It shows its own score as read, and says it is not the newest. */
    pushTick(app, 'frxEURUSD', EUR_TICK);
    assert.deepEqual(liveCard(app, 'EUR/USD'), {
      direction, score: '70%', bar: '70%',
      note: 'This ' + direction + ' reading is no longer the newest for this market: refresh to see the latest.'
    });
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('live confidence, Gold monitor on Exness: the score follows the Exness gold price, not the Deriv tick', async () => {
  const gold = bridgeMarket('XAU/USD', { name: 'XAUUSDm', level: 4000, digits: 2 });
  const { signal: direction, confidence: base } = gold.decision;
  /* The Gold monitor asks the bridge for "XAUUSD". */
  const app = await bootApp({ origin: PC_ORIGIN, pcApi: liveScanApi, bridgeApi: exnessBridge({ XAUUSD: gold }), world: { ticks: true } });
  try {
    await app.enter();
    const doc = app.doc;
    const text = (id) => doc.getElementById(id).textContent;
    const shown = () => ({ score: text('goldConfidence'), bar: doc.getElementById('goldConfidenceBar').style.width, note: text('goldConfidenceNote') });
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the Deriv gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    await connectExness(app);
    await app.open('gold');
    await app.waitFor(() => text('goldSignal') === direction, 'the gold analysis from Exness candles');
    assert.match(text('goldFeedStatus'), /^LIVE ANALYSIS \u00b7 Exness MT5 local candles/);

    /* The terminal quotes the entry itself. */
    const first = shown();
    assert.equal(first.score, base + '%');
    assert.match(first.note, /^No move yet \u00b7 first read at /);

    /* Deriv quotes gold at a few hundred here: far beyond every level of this reading. Nothing moves. */
    pushTick(app, 'frxXAUUSD', GOLD_TICK + 5);
    pushTick(app, 'frxXAUUSD', GOLD_TICK);
    assert.deepEqual(shown(), first);

    /* The terminal's price goes a third of the way to target 1; the monitor asks for it every ten seconds. */
    gold.price = gold.third;
    app.advanceClock(11000);
    app.runIntervals(10000);
    await app.waitFor(() => / 33% of the way to target 1 /.test(text('goldConfidenceNote')), 'the Exness gold price at the next poll');
    assert.equal(text('goldConfidence'), (base + 5) + '%');
    assert.equal(doc.getElementById('goldConfidenceBar').style.width, (base + 5) + '%');
    assert.match(text('goldConfidenceNote'), new RegExp('^\\$\\d+\\.\\d\\d with this ' + direction + ' \u00b7 33% of the way to target 1 \u00b7 first read at .* \u00b7 score as read ' + base + '%$'));

    /* Auto-refresh off, so the analysis stays on screen; then the terminal's tick is more than
       two minutes old at the next poll. An old price is not a live price. */
    const auto = doc.getElementById('goldAuto');
    auto.checked = false;
    auto.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    app.advanceClock(130000);
    app.runIntervals(10000);
    await app.waitFor(() => /^No live price right now /.test(text('goldConfidenceNote')), 'the stale Exness tick');
    assert.equal(text('goldSignal'), direction, 'the analysis is still shown');
    assert.equal(text('goldConfidence'), base + '%', 'the score as read');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});
