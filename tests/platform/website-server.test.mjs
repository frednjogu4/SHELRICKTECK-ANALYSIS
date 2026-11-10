/*
 * server/websiteserver.js — static file containment for the local website
 * server (Node standard library only).
 *
 * The server is copied into a throw-away directory next to a fake dist/ and a
 * sibling folder whose name merely STARTS with "dist". Only static-file
 * requests are made; the /api proxy is never exercised, so nothing is sent
 * to the API server or to any broker route.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let sandbox = '';
let child = null;
let port = 0;
let output = '';

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolvePort(chosen)); });
  });
}

/* node:http sends the path exactly as written, so "/../" reaches the server
   unnormalised — which fetch() and URL would not allow. */
function rawGet(path) {
  return new Promise((resolveResponse, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'aurum-website-'));
  mkdirSync(join(sandbox, 'server'));
  mkdirSync(join(sandbox, 'dist'));
  mkdirSync(join(sandbox, 'dist-private'));
  mkdirSync(join(sandbox, 'other'));
  copyFileSync(join(root, 'server', 'websiteserver.js'), join(sandbox, 'server', 'websiteserver.js'));
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(sandbox, 'dist', 'index.html'), '<!doctype html><title>site</title>');
  writeFileSync(join(sandbox, 'dist', 'manifest.webmanifest'), '{"name":"x"}');
  writeFileSync(join(sandbox, 'dist-private', 'notes.txt'), 'OUTSIDE-DIST-CONTENT');
  writeFileSync(join(sandbox, 'other', 'notes.txt'), 'OUTSIDE-DIST-CONTENT');

  port = await freePort();
  child = spawn(process.execPath, [join(sandbox, 'server', 'websiteserver.js')], {
    cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WEBSITE_PORT: String(port), PORT: '9' }
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 15000;
  while (!output.includes('serving dist/')) {
    if (child.exitCode !== null) throw new Error('website server exited early:\n' + output);
    if (Date.now() > deadline) throw new Error('website server did not start:\n' + output);
    await new Promise((r) => setTimeout(r, 50));
  }
});

after(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test('files inside dist/ are still served', async () => {
  for (const path of ['/', '/index.html', '/.']) {
    const page = await rawGet(path);
    assert.equal(page.status, 200, path);
    assert.match(page.headers['content-type'], /^text\/html/, path);
    assert.match(page.body, /<title>site<\/title>/, path);
  }
  const manifest = await rawGet('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body, '{"name":"x"}');

  /* Unknown extension-less paths keep falling back to the single-page app. */
  const deep = await rawGet('/some/deep/link');
  assert.equal(deep.status, 200);
  assert.match(deep.body, /<title>site<\/title>/);
});

test('a sibling folder whose name starts with "dist" cannot be read through ../', async () => {
  for (const path of ['/../dist-private/notes.txt', '/..//dist-private/notes.txt', '/x/../../dist-private/notes.txt']) {
    const res = await rawGet(path);
    assert.equal(res.status, 403, path);
    assert.doesNotMatch(res.body, /OUTSIDE-DIST-CONTENT/, path);
  }
});

test('other paths outside dist/ stay unreadable', async () => {
  for (const path of ['/../other/notes.txt', '/../package.json', '/../../etc/hostname', '/../server/websiteserver.js']) {
    const res = await rawGet(path);
    assert.equal(res.status, 403, path);
    assert.doesNotMatch(res.body, /OUTSIDE-DIST-CONTENT|createServer/, path);
  }
});
