#!/usr/bin/env node
/*
 * The page of the PC app is the page of the website.
 *
 * The website serves dist/ (Cloudflare publishes it at every merge). The PC
 * app serves bridge/app.html and the few static files in bridge/pwa/ from the
 * bridge on the trading PC (bridge/mt5_bridge.py, _APP_FILE and _PWA_FILES).
 * Until November 2026 nothing rebuilt those copies, so the PC app stayed at
 * the build its package had been made from while the website moved on.
 *
 * `npm run build` now ends by copying the built page and its static files
 * into bridge/ (scripts/postbuild.mjs calls refreshPcPage), and
 * tests/platform/pc-page.test.mjs fails when a copy differs from dist/.
 *
 * This keeps the copies in the repository equal. The trading PC has its own
 * files: they change when the package folder on that PC is replaced (README,
 * "Bringing the PC app up to date").
 *
 * Usage:
 *   node scripts/pc-page.mjs           copy what differs, list what was copied
 *   node scripts/pc-page.mjs --check   copy nothing; exit 1 when a copy differs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** [built file under dist/, the copy the PC bridge serves under bridge/]. */
export const PC_PAGE_COPIES = Object.freeze([
  ['index.html', 'app.html'],
  ['manifest.webmanifest', 'pwa/manifest.webmanifest'],
  ['sw.js', 'pwa/sw.js'],
  ['icons/icon-192.png', 'pwa/icons/icon-192.png'],
  ['icons/icon-512.png', 'pwa/icons/icon-512.png'],
  ['icons/icon-maskable-512.png', 'pwa/icons/icon-maskable-512.png'],
  ['icons/apple-touch-icon.png', 'pwa/icons/apple-touch-icon.png'],
  ['icons/favicon-32.png', 'pwa/icons/favicon-32.png']
].map((pair) => Object.freeze(pair)));

const paths = (root, [built, copy]) => ({
  built: join(root, 'dist', ...built.split('/')),
  copy: join(root, 'bridge', ...copy.split('/')),
  name: 'bridge/' + copy,
  from: 'dist/' + built
});

/**
 * The copies under bridge/ that are not byte for byte the built file.
 * @returns {{ name: string, from: string, reason: 'missing' | 'differs' | 'not built' }[]}
 */
export function stalePcPageFiles(root = REPO_ROOT) {
  const stale = [];
  for (const pair of PC_PAGE_COPIES) {
    const file = paths(root, pair);
    if (!existsSync(file.built)) { stale.push({ name: file.name, from: file.from, reason: 'not built' }); continue; }
    if (!existsSync(file.copy)) { stale.push({ name: file.name, from: file.from, reason: 'missing' }); continue; }
    if (!readFileSync(file.built).equals(readFileSync(file.copy))) stale.push({ name: file.name, from: file.from, reason: 'differs' });
  }
  return stale;
}

/**
 * Copies every built file whose copy under bridge/ is missing or different.
 * A file that is already equal is left alone, so its date does not change.
 * @returns {string[]} the copies that were written
 */
export function refreshPcPage(root = REPO_ROOT) {
  const written = [];
  for (const entry of stalePcPageFiles(root)) {
    if (entry.reason === 'not built') throw new Error(entry.from + ' does not exist. Run "npm run build" first.');
    const pair = PC_PAGE_COPIES.find(([, copy]) => 'bridge/' + copy === entry.name);
    const file = paths(root, pair);
    mkdirSync(dirname(file.copy), { recursive: true });
    copyFileSync(file.built, file.copy);
    written.push(entry.name);
  }
  return written;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  if (process.argv.includes('--check')) {
    const stale = stalePcPageFiles();
    if (stale.length) {
      console.error('The PC app would not serve the built page:');
      for (const entry of stale) console.error('  - ' + entry.name + ' (' + entry.reason + '; built file: ' + entry.from + ')');
      console.error('Run "npm run build" and commit the files it changes under bridge/.');
      process.exit(1);
    }
    console.log('PC page verified: ' + PC_PAGE_COPIES.length + ' files under bridge/ equal the built files in dist/');
  } else {
    const written = refreshPcPage();
    console.log(written.length ? 'PC page refreshed: ' + written.join(', ') : 'PC page already equal to dist/ (' + PC_PAGE_COPIES.length + ' files)');
  }
}
