/*
 * Build revision: one content-addressed release id must travel through the
 * page, /build.json and the service worker, and it must be reproducible so a
 * rebuild of the same sources never looks like a different release (CI's
 * "committed dist matches a fresh build" check, update-banner false positives).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentId, stripBuildMeta, injectBuildMeta, injectSwVersion, buildRevision } from '../../scripts/build-revision.mjs';
import { stalePcPageFiles } from '../../scripts/pc-page.mjs';
import { verifyDist } from '../../scripts/verify-dist.mjs';

const root = new URL('../..', import.meta.url).pathname;
const dist = join(root, 'dist');
const hasBuild = existsSync(join(dist, 'index.html'));

test('content ids are stable for identical bytes and differ for different bytes', () => {
  assert.equal(contentId('abc'), contentId('abc'));
  assert.notEqual(contentId('abc'), contentId('abd'));
  assert.match(contentId('x'), /^b[0-9a-f]{12}$/);
});

test('stamping is idempotent: stripping, re-injecting and re-hashing yields the same id', () => {
  const plain = '<!doctype html><html><head><title>t</title></head><body></body></html>';
  const rev = { id: 'btest', version: '1' };
  const stamped = injectBuildMeta(plain, rev);
  assert.match(stamped, /<meta name="aurum-build" content="btest">/);
  const restamped = injectBuildMeta(stamped, rev);
  assert.equal(restamped, stamped, 'a second stamp must not stack or shift');
  assert.equal(contentId(Buffer.from(stripBuildMeta(stamped))), contentId(Buffer.from(stripBuildMeta(restamped))));
});

test('the service worker VERSION stamp is idempotent and release-keyed', () => {
  const src = "const VERSION = 'aurum-local-dev';\nconst VERSION_PREFIX = 'aurum-local-';";
  const once = injectSwVersion(src, 'babc123');
  assert.match(once, /const VERSION = 'aurum-local-babc123';/);
  const twice = injectSwVersion(once, 'babc123');
  assert.equal(twice, once);
});

test('dist carries ONE release id across page, manifest and service worker', { skip: !hasBuild }, () => {
  const v = verifyDist(dist);
  assert.ok(v.ok, v.problems.join(' | '));
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const meta = html.match(/<meta name="aurum-build" content="([^"]+)">/);
  assert.ok(meta, 'page meta missing');
  const manifest = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'));
  assert.equal(manifest.id, meta[1], 'build.json id must equal the page meta');
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  const swv = sw.match(/const VERSION = '([^']+)'/);
  assert.ok(swv, 'sw.js VERSION missing');
  assert.equal(swv[1], `aurum-local-${meta[1]}`, 'sw cache name must be keyed by the same release');
  assert.equal(readFileSync(join(dist, 'AURUM_Workspace.html'), 'utf8'), html);
});

test('shipped release files never bake timestamps or git shas (reproducible builds)', { skip: !hasBuild }, () => {
  const manifest = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['id', 'version'], 'build.json is content metadata only');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /aurum-build-git/);
  /* Re-running the revision against the stamped page returns the same id —
     the property that makes a rebuild byte-identical. */
  assert.equal(buildRevision(dist).id, manifest.id);
});

test('every release file under bridge/ equals its dist/ counterpart byte-for-byte', { skip: !hasBuild }, () => {
  assert.deepEqual(stalePcPageFiles(root), [], 'bridge copies are stale — run `npm run build` (or `npm run sync:local`)');
  const distId = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8')).id;
  const bridgeId = JSON.parse(readFileSync(join(root, 'bridge', 'pwa', 'build.json'), 'utf8')).id;
  assert.equal(bridgeId, distId, 'the PC package must serve the same release as dist/');
});

test('npm exposes the local development and sync commands', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['dev:local'], 'node scripts/dev-local.mjs');
  assert.equal(pkg.scripts['sync:local'], 'node scripts/pc-page.mjs');
  assert.equal(pkg.scripts['verify:local'], 'node scripts/pc-page.mjs --check');
  assert.ok(pkg.scripts.build.includes('postbuild'), 'build must keep ending in the sync step');
});
