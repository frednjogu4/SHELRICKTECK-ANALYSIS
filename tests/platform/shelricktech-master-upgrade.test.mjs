import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  computeMultiTimeframeConfluence,
  stampSignalEnvelope,
  getSignalValidityState,
  evaluateTradeSupervisor,
  buildMarketIntelligenceBrief,
} from '../../src/supervisor.js';
import {
  PROFIT_TARGET_PRESETS,
  normalizeSniperConfig,
  buildAccountAuthKey,
  checkHighImpactNewsWindow,
  evaluatePositionProfitTarget,
  createSniperRuntime,
} from '../../src/sniperengine.js';
import {
  pushNotificationItem,
  listNotifications,
  unreadNotificationCount,
  markNotificationRead,
  updateNotificationStatusBySignal,
  clearResolvedNotifications,
} from '../../src/notify.js';
import { tvSymbol, TV_COMMAND_INSTRUMENTS } from '../../src/tradingview.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

test('SHELRICKTECH branding, Account Status Top Bar, Notification Bell, TradingView Command Centre & 17+ nav views', () => {
  const doc = new JSDOM(html).window.document;
  assert.match(html, /SHELRICKTECH AI TRADING &amp; MARKET INTELLIGENCE/);
  assert.match(html, /Designed by Fredrick K under Shelricktech Investment/);
  assert.equal(doc.getElementById('brandName')?.textContent, 'Shelricktech');

  // Account Status Top Bar permanently mounted with non-fabricated placeholders
  const topBar = doc.getElementById('accountTopBar');
  assert.ok(topBar, 'accountTopBar exists');
  for (const id of [
    'topBarBrokerPill', 'topBarModeBadge', 'topBarBalance', 'topBarEquity',
    'topBarFreeMargin', 'topBarMarginLevel', 'topBarOpenPl', 'topBarDailyPl',
    'topBarCounts', 'topBarSyncTs', 'topBarSniperBadge', 'topBarEmergencyStop',
  ]) {
    assert.ok(doc.getElementById(id), `${id} present in Account Top Bar`);
  }
  assert.equal(doc.getElementById('topBarBalance').textContent, '—', 'no fake sample balance when disconnected');

  // Notification Bell + Drawer
  assert.ok(doc.getElementById('notifBellBtn'));
  assert.ok(doc.getElementById('notifBadge'));
  assert.ok(doc.getElementById('notifDrawer'));

  // Authoritative institutional sidebar destinations
  for (const view of [
    'overview', 'markets', 'signals', 'automation', 'tv', 'watch',
    'trade', 'positions', 'pending', 'portfolio', 'history',
    'intelligence', 'news', 'gold', 'learn', 'backtest', 'settings', 'security',
  ]) {
    assert.ok(doc.querySelector(`.nav-item[data-view="${view}"]`), `nav item for ${view}`);
    assert.ok(doc.getElementById(`view-${view}`), `section #view-${view}`);
  }

  // Settings responsive anti-overflow CSS rules
  assert.match(html, /grid-template-columns:minmax\(0,1\.65fr\) minmax\(0,1fr\)/);
  assert.match(html, /\.set-row\{display:flex;[^}]*flex-wrap:wrap/);
  assert.ok(doc.getElementById('settingsSubnav'));
});

test('CRITICAL BUG FIX: Signal direction reversal (BUY -> SELL) invalidates setup & AI Trade Supervisor blocks execution', () => {
  const now = 1_760_000_000_000;
  const env = stampSignalEnvelope({
    symbol: 'XAU/USD',
    signal: 'BUY',
    confidence: 82,
    entry: 2650.0,
    stop_loss: 2642.0,
    tp1: 2664.0,
  }, { nowMs: now, bid: 2649.9, ask: 2650.2, timeframe: '5m' });

  // Initially valid
  const okState = getSignalValidityState(env, { nowMs: now + 10_000, liveBid: 2649.9, liveAsk: 2650.2, latestSignal: 'BUY' });
  assert.equal(okState.valid, true);
  assert.equal(okState.status, 'VALID');

  // Market reverses to SELL right before order execution -> MUST reject!
  const supReversed = evaluateTradeSupervisor({
    intendedSide: 'BUY',
    symbol: 'XAUUSD',
    signalEnvelope: env,
    latestRecalculatedSignal: 'SELL',
    brokerConnected: true,
    expectedBroker: 'mt5',
    activeBroker: 'mt5',
    expectedAccountId: '880011',
    activeAccountId: '880011',
    expectedEnvironment: 'demo',
    activeEnvironment: 'demo',
    marketOpen: true,
    liveBid: 2648.0,
    liveAsk: 2648.3,
    quoteTsMs: now + 12_000,
    nowMs: now + 12_000,
    requireSignalValidation: true,
  });
  assert.equal(supReversed.verdict, 'REJECTED');
  assert.match(supReversed.reasons[0], /changed.*BUY.*SELL|reversed/i);
  assert.ok(env.invalidatedReason, 'old BUY envelope marked invalidated');
});

test('AI Trade Supervisor blocks expired signals, silent DEMO/REAL switching, secret min-lot inflation, and high-impact news', () => {
  const now = 1_760_000_000_000;
  const env = stampSignalEnvelope({
    symbol: 'EUR/USD',
    signal: 'SELL',
    confidence: 80,
    entry: 1.0850,
    stop_loss: 1.0870,
    tp1: 1.0810,
  }, { nowMs: now, bid: 1.0850, ask: 1.0851, timeframe: '1m' });

  // 1. Expired signal -> STALE SIGNAL
  const expired = evaluateTradeSupervisor({
    intendedSide: 'SELL',
    symbol: 'EURUSD',
    signalEnvelope: env,
    latestRecalculatedSignal: 'SELL',
    brokerConnected: true,
    activeBroker: 'mt5',
    activeEnvironment: 'demo',
    liveBid: 1.0850,
    liveAsk: 1.0851,
    quoteTsMs: now + 120_000,
    nowMs: now + 120_000,
    requireSignalValidation: true,
  });
  assert.equal(expired.verdict, 'STALE SIGNAL');

  // 2. Silent DEMO -> REAL mismatch -> REJECTED
  const freshEnv = stampSignalEnvelope({ symbol: 'EUR/USD', signal: 'SELL', entry: 1.0850, stop_loss: 1.0870, tp1: 1.0810 }, { nowMs: now });
  const modeMismatch = evaluateTradeSupervisor({
    intendedSide: 'SELL',
    symbol: 'EURUSD',
    signalEnvelope: freshEnv,
    brokerConnected: true,
    expectedBroker: 'mt5',
    activeBroker: 'mt5',
    expectedEnvironment: 'demo',
    activeEnvironment: 'real',
    liveBid: 1.0850,
    liveAsk: 1.0851,
    quoteTsMs: now,
    nowMs: now,
  });
  assert.equal(modeMismatch.verdict, 'REJECTED');
  assert.match(modeMismatch.reasons[0], /DEMO.*REAL/i);

  // 3. Requested lot below broker minimum -> REJECTED (never secretly inflated!)
  const minLotBlocked = evaluateTradeSupervisor({
    intendedSide: 'SELL',
    symbol: 'EURUSD',
    brokerConnected: true,
    activeBroker: 'mt5',
    activeEnvironment: 'demo',
    liveBid: 1.0850,
    liveAsk: 1.0851,
    quoteTsMs: now,
    nowMs: now,
    requestedLots: 0.004,
    brokerMinLots: 0.01,
  });
  assert.equal(minLotBlocked.verdict, 'REJECTED');
  assert.match(minLotBlocked.reasons[0], /never secretly increased/i);

  // 4. High-impact economic event window -> WAIT
  const newsBlocked = evaluateTradeSupervisor({
    intendedSide: 'SELL',
    symbol: 'EURUSD',
    signalEnvelope: freshEnv,
    latestRecalculatedSignal: 'SELL',
    brokerConnected: true,
    activeBroker: 'mt5',
    activeEnvironment: 'demo',
    liveBid: 1.0850,
    liveAsk: 1.0851,
    quoteTsMs: now,
    nowMs: now,
    highImpactNewsActive: true,
    highImpactEventTitle: 'USD Non-Farm Payrolls',
    requireSignalValidation: true,
  });
  assert.equal(newsBlocked.verdict, 'WAIT');
});

test('Dynamic Monetary Net-Profit Target ($2, $3, $4, $5, $10, custom) accounts for commissions, swaps & fees', () => {
  assert.deepEqual(PROFIT_TARGET_PRESETS, [2, 3, 4, 5, 10]);
  const cfg = normalizeSniperConfig({
    autoProfitCloseEnabled: true,
    netProfitTargetUsd: 3.0,
    perPositionTargets: { 'mt5:999': 5.0 },
  });

  // Gross +$3.15, commission -$0.25, swap -$0.05 => Net +$2.85 (< $3.00 target -> keep open!)
  const belowNet = evaluatePositionProfitTarget({
    posKey: 'mt5:101',
    profit: 3.15,
    commission: -0.25,
    swap: -0.05,
    fee: 0,
  }, cfg);
  assert.equal(belowNet.eligible, false);
  assert.equal(belowNet.netProfit, 2.85);

  // Gross +$3.40, commission -$0.25, swap -$0.05 => Net +$3.10 (>= $3.00 target -> close!)
  const metNet = evaluatePositionProfitTarget({
    posKey: 'mt5:101',
    profit: 3.40,
    commission: -0.25,
    swap: -0.05,
    fee: 0,
  }, cfg);
  assert.equal(metNet.eligible, true);
  assert.equal(metNet.netProfit, 3.10);

  // Per-position custom target override ($5.00)
  const customOverride = evaluatePositionProfitTarget({
    posKey: 'mt5:999',
    profit: 4.20,
    commission: 0,
    swap: 0,
  }, cfg);
  assert.equal(customOverride.eligible, false);
  assert.equal(customOverride.targetUsd, 5.0);

  // Single-flight close lock & Emergency STOP ALL
  const rt = createSniperRuntime();
  assert.equal(rt.acquireCloseLock('mt5:101', 10_000), true);
  assert.equal(rt.acquireCloseLock('mt5:101', 10_000), false, 'duplicate concurrent close prevented');
  const stopEvt = rt.emergencyReset('operator');
  assert.equal(stopEvt.category, 'EMERGENCY_STOP');
  assert.equal(rt.closingLocks.size, 0);
  assert.equal(buildAccountAuthKey('MT5', '12345', 'DEMO'), 'mt5:12345:demo');
});

test('7-Timeframe Confluence, AI Market Intelligence & News Window checks operate deterministically', () => {
  // Construct 220 rising M1 candles -> resampled across timeframes
  const m1 = [];
  let px = 2600;
  const baseSec = 1_760_000_000;
  for (let i = 0; i < 600; i++) {
    const open = px;
    const close = px + 0.35 + (i % 3 === 0 ? -0.1 : 0.15);
    m1.push({ time: baseSec + i * 60, open, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.15, close, volume: 120 + (i % 20) });
    px = close;
  }
  const mtf = computeMultiTimeframeConfluence({ '1m': m1 });
  assert.equal(mtf.ok, true);
  assert.equal(mtf.verdict, 'BUY');
  assert.ok(mtf.buyConfluence >= 60);
  assert.equal(mtf.frames.length, 7);

  const brief = buildMarketIntelligenceBrief({
    symbol: 'XAU/USD',
    quote: { mid: px, bid: px - 0.1, ask: px + 0.1, tsMs: Date.now() },
    mtf,
    dataSource: 'Deriv verified candle feed',
  });
  assert.ok(brief.observedFacts.length >= 3);
  assert.match(brief.limitations, /NOT a probability of profit/);

  // News window check
  const evTime = Date.now() + 5 * 60_000;
  const nw = checkHighImpactNewsWindow([{ title: 'CPI YoY', currency: 'USD', impact: 'High', tsMs: evTime }], 'XAU/USD', { beforeMin: 15, afterMin: 15 });
  assert.equal(nw.active, true);
});

test('Notification Centre deduplicates signals and TradingView Command Centre maps Oil, Gold, Silver, Crypto, FX & Indices', () => {
  clearResolvedNotifications();
  const n1 = pushNotificationItem({
    dedupeKey: 'sig:XAU:BUY:5m',
    title: 'XAU/USD BUY Setup',
    body: 'Confluence 81/100',
    symbol: 'XAU/USD',
    direction: 'BUY',
    strength: 81,
    timeframe: '5m',
    broker: 'MT5',
    status: 'ACTIVE',
  });
  assert.ok(n1);
  const dup = pushNotificationItem({ dedupeKey: 'sig:XAU:BUY:5m', title: 'Duplicate' });
  assert.equal(dup, null, 'duplicate notification suppressed within TTL');
  assert.ok(unreadNotificationCount() >= 1);
  updateNotificationStatusBySignal('XAU/USD', 'BUY', 'INVALIDATED', 'Reversed to SELL');
  const invList = listNotifications({ status: 'INVALIDATED' });
  assert.ok(invList.some((x) => x.id === n1.id));
  markNotificationRead(n1.id);

  // TradingView Command Centre symbol coverage (Section 10)
  for (const sym of ['XAU/USD', 'XAG/USD', 'WTI/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'BTC/USD', 'ETH/USD', 'NAS100', 'US30', 'US500', 'GER40']) {
    assert.ok(tvSymbol(sym), `${sym} mapped for TradingView Command Centre`);
  }
  assert.ok(TV_COMMAND_INSTRUMENTS.length >= 16);
});
