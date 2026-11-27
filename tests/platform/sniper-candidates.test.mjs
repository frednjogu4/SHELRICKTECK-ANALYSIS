import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { sniperMarketAllowed, trySniperCandidates, sniperScanBatch, DEFAULT_SNIPER_CONFIG } from '../../src/sniperengine.js';
import { marketStatus } from '../../server/lib/markethours.js';

const candidates = ['EUR/GBP', 'EUR/USD', 'BTC/USD'].map(symbol => ({ symbol, signal: 'BUY' }));
test('closed top candidate and rejected second candidate are skipped; one confirmed fill stops the cycle', async () => {
  const visited = [], skipped = [];
  const result = await trySniperCandidates([...candidates, { symbol: 'XAU/USD' }], {
    canContinue: () => true,
    attempt: async c => {
      visited.push(c.symbol);
      return c.symbol === 'BTC/USD' ? { status: 'filled' } : { status: 'skipped', reason: 'Closed or rejected by supervisor.' };
    },
    onSkip: c => skipped.push(c.symbol),
  });
  assert.deepEqual(visited, candidates.map(c => c.symbol));
  assert.deepEqual(skipped, ['EUR/GBP', 'EUR/USD']);
  assert.equal(result.status, 'filled');
});
test('all rejected reports exhaustion, no duplicate symbol attempts, no forced entry', async () => {
  let calls = 0;
  const result = await trySniperCandidates([...candidates, candidates[0]], {
    canContinue: () => true,
    attempt: async () => { calls++; return { status: 'skipped', reason: 'No eligible setup.' }; },
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 'exhausted');
  assert.equal(result.skipped.length, 3);
});
test('STOP ALL, lost account authorization or stale snapshot between candidates halts immediately', async () => {
  let authorized = true, calls = 0;
  const result = await trySniperCandidates(candidates, {
    canContinue: () => authorized,
    attempt: async () => { calls++; authorized = false; return { status: 'skipped' }; },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'halted');
});
test('cooldown/global risk halt, ambiguous broker result or error never causes another submission', async () => {
  for (const outcome of [{ status: 'halted', reason: 'Daily limit' }, undefined, { status: 'unknown' }]) {
    let calls = 0;
    await trySniperCandidates(candidates, {
      canContinue: () => true,
      attempt: async () => { calls++; return outcome; },
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(trySniperCandidates(candidates, {
    canContinue: () => true,
    attempt: async () => { calls++; throw new Error('Broker response timed out'); },
  }), /timed out/);
  assert.equal(calls, 1);
});
test('bounded scan rotates across markets rather than repeatedly scanning only the first closed batch', () => {
  const universe = Array.from({ length: 23 }, (_, i) => ({ s: `market-${i}` }));
  let cursor = 0;
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const batch = sniperScanBatch(universe, cursor, 10);
    assert.equal(batch.symbols.length, 10);
    batch.symbols.forEach(s => seen.add(s));
    cursor = batch.nextCursor;
  }
  assert.equal(seen.size, 23);
  assert.deepEqual(sniperScanBatch([], 0, 10), { symbols: [], nextCursor: 0 });
  assert.deepEqual(sniperScanBatch([{ s: 'one' }], 0, 10).symbols, ['one']);
});
test('actual Sniper entry skips closed forex, then supervises and fills the next open instrument', async () => {
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const entry = main.slice(main.indexOf('async function executeSupervisedSniperEntry'), main.indexOf('\nasync function runDynamicProfitTargetWatcher'));
  const submitted = [], supervised = [], audits = [];
  const ident = { connected: true, broker: 'mt5', authKey: 'mt5:123:demo', environment: 'demo', accountId: '123', equity: 100 };
  const ctx = {
    getActiveBrokerIdentity: () => ident,
    isSniperExecutionArmedNow: () => true,
    automationSnapshotCheck: () => ({ ok: true }),
    sniperExecConfig: { ...DEFAULT_SNIPER_CONFIG, sizingMode: 'fixed_lots', pauseOnHighImpactNews: false },
    sniperRuntime: { canStartAutoEntry: () => ({ ok: true }), beginAutoEntry() {}, finishAutoEntry() {}, executedSignals: new Set() },
    sniperMarketAllowed, isTradingSessionAllowed: () => ({ ok: true }),
    bySym: { 'EUR/GBP': { c: 'forex' }, 'BTC/USD': { c: 'crypto' } },
    marketStatus: inst => {
      assert.equal(typeof inst, 'object', 'marketStatus requires the instrument, not its category string');
      return marketStatus(inst, Date.parse('2026-11-28T12:00:00Z'));
    },
    recordPlatformAudit: (...args) => audits.push(args), updateNotificationStatusBySignal() {},
    scanSignalsPreferred: async () => [{ confidence: 90, signal: 'BUY', stop_loss: 95, tp1: 110 }],
    state: { mktScan: {}, mt5LivePositions: [] },
    getOrStampEnvelopeForSymbol: () => ({ signalId: 'test-signal' }),
    bridge: { quoteBridge: async () => ({ quotes: [{ bid: 100, ask: 101, time: Date.now() / 1000 }] }),
      placeBridgeOrder: async order => { submitted.push(order); return { type: 'filled', ticket: 1 }; } },
    computeAccountDrawdownAndExposure: () => ({ currentDrawdownPct: 0, totalOpenExposureUsd: 0, effectiveRequestedUsd: 10 }),
    evaluateTradeSupervisor: input => { supervised.push(input); return { verdict: 'APPROVED', checks: [], reasons: [] }; },
    atSession: { entries: 0 }, atStatusUI() {}, notify() {}, refreshMt5Snapshot: async () => true,
  };
  const execute = vm.runInNewContext('(' + entry + ')', ctx);
  const result = await trySniperCandidates([candidates[0], candidates[2]], { canContinue: () => true, attempt: execute });
  assert.equal(result.status, 'filled');
  assert.equal(result.skipped[0].symbol, 'EUR/GBP');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].symbol, 'BTCUSD');
  assert.equal(supervised.length, 1);
  assert.equal(supervised[0].marketOpen, true);
  assert.equal(ctx.atSession.entries, 1);
  assert.equal(audits[0][1], 'MARKET_UNAVAILABLE');
  // A market may be open yet fail another per-symbol supervisor check.
  // The real entry path must return an explicit skip so the next symbol runs.
  submitted.length = 0;
  supervised.length = 0;
  ctx.marketStatus = inst => marketStatus(inst, Date.parse('2026-11-24T12:00:00Z'));
  ctx.evaluateTradeSupervisor = input => {
    supervised.push(input);
    return input.symbol === 'EURGBP'
      ? { verdict: 'REJECTED', checks: [{ name: 'spreadLiquidity', status: 'FAILED' }], reasons: ['Spread too wide.'] }
      : { verdict: 'APPROVED', checks: [], reasons: [] };
  };
  const second = await trySniperCandidates([candidates[0], candidates[2]], { canContinue: () => true, attempt: execute });
  assert.equal(second.status, 'filled');
  assert.equal(second.skipped[0].reason, 'Spread too wide.');
  assert.equal(supervised.length, 2);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].symbol, 'BTCUSD');
  submitted.length = 0;
  ctx.sniperExecConfig.marketScope = 'FOREX';
  assert.equal((await execute(candidates[2])).status, 'skipped');
  assert.equal(submitted.length, 0, 'excluded crypto cannot dispatch in forex-only scope');
  ctx.sniperExecConfig.marketScope = 'ALL';
  ctx.bridge.quoteBridge = async () => {
    ctx.sniperExecConfig.marketScope = 'FOREX';
    return { quotes: [{ bid: 100, ask: 101, time: Date.now() / 1000 }] };
  };
  assert.equal((await execute(candidates[2])).status, 'skipped');
  assert.equal(submitted.length, 0, 'a scope change during quote fetch must prevent dispatch');
  assert.doesNotMatch(main, /marketStatus\(I\.c,/);
  assert.match(main, /trySniperCandidates\(sigs,/);
});
