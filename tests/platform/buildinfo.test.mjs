/*
 * src/buildinfo.js — release detection, safe refresh gating and diagnostics.
 * All collaborators are injected; nothing here touches the network or a real
 * DOM beyond a minimal jsdom document.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  pageBuildMeta, idsDiffer, buildEnvironment, safeToRefresh,
  fetchBuildInfo, initBuildUpdateWatch
} from '../../src/buildinfo.js';

test('the running page compares its stamped id with the served release', () => {
  const dom = new JSDOM('<!doctype html><html><head><meta name="aurum-build" content="b111"></head><body></body></html>');
  assert.equal(pageBuildMeta(dom.window.document), 'b111');
  assert.equal(idsDiffer('b111', 'b111'), false, 'same release: no banner');
  assert.equal(idsDiffer('b111', 'b222'), true, 'new release: banner');
  assert.equal(idsDiffer('dev', 'b222'), true, 'unbuilt dev page adopts the served release');
  assert.equal(idsDiffer(null, 'b222'), true);
  assert.equal(idsDiffer('b111', null), false, 'no remote id: never claim an update');
  assert.equal(idsDiffer('b111', undefined), false);
});

test('environment labelling distinguishes staging, loopback and LAN', () => {
  assert.equal(buildEnvironment('cloudflare-staging.frednjogu4.workers.dev'), 'STAGING (Cloudflare)');
  assert.equal(buildEnvironment('127.0.0.1'), 'LOCAL');
  assert.equal(buildEnvironment('localhost'), 'LOCAL');
  assert.equal(buildEnvironment('192.168.1.20'), 'LOCAL (LAN)');
});

test('the automatic refresh is gated: hidden tab, submitting form, open modal, focused or dirty input all block it', () => {
  const dom = new JSDOM('<!doctype html><html><body>' +
    '<form><input id="a"></form><div class="modal-overlay"><div class="modal"></div></div>' +
    '</body></html>', { url: 'http://127.0.0.1:8788/app' });
  const doc = dom.window.document;
  Object.defineProperty(doc, 'hidden', { configurable: true, value: false });
  assert.equal(safeToRefresh({ doc, now: 99999999 }), true, 'idle page: refresh allowed');

  assert.equal(safeToRefresh({ doc, graceUntil: Date.now() + 60000 }), false, 'grace period: deferred');
  assert.equal(safeToRefresh({ doc, submitting: true, now: 99999999 }), false, 'form submitting: never interrupt');

  doc.querySelector('.modal-overlay').classList.add('open');
  assert.equal(safeToRefresh({ doc, now: 99999999 }), false, 'modal open: deferred');
  doc.querySelector('.modal-overlay').classList.remove('open');

  doc.body.focus?.();
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => doc.getElementById('a') });
  assert.equal(safeToRefresh({ doc, now: 99999999 }), false, 'input focused: user is typing');
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => doc.body });

  const field = doc.getElementById('a');
  field.value = 'edited';
  field.dataset.aurumTouched = '1';
  assert.equal(safeToRefresh({ doc, now: 99999999 }), false, 'unsubmitted input: deferred');
  field.value = '';
  assert.equal(safeToRefresh({ doc, now: 99999999 }), true, 'cleared again: safe');

  Object.defineProperty(doc, 'hidden', { configurable: true, value: true });
  assert.equal(safeToRefresh({ doc, now: 99999999 }), false, 'hidden tab: deferred');
});

test('fetchBuildInfo reads /build.json without caching and fails softly', async () => {
  const ok = await fetchBuildInfo(async (url, opts) => {
    assert.equal(url, '/build.json');
    assert.equal(opts.cache, 'no-store');
    return { ok: true, json: async () => ({ id: 'b1', version: '1.0.0', git: 'abc12345', builtAt: 'T', mode: 'LOCAL' }) };
  }, '/build.json');
  assert.deepEqual(ok, { ok: true, id: 'b1', version: '1.0.0', git: 'abc12345', builtAt: 'T', mode: 'LOCAL', service: null });

  assert.equal((await fetchBuildInfo(async () => ({ ok: false, status: 503 }), '/build.json')).ok, false);
  assert.equal((await fetchBuildInfo(async () => { throw new Error('offline'); }, '/build.json')).ok, false);
});

test('a changed release shows the NEW VERSION banner once and only reloads when safe', async () => {
  const dom = new JSDOM('<!doctype html><html><head><meta name="aurum-build" content="bold"></head><body></body></html>', { url: 'http://127.0.0.1:8788/app' });
  const doc = dom.window.document;
  Object.defineProperty(doc, 'hidden', { configurable: true, value: false });
  const win = dom.window;

  const timers = [];
  const intervals = [];
  let reloaded = 0;
  let remoteId = 'bnew';

  const watch = initBuildUpdateWatch({
    doc,
    win,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: remoteId, version: '1.0.0' }) }),
    intervalMs: 9999,
    graceMs: 10,
    firstPollDelayMs: 0,
    reload: () => { reloaded += 1; },
    setIntervalImpl: (fn, ms) => { intervals.push(fn); return intervals.length; },
    clearIntervalImpl: () => {},
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }
  });

  /* Same id: no banner. */
  remoteId = 'bold';
  await intervals[0]();
  assert.equal(doc.getElementById('updateBanner'), null);

  /* New id: banner appears exactly once, even after further polls. */
  remoteId = 'bnew';
  await intervals[0]();
  await intervals[0]();
  const banner = doc.getElementById('updateBanner');
  assert.ok(banner, 'banner shown for a new release');
  assert.match(banner.textContent, /NEW VERSION AVAILABLE/);
  assert.match(banner.textContent, /Refresh/);

  /* Grace timer elapses on an idle page: one automatic reload. */
  const grace = timers.find((t) => t.ms === 10);
  assert.ok(grace, 'auto-refresh timer scheduled');
  grace.fn();
  assert.equal(reloaded, 1, 'reloaded once');
  /* Subsequent grace attempts never fire again (timer list unchanged). */
  watch.dispose();
  assert.equal(reloaded, 1, 'no reload loops');
});
