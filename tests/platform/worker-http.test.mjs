/*
 * Cloudflare Worker — HTTP / platform behaviour.
 *
 * Scope: the HTTP envelope only (status codes, headers, body limits, JSON
 * parsing, rate-limit wiring, cross-origin policy, asset fallback, logging).
 *
 * These tests never open a network connection and never fabricate market or
 * account data: both upstream providers are replaced by stubs that always
 * FAIL and count how often they were reached. No assertion looks at an
 * analysis result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';
import { MAX_JSON_BODY_BYTES, WORKER_SECURITY_HEADERS } from '../../cloudflare/platform.js';

const ORIGIN = 'https://aurum-staging.example';
const SHELL_HTML = '<!doctype html><title>app shell</title>';

function setup({ assets, signalLimiter, marketLimiter } = {}) {
  const calls = { provider: 0, assets: [], limiterKeys: [] };
  const logs = [];
  const worker = createReadOnlyWorker({
    requestImpl: async () => { calls.provider++; throw new Error('stub provider is offline'); },
    fetchImpl: async () => { calls.provider++; throw new Error('stub provider is offline'); },
    log: (level, event, fields = {}) => logs.push({ level, event, ...fields })
  });
  const allow = { limit: async ({ key }) => { calls.limiterKeys.push(key); return { success: true }; } };
  const env = {
    ASSETS: assets === undefined
      ? { fetch: async (request) => { calls.assets.push(new URL(request.url).pathname); return new Response(SHELL_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }); } }
      : assets,
    AURUM_SIGNAL_LIMITER: signalLimiter === undefined ? allow : signalLimiter,
    AURUM_MARKET_LIMITER: marketLimiter === undefined ? allow : marketLimiter
  };
  const send = (path, init = {}, overrideEnv = env) => worker.fetch(new Request(ORIGIN + path, init), overrideEnv);
  const postJson = (path, value, headers = {}) => send(path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof value === 'string' ? value : JSON.stringify(value)
  });
  return { worker, env, calls, logs, send, postJson };
}

function assertSecurityHeaders(response, label) {
  for (const [name, value] of Object.entries(WORKER_SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value, `${label}: ${name}`);
  }
  assert.equal(response.headers.get('cache-control'), 'no-store', `${label}: cache-control`);
  assert.equal(response.headers.get('access-control-allow-origin'), null, `${label}: must not grant cross-origin access`);
}

/* ---------------------------------------------------------------- success */

test('health answers 200 JSON with the read-only runtime marker and full security headers', async () => {
  const { send, calls } = setup();
  const res = await send('/api/health');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(res.headers.get('x-aurum-runtime'), 'cloudflare-readonly');
  assertSecurityHeaders(res, 'health');
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.runtime, 'cloudflare-readonly');
  assert.equal(data.execution, false);
  assert.equal(calls.provider, 0, 'health must not depend on any upstream provider');
  assert.equal(calls.limiterKeys.length, 0, 'health must stay available when rate limiting is saturated');
});

test('HEAD is answered like GET without a body; same-origin OPTIONS lists the allowed methods', async () => {
  const { send } = setup();
  const head = await send('/api/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assertSecurityHeaders(head, 'HEAD health');

  const options = await send('/api/health', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('allow'), 'GET, HEAD, OPTIONS');
  assertSecurityHeaders(options, 'OPTIONS health');

  const postRoute = await send('/api/signals/scan', { method: 'OPTIONS' });
  assert.equal(postRoute.status, 204);
  assert.equal(postRoute.headers.get('allow'), 'POST, OPTIONS');
});

/* ------------------------------------------------------- routing / methods */

test('a known route with the wrong method is 405 with an Allow header, not 501', async () => {
  const { send, calls } = setup();
  for (const [path, method, allow] of [
    ['/api/health', 'POST', 'GET, HEAD, OPTIONS'],
    ['/api/health', 'DELETE', 'GET, HEAD, OPTIONS'],
    ['/api/signals/scan', 'GET', 'POST, OPTIONS'],
    ['/api/signals/analyze', 'PUT', 'POST, OPTIONS'],
    ['/api/markets/deriv/candles', 'GET', 'POST, OPTIONS'],
    ['/api/history/candles', 'PATCH', 'POST, OPTIONS']
  ]) {
    const res = await send(path, { method });
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.equal(res.headers.get('allow'), allow, `${method} ${path} Allow`);
    assert.equal((await res.json()).error, 'method_not_allowed');
    assertSecurityHeaders(res, `${method} ${path}`);
  }
  const head = await send('/api/signals/scan', { method: 'HEAD' });
  assert.equal(head.status, 405);
  assert.equal(await head.text(), '');
  assert.equal(calls.provider, 0);
  assert.equal(calls.limiterKeys.length, 0, 'rejected methods must not consume rate-limit budget');
});

test('unknown API routes stay 501 JSON and never fall through to the HTML shell', async () => {
  const { send, calls } = setup();
  for (const path of ['/api', '/api/', '/api/nope', '/api/health/', '/api/news/feed', '/api/health%2f..', '/api/constructor', '/api/__proto__']) {
    const res = await send(path);
    assert.equal(res.status, 501, path);
    assert.match(res.headers.get('content-type'), /^application\/json/, path);
    assert.equal((await res.json()).error, 'cloudflare_route_not_migrated', path);
    assertSecurityHeaders(res, path);
  }
  assert.equal(calls.assets.length, 0, 'API paths must never be answered from static assets');
});

test('broker, account, order and risk namespaces are refused for every method before any other handling', async () => {
  const { send, calls } = setup();
  const paths = [
    '/api/deriv', '/api/deriv/', '/api/deriv/order', '/api/deriv/pat/session', '/api/deriv/pat/confirm', '/api/deriv/close',
    '/api/risk', '/api/risk/gate', '/api/ctl', '/api/ctl/killswitch', '/api/DERIV/order', '/api/Risk/Gate'
  ];
  for (const path of paths) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const init = { method };
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) { init.headers = { 'content-type': 'application/json' }; init.body = '{}'; }
      const res = await send(path, init);
      assert.equal(res.status, 403, `${method} ${path}`);
      if (method !== 'HEAD') assert.equal((await res.json()).error, 'broker_execution_routes_disabled', `${method} ${path}`);
      assertSecurityHeaders(res, `${method} ${path}`);
    }
  }
  assert.equal(calls.provider, 0, 'blocked namespaces must never reach a provider');
  assert.equal(calls.limiterKeys.length, 0);
  assert.equal(calls.assets.length, 0);
});

/* ------------------------------------------------------------ malformed input */

test('malformed JSON is a 400, and valid JSON that is not an object is a 400 instead of a crash', async () => {
  const { postJson, calls, logs } = setup();
  const routes = ['/api/signals/scan', '/api/signals/analyze', '/api/markets/deriv/candles', '/api/markets/deriv/tick', '/api/history/candles'];
  for (const path of routes) {
    const broken = await postJson(path, '{"symbols": [');
    assert.equal(broken.status, 400, `${path} broken JSON`);
    assert.equal((await broken.json()).error, 'invalid_json', `${path} broken JSON`);
    assertSecurityHeaders(broken, `${path} broken JSON`);

    for (const literal of ['null', '[]', '["a"]', '"text"', '42', 'true']) {
      const res = await postJson(path, literal);
      assert.equal(res.status, 400, `${path} body ${literal}`);
      assert.equal((await res.json()).error, 'invalid_body', `${path} body ${literal}`);
    }

    const empty = await postJson(path, '');
    assert.equal(empty.status, 400, `${path} empty body is rejected by route validation`);
    const emptyObject = await postJson(path, {});
    assert.equal(emptyObject.status, 400, `${path} {} is rejected by route validation`);
  }
  assert.equal(calls.provider, 0, 'rejected input must never reach a provider');
  assert.deepEqual(logs.filter((entry) => entry.event === 'unhandled_exception'), [], 'bad input must not be an unhandled exception');
});

test('the parser error text and the offending body are never echoed back', async () => {
  const { postJson } = setup();
  const res = await postJson('/api/signals/scan', '{"marker":"SENSITIVE-BODY-VALUE",');
  const text = await res.text();
  assert.equal(res.status, 400);
  assert.doesNotMatch(text, /SENSITIVE-BODY-VALUE/);
  assert.doesNotMatch(text, /Unexpected|position|JSON\.parse/i);
});

test('deeply nested and invalid-UTF-8 bodies are rejected cleanly', async () => {
  const { send, postJson, logs } = setup();
  const nested = await postJson('/api/signals/scan', '['.repeat(60000));
  assert.equal(nested.status, 400);

  const invalidUtf8 = await send('/api/signals/scan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])
  });
  assert.equal(invalidUtf8.status, 400);
  assert.equal((await invalidUtf8.json()).error, 'invalid_json');
  assert.deepEqual(logs.filter((entry) => entry.event === 'unhandled_exception'), []);
});

test('a request body must be declared as JSON: other media types are 415', async () => {
  const { send, calls } = setup();
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'text/json-ish']) {
    const res = await send('/api/signals/scan', { method: 'POST', headers: { 'content-type': contentType }, body: '{"symbols":["X"]}' });
    assert.equal(res.status, 415, contentType);
    assert.equal((await res.json()).error, 'unsupported_media_type', contentType);
    assertSecurityHeaders(res, contentType);
  }
  const untyped = await send('/api/signals/scan', { method: 'POST', body: new Uint8Array([0x7b, 0x7d]) });
  assert.equal(untyped.status, 415, 'a body without any Content-Type is refused');

  for (const contentType of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON', 'application/problem+json']) {
    const res = await send('/api/signals/scan', { method: 'POST', headers: { 'content-type': contentType }, body: '{}' });
    assert.equal(res.status, 400, `${contentType} is accepted as JSON and then fails route validation`);
  }
  assert.equal(calls.provider, 0);
});

/* ------------------------------------------------------------ oversized requests */

test('a body larger than the limit is 413 on every POST route', async () => {
  const { postJson, calls } = setup();
  const oversized = JSON.stringify({ padding: 'x'.repeat(MAX_JSON_BODY_BYTES) });
  for (const path of ['/api/signals/scan', '/api/signals/analyze', '/api/markets/deriv/candles', '/api/markets/deriv/tick', '/api/history/candles']) {
    const res = await postJson(path, oversized);
    assert.equal(res.status, 413, path);
    assert.equal((await res.json()).error, 'request_too_large', path);
    assertSecurityHeaders(res, path);
  }
  assert.equal(calls.provider, 0);
});

test('the limit counts bytes, not characters', async () => {
  const { postJson } = setup();
  /* 30,000 three-byte characters: under the limit as characters, over it as bytes. */
  const res = await postJson('/api/signals/scan', JSON.stringify({ padding: '\u20ac'.repeat(30000) }));
  assert.equal(res.status, 413);
});

test('a streamed body without Content-Length stops being read once it passes the limit', async () => {
  const { send, calls } = setup();
  const chunk = new Uint8Array(16384).fill(0x20);
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      if (pulled > 2000) { controller.close(); return; }
      controller.enqueue(chunk);
    },
    cancel() { cancelled = true; }
  });
  const res = await send('/api/signals/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' });
  assert.equal(res.status, 413);
  assert.ok(pulled <= 10, `read ${pulled} chunks (~${pulled * 16} KB) of an endless body; expected to stop just past the 64 KB limit`);
  assert.equal(cancelled, true, 'the upload stream is cancelled, not drained');
  assert.equal(calls.provider, 0);
});

test('a declared Content-Length over the limit is refused without reading the body, and a non-numeric one is a 400', async () => {
  const { worker, env, calls } = setup();
  let bodyRead = false;
  const fakeRequest = (contentLength) => ({
    url: ORIGIN + '/api/signals/scan',
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', 'content-length': contentLength }),
    get body() { bodyRead = true; return null; }
  });
  const tooLarge = await worker.fetch(fakeRequest(String(MAX_JSON_BODY_BYTES + 1)), env);
  assert.equal(tooLarge.status, 413);
  assert.equal(bodyRead, false, 'the body is not touched when the declared length already exceeds the limit');

  const notANumber = await worker.fetch(fakeRequest('12abc'), env);
  assert.equal(notANumber.status, 400);
  assert.equal((await notANumber.json()).error, 'invalid_content_length');
  assert.equal(calls.provider, 0);
});

/* ------------------------------------------------------------ missing configuration */

test('provider-backed routes fail closed with 503 when a rate-limit binding is missing or malformed', async () => {
  for (const broken of [null, {}, { limit: 'not a function' }]) {
    const { send, postJson, calls, logs } = setup({ signalLimiter: broken, marketLimiter: broken });
    const responses = [
      await postJson('/api/signals/scan', { symbols: ['X'] }),
      await postJson('/api/signals/analyze', { symbol: 'X' }),
      await send('/api/markets/deriv'),
      await postJson('/api/markets/deriv/candles', { code: 'X1' }),
      await postJson('/api/markets/deriv/tick', { code: 'X1' }),
      await postJson('/api/history/candles', { sym: 'X' })
    ];
    for (const res of responses) {
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'rate_limiter_not_configured');
      assertSecurityHeaders(res, 'missing limiter');
    }
    assert.equal(calls.provider, 0, 'an unmetered request must never reach a provider');
    assert.equal(logs.filter((entry) => entry.event === 'rate_limiter_not_configured').length, responses.length, 'the misconfiguration is logged, not swallowed');
  }
});

test('a missing bindings object or ASSETS binding is a 503, never a healthy-looking 200', async () => {
  const { worker, logs } = setup();
  for (const env of [undefined, null, {}]) {
    const page = await worker.fetch(new Request(ORIGIN + '/'), env);
    assert.equal(page.status, 503);
    assert.equal((await page.json()).error, 'assets_unavailable');
    assertSecurityHeaders(page, 'missing ASSETS');

    const api = await worker.fetch(new Request(ORIGIN + '/api/markets/deriv'), env);
    assert.equal(api.status, 503);

    const health = await worker.fetch(new Request(ORIGIN + '/api/health'), env);
    assert.equal(health.status, 200, 'health itself needs no binding');
  }
  assert.ok(logs.some((entry) => entry.event === 'assets_binding_missing'));
});

/* ------------------------------------------------------------ rate limiting */

test('a denied request is 429 with Retry-After and never reaches a provider', async () => {
  const deny = { limit: async () => ({ success: false }) };
  const { send, postJson, calls } = setup({ signalLimiter: deny, marketLimiter: deny });
  const responses = [
    await postJson('/api/signals/scan', { symbols: ['X'] }),
    await postJson('/api/signals/analyze', { symbol: 'X' }),
    await send('/api/markets/deriv'),
    await postJson('/api/markets/deriv/tick', { code: 'X1' }),
    await postJson('/api/history/candles', { sym: 'X' })
  ];
  for (const res of responses) {
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    assert.equal((await res.json()).error, 'rate_limited');
    assertSecurityHeaders(res, '429');
  }
  assert.equal(calls.provider, 0);
});

test('rate limiting is applied before the body is parsed, so malformed requests are metered too', async () => {
  const { postJson, calls } = setup();
  await postJson('/api/signals/scan', '{broken');
  await postJson('/api/markets/deriv/tick', 'null');
  assert.equal(calls.limiterKeys.length, 2);
});

test('the limiter key is scoped per route group and per client address', async () => {
  const { send, calls } = setup();
  const post = (path, ip) => send(path, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: '{}' });
  await post('/api/signals/scan', '203.0.113.7');
  await post('/api/signals/scan', '203.0.113.8');
  await post('/api/markets/deriv/tick', '203.0.113.7');
  assert.equal(new Set(calls.limiterKeys).size, 3, 'different clients and different route groups use different buckets');
  assert.ok(calls.limiterKeys[0].endsWith(':203.0.113.7'));
  assert.ok(calls.limiterKeys[1].endsWith(':203.0.113.8'));
});

test('a limiter that throws fails closed with 503 and is logged', async () => {
  const broken = { limit: async () => { throw new Error('limiter backend down'); } };
  const { postJson, calls, logs } = setup({ signalLimiter: broken });
  const res = await postJson('/api/signals/scan', { symbols: ['X'] });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'rate_limiter_unavailable');
  assert.ok(res.headers.get('retry-after'));
  assert.equal(calls.provider, 0);
  const logged = logs.find((entry) => entry.event === 'rate_limiter_unavailable');
  assert.ok(logged, 'the limiter failure is logged');
  assert.equal(logged.message, 'limiter backend down');
});

/* ------------------------------------------------------------ cross-origin requests */

test('requests carrying a foreign Origin are refused on every route and method', async () => {
  const { send, calls } = setup();
  const foreign = ['https://evil.example', 'http://aurum-staging.example', 'https://aurum-staging.example:8443', 'https://sub.aurum-staging.example', 'null'];
  for (const origin of foreign) {
    for (const [path, method] of [['/api/health', 'GET'], ['/api/health', 'OPTIONS'], ['/api/signals/scan', 'POST'], ['/api/signals/scan', 'OPTIONS'], ['/api/markets/deriv', 'GET'], ['/api/nope', 'GET'], ['/api/deriv/order', 'POST']]) {
      const init = { method, headers: { origin } };
      if (method === 'POST') { init.headers['content-type'] = 'application/json'; init.body = '{}'; }
      if (method === 'OPTIONS') { init.headers['access-control-request-method'] = 'POST'; init.headers['access-control-request-headers'] = 'content-type'; }
      const res = await send(path, init);
      assert.equal(res.status, 403, `${origin} ${method} ${path}`);
      for (const header of ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials']) {
        assert.equal(res.headers.get(header), null, `${origin} ${method} ${path} must not send ${header}`);
      }
    }
  }
  assert.equal(calls.provider, 0);
  assert.equal(calls.limiterKeys.length, 0);
});

test('the same origin is accepted and still receives no CORS grant', async () => {
  const { send } = setup();
  const res = await send('/api/health', { headers: { origin: ORIGIN } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
});

/* ------------------------------------------------------------ provider failures */

test('an upstream provider failure is a 502 JSON error, not a crash or a 500', async () => {
  const { send, postJson, calls, logs } = setup();
  const catalogue = await send('/api/markets/deriv');
  assert.equal(catalogue.status, 502);
  assert.match(catalogue.headers.get('content-type'), /^application\/json/);
  assertSecurityHeaders(catalogue, 'provider failure');
  const body = await catalogue.json();
  assert.equal(typeof body.error, 'string');
  assert.ok(String(body.detail || '').length <= 160);
  assert.doesNotMatch(JSON.stringify(body), /\bat \S+ \(|node:internal|\.js:\d+/, 'no stack trace in the response');

  const tick = await postJson('/api/markets/deriv/tick', { code: 'ABC_1' });
  assert.equal(tick.status, 502);
  assert.ok(calls.provider >= 2, 'the failing stub was reached');
  assert.deepEqual(logs.filter((entry) => entry.event === 'unhandled_exception'), []);
});

/* ------------------------------------------------------------ assets / SPA fallback */

test('plain app paths fall back to the shell; file-like, dot-file and odd paths are real 404s', async () => {
  const { send, calls } = setup();
  for (const path of ['/', '/app', '/app/', '/anything', '/a/b/c']) {
    const res = await send(path);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), SHELL_HTML, path);
  }
  assert.deepEqual([...new Set(calls.assets)], ['/'], 'the shell is always requested from the asset root');

  calls.assets.length = 0;
  for (const path of ['/missing.js', '/sw.js', '/manifest.webmanifest', '/icons/none.png', '/robots.txt', '/.env', '/.git/config', '/.well-known/security.txt', '/a/b/c/d/e', '/%2fetc%2fpasswd', '/a%20b', '/wp-login.php', '/app.html', '/~user']) {
    const res = await send(path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get('content-type'), /^text\/plain/, path);
    assert.doesNotMatch(await res.text(), /<html|<!doctype/i, path);
    assertSecurityHeaders(res, path);
  }
  assert.equal(calls.assets.length, 0, 'a miss never serves the shell for a file-like path');
});

test('conditional request headers reach the asset layer and a 304 is passed through', async () => {
  let seen;
  const assets = { fetch: async (request) => { seen = request; return new Response(null, { status: 304, headers: { etag: '"abc"' } }); } };
  const { send } = setup({ assets });
  const res = await send('/app', { headers: { 'if-none-match': '"abc"' } });
  assert.equal(res.status, 304);
  assert.equal(seen.headers.get('if-none-match'), '"abc"');
  assert.equal(new URL(seen.url).pathname, '/');
  assert.equal(seen.method, 'GET');
});

test('a partial (Range) answer from the asset layer is passed through, not reported as an outage', async () => {
  const assets = { fetch: async () => new Response('<!doc', { status: 206, headers: { 'content-type': 'text/html', 'content-range': 'bytes 0-4/100' } }) };
  const { send, logs } = setup({ assets });
  const res = await send('/app', { headers: { range: 'bytes=0-4' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 0-4/100');
  assert.equal(logs.length, 0);
});

test('non-GET requests outside /api are 405 and never touch the asset layer', async () => {
  const { send, calls } = setup();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await send('/app', { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET, HEAD', method);
    assertSecurityHeaders(res, method);
  }
  assert.equal(calls.assets.length, 0);
});

test('a deployment without the shell is reported as 503 and logged', async () => {
  const assets = { fetch: async () => new Response(null, { status: 404 }) };
  const { send, logs } = setup({ assets });
  const res = await send('/app');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'app_shell_unavailable');
  assertSecurityHeaders(res, 'shell missing');
  assert.ok(logs.some((entry) => entry.event === 'app_shell_unavailable' && entry.status === 404));
});

/* ------------------------------------------------------------ unexpected errors / logging */

test('an unexpected exception becomes a generic JSON 500 and is logged without request secrets', async () => {
  const assets = { fetch: async () => { throw new TypeError('internal detail that must stay server-side'); } };
  const { send, logs } = setup({ assets });
  const res = await send('/app?token=QUERY-SECRET-VALUE', {
    headers: { authorization: 'Bearer HEADER-SECRET-VALUE', cookie: 'session=COOKIE-SECRET-VALUE', 'x-ai-claude': 'AI-KEY-SECRET-VALUE' }
  });
  assert.equal(res.status, 500);
  assertSecurityHeaders(res, '500');
  const body = await res.json();
  assert.deepEqual(body, { error: 'internal_error', detail: 'Unexpected server error. Retry shortly.' });

  const entry = logs.find((item) => item.event === 'unhandled_exception');
  assert.ok(entry, 'the exception is logged, not swallowed');
  assert.equal(entry.level, 'error');
  assert.equal(entry.method, 'GET');
  assert.equal(entry.path, '/app');
  assert.equal(entry.name, 'TypeError');
  const serialized = JSON.stringify(logs);
  for (const secret of ['QUERY-SECRET-VALUE', 'HEADER-SECRET-VALUE', 'COOKIE-SECRET-VALUE', 'AI-KEY-SECRET-VALUE']) {
    assert.doesNotMatch(serialized, new RegExp(secret), `${secret} must not be logged`);
  }
});

test('an exception inside an API route is contained the same way', async () => {
  const { worker, logs } = setup();
  const explodingEnv = new Proxy({}, { get() { throw new Error('binding lookup exploded'); } });
  const res = await worker.fetch(new Request(ORIGIN + '/api/markets/deriv'), explodingEnv);
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal((await res.json()).error, 'internal_error');
  assert.ok(logs.some((entry) => entry.event === 'unhandled_exception' && entry.path === '/api/markets/deriv'));
});

test('request headers that carry client-side API keys are never reflected in a response', async () => {
  const { send, postJson } = setup();
  const secretHeaders = { 'x-ai-claude': 'AI-KEY-SECRET-VALUE', 'x-ai-openai': 'AI-KEY-SECRET-VALUE', 'x-ai-perplexity': 'AI-KEY-SECRET-VALUE' };
  const responses = [
    await send('/api/health', { headers: secretHeaders }),
    await postJson('/api/signals/analyze', {}, secretHeaders),
    await postJson('/api/news/expectations', {}, secretHeaders)
  ];
  for (const res of responses) {
    const dump = JSON.stringify([...res.headers]) + await res.text();
    assert.doesNotMatch(dump, /AI-KEY-SECRET-VALUE/);
  }
});
