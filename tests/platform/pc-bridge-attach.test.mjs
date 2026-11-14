/*
 * bridge/mt5_bridge.py — what the PC bridge says when it cannot attach to
 * MetaTrader 5, and the three facts about the app that its wording and its
 * waiting times rest on:
 *
 *   1. the Exness sign-in form replaces a bridge message that contains one of
 *      five words by its own "Bridge not reachable" help;
 *   2. the app waits 8 seconds for the answer to a request, and 6 seconds from
 *      opening its connection for the answer to the login;
 *   3. the app repeats a failed login once over HTTP straight away.
 *
 * The same facts decide how the bridge logs MetaTrader 5 in with the account
 * entered in the app when MetaTrader 5 is not logged in: within one answer
 * while there is time for it, otherwise at the app's repeat.
 *
 * The page the PC serves (bridge/app.html) is a copy of the built page
 * (tests/platform/pc-page.test.mjs), so the same facts are checked in their
 * built, minified form as well.
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

test('the attaching one login asks for is over before the app stops waiting for the answer', () => {
  const loginWait = pythonNumber('_LOGIN_ATTACH_WAIT_MS');
  const startWait = pythonNumber('_START_ATTACH_WAIT_MS');

  const socketFrame = bridgeJs.match(/reject\(new Error\('bridge timeout'\)\); \}, (\d+)\)/);
  const httpFrame = bridgeJs.match(/function httpFrame\(msg\) \{[\s\S]*?AbortSignal\.timeout\((\d+)\)/);
  assert.ok(socketFrame && httpFrame, 'src/bridge.js no longer has the two frame timers this test reads');
  const appWaits = Math.min(Number(socketFrame[1]), Number(httpFrame[1]));
  assert.equal(appWaits, 8000);
  assert.ok(loginWait >= 1000 && loginWait <= appWaits - 2000, `login attach ${loginWait} ms, the app waits ${appWaits} ms`);
  assert.equal(startWait, 60000);

  /* the page the PC serves: same 8 seconds, in the minified form */
  assert.match(pcPage, /new Error\("bridge timeout"\)\)\},8e3\)/);
  assert.match(pcPage, /AbortSignal\.timeout\(8e3\)/);

  /* The answer to the login over the socket has less: 6 seconds from the moment the app opens its
     connection. After that the app gives the socket up and shows its own "Bridge not reachable" help. */
  const socketLogin = bridgeJs.match(/t = setTimeout\(\(\) => fail\('Bridge timeout[^']*' \+ url \+ '\?'\), (\d+)\);/);
  assert.ok(socketLogin, 'connectBridge() in src/bridge.js no longer has the timer this test reads');
  assert.equal(Number(socketLogin[1]), 6000);
  assert.match(pcPage, /Bridge timeout[^"]*"\+\w+\+"\?"\),6e3\)/);
  assert.ok(loginWait < Number(socketLogin[1]), `login attach ${loginWait} ms, the app gives the socket up after ${socketLogin[1]} ms`);

  /* The attach with the account entered in the app is part of that same answer, and MetaTrader's own
     login() follows it: it ends before the attaching time is up, and is not begun without time for it. */
  const accountEnd = pythonNumber('_ACCOUNT_ATTACH_END_MS');
  const accountMin = pythonNumber('_ACCOUNT_ATTACH_MIN_MS');
  assert.ok(accountEnd >= 3000 && accountEnd <= loginWait - 1000, `the attach with the account ends after ${accountEnd} ms`);
  assert.ok(accountMin >= 1000 && accountMin <= accountEnd / 2, `the attach with the account needs ${accountMin} ms`);
  assert.match(bridge, /left_ms = min\(wait_ms, _ACCOUNT_ATTACH_END_MS\) - \(_now\(\) - began\) \* 1000\.0\n {8}if left_ms < _ACCOUNT_ATTACH_MIN_MS:\n {12}return False/);

  /* the attach at bridge start stays without an argument: its wait comes from _ATTACH_STATE, and it has no account to give */
  assert.match(bridge, /\n {4}_ATTACH_STATE\["wait_ms"\] = _START_ATTACH_WAIT_MS[^\n]*\n {4}attached = attach_terminal\(\)\n {4}_ATTACH_STATE\["wait_ms"\] = _LOGIN_ATTACH_WAIT_MS\n/);
  assert.match(bridge, /\n_ATTACH_STATE = \{"wait_ms": _LOGIN_ATTACH_WAIT_MS, /);
});

test('the app repeats a failed login at once over HTTP, and the bridge does not contact MetaTrader 5 twice for it', () => {
  const fail = bridgeJs.match(/const fail = \(msg\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(fail, 'connectBridge() in src/bridge.js no longer has the fail() this test reads');
  assert.match(fail[0], /if \(!usedHttp\) \{[^}]*usedHttp = true;[\s\S]*?loginSeq\(\);\s*return;/);
  const quiet = pythonNumber('_ATTACH_REPEAT_QUIET_S');
  assert.ok(quiet >= 1 && quiet <= 5, `quiet time ${quiet} s`);
  /* The one login that is not held back: MetaTrader 5 has just said "not logged in" to an attach without
     an account, and the repeat brings the account for the attach that has not been made. */
  assert.match(bridge, /time\.time\(\) - \(recent\.get\("at"\) or 0\.0\) < _ATTACH_REPEAT_QUIET_S:\n(?: {8}#[^\n]*\n)+ {8}if not account_at_once or recent\.get\("with_account"\):\n {12}return False/);
  assert.match(bridge, /\n {4}account_at_once = account is not None and _CONNECTOR_TAKES_TIMEOUT and _wants_account\(recent\)\n/);

  /* That repeat has its own time. When the login over the socket is answered, with an error as well, the app
     clears its 6-second timer before it repeats; the repeat is then limited by the 8 seconds of a request. */
  const answered = bridgeJs.match(/\.catch\(\(e\) => \{ if \(t\) clearTimeout\(t\); fail\(String\(e\.message \|\| e\)\); \}\);/);
  assert.ok(answered, 'connectBridge() in src/bridge.js no longer clears its timer before it repeats a failed login');
  const repeatWait = Number(bridgeJs.match(/function httpFrame\(msg\) \{[\s\S]*?AbortSignal\.timeout\((\d+)\)/)[1]);
  assert.ok(pythonNumber('_ACCOUNT_ATTACH_END_MS') <= repeatWait - 2000, `the repeat waits ${repeatWait} ms`);
});

test('a login gives its account to the attach, a bound bridge is asked first, and the bridge start has no account', () => {
  const login = bridge.slice(bridge.indexOf('def handle_login(msg):'), bridge.indexOf('def _app_safe(text):'));
  const bound = login.indexOf('if _bound_to_another_account(login, server):');
  const attach = login.indexOf('if not attach_terminal((login, password, server)):');
  const ownLogin = login.indexOf('ok = mt5.login(login, password=password, server=server)');
  assert.ok(bound > 0 && attach > bound, 'the bound account is checked before MetaTrader 5 can be given another one');
  /* what follows the attach is unchanged: MetaTrader's own login() with the same three, then the identity checks */
  assert.ok(ownLogin > attach);
  assert.ok(login.indexOf('actual_server.casefold() != server.casefold()') > ownLogin);
  assert.ok(login.indexOf('"exness" not in company.casefold()') > ownLogin);

  /* only the login calls the attach with an account */
  const calls = [...bridge.matchAll(/(?<!def )\battach_terminal\(([^)\n]*)\)?/g)].map((call) => call[1]);
  assert.deepEqual(calls.filter((argument) => argument !== ''), ['(login, password, server']);
  assert.ok(calls.includes(''), 'the attach at bridge start');

  /* the account goes to MetaTrader 5 under the names MetaQuotes documents for initialize() */
  assert.match(bridge, /named = \{"login": int\(login\), "password": str\(password\), "server": str\(server\)\}/);
  assert.match(bridge, /return mt5\.initialize\(\*where, timeout=int\(wait_ms\), \*\*named\), wait_ms \/ 1000\.0/);
  /* never without a waiting time: a connector that refuses 'timeout' is not given the account at all */
  assert.match(bridge, /except TypeError:\n {8}if account is not None:\n {12}raise\n {8}ok = mt5\.initialize\(\*where\)[^\n]*\n {8}_CONNECTOR_TAKES_TIMEOUT = False\n/);
  assert.match(bridge, /if account is None or not _CONNECTOR_TAKES_TIMEOUT or not _wants_account\(_ATTACH_FAILURE\):\n {16}return False/);
  /* and neither the password nor the account number is passed on from what MetaTrader 5 or its connector says */
  assert.equal((bridge.match(/_without_account\(/g) || []).length, 3);
});

test('the reason for a failed attach is read before mt5.shutdown() and reported by the login', () => {
  const attach = bridge.slice(bridge.indexOf('def _attach_terminal_once(wait_ms, account=None, account_follows=False):'), bridge.indexOf('try:\n    from websockets.datastructures import Headers'));
  assert.ok(attach.length > 200);
  const read = attach.indexOf('code, text = _last_error()');
  const shutdown = attach.indexOf('mt5.shutdown()');
  assert.ok(read > 0 && shutdown > read, 'the error must be read before mt5.shutdown() sets it back to (1, "Success")');

  const login = bridge.slice(bridge.indexOf('def handle_login(msg):'), bridge.indexOf('def _app_safe(text):'));
  assert.match(login, /if not attach_terminal\(\(login, password, server\)\):\n {12}busy = _attach_busy_message\(\)\n {12}if busy or _ATTACH_FAILURE is not None:\n {16}return \{\*\*err\(busy or _attach_failure_message\(\)\)\}/);
  assert.doesNotMatch(login, /attach_terminal\([^\n]*\):\n\s+code, desc = _last_error\(\)/);
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
  assert.ok(ran && Number(ran[1]) >= 59, `Python tests run: ${ran ? ran[1] : 'none'}`);
  assert.match(output, /test_a_failed_attach_reports_the_reason_and_not_code_1_success .*ok/);
  assert.match(output, /test_a_terminal_that_is_not_logged_in_is_given_the_account_entered_in_the_app .*ok/);
  assert.match(output, /test_a_connector_that_takes_no_waiting_time_is_not_given_the_account .*ok/);
  assert.match(output, /test_the_pc_serves_the_built_page_and_its_files_byte_for_byte .*ok/);
});
