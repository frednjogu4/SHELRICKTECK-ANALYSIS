/*
 * The page of the PC app is the page of the website.
 *
 * The website serves dist/. The PC app serves bridge/app.html and the static
 * files in bridge/pwa/ (bridge/mt5_bridge.py: _APP_FILE, _PWA_FILES). Until
 * November 2026 nothing kept the two equal, and the PC app showed a build
 * that was days of work behind the website. `npm run build` now copies the
 * built files into bridge/ (scripts/pc-page.mjs), and this file fails when a
 * copy in the repository differs from dist/.
 *
 * tests/test_mt5_bridge_page.py asks the bridge's own page server for the
 * same files; this file needs no Python.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PC_PAGE_COPIES, refreshPcPage, stalePcPageFiles } from '../../scripts/pc-page.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts));

test('the PC serves the same build as the website: every copy under bridge/ equals its file in dist/', () => {
  assert.deepEqual(stalePcPageFiles(root), [], 'run "npm run build" and commit the files it changes under bridge/');
  assert.ok(read('bridge', 'app.html').equals(read('dist', 'index.html')), 'bridge/app.html is not dist/index.html');
  assert.ok(read('bridge', 'app.html').length > 100000, 'bridge/app.html is not a whole page');
});

test('every file the bridge serves for the page is one of the copies, and no copy goes unserved', () => {
  const bridge = read('bridge', 'mt5_bridge.py').toString('utf8');
  assert.match(bridge, /\n_APP_FILE = os\.path\.join\(_BRIDGE_DIR, "app\.html"\)\n/);
  const table = bridge.match(/\n_PWA_FILES = \{\n([\s\S]*?)\n\}\n/);
  assert.ok(table, '_PWA_FILES is not the table this test reads');
  const served = [...table[1].matchAll(/^\s+"(\/[^"]+)": \(os\.path\.join\(_BRIDGE_DIR, ((?:"[^"]+"(?:, )?)+)\), "[^"]+"\),$/gm)]
    .map((row) => ({ url: row[1], file: [...row[2].matchAll(/"([^"]+)"/g)].map((part) => part[1]).join('/') }));
  assert.equal(served.length, table[1].trim().split('\n').length, 'a row of _PWA_FILES was not understood');

  const copies = new Map(PC_PAGE_COPIES.map(([built, copy]) => [copy, built]));
  assert.equal(copies.get('app.html'), 'index.html');
  for (const { url, file } of served) {
    assert.ok(copies.has(file), `the bridge serves bridge/${file}, which the build does not refresh`);
    assert.equal('/' + copies.get(file), url, `bridge/${file} is served as ${url}, so it must be the built file of that name`);
  }
  assert.deepEqual([...copies.keys()].filter((copy) => copy !== 'app.html').sort(), served.map((entry) => entry.file).sort());
});

test('the build ends by refreshing the PC page', () => {
  const scripts = JSON.parse(read('package.json').toString('utf8')).scripts;
  assert.match(scripts.build, /vite build && node scripts\/postbuild\.mjs$/);
  const postbuild = read('scripts', 'postbuild.mjs').toString('utf8');
  assert.match(postbuild, /import \{[^}]*\brefreshPcPage\b[^}]*\} from '\.\/pc-page\.mjs';/);
  assert.ok(postbuild.indexOf('refreshPcPage()') > postbuild.indexOf('verifyDist(dist)'), 'the page is copied only after dist/ was verified');
});

function scratchRoot() {
  const folder = mkdtempSync(join(tmpdir(), 'aurum-pc-page-'));
  for (const [built] of PC_PAGE_COPIES) {
    const file = join(folder, 'dist', ...built.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'built ' + built);
  }
  return folder;
}

test('refreshing copies what is missing or different and leaves an equal file alone', () => {
  const folder = scratchRoot();
  try {
    assert.equal(stalePcPageFiles(folder).length, PC_PAGE_COPIES.length);
    assert.ok(stalePcPageFiles(folder).every((entry) => entry.reason === 'missing'));
    assert.deepEqual(refreshPcPage(folder), PC_PAGE_COPIES.map(([, copy]) => 'bridge/' + copy));
    assert.deepEqual(stalePcPageFiles(folder), []);
    assert.equal(readFileSync(join(folder, 'bridge', 'app.html'), 'utf8'), 'built index.html');
    assert.equal(readFileSync(join(folder, 'bridge', 'pwa', 'icons', 'favicon-32.png'), 'utf8'), 'built icons/favicon-32.png');

    /* an older page on the PC side, as the repository had it */
    const page = join(folder, 'bridge', 'app.html');
    const icon = join(folder, 'bridge', 'pwa', 'icons', 'icon-192.png');
    const long = new Date('2026-11-09T21:55:00Z');
    writeFileSync(page, 'the page of an older package');
    utimesSync(icon, long, long);
    assert.deepEqual(stalePcPageFiles(folder), [{ name: 'bridge/app.html', from: 'dist/index.html', reason: 'differs' }]);
    assert.deepEqual(refreshPcPage(folder), ['bridge/app.html']);
    assert.equal(readFileSync(page, 'utf8'), 'built index.html');
    assert.equal(statSync(icon).mtimeMs, long.getTime(), 'an equal file was written again');
    assert.deepEqual(refreshPcPage(folder), []);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('nothing is copied from a build that is not there', () => {
  const folder = scratchRoot();
  try {
    rmSync(join(folder, 'dist', 'index.html'));
    assert.deepEqual(stalePcPageFiles(folder)[0], { name: 'bridge/app.html', from: 'dist/index.html', reason: 'not built' });
    assert.throws(() => refreshPcPage(folder), /dist\/index\.html does not exist\. Run "npm run build" first\./);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
