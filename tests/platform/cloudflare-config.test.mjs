/*
 * Static checks on the Cloudflare deployment configuration.
 *
 * These read wrangler.jsonc, public/_headers, package.json, .gitignore and the
 * PWA files and assert the properties the Worker relies on, so a config edit
 * that would silently weaken the deployment fails here first. Nothing is
 * deployed and no Cloudflare account is contacted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_SECURITY_HEADERS, isAppShellPath } from '../../cloudflare/platform.js';
import { REQUIRED_ASSET_HEADERS } from '../../scripts/verify-dist.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

/** Minimal JSONC reader: removes comments and trailing commas outside strings. */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next; i++; } else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true; out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) throw new Error('unterminated block comment');
    } else if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '}' && text[j] !== ']') out += ch;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out);
}

/** Parse a Cloudflare _headers file into { pattern: { 'header-name': value } }. */
function parseHeadersFile(text) {
  const rules = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { current = raw.trim(); rules[current] = rules[current] || {}; continue; }
    assert.ok(current, 'header line before any path pattern: ' + raw);
    const separator = raw.indexOf(':');
    assert.ok(separator > 0, 'malformed header line: ' + raw);
    rules[current][raw.slice(0, separator).trim().toLowerCase()] = raw.slice(separator + 1).trim();
  }
  return rules;
}

const wrangler = parseJsonc(read('wrangler.jsonc'));
const packageJson = JSON.parse(read('package.json'));
const workerSource = read('cloudflare/worker.js');

test('the JSONC reader used by these tests handles comments, strings and trailing commas', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "x // not a comment", /* b */ "u": "http://h/p", "l": [1, 2,], }'), { a: 'x // not a comment', u: 'http://h/p', l: [1, 2] });
});

test('wrangler.jsonc points at the Worker entry and the built asset directory', () => {
  assert.equal(wrangler.name, 'cloudflare-staging');
  assert.equal(wrangler.main, 'cloudflare/worker.js');
  assert.ok(existsSync(join(root, wrangler.main)));
  assert.match(wrangler.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(wrangler.assets.directory, './dist');
  assert.equal(wrangler.assets.binding, 'ASSETS');
  assert.match(workerSource, /env\.ASSETS/, 'the Worker uses the binding name declared in the config');
});

test('every /api request runs the Worker and missing files are not answered with the app shell', () => {
  const rules = wrangler.assets.run_worker_first;
  assert.ok(Array.isArray(rules));
  assert.ok(rules.includes('/api/*'), '/api/* must run the Worker first');
  assert.ok(rules.includes('/api'), 'the bare /api path must run the Worker first');
  assert.deepEqual(rules.filter((rule) => rule.startsWith('!')), [], 'no path is exempted from the Worker');
  assert.equal(wrangler.assets.not_found_handling, 'none',
    'with "single-page-application" every unknown path (/.env, /missing.js) is answered with index.html and status 200');
});

test('both rate-limit bindings used by the Worker are declared, with the period the Worker advertises', () => {
  const used = [...workerSource.matchAll(/enforceRateLimit\(env, request, '([A-Z_]+)'/g)].map((match) => match[1]);
  assert.ok(used.length >= 4, 'provider-backed routes call the limiter');
  const declared = new Map(wrangler.ratelimits.map((binding) => [binding.name, binding]));
  for (const name of new Set(used)) {
    const binding = declared.get(name);
    assert.ok(binding, `${name} is used by the Worker but not declared in wrangler.jsonc`);
    assert.ok(Number.isInteger(binding.simple.limit) && binding.simple.limit > 0, `${name} limit`);
    assert.equal(binding.simple.period, 60, `${name} period must match the Retry-After the Worker sends`);
    assert.match(String(binding.namespace_id), /^\d+$/, `${name} namespace_id is a numeric identifier`);
  }
  const ids = wrangler.ratelimits.map((binding) => binding.namespace_id);
  assert.equal(new Set(ids).size, ids.length, 'namespace ids must be unique');
  assert.match(workerSource, /const RATE_LIMIT_PERIOD_SECONDS = 60;/);
});

test('the config holds no secrets, variables, custom domains or stateful bindings', () => {
  for (const key of ['vars', 'secrets', 'routes', 'route', 'kv_namespaces', 'd1_databases', 'r2_buckets', 'durable_objects', 'services', 'queues', 'triggers', 'env']) {
    assert.equal(wrangler[key], undefined,
      `"${key}" was added to wrangler.jsonc. The staging Worker is designed to run with no secrets, no storage and only its workers.dev address; ` +
      'review README.md ("Cloudflare configuration") and the client-side read-only gating before changing that.');
  }
  assert.equal(wrangler.workers_dev, true);
  assert.doesNotMatch(read('wrangler.jsonc'), /(api[_-]?key|token|secret|password)\s*"?\s*:/i);
});

test('request metadata is kept out of Cloudflare logs while the Worker\'s own error logs are stored', () => {
  assert.equal(wrangler.observability.logs.enabled, true);
  assert.equal(wrangler.observability.logs.invocation_logs, false,
    'invocation logs record request metadata; browsers may attach client-held x-ai-* keys to API requests');
});

test('wrangler refuses to run with an incomplete dist/', () => {
  assert.equal(wrangler.build.command, 'node scripts/verify-dist.mjs');
  assert.ok(existsSync(join(root, 'scripts', 'verify-dist.mjs')));
});

test('public/_headers sets the security headers for every static asset', () => {
  const text = read('public/_headers');
  const rules = parseHeadersFile(text);
  const all = rules['/*'];
  assert.ok(all, 'a /* rule exists');
  for (const header of REQUIRED_ASSET_HEADERS) assert.ok(all[header.toLowerCase()], `${header} is set`);

  assert.equal(all['x-content-type-options'], 'nosniff');
  assert.equal(all['x-frame-options'], 'DENY');
  assert.match(all['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(all['content-security-policy'], /form-action 'self'/);
  assert.match(all['content-security-policy'], /object-src 'none'/);
  assert.match(all['content-security-policy'], /base-uri 'self'/);
  assert.doesNotMatch(all['content-security-policy'], /(default|script|connect|style|img|frame|font)-src/,
    'the resource policy lives in the index.html meta tag only; a second copy here could drift and break the page');
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
    assert.match(all['permissions-policy'], new RegExp(feature + '=\\(\\)'), `${feature} is disabled`);
  }

  /* Headers that exist on both asset and Worker responses must agree. */
  for (const name of ['x-content-type-options', 'x-frame-options', 'strict-transport-security']) {
    assert.equal(all[name], WORKER_SECURITY_HEADERS[name], `${name} differs between _headers and cloudflare/platform.js`);
  }

  for (const [pattern, headers] of Object.entries(rules)) {
    for (const name of Object.keys(headers)) {
      assert.doesNotMatch(name, /^access-control-/, `${pattern} must not grant cross-origin access (${name})`);
    }
  }
  assert.ok(Object.keys(rules).length <= 100, 'Cloudflare allows at most 100 header rules');
  for (const line of text.split('\n')) assert.ok(line.length <= 2000, 'Cloudflare allows at most 2,000 characters per line');
});

test('everything the service worker precaches is a real file or an app-shell path', () => {
  const sw = read('public/sw.js');
  const list = sw.match(/const SHELL = \[([^\]]+)\]/);
  assert.ok(list, 'SHELL list found in public/sw.js');
  const paths = [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    assert.ok(isAppShellPath(path) || existsSync(join(root, 'public', path)),
      `${path} is precached by the service worker but is neither a file in public/ nor a path the Worker serves the shell for`);
  }
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.ok(isAppShellPath(manifest.start_url), 'the PWA start URL is served by the Worker shell fallback');
  for (const icon of manifest.icons) assert.ok(existsSync(join(root, 'public', icon.src)), `${icon.src} exists`);
});

test('the Wrangler version is pinned exactly and the tooling scripts exist', () => {
  assert.match(packageJson.devDependencies.wrangler, /^\d+\.\d+\.\d+$/, 'wrangler must be an exact version, not a range');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages['node_modules/wrangler'].version, packageJson.devDependencies.wrangler);
  for (const script of ['build', 'test', 'test:server', 'test:platform', 'test:worker', 'verify', 'verify:dist', 'cf:dev', 'cf:dry-run', 'cf:deploy:staging']) {
    assert.equal(typeof packageJson.scripts[script], 'string', `npm run ${script}`);
  }
  assert.doesNotMatch(packageJson.scripts.build, /(^|[\s&])cp\s/, 'the build must not depend on a POSIX-only shell command');
  assert.doesNotMatch(packageJson.scripts.test, /--test\s+\S*\/(\s|$)/, '`node --test <directory>` does not work on Node 21+');
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (/wrangler\s+deploy/.test(command) && !/--dry-run/.test(command)) {
      assert.match(name, /staging/, `"${name}" deploys; only an explicitly named staging script may do that`);
      assert.match(command, /npm run build/, `"${name}" must build (and verify) before deploying`);
    }
  }
});

test('local secret files and Wrangler state are ignored by Git', () => {
  const ignore = read('.gitignore').split(/\r?\n/).map((line) => line.trim());
  for (const entry of ['.env', '.env.*', '!.env.example', '.dev.vars', '.dev.vars.*', '.wrangler/', 'node_modules/', 'bridge_token.txt']) {
    assert.ok(ignore.includes(entry), `.gitignore must contain ${entry}`);
  }
});

test('the Worker source contains no credentials and reads no secret bindings', () => {
  for (const file of ['cloudflare/worker.js', 'cloudflare/platform.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /(sk-ant-|sk-[A-Za-z0-9]{20,}|pplx-[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9._-]{20,})/, `${file} must not contain a credential`);
    assert.doesNotMatch(source, /env\.[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\b/, `${file} must not read secret bindings`);
    assert.doesNotMatch(source, /access-control-allow-origin/i, `${file} must not grant cross-origin access`);
  }
});
