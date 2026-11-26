import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPortListener,
  PACKAGE_ROOT_FILES,
  runLocalUpdate,
  sha256File
} from '../../scripts/local-updater.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rawBytes = readFileSync(join(root, 'UPDATE_LOCAL_APP.bat'));
const rawText = rawBytes.toString('utf8');
const psScriptBytes = readFileSync(join(root, 'bridge', 'UPDATE_LOCAL_APP.ps1'));
const psScriptText = psScriptBytes.toString('utf8');
const MARKER = '# === AURUM_PS_UPDATER_PAYLOAD ===';

function checkBalancedPowerShell(psSource) {
  const stack = [];
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const closers = new Set(['}', ')', ']']);
  let inSingle = false;
  let inDouble = false;
  let inComment = false;

  for (let i = 0; i < psSource.length; i += 1) {
    const ch = psSource[i];
    const next = psSource[i + 1] || '';

    if (inComment) {
      if (ch === '\n') inComment = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && next === "'") { i += 1; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '`') { i += 1; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === '#') { inComment = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }

    if (pairs[ch]) {
      stack.push({ ch, expected: pairs[ch], pos: i });
    } else if (closers.has(ch)) {
      const top = stack.pop();
      assert.ok(top, `Unexpected closer '${ch}' at offset ${i}`);
      assert.equal(ch, top.expected, `Mismatched '${top.ch}' (at ${top.pos}) closed by '${ch}' (at ${i})`);
    }
  }

  assert.equal(inSingle, false, 'Unterminated single-quoted string in PowerShell payload');
  assert.equal(inDouble, false, 'Unterminated double-quoted string in PowerShell payload');
  assert.equal(stack.length, 0, `Unclosed delimiter(s) in PowerShell payload: ${JSON.stringify(stack)}`);
}

function makeAurumInstallFixture(baseDir, buildId, extraPayload = 'v1', includeDist = false) {
  mkdirSync(join(baseDir, 'bridge', 'pwa'), { recursive: true });
  mkdirSync(join(baseDir, 'server', 'lib'), { recursive: true });
  mkdirSync(join(baseDir, 'server', 'data'), { recursive: true });
  writeFileSync(join(baseDir, 'package.json'), JSON.stringify({ name: 'aurum-workspace', version: '1.0.0' }));
  writeFileSync(join(baseDir, 'START_ALL_LOCAL.bat'), '@echo off\r\necho start\r\n');
  writeFileSync(join(baseDir, 'bridge', 'mt5_bridge.py'), `# bridge ${extraPayload}\n`);
  const html = `<!DOCTYPE html><html><head><meta name="aurum-build" content="${buildId}"></head><body>${extraPayload}</body></html>`;
  const manifest = JSON.stringify({ id: buildId, version: '1.0.0', git: 'abcdef123456', builtAt: '2026-11-23T00:00:00Z' });
  const sw = `const VERSION = 'aurum-local-${buildId}';\n`;
  writeFileSync(join(baseDir, 'bridge', 'app.html'), html);
  writeFileSync(join(baseDir, 'bridge', 'pwa', 'build.json'), manifest);
  writeFileSync(join(baseDir, 'bridge', 'pwa', 'sw.js'), sw);
  if (includeDist) {
    mkdirSync(join(baseDir, 'dist'), { recursive: true });
    writeFileSync(join(baseDir, 'dist', 'index.html'), html);
    writeFileSync(join(baseDir, 'dist', 'build.json'), manifest);
    writeFileSync(join(baseDir, 'dist', 'sw.js'), sw);
  }
  writeFileSync(join(baseDir, 'server', 'server.js'), `// server ${extraPayload}\n`);
  writeFileSync(join(baseDir, 'server', 'lib', 'strength.js'), `// strength ${extraPayload}\n`);
}

test('UPDATE_LOCAL_APP.bat and bridge/UPDATE_LOCAL_APP.ps1 use pure ASCII CRLF and share the exact PowerShell payload', () => {
  for (const [label, buf] of [['UPDATE_LOCAL_APP.bat', rawBytes], ['bridge/UPDATE_LOCAL_APP.ps1', psScriptBytes]]) {
    for (let i = 0; i < buf.length; i += 1) {
      assert.ok(buf[i] < 128, `${label}: non-ASCII byte ${buf[i]} at offset ${i}`);
      if (buf[i] === 0x0a) {
        assert.equal(buf[i - 1], 0x0d, `${label}: bare LF without CR at byte offset ${i}`);
      }
    }
  }

  const idx = rawText.indexOf(MARKER);
  assert.ok(idx > 0, 'PowerShell payload marker missing in UPDATE_LOCAL_APP.bat');
  assert.equal(rawText.indexOf(MARKER, idx + 1), -1, 'Marker must appear literally only once');
  assert.equal(rawText.slice(idx), psScriptText, 'UPDATE_LOCAL_APP.bat embedded payload must equal bridge/UPDATE_LOCAL_APP.ps1');

  const batHeader = rawText.slice(0, idx);
  assert.match(batHeader, /\(\r\n[\s\S]*powershell\.exe[\s\S]*exit \/b 1[\s\S]*exit \/b 0\r\n\s*\)\r\n\)\r\n/);
  const blockBody = batHeader.slice(batHeader.indexOf('(\r\n'));
  for (const line of blockBody.split('\r\n')) {
    if (/^\s*echo\b/i.test(line)) {
      assert.doesNotMatch(line, /[()]/, `Unescaped parenthesis inside parenthesized .bat echo crashes cmd.exe: ${line}`);
    }
  }
});

test('PowerShell updater payload has balanced syntax, TLS 1.2, UseBasicParsing, backup, rollback, dry-run, and canonical GitHub URL', () => {
  const ps = rawText.slice(rawText.indexOf(MARKER));
  checkBalancedPowerShell(ps);

  assert.match(ps, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(ps, /\$ProgressPreference\s*=\s*'SilentlyContinue'/);
  assert.match(ps, /SecurityProtocolType\]::Tls12/);
  assert.match(ps, /Invoke-WebRequest\s+-UseBasicParsing/);
  assert.match(ps, /--dry-run/);
  assert.match(ps, /Restore-AurumBackup/);
  assert.match(ps, /backup-manifest\.json/);
  assert.match(ps, /local-update-/);
  assert.ok(ps.includes('https://codeload.github.com/frednjogu4/SHELRICKTECK-ANALYSIS/zip/refs/heads/main'));
  assert.ok(ps.includes('http://127.0.0.1:8788/build.json'));
  assert.ok(ps.includes('http://127.0.0.1:4100/api/health'));
});

test('updater preserves local secrets/data, refuses unrelated processes, never stops MT5, and never exposes ports', () => {
  const ps = rawText.slice(rawText.indexOf(MARKER));

  for (const preserved of [
    'bridge/bridge_token.txt',
    'bridge/terminal_path.txt',
    'bridge/python_runtime.txt',
    'server/data/',
    'logs/',
    'node_modules/',
    'backups/',
    '.env',
    '.env.local'
  ]) {
    assert.ok(ps.includes(preserved), `Missing preserved path guard: ${preserved}`);
  }

  assert.match(ps, /terminal\(64\)\?/);
  assert.match(ps, /preservedBefore/);
  assert.match(ps, /Safety check failed: preserved local file/);
  assert.match(ps, /Refusing to terminate unrelated process/);
  assert.match(ps, /Get-ListeningPids 8788/);
  assert.match(ps, /Get-ListeningPids 4100/);
  assert.match(ps, /RUN_LOCAL_API\\\.bat/);
  assert.doesNotMatch(rawText, /netsh\s+interface\s+portproxy/i);
  assert.doesNotMatch(rawText, /0\.0\.0\.0/);
  assert.doesNotMatch(ps, /Get-Content[^\r\n]*bridge_token\.txt/);
  assert.doesNotMatch(ps, /-WindowStyle\s+Hidden/i, 'Hidden WindowStyle suppresses MT5 and Chrome GUI windows on Windows');
  assert.match(ps, /START_MT5_IF_CLOSED\.ps1/);
});

test('updater file lists match scripts/refresh_local_update_packages.py across Python, PowerShell, and Node', () => {
  const refreshPy = readFileSync(join(root, 'scripts', 'refresh_local_update_packages.py'), 'utf8');
  const ps = rawText.slice(rawText.indexOf(MARKER));

  const pyRootBlock = /PACKAGE_ROOT_FILES\s*=\s*\(([\s\S]*?)\)/.exec(refreshPy);
  assert.ok(pyRootBlock, 'PACKAGE_ROOT_FILES not found in refresh_local_update_packages.py');
  const pyFiles = [...pyRootBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const psRootBlock = /\$packageRootFiles\s*=\s*@\(([\s\S]*?)\)/.exec(ps);
  assert.ok(psRootBlock, '$packageRootFiles not found in UPDATE_LOCAL_APP.bat');
  const psFiles = [...psRootBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  assert.deepEqual(psFiles.slice().sort(), pyFiles.slice().sort());
  assert.deepEqual([...PACKAGE_ROOT_FILES].sort(), pyFiles.slice().sort());
  assert.ok(pyFiles.includes('UPDATE_LOCAL_APP.bat'));
});

test('classifyPortListener stops only verified AURUM processes and rejects unrelated listeners on 8788/8787/4100', () => {
  assert.equal(
    classifyPortListener({ port: 8788, name: 'terminal64.exe', commandLine: 'C:\\MT5\\terminal64.exe' }).action,
    'ignore_mt5'
  );
  assert.equal(
    classifyPortListener({ port: 8788, name: 'python.exe', commandLine: 'python.exe "C:\\Aurum\\bridge\\mt5_bridge.py"' }).action,
    'stop_aurum'
  );
  assert.equal(
    classifyPortListener({ port: 8788, name: 'python.exe', commandLine: 'python.exe -m http.server 8788' }).action,
    'abort_unrelated'
  );
  assert.equal(
    classifyPortListener({ port: 4100, name: 'node.exe', commandLine: 'node C:\\other-app\\index.js' }).action,
    'abort_unrelated'
  );
  assert.equal(
    classifyPortListener({ port: 4100, name: 'node.exe', commandLine: 'node "C:\\Aurum\\server\\server.js"' }).action,
    'stop_aurum'
  );
});

test('separate-copy simulation: --dry-run, unrelated-port abort, full backup+update, and automatic rollback on failure', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'aurum-updater-test-'));
  try {
    const installDir = join(sandbox, 'installed-copy');
    const candidateDir = join(sandbox, 'candidate-release');
    makeAurumInstallFixture(installDir, '1111111111111', 'old-release', true);
    makeAurumInstallFixture(candidateDir, '2222222222222', 'new-release', false);

    const origDistIndexSha = sha256File(join(installDir, 'dist', 'index.html'));

    /* Seed local secrets, credentials, env, and historical data that MUST never be touched */
    const tokenPath = join(installDir, 'bridge', 'bridge_token.txt');
    const termPath = join(installDir, 'bridge', 'terminal_path.txt');
    const envPath = join(installDir, '.env.local');
    const journalPath = join(installDir, 'server', 'data', 'journal.json');
    writeFileSync(tokenPath, 'local-bridge-secret-do-not-touch\n');
    writeFileSync(termPath, 'C:\\Program Files\\MetaTrader 5 EXNESS\\terminal64.exe\n');
    writeFileSync(envPath, 'LOCAL_SETTING=keep\n');
    writeFileSync(journalPath, JSON.stringify({ trades: [{ id: 1, symbol: 'XAU/USD' }] }));

    const tokenSha = sha256File(tokenPath);
    const termSha = sha256File(termPath);
    const envSha = sha256File(envPath);
    const journalSha = sha256File(journalPath);
    const origAppSha = sha256File(join(installDir, 'bridge', 'app.html'));

    /* 1. --dry-run touches zero target files and writes a secret-free log */
    const dryRes = await runLocalUpdate({
      targetRoot: installDir,
      source: candidateDir,
      dryRun: true
    });
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.previousBuildId, '1111111111111');
    assert.equal(dryRes.targetBuildId, '2222222222222');
    assert.ok(dryRes.changedCount > 0);
    assert.equal(sha256File(join(installDir, 'bridge', 'app.html')), origAppSha, 'dry-run must not modify app.html');
    assert.ok(!readFileSync(dryRes.logPath, 'utf8').includes('local-bridge-secret-do-not-touch'));

    /* 2. Unrelated process on port 8788 aborts before stopping anything or altering files */
    let stoppedCalled = false;
    await assert.rejects(
      runLocalUpdate({
        targetRoot: installDir,
        source: candidateDir,
        inspectListeners: async () => [{
          port: 8788,
          pid: 9999,
          name: 'custom-server.exe',
          commandLine: 'custom-server.exe --port 8788'
        }],
        stopProcesses: async () => { stoppedCalled = true; }
      }),
      /unrelated process/i
    );
    assert.equal(stoppedCalled, false);
    assert.equal(sha256File(join(installDir, 'bridge', 'app.html')), origAppSha);

    /* 3. Fault during post-restart /build.json verification automatically rolls back to 1111111111111 */
    let restartedWithBuildId = null;
    const rollbackRes = await runLocalUpdate({
      targetRoot: installDir,
      source: candidateDir,
      verifyTimeoutMs: 400,
      inspectListeners: async () => [{
        port: 8788,
        pid: 4242,
        name: 'python.exe',
        commandLine: 'python.exe "C:\\Aurum\\bridge\\mt5_bridge.py"'
      }],
      stopProcesses: async () => {},
      restartServices: async ({ targetRoot }) => {
        restartedWithBuildId = JSON.parse(readFileSync(join(targetRoot, 'bridge', 'pwa', 'build.json'), 'utf8')).id;
      },
      fetchBuildJson: async () => ({ id: 'wrong_stale_build' })
    });
    assert.equal(rollbackRes.ok, false);
    assert.equal(rollbackRes.rolledBack, true);
    assert.equal(rollbackRes.restoredBuildId, '1111111111111');
    assert.equal(restartedWithBuildId, '1111111111111', 'rollback must restart service with restored version');
    assert.equal(sha256File(join(installDir, 'bridge', 'app.html')), origAppSha, 'rollback must restore exact previous app.html');
    assert.equal(sha256File(join(installDir, 'dist', 'index.html')), origDistIndexSha, 'rollback must restore exact previous dist/index.html');
    assert.equal(sha256File(tokenPath), tokenSha);
    assert.equal(sha256File(journalPath), journalSha);
    assert.match(readFileSync(rollbackRes.logPath, 'utf8'), /\[ROLLBACK\]/);

    /* 4. Valid update creates backup, updates canonical files, verifies /build.json, preserves secrets & data */
    const okRes = await runLocalUpdate({
      targetRoot: installDir,
      source: candidateDir,
      verifyTimeoutMs: 1000,
      inspectListeners: async () => [],
      restartServices: async () => {},
      fetchBuildJson: async () => ({ id: '2222222222222' })
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.rolledBack, false);
    assert.equal(okRes.activeBuildId, '2222222222222');
    assert.ok(existsSync(join(okRes.backupDir, 'backup-manifest.json')));
    assert.equal(
      JSON.parse(readFileSync(join(installDir, 'bridge', 'pwa', 'build.json'), 'utf8')).id,
      '2222222222222'
    );
    assert.equal(
      JSON.parse(readFileSync(join(installDir, 'dist', 'build.json'), 'utf8')).id,
      '2222222222222',
      'dist/build.json must sync to the new Build ID alongside bridge/pwa/build.json'
    );
    assert.equal(
      sha256File(join(installDir, 'dist', 'index.html')),
      sha256File(join(installDir, 'bridge', 'app.html')),
      'dist/index.html must equal bridge/app.html after update'
    );
    assert.equal(sha256File(tokenPath), tokenSha, 'bridge_token.txt must be untouched');
    assert.equal(sha256File(termPath), termSha, 'terminal_path.txt must be untouched');
    assert.equal(sha256File(envPath), envSha, '.env.local must be untouched');
    assert.equal(sha256File(journalPath), journalSha, 'server/data/journal.json must be untouched');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
