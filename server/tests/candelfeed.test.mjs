import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCandleFetcher, ttlFor } from '../lib/derivfeed.js';

/* ================================================================
 * Candle data layer (fixes: Markets scan fired ~70 simultaneous
 * sockets → Deriv throttled → "No data" badges + phantom WAITs).
 * Verifies: in-flight dedup, TTL cache reuse, concurrency cap,
 * failure NOT cached (retry next call).
 * ================================================================ */

const mkCandles = (n, sym) => Array.from({ length: n }, (_, i) => ({ epoch: 1700000000 + i, open: 1, high: 1.1, low: 0.9, close: 1.05, close_times: 1 }));

test('ttlFor: freshness matches the candle period', () => {
  assert.equal(ttlFor(60), 20000);
  assert.equal(ttlFor(300), 60000);
  assert.equal(ttlFor(3600), 300000);
});

test('in-flight dedup: concurrent identical requests share ONE underlying fetch', async () => {
  let calls = 0;
  const f = createCandleFetcher({
    requestImpl: async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return mkCandles(5); }
  });
  const [a, b, c] = await Promise.all([f.fetchCandles('EUR/USD', 300), f.fetchCandles('EUR/USD', 300), f.fetchCandles('EUR/USD', 300)]);
  assert.equal(calls, 1);
  assert.equal(a.length, 5);
  assert.equal(b, a); /* same shared result object */
  assert.equal(c, a);
});

test('cache: a fresh result is reused within TTL; distinct keys fetch separately', async () => {
  let calls = 0;
  const f = createCandleFetcher({ requestImpl: async () => { calls++; return mkCandles(4); } });
  await f.fetchCandles('EUR/USD', 300);
  await f.fetchCandles('EUR/USD', 300);      /* TTL hit — no call */
  await f.fetchCandles('GBP/USD', 300);      /* different key — fetches */
  await f.fetchCandles('EUR/USD', 3600);     /* different granularity — fetches */
  assert.equal(calls, 3);
});

test('TTL expiry refetches (short test TTL)', async () => {
  let calls = 0;
  const f = createCandleFetcher({ requestImpl: async () => { calls++; return mkCandles(4); }, ttlOverrideMs: 25 });
  await f.fetchCandles('EUR/USD', 300);
  await new Promise((r) => setTimeout(r, 45));
  await f.fetchCandles('EUR/USD', 300);
  assert.equal(calls, 2);
});

test('concurrency cap: never more than maxActive underlying requests at once', async () => {
  let active = 0, peak = 0;
  const f = createCandleFetcher({
    maxActive: 2,
    requestImpl: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active--; return mkCandles(3); }
  });
  const syms = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'BTC/USD'];
  const res = await Promise.all(syms.map((s) => f.fetchCandles(s, 60)));
  assert.equal(res.length, 6);
  assert.ok(peak <= 2, 'peak ' + peak + ' exceeded the cap');
});

test('transient failure: retried inside the call, then the success is cached', async () => {
  let calls = 0;
  const f = createCandleFetcher({
    requestImpl: async () => { calls++; if (calls === 1) throw new Error('empty candles'); return mkCandles(4); },
    ttlOverrideMs: 60000
  });
  const ok = await f.fetchCandles('EUR/USD', 300);
  assert.equal(ok.length, 4);
  assert.equal(calls, 2, 'one internal retry');
  await f.fetchCandles('EUR/USD', 300);
  assert.equal(calls, 2, 'success cached within TTL');
});

test('persistent failure: rejects and is NOT cached (each call retries)', async () => {
  let calls = 0;
  const f = createCandleFetcher({
    requestImpl: async () => { calls++; throw new Error('empty candles'); },
    ttlOverrideMs: 60000
  });
  await assert.rejects(() => f.fetchCandles('EUR/USD', 300));
  const afterFirst = calls;
  await assert.rejects(() => f.fetchCandles('EUR/USD', 300));
  assert.ok(calls > afterFirst, 'a failed fetch must not be cached');
});
