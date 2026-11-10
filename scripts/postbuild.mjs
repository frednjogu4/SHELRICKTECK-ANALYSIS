#!/usr/bin/env node
/*
 * Post-build step for `npm run build`.
 *
 * 1. Copies dist/index.html to dist/AURUM_Workspace.html (the standalone
 *    single-file copy the project has always shipped). This used to be a
 *    shell `cp`, which does not exist in the default Windows npm shell.
 * 2. Verifies that dist/ is complete, so an incomplete build fails here
 *    instead of being deployed.
 */
import { copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDist } from './verify-dist.mjs';

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist');

copyFileSync(join(dist, 'index.html'), join(dist, 'AURUM_Workspace.html'));

const result = verifyDist(dist);
if (!result.ok) {
  console.error('Build output is incomplete:');
  for (const problem of result.problems) console.error('  - ' + problem);
  process.exit(1);
}
console.log(`postbuild: AURUM_Workspace.html written; dist verified (${result.files.length} files)`);
