#!/usr/bin/env node
/* Visual verification harness for the GOLD MARKET STRENGTH meter.
 *
 *   node scripts/screenshot-gold-strength.mjs --tag before|after [--port 5199]
 *
 * The sandbox has no market-data egress, so --tag after injects a clearly
 * labelled FIXTURE:
 *   - a mock WebSocket answering the Deriv public protocol with synthetic
 *     candles/ticks generated in-page (chart + quote visuals), and
 *   - an intercepted /api/signals/analyze whose response is built in Node
 *     from the SAME synthetic candle sets through the real marketStrength()
 *     engine — data_source in the screenshot says FIXTURE.
 * BEFORE runs plain (no mock) and captures the pre-change build as-is.
 * Captures desktop 1600x900 (Command Centre + Gold) and mobile 390x844
 * (both), and prints browser console errors for each shot.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { marketStrength } from '../server/lib/strength.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TAG = arg('--tag', 'after');
const PORT = arg('--port', '5199');
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(root, 'screenshots');
mkdirSync(OUT, { recursive: true });

const NOW = Math.floor(Date.now() / 1000);
function series(n, dir, gran, seed) {
  const out = []; let price = seed;
  for (let i = 0; i < n; i++) {
    const step = dir === 'up' ? 0.8 : dir === 'down' ? -0.8 : 0;
    const open = price;
    const close = Math.max(0.5, price + step);
    out.push({ time: NOW - (n - 1 - i) * gran, open, high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3, close });
    price = close;
  }
  return out;
}
const SETS = { m1: series(120, 'up', 60, 2650), m5: series(120, 'up', 300, 2650), h1: series(120, 'up', 3600, 2650) };
const STRENGTH = marketStrength(SETS, { nowSec: NOW, currentPresent: true });
const FIXTURE = {
  symbol: 'XAU/USD', timeframe: 'MTF',
  signal: 'WAIT', confidence: 54, mtf_signal: 'MIXED — WAIT',
  votes: 'M1 +4 BUY · M5 +3 BUY · H1 +1 WAIT',
  wait_reason: 'MTF_LEAN_NOT_CONFIRMED', wait_detail: 'Timeframe lean not confirmed; monitor stands aside.',
  price: 2650.42, entry: 2650.4, stop_loss: 2637.2, tp1: 2663.6, tp2: 2676.8,
  rationale: 'Fixture reading (sandbox has no market-data egress): bullish M1/M5 alignment with H1 not yet confirming — WAIT remains possible beside a dominant strength bar.',
  risks: ['Fixture data — harness-served for visual verification only.', 'Scores are technical evidence, not probabilities of profit.'],
  data_ok: true,
  data_source: 'FIXTURE (harness): completed M1/M5/H1 candles served locally — sandbox egress blocked, not live market data',
  latest_candle_time: NOW - 65, candle_close: true, candle_current: true,
  updatedAt: Date.now(), sentiment_score: 50, sentiment_source: 'derived',
  news: { available: false, reason: 'technical_only' },
  strength: STRENGTH
};

function fixtureFor(sym) {
  const s = String(sym || 'XAU/USD');
  if (/XAU|GOLD/i.test(s)) return FIXTURE;
  return Object.assign({}, FIXTURE, {
    symbol: s,
    price: 1.085, entry: 1.085, stop_loss: 1.0795, tp1: 1.0908, tp2: 1.0965,
    rationale: 'Fixture reading (sandbox has no market-data egress): harness-served technical analysis for ' + s + ' — not live market data.'
  });
}

const MOCK_WS = `
(() => {
  const FIX = window.__FIXTURE__;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const priceFor = (code) => /gold|xau/i.test(code) ? 2650.42 : 1 + ((code.length * 37 + code.charCodeAt(0)) % 900) / 1000;
  function candlesFor(g, n) {
    const out = []; let p = /gold|xau/i.test(String(g)) ? 2650 : 100;
    const now = nowSec();
    const base = 2650;
    p = base;
    for (let i = n - 1; i >= 0; i--) {
      const t = now - i * g - 5;
      const open = p, close = p + 0.8;
      out.push({ epoch: t, open, high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3, close });
      p = close;
    }
    return out;
  }
  class MockWS {
    constructor(url) { this.url = String(url); this.readyState = 0; this.onopen = this.onmessage = this.onerror = this.onclose = null;
      queueMicrotask(() => { this.readyState = 1; if (this.onopen) this.onopen({}); }); }
    _emit(obj) { const data = JSON.stringify(obj); queueMicrotask(() => { if (this.onmessage) this.onmessage({ data }); }); }
    send(raw) {
      let m; try { m = JSON.parse(String(raw)); } catch (_e) { return; }
      if (m.ticks_history && m.style === 'candles') {
        this._emit({ req_id: m.req_id, candles: candlesFor(Number(m.granularity) || 300, Number(m.count) || 120) });
      } else if (m.ticks_history || m.ticks) {
        const code = String(m.ticks_history || m.ticks);
        const id = 'mock-' + code + '-' + (m.req_id || 0);
        const echo = m.passthrough ? { passthrough: m.passthrough } : {};
        this._emit(Object.assign({ req_id: m.req_id, subscription: { id } }, echo));
        this._emit({ tick: { symbol: code, quote: priceFor(code), epoch: nowSec() }, subscription: { id } });
      } else if (m.forget) { this._emit({ forget: m.forget, id: m.forget }); }
    }
    close() { this.readyState = 3; queueMicrotask(() => { if (this.onclose) this.onclose({}); }); }
  }
  window.WebSocket = MockWS;
})();`;

async function enterApp(page) {
  await page.evaluate(() => { const g = document.querySelector('#guestBtn'); if (g) g.click(); });
  await page.waitForSelector('#appShell.ready', { timeout: 12000 });
  await new Promise((r) => setTimeout(r, 600));
}
async function shot(page, name, errors) {
  errors.length = 0;
  await new Promise((r) => setTimeout(r, 900));
  const file = join(OUT, `${TAG}-${name}.png`);
  const view = await page.evaluate(() => {
    const a = document.querySelector('.nav-item.active');
    if (a && a.dataset.view) return a.dataset.view;
    const s = document.querySelector('.view.active, section.view.active, [id^="view-"].active');
    return s ? (s.id || 'active-view') : '?';
  }).catch(() => '?');
  await page.screenshot({ path: file });
  console.log(`SHOT ${file} · view:${view} · console errors: ${errors.length}`);
  if (errors.length) console.log('  ' + errors.slice(0, 5).join('\n  '));
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    args: [...chromium.args, '--no-sandbox'],
    headless: 'shell',
    env: { ...process.env, LD_LIBRARY_PATH: '/tmp/al2023/lib' }
  });
  const pages = [];
  async function newPage(viewport) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e && e.message || e).slice(0, 160)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
    if (TAG === 'after') {
      await page.evaluateOnNewDocument((fixture, mockSrc) => {
        window.__FIXTURE__ = fixture;
        try { (0, eval)(mockSrc); } catch (e) { console.error('mock-inject-failed: ' + (e && e.message)); }
      }, FIXTURE, MOCK_WS);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/signals/analyze')) {
          let sym = 'XAU/USD';
          try { const b = JSON.parse(req.postData() || '{}'); if (b.symbol) sym = b.symbol; } catch (_e) {}
          req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fixtureFor(sym)) });
        } else if (url.includes('/api/signals/scan')) {
          /* azAnalyze reaches analyze only after the scan fallback returns a row */
          let syms = ['EUR/USD'];
          try { const b = JSON.parse(req.postData() || '{}'); if (Array.isArray(b.symbols) && b.symbols.length) syms = b.symbols; } catch (_e) {}
          const results = syms.map((sym) => Object.assign({}, fixtureFor(sym), {
            source: 'Deriv public candles', data_source: 'Deriv public candles',
            computed: 'server', ts: Date.now()
          }));
          delete results[0].meta;
          req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ results }) });
        } else if (url.includes('/api/')) {
          req.respond({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'harness: no backend' }) });
        } else req.continue();
      });
    }
    pages.push({ page, errors });
    return page;
  }

  const desk = await newPage({ width: 1600, height: 900 });
  await desk.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  await enterApp(desk);
  await desk.evaluate(() => { const b = document.querySelector('[data-view="overview"]'); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 800));
  if (TAG === 'after') await desk.waitForFunction(() => { const e = document.querySelector('#ovProvenance'); return e && e.textContent.length > 40; }, { timeout: 8000 }).catch(() => {});
  await shot(desk, 'command-centre-desktop', pages[0].errors);

  if (TAG === 'after') {
    /* Signal Analyzer: any instrument → MARKET STRENGTH block */
    await desk.evaluate(() => { const b = document.querySelector('[data-view="signals"]'); if (b) b.click(); });
    await new Promise((r) => setTimeout(r, 600));
    await desk.evaluate(() => { const r = document.querySelector('#azRun'); if (r) r.click(); });
    await desk.waitForFunction(() => /%$/.test((document.querySelector('#azStrength [data-s="buyPct"]') || {}).textContent || ''), { timeout: 15000 }).catch(() => {});
    await desk.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); const s = document.querySelector('#azStrength'); if (s) s.scrollIntoView({ block: 'center' }); });
    await shot(desk, 'signals-desktop', pages[0].errors);
    const azEvidence = await desk.evaluate(() => ({
      symbol: (document.querySelector('#azSymbol') || {}).value,
      signal: (document.querySelector('#azSignal') || {}).textContent,
      buy: (document.querySelector('#azStrength [data-s="buyPct"]') || {}).textContent,
      sell: (document.querySelector('#azStrength [data-s="sellPct"]') || {}).textContent,
      neutral: (document.querySelector('#azStrength [data-s="neutralPct"]') || {}).textContent,
      cls: (document.querySelector('#azStrength [data-s="cls"]') || {}).textContent
    }));
    console.log('AZ-EVIDENCE ' + JSON.stringify(azEvidence));
  }

  await desk.evaluate(() => { const b = document.querySelector('[data-view="gold"]'); if (b) b.click(); });
  if (TAG === 'after') {
    await desk.waitForFunction(() => /%$/.test((document.querySelector('#strengthBuyPct') || {}).textContent || ''), { timeout: 15000 }).catch(() => {});
  } else {
    await new Promise((r) => setTimeout(r, 4000));
  }
  await desk.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); const s = document.querySelector('#goldStrength'); if (s) s.scrollIntoView({ block: 'start' }); });
  await shot(desk, 'gold-desktop', pages[0].errors);
  const evidence = await desk.evaluate(() => ({
    badge: (document.querySelector('#goldSignalBadge') || {}).textContent,
    entry: (document.querySelector('#goldEntry') || {}).textContent,
    votes: ((document.querySelector('#goldVotes') || {}).textContent || '').slice(0, 90),
    buy: (document.querySelector('#strengthBuyPct') || {}).textContent,
    sell: (document.querySelector('#strengthSellPct') || {}).textContent,
    neutral: (document.querySelector('#strengthNeutralPct') || {}).textContent,
    classification: (document.querySelector('#strengthClass') || {}).textContent,
    provenance: ((document.querySelector('#strengthProvenance') || {}).textContent || '').slice(0, 220)
  }));
  console.log('EVIDENCE ' + JSON.stringify(evidence));

  const mob = await newPage({ width: 390, height: 844 });
  await mob.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  await enterApp(mob);
  await mob.evaluate(() => { const b = document.querySelector('[data-view="gold"]'); if (b) b.click(); });
  if (TAG === 'after') {
    await mob.waitForFunction(() => /%$/.test((document.querySelector('#strengthBuyPct') || {}).textContent || ''), { timeout: 15000 }).catch(() => {});
  } else {
    await new Promise((r) => setTimeout(r, 4000));
  }
  await mob.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); const s = document.querySelector('#goldStrength'); if (s) s.scrollIntoView({ block: 'start' }); });
  await shot(mob, 'gold-mobile', pages[1].errors);

  await mob.evaluate(() => { const b = document.querySelector('[data-view="overview"]'); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 800));
  await shot(mob, 'command-centre-mobile', pages[1].errors);

  await browser.close();
  writeFileSync(join(OUT, `${TAG}-strength-fixture.json`), JSON.stringify({ tag: TAG, strength: STRENGTH, fixtureSource: FIXTURE.data_source }, null, 2));
  console.log('DONE', TAG, 'strength:', STRENGTH.ok ? `${STRENGTH.buying}/${STRENGTH.selling}/${STRENGTH.neutral} ${STRENGTH.classification}` : STRENGTH.reason);
}
run().catch((e) => { console.error('HARNESS-FAIL', e); process.exit(1); });
