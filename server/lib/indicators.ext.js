/* ================================================================
 * AURUM — additional indicators for the rule-based setups module
 * (ANALYSIS ONLY). Reuses nothing here that duplicates
 * lib/indicators.js — that file is untouched by design; everything
 * missing from it (ADX, session VWAP, swings, pivots) lives here.
 * Pure functions only: no fetching, no broker calls, no state.
 * ================================================================ */

/** Wilder's smoothing (used by ADX). */
export function wilder(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out.push(prev);
  }
  return out;
}

/**
 * ADX(14) with +DI / -DI. Returns { adx, plusDI, minusDI } for the last bar,
 * or null when there is less than 2*period+1 candles.
 */
export function adx(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period * 2 + 1) return null;
  const plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  const trS = wilder(trs, period), pS = wilder(plusDM, period), mS = wilder(minusDM, period);
  if (!trS || !pS || !mS) return null;
  const dx = [];
  let plusDI = 0, minusDI = 0;
  for (let i = 0; i < trS.length; i++) {
    const pdi = trS[i] > 0 ? (100 * pS[i]) / trS[i] : 0;
    const mdi = trS[i] > 0 ? (100 * mS[i]) / trS[i] : 0;
    plusDI = pdi; minusDI = mdi;
    dx.push(pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0);
  }
  const adxS = wilder(dx, period);
  return { adx: adxS ? adxS[adxS.length - 1] : null, plusDI, minusDI };
}

/**
 * Session VWAP over candles belonging to one session (caller pre-slices or we
 * slice by UTC day boundary at `resetHourUTC`). Requires finite volume>0 on
 * every candle; returns { vwap, bars, zeroVolume } — zeroVolume=true when the
 * window exists but volume is missing/zero (caller must mark validData=false).
 */
export function sessionVwap(candles, resetHourUTC = 0) {
  if (!Array.isArray(candles) || !candles.length) return { vwap: null, bars: 0, zeroVolume: true };
  const last = candles[candles.length - 1];
  const dayStart = Date.UTC(new Date(last.time * 1000).getUTCFullYear(), new Date(last.time * 1000).getUTCMonth(), new Date(last.time * 1000).getUTCDate(), resetHourUTC, 0, 0) / 1000;
  let pv = 0, vv = 0, bars = 0, zero = false;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (c.time < dayStart) break;
    const typical = (c.high + c.low + c.close) / 3;
    const v = Number(c.volume);
    if (!Number.isFinite(v) || v <= 0) { zero = true; continue; }
    pv += typical * v; vv += v; bars++;
  }
  if (vv <= 0) return { vwap: null, bars: 0, zeroVolume: true };
  return { vwap: pv / vv, bars, zeroVolume: zero };
}

/** Most recent swing high/low over `lookback` bars (fractal: higher than 2 neighbours each side). */
export function swingLevels(candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < lookback + 5) return { swingHigh: null, swingLow: null };
  const seg = candles.slice(-lookback);
  let hi = null, lo = null;
  for (let i = 2; i < seg.length - 2; i++) {
    if (seg[i].high >= seg[i - 1].high && seg[i].high >= seg[i - 2].high && seg[i].high >= seg[i + 1].high && seg[i].high >= seg[i + 2].high) hi = seg[i].high;
    if (seg[i].low <= seg[i - 1].low && seg[i].low <= seg[i - 2].low && seg[i].low <= seg[i + 1].low && seg[i].low <= seg[i + 2].low) lo = seg[i].low;
  }
  /* fall back to window extremes so a stop is never null in a trending run */
  if (hi == null) hi = Math.max.apply(null, seg.map((c) => c.high));
  if (lo == null) lo = Math.min.apply(null, seg.map((c) => c.low));
  return { swingHigh: hi, swingLow: lo };
}

/**
 * Classic floor-trader pivots from the previous completed UTC day
 * (P, R1, S1, R2, S2). Returns null when no full previous day exists.
 */
export function pivotLevels(candles, resetHourUTC = 0) {
  if (!Array.isArray(candles) || candles.length < 10) return null;
  const lastT = candles[candles.length - 1].time * 1000;
  const day = new Date(lastT);
  const todayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), resetHourUTC) / 1000;
  const prevStart = todayStart - 86400;
  const prev = candles.filter((c) => c.time >= prevStart && c.time < todayStart);
  if (prev.length < 5) return null;
  const H = Math.max.apply(null, prev.map((c) => c.high));
  const L = Math.min.apply(null, prev.map((c) => c.low));
  const C = prev[prev.length - 1].close;
  const P = (H + L + C) / 3;
  return { P, R1: 2 * P - L, S1: 2 * P - H, R2: P + (H - L), S2: P - (H - L) };
}
