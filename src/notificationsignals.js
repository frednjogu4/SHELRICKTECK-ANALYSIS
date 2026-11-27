import { sniperMarketAllowed } from './sniperengine.js';

/* Notification records are discovery hints, never executable order payloads.
 * Only explicitly typed, recent entry signals can request a fresh Sniper scan. */
export const NOTIFICATION_SIGNAL_MAX_AGE_MS = 180_000;

export function signalNotificationFields(reading = {}, { symbol = reading.symbol, timeframe = reading.tf || '5m' } = {}, nowMs = Date.now()) {
  const direction = reading.signal;
  const source = String(reading.data_source || reading.source || '');
  const daily = /daily|\b1d\b/i.test(timeframe) || /yahoo/i.test(source);
  const actionable = ['BUY', 'SELL'].includes(direction) && !reading.error && !daily && Number(reading.confidence) > 0;
  return {
    signalType: actionable ? 'ENTRY_SIGNAL' : 'CONTEXT',
    symbol: symbol || '', direction: direction || 'INFO', strength: reading.confidence ?? null,
    timeframe, source,
    entry: reading.entry ?? null, stopLoss: reading.stop_loss ?? null, takeProfit: reading.tp1 ?? null,
    expiresAtMs: nowMs + NOTIFICATION_SIGNAL_MAX_AGE_MS,
  };
}

export function notificationSignalCandidates(items, { broker, environment, knownSymbols, allowSynthetics = false, instruments = [], allowedInstruments = [], allowedTimeframes = [], marketScope = 'ALL' }, nowMs = Date.now()) {
  const selected = new Map();
  const categories = new Map(instruments.map(i => [i.s, i.c]));
  const brokerName = String(broker || '').toUpperCase();
  for (const n of [...items].sort((a, b) => Number(b.createdAtMs) - Number(a.createdAtMs))) {
    if (n.signalType !== 'ENTRY_SIGNAL' || n.status !== 'ACTIVE' || !['BUY', 'SELL'].includes(n.direction)) continue;
    if (!knownSymbols.has(n.symbol) || selected.has(n.symbol)) continue;
    const age = nowMs - Number(n.createdAtMs), expiry = Number(n.expiresAtMs);
    if (!(Number(n.createdAtMs) > 0) || !Number.isFinite(age) || age < 0 || age > NOTIFICATION_SIGNAL_MAX_AGE_MS || !Number.isFinite(expiry) || expiry <= nowMs) continue;
    if (n.broker !== 'ALL' && n.broker !== brokerName && !(brokerName === 'MT5' && n.broker === 'EXNESS MT5')) continue;
    if (n.accountMode && n.accountMode !== String(environment || '').toUpperCase()) continue;
    if (!sniperMarketAllowed({ c: categories.get(n.symbol) }, marketScope)) continue;
    if (!allowSynthetics && categories.get(n.symbol) === 'synthetics') continue;
    if (allowedInstruments.length && !allowedInstruments.includes(n.symbol)) continue;
    const frames = String(n.timeframe || '').toLowerCase().match(/\b\d+[mhd]\b/g) || [];
    if (allowedTimeframes.length && !frames.some(tf => allowedTimeframes.includes(tf))) continue;
    if (/daily|\b1d\b/i.test(n.timeframe) || /yahoo/i.test(n.source || '')) continue;
    selected.set(n.symbol, { symbol: n.symbol, direction: n.direction, notificationId: n.id });
  }
  return [...selected.values()];
}
