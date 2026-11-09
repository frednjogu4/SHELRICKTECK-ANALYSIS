import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';

/* ================================================================
 * Pattern API tests — STUB feed, no network.
 * ================================================================ */

process.env.DAILY_BUDGET_USD = '5';

function stubCandles(sym, granularity, count = 120) {
  const base = 1.1;
  const out = [];
  let p = base;
  for (let i = 0; i < count; i++) {
    p = p * (1 + 0.0004 + Math.sin(i / 7) * 0.0006);
    out.push({ time: 1700000000 + i * granularity, open: p * 0.999, high: p * 1.003, low: p * 0.997, close: p, volume: 8 });
  }
  return out;
}
const stubFeed = {
  symbols: { 'EUR/USD': 'frxEURUSD' },
  fetchCandles: async (sym, g, n) => {
    if (sym === 'XAU/USD') throw new Error('stub: candles down');
    if (sym === 'GBP/USD') return stubCandles(sym, g, 10);
    return stubCandles(sym, g, n);
  }
};

let server;
let base;
let tmpDir;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aurum-patapi-'));
  const store = createStore(join(tmpDir, 'store.json'));
  const config = configFromEnv({ DAILY_BUDGET_USD: '5' });
  const app = createApp({ store, config, feed: stubFeed });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server && server.close();
  tmpDir && rmSync(tmpDir, { recursive: true, force: true });
});

const post = (p, body) => fetch(base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {})
});

test('POST /api/patterns/analyze — 200 with candles + detections array', async () => {
  const r = await post('/api/patterns/analyze', { symbol: 'EURUSD', granularity: 300, bars: 120 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.symbol, 'EUR/USD');
  assert.equal(j.granularity, 300);
  assert.ok(Array.isArray(j.candles) && j.candles.length === 120, 'candles ' + (j.candles || []).length);
  assert.ok(Array.isArray(j.patterns));
  assert.equal(j.source, 'deriv-candles');
  for (const d of j.patterns) {
    assert.ok(d.key && d.pattern && d.direction && d.action != null);
    assert.ok(d.confidence >= 40 && d.confidence <= 92, 'conf ' + d.confidence);
    assert.ok(Array.isArray(d.lines));
  }
});

test('POST /api/patterns/analyze — validation 400s', async () => {
  assert.equal((await post('/api/patterns/analyze', { symbol: 12345 })).status, 400);
  assert.equal((await post('/api/patterns/analyze', { symbol: 'EURUSD', granularity: 77 })).status, 400);
  const r = await post('/api/patterns/analyze', { symbol: 'EURUSD', bars: 99999 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.candles.length, 240, 'bars clamped to max 240 (clamp convention, same as backtest)');
});

test('POST /api/patterns/analyze — insufficient history → 502, feed error → 502 (no stack leak)', async () => {
  const short = await post('/api/patterns/analyze', { symbol: 'GBPUSD' });
  assert.equal(short.status, 502);
  assert.equal((await short.json()).error, 'insufficient_history');

  const fail = await post('/api/patterns/analyze', { symbol: 'XAUUSD' });
  assert.equal(fail.status, 502);
  const body = JSON.stringify(await fail.json());
  assert.ok(!body.includes('at Object') && !body.includes('.mjs:'), 'no stack traces to client');
});

test('POST /api/patterns/study — walk-forward shape', async () => {
  const r = await post('/api/patterns/study', { symbol: 'EURUSD', granularity: 300, bars: 400 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.window >= 300, 'window ' + j.window);
  assert.equal(j.holdBars, 48);
  assert.ok(typeof j.signals === 'number');
  assert.ok(Array.isArray(j.patterns));
  assert.ok(j.note && (j.note.includes('Walk-forward') || j.note.includes('Small sample')), j.note);
  assert.ok(j.meta && j.meta.double_bot && j.meta.hs, 'education meta included');
  assert.equal(j.source, 'deriv-candles');
});

test('POST /api/patterns/study — rejects bad input and short history', async () => {
  assert.equal((await post('/api/patterns/study', { symbol: 'NOPE!!' })).status, 400);
  assert.equal((await post('/api/patterns/study', { symbol: 'EURUSD', granularity: 12345 })).status, 400);
  const short = await post('/api/patterns/study', { symbol: 'GBPUSD' });
  assert.equal(short.status, 502);
});
