#!/usr/bin/env node
/*
 * Canonical local-package updater engine with:
 *   - installation directory validation,
 *   - candidate release & Build ID consistency verification,
 *   - safe `--dry-run` mode (zero file writes, zero process stops),
 *   - strict AURUM-only process classification (never kills unrelated listeners
 *     on ports 8788, 8787 or 4100, and never touches MetaTrader 5),
 *   - timestamped backup (`backups/backup-<timestamp>/`) before replacing files,
 *   - preservation + SHA-256 verification of local tokens, configs and `server/data/`,
 *   - post-restart live `/build.json` verification,
 *   - automatic rollback to the backup if sync, restart or build verification fails,
 *   - structured secret-free update log under `logs/local-update-<timestamp>.log`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_GITHUB_ZIP_URL =
  'https://codeload.github.com/frednjogu4/SHELRICKTECK-ANALYSIS/zip/refs/heads/main';

export const PACKAGE_TREES = Object.freeze([
  'bridge', 'server', 'src', 'scripts', 'public', 'cloudflare'
]);

export const PACKAGE_ROOT_FILES = Object.freeze([
  'index.html',
  'vite.config.js',
  'wrangler.jsonc',
  'START_LOCAL_MARKET_COMMAND_CENTRE.bat',
  'START_ALL_LOCAL.bat',
  'SETUP_AND_RUN_LOCAL.bat',
  'RUN_LOCAL_API.bat',
  'START_LOCAL_API.bat',
  'UPDATE_LOCAL_APP.bat',
  'LOCAL_HOSTING_README.md',
  'LOCAL_HOST_ONLY.txt',
  'LOCAL_UPDATE_NOTES.txt',
  'START_HERE_LOCAL_PACKAGE.txt',
  'package.json',
  'package-lock.json'
]);

export const PRESERVED_REL_FILES = Object.freeze([
  'bridge/bridge_token.txt',
  'bridge/terminal_path.txt',
  'bridge/python_runtime.txt',
  'bridge/.dev-watch.json',
  '.env',
  '.env.local'
]);

export const PRESERVED_DIR_PREFIXES = Object.freeze([
  'server/data/',
  'logs/',
  'node_modules/',
  'backups/'
]);

export function sha256File(filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function validateAurumRoot(dir) {
  if (!dir) return false;
  const full = resolve(dir);
  if (!existsSync(full) || !statSync(full).isDirectory()) return false;
  const hasPkg = existsSync(join(full, 'package.json'));
  const hasBridge = existsSync(join(full, 'bridge', 'mt5_bridge.py'));
  const hasLauncher = existsSync(join(full, 'START_ALL_LOCAL.bat')) ||
                      existsSync(join(full, 'START_LOCAL_MARKET_COMMAND_CENTRE.bat'));
  return hasPkg && hasBridge && hasLauncher;
}

/**
 * Classify a process listening on 8788, 8787, or 4100.
 * Never returns 'stop_aurum' merely because a process occupies the port.
 */
export function classifyPortListener({ port, name = '', commandLine = '', windowTitle = '' } = {}) {
  const procName = String(name || '').trim();
  const cmd = String(commandLine || '');
  const title = String(windowTitle || '');

  if (/^terminal(64)?(\.exe)?$/i.test(procName)) {
    return { action: 'ignore_mt5', reason: 'MetaTrader 5 terminal is never stopped' };
  }

  if (port === 8788 || port === 8787) {
    if (/mt5_bridge\.py/i.test(cmd) || /Exness MT5 Bridge/i.test(title)) {
      return { action: 'stop_aurum', mode: 'bridge', reason: 'verified AURUM mt5_bridge.py listener' };
    }
    if (/wrangler/i.test(cmd) && /wrangler\.jsonc/i.test(cmd) || /Shelricktech Local Dashboard/i.test(title)) {
      return { action: 'stop_aurum', mode: 'wrangler', reason: 'verified AURUM Wrangler local dashboard' };
    }
    return {
      action: 'abort_unrelated',
      reason: `Port ${port} is held by unrelated process "${procName || 'unknown'}" — refusing to terminate it`
    };
  }

  if (port === 4100) {
    if (/server[\\/]server\.js/i.test(cmd) || /RUN_LOCAL_API\.bat/i.test(cmd) || /Fredrick AURUM Local API/i.test(title)) {
      return { action: 'stop_aurum', mode: 'api', reason: 'verified AURUM local Express API' };
    }
    return {
      action: 'abort_unrelated',
      reason: `Port 4100 is held by unrelated process "${procName || 'unknown'}" — refusing to terminate it`
    };
  }

  return { action: 'ignore', reason: 'unrelated port' };
}

function isPreservedRel(relPosix) {
  if (PRESERVED_REL_FILES.includes(relPosix)) return true;
  return PRESERVED_DIR_PREFIXES.some((pref) => relPosix.toLowerCase().startsWith(pref.toLowerCase()));
}

function walkFiles(baseDir) {
  const out = [];
  if (!existsSync(baseDir)) return out;
  const stack = [baseDir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && !entry.name.endsWith('.pyc')) out.push(full);
    }
  }
  return out.sort();
}

export function collectCanonicalFiles(srcRoot) {
  const entries = [];
  for (const rootName of PACKAGE_ROOT_FILES) {
    const full = join(srcRoot, rootName);
    if (existsSync(full) && statSync(full).isFile()) {
      entries.push({ rel: rootName, src: full });
    }
  }
  for (const tree of PACKAGE_TREES) {
    const treeDir = join(srcRoot, tree);
    for (const full of walkFiles(treeDir)) {
      const rel = relative(srcRoot, full).split(sep).join('/');
      if (isPreservedRel(rel)) continue;
      entries.push({ rel, src: full });
    }
  }
  return entries;
}

export function verifyReleaseTree(srcRoot) {
  const required = [
    'bridge/app.html',
    'bridge/pwa/build.json',
    'bridge/pwa/sw.js',
    'bridge/mt5_bridge.py',
    'server/server.js',
    'server/lib/strength.js',
    'package.json'
  ];
  for (const rel of required) {
    const full = join(srcRoot, ...rel.split('/'));
    if (!existsSync(full) || !statSync(full).isFile() || statSync(full).size === 0) {
      throw new Error(`Candidate release verification failed: missing or empty ${rel}`);
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(srcRoot, 'bridge', 'pwa', 'build.json'), 'utf8'));
  } catch (err) {
    throw new Error(`Candidate bridge/pwa/build.json is invalid JSON: ${err.message}`);
  }
  if (!manifest || !manifest.id) {
    throw new Error('Candidate bridge/pwa/build.json has no id');
  }
  const appHtml = readFileSync(join(srcRoot, 'bridge', 'app.html'), 'utf8');
  const metaMatch = appHtml.match(/<meta name="aurum-build" content="([^"]+)">/);
  if (!metaMatch || metaMatch[1] !== manifest.id) {
    throw new Error(`Candidate bridge/app.html meta (${metaMatch ? metaMatch[1] : 'missing'}) does not match build.json (${manifest.id})`);
  }
  const swJs = readFileSync(join(srcRoot, 'bridge', 'pwa', 'sw.js'), 'utf8');
  const swMatch = swJs.match(/const VERSION = '([^']+)'/);
  if (!swMatch || swMatch[1] !== `aurum-local-${manifest.id}`) {
    throw new Error(`Candidate bridge/pwa/sw.js VERSION (${swMatch ? swMatch[1] : 'missing'}) does not match build.json (${manifest.id})`);
  }
  return manifest;
}

export function snapshotPreservedState(targetRoot) {
  const snap = new Map();
  for (const rel of PRESERVED_REL_FILES) {
    const full = join(targetRoot, ...rel.split('/'));
    if (existsSync(full) && statSync(full).isFile()) {
      snap.set(rel, sha256File(full));
    }
  }
  const dataDir = join(targetRoot, 'server', 'data');
  for (const full of walkFiles(dataDir)) {
    const rel = relative(targetRoot, full).split(sep).join('/');
    snap.set(rel, sha256File(full));
  }
  return snap;
}

export function assertPreservedState(targetRoot, beforeSnap) {
  for (const [rel, expectedHash] of beforeSnap.entries()) {
    const full = join(targetRoot, ...rel.split('/'));
    const actual = sha256File(full);
    if (actual !== expectedHash) {
      throw new Error(`Preserved local file check failed for ${rel}`);
    }
  }
}

function formatStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

export function createTimestampedBackup(targetRoot, candidateEntries, stamp = formatStamp(), maxBackups = 5) {
  const backupsRoot = join(targetRoot, 'backups');
  mkdirSync(backupsRoot, { recursive: true });
  let backupDir = join(backupsRoot, `backup-${stamp}`);
  let suffix = 1;
  while (existsSync(backupDir)) {
    backupDir = join(backupsRoot, `backup-${stamp}-${suffix++}`);
  }
  const filesDir = join(backupDir, 'files');
  mkdirSync(filesDir, { recursive: true });

  let previousBuildId = 'none';
  try {
    const oldBj = JSON.parse(readFileSync(join(targetRoot, 'bridge', 'pwa', 'build.json'), 'utf8'));
    if (oldBj && oldBj.id) previousBuildId = String(oldBj.id);
  } catch { /* older package without build.json */ }

  const sha256ByRelPath = {};
  const addedIfApplied = [];

  for (const { rel } of candidateEntries) {
    if (isPreservedRel(rel)) continue;
    const existing = join(targetRoot, ...rel.split('/'));
    if (existsSync(existing) && statSync(existing).isFile()) {
      const dst = join(filesDir, ...rel.split('/'));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(existing, dst);
      sha256ByRelPath[rel] = sha256File(dst);
    } else {
      addedIfApplied.push(rel);
    }
  }

  const backupManifest = {
    createdAt: new Date().toISOString(),
    previousBuildId,
    backedUpCount: Object.keys(sha256ByRelPath).length,
    sha256ByRelPath,
    addedIfApplied
  };
  writeFileSync(join(backupDir, 'backup-manifest.json'), JSON.stringify(backupManifest, null, 2) + '\n');

  /* Keep recent backups tidy without deleting user data. */
  const allBackups = readdirSync(backupsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('backup-'))
    .map((d) => d.name)
    .sort();
  while (allBackups.length > maxBackups) {
    const oldest = allBackups.shift();
    rmSync(join(backupsRoot, oldest), { recursive: true, force: true });
  }

  return { backupDir, backupManifest };
}

export function restoreFromBackup(targetRoot, backupDir) {
  const manifestPath = join(backupDir, 'backup-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Rollback failed: missing ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const filesDir = join(backupDir, 'files');

  for (const [rel, expectedSha] of Object.entries(manifest.sha256ByRelPath || {})) {
    if (isPreservedRel(rel)) continue;
    const src = join(filesDir, ...rel.split('/'));
    const dst = join(targetRoot, ...rel.split('/'));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    if (sha256File(dst) !== expectedSha) {
      throw new Error(`Rollback checksum mismatch on ${rel}`);
    }
  }

  for (const rel of manifest.addedIfApplied || []) {
    if (isPreservedRel(rel)) continue;
    const dst = join(targetRoot, ...rel.split('/'));
    if (existsSync(dst) && statSync(dst).isFile()) {
      unlinkSync(dst);
    }
  }
  return manifest.previousBuildId;
}

function downloadFile(url, destFile) {
  return new Promise((resolvePromise, rejectPromise) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(res.headers.location, destFile).then(resolvePromise, rejectPromise);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        rejectPromise(new Error(`Download HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        writeFileSync(destFile, Buffer.concat(chunks));
        resolvePromise(destFile);
      });
    });
    req.on('error', rejectPromise);
    req.on('timeout', () => { req.destroy(new Error('Download timed out')); });
  });
}

function extractZipCrossPlatform(zipPath, extractDir) {
  mkdirSync(extractDir, { recursive: true });
  for (const py of ['python3', 'python']) {
    const r = spawnSync(py, ['-m', 'zipfile', '-e', zipPath, extractDir], { encoding: 'utf8' });
    if (r.status === 0) return;
  }
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
    ], { encoding: 'utf8' });
    if (ps.status === 0) return;
  }
  throw new Error('Could not extract release archive (neither python zipfile nor PowerShell Expand-Archive succeeded)');
}

async function fetchJsonNoCache(url, timeoutMs = 4000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'Cache-Control': 'no-cache' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          rejectPromise(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolvePromise(JSON.parse(body)); } catch (e) { rejectPromise(e); }
      });
    });
    req.on('error', rejectPromise);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

/**
 * Execute a full validated update (or dry-run) against `targetRoot`.
 */
export async function runLocalUpdate({
  targetRoot,
  source = DEFAULT_GITHUB_ZIP_URL,
  dryRun = false,
  skipRestart = false,
  verifyUrl = 'http://127.0.0.1:8788/build.json',
  verifyTimeoutMs = 30000,
  inspectListeners = async () => [],
  stopProcesses = async () => {},
  restartServices = async () => {},
  fetchBuildJson = fetchJsonNoCache,
  injectFaultAfterCopy = null
} = {}) {
  const resolvedTarget = resolve(targetRoot || process.cwd());
  if (!validateAurumRoot(resolvedTarget)) {
    throw new Error(`Target directory is not a valid AURUM local installation: ${resolvedTarget}`);
  }

  const stamp = formatStamp();
  const logsDir = join(resolvedTarget, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, `local-update-${stamp}.log`);
  const logLines = [];
  const writeLog = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logLines.push(line);
    writeFileSync(logPath, logLines.join('\n') + '\n', 'utf8');
  };

  let previousBuildId = 'none';
  try {
    const oldBj = JSON.parse(readFileSync(join(resolvedTarget, 'bridge', 'pwa', 'build.json'), 'utf8'));
    if (oldBj && oldBj.id) previousBuildId = String(oldBj.id);
  } catch { /* pre-manifest installation */ }

  writeLog(`Target installation: ${resolvedTarget}`);
  writeLog(`Previous Build ID: ${previousBuildId}`);
  writeLog(`Mode: ${dryRun ? 'DRY-RUN (read-only)' : (skipRestart ? 'FILE-UPDATE (--no-restart)' : 'FULL UPDATE + VERIFY')}`);

  const tempWork = mkdtempSync(join(tmpdir(), 'aurum-updater-'));
  try {
    let srcRoot = null;
    if (existsSync(source) && statSync(source).isDirectory()) {
      srcRoot = resolve(source);
      writeLog(`Using local candidate directory: ${srcRoot}`);
    } else {
      const zipPath = join(tempWork, 'release.zip');
      if (/^https?:\/\//i.test(source)) {
        writeLog(`Downloading release archive from ${source}`);
        await downloadFile(source, zipPath);
      } else if (existsSync(source) && statSync(source).isFile()) {
        copyFileSync(source, zipPath);
        writeLog(`Copied local candidate archive: ${source}`);
      } else {
        throw new Error(`Release source not found: ${source}`);
      }
      const extractDir = join(tempWork, 'extracted');
      extractZipCrossPlatform(zipPath, extractDir);
      const topDirs = readdirSync(extractDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      if (topDirs.length === 1 && existsSync(join(extractDir, topDirs[0].name, 'bridge', 'app.html'))) {
        srcRoot = join(extractDir, topDirs[0].name);
      } else if (existsSync(join(extractDir, 'bridge', 'app.html'))) {
        srcRoot = extractDir;
      } else {
        throw new Error('Extracted archive does not contain bridge/app.html in an expected top directory');
      }
    }

    const candidateManifest = verifyReleaseTree(srcRoot);
    const targetBuildId = String(candidateManifest.id);
    writeLog(`Verified candidate release: Build ID ${targetBuildId}${candidateManifest.git ? ` (git ${candidateManifest.git})` : ''}`);

    const entries = collectCanonicalFiles(srcRoot);
    const changed = entries.filter(({ rel, src }) => {
      const dst = join(resolvedTarget, ...rel.split('/'));
      return sha256File(dst) !== sha256File(src);
    });

    if (dryRun) {
      writeLog(`[DRY-RUN] ${changed.length} of ${entries.length} canonical files would be updated (${previousBuildId} -> ${targetBuildId}). Zero files modified, zero processes stopped.`);
      return {
        ok: true,
        dryRun: true,
        rolledBack: false,
        previousBuildId,
        targetBuildId,
        changedCount: changed.length,
        totalCanonicalCount: entries.length,
        logPath
      };
    }

    const preservedBefore = snapshotPreservedState(resolvedTarget);
    writeLog(`Snapshotted ${preservedBefore.size} local configuration/credential/data file(s) for integrity protection.`);

    const listeners = await inspectListeners();
    const toStop = [];
    let launchMode = 'bridge';
    for (const item of listeners) {
      const decision = classifyPortListener(item);
      writeLog(`Port ${item.port} PID ${item.pid} (${item.name || 'unknown'}): ${decision.action} — ${decision.reason}`);
      if (decision.action === 'abort_unrelated') {
        throw new Error(decision.reason);
      }
      if (decision.action === 'stop_aurum') {
        if (decision.mode === 'wrangler' && !existsSync(join(resolvedTarget, 'START_ALL_LOCAL.bat'))) launchMode = 'wrangler';
        toStop.push(item);
      }
    }

    const { backupDir } = createTimestampedBackup(resolvedTarget, entries, stamp);
    writeLog(`Created pre-update backup: ${backupDir}`);

    try {
      if (!skipRestart && toStop.length > 0) {
        writeLog(`Stopping ${toStop.length} verified AURUM process(es)...`);
        await stopProcesses(toStop);
      }

      for (const { rel, src } of entries) {
        if (isPreservedRel(rel)) continue;
        const dst = join(resolvedTarget, ...rel.split('/'));
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      }
      writeLog(`Replaced ${entries.length} canonical file(s) (${changed.length} changed).`);

      if (typeof injectFaultAfterCopy === 'function') {
        await injectFaultAfterCopy(resolvedTarget);
      }

      assertPreservedState(resolvedTarget, preservedBefore);
      writeLog('Verified all preserved local credentials/configs/data files are byte-for-byte unchanged.');

      if (!skipRestart) {
        writeLog(`Restarting local service (${launchMode})...`);
        await restartServices({ targetRoot: resolvedTarget, launchMode });

        const deadline = Date.now() + verifyTimeoutMs;
        let liveId = null;
        while (Date.now() < deadline) {
          try {
            const info = await fetchBuildJson(verifyUrl, 2500);
            if (info && info.id) {
              liveId = String(info.id);
              if (liveId === targetBuildId) break;
            }
          } catch { /* service still starting */ }
          await new Promise((r) => setTimeout(r, 250));
        }
        if (liveId !== targetBuildId) {
          throw new Error(`Post-restart build verification failed at ${verifyUrl}: expected ${targetBuildId}, got ${liveId || 'unreachable'}`);
        }
        writeLog(`[SUCCESS] Verified live endpoint ${verifyUrl} serving Build ID ${liveId}.`);
      } else {
        const diskBj = JSON.parse(readFileSync(join(resolvedTarget, 'bridge', 'pwa', 'build.json'), 'utf8'));
        if (!diskBj || diskBj.id !== targetBuildId) {
          throw new Error('On-disk build.json verification failed after copy');
        }
        writeLog(`[SUCCESS] Verified on-disk Build ID ${targetBuildId} (--no-restart).`);
      }

      return {
        ok: true,
        dryRun: false,
        rolledBack: false,
        previousBuildId,
        activeBuildId: targetBuildId,
        backupDir,
        logPath
      };
    } catch (updateErr) {
      writeLog(`[ERROR] Update failed: ${updateErr.message}`);
      writeLog(`[ROLLBACK] Restoring previous installation (${previousBuildId}) from ${backupDir}...`);
      const restoredId = restoreFromBackup(resolvedTarget, backupDir);
      assertPreservedState(resolvedTarget, preservedBefore);
      if (!skipRestart) {
        try {
          await restartServices({ targetRoot: resolvedTarget, launchMode, isRollback: true });
        } catch (restartErr) {
          writeLog(`[ROLLBACK] Warning during rollback service restart: ${restartErr.message}`);
        }
      }
      writeLog(`[ROLLBACK] Restored previous Build ID ${restoredId}; preserved local files verified intact.`);
      return {
        ok: false,
        dryRun: false,
        rolledBack: true,
        restoredBuildId: restoredId,
        backupDir,
        error: updateErr.message,
        logPath
      };
    }
  } finally {
    rmSync(tempWork, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const opt = (name, defVal) => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : defVal;
  };
  const targetRoot = opt('--target', resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const source = opt('--source', process.env.AURUM_UPDATE_ZIP_URL || DEFAULT_GITHUB_ZIP_URL);
  const dryRun = flag('--dry-run');
  const skipRestart = flag('--no-restart') || dryRun;
  const verifyUrl = opt('--verify-url', 'http://127.0.0.1:8788/build.json');

  runLocalUpdate({ targetRoot, source, dryRun, skipRestart, verifyUrl })
    .then((res) => {
      if (res.ok) {
        console.log(res.dryRun
          ? `[DRY-RUN OK] ${res.changedCount} file(s) would update (${res.previousBuildId} -> ${res.targetBuildId}). Log: ${res.logPath}`
          : `[UPDATE OK] Active Build ID: ${res.activeBuildId} (backup: ${res.backupDir}). Log: ${res.logPath}`);
        process.exit(0);
      } else {
        console.error(`[UPDATE FAILED — ROLLED BACK TO ${res.restoredBuildId}] ${res.error}. Log: ${res.logPath}`);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`[UPDATER ABORTED] ${err.message}`);
      process.exit(1);
    });
}
