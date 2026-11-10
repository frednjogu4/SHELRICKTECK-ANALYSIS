/*
 * App shell — generic frontend stability checks.
 *
 * Scope: page-level behaviour only (startup guard, <noscript>, connectivity
 * notices, service-worker registration errors, navigation semantics, and
 * keeping client-held AI keys away from the Cloudflare host).
 *
 * The hosted-mode test boots the real application bundle in jsdom on a
 * *.workers.dev address and wires its fetch() to the real Worker code with
 * upstream providers that always FAIL. WebSocket is a stub that never
 * connects. No market data, balance or connection success is fabricated, no
 * broker is contacted, and no assertion looks at an analysis result.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { initConnectivityNotices, registerServiceWorker, removeAiKeyHeaders } from '../../src/resilience.js';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
const MODULE_TAG = '<script type="module" src="/src/main.js"></script>';

/* ---------------------------------------------------------------- resilience.js */

test('removeAiKeyHeaders strips every x-ai-* header and nothing else', () => {
  const headers = {
    'content-type': 'application/json', 'x-aurum-user': 'local',
    'x-ai-claude': 'k1', 'X-AI-OpenAI': 'k2', 'x-ai-perplexity': 'k3', 'x-ai-future-engine': 'k4', 'x-airline': 'keep'
  };
  const result = removeAiKeyHeaders(headers);
  assert.equal(result, headers, 'the same object is returned');
  assert.deepEqual(headers, { 'content-type': 'application/json', 'x-aurum-user': 'local', 'x-airline': 'keep' });
  assert.equal(removeAiKeyHeaders(null), null);
  assert.equal(removeAiKeyHeaders(undefined), undefined);
  assert.deepEqual(removeAiKeyHeaders({}), {});
});

test('connectivity notices report the device state and never claim a feed or broker is connected', () => {
  const win = new EventTarget();
  win.navigator = { onLine: true };
  const toasts = [];
  assert.equal(initConnectivityNotices({ toast: (...args) => toasts.push(args), win }), true);
  assert.equal(toasts.length, 0, 'nothing is shown while the device is online');

  win.dispatchEvent(new Event('offline'));
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][0], 'You are offline');
  assert.equal(toasts[0][2], 'warn');

  win.dispatchEvent(new Event('online'));
  assert.equal(toasts.length, 2);
  assert.equal(toasts[1][2], 'ok');
  for (const [title, message] of toasts) {
    assert.doesNotMatch(title + ' ' + message, /\b(broker|account|deriv|exness|mt5)\b/i, 'device connectivity is not a broker status');
    assert.doesNotMatch(title + ' ' + message, /\b(feed|data) (is )?(connected|live)\b/i, 'no data-feed success is claimed');
  }
});

test('a page that starts offline says so once', () => {
  const win = new EventTarget();
  win.navigator = { onLine: false };
  const toasts = [];
  initConnectivityNotices({ toast: (...args) => toasts.push(args), win });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][0], 'You are offline');
});

test('connectivity notices need a window and a toast function', () => {
  assert.equal(initConnectivityNotices({ toast: null, win: new EventTarget() }), false);
  assert.equal(initConnectivityNotices({ toast: () => {}, win: null }), false);
});

test('a failed service-worker registration is reported, not swallowed', async () => {
  const warnings = [];
  const nav = { serviceWorker: { register: async () => { throw new Error('bad MIME type'); } } };
  const result = await registerServiceWorker({ nav, loc: { protocol: 'https:' }, warn: (...args) => warnings.push(args) });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /Service worker registration failed/);
  assert.equal(warnings[0][1], 'bad MIME type');
});

test('the service worker is registered at /sw.js on http(s) only', async () => {
  const registered = [];
  const nav = { serviceWorker: { register: async (url) => { registered.push(url); return { scope: '/' }; } } };
  const registration = await registerServiceWorker({ nav, loc: { protocol: 'https:' }, warn: () => assert.fail('no warning expected') });
  assert.deepEqual(registration, { scope: '/' });
  assert.deepEqual(registered, ['/sw.js']);

  assert.equal(registerServiceWorker({ nav, loc: { protocol: 'file:' } }), null);
  assert.equal(registerServiceWorker({ nav: {}, loc: { protocol: 'https:' } }), null);
  assert.equal(registered.length, 1);
});

/* ---------------------------------------------------------------- index.html */

test('index.html keeps one valid manifest link, a <noscript> notice and the module entry', () => {
  assert.equal((indexHtml.match(/<link rel="manifest"/g) || []).length, 1);
  assert.doesNotMatch(indexHtml, /<meta name="manifest"/, 'a <meta> element cannot link a manifest');
  assert.match(indexHtml, /<noscript>[\s\S]*JavaScript[\s\S]*<\/noscript>/);
  assert.equal(indexHtml.split(MODULE_TAG).length - 1, 1, 'the module entry tag is present exactly once and unchanged');
  assert.ok(indexHtml.indexOf('id=\'startupNotice\'') < indexHtml.indexOf(MODULE_TAG) && indexHtml.includes("bar.id='startupNotice'"), 'the startup guard is defined before the application module');
});

test('the page Content-Security-Policy keeps its restrictive baseline', () => {
  const match = indexHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(match, 'CSP meta tag present');
  const policy = match[1];
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'self'/);
  assert.doesNotMatch(policy, /'unsafe-eval'/);
  const directive = (name) => (policy.split(';').map((part) => part.trim()).find((part) => part.startsWith(name + ' ')) || '').split(/\s+/).slice(1);
  for (const name of ['script-src', 'connect-src', 'frame-src']) {
    for (const source of directive(name)) {
      assert.notEqual(source, '*', `${name} must not allow every origin`);
      assert.doesNotMatch(source, /^(https?|wss?):$/, `${name} must not allow a whole scheme`);
      assert.doesNotMatch(source, /^(http|ws):\/\//, `${name} must not allow plaintext origins`);
    }
  }
});

function guardScript() {
  const before = indexHtml.slice(0, indexHtml.indexOf(MODULE_TAG));
  const start = before.lastIndexOf('<script>');
  assert.ok(start > 0, 'startup guard script found');
  return before.slice(start);
}

function loadGuard({ started }) {
  const timers = [];
  const dom = new JSDOM('<!doctype html><html><body><p>static page</p>' + guardScript() + '</body></html>', {
    runScripts: 'dangerously',
    url: 'https://aurum-test.workers.dev/',
    beforeParse(window) {
      window.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
    }
  });
  return new Promise((resolveLoaded) => {
    dom.window.addEventListener('load', () => {
      if (started) dom.window.__aurumAppStarted = true;
      resolveLoaded({ dom, timers });
    });
  });
}

test('startup guard: a page whose application never started shows one reload notice', async () => {
  const { dom, timers } = await loadGuard({ started: false });
  const doc = dom.window.document;
  assert.equal(timers.length, 1, 'the check is scheduled after load');
  assert.ok(timers[0].delay >= 1000, 'the application gets time to start first');
  assert.equal(doc.getElementById('startupNotice'), null, 'nothing is shown before the check runs');

  timers[0].fn();
  const notice = doc.getElementById('startupNotice');
  assert.ok(notice, 'the notice is shown');
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.match(notice.textContent, /did not start correctly/);
  const button = notice.querySelector('button');
  assert.ok(button, 'a reload control is offered');
  assert.equal(button.type, 'button');
  assert.equal(typeof button.onclick, 'function');

  timers[0].fn();
  assert.equal(doc.querySelectorAll('#startupNotice').length, 1, 'the notice is never duplicated');
  dom.window.close();
});

test('startup guard: a page whose application started shows nothing', async () => {
  const { dom, timers } = await loadGuard({ started: true });
  timers[0].fn();
  assert.equal(dom.window.document.getElementById('startupNotice'), null);
  dom.window.close();
});

/* ---------------------------------------------------------------- hosted mode, real bundle */

const HOSTED_ORIGIN = 'https://aurum-test.workers.dev';
const TEST_KEYS = { claude: 'TEST-CLAUDE-KEY-VALUE', openai: 'TEST-OPENAI-KEY-VALUE', perplexity: 'TEST-PPLX-KEY-VALUE' };
let bundleCode = '';

before(async () => {
  const bundle = await build({
    entryPoints: [join(root, 'src', 'main.js')], bundle: true, write: false, format: 'iife',
    absWorkingDir: root, define: { 'import.meta.env': '{}' }, logLevel: 'silent'
  });
  bundleCode = bundle.outputFiles[0].text;
});

async function bootHostedApp() {
  const worker = createReadOnlyWorker({
    requestImpl: async () => { throw new Error('stub provider is offline'); },
    fetchImpl: async () => { throw new Error('stub provider is offline'); },
    log: () => {}
  });
  const allow = { limit: async () => ({ success: true }) };
  const env = { AURUM_SIGNAL_LIMITER: allow, AURUM_MARKET_LIMITER: allow, ASSETS: { fetch: async () => new Response('shell') } };

  const problems = [];
  const requests = [];
  const sockets = [];
  let closing = false;
  const consoleLines = new VirtualConsole();
  consoleLines.on('jsdomError', (error) => problems.push('jsdomError: ' + ((error.detail && error.detail.stack) || error.message)));
  consoleLines.on('error', (...args) => problems.push('console.error: ' + args.join(' ')));

  /* Function replacement: a string replacement would expand `$&`-style sequences inside the bundle. */
  const html = indexHtml.replace(MODULE_TAG, () => '<script>' + bundleCode + '</' + 'script>');
  assert.ok(!html.includes(MODULE_TAG), 'module tag replaced by the bundle');

  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: consoleLines, url: HOSTED_ORIGIN + '/',
    beforeParse(window) {
      window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.Element.prototype.scrollIntoView = function () {};
      window.scrollTo = function () {};
      window.localStorage.setItem('aurum_aikeys', JSON.stringify(TEST_KEYS));
      /* A socket that never connects: no feed, no ticks, no authorisation. */
      window.WebSocket = function (url) {
        sockets.push(String(url));
        this.readyState = 0;
        this.send = () => {};
        this.close = () => { this.readyState = 3; };
        this.addEventListener = () => {};
        this.removeEventListener = () => {};
      };
      /* Same-origin requests are answered by the real Worker code; anything else has no network. */
      window.fetch = async (input, init = {}) => {
        const url = new URL(String(input), HOSTED_ORIGIN);
        const headers = {};
        for (const [name, value] of Object.entries(init.headers || {})) headers[name.toLowerCase()] = String(value);
        const record = { path: url.pathname, origin: url.origin, method: init.method || 'GET', headers, status: null };
        requests.push(record);
        if (url.origin !== HOSTED_ORIGIN) throw new TypeError('network is disabled in tests');
        const response = await worker.fetch(new Request(url, { method: record.method, headers: { ...headers, origin: HOSTED_ORIGIN }, body: init.body }), env);
        record.status = response.status;
        /* Once the test is tearing the page down, leave late requests pending
           so application code never resumes against a closed document. */
        if (closing) return new Promise(() => {});
        return response;
      };
    }
  });
  const { window } = dom;
  const doc = window.document;
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const waitFor = async (condition, label, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (condition()) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for: ' + label + '\n' + problems.join('\n'));
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  /* Teardown: stop answering requests, let already-resumed application code
     finish its current microtasks, then close the window (which cancels the
     page's timers). */
  const close = async () => {
    closing = true;
    await new Promise((r) => setTimeout(r, 50));
    window.close();
  };
  return { window, doc, click, waitFor, close, requests, sockets, problems };
}

test('hosted mode: the app starts cleanly against the Worker even when every upstream provider is down', async () => {
  const app = await bootHostedApp();
  try {
    await app.waitFor(() => app.window.__aurumAppStarted === true, 'application start marker');
    await app.waitFor(() => app.requests.some((r) => r.path === '/api/health' && r.status === 200), 'health check');
    assert.equal(app.doc.getElementById('startupNotice'), null);
    assert.ok(!app.doc.querySelector('#authScreen').classList.contains('hidden'), 'the connect screen is shown');
    assert.deepEqual(app.problems, [], 'no uncaught error and no console.error during startup');

    assert.ok(app.requests.length > 0);
    for (const request of app.requests) {
      assert.equal(request.origin, HOSTED_ORIGIN, `startup request to ${request.origin}${request.path} must be same-origin`);
    }
    for (const request of app.requests.filter((r) => /^\/api\/(deriv|risk|ctl)(\/|$)/.test(r.path))) {
      assert.equal(request.status, 403, `${request.method} ${request.path} is refused by the Worker`);
    }
    assert.deepEqual(app.sockets, [], 'no socket is opened before the user chooses to enter the app');
  } finally {
    await app.close();
  }
});

test('hosted mode: AI keys saved on the device are never sent to the Cloudflare host', async () => {
  const app = await bootHostedApp();
  try {
    await app.waitFor(() => app.window.__aurumAppStarted === true, 'application start marker');
    app.click(app.doc.querySelector('#guestBtn'));
    await app.waitFor(() => app.doc.querySelector('#appShell').classList.contains('ready'), 'app shell');

    app.click(app.doc.querySelector('.nav-item[data-view="news"]'));
    await app.waitFor(() => app.doc.querySelector('#view-news').classList.contains('active'), 'news view');
    app.click(app.doc.querySelector('#newsBriefBtn'));
    await app.waitFor(() => app.requests.some((r) => r.path === '/api/news/expectations' && r.status !== null), 'the keyed request');

    const keyed = app.requests.find((r) => r.path === '/api/news/expectations');
    assert.equal(keyed.method, 'POST');
    assert.equal(keyed.headers['content-type'], 'application/json');
    const serialized = JSON.stringify(app.requests);
    for (const value of Object.values(TEST_KEYS)) {
      assert.doesNotMatch(serialized, new RegExp(value), 'a device-held AI key left the browser');
    }
    for (const request of app.requests) {
      assert.deepEqual(Object.keys(request.headers).filter((name) => name.startsWith('x-ai-')), [], `${request.method} ${request.path}`);
    }

    /* The unavailable route is reported to the user instead of failing silently. */
    await app.waitFor(() => /unavailable/i.test(app.doc.querySelector('#newsAiBody').textContent), 'visible error state');
    assert.deepEqual(app.problems, []);
  } finally {
    await app.close();
  }
});

test('hosted mode: navigation marks the current view and the menu button reports its state', async () => {
  const app = await bootHostedApp();
  try {
    await app.waitFor(() => app.window.__aurumAppStarted === true, 'application start marker');
    app.click(app.doc.querySelector('#guestBtn'));
    await app.waitFor(() => app.doc.querySelector('#appShell').classList.contains('ready'), 'app shell');

    app.click(app.doc.querySelector('.nav-item[data-view="settings"]'));
    const current = app.doc.querySelectorAll('.nav-item[aria-current="page"]');
    assert.equal(current.length, 1, 'exactly one navigation item is current');
    assert.equal(current[0].dataset.view, 'settings');
    assert.ok(current[0].classList.contains('active'));

    const menu = app.doc.querySelector('#hamburger');
    assert.equal(menu.getAttribute('aria-controls'), 'sidebar');
    assert.equal(menu.getAttribute('aria-expanded'), 'false');
    app.click(menu);
    assert.equal(menu.getAttribute('aria-expanded'), 'true');
    assert.ok(app.doc.querySelector('#sidebar').classList.contains('open'));
    app.click(app.doc.querySelector('#scrim'));
    assert.equal(menu.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(app.problems, []);
  } finally {
    await app.close();
  }
});

test('hosted mode: losing and regaining the network connection is announced in the live region', async () => {
  const app = await bootHostedApp();
  try {
    await app.waitFor(() => app.window.__aurumAppStarted === true, 'application start marker');
    const region = app.doc.querySelector('#toasts');
    assert.equal(region.getAttribute('aria-live'), 'polite');
    assert.doesNotMatch(region.textContent, /offline/i);

    app.window.dispatchEvent(new app.window.Event('offline'));
    assert.match(region.textContent, /You are offline/);
    app.window.dispatchEvent(new app.window.Event('online'));
    assert.match(region.textContent, /Network connection restored/);
    assert.deepEqual(app.problems, []);
  } finally {
    await app.close();
  }
});
