/* ================================================================
 * SHELRICKTECH — Real-Time Signal Notification Centre, Web Audio
 * Chime, In-App Toast & Browser/PWA Notification Dispatcher (Section 9)
 * ================================================================ */

const STORAGE_KEY = 'aurum_notifications_v2';
const MAX_STORED = 120;
const DEDUPE_TTL_MS = 180_000;

let toastFn = null;
let _items = null;
const _dedupeMap = new Map();
const _listeners = new Set();

export function initNotifications(toastImpl) { toastFn = toastImpl; }

export function notifState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function enableNotifications() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

function loadStore() {
  if (_items !== null) return _items;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : [];
    _items = Array.isArray(parsed) ? parsed.slice(0, MAX_STORED) : [];
  } catch {
    _items = [];
  }
  return _items;
}

function saveStore() {
  try {
    if (typeof localStorage !== 'undefined' && _items) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_items.slice(0, MAX_STORED)));
    }
  } catch {}
  for (const fn of _listeners) {
    try { fn(getNotificationSnapshot()); } catch {}
  }
}

let audioCtx = null;
export function playSignalChime(kind = 'buy') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const notes = kind === 'sell' ? [660, 495] : kind === 'warn' ? [440, 370] : [528, 704];
    notes.forEach((hz, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, t0 + idx * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.09, t0 + idx * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + idx * 0.12 + 0.24);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0 + idx * 0.12);
      osc.stop(t0 + idx * 0.12 + 0.26);
    });
  } catch {}
}

/**
 * Notify the user: always an in-app toast + Signal Notification Centre record;
 * additionally a system notification when permission is granted.
 */
export function notify(title, body, opts = {}) {
  const { tag = 'shelricktech', kind = '' } = opts;
  if (toastFn) toastFn(title, body, kind);
  pushNotificationItem({
    dedupeKey: `${tag}:${title}:${body || ''}`,
    title,
    body: body || '',
    symbol: opts.symbol || '',
    direction: opts.direction || (kind === 'ok' ? 'BUY' : kind === 'err' ? 'WARN' : 'INFO'),
    strength: opts.strength ?? null,
    timeframe: opts.timeframe || '',
    broker: opts.broker || 'ALL',
    accountMode: opts.accountMode || '',
    status: opts.status || 'ACTIVE',
  }, { dedupeMs: opts.dedupeMs ?? 25_000, sound: opts.sound });

  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification('SHELRICKTECH · ' + title, { body: body || '', tag });
      n.onclick = () => { try { window.focus(); } catch {} n.close(); };
    } catch {}
  }
}

/** Level-guidance phrasing used by the SL/TP watcher. */
export const LEVEL_GUIDE = {
  sl: (sym, side, px) => `${sym}: stop-loss ${px} hit (${side}) — position closed. Review the setup before re-entering.`,
  tp1: (sym, side, px) => `${sym}: TP1 ${px} reached. Guidance: move stop-loss to entry, bank part if you scale out.`,
  tp2: (sym, side, px) => `${sym}: TP2 ${px} reached. Guidance: trail the remainder or close — target achieved.`,
  partial: (sym, side, px) => `${sym}: price ${px} — approaching a level. Watch ${side === 'BUY' ? 'support' : 'resistance'}.`
};

/** Add a structured notification to the Signal Notification Centre with deduplication. */
export function pushNotificationItem(item = {}, opts = {}) {
  const store = loadStore();
  const now = Date.now();
  const dedupeKey = item.dedupeKey || `${item.symbol || 'SYS'}:${item.direction || 'INFO'}:${item.timeframe || ''}:${item.status || 'NEW'}`;
  const prevTs = _dedupeMap.get(dedupeKey);
  if (prevTs && now - prevTs < (opts.dedupeMs ?? DEDUPE_TTL_MS)) {
    return null;
  }
  _dedupeMap.set(dedupeKey, now);

  const record = {
    id: item.id || `ntf-${now}-${Math.random().toString(36).slice(2, 7)}`,
    dedupeKey,
    title: String(item.title || 'Market Signal'),
    body: String(item.body || ''),
    symbol: String(item.symbol || ''),
    direction: String(item.direction || 'INFO').toUpperCase(),
    strength: Number.isFinite(Number(item.strength)) ? Math.round(Number(item.strength)) : null,
    timeframe: String(item.timeframe || ''),
    broker: String(item.broker || 'ALL').toUpperCase(),
    accountMode: String(item.accountMode || '').toUpperCase(),
    entry: item.entry ?? null,
    stopLoss: item.stopLoss ?? null,
    takeProfit: item.takeProfit ?? null,
    status: String(item.status || 'ACTIVE').toUpperCase(),
    read: Boolean(item.read),
    createdAtMs: item.createdAtMs || now,
    expiresAtMs: item.expiresAtMs || null,
  };
  store.unshift(record);
  if (store.length > MAX_STORED) store.length = MAX_STORED;
  saveStore();

  if (opts.sound) {
    playSignalChime(record.direction === 'SELL' ? 'sell' : record.status === 'INVALIDATED' ? 'warn' : 'buy');
  }
  return record;
}

export function refreshExpiredNotifications(nowMs = Date.now()) {
  const store = loadStore();
  let changed = false;
  for (const item of store) {
    if (item.status === 'ACTIVE' && item.expiresAtMs && nowMs >= item.expiresAtMs) {
      item.status = 'EXPIRED';
      changed = true;
    }
  }
  if (changed) saveStore();
  return changed;
}

export function listNotifications(filters = {}) {
  refreshExpiredNotifications();
  const store = loadStore();
  return store.filter((item) => {
    if (filters.unreadOnly && item.read) return false;
    if (filters.broker && filters.broker !== 'ALL' && item.broker !== 'ALL' && item.broker !== String(filters.broker).toUpperCase()) return false;
    if (filters.accountMode && filters.accountMode !== 'ALL' && item.accountMode && item.accountMode !== String(filters.accountMode).toUpperCase()) return false;
    if (filters.symbol && filters.symbol !== 'ALL' && item.symbol !== filters.symbol) return false;
    if (filters.timeframe && filters.timeframe !== 'ALL' && item.timeframe.toLowerCase() !== String(filters.timeframe).toLowerCase()) return false;
    if (filters.status && filters.status !== 'ALL' && item.status !== String(filters.status).toUpperCase()) return false;
    return true;
  });
}

export function unreadNotificationCount() {
  return loadStore().reduce((acc, item) => acc + (item.read ? 0 : 1), 0);
}

export function markNotificationRead(id) {
  const store = loadStore();
  const hit = store.find((i) => i.id === id);
  if (hit && !hit.read) {
    hit.read = true;
    saveStore();
  }
}

export function markAllNotificationsRead() {
  const store = loadStore();
  let changed = false;
  for (const item of store) {
    if (!item.read) { item.read = true; changed = true; }
  }
  if (changed) saveStore();
}

export function updateNotificationStatusBySignal(symbol, oldDirection, nextStatus, note = '') {
  const store = loadStore();
  let changed = false;
  for (const item of store) {
    if (item.symbol === symbol && (!oldDirection || item.direction === oldDirection) && item.status === 'ACTIVE') {
      item.status = nextStatus;
      if (note) item.body = `${item.body} · ${note}`;
      changed = true;
    }
  }
  if (changed) saveStore();
}

export function clearResolvedNotifications() {
  const store = loadStore();
  const before = store.length;
  _items = store.filter((i) => i.status === 'ACTIVE' || !i.read);
  if (_items.length !== before) saveStore();
}

export function getNotificationSnapshot() {
  const items = loadStore();
  return {
    unread: items.reduce((a, i) => a + (i.read ? 0 : 1), 0),
    total: items.length,
    items: items.slice(0, 80),
  };
}

export function subscribeNotifications(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
