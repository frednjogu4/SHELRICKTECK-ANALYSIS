/*
 * bridge/mt5_bridge.py — what the PC bridge says when it cannot attach to
 * MetaTrader 5, and the three facts about the app that its wording and its
 * waiting times rest on:
 *
 *   1. the Exness sign-in form replaces a bridge message that contains one of
 *      five words by its own "Bridge not reachable" help;
 *   2. the app waits 8 seconds for the answer to a login;
 *   3. the app repeats a failed login once over HTTP straight away.
 *
 * The page the PC serves (bridge/app.html) is an older build than src/, so
 * the same facts are checked in that file as well.
 *
 * The bridge's behaviour itself is tested in Python
 * (tests/test_mt5_bridge_attach.py, against a stand-in for the Windows-only
 * MetaTrader5 package). Those tests are run from here when a Python
 * interpreter is installed. No terminal, broker or network is involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const bridge = read('bridge', 'mt5_bridge.py');
const mainJs = read('src', 'main.js');
const bridgeJs = read('src', 'bridge.js');
const pcPage = read('bridge', 'app.html');
const builtPage = read('dist', 'index.html');

function pythonNumber(name) {
  const found = bridge.match(new RegExp(`^${name} = ([0-9.]+)`, 'm'));
  assert.ok(found, `${name} is not set in bridge/mt5_bridge.py`);
  return Number(found[1]);
}

test('the bridge rewords exactly the words for which the app shows its own help', () => {
  const inApp = mainJs.match(/\/([a-z|]+)\/i\.test\(m\)\s*\?\s*'<b>Bridge not reachable\.<\/b>/);
  assert.ok(inApp, 'the Exness sign-in form no longer replaces a message by "Bridge not reachable"');
  const appWords = inApp[1].split('|');
  assert.deepEqual(appWords, ['unreachable', 'timeout', 'refused', 'closed', 'blocked']);

  const list = bridge.match(/_APP_REPLACES_WORDS = \(\n((?: {4}\("[a-z]+", "[a-z -]+"\),\n)+)\)/);
  assert.ok(list, '_APP_REPLACES_WORDS is not the list of pairs this test reads');
  const pairs = [...list[1].matchAll(/\("([a-z]+)", "([a-z -]+)"\)/g)].map((pair) => [pair[1], pair[2]]);
  assert.deepEqual(pairs.map((pair) => pair[0]), appWords);

  /* a replacement must not bring one of the words back */
  const replaces = new RegExp(appWords.join('|'), 'i');
  for (const [word, other] of pairs) assert.doesNotMatch(other, replaces, `"${word}" is reworded to "${other}"`);

  /* the page the PC serves and the built page decide in the same way */
  const sameCheck = `/${appWords.join('|')}/i.test(`;
  assert.ok(pcPage.includes(sameCheck), 'bridge/app.html replaces other words than src/main.js');
  assert.ok(builtPage.includes(sameCheck), 'dist/index.html replaces other words than src/main.js');
});

test('an attach asked for by a login is over before the app stops waiting for the answer', () => {
  const loginWait = pythonNumber('_LOGIN_ATTACH_WAIT_MS');
  const startWait = pythonNumber('_START_ATTACH_WAIT_MS');

  const socketFrame = bridgeJs.match(/reject\(new Error\('bridge timeout'\)\); \}, (\d+)\)/);
  const httpFrame = bridgeJs.match(/function httpFrame\(msg\) \{[\s\S]*?AbortSignal\.timeout\((\d+)\)/);
  assert.ok(socketFrame && httpFrame, 'src/bridge.js no longer has the two frame timers this test reads');
  const appWaits = Math.min(Number(socketFrame[1]), Number(httpFrame[1]));
  assert.equal(appWaits, 8000);
  assert.ok(loginWait >= 1000 && loginWait <= appWaits - 2000, `login attach ${loginWait} ms, the app waits ${appWaits} ms`);
  assert.equal(startWait, 60000);

  /* the PC page: same 8 seconds, in the minified form */
  assert.match(pcPage, /new Error\("bridge timeout"\)\)\},8e3\)/);
  assert.match(pcPage, /AbortSignal\.timeout\(8e3\)/);

  /* both attach calls stay without an argument: the wait comes from _ATTACH_STATE */
  assert.match(bridge, /\n {4}_ATTACH_STATE\["wait_ms"\] = _START_ATTACH_WAIT_MS[^\n]*\n {4}attached = attach_terminal\(\)\n {4}_ATTACH_STATE\["wait_ms"\] = _LOGIN_ATTACH_WAIT_MS\n/);
  assert.match(bridge, /\n_ATTACH_STATE = \{"wait_ms": _LOGIN_ATTACH_WAIT_MS, /);
});

test('the app repeats a failed login at once over HTTP, and the bridge does not contact MetaTrader 5 twice for it', () => {
  const fail = bridgeJs.match(/const fail = \(msg\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(fail, 'connectBridge() in src/bridge.js no longer has the fail() this test reads');
  assert.match(fail[0], /if \(!usedHttp\) \{[^}]*usedHttp = true;[\s\S]*?loginSeq\(\);\s*return;/);
  const quiet = pythonNumber('_ATTACH_REPEAT_QUIET_S');
  assert.ok(quiet >= 1 && quiet <= 5, `quiet time ${quiet} s`);
  assert.match(bridge, /time\.time\(\) - \(recent\.get\("at"\) or 0\.0\) < _ATTACH_REPEAT_QUIET_S:\n {8}return False/);
});

test('the reason for a failed attach is read before mt5.shutdown() and reported by the login', () => {
  const attach = bridge.slice(bridge.indexOf('def _attach_terminal_once(wait_ms):'), bridge.indexOf('try:\n    from websockets.datastructures import Headers'));
  assert.ok(attach.length > 200);
  const read = attach.indexOf('code, text = _last_error()');
  const shutdown = attach.indexOf('mt5.shutdown()');
  assert.ok(read > 0 && shutdown > read, 'the error must be read before mt5.shutdown() sets it back to (1, "Success")');

  const login = bridge.slice(bridge.indexOf('def handle_login(msg):'), bridge.indexOf('def _app_safe(text):'));
  assert.match(login, /if not attach_terminal\(\):\n {12}busy = _attach_busy_message\(\)\n {12}if busy or _ATTACH_FAILURE is not None:\n {16}return \{\*\*err\(busy or _attach_failure_message\(\)\)\}/);
  assert.doesNotMatch(login, /attach_terminal\(\):\n\s+code, desc = _last_error\(\)/);
  assert.ok(!bridge.includes('Cannot attach to the configured MetaTrader 5 terminal (step terminal, code {code}: {desc})'));
});

function findPython() {
  for (const command of [['python3'], ['python'], ['py', '-3']]) {
    const probe = spawnSync(command[0], [...command.slice(1), '--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0 && /Python 3\./.test(`${probe.stdout}${probe.stderr}`)) return command;
  }
  return null;
}

test('the Python tests of the PC bridge pass', (t) => {
  const python = findPython();
  if (!python) { t.skip('no Python 3 interpreter on this machine'); return; }
  const run = spawnSync(python[0], [...python.slice(1), '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 120000
  });
  const output = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 0, output.slice(-3000));
  assert.match(output, /\nOK\b/);
  const ran = output.match(/Ran (\d+) tests? in/);
  assert.ok(ran && Number(ran[1]) >= 44, `Python tests run: ${ran ? ran[1] : 'none'}`);
  assert.match(output, /test_a_failed_attach_reports_the_reason_and_not_code_1_success .*ok/);
});
