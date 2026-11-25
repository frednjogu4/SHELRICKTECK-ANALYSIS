import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rawBytes = readFileSync(join(root, 'UPDATE_LOCAL_APP.bat'));
const rawText = rawBytes.toString('utf8');
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

test('UPDATE_LOCAL_APP.bat uses pure ASCII CRLF and exits inside a compound block before the PS payload', () => {
  for (let i = 0; i < rawBytes.length; i += 1) {
    assert.ok(rawBytes[i] < 128, `Non-ASCII byte ${rawBytes[i]} at offset ${i}`);
    if (rawBytes[i] === 0x0a) {
      assert.equal(rawBytes[i - 1], 0x0d, `Bare LF without CR at byte offset ${i}`);
    }
  }

  const idx = rawText.indexOf(MARKER);
  assert.ok(idx > 0, 'PowerShell payload marker missing');
  assert.equal(rawText.indexOf(MARKER, idx + 1), -1, 'Marker must appear literally only once');

  const batHeader = rawText.slice(0, idx);
  assert.match(batHeader, /\(\r\n\s*powershell\.exe[\s\S]*exit \/b 1[\s\S]*exit \/b 0\r\n\s*\)\r\n\)\r\n/);
});

test('PowerShell updater payload has balanced syntax, TLS 1.2, UseBasicParsing, and canonical GitHub main URL', () => {
  const ps = rawText.slice(rawText.indexOf(MARKER));
  checkBalancedPowerShell(ps);

  assert.match(ps, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(ps, /\$ProgressPreference\s*=\s*'SilentlyContinue'/);
  assert.match(ps, /SecurityProtocolType\]::Tls12/);
  assert.match(ps, /Invoke-WebRequest\s+-UseBasicParsing/);
  assert.ok(ps.includes('https://codeload.github.com/frednjogu4/SHELRICKTECK-ANALYSIS/zip/refs/heads/main'));
  assert.ok(ps.includes('http://127.0.0.1:8788/build.json'));
  assert.ok(ps.includes('http://127.0.0.1:4100/api/health'));
});

test('updater preserves local secrets/data, never stops MT5, never exposes ports, and restarts both 4100 and 8788', () => {
  const ps = rawText.slice(rawText.indexOf(MARKER));

  for (const preserved of [
    'bridge/bridge_token.txt',
    'bridge/terminal_path.txt',
    'bridge/python_runtime.txt',
    'server/data/',
    'logs/',
    'node_modules/',
    '.env',
    '.env.local',
  ]) {
    assert.ok(ps.includes(preserved), `Missing preserved path guard: ${preserved}`);
  }

  assert.match(ps, /terminal\(64\)\?/);
  assert.match(ps, /preservedBefore/);
  assert.match(ps, /Safety check failed: local file/);
  assert.match(ps, /Get-ListeningPids 8788/);
  assert.match(ps, /Get-ListeningPids 4100/);
  assert.match(ps, /RUN_LOCAL_API\\\.bat/);
  assert.doesNotMatch(rawText, /netsh\s+interface\s+portproxy/i);
  assert.doesNotMatch(rawText, /0\.0\.0\.0/);
  assert.doesNotMatch(ps, /Get-Content[^\r\n]*bridge_token\.txt/);
});

test('updater file lists match scripts/refresh_local_update_packages.py', () => {
  const refreshPy = readFileSync(join(root, 'scripts', 'refresh_local_update_packages.py'), 'utf8');
  const ps = rawText.slice(rawText.indexOf(MARKER));

  const pyRootBlock = /PACKAGE_ROOT_FILES\s*=\s*\(([\s\S]*?)\)/.exec(refreshPy);
  assert.ok(pyRootBlock, 'PACKAGE_ROOT_FILES not found in refresh_local_update_packages.py');
  const pyFiles = [...pyRootBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const psRootBlock = /\$packageRootFiles\s*=\s*@\(([\s\S]*?)\)/.exec(ps);
  assert.ok(psRootBlock, '$packageRootFiles not found in UPDATE_LOCAL_APP.bat');
  const psFiles = [...psRootBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  assert.deepEqual(psFiles.slice().sort(), pyFiles.slice().sort());
  assert.ok(pyFiles.includes('UPDATE_LOCAL_APP.bat'));
});

test('updater backs up before overwriting, rolls back on failure, supports dry-run and logs the run', () => {
  const ps = rawText.slice(rawText.indexOf(MARKER));

  // Timestamped backup created before any file is replaced.
  assert.match(ps, /backups\\aurum-backup-/);
  assert.match(ps, /manifest\.txt/);
  assert.match(ps, /Backup written to/);
  // Rollback restores backed-up files and removes newly created ones.
  assert.match(ps, /\[ROLLBACK\] Restoring previous files/);
  assert.match(ps, /createdRels\.Contains/);
  assert.match(ps, /Previous version is live again/);
  // Dry run reports the plan without stopping services or copying.
  assert.match(ps, /--dry-run/);
  assert.match(ps, /\[DRY RUN\] No files will be changed/);
  // Readable update log under logs/ (a preserved directory).
  assert.match(ps, /Start-Transcript/);
  assert.match(ps, /aurum-update-/);
  assert.match(ps, /Stop-Transcript/);
  // Download integrity: archive hash is recorded and the extracted
  // package.json version must match build.json before anything is copied.
  assert.match(ps, /Downloaded archive SHA-256/);
  assert.match(ps, /package\.json version/);
  // A non-AURUM occupant of 8788 aborts instead of being killed.
  assert.match(ps, /occupied by non-AURUM process/);
});
