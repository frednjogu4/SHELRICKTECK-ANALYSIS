/*
 * What the trading PC needs besides the page.
 *
 * The PC app's own server is started from the package folder on the trading
 * PC (START_LOCAL_API.bat: `node server\server.js`, with the packages that
 * `npm ci --omit=dev` installs). That folder is brought up to date by hand, a
 * folder at a time, by someone who is not a programmer. So:
 *
 *   1. nothing under server/ needs a file from outside server/. Until
 *      November 2026 nothing did. When the PC's server began to make its
 *      reading at the 5-minute close, the code for that was moved from src/ to
 *      server/lib/closedcandles.js instead of making the server reach into
 *      src/: a PC that receives a new server folder and no src folder still
 *      starts;
 *   2. every package the server imports is a runtime dependency;
 *   3. what the page tells the user to do on the PC names a window and a
 *      launcher that exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as inServer from '../../server/lib/closedcandles.js';
import * as inPage from '../../src/closedcandles.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverRoot = join(root, 'server');
const text = (...parts) => readFileSync(join(root, ...parts), 'utf8');

/* Every .js file the PC's server can load: server/ without its tests. */
function serverFiles(folder = serverRoot) {
  const found = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) { if (name !== 'tests' && name !== 'data' && name !== 'node_modules') found.push(...serverFiles(path)); }
    else if (name.endsWith('.js') || name.endsWith('.mjs')) found.push(path);
  }
  return found;
}
/* What a file imports: `import … from 'x'`, `export … from 'x'`, `import 'x'` and `import('x')`. */
function importsOf(file) {
  const source = readFileSync(file, 'utf8');
  const found = new Set();
  for (const match of source.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)) found.add(match[1]);
  for (const match of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) found.add(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.add(match[1]);
  return [...found];
}
const shown = (file) => relative(root, file).split(sep).join('/');

test('the PC\'s server folder is complete on its own: nothing under server/ needs a file from outside it', () => {
  const files = serverFiles();
  assert.ok(files.length >= 30, 'the server files were not found');
  assert.ok(files.some((file) => shown(file) === 'server/app.js') && files.some((file) => shown(file) === 'server/lib/closedcandles.js'));
  let relativeImports = 0;
  for (const file of files) {
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      relativeImports += 1;
      const target = resolve(dirname(file), specifier);
      assert.ok(target.startsWith(serverRoot + sep), `${shown(file)} imports ${specifier}: a file outside server/, which a PC that received only the server folder does not have`);
      assert.ok(existsSync(target), `${shown(file)} imports ${specifier}, which does not exist`);
    }
  }
  assert.ok(relativeImports >= 40, 'the imports were not understood');
  /* the import this rule was written for */
  assert.ok(importsOf(join(serverRoot, 'app.js')).includes('./lib/closedcandles.js'));
});

test('every package the PC\'s server imports is installed by "npm ci --omit=dev"', () => {
  const manifest = JSON.parse(text('package.json'));
  const runtime = new Set(Object.keys(manifest.dependencies || {}));
  const builtin = new Set(builtinModules);
  const packages = new Set();
  for (const file of serverFiles()) {
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('.')) continue;
      const bare = specifier.replace(/^node:/, '');
      if (builtin.has(bare) || builtin.has(bare.split('/')[0])) continue;
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      packages.add(name);
      assert.ok(runtime.has(name), `${shown(file)} imports "${name}", which is not under "dependencies" in package.json`);
    }
  }
  assert.ok(packages.has('express') && packages.has('ws'), 'the packages were not understood');
  assert.match(text('START_LOCAL_API.bat'), /npm ci --omit=dev/);
});

test('the page and the Worker read a market through the same code as the PC\'s server', () => {
  assert.deepEqual(Object.keys(inPage).sort(), Object.keys(inServer).sort());
  for (const name of Object.keys(inServer)) assert.equal(inPage[name], inServer[name], name);
  assert.equal(typeof inServer.closedCandleSets, 'function');
  /* each of the places imports it */
  assert.match(text('server', 'app.js'), /import \{ closedCandleSets \} from '\.\/lib\/closedcandles\.js';/);
  assert.match(text('cloudflare', 'worker.js'), /import \{ closedCandleSets \} from '\.\.\/src\/closedcandles\.js';/);
  assert.match(text('src', 'hostedscan.js'), /import \{ closedCandleSets \} from '\.\/closedcandles\.js';/);
  assert.match(text('src', 'main.js'), /import \{ closedCandleSets, nextReadingCheck \} from '\.\/closedcandles\.js';/);
});

test('the hint on the PC\'s Gold page names a window and a launcher that exist, and the reason for it holds', () => {
  const page = text('src', 'main.js');
  const hint = /close the "([^"]+)" window and run ([A-Z_]+\.bat) again/.exec(page);
  assert.ok(hint, 'the hint is not in src/main.js in the form this test reads');
  const [, windowTitle, launcher] = hint;

  /* the window: the one the PC's server runs in */
  const startApi = text('START_LOCAL_API.bat');
  assert.ok(startApi.includes(`start "${windowTitle}" /min`), `START_LOCAL_API.bat opens no window titled "${windowTitle}"`);
  assert.match(startApi, /RUN_LOCAL_API\.bat/);
  assert.match(text('RUN_LOCAL_API.bat'), /node server\\server\.js/);

  /* the launcher: starts the server again when none is running */
  assert.ok(existsSync(join(root, launcher)), launcher + ' does not exist');
  assert.match(text(launcher), /bridge\\SETUP_AND_RUN\.bat/);
  assert.match(text('bridge', 'SETUP_AND_RUN.bat'), /START_LOCAL_API\.bat/);

  /* the reason: a server that is already running is left alone, so new files under server\ are not
     loaded until its window is closed. If this changes, the hint has to change with it. */
  assert.match(startApi, /Invoke-RestMethod 'http:\/\/127\.0\.0\.1:4100\/api\/health'[^\r\n]*\r?\nif not errorlevel 1 exit \/b 0\r?\n/);
});
