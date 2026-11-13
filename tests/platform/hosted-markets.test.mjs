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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';
import { DERIV_INSTRUMENTS, INDEX_INSTRUMENTS, derivCandleRows, basePriceFor, yahooChartFixture, nowSec } from './helpers/market-fixtures.mjs';
import { tradingDayText } from '../../src/bestpick.js';
import { runDeterministicAnalysis } from '../../server/lib/analyzer.js';
import { localDecision } from '../../server/lib/localdecision.js';
import { closedCandleSets } from '../../src/closedcandles.js';
import { CALENDAR_URL, HEADLINE_SOURCES } from '../../cloudflare/news.js';
import { createApp, configFromEnv } from '../../server/app.js';
import { createStore } from '../../server/lib/store.js';
import { STATE_TIMEFRAMES, STATE_CANDLES, STATE_MEASURED_TEXT, eatMoment } from '../../src/marketstate.js';

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
 *   candleRows    (code, granularity, count, nowSec) => rows, a market written by the test in place of
 *                 the built-in series, whose candles do not keep their content from one minute to the next
 *   rewriteScan   (results) => results, applied to what the Worker answers to /api/signals/scan:
 *                 lets a test hand the page a reading of its own writing for one market
 *   scanTakesMs   page time that passes while a scan request is answered
 *   scanGate      () => Promise, awaited before a scan request is answered
 *   news          { feeds: { address: RSS text }, calendar: rows } written by the test; offline without it
 * `pcApi`, when given, replaces the Worker: the page then runs as the PC app
 * and `pcApi(path, body)` answers its API requests with { status, body }.
 * `pcServer: true` puts the PC's own server behind the page instead: the real
 * server/app.js, whose candle feed is the one of `world` (cloudDeriv 'down'
 * makes it fail). What that server fetches itself is answered here as well:
 * Yahoo's daily series with the fixture the Worker gets, every other address
 * (the news sources) as offline. That server answers any number of requests a
 * minute here; `pcConfig` sets its configuration back for a test about its limits.
 */
async function bootApp({ origin = HOSTED_ORIGIN, world = {}, pcApi = null, pcServer = false, pcConfig = null, bridgeApi = null } = {}) {
  const state = { browserDeriv: 'ok', cloudDeriv: 'ok', yahoo: 'ok', candleAgeSec: 0, ticks: false, yahooBars: {}, rewriteScan: null, scanTakesMs: 0, scanGate: null, candleRows: null, ...world };
  const problems = [];
  const warnings = [];
  const requests = [];
  const sockets = [];
  const intervals = [];
  const clock = { shiftMs: 0 };
  let closing = false;

  const symbolOf = (code) => DERIV_INSTRUMENTS.find((instrument) => instrument.deriv === code);
  const rows = (code, granularity, count) => (state.candleRows
    ? state.candleRows(code, granularity, count, nowSec() + clock.shiftMs / 1000 - state.candleAgeSec)
    : derivCandleRows({ count, granularity, end: nowSec() + clock.shiftMs / 1000 - state.candleAgeSec, base: basePriceFor(code) }));

  const worker = createReadOnlyWorker({
    requestImpl: async (payload) => {
      if (state.cloudDeriv !== 'ok') throw new Error('Deriv public WebSocket connection failed');
      if (payload.ticks_history) return { candles: rows(payload.ticks_history, payload.granularity, payload.count) };
      throw new Error('unexpected Deriv request in this test');
    },
    fetchImpl: async (address) => {
      /* The headline feeds and the calendar are offline unless a test writes them: `world.news` is
         { feeds: { address: text }, calendar: rows }. Every other address is Yahoo's daily series. */
      const url = String(address);
      if (url === CALENDAR_URL) {
        if (!state.news || state.news.calendar == null) throw new Error('the calendar source is offline in this test');
        return Response.json(state.news.calendar);
      }
      if (HEADLINE_SOURCES.some((source) => source.url === url)) {
        const text = state.news && state.news.feeds && state.news.feeds[url];
        if (text == null) throw new Error('this headline source is offline in this test');
        return new Response(text);
      }
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

  /* The PC's own server, listening on this machine for the length of the test. Its feed hands on
     Deriv's rows in the shape server/lib/derivfeed.js does. */
  let pcServerBase = '';
  let stopPcServer = async () => {};
  if (pcServer) {
    const folder = mkdtempSync(join(tmpdir(), 'aurum-pc-app-'));
    const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', PERPLEXITY_API_KEY: '' }), { apiKey: '', backtestRatePerMin: 100000 }, pcConfig || {});
    const notInThisTest = async () => { throw new Error('not part of this test'); };
    const feed = {
      symbols: Object.fromEntries(DERIV_INSTRUMENTS.map((instrument) => [instrument.s, instrument.deriv])),
      fetchCandles: async (symbol, granularity, count) => {
        if (state.cloudDeriv !== 'ok') throw new Error('deriv timeout');
        return rows(DERIV_INSTRUMENTS.find((instrument) => instrument.s === symbol).deriv, granularity, count)
          .map((c) => ({ time: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: 0 }));
      },
      fetchCandlesByCode: notInThisTest, fetchActiveSymbols: notInThisTest, fetchTickByCode: notInThisTest
    };
    const listening = createApp({ store: createStore(join(folder, 'store.json')), config, feed }).listen(0, '127.0.0.1');
    await new Promise((resolveListening) => listening.once('listening', resolveListening));
    pcServerBase = 'http://127.0.0.1:' + listening.address().port;
    /* The server reaches Yahoo and the news sources with the fetch of this process. While this app is open,
       that fetch answers them from `world`; requests to a server on this machine pass through. */
    const outerFetch = globalThis.fetch;
    const ownFetch = async (input, init) => {
      const url = String((input && input.url) || input);
      if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return outerFetch(input, init);
      if (url.startsWith('https://query1.finance.yahoo.com/')) {
        if (state.yahoo !== 'ok') throw new Error('Yahoo Finance HTTP 503');
        return Response.json(yahooChartFixture(state.yahooBars));
      }
      throw new Error('this source is offline in this test');
    };
    globalThis.fetch = ownFetch;
    stopPcServer = async () => {
      if (globalThis.fetch === ownFetch) globalThis.fetch = outerFetch;
      listening.close();
      if (listening.closeAllConnections) listening.closeAllConnections();
      rmSync(folder, { recursive: true, force: true });
    };
  }

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
        if (pcServerBase) {
          const answer = await fetch(pcServerBase + url.pathname + url.search, { method: record.method, headers: { 'content-type': 'application/json' }, body: init.body });
          response = new Response(await answer.text(), { status: answer.status, headers: { 'content-type': 'application/json' } });
        } else if (pcApi) {
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
      await stopPcServer();
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
    /* ...and says which 5-minute close the reading was made at. */
    for (const card of fromDeriv) assert.match(card.why, / · source: Deriv public candles · analysed in this browser · read at the \d\d:\d\d candle close$/, card.symbol);
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
      assert.match(card.querySelector('.sig-why').textContent, / · source: Deriv public candles · analysed in this browser · read at the \d\d:\d\d candle close$/);
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
const NO_LEVELS = 'Daily index reading from daily closing prices: it has no entry, stop or target, so nothing here moves with the price and there is no measured result. Levels need minute-by-minute prices, which for indices come only from Exness MT5 in the PC app.';
/* What the replay measured (src/measured.js). A reading written by these tests names no 5-minute close, the way a PC server
   from before 13 Nov 2026 answers, which looked every minute: "minute". A reading that names its close, made in the page or
   by the PC's server as it is now, has the figure of the 5-minute rule: "close". */
const EUR_MEASURED_CLOSE = 'Measured in a replay on EUR/USD (Mar \u2013 Sep 2026): 39.9% of 6,114 signals of this rule reached target 1 before the stop; 40% is needed to break even, before the spread. Not a forecast.';
const GOLD_MEASURED_MINUTE = 'Measured in a replay on gold (Jan 2020 \u2013 Nov 2026): 39.8% of 177,715 signals of this rule reached target 1 before the stop; 40% is needed to break even, before the spread. Not a forecast.';
const GOLD_MEASURED_CLOSE = 'Measured in a replay on gold (Jan 2020 \u2013 Nov 2026): 39.6% of 76,694 signals of this rule reached target 1 before the stop; 40% is needed to break even, before the spread. Not a forecast.';
const EUR_MEASURED_MINUTE = 'Measured in a replay on EUR/USD (Mar \u2013 Sep 2026): 39.9% of 13,990 signals of this rule reached target 1 before the stop; 40% is needed to break even, before the spread. Not a forecast.';
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
    /* Under it: what a replay of the rule measured on this market. A WAIT has no such line; a daily reading says why in its own sentence. */
    const measured = (symbol) => card(symbol).querySelector('.sig-measured').textContent;
    assert.equal(measured('EUR/USD'), EUR_MEASURED_MINUTE);
    assert.equal(measured('GBP/USD'), '');
    assert.equal(measured('US30'), '');
    /* The alert of the same reading ends with that figure; the alert of a daily reading says that it has none. */
    const alertBody = (title) => { const el = [...app.doc.querySelectorAll('#toasts .toast')].find((toast) => toast.querySelector('b').textContent === title); return el ? el.querySelector('span').textContent : null; };
    assert.match(alertBody('Signal update \u00b7 EUR/USD'), /\nMeasured in a replay on EUR\/USD: 39\.9% of such signals reached TP1 before the SL \(break-even 40% before the spread\)\. Not a forecast\.$/);
    assert.match(alertBody('Signal update \u00b7 US30'), /\nNot measured: a daily reading has no stop or target\.$/);
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
    await app.waitFor(() => cells('EUR/USD')[3] === '75%6.0 pips withmeasured 39.9%', 'the live score in the selected-markets table');
    assert.equal(cells('EUR/USD').length, headers(watchTable).length, 'one cell under every header');
    assert.equal(cells('GBP/USD')[3], '20%', 'a WAIT shows the score as read, with nothing to follow');
    assert.equal(cells('AUD/USD')[3], '\u2014', 'a reading without a score shows a dash, not 0%');
    assert.equal(cells('US30')[3], '90%not measured', 'a daily reading shows its score as read: there is no level to measure from');

    /* The setups table lists the BUYs and the SELL, not the WAIT. */
    const setups = () => doc.querySelector('#sniperSignalList table');
    assert.deepEqual(headers(setups()), ['Market', 'Signal', 'Confidence', 'Timeframe', 'Entry', 'SL', 'TP1', 'Source']);
    const setupCells = (symbol) => { const tr = [...setups().querySelectorAll('tbody tr')].find((el) => el.children[0].textContent === symbol); return tr ? [...tr.children].map((td) => td.textContent) : null; };
    assert.equal(setups().querySelectorAll('tbody tr').length, 3);
    assert.equal(setupCells('EUR/USD').length, 8);
    assert.equal(setupCells('EUR/USD')[2], '75%6.0 pips withmeasured 39.9%');
    assert.equal(setupCells('AUD/USD')[2], '\u2014');
    assert.equal(setupCells('US30')[2], '90%not measured');
    assert.equal(setupCells('GBP/USD'), null);

    /* Under each score: what the replay measured for that market. The full sentence is the tooltip.
       These readings come from the PC's server, which still looks every minute: the figure is the one of that timing. */
    const measuredIn = (tr) => { const el = tr.querySelector('[data-measured]'); return el ? { text: el.textContent, title: el.getAttribute('title') } : null; };
    assert.deepEqual(measuredIn(rowOf('EUR/USD')), { text: 'measured 39.9%', title: EUR_MEASURED_MINUTE });
    assert.deepEqual(measuredIn(rowOf('US30')), { text: 'not measured', title: NO_LEVELS });
    assert.equal(measuredIn(rowOf('GBP/USD')), null, 'a WAIT of the 1m/5m/1h rule is not a signal to measure');
    assert.equal(measuredIn(rowOf('AUD/USD')), null);

    /* The eye icon: the detail line. */
    app.click(doc.querySelector('[data-sniper-view="EUR/USD"]'));
    const detail = doc.getElementById('sniperSelectedDetail');
    assert.match(detail.textContent, /Confidence: 75% \u00b7 Source: /);
    /* This box styles <b> as a heading on a line of its own: the score stays inside its sentence. */
    assert.equal(detail.querySelector('.hint [data-live-conf]').tagName, 'SPAN');
    assert.match(detail.querySelector('[data-live-note]').textContent, /^6\.0 pips with this BUY \u00b7 33% of the way to target 1 \u00b7 first read at 49\.99940, /);
    assert.equal(detail.querySelector('[data-measured]').textContent, EUR_MEASURED_MINUTE);

    /* One tick against the reading moves all three. */
    pushTick(app, 'frxEURUSD', EUR_TICK - 12 * PIP);
    assert.equal(cells('EUR/USD')[3], '55%6.0 pips againstmeasured 39.9%');
    assert.equal(setupCells('EUR/USD')[2], '55%6.0 pips againstmeasured 39.9%');
    assert.match(detail.textContent, /Confidence: 55% \u00b7 Source: /);
    assert.match(detail.querySelector('[data-live-note]').textContent, /^6\.0 pips against this BUY \u00b7 50% of the way to the stop /);
    assert.equal(cells('US30')[3], '90%not measured', 'the daily reading is left as it was');
    assert.equal(setupCells('US30')[2], '90%not measured');
    assert.equal(cells('GBP/USD')[3], '20%');

    /* The scanner reads EUR/USD again, as WAIT. These tables still hold the BUY of the last market scan:
       its row shows the score as read and says that it is not the newest reading. */
    eur = liveWait('EUR/USD');
    await app.open('signals');
    app.click(doc.getElementById('refreshSigs'));
    await app.waitFor(() => liveCard(app, 'EUR/USD') && liveCard(app, 'EUR/USD').direction === 'WAIT', 'the newer reading on the scanner card');
    pushTick(app, 'frxEURUSD', EUR_TICK);
    assert.equal(cells('EUR/USD')[2], 'BUY', 'the row is still the BUY');
    assert.equal(cells('EUR/USD')[3], '70%not the newest readingmeasured 39.9%');
    assert.equal(setupCells('EUR/USD')[2], '70%not the newest readingmeasured 39.9%');
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

    /* Under the score: what the replay measured on gold. This answer names no close, as an older PC server's: the every-minute figure. */
    assert.equal(text('goldMeasured'), GOLD_MEASURED_MINUTE);
    const goldAlert = [...doc.querySelectorAll('#toasts .toast')].find((toast) => /^Gold\/USD signal (ready|changed)$/.test(toast.querySelector('b').textContent));
    assert.match(goldAlert.querySelector('span').textContent, /\nMeasured in a replay on gold: 39\.8% of such signals reached TP1 before the SL \(break-even 40% before the spread\)\. Not a forecast\.$/);
    assert.match(text('goldSignalUpdated'), /^Last analysis: /, 'this answer does not say which close its reading belongs to');
    /* ...and the page does not promise the 5-minute rule for it: it says where such a reading comes from and what to do. */
    assert.ok(text('goldAnalysisNoticeText').endsWith(' (this reading can change every minute: it comes from an older version of the AURUM server, which does not read at the 5-minute close yet. If that server runs on this PC, close the "Fredrick AURUM Local API" window and run START_ALL_LOCAL.bat again).'), text('goldAnalysisNoticeText'));
    assert.doesNotMatch(text('goldAnalysisNoticeText'), /a reading changes only when/);

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
    assert.equal(text('goldMeasured'), '', 'a WAIT is not a signal to measure');

    /* The analysis fails (the local API, and the browser's own read of Deriv behind it): no score is left standing. */
    answer = null;
    app.state.browserDeriv = 'down';
    app.click(doc.getElementById('goldAnalyzeBtn'));
    await app.waitFor(() => text('goldSignalBadge') === 'UNAVAILABLE', 'the failed analysis');
    assert.equal(text('goldConfidence'), '\u2014');
    assert.equal(doc.getElementById('goldConfidenceBar').style.width, '0%');
    assert.equal(text('goldConfidenceNote'), 'No current analysis, so no score is shown.');
    assert.equal(text('goldMeasured'), '');

    /* A signal again, and a failure straight after it: the replay figure of the vanished signal is not left standing. */
    answer = sell;
    app.state.browserDeriv = 'ok';
    app.click(doc.getElementById('goldAnalyzeBtn'));
    await app.waitFor(() => text('goldSignal') === 'SELL', 'the signal again');
    assert.equal(text('goldMeasured'), GOLD_MEASURED_MINUTE);
    answer = null;
    app.state.browserDeriv = 'down';
    app.click(doc.getElementById('goldAnalyzeBtn'));
    await app.waitFor(() => text('goldSignalBadge') === 'UNAVAILABLE', 'the second failure');
    assert.equal(text('goldMeasured'), '');
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
   answer. The rule is asked as the application asks it: with the candles that had finished by
   the last 5-minute close (src/closedcandles.js). */
const BRIDGE_TF = { M1: 60, M5: 300, H1: 3600 };
const BRIDGE_SHAPES = [{ slope: -0.0004, wobble: 0.002 }, { slope: 0.0008, wobble: 0 }, { slope: -0.0008, wobble: 0 }, { slope: 0.0004, wobble: 0.002 }];
/* `pauseSec`: the terminal's market gave no price for that long before its newest candle, so it holds the candles
   from before the pause and the one of the price that ended it. */
function bridgeCandles(timeframe, shape, level, pauseSec = 0) {
  const period = BRIDGE_TF[timeframe], newest = Math.floor(nowSec() / period) * period;
  return Array.from({ length: 120 }, (_unused, i) => {
    const mid = level * (1 + shape.slope * i + shape.wobble * Math.sin(i / 7));
    const open = mid * 0.9998, close = mid * 1.0002;
    return { time: newest - (119 - i) * period, open: Number(open.toFixed(6)), high: Number((close * 1.0004).toFixed(6)), low: Number((open * 0.9996).toFixed(6)), close: Number(close.toFixed(6)) };
  }).filter((candle) => candle.time >= newest || candle.time < newest - pauseSec);
}
/* A market for the bridge: the first series the rule reads as a direction, and what the rule says about it. */
function bridgeMarket(symbol, { name, level, digits }) {
  for (const shape of BRIDGE_SHAPES) {
    const sets = { m1: bridgeCandles('M1', shape, level), m5: bridgeCandles('M5', shape, level), h1: bridgeCandles('H1', shape, level) };
    const decision = localDecision(runDeterministicAnalysis(symbol, closedCandleSets(sets).sets));
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
    if (!m) return { type: 'error', message: 'Symbol is not available in the connected MT5 terminal.' };
    /* `only: { M5: 1 }`: the terminal has loaded just the newest candle of that timeframe. */
    const candles = bridgeCandles(frame.timeframe, m.shape, m.level, m.pauseSec || 0), keep = m.only && m.only[frame.timeframe];
    return { type: 'history', symbol: m.name, timeframe: frame.timeframe, candles: keep ? candles.slice(-keep) : candles };
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
    /* A reading made in the page from finished candles: it says which close it belongs to, and the replay figure is the one of that timing. */
    assert.match(source(), / \u00b7 read at the \d\d:\d\d candle close$/);
    const measuredOnCard = () => [...app.doc.querySelectorAll('#sigGrid .sig-card')].find((card) => card.querySelector('.sym-name').textContent === 'EUR/USD').querySelector('.sig-measured').textContent;
    assert.equal(measuredOnCard(), EUR_MEASURED_CLOSE);
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
    /* The fallback reading comes from the PC's server, which looks every minute and names no close. */
    assert.doesNotMatch(source(), /candle close/);
    assert.equal(measuredOnCard(), EUR_MEASURED_MINUTE);
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
    /* Made in the page from finished candles: the close it belongs to, and the replay figure of that timing. */
    assert.match(text('goldSignalUpdated'), /^Reading of the \d\d:\d\d candle close \u00b7 checked .* \u00b7 the next reading comes with the next 5-minute close; no fixed expiry\.$/);
    assert.equal(text('goldMeasured'), GOLD_MEASURED_CLOSE);

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

/* ---------------------------------------------------------------- the questions of 13 November 2026 */

test('index cards on the cloud: a daily reading says on the card why it has no entry, stop or target, whether it reads BUY or WAIT', async () => {
  /* As on the screenshot: NAS100 WAIT 66%, US30 BUY 82%, SPX500 WAIT 66%, three empty boxes each. */
  const as = { NAS100: { signal: 'WAIT', bias: 'bearish', confidence: 66 }, US30: { signal: 'BUY', bias: 'bullish', confidence: 82 }, SPX500: { signal: 'WAIT', bias: 'bearish', confidence: 66 } };
  const app = await bootApp({ world: { ticks: true, rewriteScan: (results) => results.map((reading) => (as[reading.symbol] ? { ...reading, ...as[reading.symbol] } : reading)) } });
  try {
    await app.enter();
    await app.open('signals');
    await app.waitFor(() => Object.keys(as).every((symbol) => liveCard(app, symbol)), 'the three index cards');
    const cardEl = (symbol) => [...app.doc.querySelectorAll('#sigGrid .sig-card')].find((card) => card.querySelector('.sym-name').textContent === symbol);
    const check = () => {
      for (const [symbol, reading] of Object.entries(as)) {
        assert.deepEqual(liveCard(app, symbol), { direction: reading.signal, score: reading.confidence + '%', bar: reading.confidence + '%', note: NO_LEVELS }, symbol);
        assert.deepEqual(['e', 's', 't'].map((key) => cardEl(symbol).querySelector('[data-l="' + key + '"]').textContent), ['\u2014', '\u2014', '\u2014'], symbol + ': the three boxes stay empty');
        assert.equal(cardEl(symbol).querySelector('.sig-measured').textContent, '', symbol + ': the sentence above already says that nothing was measured');
        assert.match(cardEl(symbol).querySelector('.sig-why').textContent, / \u00b7 DAILY \(index\) \u00b7 source: Yahoo Finance public daily data \u00b7 AURUM cloud analysis$/);
      }
    };
    check();
    /* A price tick repaints every score and sentence on the page: the explanation stays. */
    pushTick(app, 'frxEURUSD', EUR_TICK);
    check();
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* A market whose price is a function of time, so that a candle keeps its content whenever it is asked for, as
   a real one does. `drift` is the relative move per minute. The built-in series of this file cannot do this. */
function steadyMarket(drift) {
  const anchor = nowSec();
  const priceAt = (base, t) => base * Math.exp((drift * (t - anchor)) / 60);
  return (code, granularity, count, now) => {
    const base = basePriceFor(code), newest = Math.floor(now / granularity) * granularity;
    return Array.from({ length: count }, (_unused, i) => {
      const start = newest - (count - 1 - i) * granularity, end = Math.min(start + granularity, now);
      const open = priceAt(base, start), close = priceAt(base, end);
      return { epoch: start, open, high: Math.max(open, close), low: Math.min(open, close), close };
    });
  };
}
/* The first steady market the rule reads as BUY or SELL. The tests below need a signal; which one does not matter. */
function directionalMarket() {
  for (const drift of [0.00002, 0.00005, 0.0001, -0.00002, -0.00005, -0.0001]) {
    const market = steadyMarket(drift), now = nowSec();
    const sets = Object.fromEntries([['m1', 60], ['m5', 300], ['h1', 3600]].map(([key, granularity]) => [key, market('frxEURUSD', granularity, 120, now).map((row) => ({ time: row.epoch, open: row.open, high: row.high, low: row.low, close: row.close }))]));
    if (['BUY', 'SELL'].includes(localDecision(runDeterministicAnalysis('EUR/USD', closedCandleSets(sets).sets)).signal)) return market;
  }
  return assert.fail('the rule reads none of these steady markets as BUY or SELL any more: add one that it does');
}

/* The page's clock in seconds, and a way to move it. `settle()` leaves room for two looks inside one 5-minute candle
   and returns the close that candle began with. It also moves the clock out of the first twenty seconds of a candle:
   a test that says "two seconds ago" means a moment inside the candle it stands in. Without that, three tests
   about a market that has just resumed failed when they ran within two seconds after a 5-minute close (their
   pause then ended in the candle before, which is a different market: one whose first candle has closed). */
function pageClock(app) {
  let shift = 0;
  const now = () => Date.now() / 1000 + shift;
  const advance = (seconds) => { shift += seconds; app.advanceClock(seconds * 1000); };
  const settle = () => { const into = now() % 300; if (into > 180) advance(320 - into); else if (into < 20) advance(20 - into); return Math.floor(now() / 300) * 300; };
  return { now, advance, settle };
}
const hhmm = (seconds) => new Date(seconds * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

test('one reading per finished 5-minute candle: looking again before the next close changes nothing, and the next close brings the next reading', async () => {
  const app = await bootApp({ world: { candleRows: directionalMarket() } });
  try {
    const clock = pageClock(app), pageNow = clock.now, advance = clock.advance;
    const doc = app.doc;
    const cardEl = () => [...doc.querySelectorAll('#sigGrid .sig-card')].find((card) => card.querySelector('.sym-name').textContent === 'EUR/USD');
    const snapshot = () => {
      const el = cardEl();
      return {
        direction: el.querySelector('.badge').textContent, scoreAsRead: el.querySelector('[data-live-conf]').dataset.liveBase,
        entry: el.querySelector('[data-l="e"]').textContent, stop: el.querySelector('[data-l="s"]').textContent, target: el.querySelector('[data-l="t"]').textContent,
        why: el.querySelector('.sig-why').textContent, measured: el.querySelector('.sig-measured').textContent
      };
    };
    const candleRequests = () => app.sockets.reduce((total, entry) => total + entry.sent.filter((message) => message.style === 'candles' && message.ticks_history === 'frxEURUSD').length, 0);
    const look = async () => {
      app.click(doc.getElementById('refreshSigs'));
      assert.equal(doc.getElementById('sigStamp').textContent, 'Scanning\u2026');
      await app.waitFor(() => /^Updated /.test(doc.getElementById('sigStamp').textContent) && cardEl(), 'the scan to finish');
      return snapshot();
    };

    await app.enter();
    await app.open('signals');
    const close = clock.settle();

    const first = await look();
    assert.ok(first.direction === 'BUY' || first.direction === 'SELL', 'the page reads the chosen market as a direction, as the rule did when asked');
    assert.match(first.why, new RegExp(' \u00b7 source: Deriv public candles \u00b7 analysed in this browser \u00b7 read at the ' + hhmm(close) + ' candle close$'));
    assert.equal(first.measured, EUR_MEASURED_CLOSE);

    /* A minute later, in the same 5-minute candle: the feed is asked again, one more 1-minute candle has finished,
       the forming candles have moved on, and the reading is the same in every figure. */
    const asked = candleRequests();
    advance(61);
    const second = await look();
    assert.ok(candleRequests() > asked, 'the candles were fetched again, not reused');
    assert.deepEqual(second, first);

    /* Twenty seconds after the next 5-minute close: the next reading, made at that close, at another price. */
    advance(close + 320 - pageNow());
    const third = await look();
    assert.match(third.why, new RegExp(' \u00b7 read at the ' + hhmm(close + 300) + ' candle close$'));
    assert.equal(third.direction, first.direction);
    assert.notEqual(third.entry, first.entry);

    /* The Sniper detail of the same market names the close too, and gives the same replay figure. */
    await app.open('sniper');
    app.click(doc.getElementById('sniperPickerToggle'));
    await app.waitFor(() => doc.querySelector('[data-sniper-view="EUR/USD"]') && doc.querySelector('[data-sniper-watch="EUR/USD"]').closest('tr').querySelector('[data-live-conf]'), 'the scanned EUR/USD row');
    app.click(doc.querySelector('[data-sniper-view="EUR/USD"]'));
    const detail = doc.getElementById('sniperSelectedDetail');
    assert.match(detail.textContent, / \u00b7 MTF 1m\/5m\/1h \u00b7 read at the \d\d:\d\d candle close\. Analysis only \u2014 no order sent\./);
    assert.equal(detail.querySelector('[data-measured]').textContent, EUR_MEASURED_CLOSE);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Gold monitor on the cloud: one reading per finished 5-minute candle, and a new look seconds after each close', async () => {
  /* As on the live site: the AURUM cloud cannot reach Deriv, so the monitor reads Deriv's gold candles in this browser. */
  const app = await bootApp({ world: { cloudDeriv: 'down', ticks: true, candleRows: directionalMarket() } });
  try {
    const clock = pageClock(app);
    const doc = app.doc;
    const text = (id) => doc.getElementById(id).textContent;
    const levelsShown = () => ({ signal: text('goldSignal'), entry: text('goldEntry'), stop: text('goldSL'), target: text('goldTP1'), measured: text('goldMeasured') });
    const closeShown = () => (/^Reading of the (\d\d:\d\d) candle close /.exec(text('goldSignalUpdated')) || [])[1];
    /* The monitor analyses only with a gold price under two minutes old: after the clock has been moved, the feed ticks again. */
    const tickNow = () => {
      const stream = app.sockets.find((entry) => entry.sent.some((message) => message.style === 'ticks'));
      stream.socket.onmessage({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'frxXAUUSD', quote: GOLD_TICK, epoch: Math.floor(clock.now()) } }) });
    };
    /* A look asked for by hand: done when the "checked" time has moved on. */
    const look = async () => {
      const before = text('goldSignalUpdated');
      tickNow();
      app.click(doc.getElementById('goldAnalyzeBtn'));
      await app.waitFor(() => text('goldSignalUpdated') !== before && text('goldFeedStatus').startsWith('LIVE ANALYSIS'), 'the gold analysis');
      return levelsShown();
    };

    await app.enter();
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    const close = clock.settle();
    /* settle() may have moved the clock by up to 140 seconds, and the monitor analyses only with a gold price under
       two minutes old: without a new tick this test failed when it began 180 to 200 seconds after a 5-minute close. */
    tickNow();
    await app.open('gold');
    await app.waitFor(() => text('goldFeedStatus').startsWith('LIVE ANALYSIS'), 'the first gold analysis');
    assert.match(text('goldFeedStatus'), /^LIVE ANALYSIS \u00b7 Deriv public candles \u00b7 labelled fallback/);

    const first = levelsShown();
    assert.ok(first.signal === 'BUY' || first.signal === 'SELL', 'the page reads the chosen market as a direction, as the rule did when asked');
    assert.equal(closeShown(), hhmm(close));
    assert.equal(first.measured, GOLD_MEASURED_CLOSE);

    /* A minute later, inside the same 5-minute candle: the same reading in every figure. */
    clock.advance(61);
    assert.deepEqual(await look(), first);
    assert.equal(closeShown(), hhmm(close));

    /* After the next close: the next reading, at another price. */
    clock.advance(close + 320 - clock.now());
    const next = await look();
    assert.equal(closeShown(), hhmm(close + 300));
    assert.notEqual(next.entry, first.entry);

    /* The monitor on its own. Thirty seconds before the following close it makes its regular check... */
    clock.advance(close + 570 - clock.now());
    const beforeCheck = text('goldSignalUpdated');
    tickNow();
    app.runIntervals(10000);
    await app.waitFor(() => text('goldSignalUpdated') !== beforeCheck, 'the regular check');
    assert.equal(closeShown(), hhmm(close + 300), 'the candle has not closed yet');
    /* ...and ten seconds after that close it has looked again, although its regular minute is not over. */
    clock.advance(40);
    const afterClose = text('goldSignalUpdated');
    tickNow();
    app.runIntervals(10000);
    await app.waitFor(() => text('goldSignalUpdated') !== afterClose, 'the look right after the close');
    assert.equal(closeShown(), hhmm(close + 600));
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Sniper entry alert: the message ends with what the replay measured for that market', async () => {
  const app = await bootApp({ origin: PC_ORIGIN, pcApi: liveScanApi, world: { ticks: true } });
  try {
    await app.enter();
    await app.open('sniper');
    const doc = app.doc;
    app.click(doc.getElementById('sniperPickerToggle'));
    await app.waitFor(() => doc.querySelector('[data-sniper-watch="EUR/USD"]'), 'the market list');
    for (const symbol of ['EUR/USD', 'US30']) {
      const box = doc.querySelector('[data-sniper-watch="' + symbol + '"]');
      box.checked = true;
      box.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    }
    app.click(doc.getElementById('sniperMonitorToggle'));
    const alertBody = (title) => { const el = [...doc.querySelectorAll('#toasts .toast')].find((toast) => toast.querySelector('b').textContent === title); return el ? el.querySelector('span').textContent : null; };
    await app.waitFor(() => alertBody('Sniper entry setup \u00b7 EUR/USD'), 'the entry alert for EUR/USD');
    assert.match(alertBody('Sniper entry setup \u00b7 EUR/USD'), /\nSignal alert only \u2014 no order was placed\.\nMeasured in a replay on EUR\/USD: 39\.9% of such signals reached TP1 before the SL \(break-even 40% before the spread\)\. Not a forecast\.$/);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- a market that has just resumed after a pause */

test('Gold monitor on the cloud: right after a pause no signal is shown; the first one comes when a 5-minute candle of the new session has closed', async () => {
  const market = directionalMarket();
  /* Set once the page clock is settled: no gold price between `from` and `to`. A feed has a candle only for a period with a price in it. */
  let pause = null;
  const candleRows = (code, granularity, count, now) => market(code, granularity, count, now).filter((row) => !pause || code !== 'frxXAUUSD' || row.epoch < pause.from || row.epoch + granularity > pause.to);
  const app = await bootApp({ world: { cloudDeriv: 'down', ticks: true, candleRows } });
  try {
    const clock = pageClock(app);
    const doc = app.doc;
    const text = (id) => doc.getElementById(id).textContent;
    const tickNow = () => {
      const stream = app.sockets.find((entry) => entry.sent.some((message) => message.style === 'ticks'));
      stream.socket.onmessage({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'frxXAUUSD', quote: GOLD_TICK, epoch: Math.floor(clock.now()) } }) });
    };
    await app.enter();
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    const close = clock.settle();
    /* Gold gave its first price two seconds ago, after half an hour without one (its daily break lasts an hour). */
    pause = { from: clock.now() - 1800, to: clock.now() - 2 };
    tickNow();
    await app.open('gold');
    await app.waitFor(() => text('goldSignalBadge') === 'UNAVAILABLE', 'the monitor to withhold the signal');
    assert.equal(text('goldRationale'), 'Deriv Gold has just resumed after a pause: no 5-minute candle has closed since. The first reading comes with the next 5-minute close. No old signal is being presented as current.');
    assert.equal(text('goldSignal'), '\u2014');
    assert.deepEqual(['goldEntry', 'goldSL', 'goldTP1'].map(text), ['\u2014', '\u2014', '\u2014']);
    assert.equal(text('goldMeasured'), '');
    assert.equal([...doc.querySelectorAll('#toasts .toast b')].filter((el) => /^Gold\/USD signal/.test(el.textContent)).length, 0, 'no alert from before the pause');

    /* Twenty seconds after the next 5-minute close: the candle that began with the new session has finished. */
    clock.advance(close + 320 - clock.now());
    tickNow();
    app.click(doc.getElementById('goldAnalyzeBtn'));
    await app.waitFor(() => text('goldFeedStatus').startsWith('LIVE ANALYSIS'), 'the first reading of the new session');
    assert.match(text('goldSignalUpdated'), new RegExp('^Reading of the ' + hhmm(close + 300) + ' candle close '));
    assert.ok(text('goldSignal') === 'BUY' || text('goldSignal') === 'SELL');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Gold monitor: an answer of the signal API that was made from before a pause is not shown; the browser reads the candles itself', async () => {
  const made = nowSec() - 2400;
  const fromBeforeThePause = {
    symbol: 'XAU/USD', signal: 'SELL', bias: 'bearish', confidence: 71, mtf_signal: 'SELL_CONFIRMED', votes: 'written by the test', data_ok: true,
    entry: 9999.99, price: 9999.99, stop_loss: 10014.99, tp1: 9977.49, tp2: 9959.99, rationale: 'written by the test', risks: [], model: 'technical', source: 'Deriv public candles',
    candle_close: made, candle_current: false
  };
  const pcApi = (path, body) => (path === '/api/signals/analyze' ? { status: 200, body: { ...fromBeforeThePause, latest_candle_time: nowSec() } } : liveScanApi(path, body));
  const app = await bootApp({ origin: PC_ORIGIN, pcApi, world: { ticks: true } });
  try {
    await app.enter();
    const doc = app.doc;
    const text = (id) => doc.getElementById(id).textContent;
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    await app.open('gold');
    await app.waitFor(() => text('goldFeedStatus').startsWith('LIVE ANALYSIS'), 'a gold analysis');
    assert.notEqual(text('goldEntry'), '9,999.99', 'the entry from before the pause is not on the page');
    /* What is shown was read by this browser from Deriv candles, at a close of the last few minutes. */
    const shownClose = (/^Reading of the (\d\d:\d\d) candle close /.exec(text('goldSignalUpdated')) || [])[1];
    const lastClose = Math.floor(nowSec() / 300) * 300;
    assert.ok([hhmm(lastClose), hhmm(lastClose - 300)].includes(shownClose), 'read at ' + shownClose);
    assert.notEqual(shownClose, hhmm(made));
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Exness connected: a terminal whose market has just resumed gives no Exness reading; the labelled fallback says why', async () => {
  const eur = { ...bridgeMarket('EUR/USD', { name: 'EURUSDm', level: 1.08, digits: 5 }), pauseSec: 2400 };
  const gold = { ...bridgeMarket('XAU/USD', { name: 'XAUUSDm', level: 4000, digits: 2 }), pauseSec: 2400 };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi: liveScanApi, bridgeApi: exnessBridge({ 'EUR/USD': eur, XAUUSD: gold }), world: { ticks: true } });
  try {
    await app.enter();
    const doc = app.doc;
    const text = (id) => doc.getElementById(id).textContent;
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the Deriv gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    await connectExness(app);

    /* The scanner: the terminal's newest candle and quote are current, but its finished candles are 40 minutes old. */
    await app.open('signals');
    app.click(doc.getElementById('refreshSigs'));
    const why = () => { const el = [...doc.querySelectorAll('#sigGrid .sig-card')].find((card) => card.querySelector('.sym-name').textContent === 'EUR/USD'); return el ? el.querySelector('.sig-why').textContent : ''; };
    await app.waitFor(() => /fallback \(Exness unavailable/.test(why()), 'the fallback reading');
    assert.match(why(), /source: Deriv public candles \u00b7 fallback \(Exness unavailable: Exness EUR\/USD has just resumed after a pause: no 5-minute candle has closed since\./);
    assert.doesNotMatch(why(), /Exness MT5 local candles/);

    /* The Gold monitor: the same refusal, and the Deriv fallback carries the reason. */
    await app.open('gold');
    await app.waitFor(() => text('goldFeedStatus').startsWith('LIVE ANALYSIS'), 'the gold analysis');
    assert.match(text('goldFeedStatus'), /^LIVE ANALYSIS \u00b7 Deriv public candles \u00b7 labelled fallback \(reason: Exness MT5 unavailable: Exness Gold has just resumed after a pause/);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Exness connected: a terminal without a finished 5-minute Gold candle is not called a pause; the labelled fallback says what is missing', async () => {
  /* The terminal has the whole 1-minute and 1-hour history of gold and, of the 5-minute one, only the candle that is forming. */
  const gold = { ...bridgeMarket('XAU/USD', { name: 'XAUUSDm', level: 4000, digits: 2 }), only: { M5: 1 } };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi: liveScanApi, bridgeApi: exnessBridge({ XAUUSD: gold }), world: { ticks: true } });
  try {
    await app.enter();
    const text = (id) => app.doc.getElementById(id).textContent;
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the Deriv gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    await connectExness(app);
    await app.open('gold');
    await app.waitFor(() => /^LIVE ANALYSIS .*Exness MT5 unavailable/.test(text('goldFeedStatus')), 'the gold analysis');
    assert.equal(text('goldFeedStatus'), 'LIVE ANALYSIS \u00b7 Deriv public candles \u00b7 labelled fallback (reason: Exness MT5 unavailable: Exness Gold history gives no finished 5-minute candle to read at yet.)');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- news: which markets, their own readings, standing aside */

/* Made-up feeds and calendar rows written by these tests: fixtures, not news. Nothing below asserts what a
   headline or a release means for a market; a reading shown beside one is a reading written by the test. */
const [FXSTREET_FEED, , CNBC_FEED] = HEADLINE_SOURCES.map((source) => source.url);
const feedXml = (items) => '<rss><channel>' + items.map((item) => '<item><title>' + item.title + '</title><link>' + item.link + '</link>'
  + (item.at ? '<pubDate>' + new Date(item.at).toUTCString() + '</pubDate>' : '') + '</item>').join('') + '</channel></rss>';
const newsFeeds = () => ({
  [CNBC_FEED]: feedXml([{ title: 'Fixture: Nvidia chief Jensen Huang opens a test event', link: 'https://cnbc.example/nvidia', at: Date.now() - 10 * 60000 }]),
  [FXSTREET_FEED]: feedXml([
    { title: 'Fixture: Gold steadies in a test headline', link: 'https://fx.example/gold', at: Date.now() - 5 * 60000 },
    { title: 'Fixture: council opens a new park', link: 'https://fx.example/park' }
  ])
});
const GOLD_SELL_VOTES = '1m -4 SELL · 5m -3 SELL · 1h +2 WAIT';
/* Readings written by the test for the markets the fixtures name; every other market keeps the reading it got. */
const newsReadings = (results) => results.map((reading) => {
  if (reading.symbol === 'XAU/USD') return { ...reading, signal: 'SELL', bias: 'bearish', confidence: 71, votes: GOLD_SELL_VOTES, entry: 4000, stop_loss: 4003, tp1: 3995.5, tp2: 3992 };
  if (reading.symbol === 'EUR/USD') return { ...reading, signal: 'WAIT', bias: 'bearish', confidence: 30, votes: '1m -2 WAIT · 5m -2 WAIT · 1h +1 WAIT', entry: 1.1, stop_loss: 1.0992, tp1: 1.1008, tp2: 1.1016, wait_reason: 'MTF_LEAN_NOT_CONFIRMED' };
  if (reading.symbol === 'NAS100') return { ...reading, signal: 'BUY', bias: 'bullish', confidence: 82 };
  return reading;
});
const flat = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const feedRow = (app, title) => [...app.doc.querySelectorAll('#newsFeed tbody tr')].find((tr) => tr.textContent.includes(title));
const calendarRow = (app, name) => [...app.doc.querySelectorAll('#newsCal tbody tr')].find((tr) => tr.textContent.includes(name));
/* The line under a release: its markets and its stand-aside period. null when the release has none. */
const calendarDetail = (app, name) => { const next = calendarRow(app, name).nextElementSibling; return next && next.classList.contains('news-sub') ? next : null; };
const eat = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(11, 16);
const calendarRows = (now) => [
  { title: 'Fixture rate decision', country: 'USD', impact: 'High', date: new Date(now + 20 * 60000).toISOString(), forecast: '1.0%', previous: '0.9%' },
  { title: 'Fixture output figure', country: 'GBP', impact: 'High', date: new Date(now + 120 * 60000).toISOString() },
  { title: 'Fixture survey', country: 'EUR', impact: 'Medium', date: new Date(now - 30 * 60000).toISOString() },
  { title: 'Fixture trade balance', country: 'CNY', impact: 'High', date: new Date(now + 40 * 60000).toISOString() }
];

test('News on the Cloudflare site: a headline names its markets and shows their own price readings, with no direction taken from the headline', async () => {
  const app = await bootApp({ world: { browserDeriv: 'down', rewriteScan: newsReadings, news: { feeds: newsFeeds(), calendar: [] } } });
  try {
    await app.enter();
    await app.open('news');
    await app.waitFor(() => feedRow(app, 'Nvidia') && /Sell \d+%/.test(flat(feedRow(app, 'Gold steadies'))), 'headlines with the readings of their markets');

    const nvidia = flat(feedRow(app, 'Nvidia').querySelector('.news-concern'));
    assert.match(nvidia, /^Concerns Nvidia → NAS100 Buy 82% · daily /, nvidia);
    assert.match(nvidia, /SPX500 .*US100 /, 'the three index markets Nvidia is part of');
    assert.ok(nvidia.endsWith('Nvidia is one of the largest companies in the Nasdaq-100 and the S&P 500, so news about it concerns those indices.'), nvidia);
    assert.equal(flat(feedRow(app, 'Gold steadies').querySelector('.news-concern')), 'Concerns Gold → XAU/USD Sell 71%');
    assert.equal(feedRow(app, 'Gold steadies').querySelector('[data-news-markets]').dataset.newsNamed, 'XAU/USD');
    assert.equal(flat(feedRow(app, 'new park').querySelector('.news-concern')), 'Names no market of this application.');
    assert.match(flat(feedRow(app, 'Gold steadies')), /FXStreet · (\w{3} )?\d\d:\d\d EAT/, 'source and Nairobi time under the headline');

    /* Nothing is derived from the wording of a headline: no keyword chip, no order button, no validity countdown. */
    const feed = app.doc.getElementById('newsFeed');
    assert.equal(feed.querySelectorAll('.news-exec, [data-nv]').length, 0);
    assert.doesNotMatch(flat(feed), /heuristic|sniper|Execute/i);
    for (const row of feed.querySelectorAll('tbody tr')) assert.equal(row.cells.length, 2, 'a headline and its buttons: no chip column on the cloud');
    assert.match(flat(app.doc.getElementById('newsSources')), /^Sources: FXStreet — 2 headlines · Investing\.com — not available \(unreachable\) · CNBC — 1 headline · read at (\w{3} )?\d\d:\d\d EAT$/);
    assert.match(flat(feed), /No direction is derived from a headline.*It is not a forecast of what the news will do to the price: a headline does not tell the direction\.$/);
    assert.equal(feedRow(app, 'Nvidia').querySelector('a[target="_blank"]').getAttribute('href'), 'https://cnbc.example/nvidia');

    /* The name of a market opens its chart. */
    app.click(feedRow(app, 'Gold steadies').querySelector('[data-news-open="XAU/USD"]'));
    await app.waitFor(() => app.doc.getElementById('view-trade').classList.contains('active'), 'the chart view');
    assert.equal(app.doc.getElementById('chartSymbol').value, 'XAU/USD');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('News calendar: Nairobi time, the markets of each release, and a stand-aside period that follows the clock', async () => {
  const start = Date.now();
  const app = await bootApp({ world: { browserDeriv: 'down', rewriteScan: newsReadings, news: { feeds: newsFeeds(), calendar: calendarRows(start) } } });
  try {
    await app.enter();
    await app.open('news');
    await app.waitFor(() => calendarRow(app, 'Fixture rate decision') && /Sell \d+%/.test(flat(calendarDetail(app, 'Fixture rate decision'))), 'the calendar with the readings of its markets');
    const aside = (name) => { const detail = calendarDetail(app, name); return detail ? detail.querySelector('.news-aside') : null; };
    const release = start + 20 * 60000;

    const usd = calendarRow(app, 'Fixture rate decision');
    assert.match(flat(usd.cells[0]), new RegExp('^(\\w{3} )?' + eat(release) + ' EAT$'), 'the time of the release on the Nairobi clock');
    assert.equal(usd.cells[0].getAttribute('title'), new Date(release).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
    assert.match(flat(calendarDetail(app, 'Fixture rate decision')), /^USD markets .*XAU\/USD Sell 71%/, 'the dollar markets, a Buy or Sell reading first');
    const onChart = app.doc.getElementById('chartSymbol').value;
    assert.equal(onChart, 'EUR/USD');
    assert.deepEqual([...calendarDetail(app, 'Fixture rate decision').querySelectorAll('[data-news-open]')].slice(0, 2).map((link) => link.dataset.newsOpen), [onChart, 'XAU/USD'], 'the market on the chart comes first, then the one with a Buy or Sell reading');
    assert.match(flat(aside('Fixture rate decision')), new RegExp('^STAND ASIDE NOW · release in (19|20) min · no new trade until ' + eat(release + 30 * 60000) + ' EAT$'));
    assert.ok(aside('Fixture rate decision').classList.contains('on'));
    assert.match(flat(usd), /f: 1\.0% · p: 0\.9%/, 'forecast and previous as the source gives them');

    assert.equal(flat(aside('Fixture output figure')), 'No new trade ' + eat(start + 90 * 60000) + '–' + eat(start + 150 * 60000) + ' EAT (30 min before to 30 min after)');
    assert.ok(!aside('Fixture output figure').classList.contains('on'));
    assert.match(flat(calendarDetail(app, 'Fixture survey')), /^EUR markets /);
    assert.equal(aside('Fixture survey'), null, 'a medium-impact release has no stand-aside period');
    assert.equal(flat(calendarDetail(app, 'Fixture trade balance')), 'no market of this application is priced in CNY');
    assert.equal(aside('Fixture trade balance'), null);

    const box = () => flat(app.doc.getElementById('newsAside'));
    assert.match(box(), new RegExp('^Stand aside now · USD — Fixture rate decision at (\\w{3} )?' + eat(release) + ' EAT\\. No new trade in USD markets until ' + eat(release + 30 * 60000) + ' EAT \\(EUR/USD, '));
    assert.match(box(), new RegExp('Next · GBP — Fixture output figure at (\\w{3} )?' + eat(start + 120 * 60000) + ' EAT\\. No new trade in GBP markets from ' + eat(start + 90 * 60000) + ' to ' + eat(start + 150 * 60000) + ' EAT'));
    const note = flat(app.doc.getElementById('newsCal'));
    assert.match(note, /Source: ForexFactory public weekly calendar · read at \d\d:\d\d EAT · times are Nairobi time \(EAT, UTC\+3\)/);
    assert.match(note, /Measured on gold around 379 high-impact US releases/);
    assert.match(note, /not the result: which way a release moves a market is not shown, because it is not known\.$/);
    assert.doesNotMatch(note, /sniper|all times UTC|trade them inside/i);

    /* One minute after the release: still inside the period. No price tick is needed for the clock to be followed. */
    app.advanceClock(21 * 60000);
    app.runIntervals(1000);
    await app.waitFor(() => /released/.test(flat(aside('Fixture rate decision'))), 'the period after the release');
    assert.match(flat(aside('Fixture rate decision')), new RegExp('^STAND ASIDE · released · no new trade for another (28|29) min, until ' + eat(release + 30 * 60000) + ' EAT$'));
    assert.match(box(), /^Stand aside now · USD/);

    /* Half an hour after the release the period is over, and the box no longer names the dollar. */
    app.advanceClock(30 * 60000);
    app.runIntervals(1000);
    await app.waitFor(() => /over since/.test(flat(aside('Fixture rate decision'))), 'the end of the period');
    assert.equal(flat(aside('Fixture rate decision')), 'Stand-aside period over since ' + eat(release + 30 * 60000) + ' EAT');
    assert.ok(!aside('Fixture rate decision').classList.contains('on'));
    assert.doesNotMatch(box(), /· USD —/, 'no dollar period is running or coming');
    assert.match(box(), /^Next · GBP — Fixture output figure/);

    /* The calendar source stops answering. The cloud passes on the schedule it read last, the card says when that was
       read and that the source has been silent since, and the stand-aside period of the next release is still shown. */
    const calendarReads = () => app.requests.filter((r) => r.path === '/api/news/calendar');
    const settled = async () => { await app.waitFor(() => calendarReads().every((r) => r.status !== null), 'no calendar read under way'); await new Promise((r) => setTimeout(r, 30)); };
    await settled();
    /* First a read that succeeds, 82 minutes after the start: the open view asks by itself, and the cloud's half hour is over. */
    const reads = calendarReads().length;
    app.advanceClock(31 * 60000);
    const readFrom = Date.now() + 82 * 60000;
    await app.waitFor(() => { app.runIntervals(1000); return calendarReads().length > reads; }, 'the calendar read again while the view stayed open');
    await settled();
    const readUntil = Date.now() + 82 * 60000;
    assert.doesNotMatch(flat(app.doc.getElementById('newsCal')), /has not answered since/);
    /* Then silence for 50 minutes. */
    app.state.news = { feeds: newsFeeds() };
    app.advanceClock(50 * 60000);
    await app.waitFor(() => { app.runIntervals(1000); return /has not answered since/.test(flat(app.doc.getElementById('newsCal'))); }, 'the note about the silent source');
    assert.match(flat(app.doc.getElementById('newsCal')), new RegExp('Source: ForexFactory public weekly calendar · read at (\\w{3} )?(' + eat(readFrom) + '|' + eat(readUntil) + ') EAT \\(the source has not answered since: this is the schedule as it stood then\\) · times are Nairobi time'));
    assert.match(flat(aside('Fixture output figure')), new RegExp('^STAND ASIDE · released · no new trade for another (16|17|18) min, until ' + eat(start + 150 * 60000) + ' EAT$'), 'the period of the last release, from the copy');
    assert.doesNotMatch(flat(app.doc.getElementById('newsCal')), /Calendar unavailable/);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('the line above the chart: direction with its score, what each timeframe shows, levels for a Buy or Sell only, the measured result and a coming release', async () => {
  const start = Date.now();
  const app = await bootApp({ world: { browserDeriv: 'down', rewriteScan: newsReadings, news: { feeds: newsFeeds(), calendar: calendarRows(start) } } });
  try {
    await app.enter();
    await app.open('trade');
    const select = app.doc.getElementById('chartSymbol');
    const choose = (symbol) => { select.value = symbol; select.dispatchEvent(new app.window.Event('change', { bubbles: true })); };
    const strip = app.doc.getElementById('chartLevels');

    choose('XAU/USD');
    await app.waitFor(() => /Sell \d+%/.test(flat(strip)) && /Stand aside/.test(flat(strip)), 'the gold reading and the coming release on the strip');
    const gold = flat(strip);
    assert.match(gold, /^LIVE SIGNAL LEVELS Sell 71% now: down on 1m and 5m, up on 1h E 4000\.00 · SL 4003\.00 · TP1 3995\.50 · TP2 3992\.00 measured 39\.6% % = how strongly the timeframes agree, not the chance of profit /, gold);
    assert.match(gold, new RegExp('Stand aside · USD Fixture rate decision at (\\w{3} )?' + eat(start + 20 * 60000) + ' EAT · no new trade until ' + eat(start + 50 * 60000) + ' EAT$'));
    assert.equal(strip.querySelector('[data-chart-measured]').getAttribute('title'), GOLD_MEASURED_CLOSE);
    assert.match(strip.querySelector('[data-chart-trend]').getAttribute('title'), /it does not say that the direction will continue/);
    assert.equal(strip.querySelector('[data-chart-event]').dataset.chartEvent, 'aside');

    /* A Wait that leans down: the direction it leans, no entry, stop or target. */
    choose('EUR/USD');
    await app.waitFor(() => /Wait · leans down/.test(flat(strip)), 'the euro reading on the strip');
    const euro = flat(strip);
    assert.match(euro, /^LIVE SIGNAL LEVELS Wait · leans down now: down on 1m and 5m, no clear direction on 1h no entry, stop or target: they come only with a Buy or Sell reading % = how strongly/, euro);
    assert.doesNotMatch(euro, /\bSL\b|TP1|unconfirmed|1\.0992|measured/, 'the placeholder levels of a Wait are not shown');
    assert.match(euro, /Stand aside · USD Fixture rate decision/, 'EUR/USD is a dollar market as well');

    assert.equal(app.requests.filter((r) => r.path === '/api/news/calendar').length, 1, 'the calendar is read once for the line above the chart, not at every change of market');

    /* Once the period is over the note is gone, without a price tick. */
    app.advanceClock(51 * 60000);
    app.runIntervals(1000);
    await app.waitFor(() => !/Stand aside/.test(flat(strip)), 'the strip after the period');
    assert.doesNotMatch(flat(strip), /Fixture rate decision/);
    /* A chart that stays open reads the calendar again by itself: a release added since then appears without a change of market. */
    await app.waitFor(() => app.requests.filter((r) => r.path === '/api/news/calendar' && r.status === 200).length === 2, 'the calendar read again while the chart stays open');
    await new Promise((r) => setTimeout(r, 30)); /* the page takes the answer in */
    app.state.news = { feeds: newsFeeds(), calendar: [{ title: 'Fixture added release', country: 'USD', impact: 'High', date: new Date(start + 150 * 60000).toISOString() }] };
    app.advanceClock(31 * 60000);
    /* The page's one-second round, again and again as in a browser: it reads the calendar when that is due and redraws the line. */
    await app.waitFor(() => { app.runIntervals(1000); return /Fixture added release/.test(flat(strip)); }, 'the release that was added to the calendar');
    assert.match(flat(strip), new RegExp('High-impact release (\\w{3} )?' + eat(start + 150 * 60000) + ' EAT · USD Fixture added release · no new trade from ' + eat(start + 120 * 60000) + ' EAT$'));

    /* In the Markets view a Wait shows no levels either. */
    await app.open('markets');
    await app.waitFor(() => app.doc.querySelector('.market-levels'), 'levels of a Buy or Sell reading');
    for (const levels of app.doc.querySelectorAll('.market-levels')) assert.doesNotMatch(flat(levels), /unconfirmed|≈/);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('the line above the chart says when the calendar could not be read, instead of showing no release', async () => {
  const app = await bootApp({ world: { browserDeriv: 'down', rewriteScan: newsReadings } });
  try {
    await app.enter();
    await app.open('trade');
    const select = app.doc.getElementById('chartSymbol');
    select.value = 'XAU/USD';
    select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    const strip = app.doc.getElementById('chartLevels');
    await app.waitFor(() => /calendar not available/.test(flat(strip)), 'the note about the calendar');
    assert.ok(flat(strip).endsWith('calendar not available: scheduled releases unknown'), flat(strip));
    assert.equal(strip.querySelector('[data-chart-event]').dataset.chartEvent, 'unknown');
    await app.open('news');
    await app.waitFor(() => /Calendar unavailable/.test(flat(app.doc.getElementById('newsCal'))) && /Headline feed unavailable/.test(flat(app.doc.getElementById('newsFeed'))), 'both cards say what failed');
    assert.match(flat(app.doc.getElementById('newsCal')), /No events are assumed\..*Scheduled releases are unknown until the calendar loads: nothing here says there are none\.$/);
    assert.match(flat(app.doc.getElementById('newsFeed')), /No headline source could be read from the cloud right now \(FXStreet: unreachable; Investing\.com: unreachable; CNBC: unreachable\)\. No substitute headlines are shown\./);

    /* The source answers again. Nothing is pressed: the open view tries again, here two minutes later, and shows the calendar. */
    const back = Date.now() + 121000;
    app.state.news = { calendar: [{ title: 'Fixture rate decision', country: 'USD', impact: 'High', date: new Date(back + 20 * 60000).toISOString() }] };
    app.advanceClock(121000);
    app.runIntervals(1000);
    await app.waitFor(() => calendarRow(app, 'Fixture rate decision'), 'the calendar after the source came back');
    assert.doesNotMatch(flat(app.doc.getElementById('newsCal')), /Calendar unavailable/);
    await app.open('trade');
    app.runIntervals(1000);
    await app.waitFor(() => /Stand aside · USD Fixture rate decision/.test(flat(strip)), 'the release on the strip after the source came back');
    assert.doesNotMatch(flat(strip), /calendar not available/);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('the PC app keeps its keyword chip and its order button where its server sends them, beside the markets a headline names', async () => {
  const pcApi = (path, body) => {
    if (path === '/api/news/feed') return { status: 200, body: { note: 'Direction chips are a keyword heuristic — not AI, not advice.', items: [
      { title: 'Fixture: euro headline', link: 'https://example.test/euro', source: 'Test wire', t: Date.now(), bias: { ccy: 'EUR', tone: 'up', pair: 'EUR/USD', dir: 'BUY', engine: 'heuristic' } },
      { title: 'Fixture: plain headline', link: 'javascript:alert(1)', source: 'Test wire', bias: null }
    ] } };
    if (path === '/api/news/calendar') return { status: 200, body: { day: pcDay, source: 'test calendar', events: [{ time_utc: new Date(pcRelease).toISOString().slice(11, 16), country: 'USD', event: 'Fixture PC release', impact: 'High', forecast: '', previous: '' }] } };
    return liveScanApi(path, body);
  };
  /* The PC server sends the entries of the UTC day with a clock time and no moment: a release 40 minutes ahead, or 20 minutes ago
     when that would be tomorrow. Tomorrow on either calendar: the server's day ends at 24:00 UTC, the page's (Nairobi) at 21:00 UTC,
     and a release after the page's midnight is not under "upcoming today". (Until 13 November 2026 only the UTC day was looked at,
     and this test failed when run between 20:20 and 21:00 UTC.) */
  const started = Date.now();
  const dayUtc = (ms) => new Date(ms).toISOString().slice(0, 10), dayNairobi = (ms) => dayUtc(ms + 3 * 3600000);
  const pcDay = dayUtc(started);
  const ahead = started + 40 * 60000;
  const pcRelease = Math.floor((dayUtc(ahead) === pcDay && dayNairobi(ahead) === dayNairobi(started) ? ahead : started - 20 * 60000) / 60000) * 60000;
  const app = await bootApp({ origin: PC_ORIGIN, pcApi });
  try {
    await app.enter();
    await app.open('news');
    await app.waitFor(() => feedRow(app, 'euro headline'), 'the headlines of the PC server');
    const euro = feedRow(app, 'euro headline');
    assert.match(flat(euro.cells[0]), /^BUY EUR\/USD · heuristic$/);
    assert.equal(euro.querySelectorAll('.news-exec').length, 1);
    assert.match(flat(euro.querySelector('.news-concern')), /^Concerns Euro → EUR\/USD /);
    const plain = feedRow(app, 'plain headline');
    assert.equal(plain.querySelectorAll('.news-exec').length, 0);
    for (const link of plain.querySelectorAll('a[target="_blank"]')) assert.equal(link.getAttribute('href'), '#', 'an address that is not a web address is not made a link');
    assert.match(flat(app.doc.getElementById('newsFeed')), /then goes STALE and Execute stands down/);
    assert.equal(app.doc.getElementById('newsSources'), null, 'the PC server names its source on each headline only');
    /* The calendar of the PC server, in its own shape, gives the same stand-aside period: in the News view and on the Gold page. */
    const period = eat(pcRelease - 30 * 60000) + '–' + eat(pcRelease + 30 * 60000) + ' EAT';
    await app.waitFor(() => calendarRow(app, 'Fixture PC release'), 'the release of the PC calendar');
    const pcAside = flat(calendarDetail(app, 'Fixture PC release').querySelector('.news-aside'));
    if (pcRelease > started) assert.equal(pcAside, 'No new trade ' + period + ' (30 min before to 30 min after)');
    else assert.match(pcAside, new RegExp('^STAND ASIDE · released · no new trade for another \\d+ min, until ' + eat(pcRelease + 30 * 60000) + ' EAT$'));
    assert.doesNotMatch(flat(app.doc.getElementById('newsCal')), /read at/, 'the PC server does not say when it read its source, and no time is made up');
    await app.open('gold');
    await app.waitFor(() => app.doc.querySelector('#goldEvents [data-gold-aside-span]'), 'the release on the Gold page of the PC app');
    assert.equal(flat(app.doc.querySelector('#goldEvents [data-gold-aside-span]')), 'no new trade ' + period);
    assert.equal(app.doc.querySelectorAll('#goldEvents tbody tr').length, 1);
    assert.equal(app.requests.filter((r) => r.path === '/api/news/calendar').length, 1, 'one calendar for the page on the PC as well');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Gold page on the cloud: the dollar releases with their stand-aside period, the note under the signal, and an alert before a release that says to stand aside', async () => {
  const start = Date.now();
  /* On a whole minute, as a calendar lists its releases: 50 to 51 minutes ahead. */
  const release = Math.floor(start / 60000) * 60000 + 51 * 60000;
  const app = await bootApp({ world: { cloudDeriv: 'down', ticks: true, candleRows: directionalMarket(), news: { feeds: newsFeeds(), calendar: [
    { title: 'Fixture output figure', country: 'GBP', impact: 'High', date: new Date(start + 10 * 60000).toISOString() },
    { title: 'Fixture rate decision', country: 'USD', impact: 'High', date: new Date(release).toISOString() },
    { title: 'Fixture stock report', country: 'USD', impact: 'Medium', date: new Date(release + 150 * 60000).toISOString() },
    /* Within the next 24 hours, and (unless the test starts in the first minutes of a UTC day) on the next UTC day. */
    { title: 'Fixture later figure', country: 'USD', impact: 'High', date: new Date(release + 23 * 3600000).toISOString() },
    { title: 'Fixture far figure', country: 'USD', impact: 'High', date: new Date(release + 26 * 3600000).toISOString() }
  ] } } });
  try {
    const clock = pageClock(app);
    const doc = app.doc;
    const text = (id) => doc.getElementById(id).textContent;
    const eventRow = (name) => [...doc.querySelectorAll('#goldEvents tbody tr')].find((tr) => tr.textContent.includes(name));
    const aside = () => flat(doc.getElementById('goldAside'));
    const alerts = () => [...doc.querySelectorAll('#toasts .toast')].filter((toast) => toast.querySelector('b').textContent === 'Gold news alert').map((toast) => toast.querySelector('span').textContent);
    const tickNow = () => {
      const stream = app.sockets.find((entry) => entry.sent.some((message) => message.style === 'ticks'));
      stream.socket.onmessage({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'frxXAUUSD', quote: GOLD_TICK, epoch: Math.floor(clock.now()) } }) });
    };
    const utc = (ms) => new Date(ms).toISOString().slice(11, 16);
    const period = eat(release - 30 * 60000) + '–' + eat(release + 30 * 60000) + ' EAT';
    /* A moment as the page writes it: the Nairobi clock, with the weekday when that is not today's Nairobi day. */
    const nairobiDay = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 10);
    const stamp = (ms) => (nairobiDay(ms) === nairobiDay(start) ? '' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ms + 3 * 3600000).getUTCDay()] + ' ') + eat(ms) + ' EAT';

    await app.enter();
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    await app.open('gold');
    await app.waitFor(() => eventRow('Fixture rate decision') && text('goldFeedStatus').startsWith('LIVE ANALYSIS'), 'the dollar releases and the first gold analysis');

    /* The table: dollar releases only, both clocks, and the stand-aside period of a high-impact one. */
    const row = eventRow('Fixture rate decision');
    assert.equal(flat(row.cells[0]), utc(release) + ' UTC · ' + stamp(release));
    assert.equal(flat(row.cells[1]), 'High');
    assert.equal(flat(row.cells[2].querySelector('[data-gold-aside-span]')), 'no new trade ' + period);
    assert.equal(row.cells[2].firstChild.textContent, 'Fixture rate decision');
    assert.equal(flat(eventRow('Fixture stock report').cells[2]), 'Fixture stock report', 'a medium-impact release has no stand-aside period');
    assert.equal(eventRow('Fixture output figure'), undefined, 'a release of another currency is not a gold release');
    const later = eventRow('Fixture later figure');
    assert.ok(later, 'a release within the next 24 hours is listed, whichever UTC day it is on');
    assert.equal(flat(later.cells[0]), utc(release + 23 * 3600000) + ' UTC · ' + stamp(release + 23 * 3600000), 'with its weekday when it is not today in Nairobi');
    assert.equal(eventRow('Fixture far figure'), undefined, 'more than 24 hours ahead is not listed');
    assert.equal(doc.querySelectorAll('#goldEvents tbody tr').length, 3);
    assert.equal(app.requests.filter((r) => r.path === '/api/news/calendar').length, 1, 'one calendar for the page');

    /* Under the signal: the release that is coming, while the reading itself stays shown. */
    assert.ok(['BUY', 'SELL'].includes(text('goldSignal')));
    assert.equal(aside(), 'High-impact release ' + stamp(release) + ' · USD Fixture rate decision · no new trade from ' + eat(release - 30 * 60000) + ' EAT');
    assert.equal(doc.querySelector('#goldAside [data-chart-event]').dataset.chartEvent, 'ahead');
    assert.deepEqual(alerts(), [], 'no alert 50 minutes before');

    /* The Refresh button reads the calendar again; the monitor's own round every five minutes uses the copy the page has, for ten minutes. */
    const answered = (path) => app.requests.filter((r) => r.path === path && r.status !== null).length;
    app.click(doc.getElementById('goldNewsRefresh'));
    await app.waitFor(() => answered('/api/news/calendar') === 2 && answered('/api/news/feed') === 2, 'the calendar read again on request');
    await new Promise((r) => setTimeout(r, 30));
    clock.advance(6 * 60);
    tickNow();
    app.runIntervals(10000);
    await app.waitFor(() => answered('/api/news/feed') === 3, 'the regular round of the monitor');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(answered('/api/news/calendar'), 2, 'the copy read six minutes ago is used');
    assert.ok(eventRow('Fixture rate decision'), 'and the table is drawn from it');

    /* A quarter of an hour before the release: the period is running, and the alert says so before anything else. */
    clock.advance((release - 14.5 * 60000) / 1000 - clock.now());
    tickNow();
    app.runIntervals(10000);
    await app.waitFor(() => alerts().length === 1, 'the alert 15 minutes before');
    assert.match(aside(), new RegExp('^Stand aside · USD Fixture rate decision at (\\w{3} )?' + eat(release) + ' EAT · no new trade until ' + eat(release + 30 * 60000) + ' EAT$'));
    assert.equal(doc.querySelector('#goldAside [data-chart-event]').dataset.chartEvent, 'aside');
    const head = (minutes) => 'USD high-impact event in about ' + minutes + ' minutes: Fixture rate decision (' + utc(release) + ' UTC / ' + eat(release) + ' EAT). Stand aside: no new Gold trade ' + period + ' (30 min before to 30 min after). Expect possible volatility; check the live quote and spread.';
    const first = alerts()[0];
    assert.ok(first.startsWith(head(15) + '\nGold reading now, for information only (the stand-aside period applies to it):\n🟡 Gold/USD technical signal · '), first);
    assert.doesNotMatch(first, /Current Gold signal/);

    /* The same check a few seconds later does not repeat the alert; five minutes before there is the second one. */
    app.runIntervals(10000);
    assert.equal(alerts().length, 1);
    clock.advance((release - 4.5 * 60000) / 1000 - clock.now());
    tickNow();
    app.runIntervals(10000);
    await app.waitFor(() => alerts().length === 2, 'the alert 5 minutes before');
    assert.ok(alerts().some((body) => body.startsWith(head(5))), alerts().join('\n---\n'));

    /* Half an hour after the release the note is gone. */
    clock.advance((release + 30.5 * 60000) / 1000 - clock.now());
    tickNow();
    app.runIntervals(10000);
    await app.waitFor(() => aside() === '', 'the note after the period');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Gold page: a calendar that cannot be read is said under the signal and in the table, and no alert is made from it', async () => {
  const app = await bootApp({ world: { cloudDeriv: 'down', ticks: true, candleRows: directionalMarket() } });
  try {
    const doc = app.doc;
    await app.enter();
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    await app.open('gold');
    await app.waitFor(() => /USD calendar unavailable/.test(flat(doc.getElementById('goldEvents'))) && flat(doc.getElementById('goldAside')) !== '', 'the missing calendar on the Gold page');
    assert.match(flat(doc.getElementById('goldEvents')), /No upcoming-event claim is being made\.$/);
    assert.equal(flat(doc.getElementById('goldAside')), 'calendar not available: scheduled releases unknown');
    assert.match(flat(doc.getElementById('goldHeadlines')), /^Headline feed unavailable/);
    assert.equal([...doc.querySelectorAll('#toasts .toast b')].filter((el) => el.textContent === 'Gold news alert').length, 0);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- the PC app and the website show the same reading */

/* Reported on 13 Nov 2026 with two screenshots of the same minute: the PC app (Exness not connected) and the
   website showed different scores and levels for the same markets, and the PC's Gold page said "Last analysis",
   "once per minute", where the website said "Reading of the 14:35 candle close". Two causes: the PC served an
   older build of the page (tests/platform/pc-page.test.mjs), and the PC's own server made its reading from the
   forming candles. In these tests the page talks to the real server/app.js, which reads the same candles as the
   rest of `world`. */

test('PC app, its own server: the Gold monitor shows one reading per finished 5-minute candle, the one the rule gives at that close', async () => {
  const market = directionalMarket();
  const app = await bootApp({ origin: PC_ORIGIN, pcServer: true, world: { ticks: true, candleRows: market } });
  try {
    const clock = pageClock(app);
    const doc = app.doc;
    const text = (id) => doc.getElementById(id).textContent;
    const levelsShown = () => ({ signal: text('goldSignal'), entry: text('goldEntry'), stop: text('goldSL'), target: text('goldTP1'), measured: text('goldMeasured') });
    const closeShown = () => (/^Reading of the (\d\d:\d\d) candle close /.exec(text('goldSignalUpdated')) || [])[1];
    const tickNow = () => {
      const stream = app.sockets.find((entry) => entry.sent.some((message) => message.style === 'ticks'));
      stream.socket.onmessage({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'frxXAUUSD', quote: GOLD_TICK, epoch: Math.floor(clock.now()) } }) });
    };
    const look = async () => {
      const before = text('goldSignalUpdated');
      tickNow();
      app.click(doc.getElementById('goldAnalyzeBtn'));
      await app.waitFor(() => text('goldSignalUpdated') !== before && text('goldFeedStatus').startsWith('LIVE ANALYSIS'), 'the gold analysis');
      return levelsShown();
    };
    /* What the rule reads from the finished candles of this market at the page's time: the reading the website shows. */
    const ruleNow = () => {
      const sets = Object.fromEntries([['m1', 60], ['m5', 300], ['h1', 3600]].map(([key, granularity]) => [key,
        market('frxXAUUSD', granularity, 120, Math.floor(clock.now())).map((row) => ({ time: row.epoch, open: row.open, high: row.high, low: row.low, close: row.close }))]));
      return localDecision(runDeterministicAnalysis('XAU/USD', closedCandleSets(sets).sets));
    };
    const shown = (value) => Number(String(value).replace(/,/g, ''));

    await app.enter();
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    const close = clock.settle();
    /* settle() may have moved the clock by up to 140 seconds, and the monitor analyses only with a gold price under
       two minutes old: without a new tick this test failed when it began 180 to 200 seconds after a 5-minute close. */
    tickNow();
    await app.open('gold');
    await app.waitFor(() => text('goldFeedStatus').startsWith('LIVE ANALYSIS'), 'the first gold analysis');

    /* The PC's own wording for where the reading comes from; the reading itself is made by the PC's server. */
    assert.equal(text('goldFeedStatus'), 'LIVE ANALYSIS \u00b7 Deriv public candles \u00b7 labelled fallback (reason: Exness MT5 bridge is not connected)');
    assert.ok(app.requests.some((r) => r.path === '/api/signals/analyze' && r.status === 200), 'answered by the PC server');
    assert.ok(app.sockets.every((entry) => entry.sent.every((message) => message.style === 'ticks')), 'the browser opened no candle connection of its own');

    const first = levelsShown();
    assert.ok(first.signal === 'BUY' || first.signal === 'SELL', 'the page reads the chosen market as a direction, as the rule did when asked');
    /* The lines the website shows, word for word. */
    assert.equal(closeShown(), hhmm(close));
    assert.match(text('goldSignalUpdated'), /^Reading of the \d\d:\d\d candle close \u00b7 checked .* \u00b7 the next reading comes with the next 5-minute close; no fixed expiry\.$/);
    assert.match(text('goldAnalysisNoticeText'), /^Verified source: Deriv public candles \u00b7 labelled fallback \(reason: Exness MT5 bridge is not connected\)\. Last successful check \d+s ago\. Auto-refresh next check in \d+s \(a reading changes only when a 5-minute candle closes\)\.$/);
    assert.equal(first.measured, GOLD_MEASURED_CLOSE);
    /* ...and the figures of the rule at that close. */
    const rule = ruleNow();
    assert.equal(first.signal, rule.signal);
    assert.ok(Math.abs(shown(first.entry) - rule.entry) < 0.006, `entry ${first.entry} against ${rule.entry}`);
    assert.ok(Math.abs(shown(first.stop) - rule.stop_loss) < 0.006, `stop ${first.stop} against ${rule.stop_loss}`);
    assert.ok(Math.abs(shown(first.target) - rule.tp1) < 0.006, `target ${first.target} against ${rule.tp1}`);

    /* A minute later, inside the same 5-minute candle: the same reading in every figure. */
    clock.advance(61);
    assert.deepEqual(await look(), first);
    assert.equal(closeShown(), hhmm(close));

    /* After the next close: the next reading, at another price. */
    clock.advance(close + 320 - clock.now());
    const next = await look();
    assert.equal(closeShown(), hhmm(close + 300));
    assert.notEqual(next.entry, first.entry);
    assert.ok(Math.abs(shown(next.entry) - ruleNow().entry) < 0.006);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('PC app, its own server: every signal card and every row of the Markets table says which 5-minute close it was read at', async () => {
  const app = await bootApp({ origin: PC_ORIGIN, pcServer: true, world: { ticks: true, candleRows: directionalMarket() } });
  try {
    await app.openMarkets();
    const PC_SOURCE = 'Deriv public candles \u00b7 fallback (Exness unavailable: Exness bridge is not connected in this tab.)';
    for (const symbol of DERIV_SYMBOLS) {
      const row = app.row(symbol);
      assert.match(row.badge, /^(Buy|Sell)/, `${symbol}: the chosen market reads as a direction`);
      assert.equal(row.source, 'source: ' + PC_SOURCE, symbol);
    }
    await app.open('signals');
    const grid = app.doc.getElementById('sigGrid');
    await app.waitFor(() => grid.querySelectorAll('.sig-card').length > 0, 'signal cards');
    const cards = [...grid.querySelectorAll('.sig-card')].map((card) => ({ symbol: card.querySelector('.sym-name').textContent, why: card.querySelector('.sig-why').textContent, measured: (card.querySelector('.sig-measured') || {}).textContent || '' }));
    const fromDeriv = cards.filter((card) => DERIV_SYMBOLS.includes(card.symbol));
    assert.ok(fromDeriv.length >= 3, 'cards of Deriv markets');
    for (const card of fromDeriv) {
      assert.ok(card.why.endsWith(' \u00b7 source: ' + PC_SOURCE + ' \u00b7 read at the ' + (/(\d\d:\d\d) candle close$/.exec(card.why) || [])[1] + ' candle close'), card.symbol + ': ' + card.why);
    }
    /* The replay figure under a card is the one of the 5-minute rule, as on the website. */
    const eur = fromDeriv.find((card) => card.symbol === 'EUR/USD');
    if (eur) assert.equal(eur.measured, EUR_MEASURED_CLOSE);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('PC app: a reading the PC server made from before a pause is not shown; the row says the market has just resumed', async () => {
  const candleTime = nowSec();
  const pcApi = (path, body) => {
    if (path === '/api/health') return { status: 200, body: { ok: true } };
    if (path === '/api/signals/scan') {
      return { status: 200, body: { results: body.symbols.map((symbol) => ({ ...LIVE_BUY, symbol, latest_candle_time: candleTime, candle_close: Math.floor(candleTime / 300) * 300 - 2400, candle_current: symbol !== 'EUR/USD' })) } };
    }
    return null;
  };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi });
  try {
    await app.openMarkets();
    /* The row the website shows for the same state (src/hostedscan.js, resumedReading). */
    const eur = app.row('EUR/USD');
    assert.equal(eur.badge, 'Stale data');
    assert.equal(eur.title, 'EUR/USD has just resumed after a pause: no 5-minute candle has closed since, so a reading would describe the market before the pause. The first reading comes with the next 5-minute close.');
    assert.equal(eur.source, 'source: Deriv public candles \u00b7 resumed, waiting for a finished candle');
    assert.equal(eur.levels, false, 'no entry, stop or target from before the pause');
    assert.equal(eur.hasRetry, false, 'a retry cannot help before the next close');
    assert.match(app.row('GBP/USD').badge, /^Buy/, 'a market that ran through keeps its reading');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* The order ticket of the PC app fills its stop and targets from a reading. What it must never take them from is
   a reading made before a pause: the entry of such a reading is not the price now. */
const RESUMED_DETAIL = (symbol) => symbol + ' has just resumed after a pause: no 5-minute candle has closed since, so a reading would describe the market before the pause. The first reading comes with the next 5-minute close.';
const ticketOf = (app) => {
  const doc = app.doc, select = doc.getElementById('chartSymbol');
  return {
    note: doc.getElementById('levelsNote'),
    /* the line above the chart, without the calendar note that follows the reading */
    strip: () => doc.getElementById('chartLevels').firstElementChild.textContent,
    /* choosing the symbol that is already on the chart asks for its reading again */
    choose: (symbol) => { select.value = symbol; select.dispatchEvent(new app.window.Event('change', { bubbles: true })); },
    levels: () => ['orderSL', 'orderTP', 'orderTP2'].map((id) => doc.getElementById(id).value),
    type: (id, value) => { const field = doc.getElementById(id); field.value = value; field.dispatchEvent(new app.window.Event('input', { bubbles: true })); }
  };
};

test('PC app, order ticket: a reading from before a pause fills nothing, also when the server only marks it; levels filled in earlier are withdrawn, typed ones stay', async () => {
  const candleTime = nowSec();
  const resumed = new Set(['EUR/USD']);
  /* A server that still hands out the reading from before the pause, marked candle_current:false (as the read-only Worker does). */
  const pcApi = (path, body) => {
    if (path === '/api/health') return { status: 200, body: { ok: true } };
    if (path === '/api/signals/scan') {
      return { status: 200, body: { results: body.symbols.map((symbol) => ({ ...LIVE_BUY, symbol, latest_candle_time: candleTime, candle_close: Math.floor(candleTime / 300) * 300 - (resumed.has(symbol) ? 2400 : 0), candle_current: !resumed.has(symbol) })) } };
    }
    return null;
  };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi });
  try {
    await app.enter();
    await app.open('trade');
    const ticket = ticketOf(app);
    const filled = [LIVE_BUY.stop_loss, LIVE_BUY.tp1, LIVE_BUY.tp2].map((level) => level.toFixed(5));

    /* A market that runs: its stop and targets go onto the ticket. */
    ticket.choose('GBP/USD');
    await app.waitFor(() => /^Levels from live analysis/.test(ticket.note.textContent), 'levels for a market that runs');
    assert.deepEqual(ticket.levels(), filled);

    /* A market that has just resumed: the answer holds a BUY with levels; none of it reaches the ticket or the chart. */
    ticket.choose('EUR/USD');
    await app.waitFor(() => ticket.note.textContent === RESUMED_DETAIL('EUR/USD'), 'the ticket note for a market that has just resumed');
    assert.deepEqual(ticket.levels(), ['', '', '']);
    assert.equal(ticket.strip(), RESUMED_DETAIL('EUR/USD'));

    /* A market pauses and resumes while its levels are on the ticket: asked again, they are withdrawn. */
    ticket.choose('GBP/USD');
    await app.waitFor(() => /^Levels from live analysis/.test(ticket.note.textContent), 'levels for GBP/USD again');
    assert.deepEqual(ticket.levels(), filled);
    resumed.add('GBP/USD');
    ticket.choose('GBP/USD');
    await app.waitFor(() => ticket.note.textContent === RESUMED_DETAIL('GBP/USD'), 'the ticket note once GBP/USD has resumed');
    assert.deepEqual(ticket.levels(), ['', '', ''], 'the levels of the reading before the pause are gone');
    assert.equal(ticket.strip(), RESUMED_DETAIL('GBP/USD'));

    /* A stop the trader typed is his own: it stays. */
    ticket.type('orderSL', '1.23456');
    ticket.choose('GBP/USD');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(ticket.note.textContent, RESUMED_DETAIL('GBP/USD'));
    assert.deepEqual(ticket.levels(), ['1.23456', '', '']);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('PC app, its own server: a chart chosen right after a pause gets no reading and no levels; the first 5-minute close of the new session brings both', async () => {
  const market = directionalMarket();
  /* Set once the page clock is settled: no GBP/USD price between `from` and `to`. A feed has a candle only for a period with a price in it. */
  let pause = null;
  const candleRows = (code, granularity, count, now) => market(code, granularity, count, now).filter((row) => !pause || code !== 'frxGBPUSD' || row.epoch < pause.from || row.epoch + granularity > pause.to);
  const app = await bootApp({ origin: PC_ORIGIN, pcServer: true, world: { ticks: true, candleRows } });
  try {
    const clock = pageClock(app);
    await app.enter();
    await app.open('trade');
    const ticket = ticketOf(app);
    const close = clock.settle();
    /* GBP/USD gave its first price two seconds ago, after half an hour without one. */
    pause = { from: clock.now() - 1800, to: clock.now() - 2 };

    ticket.choose('GBP/USD');
    await app.waitFor(() => ticket.note.textContent === RESUMED_DETAIL('GBP/USD'), 'the ticket note for a market that has just resumed');
    assert.deepEqual(ticket.levels(), ['', '', ''], 'no stop and no target from before the pause');
    assert.equal(ticket.strip(), RESUMED_DETAIL('GBP/USD'));
    /* The Markets table shows the website's row for it; a market without a pause keeps its reading. */
    await app.openMarkets();
    const row = app.row('GBP/USD');
    assert.equal(row.badge, 'Stale data');
    assert.equal(row.title, RESUMED_DETAIL('GBP/USD'));
    assert.equal(row.source, 'source: Deriv public candles \u00b7 resumed, waiting for a finished candle');
    assert.equal(row.levels, false);
    assert.match(app.row('EUR/USD').badge, /^(Buy|Sell)/);

    /* Twenty seconds after the next 5-minute close: the candle that began with the new session has finished. */
    clock.advance(close + 320 - clock.now());
    await app.open('trade');
    ticket.choose('EUR/USD');
    ticket.choose('GBP/USD');
    await app.waitFor(() => /^Levels from live analysis/.test(ticket.note.textContent), 'levels from the first reading of the new session');
    for (const level of ticket.levels()) assert.ok(Number(level) > 0, 'a stop and two targets: ' + ticket.levels().join(' / '));
    assert.equal(ticket.strip(), 'LIVE SIGNAL LEVELS');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

/* `candle_current: false` alone does not say why. With a close the market has just resumed after a pause; without
   one (candle_close 0) the history holds no finished 5-minute candle, which is missing history and not a pause. */
const NO_CANDLES_NOTE = (symbol) => 'No confirmed setup for ' + symbol + ' yet (feed error) \u2014 SL/TP fill when the timeframes align.';

test('PC app, its own server: a history without a finished 5-minute candle is not called a pause; the row and the ticket show the WAIT with its own reason', async () => {
  /* USD/JPY: one candle per timeframe, the one that is forming. Every other market has its whole history. */
  const market = directionalMarket();
  const candleRows = (code, granularity, count, now) => { const rows = market(code, granularity, count, now); return code === 'frxUSDJPY' ? rows.slice(-1) : rows; };
  const app = await bootApp({ origin: PC_ORIGIN, pcServer: true, world: { ticks: true, candleRows } });
  try {
    await app.openMarkets();
    const row = app.row('USD/JPY');
    assert.equal(row.badge, 'Wait \u00b7 feed error');
    assert.equal(row.title, 'Wait [FEED_ERROR] (some timeframes lack data \u2014 not confirmable) \u2014 No timeframe returned usable candles just now.');
    assert.equal(row.source, 'source: Deriv public candles \u00b7 fallback (Exness unavailable: Exness bridge is not connected in this tab.)');
    assert.equal(row.levels, false);
    assert.match(app.row('EUR/USD').badge, /^(Buy|Sell)/, 'a market with its history keeps its reading');

    await app.open('trade');
    const ticket = ticketOf(app);
    ticket.choose('USD/JPY');
    await app.waitFor(() => ticket.note.textContent === NO_CANDLES_NOTE('USD/JPY'), 'the ticket note for a market without candles');
    assert.deepEqual(ticket.levels(), ['', '', '']);
    assert.doesNotMatch(app.doc.getElementById('chartLevels').textContent, /resumed/);

    /* The analysis panel and the six roles under it: the server's WAIT with its reason, and the roles' report of it. Neither speaks of a pause. */
    await app.open('signals');
    app.doc.getElementById('azSymbol').value = 'USD/JPY';
    app.click(app.doc.getElementById('azRun'));
    await app.waitFor(() => !app.doc.getElementById('azResult').classList.contains('hidden'), 'the analysis result');
    assert.match(app.doc.getElementById('azWhy').textContent, /^Why WAIT: No timeframe returned usable candles just now\.reason: FEED_ERROR /);
    assert.ok(app.doc.getElementById('azRationale').textContent.length > 20, 'the server\'s own analysis is shown, with its write-up');
    await app.waitFor(() => { const flow = app.doc.getElementById('pipelineFlow'); return flow && !/running/.test(flow.textContent); }, 'the six-role panel');
    const flow = app.doc.getElementById('pipelineFlow').textContent;
    assert.match(flow, /^Six-role pipeline \u2014 Boss verdict: /);
    assert.doesNotMatch(flow, /resumed|Pipeline unavailable/);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('PC app: an answer marked as not current that names no close is never called a pause: a WAIT is shown as it is, a direction is withheld', async () => {
  const candleTime = nowSec();
  const UNCONFIRMED = 'The reading for AUD/USD is marked as not current and names no 5-minute close, so it cannot be confirmed. No reading is shown.';
  const pcApi = (path, body) => {
    if (path === '/api/health') return { status: 200, body: { ok: true } };
    if (path === '/api/signals/scan') {
      return { status: 200, body: { results: body.symbols.map((symbol) => {
        /* What the PC's server answers for a history without a finished 5-minute candle. */
        if (symbol === 'USD/JPY') return { ...liveWait(symbol), confidence: 15, wait_reason: 'FEED_ERROR', wait_detail: 'No timeframe returned usable candles just now.', data_ok: false, latest_candle_time: candleTime, candle_close: 0, candle_current: false };
        /* What no server of this project sends: a direction with levels, marked as not current, without a close. */
        if (symbol === 'AUD/USD') return { ...LIVE_BUY, symbol, latest_candle_time: candleTime, candle_close: 0, candle_current: false };
        return { ...LIVE_BUY, symbol, latest_candle_time: candleTime, candle_close: Math.floor(candleTime / 300) * 300, candle_current: true };
      }) } };
    }
    return null;
  };
  const app = await bootApp({ origin: PC_ORIGIN, pcApi });
  try {
    await app.openMarkets();
    const jpy = app.row('USD/JPY');
    assert.equal(jpy.badge, 'Wait \u00b7 feed error');
    assert.match(jpy.title, / \u2014 No timeframe returned usable candles just now\.$/);
    const aud = app.row('AUD/USD');
    assert.equal(aud.badge, 'Stale data');
    assert.equal(aud.title, UNCONFIRMED);
    assert.equal(aud.source, 'source: Deriv public candles \u00b7 not confirmed as current');
    assert.equal(aud.levels, false);

    await app.open('trade');
    const ticket = ticketOf(app);
    ticket.choose('USD/JPY');
    await app.waitFor(() => ticket.note.textContent === NO_CANDLES_NOTE('USD/JPY'), 'the ticket note for a WAIT without candles');
    assert.deepEqual(ticket.levels(), ['', '', '']);
    ticket.choose('AUD/USD');
    await app.waitFor(() => ticket.note.textContent === UNCONFIRMED, 'the ticket note for a direction that cannot be confirmed');
    assert.deepEqual(ticket.levels(), ['', '', ''], 'its levels are not on the ticket');
    assert.equal(ticket.strip(), UNCONFIRMED);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('PC app, its own server: right after a pause the Gold monitor shows no signal; the first one comes when a 5-minute candle of the new session has closed', async () => {
  const market = directionalMarket();
  /* Set once the page clock is settled: no gold price between `from` and `to`. */
  let pause = null;
  const candleRows = (code, granularity, count, now) => market(code, granularity, count, now).filter((row) => !pause || code !== 'frxXAUUSD' || row.epoch < pause.from || row.epoch + granularity > pause.to);
  const app = await bootApp({ origin: PC_ORIGIN, pcServer: true, world: { ticks: true, candleRows } });
  try {
    const clock = pageClock(app);
    const doc = app.doc;
    const text = (id) => doc.getElementById(id).textContent;
    const tickNow = () => {
      const stream = app.sockets.find((entry) => entry.sent.some((message) => message.style === 'ticks'));
      stream.socket.onmessage({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'frxXAUUSD', quote: GOLD_TICK, epoch: Math.floor(clock.now()) } }) });
    };
    const analyses = () => app.requests.filter((r) => r.path === '/api/signals/analyze');
    await app.enter();
    await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
    await new Promise((r) => setTimeout(r, 60));
    const close = clock.settle();
    /* Gold gave its first price two seconds ago, after half an hour without one (its daily break lasts an hour). */
    pause = { from: clock.now() - 1800, to: clock.now() - 2 };
    tickNow();
    const asked = analyses().length;
    await app.open('gold');
    app.click(doc.getElementById('goldAnalyzeBtn'));
    await app.waitFor(() => analyses().length > asked && analyses().at(-1).status != null && text('goldSignalBadge') === 'UNAVAILABLE', 'the monitor to withhold the signal');
    /* The PC's server had no reading to give, and said so. */
    assert.equal(analyses().at(-1).status, 409);
    assert.equal(text('goldRationale'), 'Deriv Gold has just resumed after a pause: no 5-minute candle has closed since. The first reading comes with the next 5-minute close. No old signal is being presented as current.');
    assert.equal(text('goldSignal'), '\u2014');
    assert.deepEqual(['goldEntry', 'goldSL', 'goldTP1', 'goldTP2'].map(text), ['\u2014', '\u2014', '\u2014', '\u2014']);
    assert.equal(text('goldMeasured'), '');
    assert.equal([...doc.querySelectorAll('#toasts .toast b')].filter((el) => /^Gold\/USD signal/.test(el.textContent)).length, 0, 'no alert from before the pause');

    /* Twenty seconds after the next 5-minute close: the candle that began with the new session has finished. */
    clock.advance(close + 320 - clock.now());
    tickNow();
    app.click(doc.getElementById('goldAnalyzeBtn'));
    await app.waitFor(() => /^(LIVE ANALYSIS|CHECK DATA) /.test(text('goldFeedStatus')), 'the first reading of the new session');
    assert.equal(analyses().at(-1).status, 200, 'this one is the server\'s reading');
    assert.match(text('goldSignalUpdated'), new RegExp('^Reading of the ' + hhmm(close + 300) + ' candle close '));
    assert.ok(text('goldSignal') === 'BUY' || text('goldSignal') === 'SELL');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('the same candles at the same moment: the PC app (Exness not connected) and the website show the same Gold reading and the same signal cards', async () => {
  const market = directionalMarket();
  /* The website as it runs live: the AURUM cloud cannot reach Deriv, so this browser reads the candles itself. */
  const website = await bootApp({ world: { cloudDeriv: 'down', ticks: true, candleRows: market } });
  /* The PC app: the page from the bridge, its readings from the PC's own server. */
  const pc = await bootApp({ origin: PC_ORIGIN, pcServer: true, world: { ticks: true, candleRows: market } });
  try {
    /* Both pages at one moment, at least 20 seconds after a 5-minute close and 150 before the next. */
    const clocks = new Map([[website, pageClock(website)], [pc, pageClock(pc)]]);
    const into = clocks.get(website).now() % 300;
    const shift = into > 150 ? 320 - into : into < 20 ? 20 - into : 0;
    if (shift) for (const clock of clocks.values()) clock.advance(shift);
    const close = Math.floor(clocks.get(website).now() / 300) * 300;

    const goldOf = async (app) => {
      const text = (id) => app.doc.getElementById(id).textContent;
      await app.enter();
      await app.waitFor(() => app.sockets.some((entry) => entry.sent.some((message) => message.ticks_history === 'frxXAUUSD')), 'the gold price subscription');
      await new Promise((r) => setTimeout(r, 60));
      /* The clock may have been moved by more than two minutes; the monitor analyses only with a gold price younger than that. */
      const stream = app.sockets.find((entry) => entry.sent.some((message) => message.style === 'ticks'));
      stream.socket.onmessage({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'frxXAUUSD', quote: GOLD_TICK, epoch: Math.floor(clocks.get(app).now()) } }) });
      await app.open('gold');
      /* "LIVE ANALYSIS", or "CHECK DATA" for a reading without confirmation: whichever it is, it has to be the same on both. */
      await app.waitFor(() => /^(LIVE ANALYSIS|CHECK DATA) /.test(text('goldFeedStatus')), 'the gold analysis');
      const asRead = /score as read (\d+)%/.exec(text('goldConfidenceNote'));
      return {
        status: text('goldFeedStatus').split(' \u00b7 ')[0],
        signal: text('goldSignal'), badge: text('goldSignalBadge'), entry: text('goldEntry'), stop: text('goldSL'), target1: text('goldTP1'), target2: text('goldTP2'),
        score: asRead ? asRead[1] + '%' : text('goldConfidence'), votes: text('goldVotes'), measured: text('goldMeasured'),
        close: (/^Reading of the (\d\d:\d\d) candle close /.exec(text('goldSignalUpdated')) || [])[1],
        rule: (/\(([^()]*)\)\.$/.exec(text('goldAnalysisNoticeText')) || [])[1]
      };
    };
    const cardsOf = async (app) => {
      await app.open('signals');
      const grid = app.doc.getElementById('sigGrid');
      await app.waitFor(() => grid.querySelectorAll('.sig-card').length > 0, 'signal cards');
      const cards = {};
      for (const card of grid.querySelectorAll('.sig-card')) {
        const symbol = card.querySelector('.sym-name').textContent;
        const why = card.querySelector('.sig-why').textContent;
        const asRead = /score as read (\d+)%/.exec(card.querySelector('.sig-live').textContent);
        cards[symbol] = {
          signal: card.querySelector('.badge').textContent,
          score: asRead ? asRead[1] + '%' : card.querySelector('.row.between b').textContent,
          entry: card.querySelector('[data-l="e"]').textContent, stop: card.querySelector('[data-l="s"]').textContent, target: card.querySelector('[data-l="t"]').textContent,
          measured: card.querySelector('.sig-measured').textContent,
          /* "buy confirmed · MTF 1m/5m/1h" and "read at the 14:35 candle close": the source label between them differs on purpose. */
          reading: why.split(' \u00b7 source: ')[0], close: (/ \u00b7 read at the (\d\d:\d\d) candle close$/.exec(why) || [])[1]
        };
      }
      return cards;
    };

    const goldOnWebsite = await goldOf(website), goldOnPc = await goldOf(pc);
    assert.ok(goldOnWebsite.signal === 'BUY' || goldOnWebsite.signal === 'SELL', 'the chosen market reads as a direction');
    assert.equal(goldOnWebsite.close, hhmm(close));
    assert.equal(goldOnWebsite.rule, 'a reading changes only when a 5-minute candle closes');
    assert.deepEqual(goldOnPc, goldOnWebsite);

    const cardsOnWebsite = await cardsOf(website), cardsOnPc = await cardsOf(pc);
    const shown = Object.keys(cardsOnWebsite);
    assert.equal(shown.filter((symbol) => DERIV_SYMBOLS.includes(symbol)).length, 6, 'six Deriv markets on the website');
    assert.deepEqual(shown.filter((symbol) => !DERIV_SYMBOLS.includes(symbol)).sort(), ['NAS100', 'SPX500', 'US30'], 'and the three daily index readings');
    assert.deepEqual(Object.keys(cardsOnPc).sort(), shown.sort(), 'the same markets on the PC');
    for (const symbol of shown) {
      /* A Deriv market names its 5-minute close; a daily index reading has none. */
      assert.equal(cardsOnWebsite[symbol].close, DERIV_SYMBOLS.includes(symbol) ? hhmm(close) : undefined, symbol);
      assert.deepEqual(cardsOnPc[symbol], cardsOnWebsite[symbol], symbol);
    }
    assert.deepEqual(website.problems, []);
    assert.deepEqual(pc.problems, []);
  } finally { await website.close(); await pc.close(); }
});

/* ---------------------------------------------------------------- Market state: a description on four timeframes */

/* A market that swings. Its price is a function of time (three waves), so a candle keeps its content whenever
   it is asked for and the four timeframes are views of one market. `frozenAt` makes it a closed market: its
   newest candle stays the one of that moment, however far the page's clock moves on. */
function swingingMarket({ frozenAt = 0, without = [] } = {}) {
  const anchor = nowSec();
  const priceAt = (base, t) => { const x = (t - anchor) / 60; return base * (1 + 0.004 * Math.sin(x / 190) + 0.0015 * Math.sin(x / 23) + 0.0006 * Math.sin(x / 3.1)); };
  return (code, granularity, count, now) => {
    if (without.includes(granularity)) return [];
    const end = frozenAt || now, base = basePriceFor(code), newest = Math.floor(end / granularity) * granularity;
    return Array.from({ length: count }, (_unused, i) => {
      const start = newest - (count - 1 - i) * granularity, stop = Math.min(start + granularity, end);
      let high = -Infinity, low = Infinity;
      for (let k = 0; k <= 6; k++) { const price = priceAt(base, start + ((stop - start) * k) / 6); if (price > high) high = price; if (price < low) low = price; }
      return { epoch: start, open: priceAt(base, start), high, low, close: priceAt(base, stop) };
    });
  };
}
const STATE_SHOWN = [...STATE_TIMEFRAMES].reverse();
/* What the Market state view shows, card by card. */
function stateView(app) {
  const doc = app.doc;
  const cards = [...doc.querySelectorAll('#msGrid .ms-card')];
  return {
    market: doc.getElementById('msSym').value,
    summary: doc.getElementById('msSummary').textContent,
    feed: doc.getElementById('msFeedText').textContent,
    note: doc.getElementById('msNote').textContent,
    noteWarns: doc.getElementById('msNote').classList.contains('warn'),
    cards: cards.map((card) => ({
      timeframe: card.dataset.msTf, state: card.dataset.msState,
      trend: card.dataset.msTrend || '', structure: card.dataset.msStructure || '', volatility: card.dataset.msVolatility || '',
      asOf: card.querySelector('.ms-asof') ? card.querySelector('.ms-asof').textContent : '',
      rows: [...card.querySelectorAll('.ms-row dt')].map((el) => el.textContent),
      badges: [...card.querySelectorAll('.ms-row .badge')].map((el) => el.textContent),
      sketch: card.querySelector('svg.ms-sketch'),
      text: card.textContent
    }))
  };
}
/* A close of yesterday carries its date ("as of 13 Nov 23:55 EAT"), one of today does not. Without the date, for
   comparing what a card says before and after the page's clock has moved on: midnight in Nairobi may lie between. */
const withoutDate = (asOf) => asOf.replace(/^as of \d{1,2} [A-Z][a-z]{2} /, 'as of ');
const stateSettled = (app) => { const view = stateView(app); return view.cards.length === 4 && view.cards.every((card) => card.state === 'ok' || card.state === 'unavailable') && view.feed !== 'Reading\u2026'; };
/* Candle requests of the Market state view on the browser's connection to Deriv: [market code, candle width], in the order sent. */
const stateRequests = (app) => app.sockets.flatMap((socket) => socket.sent).filter((message) => message.style === 'candles' && message.count === STATE_CANDLES).map((message) => [message.ticks_history, message.granularity]);
const historyCalls = (app) => app.requests.filter((request) => request.path === '/api/history/candles');
const codeOf = (symbol) => DERIV_INSTRUMENTS.find((instrument) => instrument.s === symbol).deriv;

test('Market state on the website: four timeframes of one market, read by this browser from finished candles', async () => {
  const app = await bootApp({ world: { candleRows: swingingMarket() } });
  try {
    const clock = pageClock(app);
    clock.settle();
    await app.enter();
    const chartMarket = app.doc.getElementById('chartSymbol').value;
    assert.ok(DERIV_SYMBOLS.includes(chartMarket), 'the chart opens on a market with candles');
    await app.open('state');
    await app.waitFor(() => stateSettled(app), 'four timeframes read');
    const now = clock.now(), view = stateView(app);

    assert.equal(view.market, chartMarket, 'the first visit shows the market of the chart');
    assert.equal(app.doc.getElementById('topTitle').textContent, 'Market state');
    assert.deepEqual(view.cards.map((card) => card.timeframe), ['h4', 'h1', 'm15', 'm5'], 'the larger picture first');
    for (const [index, timeframe] of STATE_SHOWN.entries()) {
      const card = view.cards[index];
      assert.equal(card.state, 'ok', timeframe.label);
      /* The newest candle may still be forming: the state is as of the close before it. */
      const close = Math.floor(now / timeframe.seconds) * timeframe.seconds;
      assert.equal(card.asOf, 'as of ' + eatMoment(close, now) + ' EAT \u00b7 ' + (STATE_CANDLES - 1) + ' finished candles', timeframe.label);
      assert.deepEqual(card.rows, ['Trend', 'Structure', 'Volatility'], timeframe.label);
      assert.equal(card.badges.length, 3, timeframe.label + ': one state per line');
      assert.match(card.trend, /^(UP|DOWN|RANGE|UNCLEAR)$/);
      assert.match(card.structure, /^(UP|DOWN|WIDENING|NARROWING|MIXED|UNKNOWN)$/);
      assert.match(card.volatility, /^(QUIET|NORMAL|HIGH|EXTREME)$/);
      assert.match(card.text, /EMA 20 [\d.,]+ \u00b7 EMA 50 [\d.,]+ \u00b7 EMA 200 [\d.,]+ \u00b7 close [\d.,]+: /, timeframe.label + ': the trend comes with its figures');
      assert.match(card.text, /ADX 14 \d+\.\d: (25 or more|below 20|between 20 and 25)\./);
      assert.match(card.text, /ATR 14 [\d.,]+ \(\d+\.\d\d% of the price\): higher than in \d+% of the 200 candles before it/);
      assert.ok(card.text.includes('Deriv public candles, read by this browser'), timeframe.label + ': says where its candles came from');
      assert.equal(card.sketch.getAttribute('role'), 'img');
      assert.match(card.sketch.getAttribute('aria-label'), new RegExp('^' + timeframe.label + ': the last \\d+ finished candles with EMA 50, EMA 200 and the swing highs and lows$'));
      assert.ok(card.sketch.querySelectorAll('circle.ms-swing').length >= 4, timeframe.label + ': the swings are drawn');
    }
    assert.ok(view.summary.startsWith(chartMarket + ' \u00b7 '), 'the summary names the market: ' + view.summary);
    assert.match(view.feed, /^Feed current \u00b7 read \d\d:\d\d EAT$/);
    assert.match(view.note, /^The newest M5 candle started \d+ (s|min) ago\. Each state is as of the close named on its card and changes at most once per candle of its timeframe\.$/);
    assert.equal(view.noteWarns, false);

    /* Read by this browser: four series of 600 candles for this market, and the AURUM cloud is not asked. */
    assert.deepEqual(stateRequests(app).sort(), STATE_TIMEFRAMES.map((timeframe) => [codeOf(chartMarket), timeframe.seconds]).sort());
    assert.equal(historyCalls(app).length, 0);

    /* A description, not a signal: no direction to trade, no order button, and what a replay measured about it. */
    const section = app.doc.getElementById('view-state');
    assert.equal(section.querySelectorAll('.badge.buy, .badge.sell, .badge.lean-up, .badge.lean-dn, .badge.wait').length, 0);
    assert.deepEqual([...section.querySelectorAll('button')].map((button) => button.textContent), ['Read again']);
    assert.ok(app.visibleText(section).includes('It is a description, not a signal:'));
    assert.equal(app.doc.getElementById('msMeasured').textContent, STATE_MEASURED_TEXT);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Market state: a state changes at most once per candle of its timeframe, and only what may have changed is read again', async () => {
  const app = await bootApp({ world: { candleRows: swingingMarket() } });
  try {
    const clock = pageClock(app);
    clock.settle();
    await app.enter();
    await app.open('state');
    await app.waitFor(() => stateSettled(app), 'four timeframes read');
    const market = stateView(app).market, before = clock.now();
    const perWidth = () => Object.fromEntries(STATE_TIMEFRAMES.map((timeframe) => [timeframe.label, stateRequests(app).filter(([, width]) => width === timeframe.seconds).length]));
    const first = stateView(app), sentFirst = perWidth();
    assert.deepEqual(sentFirst, { M5: 1, M15: 1, H1: 1, H4: 1 });

    /* The clock of the page keeps running; before the next 5-minute close nothing is read and no state changes.
       Only the age of the newest candle is said anew, every second. */
    const ageOf = (note) => { const [, count, unit] = /^The newest M5 candle started (\d+) (s|min) ago\./.exec(note); return Number(count) * (unit === 'min' ? 60 : 1); };
    const ageBefore = ageOf(first.note);
    clock.advance(60);
    app.runIntervals(1000);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(perWidth(), sentFirst);
    assert.deepEqual(stateView(app).cards.map((card) => card.asOf), first.cards.map((card) => card.asOf));
    assert.ok(ageOf(stateView(app).note) >= ageBefore + 30, 'the note follows the clock: ' + first.note + ' -> ' + stateView(app).note);
    assert.match(stateView(app).feed, /^Feed current \u00b7 read \d\d:\d\d EAT$/);

    /* A few seconds after the close: the 5-minute series is read again, and a longer one only if its own candle closed too. */
    const close = (Math.floor(clock.now() / 300) + 1) * 300;
    clock.advance(close + 8 - clock.now());
    app.runIntervals(1000);
    await app.waitFor(() => perWidth().M5 === 2 && stateSettled(app), 'the look after the 5-minute close');
    const after = clock.now(), sentAfter = perWidth();
    for (const timeframe of STATE_TIMEFRAMES) {
      const closed = Math.floor(after / timeframe.seconds) > Math.floor(before / timeframe.seconds);
      assert.equal(sentAfter[timeframe.label] - sentFirst[timeframe.label], closed ? 1 : 0, timeframe.label + (closed ? ': its candle closed, it is read again' : ': no candle of it closed, it is left alone'));
      const card = stateView(app).cards.find((entry) => entry.timeframe === timeframe.key);
      assert.equal(card.asOf, 'as of ' + eatMoment(Math.floor(after / timeframe.seconds) * timeframe.seconds, after) + ' EAT \u00b7 ' + (STATE_CANDLES - 1) + ' finished candles', timeframe.label);
    }
    assert.equal(stateView(app).market, market);

    /* One more close, five minutes on. By now every copy of a series that the page kept has run out, so a
       request is sent for each series it reads: again the 5-minute one, and a longer one only after its own close. */
    clock.advance(300);
    app.runIntervals(1000);
    await app.waitFor(() => perWidth().M5 === 3 && stateSettled(app), 'the look after the second 5-minute close');
    const later = clock.now(), sentLater = perWidth();
    for (const timeframe of STATE_TIMEFRAMES) {
      const closed = Math.floor(later / timeframe.seconds) > Math.floor(after / timeframe.seconds);
      assert.equal(sentLater[timeframe.label] - sentAfter[timeframe.label], closed ? 1 : 0, timeframe.label + ' at the second close');
    }
    assert.ok(sentLater.H4 <= 2 && sentLater.H1 <= 2, 'in ten minutes at most one 1-hour and one 4-hour candle can have closed');

    /* Another market: its four series are read, and the states of the first one are gone while they are. */
    const other = DERIV_SYMBOLS.find((symbol) => symbol !== market);
    const select = app.doc.getElementById('msSym');
    select.value = other;
    select.dispatchEvent(new app.window.Event('change'));
    assert.equal(stateView(app).cards.filter((card) => card.state === 'ok').length, 0, 'no state of the market before stays on screen');
    assert.equal(stateView(app).summary, 'Reading ' + other + '\u2026');
    await app.waitFor(() => stateSettled(app), 'the other market read');
    assert.ok(stateView(app).summary.startsWith(other + ' \u00b7 '));
    assert.deepEqual(stateRequests(app).filter(([code]) => code === codeOf(other)).map(([, width]) => width).sort((a, b) => a - b), STATE_TIMEFRAMES.map((timeframe) => timeframe.seconds));
    assert.equal(historyCalls(app).length, 0);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Market state: a timeframe that cannot be read has no state, and nothing is said about the whole', async () => {
  const app = await bootApp({ world: { candleRows: swingingMarket({ without: [14400] }) } });
  try {
    pageClock(app).settle();
    await app.enter();
    await app.open('state');
    await app.waitFor(() => stateSettled(app), 'three timeframes read, one refused');
    const view = stateView(app), h4 = view.cards[0];
    assert.equal(h4.timeframe, 'h4');
    assert.equal(h4.state, 'unavailable');
    assert.match(h4.text, /^H44 hoursNo stateThe candles could not be read\. \(.+\) Nothing is estimated\.$/);
    assert.equal(h4.sketch, null);
    assert.deepEqual(h4.badges, []);
    assert.deepEqual(view.cards.slice(1).map((card) => card.state), ['ok', 'ok', 'ok']);
    assert.equal(view.summary, view.market + ' \u00b7 No summary: H4 has no state.');
    /* This browser got nothing for that series, so the AURUM cloud was asked for it, and for it alone. */
    assert.deepEqual(historyCalls(app).map((request) => [request.body.sym, request.body.granularity, request.body.count]), [[view.market, 14400, STATE_CANDLES]]);
    assert.deepEqual(app.problems.filter((line) => !/Failed to load resource|502/.test(line)), []);
  } finally { await app.close(); }
});

test('Market state on a closed market: every state is the one at its last close, the page says so, and only the 5-minute series is asked again', async () => {
  const frozenAt = nowSec() - 2 * 86400 - 1234;
  const app = await bootApp({ world: { candleRows: swingingMarket({ frozenAt }) } });
  try {
    const clock = pageClock(app);
    clock.settle();
    await app.enter();
    await app.open('state');
    await app.waitFor(() => stateSettled(app), 'four timeframes read');
    const now = clock.now(), view = stateView(app);
    assert.equal(view.feed, 'Market closed or feed paused');
    assert.equal(view.noteWarns, true);
    assert.equal(view.note, 'The newest M5 candle of ' + view.market + ' started 2 days ago, so the market is closed or the feed has paused. Each state below is as of the close named on its card, not the state now.');
    for (const [index, timeframe] of STATE_SHOWN.entries()) {
      assert.equal(view.cards[index].state, 'ok');
      const close = Math.floor(frozenAt / timeframe.seconds) * timeframe.seconds;
      assert.equal(view.cards[index].asOf, 'as of ' + eatMoment(close, now) + ' EAT \u00b7 ' + (STATE_CANDLES - 1) + ' finished candles', timeframe.label + ': the close before the market shut, with its date');
      assert.match(view.cards[index].asOf, /^as of \d{1,2} [A-Z][a-z]{2} \d\d:\d\d EAT/);
    }
    /* The next 5-minute close on the page's clock: the feed is asked whether it has moved, with one request. */
    const sent = () => stateRequests(app).map(([, width]) => width);
    assert.deepEqual(sent().sort((a, b) => a - b), STATE_TIMEFRAMES.map((timeframe) => timeframe.seconds));
    clock.advance((Math.floor(clock.now() / 300) + 1) * 300 + 8 - clock.now());
    app.runIntervals(1000);
    await app.waitFor(() => sent().length === 5 && stateSettled(app), 'the look after the 5-minute close');
    assert.deepEqual(sent().slice(4), [300], 'the newest 5-minute candle has not moved: the longer series are not read again');
    /* And at the close after that, when every copy the page kept has run out: still one request. */
    clock.advance(300);
    app.runIntervals(1000);
    await app.waitFor(() => sent().length >= 6 && stateSettled(app), 'the look after the second 5-minute close');
    assert.deepEqual(sent().slice(4), [300, 300]);
    assert.equal(stateView(app).feed, 'Market closed or feed paused');
    assert.deepEqual(stateView(app).cards.map((card) => withoutDate(card.asOf)), view.cards.map((card) => withoutDate(card.asOf)), 'the states are still the ones of the last close');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Market state in the PC app: the same view, with the candles read through the PC\'s own server', async () => {
  const app = await bootApp({ origin: PC_ORIGIN, pcServer: true, world: { candleRows: swingingMarket() } });
  try {
    const clock = pageClock(app);
    clock.settle();
    await app.enter();
    await app.open('state');
    await app.waitFor(() => stateSettled(app), 'four timeframes read');
    const now = clock.now(), view = stateView(app);
    assert.deepEqual(view.cards.map((card) => [card.timeframe, card.state]), [['h4', 'ok'], ['h1', 'ok'], ['m15', 'ok'], ['m5', 'ok']]);
    for (const [index, timeframe] of STATE_SHOWN.entries()) {
      assert.equal(view.cards[index].asOf, 'as of ' + eatMoment(Math.floor(now / timeframe.seconds) * timeframe.seconds, now) + ' EAT \u00b7 ' + (STATE_CANDLES - 1) + ' finished candles', timeframe.label);
      assert.ok(view.cards[index].text.includes('Deriv public candles, read through the AURUM API'), timeframe.label);
    }
    assert.deepEqual(historyCalls(app).map((request) => [request.body.sym, request.body.granularity, request.body.count, request.status]).sort((a, b) => a[1] - b[1]),
      STATE_TIMEFRAMES.map((timeframe) => [view.market, timeframe.seconds, STATE_CANDLES, 200]));
    assert.deepEqual(stateRequests(app), [], 'the PC app does not open its own candle connection for this view');
    assert.match(view.feed, /^Feed current \u00b7 read \d\d:\d\d EAT$/);

    /* After the next 5-minute close the PC is asked for the 5-minute series, and for nothing else until that
       series shows the new candle. (The PC's server keeps a copy of a series for a minute of its own clock, which
       this test does not move: what it answers here is the copy, whose newest candle is the one that has just closed.) */
    clock.advance((Math.floor(clock.now() / 300) + 1) * 300 + 8 - clock.now());
    app.runIntervals(1000);
    await app.waitFor(() => historyCalls(app).length > STATE_TIMEFRAMES.length && stateSettled(app), 'the look after the 5-minute close');
    assert.deepEqual(historyCalls(app).slice(STATE_TIMEFRAMES.length).map((request) => [request.body.sym, request.body.granularity, request.status]), [[view.market, 300, 200]]);
    assert.deepEqual(stateView(app).cards.map((card) => card.state), ['ok', 'ok', 'ok', 'ok']);
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Market state offers the markets that have intraday candles here; with an index on the chart it opens on gold', async () => {
  const app = await bootApp({ world: { candleRows: swingingMarket() } });
  try {
    pageClock(app).settle();
    await app.enter();
    const chart = app.doc.getElementById('chartSymbol');
    chart.value = INDEX_SYMBOLS[0];
    chart.dispatchEvent(new app.window.Event('change'));
    await app.open('state');
    await app.waitFor(() => stateSettled(app), 'four timeframes read');
    const offered = [...app.doc.querySelectorAll('#msSym option')].map((option) => option.value);
    assert.deepEqual(offered, DERIV_SYMBOLS);
    for (const symbol of INDEX_SYMBOLS) assert.ok(!offered.includes(symbol), symbol + ' is not offered');
    assert.equal(stateView(app).market, 'XAU/USD');
    assert.ok(stateView(app).summary.startsWith('XAU/USD \u00b7 '));
    assert.ok(app.visibleText(app.doc.getElementById('view-state')).includes('Index markets are not offered here: this app has no intraday candles for them.'));
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Market state: when the feed has not shown the candle after a close yet, the view asks again within the minute, not at the next close', async () => {
  const app = await bootApp({ world: { candleRows: swingingMarket() } });
  try {
    const clock = pageClock(app);
    clock.settle();
    await app.enter();
    await app.open('state');
    await app.waitFor(() => stateSettled(app), 'four timeframes read');
    const m5 = () => stateView(app).cards.find((card) => card.timeframe === 'm5');
    const asOf = (close) => 'as of ' + eatMoment(close, clock.now()) + ' EAT \u00b7 ' + (STATE_CANDLES - 1) + ' finished candles';
    const close = (Math.floor(clock.now() / 300) + 1) * 300;
    assert.equal(m5().asOf, asOf(close - 300));

    /* Eight seconds after the close the feed is twenty seconds behind: its newest candle is still the one that has just closed. */
    app.state.candleAgeSec = 20;
    clock.advance(close + 8 - clock.now());
    const sentBefore = stateRequests(app).length;
    app.runIntervals(1000);
    await app.waitFor(() => stateRequests(app).length > sentBefore && stateSettled(app), 'the look after the close');
    assert.equal(m5().asOf, asOf(close - 300), 'nothing newer has been shown, so the state is still the one of the close before');
    assert.match(stateView(app).feed, /^Feed current/);

    /* The feed catches up. The view does not wait five minutes for it: it looks again every half minute until the candle is there. */
    app.state.candleAgeSec = 0;
    let looks = 0;
    while (m5().asOf !== asOf(close) && looks < 4) {
      looks++;
      clock.advance(31);
      app.runIntervals(1000);
      await new Promise((r) => setTimeout(r, 120));
      await app.waitFor(() => stateSettled(app), 'the next look');
    }
    assert.equal(m5().asOf, asOf(close), 'the state of the close that had just happened');
    assert.ok(looks <= 3, 'within about a minute and a half, took ' + looks + ' looks');
    assert.ok(clock.now() < close + 150, 'long before the next 5-minute close');
    assert.deepEqual(app.problems, []);
  } finally { await app.close(); }
});

test('Market state: when a later look fails, the states read before stay, marked as such, and the feed is not called current', async () => {
  const app = await bootApp({ world: { candleRows: swingingMarket() } });
  try {
    const clock = pageClock(app);
    clock.settle();
    await app.enter();
    await app.open('state');
    await app.waitFor(() => stateSettled(app), 'four timeframes read');
    const first = stateView(app);
    assert.match(first.feed, /^Feed current/);

    /* Neither this browser nor the AURUM cloud reaches Deriv any more; seven minutes later every copy the page kept has run out. */
    app.state.browserDeriv = 'down';
    app.state.cloudDeriv = 'down';
    clock.advance(420);
    app.click(app.doc.getElementById('msBtn'));
    await app.waitFor(() => stateView(app).cards.every((card) => /last look failed/.test(card.asOf)) && stateSettled(app), 'the failed look');
    const after = stateView(app);
    assert.deepEqual(after.cards.map((card) => [card.timeframe, card.state, card.trend, card.structure, card.volatility]), first.cards.map((card) => [card.timeframe, card.state, card.trend, card.structure, card.volatility]), 'every state is the one read before');
    for (const [index, card] of after.cards.entries()) assert.equal(withoutDate(card.asOf), withoutDate(first.cards[index].asOf) + ' \u00b7 last look failed');
    assert.match(after.feed, /^Last look failed \u00b7 read \d\d:\d\d EAT$/);
    /* Seven minutes on, the newest candle read is old. That is said with its age; that the market is closed is not
       concluded from it, because the look that would have shown a newer candle is the one that failed. */
    assert.match(after.note, /^The newest M5 candle that was read started \d+ min ago\. The last look failed for H4, H1, M15, M5: the state shown there is the one read before, as of the close named on its card\.$/);
    assert.doesNotMatch(after.note, /closed|paused/);
    assert.equal(after.summary, first.summary, 'the summary is the one of the states on screen');

    /* The feed is back: the next look after a 5-minute close reads all four again, and the mark is gone. */
    app.state.browserDeriv = 'ok';
    app.state.cloudDeriv = 'ok';
    clock.advance((Math.floor(clock.now() / 300) + 1) * 300 + 8 - clock.now());
    app.runIntervals(1000);
    await app.waitFor(() => stateView(app).cards.every((card) => card.state === 'ok' && !/last look failed/.test(card.asOf)) && /^Feed current/.test(stateView(app).feed), 'the look after the feed came back');
    assert.doesNotMatch(stateView(app).note, /failed/);
  } finally { await app.close(); }
});

test('Market state in the PC app: a fourth full look within one minute is refused by the PC\'s server, and the cards say why in words', async () => {
  /* The limit the PC's server has when nothing is configured: twelve candle requests a minute. */
  const perMinute = configFromEnv({}).backtestRatePerMin;
  assert.equal(perMinute, 12);
  const app = await bootApp({ origin: PC_ORIGIN, pcServer: true, pcConfig: { backtestRatePerMin: perMinute }, world: { candleRows: swingingMarket() } });
  try {
    pageClock(app).settle();
    await app.enter();
    await app.open('state');
    await app.waitFor(() => stateSettled(app), 'four timeframes read');
    const select = app.doc.getElementById('msSym');
    const choose = async (symbol) => {
      select.value = symbol;
      select.dispatchEvent(new app.window.Event('change'));
      await app.waitFor(() => stateSettled(app) && stateView(app).market === symbol && !/^Reading/.test(stateView(app).summary), symbol + ' read');
    };
    const others = DERIV_SYMBOLS.filter((symbol) => symbol !== stateView(app).market);
    /* Three full looks are twelve requests: all answered. */
    await choose(others[0]);
    await choose(others[1]);
    assert.deepEqual(stateView(app).cards.map((card) => card.state), ['ok', 'ok', 'ok', 'ok']);
    assert.deepEqual(historyCalls(app).map((request) => request.status), Array(12).fill(200));
    /* The fourth is refused. No state of the market before is shown in its place, and nothing is estimated. */
    await choose(others[2]);
    assert.deepEqual(historyCalls(app).slice(12).map((request) => request.status), [429, 429, 429, 429]);
    const refused = stateView(app);
    assert.deepEqual(refused.cards.map((card) => card.state), ['unavailable', 'unavailable', 'unavailable', 'unavailable']);
    for (const card of refused.cards) assert.ok(card.text.endsWith('No stateThe candles could not be read. (too many candle requests within one minute; it is read again after the next 5-minute close) Nothing is estimated.'), card.text);
    assert.equal(refused.summary, others[2] + ' \u00b7 No summary: H4, H1, M15 and M5 have no state.');
    assert.equal(refused.feed, 'No candles');
    assert.deepEqual(app.problems.filter((line) => !/Failed to load resource|429/.test(line)), []);
  } finally { await app.close(); }
});
