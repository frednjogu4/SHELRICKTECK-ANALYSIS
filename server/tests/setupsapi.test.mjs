import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';
import { DEFAULT_SETUP_CONFIG } from '../lib/setups.js';

/* Setups endpoints: OFF by default (503 setups_disabled); when enabled they
 * serve analysis-only evaluations from the injected feed. No order paths. */

const c = (t, o, h, l, cl, v = 50) => ({ time: Math.round(t / 1000), open: o, high: h, low: l, close: cl, volume: v });
function candles(n = 400) {
  const out = []; let px = 1.1; let t = 1700000000000;
  for (let i = 0; i < n; i++) {
    const drift = Math.floor(i / 150) % 2 === 0 ? 0.0006 : -0.0005;
    const o = px; const cl = px + drift;
    out.push(c(t, o, Math.max(o, cl) + 0.0004, Math.min(o, cl) - 0.0004, cl)); px = cl; t += 300000;
  }
  return out;
}

let offServer, offBase, onServer, onBase, tmpDir, stubFeed;
before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aurum-setups-'));
  stubFeed = { symbols: {}, fetchCandles: async (sym, gran, bars) => candles(bars) };
  const mk = (env) => {
    const store = createStore(join(tmpDir, 'store-' + Math.random().toString(36).slice(2) + '.json'));
    const config = Object.assign(configFromEnv(env), { apiKey: '' });
    const app = createApp({ store, config, feed: stubFeed });
    return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  };
  offServer = await mk({ AURUM_SETUPS_ENABLED: '' });
  offBase = `http://127.0.0.1:${offServer.address().port}`;
  onServer = await mk({ AURUM_SETUPS_ENABLED: 'true' });
  onBase = `http://127.0.0.1:${onServer.address().port}`;
});
after(() => { offServer && offServer.close(); onServer && onServer.close(); tmpDir && rmSync(tmpDir, { recursive: true, force: true }); });

test('flag default OFF: both setups endpoints return 503 setups_disabled', async () => {
  for (const ep of ['/api/setups/analyze', '/api/setups/backtest']) {
    const r = await fetch(offBase + ep, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'EURUSD' }) });
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.error, 'setups_disabled');
    assert.ok(j.hint.includes('AURUM_SETUPS_ENABLED'));
  }
});

test('enabled: analyze returns all four setups with the analysis-only contract', async () => {
  const r = await fetch(onBase + '/api/setups/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'EURUSD' }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.analysis_only, true);
  assert.deepEqual(j.results.map((x) => x.setup), ['EMA_TREND_PULLBACK', 'VWAP_MEAN_REVERSION', 'OPENING_RANGE_BREAKOUT', 'RSI_MEAN_REVERSION']);
  for (const s of j.results) assert.ok('reasonIfSkipped' in s && 'conditions' in s);
});

test('enabled: backtest returns OOS metrics + NOT-conclusive note; synthetic category honored', async () => {
  const r = await fetch(onBase + '/api/setups/backtest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'EURUSD', scoring: 'r' }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.analysis_only, true);
  assert.ok(j.perSetup && j.note.includes('NOT conclusive'));

  const r2 = await fetch(onBase + '/api/setups/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'VOL 100' }) });
  const j2 = await r2.json();
  assert.equal(j2.category, 'synthetics'); // from the instrument universe, ORB honest N/A
  const orb = j2.results.find((x) => x.setup === 'OPENING_RANGE_BREAKOUT');
  assert.equal(orb.reasonIfSkipped, 'no_defined_session');
});

test('bad symbol still 400 when enabled; flag parsing is strict (not-truthy strings stay off)', async () => {
  const r = await fetch(onBase + '/api/setups/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: '!!' }) });
  assert.equal(r.status, 400);
  const cfg = configFromEnv({ AURUM_SETUPS_ENABLED: '1' }); // only the literal string 'true' enables
  assert.equal(cfg.setupsEnabled, false);
  assert.equal(configFromEnv({ AURUM_SETUPS_ENABLED: 'true' }).setupsEnabled, true);
});
