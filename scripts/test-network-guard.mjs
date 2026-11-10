/*
 * Test network guard — keeps the automated tests on this machine.
 *
 * Loaded into every test process (see scripts/run-node-tests.mjs and the
 * "test" script in package.json). While it is active, a TCP or TLS connection
 * to anything other than this machine is refused immediately, exactly like a
 * closed port (ECONNREFUSED). fetch(), http(s), WebSocket and the `ws`
 * package all go through this one function, so none of them can reach a
 * broker, a market-data provider or any other outside service from a test.
 *
 * Why: the suite must give the same answer offline, on a laptop and in CI,
 * and a test run must never contact a broker API. One existing test
 * (server/tests/risklimits.test.mjs, "diagnose") would otherwise send a dummy
 * token to api.derivws.com and open its public WebSocket on every run.
 *
 * Connections to this machine (localhost, 127.x.x.x, ::1, pipes) are untouched.
 *
 * To run the tests with real network access, as before this guard existed:
 *   AURUM_TEST_ALLOW_NETWORK=1 npm test
 */
import net from 'node:net';

const INSTALLED = Symbol.for('aurum.testNetworkGuard');
const LOOPBACK = /^(localhost|ip6-localhost|ip6-loopback|::1|::|0\.0\.0\.0|127(\.\d{1,3}){3}|::ffff:127(\.\d{1,3}){3})$/i;

export function isLoopbackHost(host) {
  if (host === undefined || host === null || host === '') return true; /* Node's default is localhost */
  const name = String(host).replace(/^\[|\]$/g, '');
  return LOOPBACK.test(name) || /\.localhost$/i.test(name);
}

/* Mirrors how net.Socket.prototype.connect reads its arguments. */
function connectionTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; /* already-normalised [options, callback] */
  if (first && typeof first === 'object') return first.path ? null : { host: first.host, port: first.port };
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null; /* pipe / socket path */
  return { host: typeof args[1] === 'string' ? args[1] : undefined, port: first };
}

export const networkGuardActive = process.env.AURUM_TEST_ALLOW_NETWORK !== '1';

if (networkGuardActive && !globalThis[INSTALLED]) {
  globalThis[INSTALLED] = true;
  const reported = new Set();
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = connectionTarget(args);
    if (!target || isLoopbackHost(target.host)) return connect.apply(this, args);
    const where = `${target.host}:${target.port}`;
    if (!reported.has(where)) {
      reported.add(where);
      process.stderr.write(`[test-network-guard] blocked outbound connection to ${where} (set AURUM_TEST_ALLOW_NETWORK=1 to allow)\n`);
    }
    const error = Object.assign(
      new Error(`connect ECONNREFUSED ${where} (blocked by scripts/test-network-guard.mjs: tests do not use the network)`),
      { code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: String(target.host), port: Number(target.port) || undefined, blockedByTestNetworkGuard: true }
    );
    process.nextTick(() => this.destroy(error));
    return this;
  };
}
