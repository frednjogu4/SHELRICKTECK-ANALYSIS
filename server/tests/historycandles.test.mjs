import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';

/* /api/history/candles: validates input, sanitizes provider data, caches, labels source. */

let calls = 0;
const mkFeed = (rows) => ({
  symbols: { 'EUR/USD': 'frxEURUSD', 'R_100': 'R_100' },
  fetchCandles: async () => { calls++; return rows; }
});
const junk = [
  { time: 1700000000, open: '1.1', high: 1.2, low: 1.05, close: 1.15, volume: '5' },   /* string numerics OK */
  { time: 1700000060, open: NaN, high: 1.2, low: 1.05, close: 1.15 },                   /* NaN -> dropped */
  { time: -5, open: 1, high: 1, low: 1, close: 1 },                                     /* bad time -> dropped */
  { time: 1700000120, open: 1.1, high: 1.2, low: 1.05, close: 1.16, volume: 7 }
];
const pad = (n) => Array.from({ length: n }, (_, i) => ({ time: 1700000000 + i * 60, open: 1, high: 1.01, low: 0.99, close: 1.005 }));

let server, base, tmpDir;
before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aurum-hist-'));
  const store = createStore(join(tmpDir, 'store.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '', DAILY_BUDGET_USD: '5' }), { apiKey: '' });
  const app = createApp({ store, config, feed: mkFeed([...pad(120), ...junk]) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); tmpDir && rmSync(tmpDir, { recursive: true, force: true }); });
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('returns sanitized, source-labelled candles; string numerics normalized; junk dropped', async () => {
  const r = await post('/api/history/candles', { sym: 'eur/usd', granularity: 60, count: 200 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.source, 'deriv-public');
  assert.equal(j.instrument, 'EUR/USD');
  assert.equal(j.granularity, 60);
  assert.equal(j.candles.length, 122); /* 120 pad + 2 valid junk rows */
  assert.equal(typeof j.candles[0].open, 'number');
  assert.ok(j.candles.every((c) => Number.isFinite(c.close) && c.close > 0));
  assert.ok(j.fetched_at);
});

test('caches: identical request hits cache, provider called once', async () => {
  const before = calls;
  await post('/api/history/candles', { sym: 'EUR/USD', granularity: 60, count: 200 });
  assert.equal(calls, before); /* served from cache */
  const r2 = await post('/api/history/candles', { sym: 'R_100', granularity: 60, count: 200 });
  assert.equal(r2.status, 200);
  assert.equal(calls, before + 1);
});

test('rejects unknown symbol, bad granularity, clamps count', async () => {
  assert.equal((await post('/api/history/candles', { sym: 'NOPE/XYZ', granularity: 60 })).status, 400);
  assert.equal((await post('/api/history/candles', { sym: 'EUR/USD', granularity: 777 })).status, 400);
  const r = await post('/api/history/candles', { sym: 'EUR/USD', granularity: 60, count: 999999 });
  assert.equal(r.status, 200); /* clamped, not error */
  const j = await r.json();
  assert.ok(j.count <= 2000);
});

test('feed failure -> clean 502, no stack trace', async () => {
  const store = createStore(join(tmpDir, 's2.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '', DAILY_BUDGET_USD: '5' }), { apiKey: '' });
  const app2 = createApp({ store, config, feed: { symbols: { 'EUR/USD': 'frxEURUSD' }, fetchCandles: async () => { throw new Error('ws boom with secret pat_abc123'); } } });
  await new Promise((r) => { globalThis.__s2 = app2.listen(0, '127.0.0.1', r); });
  const r = await fetch(`http://127.0.0.1:${globalThis.__s2.address().port}/api/history/candles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sym: 'EUR/USD', granularity: 60 }) });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.error, 'feed_unavailable');
  assert.ok(!JSON.stringify(j).includes('pat_abc123'), 'no secret leakage');
  assert.ok(!JSON.stringify(j).includes('boom'));
  globalThis.__s2.close();
});
