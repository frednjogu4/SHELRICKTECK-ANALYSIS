/*
 * scripts/test-network-guard.mjs — proof that a test run cannot leave this
 * machine. The targets below are reserved addresses that never reach a real
 * service (192.0.2.0/24 is documentation-only, ".invalid" never resolves),
 * so nothing is contacted even if the guard were missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { isLoopbackHost, networkGuardActive } from '../../scripts/test-network-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const guardPath = join(root, 'scripts', 'test-network-guard.mjs');
const skip = networkGuardActive ? false : 'AURUM_TEST_ALLOW_NETWORK=1 is set: the guard is switched off on request';

function connectError(options) {
  return new Promise((resolveError, reject) => {
    const socket = net.connect(options);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no error within 2 s — the connection was not refused locally')); }, 2000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(new Error('connected')); });
    socket.once('error', (error) => { clearTimeout(timer); resolveError(error); });
  });
}

test('only this machine counts as local', () => {
  for (const host of [undefined, null, '', 'localhost', 'LOCALHOST', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1', '0.0.0.0', 'app.localhost']) {
    assert.equal(isLoopbackHost(host), true, String(host));
  }
  for (const host of ['api.derivws.com', 'ws.derivws.com', 'query1.finance.yahoo.com', 'example.com', '192.0.2.1', '10.0.0.5', '192.168.1.20', '1.1.1.1', '2001:db8::1', 'localhost.example.com', '127.0.0.1.example.com', 'notlocalhost']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('a raw TCP connection to an outside address is refused at once', { skip }, async () => {
  const started = Date.now();
  const error = await connectError({ host: '192.0.2.1', port: 9 });
  assert.equal(error.code, 'ECONNREFUSED');
  assert.equal(error.blockedByTestNetworkGuard, true);
  assert.match(error.message, /test-network-guard/);
  assert.ok(Date.now() - started < 1000, 'refused locally, without waiting for a network timeout');

  const legacy = await new Promise((resolveError) => {
    const socket = new net.Socket();
    socket.once('error', resolveError);
    socket.connect(9, '192.0.2.1');
  });
  assert.equal(legacy.blockedByTestNetworkGuard, true, 'socket.connect(port, host) form');
});

test('fetch over http and https never leaves the machine (no DNS lookup either)', { skip }, async () => {
  /* Port 8080 on purpose: fetch itself refuses a few "bad" ports (9 among
     them) before any connection is attempted, which would prove nothing. */
  for (const url of ['http://192.0.2.1:8080/x', 'https://broker.invalid/v1/accounts', 'https://192.0.2.1/']) {
    const error = await fetch(url).then(() => null, (reason) => reason);
    assert.ok(error, `${url} must fail`);
    const cause = error.cause && error.cause.errors ? error.cause.errors[0] : error.cause;
    assert.equal(cause && cause.blockedByTestNetworkGuard, true, `${url}: ${cause && cause.code}`);
  }
});

test('a WebSocket client (the `ws` package the API server uses) is refused the same way', { skip }, async () => {
  const error = await new Promise((resolveError, reject) => {
    const socket = new WebSocket('wss://broker.invalid/ws/public');
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('no error within 2 s')); }, 2000);
    socket.once('open', () => { clearTimeout(timer); socket.terminate(); reject(new Error('opened')); });
    socket.once('error', (reason) => { clearTimeout(timer); resolveError(reason); });
  });
  assert.equal(error.blockedByTestNetworkGuard, true);
});

test('connections to this machine still work', { skip }, async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('local-ok'); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address();
    for (const host of ['127.0.0.1', 'localhost']) {
      const res = await fetch(`http://${host}:${port}/`);
      assert.equal(res.status, 200, host);
      assert.equal(await res.text(), 'local-ok');
    }
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('the test runner hands the guard to every process it starts', { skip }, (t) => {
  if (!String(process.env.NODE_OPTIONS || '').includes('test-network-guard')) {
    t.skip('this file was started directly; run `npm test` to check the runner wiring');
    return;
  }
  /* A grandchild started with the inherited environment and no flags of its own. */
  const child = spawnSync(process.execPath, ['-e', 'console.log(require("node:net").Socket.prototype.connect.name)'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'guardedConnect');
});

test('AURUM_TEST_ALLOW_NETWORK=1 is the only switch that turns the guard off', () => {
  const probe = 'import(process.argv[1]).then((m) => console.log(JSON.stringify({ active: m.networkGuardActive, connect: require("node:net").Socket.prototype.connect.name })))';
  const run = (value) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.AURUM_TEST_ALLOW_NETWORK;
    if (value !== undefined) env.AURUM_TEST_ALLOW_NETWORK = value;
    const child = spawnSync(process.execPath, ['-e', probe, 'file://' + guardPath.replace(/\\/g, '/').replace(/^([A-Za-z]:)/, '/$1')], { encoding: 'utf8', env });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  assert.deepEqual(run(undefined), { active: true, connect: 'guardedConnect' });
  for (const value of ['', '0', 'true', 'yes']) assert.equal(run(value).active, true, `"${value}" does not disable the guard`);
  const off = run('1');
  assert.equal(off.active, false);
  assert.notEqual(off.connect, 'guardedConnect', 'Node\'s own connect() is left in place');
});
