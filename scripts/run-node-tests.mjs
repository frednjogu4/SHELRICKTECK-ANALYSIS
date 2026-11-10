#!/usr/bin/env node
/*
 * Run the node:test suites with an explicit file list.
 *
 * `node --test <directory>` only works on Node 20. Since Node 21 a positional
 * argument is a file or glob, so a directory is loaded as a module and the
 * run fails before a single test executes. Shell globs are not an option
 * either (the default Windows npm shell does not expand them). Listing the
 * files here behaves the same on Node 20+, Linux, macOS and Windows.
 *
 * Usage: node scripts/run-node-tests.mjs [group ...]
 *   groups: server    -> server/tests/*.test.{mjs,js}
 *           app       -> tests/*.test.mjs
 *           platform  -> tests/platform/*.test.mjs
 *   no group runs all three.
 *
 * Every test process is started with scripts/test-network-guard.mjs, which
 * refuses connections to anything but this machine, so a test run cannot
 * reach a broker or data provider. AURUM_TEST_ALLOW_NETWORK=1 turns that off.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = {
  server: 'server/tests',
  app: 'tests',
  platform: 'tests/platform'
};

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !Object.hasOwn(GROUPS, name));
if (unknown.length) {
  console.error(`Unknown test group: ${unknown.join(', ')}. Available: ${Object.keys(GROUPS).join(', ')}`);
  process.exit(2);
}
const groups = requested.length ? requested : Object.keys(GROUPS);

const files = [];
for (const group of groups) {
  const dir = join(root, GROUPS[group]);
  const found = existsSync(dir)
    ? readdirSync(dir).filter((name) => /\.test\.(mjs|js)$/.test(name)).sort().map((name) => join(GROUPS[group], name))
    : [];
  if (!found.length) {
    /* An empty group means the layout changed; never report "0 tests" as success. */
    console.error(`No test files found for group "${group}" in ${GROUPS[group]}`);
    process.exit(1);
  }
  files.push(...found);
}

/* NODE_OPTIONS (not a command-line flag) so that the guard also reaches the
   per-file child processes of `node --test` and anything a test spawns. A
   file: URL keeps a checkout path with spaces in one piece. */
const allowNetwork = process.env.AURUM_TEST_ALLOW_NETWORK === '1';
const guard = `--import=${pathToFileURL(join(root, 'scripts', 'test-network-guard.mjs')).href}`;
const env = { ...process.env };
if (!allowNetwork) env.NODE_OPTIONS = [process.env.NODE_OPTIONS, guard].filter(Boolean).join(' ');

console.log(`node --test: ${files.length} files (${groups.join(', ')}) — outbound network ${allowNetwork ? 'ALLOWED (AURUM_TEST_ALLOW_NETWORK=1)' : 'blocked'}`);
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env });
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
