/*
 * Phase 8 Master Regression Suite — verifies the 7 core platform invariants:
 *   1. Single Market Command Centre mount (never duplicated on index.html or
 *      across repeated initCommandCentre calls).
 *   2. Local (`bridge/`) and staging (`dist/` + Worker) manifest revision parity.
 *   3. Stale service-worker cache invalidation, `no-cache` shell install,
 *      failure recovery, message protocol, and zero browser-storage deletion.
 *   4. Gold Market Strength Monitor: Buying green, Selling red, Neutral grey,
 *      exact 100% sum on validated closed candles, INSUFFICIENT_DATA abstention,
 *      and explicit non-profit-probability framing.
 *   5. TradingView widget embeds only via official TradingView URLs, never
 *      scrapes private TradingView APIs, and visually separates external chart
 *      display from internal candle analysis.
 *   6. Data Source Selector (`#goldSourceSelect` + `describeDataSourceSelection`)
 *      cleanly separates provider, session, instrument, timeframe, freshness,
 *      and fallback provider without mislabelling fallback/delayed/demo feeds.
 *   7. Packaged local upstream release detection (`initUpstreamReleaseNotice`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

import { initCommandCentre } from '../../src/commandcentre.js';
import { initUpstreamReleaseNotice } from '../../src/buildinfo.js';
import { describeDataSourceSelection } from '../../src/provenance.js';
import { marketStrength } from '../../server/lib/strength.js';
import worker from '../../cloudflare/worker.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
const distHtml = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
const bridgeHtml = readFileSync(join(root, 'bridge', 'app.html'), 'utf8');

test('Regression 1: only one Market Command Centre mounts — index.html keeps single #commandTitle and refuses duplicate #shelrick-command-centre', () => {
  /* Canonical index.html already has #commandTitle; initCommandCentre must refuse to inject a second Command Centre */
  const fullDom = new JSDOM(indexHtml);
  const fullDoc = fullDom.window.document;
  assert.equal(fullDoc.querySelectorAll('#commandTitle').length, 1);
  assert.equal(initCommandCentre(fullDoc), false, 'must not mount a duplicate Command Centre when #commandTitle already exists');
  assert.equal(fullDoc.getElementById('shelrick-command-centre'), null);
  assert.equal(fullDoc.querySelectorAll('#commandTitle').length, 1);

  /* Minimal overview shell without #commandTitle mounts once and stays idempotent (1 node) */
  const minimalDom = new JSDOM('<!DOCTYPE html><html><body><section id="view-overview"><div id="feedText">ok</div><div id="derivPill">ok</div><div id="mt5Status">off</div><div id="ovKpis"></div><div id="ovMovers"></div><div id="ovSignals"></div><div id="ovPositions"></div></section><div id="kpiValue">$0</div><div id="kpiPl">$0</div><div id="kpiMargin">off</div><div id="kpiWin">—</div></body></html>');
  const minDoc = minimalDom.window.document;
  assert.equal(initCommandCentre(minDoc), true);
  assert.equal(initCommandCentre(minDoc), true);
  assert.equal(minDoc.querySelectorAll('#shelrick-command-centre').length, 1);

  for (const [label, html] of [['index.html', indexHtml], ['dist/index.html', distHtml], ['bridge/app.html', bridgeHtml]]) {
    const d = new JSDOM(html).window.document;
    assert.equal(d.querySelectorAll('#commandTitle').length, 1, `${label} must have exactly one #commandTitle`);
    assert.equal(d.querySelectorAll('#shelrick-command-centre').length, 0, `${label} must have zero duplicate #shelrick-command-centre`);
    assert.equal(d.querySelectorAll('#view-overview').length, 1, `${label} must have exactly one #view-overview`);
  }
});

test('Regression 2: local bridge and Cloudflare staging Worker report the exact same canonical manifest revision', async () => {
  const distManifest = JSON.parse(readFileSync(join(root, 'dist', 'build.json'), 'utf8'));
  const bridgeManifest = JSON.parse(readFileSync(join(root, 'bridge', 'pwa', 'build.json'), 'utf8'));

  assert.deepEqual(bridgeManifest, distManifest, 'bridge/pwa/build.json must match dist/build.json identically');
  assert.ok(distManifest.id && distManifest.version && distManifest.git && distManifest.builtAt);

  const env = {
    ASSETS: {
      fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === '/build.json') {
          return new Response(JSON.stringify(distManifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      }
    }
  };
  const res = await worker.fetch(new Request('https://cloudflare-staging.frednjogu4.workers.dev/build.json'), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  const stagingJson = await res.json();
  assert.equal(stagingJson.id, distManifest.id);
  assert.equal(stagingJson.version, distManifest.version);
  assert.equal(stagingJson.git, distManifest.git);
  assert.equal(stagingJson.builtAt, distManifest.builtAt);
  assert.equal(stagingJson.environment, 'staging');
});

test('Regression 3: service worker deletes stale caches, bypasses HTTP cache on shell install, recovers from install failure, and never clears storage', async () => {
  const stampedSw = readFileSync(join(root, 'dist', 'sw.js'), 'utf8');
  assert.doesNotMatch(stampedSw, /localStorage\.clear|sessionStorage\.clear|indexedDB\.deleteDatabase/);

  const storeMap = new Map([['aurum-local-oldstale0001', new Map([['/app', 'OLD_HTML']])]]);
  const fetchCalls = [];
  let skipWaitingCalled = 0;
  let claimCalled = 0;
  const listeners = {};

  const makeSandbox = (failUrl = null) => {
    skipWaitingCalled = 0;
    claimCalled = 0;
    fetchCalls.length = 0;
    for (const k of Object.keys(listeners)) delete listeners[k];

    const caches = {
      open: async (name) => {
        if (!storeMap.has(name)) storeMap.set(name, new Map());
        const bucket = storeMap.get(name);
        return {
          put: async (k, v) => { bucket.set(typeof k === 'string' ? k : k.url, v); }
        };
      },
      keys: async () => [...storeMap.keys()],
      delete: async (k) => storeMap.delete(k),
      match: async (req) => {
        const key = typeof req === 'string' ? req : new URL(req.url).pathname;
        for (const bucket of storeMap.values()) {
          if (bucket.has(key)) return bucket.get(key);
        }
        return undefined;
      }
    };

    const selfObj = {
      location: { origin: 'http://127.0.0.1:8788' },
      skipWaiting: () => { skipWaitingCalled += 1; },
      clients: { claim: async () => { claimCalled += 1; } },
      addEventListener: (type, fn) => { listeners[type] = fn; }
    };

    const fetchFn = async (input, init = {}) => {
      const urlStr = typeof input === 'string' ? input : input.url;
      fetchCalls.push({ url: urlStr, cache: init.cache || null });
      if (failUrl && urlStr.includes(failUrl)) {
        return { ok: false, status: 500, clone() { return this; } };
      }
      return { ok: true, status: 200, body: `FRESH:${urlStr}`, clone() { return { ...this }; } };
    };

    vm.runInNewContext(stampedSw, { self: selfObj, caches, fetch: fetchFn, URL });
    return { selfObj };
  };

  /* 3a. Failed shell precache must reject and NOT call skipWaiting */
  makeSandbox('/manifest.webmanifest');
  let installPromise;
  listeners.install({ waitUntil: (p) => { installPromise = p; } });
  let installThrew = false;
  try {
    await installPromise;
  } catch (err) {
    installThrew = /precache failed/.test(String(err && err.message || err));
  }
  assert.equal(installThrew, true, 'failed shell asset must abort install and clean partial cache');
  assert.equal(skipWaitingCalled, 0, 'broken install must not call skipWaiting');

  /* 3b. Clean install fetches every shell entry with { cache: "no-cache" } and purges stale cache on activate */
  makeSandbox(null);
  listeners.install({ waitUntil: (p) => { installPromise = p; } });
  await installPromise;
  assert.equal(skipWaitingCalled, 1);
  assert.ok(fetchCalls.every((c) => c.cache === 'no-cache'), 'every install precache fetch must bypass HTTP cache');

  let activatePromise;
  listeners.activate({ waitUntil: (p) => { activatePromise = p; } });
  await activatePromise;
  assert.equal(claimCalled, 1);
  assert.equal(storeMap.has('aurum-local-oldstale0001'), false, 'stale release cache must be deleted on activate');

  /* 3c. /update-check and /build.json are never intercepted by SW */
  let intercepted = false;
  listeners.fetch({
    request: { method: 'GET', mode: 'cors', url: 'http://127.0.0.1:8788/update-check' },
    respondWith: () => { intercepted = true; }
  });
  assert.equal(intercepted, false, '/update-check must never be intercepted by SW');
});

test('Regression 4: Gold Market Strength uses green/red/grey bars across all monitors, sums to 100%, and abstains cleanly on missing candles', () => {
  assert.match(indexHtml, /#strengthBuyBar,\.strength-track i\[data-s="buyBar"\]\{background:var\(--green\)\}/);
  assert.match(indexHtml, /#strengthSellBar,\.strength-track i\[data-s="sellBar"\]\{background:var\(--red\)\}/);
  assert.match(indexHtml, /#strengthNeutralBar,\.strength-track i\[data-s="neutralBar"\]\{background:var\(--text-3,#8a95a5\)\}/);

  const emptyRes = marketStrength({}, { nowSec: 1_700_000_000 });
  assert.equal(emptyRes.ok, false);
  assert.equal(emptyRes.reason, 'INSUFFICIENT_DATA');
  assert.equal(emptyRes.buying, undefined);

  const nowSec = 1_700_100_000;
  const makeSeries = (granSec, count, slope) => {
    const out = [];
    const start = nowSec - count * granSec;
    for (let i = 0; i < count; i += 1) {
      const base = 2000 + i * slope + Math.sin(i / 3) * 0.8;
      out.push({
        time: start + i * granSec,
        open: base - 0.3,
        high: base + 1.1,
        low: base - 1.0,
        close: base + 0.4
      });
    }
    return out;
  };
  const validRes = marketStrength({
    m1: makeSeries(60, 80, 0.15),
    m5: makeSeries(300, 80, 0.25),
    h1: makeSeries(3600, 80, 0.6)
  }, { nowSec, currentPresent: true });

  assert.equal(validRes.ok, true);
  assert.equal(validRes.buying + validRes.selling + validRes.neutral, 100);
  assert.match(validRes.disclaimer, /not a probability of profit/i);
  assert.equal(validRes.currentCandle, 'excluded (still forming)');
});

test('Regression 5: TradingView embeds only official TradingView widget URLs, never scrapes private APIs, and separates visual chart display from internal analysis', () => {
  const mainJs = readFileSync(join(root, 'src', 'main.js'), 'utf8');
  const tvJs = readFileSync(join(root, 'src', 'tradingview.js'), 'utf8');
  const provJs = readFileSync(join(root, 'src', 'provenance.js'), 'utf8');

  assert.match(tvJs, /https:\/\/s\.tradingview\.com\/widgetembed\//);
  for (const src of [mainJs, tvJs, provJs]) {
    assert.doesNotMatch(src, /scanner\.tradingview\.com|symbol-search\.tradingview\.com|prodata\.tradingview\.com/i);
  }
  assert.match(provJs, /TradingView widget — display only, not an analysis input/);
  assert.match(indexHtml, /Index quotes come from TradingView and may be delayed versus your broker's feed — they are never labelled live/);
});

test('Regression 6: Data Source Selector cleanly separates provider, session, instrument, timeframe, freshness, and fallback provider', () => {
  const dom = new JSDOM(indexHtml);
  const { document } = dom.window;

  for (const id of [
    'goldSourceSelect',
    'goldDataSourceDetails',
    'dsSelectedProvider',
    'dsActiveProvider',
    'dsFallbackProvider',
    'dsSession',
    'dsInstrument',
    'dsTimeframe',
    'dsFreshness'
  ]) {
    assert.ok(document.getElementById(id), `Missing Data Source Selector element #${id}`);
  }

  /* Auto mode with MT5 disconnected -> explicitly reports fallback to Deriv public candles, never calls it a live broker feed */
  const fallbackState = describeDataSourceSelection({
    selectedMode: 'auto',
    mt5Connected: false,
    instrument: 'XAU/USD',
    timeframe: 'Completed M1 / M5 / H1 candles',
    lastUpdateMs: 1_700_000_000_000,
    nowMs: 1_700_000_020_000
  });
  assert.equal(fallbackState.fallbackActive, true);
  assert.match(fallbackState.selectedProvider, /^Auto/);
  assert.match(fallbackState.activeProvider, /Deriv public feed.*not a broker account feed/i);
  assert.match(fallbackState.fallbackProvider, /fallback active/i);
  assert.match(fallbackState.freshness, /^LIVE/);
  assert.equal(fallbackState.instrument, 'XAU/USD');
  assert.equal(fallbackState.timeframe, 'Completed M1 / M5 / H1 candles');
  assert.ok(fallbackState.session.includes('UTC'));

  /* Demo MT5 connected -> labelled Demo account bridge, never real live broker */
  const demoState = describeDataSourceSelection({
    selectedMode: 'mt5',
    mt5Connected: true,
    mt5AccountMode: 'demo',
    instrument: 'XAU/USD (XAUUSDm)',
    lastUpdateMs: 1_700_000_000_000,
    nowMs: 1_700_000_005_000
  });
  assert.equal(demoState.fallbackActive, false);
  assert.match(demoState.activeProvider, /Demo account bridge/);
  assert.match(demoState.fallbackProvider, /^None/);

  /* Delayed/cached feeds are explicitly tagged and never called LIVE */
  const delayedState = describeDataSourceSelection({
    selectedMode: 'deriv',
    mt5Connected: false,
    delayed: true,
    lastUpdateMs: 1_700_000_000_000,
    nowMs: 1_700_000_600_000
  });
  assert.match(delayedState.activeProvider, /\[delayed\]/i);
  assert.match(delayedState.freshness, /^DELAYED/);
});

test('Regression 7: initUpstreamReleaseNotice surfaces an upstream update banner on local installs when a newer GitHub/staging build exists', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><head><meta name="aurum-build" content="oldlocal00001"></head><body></body></html>', {
    url: 'http://127.0.0.1:8788/app'
  });
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      installedId: 'oldlocal00001',
      upstreamId: 'newstage99999',
      upstreamGit: 'a1b2c3d4e5f6',
      updateAvailable: true
    })
  });

  const handle = initUpstreamReleaseNotice({
    win: dom.window,
    doc: dom.window.document,
    fetchImpl: fakeFetch,
    intervalMs: 600_000,
    firstDelayMs: 600_000
  });
  try {
    await handle.check();
    const banner = dom.window.document.getElementById('upstreamUpdateBanner');
    assert.ok(banner, 'upstream update banner must be mounted when updateAvailable is true');
    assert.match(banner.textContent, /newstage99999/);
    assert.match(banner.textContent, /UPDATE_LOCAL_APP\.bat/);
  } finally {
    handle.dispose();
  }
});
