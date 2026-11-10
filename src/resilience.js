/* ================================================================
 * AURUM — generic app-shell resilience helpers.
 *
 * Nothing in this module knows about markets, brokers, accounts or
 * orders. It only covers platform concerns of the page itself:
 *   - telling the user when the DEVICE has no network connection
 *   - reporting (instead of hiding) a failed service-worker registration
 *   - keeping client-held AI keys out of requests to a host that never
 *     uses them
 * ================================================================ */

/**
 * Remove the per-device AI key headers (x-ai-claude, x-ai-openai,
 * x-ai-perplexity, ...) from a header object, in place.
 *
 * The Cloudflare read-only Worker is technical-only: it has no AI engine and
 * never reads these headers, so sending them would only expose the keys to a
 * server (and to any request logging in front of it) for no benefit.
 */
export function removeAiKeyHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  for (const name of Object.keys(headers)) {
    if (/^x-ai-/i.test(name)) delete headers[name];
  }
  return headers;
}

/**
 * Tell the user when the browser reports that the device went offline or
 * came back. This reflects `navigator.onLine` only — it says nothing about a
 * data feed or a broker connection, and the wording must stay that way.
 */
export function initConnectivityNotices({ toast, win = typeof window !== 'undefined' ? window : undefined } = {}) {
  if (!win || typeof win.addEventListener !== 'function' || typeof toast !== 'function') return false;
  const offline = () => toast(
    'You are offline',
    'This device reports no network connection. Live data and analysis requests will fail until it returns.',
    'warn'
  );
  const online = () => toast(
    'Network connection restored',
    'This device is online again. Live data resumes once the feed reconnects.',
    'ok'
  );
  win.addEventListener('offline', offline);
  win.addEventListener('online', online);
  /* Started without a connection (for example the installed app opened from
     its cached shell): say so once instead of failing silently. */
  if (win.navigator && win.navigator.onLine === false) offline();
  return true;
}

/**
 * Register the service worker and report a failure on the console instead of
 * swallowing it. The app keeps working without the offline shell, so this is
 * a warning, not an error.
 */
export function registerServiceWorker({
  nav = typeof navigator !== 'undefined' ? navigator : undefined,
  loc = typeof location !== 'undefined' ? location : undefined,
  url = '/sw.js',
  warn = (...args) => console.warn(...args)
} = {}) {
  if (!nav || !('serviceWorker' in nav) || !loc || !/^https?:$/.test(String(loc.protocol))) return null;
  return nav.serviceWorker.register(url).catch((error) => {
    warn('[aurum] Service worker registration failed; the offline shell and app install are unavailable.', (error && error.message) || error);
    return null;
  });
}
