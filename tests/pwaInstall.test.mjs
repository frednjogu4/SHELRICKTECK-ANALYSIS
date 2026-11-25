import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('PWA manifest launches the local app route and declares installation icons', () => {
  const manifest = JSON.parse(read('../public/manifest.webmanifest'));
  assert.equal(manifest.start_url, '/app');
  assert.equal(manifest.scope, '/');
  for (const path of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']) {
    assert.ok(manifest.icons.some((icon) => icon.src === path), `missing ${path}`);
  }
});

test('service worker caches only the app shell and never caches API or bridge traffic', () => {
  const sw = read('../public/sw.js');
  assert.match(sw, /const SHELL = \['\/app'/);
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\) \|\| url\.pathname === '\/bridge'/);
  assert.match(sw, /caches\.match\('\/app'\)/);
  assert.doesNotMatch(sw, /cache\.addAll\([^)]*\/api\//);
});

test('service worker release lifecycle: no-store navigation, release-keyed caches, version probe uncached', () => {
  const sw = read('../public/sw.js');
  /* The id is stamped by scripts/postbuild.mjs on every build. */
  assert.match(sw, /const VERSION = 'aurum-local-dev'/);
  assert.match(sw, /const VERSION_PREFIX = 'aurum-local-'/);
  /* Online navigations bypass the HTTP cache — the stale-shell fix. */
  assert.match(sw, /fetch\(e\.request, \{ cache: 'no-store' \}\)/);
  /* activate() deletes the caches of every older release, nothing else. */
  assert.match(sw, /k\.startsWith\(VERSION_PREFIX\) && k !== VERSION/);
  /* Background refresh revalidates instead of trusting the HTTP cache. */
  assert.match(sw, /fetch\(e\.request, \{ cache: 'no-cache' \}\)/);
  /* The update probe itself is never cached. */
  assert.match(sw, /pathname === '\/build\.json'/);
});

test('the local bridge revalidates /app and serves /build.json without caching', () => {
  const bridge = read('../bridge/mt5_bridge.py');
  assert.match(bridge, /"Cache-Control", "no-cache, must-revalidate"/);
  assert.match(bridge, /def _app_etag\(/);
  assert.match(bridge, /If-None-Match/);
  assert.match(bridge, /self\.send_response\(304\)/);
  assert.match(bridge, /if path == "\/build\.json":/);
  assert.match(bridge, /"Cache-Control", "no-store"/);
  assert.match(bridge, /"service": "mt5-bridge"/);
});

test('local bridge serves only the fixed PWA asset allowlist', () => {
  const bridge = read('../bridge/mt5_bridge.py');
  assert.match(bridge, /_PWA_FILES\s*=\s*\{/);
  assert.match(bridge, /"\/manifest\.webmanifest"/);
  assert.match(bridge, /"\/sw\.js"/);
  assert.match(bridge, /"\/icons\/icon-512\.png"/);
  assert.match(bridge, /self\.command == "GET" and path in _PWA_FILES/);
  assert.match(bridge, /PWA asset missing - re-extract the latest local app package/);
});

test('local installation guidance distinguishes laptop PWA from phone LAN HTTP', () => {
  const guide = read('../LOCAL_HOSTING_README.md');
  assert.match(guide, /http:\/\/127\.0\.0\.1:8788\/app/);
  assert.match(guide, /A full phone PWA install \(service worker\/offline shell\) needs HTTPS/);
  assert.match(guide, /Do \*\*not\*\* forward ports/);
});
