#!/usr/bin/env node
/*
 * `npm run dev:local` — local development updates for http://127.0.0.1:8788/app.
 *
 * Why this exists: the user's browser always opens the local bridge page
 * (bridge/app.html on port 8788), never the Vite dev port. Until now a
 * source change required a manual `npm run build` and a hard browser reload.
 *
 * This watcher closes that loop with the existing bridge architecture:
 *
 *   source change (index.html, src/, public/ styles, assets)
 *     -> vite build --watch rebuilds dist/            (~1-2 s, single-file app)
 *     -> this script runs scripts/postbuild.mjs       (stamp revision, verify,
 *                                                     sync bridge/app.html + pwa/)
 *     -> the bridge serves the new page on the NEXT request (it reads
 *        app.html per request — no restart needed)
 *     -> the open tab notices /build.json changed (src/buildinfo.js) and shows
 *        NEW VERSION AVAILABLE, refreshing when it is safe to do so.
 *
 * A `.dev-watch.json` marker file (repo root, removed on exit) tells the
 * bridge /build.json that mode is LOCAL DEV (watch) so Settings · Build &
 * delivery can distinguish development from packaged mode (acceptance G).
 *
 * The watcher opens no ports and exposes nothing on the network: Vite is only
 * invoked as `vite build` (a compiler), never as a dev server.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marker = join(root, '.dev-watch.json');
const distDir = join(root, 'dist');
const debounceMs = 400;

const log = (...a) => console.log('[dev:local]', ...a);

function runPostbuild() {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'postbuild.mjs')], { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => resolvePromise(code || 0));
  });
}

/* --- start vite build --watch (rebuilds dist/ on every source change) --- */
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
  console.error('[dev:local] vite is not installed — run `npm install` first.');
  process.exit(1);
}
const vite = spawn(process.execPath, [viteBin, 'build', '--watch'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
vite.stdout.on('data', (b) => process.stdout.write('[vite] ' + b));
vite.stderr.on('data', (b) => process.stderr.write('[vite] ' + b));
vite.on('exit', (code) => {
  log('vite build --watch exited with code ' + code);
  shutdown(code || 0);
});

/* --- marker so /build.json reports LOCAL DEV (watch) while this runs --- */
writeFileSync(marker, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
log('watching for UI source changes — updates appear at http://127.0.0.1:8788/app');
log('press Ctrl+C to stop (packaged mode resumes on the next /build.json poll)');

/* --- initial sync so the bridge serves the current sources right away --- */
await runPostbuild();

/* --- watch dist/: whenever vite rewrites files, sync the bridge copies --- */
let timer = null;
let running = false;
let pending = false;
let watcher = null;

function onDistChange() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (running) { pending = true; return; }
    running = true;
    try {
      const code = await runPostbuild();
      if (code === 0) {
        log('bridge/app.html synced — the open tab shows NEW VERSION AVAILABLE (Refresh, or it refreshes itself when safe)');
      } else {
        log('postbuild FAILED — the bridge still serves the previous verified build');
      }
    } finally {
      running = false;
      if (pending) { pending = false; onDistChange(); }
    }
  }, debounceMs);
}

if (existsSync(distDir)) {
  watcher = watch(distDir, { recursive: false }, () => onDistChange());
} else {
  log('dist/ not created yet — waiting for the first vite build…');
  const wait = setInterval(() => {
    if (existsSync(distDir)) {
      clearInterval(wait);
      watcher = watch(distDir, { recursive: false }, () => onDistChange());
    }
  }, 1000);
}

let stopped = false;
function cleanup() {
  try { if (watcher) watcher.close(); } catch { /* already closed */ }
  try { if (existsSync(marker)) rmSync(marker); } catch { /* nothing to remove */ }
}
function shutdown(code) {
  if (stopped) return;
  stopped = true;
  cleanup();
  try { vite.kill('SIGTERM'); } catch { /* already gone */ }
  process.exit(typeof code === 'number' ? code : 0);
}
process.on('SIGINT', () => { log('stopped'); shutdown(0); });
process.on('SIGTERM', () => { log('stopped'); shutdown(0); });
process.on('exit', cleanup);
