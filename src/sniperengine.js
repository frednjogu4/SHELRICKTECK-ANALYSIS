/* ================================================================
 * SHELRICKTECH — Automated Sniper Entry Engine, Dynamic Net-Profit
 * Target Auto-Closure & Immutable Execution Audit Trail (Sections 5, 6, 20)
 * ================================================================ */

export const PROFIT_TARGET_PRESETS = [2, 3, 4, 5, 10];

export const DEFAULT_SNIPER_CONFIG = {
  execEnabled: false,             // Master Sniper execution switch (explicit per-account)
  authorizedKey: null,            // Exact `${broker}:${accountId}:${environment}` authorized by user
  authorizedBy: null,
  authorizedAt: null,
  emergencyHalted: false,
  minStrength: 75,
  marketScope: 'ALL',             // Sniper analysis/new entries: ALL | FOREX | INDICES | SELECTED
  selectedMarkets: [],            // Exact catalogue symbols; SELECTED with [] scans nothing
  allowedTimeframes: ['5m', '15m', '1h'],
  allowedInstruments: [],         // Empty = all instruments enabled in workspace scanner
  sizingMode: 'fixed_usd',        // 'fixed_usd' | 'fixed_lots' | 'risk_pct'
  fixedUsd: 10,
  fixedLots: 0.01,
  riskPct: 1.0,
  strictMinVolume: true,          // Never secretly inflate below broker minimum
  maxConcurrentPositions: 3,
  maxDailyTrades: 10,
  dailyProfitTargetUsd: 50,
  maxDailyLossUsd: 30,
  maxDrawdownPct: 10,
  maxExposureUsd: 5000,
  maxSpreadRatio: 0.35,
  maxSlippagePoints: 20,
  sessionFilter: 'ALL',           // 'ALL' | 'LONDON' | 'NEW_YORK' | 'LONDON_NY' | 'ASIA'
  pauseOnHighImpactNews: true,
  newsWindowBeforeMin: 15,
  newsWindowAfterMin: 15,
  cooldownSec: 60,
  preventDuplicateSymbol: true,
  autoProfitCloseEnabled: false,  // Dynamic net-profit target auto-close toggle
  netProfitTargetUsd: 3.0,        // Default $3 net profit target ($2, $3, $4, $5, $10, or custom)
  perPositionTargets: {},         // { [posKey]: customTargetUsd }
};

export function buildAccountAuthKey(broker, accountId, environment) {
  if (!broker || !environment) return null;
  const cleanBroker = String(broker).trim().toLowerCase();
  const cleanEnv = String(environment).trim().toLowerCase();
  if (cleanEnv !== 'demo' && cleanEnv !== 'real') return null;
  const cleanId = String(accountId || cleanBroker).trim();
  return `${cleanBroker}:${cleanId}:${cleanEnv}`;
}

export function normalizeSniperConfig(raw = {}) {
  const merged = { ...DEFAULT_SNIPER_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  merged.execEnabled = Boolean(merged.execEnabled) && !merged.emergencyHalted && Boolean(merged.authorizedKey);
  merged.marketScope = ['ALL', 'FOREX', 'INDICES', 'SELECTED'].includes(merged.marketScope) ? merged.marketScope : 'ALL';
  merged.selectedMarkets = Array.isArray(merged.selectedMarkets)
    ? [...new Set(merged.selectedMarkets.filter(s => typeof s === 'string').map(s => s.trim().toUpperCase()).filter(Boolean))]
    : [];
  merged.minStrength = Math.max(50, Math.min(99, Number(merged.minStrength) || 75));
  merged.fixedUsd = Math.max(0.35, Number(merged.fixedUsd) || 10);
  merged.fixedLots = Math.max(0.001, Number(merged.fixedLots) || 0.01);
  merged.riskPct = Math.max(0.1, Math.min(10, Number(merged.riskPct) || 1));
  merged.maxConcurrentPositions = Math.max(1, Math.min(25, Math.round(Number(merged.maxConcurrentPositions) || 3)));
  merged.maxDailyTrades = Math.max(1, Math.min(200, Math.round(Number(merged.maxDailyTrades) || 10)));
  merged.dailyProfitTargetUsd = Math.max(0, Number(merged.dailyProfitTargetUsd) ?? 50);
  merged.maxDailyLossUsd = Math.max(0, Number(merged.maxDailyLossUsd) ?? 30);
  merged.maxDrawdownPct = Math.max(1, Math.min(80, Number(merged.maxDrawdownPct) || 10));
  merged.maxExposureUsd = Math.max(0, Number(merged.maxExposureUsd) ?? 5000);
  merged.maxSlippagePoints = Math.max(1, Math.min(100, Math.round(Number(merged.maxSlippagePoints) || 20)));
  merged.cooldownSec = Math.max(5, Math.min(3600, Math.round(Number(merged.cooldownSec) || 60)));
  merged.netProfitTargetUsd = Math.max(0.1, Number(merged.netProfitTargetUsd) || 3);
  if (!merged.perPositionTargets || typeof merged.perPositionTargets !== 'object') {
    merged.perPositionTargets = {};
  }
  return merged;
}

export function isTradingSessionAllowed(sessionFilter = 'ALL', nowMs = Date.now()) {
  if (!sessionFilter || sessionFilter === 'ALL') return { ok: true, session: '24h All Sessions' };
  const utcHour = new Date(nowMs).getUTCHours();
  const inAsia = utcHour >= 0 && utcHour < 9;
  const inLondon = utcHour >= 7 && utcHour < 16;
  const inNy = utcHour >= 12 && utcHour < 21;
  if (sessionFilter === 'ASIA') return { ok: inAsia, session: 'Tokyo/Asia (00:00–09:00 UTC)' };
  if (sessionFilter === 'LONDON') return { ok: inLondon, session: 'London (07:00–16:00 UTC)' };
  if (sessionFilter === 'NEW_YORK') return { ok: inNy, session: 'New York (12:00–21:00 UTC)' };
  if (sessionFilter === 'LONDON_NY') return { ok: inLondon || inNy, session: 'London + NY (07:00–21:00 UTC)' };
  return { ok: true, session: sessionFilter };
}

export function checkHighImpactNewsWindow(events = [], symbol = '', { beforeMin = 15, afterMin = 15, nowMs = Date.now() } = {}) {
  if (!Array.isArray(events) || !events.length) return { active: false, event: null };
  const symUpper = String(symbol || '').toUpperCase();
  const beforeMs = Math.max(0, Number(beforeMin) || 15) * 60_000;
  const afterMs = Math.max(0, Number(afterMin) || 15) * 60_000;

  for (const ev of events) {
    const impact = String(ev.impact || ev.importance || '').toLowerCase();
    if (!impact.includes('high') && impact !== '3') continue;
    const rawT = ev.tsMs ?? ev.t ?? ev.timestamp ?? null;
    let evMs = NaN;
    if (typeof rawT === 'number' && Number.isFinite(rawT)) {
      evMs = rawT > 0 && rawT < 1e11 ? rawT * 1000 : rawT;
    } else if (rawT instanceof Date) {
      evMs = rawT.getTime();
    } else if (typeof rawT === 'string' && rawT.trim()) {
      const n = Number(rawT);
      evMs = Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(rawT);
    } else if (ev.time || ev.date) {
      evMs = Date.parse(String(ev.time || ev.date));
    }
    if (!Number.isFinite(evMs)) continue;
    const ccy = String(ev.currency || ev.country || '').toUpperCase();
    const affectsPair = !ccy || ccy === 'USD' || symUpper.includes(ccy);
    if (!affectsPair) continue;
    if (nowMs >= evMs - beforeMs && nowMs <= evMs + afterMs) {
      return {
        active: true,
        event: ev,
        title: `${ccy ? ccy + ' ' : ''}${ev.title || ev.event || 'High-Impact Release'}`,
        evMs,
      };
    }
  }
  return { active: false, event: null };
}

/**
 * Compute exact NET monetary P&L of an open broker position after commissions, swaps, and fees,
 * and determine whether the user's dynamic profit target is met.
 */
export function evaluatePositionProfitTarget(pos, config = DEFAULT_SNIPER_CONFIG) {
  if (!pos || typeof pos !== 'object') {
    return { eligible: false, netProfit: 0, grossProfit: 0, costs: 0, targetUsd: 0, reason: 'Invalid position' };
  }
  const posKey = String(pos.posKey || pos.ticket || pos.contract_id || pos.id || '');
  const customTarget = posKey && Number.isFinite(Number(config?.perPositionTargets?.[posKey]))
    ? Number(config.perPositionTargets[posKey])
    : null;
  const targetUsd = customTarget != null && customTarget > 0
    ? customTarget
    : Number(config?.netProfitTargetUsd || 0);

  const grossProfit = Number(pos.profit ?? pos.unrealizedPl ?? 0) || 0;
  const commission = Number(pos.commission || 0) || 0;
  const swap = Number(pos.swap || 0) || 0;
  const fee = Number(pos.fee || 0) || 0;
  const costs = commission + swap + fee;
  const netProfit = Number.isFinite(Number(pos.net_profit))
    ? Number(pos.net_profit)
    : Number((grossProfit + costs).toFixed(2));

  if (!config?.autoProfitCloseEnabled || !(targetUsd > 0)) {
    return { eligible: false, posKey, netProfit, grossProfit, costs, targetUsd, reason: 'Auto profit-target closure is disabled.' };
  }
  if (netProfit + 1e-9 >= targetUsd) {
    return {
      eligible: true,
      posKey,
      netProfit,
      grossProfit,
      costs,
      targetUsd,
      reason: `Net profit +$${netProfit.toFixed(2)} (gross $${grossProfit.toFixed(2)}, fees/swap $${costs.toFixed(2)}) reached target +$${targetUsd.toFixed(2)}.`,
    };
  }
  return {
    eligible: false,
    posKey,
    netProfit,
    grossProfit,
    costs,
    targetUsd,
    remainingUsd: Number((targetUsd - netProfit).toFixed(2)),
    reason: `Tracking +$${netProfit.toFixed(2)} / +$${targetUsd.toFixed(2)} net target`,
  };
}

/** In-memory runtime coordinator preventing race conditions & duplicate closes/entries. */
export function createSniperRuntime() {
  const closingLocks = new Map();     // posKey -> timestampMs
  const executedSignals = new Set();  // signalId
  let orderInFlight = false;
  let lastExecutionAtMs = 0;
  const auditEvents = [];

  function recordAudit(category, action, detail = {}, actor = 'user') {
    const entry = {
      id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      tsIso: new Date().toISOString(),
      tsMs: Date.now(),
      actor,
      category,
      action,
      detail,
    };
    auditEvents.unshift(entry);
    if (auditEvents.length > 300) auditEvents.length = 300;
    return entry;
  }

  function acquireCloseLock(posKey, ttlMs = 15_000) {
    if (!posKey) return false;
    const now = Date.now();
    const prev = closingLocks.get(posKey);
    if (prev && now - prev < ttlMs) return false;
    closingLocks.set(posKey, now);
    return true;
  }

  function releaseCloseLock(posKey) {
    closingLocks.delete(posKey);
  }

  function canStartAutoEntry(cooldownSec = 60) {
    if (orderInFlight) return { ok: false, reason: 'Another automated order is currently awaiting broker confirmation.' };
    const elapsed = (Date.now() - lastExecutionAtMs) / 1000;
    if (lastExecutionAtMs > 0 && elapsed < cooldownSec) {
      return { ok: false, reason: `Cooldown active (${Math.ceil(cooldownSec - elapsed)}s remaining).` };
    }
    return { ok: true };
  }

  function beginAutoEntry() { orderInFlight = true; }
  function finishAutoEntry(executed = false, signalId = null) {
    orderInFlight = false;
    if (executed) {
      lastExecutionAtMs = Date.now();
      if (signalId) executedSignals.add(signalId);
    }
  }

  function emergencyReset(actor = 'user') {
    orderInFlight = false;
    closingLocks.clear();
    return recordAudit('EMERGENCY_STOP', 'STOP ALL AUTOMATION', { message: 'All automated Sniper entries and auto-closures halted immediately.' }, actor);
  }

  return {
    closingLocks,
    executedSignals,
    auditEvents,
    recordAudit,
    acquireCloseLock,
    releaseCloseLock,
    canStartAutoEntry,
    beginAutoEntry,
    finishAutoEntry,
    emergencyReset,
    isOrderInFlight: () => orderInFlight,
  };
}

/** Authorization is not evidence of a live broker snapshot. Fail closed. */
export function checkAutomationSnapshot({ broker, connected, syncTsSec, snapshotAt, snapshotFailed, positions }, nowMs = Date.now()) {
  if (!connected) return { ok: false, reason: 'Broker disconnected. Reconnect the local bridge.' };
  if (broker !== 'mt5') return { ok: true };
  if (snapshotFailed) return { ok: false, reason: 'MT5 snapshot refresh failed. Reconnect Exness and refresh the broker snapshot.' };
  const age = nowMs - Number(syncTsSec) * 1000;
  const receivedAge = nowMs - Number(snapshotAt);
  if (!(Number(syncTsSec) > 0) || !(Number(snapshotAt) > 0) || !Number.isFinite(age) || !Number.isFinite(receivedAge) || age < -5000 || receivedAge < -5000 || age > 45000 || receivedAge > 45000) {
    return { ok: false, reason: 'MT5 account data is stale or unavailable (45s limit). Refresh Broker Snapshot; reconnect Exness if refresh fails.' };
  }
  if (!Array.isArray(positions)) return { ok: false, reason: 'Live MT5 positions are unavailable. Refresh Broker Snapshot before automation.' };
  return { ok: true };
}

/** Only an explicit, pre-order candidate rejection permits trying another symbol.
 * A fill, global safety halt, unknown result, or exception stops this cycle. */
export async function trySniperCandidates(candidates, { canContinue, attempt, onSkip = () => {} }) {
  const skipped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!canContinue()) return { status: 'halted', skipped };
    if (!candidate?.symbol || seen.has(candidate.symbol)) continue;
    seen.add(candidate.symbol);
    const result = await attempt(candidate);
    if (result?.status !== 'skipped') return { ...result, status: result?.status || 'halted', skipped };
    skipped.push({ symbol: candidate.symbol, reason: result.reason || 'Setup not executable.' });
    onSkip(candidate, result);
  }
  return { status: 'exhausted', skipped };
}

/** Rotate the bounded base scan so a permanently rejected first batch cannot starve other markets. */
export function sniperScanBatch(universe, cursor, breadth) {
  if (!universe.length) return { symbols: [], nextCursor: 0 };
  const count = Math.min(universe.length, breadth);
  const symbols = Array.from({ length: count }, (_, i) => universe[(cursor + i) % universe.length].s);
  return { symbols, nextCursor: (cursor + count) % universe.length };
}

/** Category scope applies to analysis/new entries, never to management of open positions. */
export function sniperMarketAllowed(instrument, scope = 'ALL', selectedMarkets = []) {
  if (!instrument) return false;
  if (scope === 'SELECTED') return Array.isArray(selectedMarkets) && selectedMarkets.includes(instrument.s);
  if (scope === 'ALL') return true;
  if (scope === 'FOREX') return instrument.c === 'forex';
  if (scope === 'INDICES') return instrument.c === 'indices' || instrument.c === 'stockindices';
  return false;
}

export { checkMt5OrderSize as checkSniperMt5Size } from './mt5sizing.js';

export function sniperSizingGuidance(mode, usdSize, lotSize) {
  if (mode === 'fixed_lots') return `MT5: request ${lotSize} lots per entry, subject to this symbol's minimum, volume step, margin and risk checks. The USD notional field is not the MT5 lot size. The net-profit target is separate; this mode does not guarantee a fill or profit.`;
  if (mode === 'risk_pct') return 'This mode requests a percentage of equity as NOTIONAL exposure—not a maximum loss at the stop. MT5 minimum lots, margin and risk checks still apply. The net-profit target is separate.';
  return `MT5: $${Number(usdSize).toFixed(2)} means NOTIONAL exposure—not margin, maximum loss or the net-profit target. A broker minimum of 0.01 lots may represent much more exposure and block this size. To request lots, explicitly select Fixed MT5 Lots and review the broker minimum and margin first. No size is increased automatically. Deriv uses the USD field as stake.`;
}
