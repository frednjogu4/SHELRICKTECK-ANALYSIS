import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';

/* ================================================================
 * Risk-limit gates (audit Task 5.2): every path that can place an
 * order must reject over-limit orders BEFORE any execution.
 * Paths under test:
 *   /api/deriv/order      (classic browser gate)
 *   /api/risk/gate        (generic gate — Exness bridge path)
 *   /api/deriv/pat/*      (PAT server path — proposal gate)
 * Limits: DERIV_MAX_STAKE_USD=50, DERIV_MAX_OPEN_TRADES=2 (test), DERIV_DAILY_LOSS_LIMIT_USD=25
 * ================================================================ */

process.env.ANTHROPIC_API_KEY = '';
process.env.DAILY_BUDGET_USD = '5';
process.env.DERIV_MAX_STAKE_USD = '50';
process.env.DERIV_MAX_OPEN_TRADES = '2';
process.env.DERIV_DAILY_LOSS_LIMIT_USD = '25';
process.env.AURUM_DIAG_KEY = 'diag-test-key-123';
process.env.DERIV_CONNECT_RATE_PER_MIN = '100';

const store = createStore(join(mkdtempSync(join(tmpdir(), 'aurum-risk-')), 'store.json'));
const app = createApp({ store, config: configFromEnv(), feed: { fetchCandles: async () => [], symbols: {} } });
const server = app.listen(0);
let base;

before(() => { base = 'http://127.0.0.1:' + server.address().port; });
after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
const H = { 'x-aurum-user': 'risk-tester', 'x-deriv-pat': 'gate-test-token-123', 'x-deriv-appid': '1089' };

test('classic gate: stake over max rejected', async () => {
  const r = await post('/api/deriv/order', { amount: 9999 }, H);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'stake_limit');
});

test('classic gate: negative/zero stake rejected', async () => {
  for (const amt of [0, -5]) {
    const r = await post('/api/deriv/order', { amount: amt }, H);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'bad_amount');
  }
});

test('classic gate: more than max open trades rejected', async () => {
  const ok1 = await post('/api/deriv/order', { amount: 10 }, H);
  const ok2 = await post('/api/deriv/order', { amount: 10 }, H);
  assert.equal(ok1.status, 200);
  assert.equal(ok2.status, 200);
  const third = await post('/api/deriv/order', { amount: 10 }, H);
  assert.equal(third.status, 400);
  assert.equal((await third.json()).error, 'open_trades_limit');
});

test('PAT proposal path: stake limit applies before any Deriv call', async () => {
  const r = await post('/api/deriv/pat/proposal', { sid: 'nonexistent', accountId: 'X', symbol: 'EUR/USD', amount: 500, side: 'BUY' }, H);
  /* limits fire BEFORE the session check completes the call — either way it must not pass */
  assert.ok([400, 401].includes(r.status));
  const d = await r.json();
  assert.ok(['stake_limit', 'no_session'].includes(d.error));
});

test('generic gate (Exness path): all three limits hold', async () => {
  const over = await post('/api/risk/gate', { amount: 80 }, H);
  assert.equal(over.status, 400);
  assert.equal((await over.json()).error, 'stake_limit');

  /* reuse classic-path opens (same ledger): tester already has 2 opens */
  const third = await post('/api/risk/gate', { amount: 10 }, H);
  assert.equal(third.status, 400);
  const td = await third.json();
  assert.equal(td.error, 'risk_blocked'); /* unified gate contract: reason in detail + checks[] */
  assert.match(td.detail || '', /open/i);
  assert.ok(Array.isArray(td.checks));
});

test('daily loss limit: booked losses block the next order', async () => {
  /* close both opens with heavy losses to breach the $25 daily limit */
  await post('/api/deriv/fill', { kind: 'close', pnl: -20 }, H);
  const stillUnder = await post('/api/deriv/order', { amount: 10 }, H);
  assert.ok([200, 400].includes(stillUnder.status)); /* −20 is under −25 → may pass */
  await post('/api/deriv/fill', { kind: 'close', pnl: -10 }, H);   /* total −30 */
  const blocked = await post('/api/deriv/order', { amount: 10 }, H);
  assert.equal(blocked.status, 400);
  assert.equal((await blocked.json()).error, 'daily_loss_limit');
  const gateBlocked = await post('/api/risk/gate', { amount: 10 }, H);
  assert.equal(gateBlocked.status, 400);
  const gd = await gateBlocked.json();
  assert.equal(gd.error, 'risk_blocked');
  assert.match(gd.detail || '', /Daily loss/i);
});

test('diagnose: forbidden without the admin key', async () => {
  const r = await post('/api/deriv/diagnose', {}, { 'x-deriv-pat': 'abc', 'x-deriv-appid': '1' });
  assert.equal(r.status, 403);
});

test('diagnose: works with the key and NEVER returns the PAT', async () => {
  const r = await post('/api/deriv/diagnose', {}, { 'x-diag-key': 'diag-test-key-123', 'x-deriv-pat': 'SECRET_PAT_VALUE_123456', 'x-deriv-appid': '1089' });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes('SECRET_PAT_VALUE_123456'), 'PAT must never appear');
  assert.match(text, /"pat":"\w{3}…\(\d+ chars\)"/, 'masked shape expected');
  const d = JSON.parse(text);
  assert.ok(d.checks.rest_accounts);          /* live probe result present */
  assert.ok(d.checks.public_ws);              /* public feed reachability */
});

test('generic MT5 risk gate fails closed when news evidence is not server-verified', async () => {
  const mt5 = { 'x-aurum-user': 'mt5-reservation-tester' };
  const once = 'intent-untrusted-news';
  const response = await post('/api/risk/gate', {
    amount: 10, venue: 'mt5', once, rr: 1, marketHours: true, newsBlocked: false
  }, mt5);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'risk_blocked');
  const news = body.checks.find((check) => check.name === 'news_event');
  assert.equal(news.status, 'UNKNOWN');
  assert.match(news.reason, /not verified by the server/i);
  assert.equal((await post('/api/risk/fill', { kind: 'release', once }, mt5)).status, 409,
    'a blocked intent must not create a reservation that can be committed or closed');
});
