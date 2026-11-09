import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';

/* Security headers: every response must carry the hardening set
   (audit finding: the deployed app previously sent NONE of these). */

let server, base, tmpDir;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aurum-sec-'));
  const store = createStore(join(tmpDir, 'store.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '', DAILY_BUDGET_USD: '5' }), { apiKey: '' });
  const feed = { symbols: {}, fetchCandles: async () => { throw new Error('feed down'); } };
  const app = createApp({ store, config, feed });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server && server.close(); tmpDir && rmSync(tmpDir, { recursive: true, force: true }); });

test('hardening headers present on health (200 path)', async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('strict-transport-security') || '', /max-age=31536000/);
  assert.match(r.headers.get('content-security-policy-report-only') || '', /default-src/);
});

test('hardening headers present on error paths too (404/400)', async () => {
  const nf = await fetch(base + '/api/nope');
  assert.equal(nf.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(nf.headers.get('x-frame-options'), 'DENY');
  const bad = await fetch(base + '/api/backtest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('x-content-type-options'), 'nosniff');
});
