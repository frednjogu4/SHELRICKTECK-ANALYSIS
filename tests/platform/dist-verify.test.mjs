/*
 * scripts/verify-dist.mjs — the guard that stops an incomplete or unsafe
 * dist/ from being served or deployed. Uses throw-away directories only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_ASSET_HEADERS, REQUIRED_FILES, verifyDist } from '../../scripts/verify-dist.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'verify-dist.mjs');

const BUILT_HTML = '<!doctype html><html><head><script type="module" crossorigin>' + '/* bundle */'.repeat(200) + '</script></head><body></body></html>';
const HEADERS = '/*\n' + REQUIRED_ASSET_HEADERS.map((name) => `  ${name}: value`).join('\n') + '\n';
const MANIFEST = JSON.stringify({ name: 'x', start_url: '/app', icons: [{ src: '/icons/icon-192.png' }, { src: '/icons/icon-512.png' }, { src: '/icons/icon-maskable-512.png' }] });

function makeDist(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurum-dist-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'icons'));
  for (const name of REQUIRED_FILES) {
    const content = name.endsWith('.html') ? BUILT_HTML
      : name === '_headers' ? HEADERS
        : name === 'manifest.webmanifest' ? MANIFEST
          : name === 'sw.js' ? 'self.addEventListener("fetch", () => {});'
            : 'PNG';
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test('a complete build passes', (t) => {
  const dir = makeDist(t);
  const result = verifyDist(dir);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.files.length, REQUIRED_FILES.length);
});

test('a missing directory is reported with the fix', () => {
  const result = verifyDist(join(tmpdir(), 'aurum-dist-does-not-exist'));
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /npm run build/);
});

test('every required file is individually enforced', (t) => {
  for (const name of REQUIRED_FILES) {
    const dir = makeDist(t);
    unlinkSync(join(dir, name));
    const result = verifyDist(dir);
    assert.equal(result.ok, false, name);
    assert.ok(result.problems.some((problem) => problem.includes('missing ' + name)), `${name}: ${result.problems.join('; ')}`);
  }
});

test('the two-file dist that is tracked in Git (HTML only) is rejected', (t) => {
  const dir = makeDist(t);
  for (const name of REQUIRED_FILES.filter((file) => !file.endsWith('.html'))) unlinkSync(join(dir, name));
  const result = verifyDist(dir);
  assert.equal(result.ok, false);
  for (const name of ['sw.js', 'manifest.webmanifest', '_headers', 'icons/icon-192.png']) {
    assert.ok(result.problems.includes('missing ' + name), name);
  }
});

test('an empty file, an unbuilt page and a stale standalone copy are rejected', (t) => {
  const empty = makeDist(t);
  writeFileSync(join(empty, 'sw.js'), '');
  assert.ok(verifyDist(empty).problems.includes('sw.js is empty'));

  const unbuilt = makeDist(t);
  writeFileSync(join(unbuilt, 'index.html'), '<!doctype html><script type="module" src="/src/main.js"></script>');
  const unbuiltProblems = verifyDist(unbuilt).problems.join('\n');
  assert.match(unbuiltProblems, /unbuilt source page/);
  assert.match(unbuiltProblems, /inlined application bundle/);

  const stale = makeDist(t);
  writeFileSync(join(stale, 'AURUM_Workspace.html'), BUILT_HTML + '<!-- older -->');
  assert.ok(verifyDist(stale).problems.some((problem) => /AURUM_Workspace\.html differs/.test(problem)));
});

test('a broken manifest, a missing manifest icon and incomplete _headers are rejected', (t) => {
  const broken = makeDist(t);
  writeFileSync(join(broken, 'manifest.webmanifest'), '{ not json');
  assert.ok(verifyDist(broken).problems.some((problem) => /manifest\.webmanifest is not valid JSON/.test(problem)));

  const icon = makeDist(t);
  writeFileSync(join(icon, 'manifest.webmanifest'), JSON.stringify({ icons: [{ src: '/icons/other.png' }] }));
  assert.ok(verifyDist(icon).problems.includes('manifest icon /icons/other.png is not in the build'));

  for (const header of REQUIRED_ASSET_HEADERS) {
    const dir = makeDist(t);
    writeFileSync(join(dir, '_headers'), HEADERS.split('\n').filter((line) => !line.includes(header + ':')).join('\n'));
    assert.ok(verifyDist(dir).problems.includes('_headers does not set ' + header), header);
  }
});

test('secret-looking files and source maps are never accepted into a public build', (t) => {
  for (const name of ['.env', '.env.production', '.dev.vars', 'server.pem', 'private.key', 'bridge_token.txt', 'icons/id_rsa', 'index.js.map']) {
    const dir = makeDist(t);
    writeFileSync(join(dir, name), 'x');
    const result = verifyDist(dir);
    assert.equal(result.ok, false, name);
    assert.ok(result.problems.some((problem) => problem.startsWith(name + ' must not be published')), `${name}: ${result.problems.join('; ')}`);
  }
});

test('the command-line entry exits 0 for a complete build and 1 with a readable report otherwise', (t) => {
  const good = makeDist(t);
  const pass = spawnSync(process.execPath, [script, good], { encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /dist verified: \d+ files/);

  const bad = makeDist(t);
  unlinkSync(join(bad, 'sw.js'));
  const fail = spawnSync(process.execPath, [script, bad], { encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /dist verification FAILED/);
  assert.match(fail.stderr, /missing sw\.js/);
  assert.match(fail.stderr, /Nothing was deployed/);
});
