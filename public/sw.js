/* AURUM service worker — installable local app shell.
 * Strategy:
 *  - /app shell: network-first, cached shell only as an offline fallback
 *  - icons/manifest: cache-first with background refresh
 *  - /api/* and WebSocket/live data: NEVER cached
 */
const VERSION = 'aurum-local-v2';
const SHELL = ['/app', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  /* Never cache live API, bridge commands, or websocket/live data. */
  if (url.pathname.startsWith('/api/') || url.pathname === '/bridge') return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
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
      const refresh = fetch(e.request)
        .then((r) => {
          if (r && r.ok) caches.open(VERSION).then((c) => c.put(e.request, r.clone())).catch(() => {});
          return r;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
