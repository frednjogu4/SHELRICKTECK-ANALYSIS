import test from 'node:test';
import assert from 'node:assert/strict';
import * as cloud from '../src/cloud.js';

class MemoryStorage {
  data = new Map();
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
  clear() { this.data.clear(); }
}

function resetStorage() {
  globalThis.localStorage = new MemoryStorage();
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.fetch = async () => { throw new Error('unexpected fetch'); };
}
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('Cloud config normalizes a pasted REST URL and refuses secret keys', () => {
  resetStorage();
  const cfg = cloud.cloudSaveConfig('https://demo-project.supabase.co/rest/v1/', 'sb_publishable_public-test');
  assert.equal(cfg.url, 'https://demo-project.supabase.co');
  assert.throws(() => cloud.cloudSaveConfig('https://demo-project.supabase.co', 'sb_secret_do-not-use'), /SECRET/);
  assert.throws(() => cloud.cloudSaveConfig('http://demo-project.supabase.co', 'anon-test'), /https/);
});

test('sign-up sends the password only to Supabase Auth and saves only a tab session', async () => {
  resetStorage();
  cloud.cloudSaveConfig('https://demo-project.supabase.co', 'sb_publishable_test');
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return response({
      access_token: 'jwt-access-test', refresh_token: 'refresh-test', expires_in: 3600,
      user: { id: 'user-123', email: 'trader@example.com' }
    });
  };
  const result = await cloud.cloudSignUp('Trader@Example.com', 'test-password-123');
  assert.equal(result.signedIn, true);
  assert.match(request.url, /\/auth\/v1\/signup$/);
  assert.equal(request.options.headers.apikey, 'sb_publishable_test');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(JSON.parse(request.options.body).password, 'test-password-123');
  assert.equal(localStorage.getItem('aurum.supabase.key'), 'sb_publishable_test');
  assert.equal(JSON.stringify(sessionStorage.data).includes('test-password-123'), false);
  assert.equal(cloud.cloudAuthStatus().email, 'trader@example.com');
});

test('history insert requires a signed-in user and forces user_id from the session', async () => {
  resetStorage();
  cloud.cloudSaveConfig('https://demo-project.supabase.co', 'sb_publishable_test');
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    if (String(url).includes('/auth/v1/token?grant_type=password')) {
      return response({
        access_token: 'user-jwt', refresh_token: 'refresh', expires_in: 3600,
        user: { id: 'user-123', email: 'trader@example.com' }
      });
    }
    assert.match(String(url), /\/rest\/v1\/analysis_history$/);
    assert.equal(options.headers.Authorization, 'Bearer user-jwt');
    const row = JSON.parse(options.body);
    assert.equal(row.user_id, 'user-123');
    assert.equal(row.symbol, 'XAU/USD');
    return response({}, 201);
  };
  await cloud.cloudSignIn('trader@example.com', 'test-password-123');
  const written = await cloud.cloudInsert('analysis_history', { user_id: 'other-user', symbol: 'XAU/USD', kind: 'scan' });
  assert.deepEqual(written, { ok: true });
  assert.equal(calls, 2);
});

test('unsigned history writes fail closed without making a request', async () => {
  resetStorage();
  cloud.cloudSaveConfig('https://demo-project.supabase.co', 'sb_publishable_test');
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('should not fetch'); };
  const result = await cloud.cloudInsert('alerts', { title: 'test' });
  assert.deepEqual(result, { ok: false, error: 'not_signed_in' });
  assert.equal(called, false);
});

test('expired tab session refreshes before a protected request', async () => {
  resetStorage();
  cloud.cloudSaveConfig('https://demo-project.supabase.co', 'sb_publishable_test');
  sessionStorage.setItem('aurum.supabase.session', JSON.stringify({
    access_token: 'old-token', refresh_token: 'refresh-old', expires_at: Math.floor(Date.now() / 1000) - 1,
    user: { id: 'user-123', email: 'trader@example.com' }
  }));
  let protectedAuth = '';
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/auth/v1/token?grant_type=refresh_token')) {
      assert.equal(JSON.parse(options.body).refresh_token, 'refresh-old');
      return response({
        access_token: 'new-token', refresh_token: 'refresh-new', expires_in: 3600,
        user: { id: 'user-123', email: 'trader@example.com' }
      });
    }
    protectedAuth = options.headers.Authorization;
    return response({}, 201);
  };
  const result = await cloud.cloudInsert('alerts', { channel: 'test', title: 'title', body: 'body' });
  assert.equal(result.ok, true);
  assert.equal(protectedAuth, 'Bearer new-token');
  assert.equal(cloud.cloudAuthStatus().signedIn, true);
});

test('table verification uses the authenticated session for all required tables', async () => {
  resetStorage();
  cloud.cloudSaveConfig('https://demo-project.supabase.co', 'sb_publishable_test');
  sessionStorage.setItem('aurum.supabase.session', JSON.stringify({
    access_token: 'user-jwt', refresh_token: 'refresh', expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'user-123', email: 'trader@example.com' }
  }));
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push(String(url));
    assert.equal(options.headers.Authorization, 'Bearer user-jwt');
    return response([]);
  };
  const result = await cloud.cloudVerifyTables();
  assert.equal(result.ok, true);
  assert.equal(seen.length, 4);
});
