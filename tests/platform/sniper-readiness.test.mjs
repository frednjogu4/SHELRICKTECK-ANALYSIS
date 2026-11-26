import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkAutomationSnapshot } from '../../src/sniperengine.js';

const now = 1800000000000;
const live = { broker: 'mt5', connected: true, syncTsSec: now / 1000, snapshotAt: now, snapshotFailed: false, positions: [] };
test('MT5 automation requires both fresh broker time and fresh complete local snapshot', () => {
  assert.equal(checkAutomationSnapshot(live, now).ok, true);
  for (const delta of [45001, 9015000]) {
    assert.equal(checkAutomationSnapshot({ ...live, syncTsSec: (now - delta) / 1000 }, now).ok, false);
    assert.equal(checkAutomationSnapshot({ ...live, snapshotAt: now - delta }, now).ok, false);
  }
  for (const syncTsSec of [0, null, undefined, NaN, Infinity, (now + 6000) / 1000]) {
    assert.equal(checkAutomationSnapshot({ ...live, syncTsSec }, now).ok, false);
  }
  for (const patch of [{ snapshotFailed: true }, { snapshotAt: null }, { positions: null }, { connected: false }]) {
    assert.equal(checkAutomationSnapshot({ ...live, ...patch }, now).ok, false);
  }
});
test('readiness allows fresh empty positions but never treats failure as an empty successful snapshot', () => {
  assert.match(checkAutomationSnapshot({ ...live, snapshotFailed: true }, now).reason, /refresh failed/);
  assert.equal(checkAutomationSnapshot({ ...live, snapshotAt: now - 45000 }, now).ok, true);
  assert.equal(checkAutomationSnapshot({ broker: 'deriv', connected: true }, now).ok, true);
});
test('entry and auto-close paths use readiness; runtime reason is visible on the Sniper hub', () => {
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const entry = main.slice(main.indexOf('async function executeSupervisedSniperEntry'), main.indexOf('async function runDynamicProfitTargetWatcher'));
  const watcher = main.slice(main.indexOf('async function runDynamicProfitTargetWatcher'), main.indexOf('function initSniperAndProfitTargetEngine'));
  assert.match(entry, /if \(!automationSnapshotCheck\(\)\.ok\)/);
  assert.match(entry, /Account authorization or live snapshot changed/);
  assert.match(entry, /if \(!q0\) throw new Error/);
  assert.match(entry, /quoteTsMs = q0.time \? q0.time \* 1000 : 0/);
  assert.match(watcher, /!automationSnapshotCheck\(\)\.ok/);
  assert.match(watcher, /authorizedKey !== ident.authKey/);
  assert.match(html, /id="sniperRuntimeStatus" role="status"/);
  assert.match(main, /AUTOMATION PAUSED · BROKER DATA/);
  assert.match(main, /sniperRuntimeStatus = text/);
});
