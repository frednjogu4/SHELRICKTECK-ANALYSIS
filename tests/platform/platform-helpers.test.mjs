/*
 * Unit tests for cloudflare/platform.js — generic HTTP helpers only.
 * No market, broker, account or signal data is involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpError, MAX_JSON_BODY_BYTES, WORKER_SECURITY_HEADERS, allowHeader, createBoundedCache,
  describeError, isAppShellPath, isJsonContentType, logEvent, readBodyText, readJsonObject, withoutBody
} from '../../cloudflare/platform.js';

const post = (body, headers = { 'content-type': 'application/json' }) =>
  new Request('https://worker.example/x', { method: 'POST', headers, body });

test('createBoundedCache never exceeds its limit and evicts the oldest entry first', () => {
  const cache = createBoundedCache(3);
  cache.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(cache.size, 3);
  cache.set('d', 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('a'), undefined, 'oldest entry evicted');
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('d'), 4);

  cache.set('b', 22); /* rewriting a key refreshes its position */
  cache.set('e', 5);
  assert.equal(cache.get('c'), undefined);
  assert.equal(cache.get('b'), 22);

  for (let i = 0; i < 10000; i++) cache.set('key-' + i, i);
  assert.equal(cache.size, 3, 'size stays bounded under high key cardinality');
});

test('createBoundedCache tolerates a nonsensical limit by keeping at least one entry', () => {
  for (const limit of [0, -5, NaN, undefined, 'abc']) {
    const cache = createBoundedCache(limit);
    cache.set('a', 1).set('b', 2);
    assert.equal(cache.size, 1);
    assert.equal(cache.get('b'), 2);
  }
});

test('isJsonContentType accepts JSON media types only', () => {
  for (const value of ['application/json', 'Application/JSON', 'application/json; charset=utf-8', ' application/json ', 'application/problem+json', 'application/vnd.api+json;v=1']) {
    assert.equal(isJsonContentType(value), true, value);
  }
  for (const value of ['', null, undefined, 'text/plain', 'text/json', 'application/jsonp', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/json-seq', 'json', 'application/+json']) {
    assert.equal(isJsonContentType(value), false, String(value));
  }
});

test('isAppShellPath admits plain app routes and rejects file-like, hidden and odd paths', () => {
  for (const path of ['/', '', '/app', '/app/', '/a/b', '/a/b/c/d', '/Some_Route-1']) {
    assert.equal(isAppShellPath(path), true, path);
  }
  for (const path of ['/sw.js', '/app.html', '/.env', '/.git/config', '/a/.hidden/b', '/a/b/c/d/e', '/a%20b', '/~x', '/a b', '/' + 'x'.repeat(65), '/a;b', '/a:b', '/..']) {
    assert.equal(isAppShellPath(path), false, path);
  }
});

test('allowHeader adds HEAD for GET routes and always adds OPTIONS', () => {
  assert.equal(allowHeader(['GET']), 'GET, HEAD, OPTIONS');
  assert.equal(allowHeader(['POST']), 'POST, OPTIONS');
  assert.equal(allowHeader(['GET', 'POST']), 'GET, POST, HEAD, OPTIONS');
});

test('withoutBody keeps status and headers and drops the body', async () => {
  const original = new Response('payload', { status: 418, headers: { 'x-test': '1' } });
  const stripped = withoutBody(original);
  assert.equal(stripped.status, 418);
  assert.equal(stripped.headers.get('x-test'), '1');
  assert.equal(await stripped.text(), '');
});

test('readBodyText returns small bodies and enforces the byte limit', async () => {
  assert.equal(await readBodyText(post('{"a":1}')), '{"a":1}');
  assert.equal(await readBodyText(new Request('https://worker.example/x', { method: 'POST' })), '');
  assert.equal(await readBodyText(post('x'.repeat(100)), 100), 'x'.repeat(100), 'exactly at the limit is allowed');
  await assert.rejects(readBodyText(post('x'.repeat(101)), 100), (e) => e instanceof HttpError && e.status === 413 && e.code === 'request_too_large');
  await assert.rejects(readBodyText(post('\u20ac'.repeat(40)), 100), (e) => e instanceof HttpError && e.status === 413, 'multi-byte characters are counted as bytes');
});

test('readBodyText strips a UTF-8 byte-order mark and rejects invalid UTF-8', async () => {
  assert.equal(await readBodyText(post(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))), '{}');
  await assert.rejects(readBodyText(post(new Uint8Array([0xc3, 0x28]))), (e) => e instanceof HttpError && e.status === 400 && e.code === 'invalid_json');
});

test('readJsonObject maps each failure to one precise HTTP error', async () => {
  assert.deepEqual(await readJsonObject(post('{"a":[1,2]}')), { a: [1, 2] });
  assert.deepEqual(await readJsonObject(post('')), {});
  assert.deepEqual(await readJsonObject(post('  \n ')), {});
  assert.deepEqual(await readJsonObject(new Request('https://worker.example/x', { method: 'POST' })), {}, 'no body and no content type is an empty object');

  const failure = async (request, status, code) => assert.rejects(readJsonObject(request), (e) => {
    assert.ok(e instanceof HttpError, 'HttpError expected');
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });
  await failure(post('{'), 400, 'invalid_json');
  await failure(post('null'), 400, 'invalid_body');
  await failure(post('[1]'), 400, 'invalid_body');
  await failure(post('"s"'), 400, 'invalid_body');
  await failure(post('7'), 400, 'invalid_body');
  await failure(post('{}', { 'content-type': 'text/plain' }), 415, 'unsupported_media_type');
  await failure(post(new Uint8Array([0x7b, 0x7d]), {}), 415, 'unsupported_media_type');
  await failure(post('x'.repeat(MAX_JSON_BODY_BYTES + 1)), 413, 'request_too_large');
});

test('readJsonObject error details never contain request content', async () => {
  try {
    await readJsonObject(post('{"secret":"BODY-SECRET-VALUE",'));
    assert.fail('expected a rejection');
  } catch (e) {
    assert.doesNotMatch(String(e.detail) + String(e.message), /BODY-SECRET-VALUE/);
  }
});

test('describeError yields a short description and survives non-Error values', () => {
  const long = new RangeError('m'.repeat(5000));
  const described = describeError(long);
  assert.equal(described.name, 'RangeError');
  assert.equal(described.message.length, 300);
  assert.ok(described.stack.length <= 600);
  assert.deepEqual(describeError('plain string'), { name: 'Error', message: 'plain string' });
  assert.deepEqual(describeError(null), { name: 'Error', message: '' });
  assert.deepEqual(describeError(undefined), { name: 'Error', message: '' });
});

test('logEvent writes one JSON line and routes errors to console.error', () => {
  const captured = [];
  const original = { error: console.error, warn: console.warn };
  console.error = (line) => captured.push(['error', line]);
  console.warn = (line) => captured.push(['warn', line]);
  try {
    logEvent('error', 'something_failed', { path: '/x', status: 500 });
    logEvent('warn', 'something_odd');
  } finally {
    console.error = original.error;
    console.warn = original.warn;
  }
  assert.deepEqual(captured.map(([channel]) => channel), ['error', 'warn']);
  assert.deepEqual(JSON.parse(captured[0][1]), { level: 'error', event: 'something_failed', path: '/x', status: 500 });
  assert.deepEqual(JSON.parse(captured[1][1]), { level: 'warn', event: 'something_odd' });
});

test('the Worker security header set is complete and forbids framing and content sniffing', () => {
  assert.equal(WORKER_SECURITY_HEADERS['x-content-type-options'], 'nosniff');
  assert.equal(WORKER_SECURITY_HEADERS['x-frame-options'], 'DENY');
  assert.match(WORKER_SECURITY_HEADERS['content-security-policy'], /default-src 'none'/);
  assert.match(WORKER_SECURITY_HEADERS['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(WORKER_SECURITY_HEADERS['strict-transport-security'], /max-age=\d{8,}/);
  assert.equal(WORKER_SECURITY_HEADERS['cross-origin-resource-policy'], 'same-origin');
  assert.ok(Object.isFrozen(WORKER_SECURITY_HEADERS));
});
