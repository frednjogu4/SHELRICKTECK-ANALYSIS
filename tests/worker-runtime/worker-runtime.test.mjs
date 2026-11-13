/*
 * Worker + static assets inside the real Cloudflare runtime (workerd), started
 * locally with `wrangler dev` from the repository's own wrangler.jsonc.
 *
 * This is the only suite that exercises Cloudflare's asset layer: routing
 * between static files and the Worker, the SPA fallback, `_headers`, and the
 * rate-limit bindings. Nothing is deployed and no Cloudflare account is used.
 *
 * It never contacts an upstream data provider: every request to a
 * provider-backed route is one that is rejected before a provider is called
 * (wrong method, bad body, failed validation, rate limit).
 *
 * Requirements: Node 22+, `npm ci`, and a built dist/ (`npm run build`).
 * Run: npm run test:worker
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDist } from '../../scripts/verify-dist.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const STARTUP_TIMEOUT_MS = 90000;

let child = null;
let base = '';
let stateDir = '';
let output = '';

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function stopChild() {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    /* ESRCH: the process group already exited — nothing left to stop. */
    if (error.code !== 'ESRCH') throw error;
  }
}

const get = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
const postJson = (path, value, headers = {}) => get(path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: typeof value === 'string' ? value : JSON.stringify(value)
});

const ASSET_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000',
  'x-robots-tag': 'noindex, nofollow'
};
function assertAssetHeaders(res, label) {
  for (const [name, value] of Object.entries(ASSET_HEADERS)) assert.equal(res.headers.get(name), value, `${label}: ${name}`);
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, `${label}: CSP frame-ancestors`);
  assert.match(res.headers.get('permissions-policy') || '', /camera=\(\)/, `${label}: Permissions-Policy`);
}
function assertWorkerHeaders(res, label) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${label}: nosniff`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY', `${label}: X-Frame-Options`);
  assert.equal(res.headers.get('cache-control'), 'no-store', `${label}: cache-control`);
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/, `${label}: CSP`);
  assert.equal(res.headers.get('access-control-allow-origin'), null, `${label}: no CORS grant`);
}

before(async () => {
  const dist = verifyDist(join(root, 'dist'));
  assert.ok(dist.ok, 'dist/ is not a complete build — run "npm run build" first:\n  ' + dist.problems.join('\n  '));

  const port = await freePort();
  const inspectorPort = await freePort();
  stateDir = mkdtempSync(join(tmpdir(), 'aurum-wrangler-'));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    wranglerBin, 'dev', '--config', 'wrangler.jsonc',
    '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspectorPort),
    '--persist-to', stateDir, '--show-interactive-dev-session=false'
  ], {
    cwd: root,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited with code ${child.exitCode} before it was ready:\n${output}`);
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) break;
    } catch (_) {
      /* Not listening yet; keep polling until the deadline below. */
    }
    if (Date.now() > deadline) { stopChild(); throw new Error(`wrangler dev was not ready after ${STARTUP_TIMEOUT_MS} ms:\n${output}`); }
    await new Promise((r) => setTimeout(r, 400));
  }
});

after(() => {
  stopChild();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

test('the app shell is served at / with the static security headers', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assertAssetHeaders(res, '/');
  const html = await res.text();
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.doesNotMatch(html, /src="\/src\/main\.js"/, 'the built page is served, not the dev source page');
  assert.equal(html, readFileSync(join(root, 'dist', 'index.html'), 'utf8'));
});

test('/index.html redirects to the canonical / instead of duplicating the page', async () => {
  const res = await get('/index.html');
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), '/');
});

test('static files are served with their own content types and the security headers', async () => {
  for (const [path, type] of [
    ['/sw.js', /javascript/],
    ['/manifest.webmanifest', /application\/manifest\+json/],
    ['/icons/icon-192.png', /^image\/png/],
    ['/icons/favicon-32.png', /^image\/png/]
  ]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), type, path);
    assertAssetHeaders(res, path);
    await res.arrayBuffer();
  }
});

test('the _headers configuration file is not published', async () => {
  const res = await get('/_headers');
  const body = await res.text();
  assert.doesNotMatch(body, /Strict-Transport-Security:|Permissions-Policy:/, '_headers content must not be downloadable');
});

test('/app (the PWA start URL) and other plain paths get the shell through the Worker fallback', async () => {
  const shell = await get('/');
  const expected = await shell.text();
  for (const path of ['/app', '/app/', '/some/deep/link']) {
    for (const headers of [{}, { 'sec-fetch-mode': 'navigate', accept: 'text/html' }]) {
      const res = await get(path, { headers });
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), /^text\/html/, path);
      assertAssetHeaders(res, path);
      assert.equal(await res.text(), expected, path);
    }
  }
  const conditional = await get('/app', { headers: { 'if-none-match': shell.headers.get('etag') } });
  assert.equal(conditional.status, 304, 'conditional requests for the shell are honoured');
  await conditional.arrayBuffer();
});

test('paths that match no file are real 404s, not the HTML shell with status 200', async () => {
  for (const path of ['/missing.js', '/does-not-exist.css', '/robots.txt', '/.env', '/.git/config', '/icons/nope.png', '/wp-login.php', '/sw.js.map']) {
    for (const headers of [{}, { 'sec-fetch-mode': 'navigate', accept: 'text/html' }]) {
      const res = await get(path, { headers });
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get('content-type'), /^text\/plain/, path);
      assert.doesNotMatch(await res.text(), /<html|<!doctype/i, path);
      assertWorkerHeaders(res, path);
    }
  }
});

test('non-GET requests to pages and files are 405', async () => {
  for (const path of ['/', '/app', '/sw.js', '/missing.js']) {
    const res = await get(path, { method: 'POST', body: 'x' });
    assert.equal(res.status, 405, path);
    await res.arrayBuffer();
  }
});

test('/api and everything under it is answered by the Worker as JSON, also for browser navigations', async () => {
  for (const headers of [{}, { 'sec-fetch-mode': 'navigate', accept: 'text/html' }]) {
    const health = await get('/api/health', { headers });
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-type'), /^application\/json/);
    assert.equal(health.headers.get('x-aurum-runtime'), 'cloudflare-readonly');
    assertWorkerHeaders(health, '/api/health');
    const data = await health.json();
    assert.equal(data.runtime, 'cloudflare-readonly');
    assert.equal(data.execution, false);

    for (const path of ['/api', '/api/', '/api/not-a-route', '/api/health.json']) {
      const res = await get(path, { headers });
      assert.equal(res.status, 501, path);
      assert.match(res.headers.get('content-type'), /^application\/json/, path);
      assert.equal((await res.json()).error, 'cloudflare_route_not_migrated', path);
    }
  }
});

test('HEAD, OPTIONS and wrong methods on API routes', async () => {
  const head = await get('/api/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const options = await get('/api/health', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('allow'), 'GET, HEAD, OPTIONS');

  const wrong = await get('/api/health', { method: 'DELETE' });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET, HEAD, OPTIONS');
  assert.equal((await wrong.json()).error, 'method_not_allowed');

  const getOnPost = await get('/api/history/candles');
  assert.equal(getOnPost.status, 405);
  assert.equal(getOnPost.headers.get('allow'), 'POST, OPTIONS');
  await getOnPost.arrayBuffer();
});

test('broker, account, order and risk namespaces stay disabled', async () => {
  for (const [path, method] of [
    ['/api/deriv/order', 'POST'], ['/api/deriv/pat/session', 'POST'], ['/api/deriv/health', 'GET'], ['/api/deriv', 'GET'],
    ['/api/risk/gate', 'POST'], ['/api/ctl/killswitch', 'GET'], ['/api/ctl/killswitch', 'POST'], ['/api/DERIV/order', 'PUT']
  ]) {
    const init = method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: '{}' };
    const res = await get(path, init);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).error, 'broker_execution_routes_disabled', `${method} ${path}`);
    assertWorkerHeaders(res, `${method} ${path}`);
  }
});

test('cross-origin API requests and preflights are refused without any CORS grant', async () => {
  for (const [path, init] of [
    ['/api/health', { headers: { origin: 'https://evil.example' } }],
    ['/api/health', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }],
    ['/api/history/candles', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }],
    ['/api/health', { headers: { origin: 'null' } }]
  ]) {
    const res = await get(path, init);
    assert.equal(res.status, 403, path);
    for (const header of ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials']) {
      assert.equal(res.headers.get(header), null, `${path} ${header}`);
    }
    await res.arrayBuffer();
  }
  const sameOrigin = await get('/api/health', { headers: { origin: base } });
  assert.equal(sameOrigin.status, 200);
  await sameOrigin.arrayBuffer();
});

test('malformed, mistyped and oversized request bodies are rejected with precise status codes', async () => {
  const path = '/api/history/candles';
  const cases = [
    [await postJson(path, '{"sym":'), 400, 'invalid_json'],
    [await postJson(path, 'null'), 400, 'invalid_body'],
    [await postJson(path, '[]'), 400, 'invalid_body'],
    [await postJson(path, {}), 400, 'unknown_symbol'],
    [await get(path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), 415, 'unsupported_media_type'],
    [await postJson(path, JSON.stringify({ padding: 'x'.repeat(200000) })), 413, 'request_too_large']
  ];
  for (const [res, status, code] of cases) {
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).error, code);
    assertWorkerHeaders(res, code);
  }
});

test('a streamed upload without Content-Length is cut off at the limit', async () => {
  const chunk = new Uint8Array(32768).fill(0x20);
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= 64) { controller.close(); return; } /* at most 2 MiB */
      sent++;
      controller.enqueue(chunk);
    }
  });
  /* The runtime may reset the connection once the Worker has answered and
     stopped reading. The client then sees a network error in place of the
     413, or the 413 and then a network error in place of its body. Each of
     the three outcomes proves the upload was refused. */
  const reset = (error) => assert.match(String(error && (error.cause && error.cause.code || error.message)), /ECONNRESET|EPIPE|UND_ERR|fetch failed|terminated/i);
  let res;
  try {
    res = await get('/api/history/candles', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' });
  } catch (error) {
    reset(error);
    return;
  }
  assert.equal(res.status, 413);
  let answer;
  try {
    answer = await res.json();
  } catch (error) {
    /* A body that arrived whole and is not JSON is a SyntaxError and fails here. */
    reset(error);
    return;
  }
  assert.equal(answer.error, 'request_too_large');
});

/* Keep this test last: it deliberately exhausts the signal rate limit. */
test('the Cloudflare rate-limit binding answers 429 with Retry-After once the budget is used', async () => {
  let limited = null;
  let accepted = 0;
  for (let i = 0; i < 40 && !limited; i++) {
    const res = await postJson('/api/signals/scan', {});
    if (res.status === 429) { limited = res; break; }
    assert.equal(res.status, 400, 'an empty scan request is refused by validation before any provider is used');
    await res.arrayBuffer();
    accepted++;
  }
  assert.ok(limited, `no 429 after ${accepted} requests against a limit of 8 per minute`);
  assert.ok(accepted >= 1, 'at least one request is admitted before the limit applies');
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await limited.json()).error, 'rate_limited');
  assertWorkerHeaders(limited, '429');

  const health = await get('/api/health');
  assert.equal(health.status, 200, 'health is not rate limited and stays available');
  await health.arrayBuffer();
});
