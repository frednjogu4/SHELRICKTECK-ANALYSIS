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
 * `pcApi`, when given, replaces the Worker: the page then runs as the PC app
 * and `pcApi(path, body)` answers its API requests with { status, body }.
 */
async function bootApp({ origin = HOSTED_ORIGIN, world = {}, pcApi = null } = {}) {
  const state = { browserDeriv: 'ok', cloudDeriv: 'ok', yahoo: 'ok', candleAgeSec: 0, ticks: false, ...world };
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
      return Response.json(yahooChartFixture());
    },
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
        this.readyState = 0;
        this.close = () => { this.readyState = 3; };
        this.send = (raw) => {
          const message = JSON.parse(raw);
          entry.sent.push(message);
          window.setTimeout(() => {
            if (this.readyState !== 1) return;
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
          if (state.browserDeriv === 'down') { this.readyState = 3; if (this.onerror) this.onerror({}); if (this.onclose) this.onclose({ code: 1006 }); return; }
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
        let response;
        if (pcApi) {
          const answer = pcApi(url.pathname, body) || { status: 404, body: { error: 'not_part_of_this_test' } };
          response = new Response(JSON.stringify(answer.body), { status: answer.status || 200, headers: { 'content-type': 'application/json' } });
        } else {
          response = await worker.fetch(new Request(url, { method: record.method, headers: { ...headers, origin }, body: init.body }), env);
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
  return {
    window, doc, state, requests, sockets, problems, warnings, click, waitFor, row,
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
    assert.deepEqual(app.warnings.filter((line) => line.startsWith('[aurum]')), []);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});
