#!/usr/bin/env node
/* Post-build step for `npm run build`.
 *
 * 1. Computes the build revision (content id of the built page — see
 *    scripts/build-revision.mjs) and injects it into dist/index.html as
 *    <meta name="aurum-build">, into dist/sw.js as the release-keyed cache
 *    VERSION, and into dist/build.json (served to every client as
 *    /build.json so the app can detect a newer release).
 * 2. Copies dist/index.html to dist/AURUM_Workspace.html (the standalone
 *    single-file copy the project has always shipped). This used to be a
 *    shell `cp`, which does not exist on the default Windows npm shell.
 * 3. Verifies that dist/ is complete AND carries a self-consistent revision,
 *    so an incomplete or mixed build fails here instead of being deployed.
 * 4. Copies the built page and its static files into bridge/, where the PC
 *    app serves them from (scripts/pc-page.mjs), so the PC app and the
 *    website are the same build. A missing source file fails the run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDist } from './verify-dist.mjs';
import { PC_PAGE_COPIES, refreshPcPage } from './pc-page.mjs';
import { resolveBuildManifest, injectBuildMeta, injectSwVersion } from './build-revision.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

/* Write only when the bytes actually change: scripts/dev-local.mjs watches
 * this directory, and a rewrite of identical bytes would wake the watcher
 * for nothing. */
function writeIfChanged(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  try {
    if (readFileSync(file).equals(buf)) return false;
  } catch { /* missing file: fall through and write */ }
  writeFileSync(file, buf);
  return true;
}

/* 1. Revision: hash the un-tagged page, resolve git/builtAt, then inject everywhere. */
let prevManifest = null;
try { prevManifest = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8')); } catch { prevManifest = null; }
const manifest = resolveBuildManifest(dist, root, prevManifest);
const stamped = [];
if (writeIfChanged(join(dist, 'index.html'), injectBuildMeta(readFileSync(join(dist, 'index.html'), 'utf8'), manifest))) stamped.push('index.html');
if (writeIfChanged(join(dist, 'sw.js'), injectSwVersion(readFileSync(join(dist, 'sw.js'), 'utf8'), manifest.id))) stamped.push('sw.js');
if (writeIfChanged(join(dist, 'build.json'), JSON.stringify(manifest, null, 2) + '\n')) stamped.push('build.json');
console.log(`postbuild: build revision ${manifest.id} (${manifest.version || 'no version'}${manifest.git ? ', git ' + manifest.git : ''})${stamped.length ? ' stamped ' + stamped.join(', ') : ' already stamped'}`);

writeIfChanged(join(dist, 'AURUM_Workspace.html'), readFileSync(join(dist, 'index.html')));

const result = verifyDist(dist);
if (!result.ok) {
  console.error('Build output is incomplete:');
  for (const problem of result.problems) console.error('  - ' + problem);
  process.exit(1);
}
console.log(`postbuild: AURUM_Workspace.html written; dist verified (${result.files.length} files)`);

const refreshed = refreshPcPage();
console.log(refreshed.length
  ? `postbuild: PC page refreshed (${refreshed.join(', ')})`
  : `postbuild: PC page already equal to dist/ (${PC_PAGE_COPIES.length} files under bridge/)`);
