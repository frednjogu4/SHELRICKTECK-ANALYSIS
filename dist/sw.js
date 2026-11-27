/* AURUM service worker — installable local app shell.
 *
 * Cache lifecycle (release-keyed):
 *  - VERSION is rewritten by scripts/postbuild.mjs to 'aurum-local-<build id>'
 *    on every build, so each UI release installs under its own cache name and
 *    activate() deletes every cache of older releases (prefix rule below).
 *  - Install precaches SHELL using { cache: 'no-cache' } requests so an older
 *    HTTP-cached page cannot poison a newly stamped release cache, and only
 *    calls skipWaiting() once all shell entries succeeded.
 *  - Navigations are fetched with cache:'no-store': the HTTP cache can never
 *    hand the app an outdated shell while online (this was the root cause of
 *    "layout changes not appearing locally" — see bridge /app no-cache headers).
 *  - The shell cache exists for OFFLINE use only; it is refreshed on every
 *    successful online navigation.
 *  - /api/*, bridge commands, /build.json, /update-check and cross-origin
 *    requests are NEVER cached: live API responses, WebSocket data and
 *    authentication traffic must not be stored. Browser storage (localStorage,
 *    sessionStorage, IndexedDB) is never cleared.
 */
const VERSION = 'aurum-local-b525766fb06df';
const VERSION_PREFIX = 'aurum-local-';
const SHELL = ['/app', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) =>
        fetch(u, { cache: 'no-cache' }).then((r) => {
          if (!r || !r.ok) throw new Error('precache failed: ' + u);
          return c.put(u, r);
        })
      )))
      .then(() => self.skipWaiting())
      .catch((err) => caches.delete(VERSION).then(() => Promise.reject(err)))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith(VERSION_PREFIX) && k !== VERSION)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  const data = e && e.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'AURUM_SW_VERSION' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ version: VERSION });
  }
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  /* Never cache live API, bridge commands, the SW script itself, or release/update probes. */
  if (url.pathname.startsWith('/api/') || url.pathname === '/bridge' || url.pathname === '/build.json' || url.pathname === '/update-check' || url.pathname === '/sw.js') return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  if (e.request.mode === 'navigate') {
    /* Online: bypass the HTTP cache so a replaced app.html reaches the screen
       on the very next reload. Offline: the cached shell of this release. */
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((r) => {
          if (r && r.ok) caches.open(VERSION).then((c) => c.put('/app', r.clone())).catch(() => {});
          return r;
        })
        .catch(() => caches.match('/app').then((r) => r || Response.error()))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request, { cache: 'no-cache' })
        .then((r) => {
          if (r && r.ok) caches.open(VERSION).then((c) => c.put(e.request, r.clone())).catch(() => {});
          return r;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
