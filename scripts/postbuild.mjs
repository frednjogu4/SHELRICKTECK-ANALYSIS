#!/usr/bin/env node
/*
 * Post-build step for `npm run build`.
 *
 * 1. Copies dist/index.html to dist/AURUM_Workspace.html (the standalone
 *    single-file copy the project has always shipped). This used to be a
 *    shell `cp`, which does not exist in the default Windows npm shell.
 * 2. Verifies that dist/ is complete, so an incomplete build fails here
 *    instead of being deployed.
 * 3. Copies the built page and its static files into bridge/, where the PC
 *    app serves them from (scripts/pc-page.mjs), so the PC app and the website
 *    are the same build.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDist } from './verify-dist.mjs';
import { PC_PAGE_COPIES, refreshPcPage } from './pc-page.mjs';

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist');

copyFileSync(join(dist, 'index.html'), join(dist, 'AURUM_Workspace.html'));

/* Bind the offline-shell cache name to the complete app shell and SW source.
   Each distinct build installs a fresh cache; the worker then deletes old ones. */
const appShell = readFileSync(join(dist, 'index.html'));
const manifest = readFileSync(join(dist, 'manifest.webmanifest'));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceWorkerSource = readFileSync(join(repoRoot, 'public', 'sw.js'), 'utf8');
const buildId = createHash('sha256')
  .update(appShell)
  .update(manifest)
  .update(serviceWorkerSource.replace('__AURUM_BUILD_ID__', ''))
  .digest('hex')
  .slice(0, 16);
const workerPath = join(dist, 'sw.js');
const worker = readFileSync(workerPath, 'utf8');
if (!worker.includes('__AURUM_BUILD_ID__')) {
  throw new Error('dist/sw.js has no __AURUM_BUILD_ID__ placeholder; update public/sw.js');
}
writeFileSync(workerPath, worker.replaceAll('__AURUM_BUILD_ID__', buildId));

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
