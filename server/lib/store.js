/* ================================================================
 * AURUM — file-backed store (Phase 1 skipped: no Supabase yet)
 *
 * Same shape as the SQL schema so a repository swap to Supabase later
 * is mechanical: signals (with one ACTIVE row per user/symbol/timeframe,
 * 5-min TTL) and ai_usage (per-day budget accounting).
 * Atomic writes; last 500 signals / 2000 usage rows retained.
 * ================================================================ */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const SIGNAL_CAP = 500;
const USAGE_CAP = 2000;
export const SIGNAL_TTL_MS = 5 * 60 * 1000;

export function todayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function createStore(filePath = join(process.cwd(), 'server', 'data', 'store.json')) {
  const data = { signals: [], usage: [] };

  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed.signals)) data.signals = parsed.signals;
      if (Array.isArray(parsed.usage)) data.usage = parsed.usage;
    } catch (e) {
      /* corrupt file: start fresh rather than crash the server */
    }
  }

  let saveTimer = null;
  function save() {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, filePath);
  }
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; save(); }, 250);
    if (saveTimer.unref) saveTimer.unref();
  }

  return {
    /* ---------- signals ---------- */
    getActive(user, symbol, now = Date.now()) {
      return data.signals.find(
        (s) => s.user === user && s.symbol === symbol && s.active &&
          now - Date.parse(s.created_at) < SIGNAL_TTL_MS
      ) || null;
    },
    addSignal(rec) {
      const row = Object.assign({ id: 'sig_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }, rec);
      // enforce one ACTIVE row per user/symbol/timeframe
      for (const s of data.signals) {
        if (s.active && s.user === row.user && s.symbol === row.symbol && s.timeframe === row.timeframe) s.active = false;
      }
      data.signals.unshift(row);
      if (data.signals.length > SIGNAL_CAP) data.signals.length = SIGNAL_CAP;
      save();
      return row;
    },
    listSignals({ user, limit = 20 } = {}) {
      return data.signals.filter((s) => !user || s.user === user).slice(0, limit);
    },

    /* ---------- usage / budget ---------- */
    recordUsage(u) {
      const row = Object.assign({ id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), created_at: new Date().toISOString(), day: todayKey() }, u);
      data.usage.unshift(row);
      if (data.usage.length > USAGE_CAP) data.usage.length = USAGE_CAP;
      save();
      return row;
    },
    usageToday(user, day = todayKey()) {
      return data.usage.filter((u) => (!user || u.user === user) && (u.day || todayKey(Date.parse(u.created_at))) === day);
    },
    statsToday(user, day = todayKey()) {
      const rows = this.usageToday(user, day);
      return {
        calls: rows.length,
        tokens_in: rows.reduce((s, u) => s + (u.tokens_in || 0), 0),
        tokens_out: rows.reduce((s, u) => s + (u.tokens_out || 0), 0),
        cost: Math.round(rows.reduce((s, u) => s + (u.cost || 0), 0) * 10000) / 10000,
        day
      };
    },

    /* ---------- lifecycle ---------- */
    flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } save(); },
    _data: data
  };
}
