/* ================================================================
 * AURUM — in-memory sliding-window rate limiter + input validators.
 * No dependencies; per-IP; used on /api/deriv/* and /api/backtest.
 * ================================================================ */

import { createHash } from 'node:crypto';

export function rateLimit({ windowMs = 60000, max = 60, name = 'default' } = {}) {
  const hits = new Map(); // ip -> [timestamps]
  return (req, res, next) => {
    const ip = String(req.ip || req.socket?.remoteAddress || '?').slice(0, 64);
    const now = Date.now();
    let arr = hits.get(ip) || [];
    arr = arr.filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      if (hits.size > 5000) hits.clear(); // safety valve
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'rate_limited', scope: name, limit_per_min: max });
    }
    arr.push(now);
    hits.set(ip, arr);
    next();
  };
}

export const GRANULARITIES = [60, 180, 300, 900, 1800, 3600, 14400, 86400];
export const DURATION_UNITS = ['s', 'm', 'h', 'd', 't']; // t=ticks, per Deriv docs

export function parseGranularity(v) {
  const g = Number(v);
  return GRANULARITIES.includes(g) ? g : null;
}
export function parseIntInRange(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
export function parseAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/* duplicate-order guard: opt-in idempotency. The client sends a fresh `once`
   key per order INTENT (created when the confirm sheet opens / order placed).
   The same key twice inside the window -> 409 duplicate_request. Bodies
   WITHOUT a key pass straight through: legitimate rapid-fire orders (risk
   tests, deliberate identical positions) are never blocked, while real
   double-submits of the SAME intent are. */
export function dedupeBody({ windowMs = 60000, name = 'dedupe' } = {}) {
  const seen = new Map(); // once-key -> firstTs
  return (req, res, next) => {
    const key = String((req.body && req.body.once) || '');
    if (!key) return next(); /* no intent key -> nothing to dedupe */
    const now = Date.now();
    const prev = seen.get(key);
    if (prev && now - prev < windowMs) {
      return res.status(409).json({ error: 'duplicate_request', scope: name, detail: 'This exact order intent was already submitted — check Portfolio before retrying.' });
    }
    if (seen.size > 5000) seen.clear();
    seen.set(key, now);
    next();
  };
}
