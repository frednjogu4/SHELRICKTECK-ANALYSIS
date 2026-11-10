/*
 * AURUM Cloudflare Worker — generic HTTP / platform helpers.
 *
 * This module is deliberately free of market-data, broker, account, order and
 * signal logic. It only knows about HTTP: response headers, request-body
 * limits, safe JSON parsing, method handling, bounded caches and safe logging.
 * Keeping it separate lets the platform behaviour be unit-tested without
 * touching (or faking) any trading-domain data.
 */

/** Largest JSON request body the API accepts, in bytes (not characters). */
export const MAX_JSON_BODY_BYTES = 65536;

/**
 * Security headers attached to every response the Worker itself generates
 * (JSON API answers and plain-text errors). Static assets get the equivalent
 * set from `public/_headers`, which the Cloudflare asset layer applies.
 * These responses are never documents, so the CSP forbids everything.
 */
export const WORKER_SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
});

/** An error that maps directly to an HTTP response. `code` is a stable, non-sensitive identifier. */
export class HttpError extends Error {
  constructor(status, code, detail = '', headers = {}) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}

/** True for `application/json` and `application/<anything>+json`, ignoring parameters and case. */
export function isJsonContentType(value) {
  const mediaType = String(value || '').split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json' || /^application\/[a-z0-9.!#$&^_-]+\+json$/.test(mediaType);
}

/**
 * Read a request body as text while enforcing a hard byte limit.
 * The declared Content-Length is checked first so oversized uploads are
 * refused without reading them; the stream is then counted chunk by chunk so
 * a missing or dishonest Content-Length cannot make the Worker buffer more
 * than `maxBytes`.
 */
export async function readBodyText(request, maxBytes = MAX_JSON_BODY_BYTES) {
  const declared = request.headers.get('content-length');
  if (declared !== null && declared.trim() !== '') {
    if (!/^\d+$/.test(declared.trim())) throw new HttpError(400, 'invalid_content_length', 'Content-Length must be a non-negative integer.');
    if (Number(declared) > maxBytes) throw new HttpError(413, 'request_too_large', 'The request body exceeds ' + maxBytes + ' bytes.');
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      /* Stop reading. A cancel failure only means the stream is already gone,
         which is the state we want, so it is not an error worth surfacing. */
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'request_too_large', 'The request body exceeds ' + maxBytes + ' bytes.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_) {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid UTF-8.');
  }
}

/**
 * Parse a JSON request body that must be a plain object.
 *  - 415 when a body is sent without a JSON content type
 *  - 413 when it is larger than `maxBytes`
 *  - 400 when it is not valid JSON, or valid JSON that is not an object
 * An empty body yields `{}` so route-level validation can report what is missing.
 */
export async function readJsonObject(request, maxBytes = MAX_JSON_BODY_BYTES) {
  const contentType = request.headers.get('content-type');
  if (contentType && !isJsonContentType(contentType)) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the request body as application/json.');
  }
  const text = await readBodyText(request, maxBytes);
  if (!text.trim()) return {};
  if (!contentType) throw new HttpError(415, 'unsupported_media_type', 'Send the request body as application/json.');
  let value;
  try {
    value = JSON.parse(text);
  } catch (_) {
    /* The parser message can echo request content, so it is not forwarded. */
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_body', 'The JSON request body must be an object.');
  }
  return value;
}

/**
 * A Map-like cache that never holds more than `maxEntries` items; the oldest
 * insertion is evicted first. Only `get` and `set` are provided on purpose.
 */
export function createBoundedCache(maxEntries) {
  const limit = Math.max(1, Math.floor(Number(maxEntries)) || 1);
  const entries = new Map();
  return {
    get(key) { return entries.get(key); },
    set(key, value) {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return this;
    },
    get size() { return entries.size; }
  };
}

/** Value for an `Allow` header: the route's methods plus the ones the Worker answers itself. */
export function allowHeader(methods) {
  const list = [...methods];
  if (list.includes('GET') && !list.includes('HEAD')) list.push('HEAD');
  if (!list.includes('OPTIONS')) list.push('OPTIONS');
  return list.join(', ');
}

/** Same status and headers, no body — used to answer HEAD. */
export function withoutBody(response) {
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Decide whether a path that matched no static file may fall back to the app
 * shell. Only plain, extension-less paths such as `/app` qualify; anything
 * that looks like a file (`/missing.js`), a dot-file (`/.env`, `/.git/config`)
 * or an encoded/odd path gets a real 404 instead of a 200 HTML page.
 */
export function isAppShellPath(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean);
  if (segments.length > 4) return false;
  return segments.every((segment) => /^[A-Za-z0-9_-]{1,64}$/.test(segment));
}

/**
 * Structured, deliberately small log line. Callers pass only non-sensitive
 * fields (event name, method, path, status, error name/message). Request
 * headers, query strings and bodies are never logged.
 */
export function logEvent(level, event, fields = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else console.warn(line);
}

/** Reduce an unknown thrown value to a short, non-sensitive description for logs. */
export function describeError(error) {
  const name = String((error && error.name) || 'Error').slice(0, 60);
  const message = String((error && error.message) || error || '').slice(0, 300);
  const stack = error && typeof error.stack === 'string'
    ? error.stack.split('\n').slice(1, 4).map((line) => line.trim()).join(' | ').slice(0, 600)
    : undefined;
  return stack ? { name, message, stack } : { name, message };
}
