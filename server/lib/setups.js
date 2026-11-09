/* ================================================================
 * AURUM — rule-based setups (ANALYSIS ONLY).
 * Four textbook setups evaluated on normalized candles. This module
 * is imported ONLY by the /api/setups/* routes and the Signal
 * Analyzer display card. It is deliberately NOT imported by the
 * decision engine, the sniper, the risk gate, or any order path.
 * No AI, no keys, no network: pure functions over candles.
 * Output shape per setup (contract):
 *   { setup, direction, entry, stop, tp1, rr,
 *     conditions: [{name, passed, value}], validData, reasonIfSkipped, confidence }
 * ================================================================ */

import { sma, emaSeries, rsi as rsiFn, atr } from './indicators.js';
import { adx, sessionVwap, swingLevels } from './indicators.ext.js';
import { log as logger } from './log.js';

export const SETUPS_ENABLED_ENV = 'AURUM_SETUPS_ENABLED';

export const DEFAULT_SETUP_CONFIG = {
  emaPullback: { fast: 20, slow: 50, slopeBars: 3, bandAtrMult: 0.75, stopAtrBuffer: 0.5, rrTarget: 1.5 },
  vwapRev: { kAtr: 2, adxMax: 25, stopAtrBuffer: 0.25 },
  orb: { rangeMinutes: 15, sessionStartUTC: 8, minRangeAtr: 0.25, maxRangeAtr: 1.5 },
  rsiRev: { period: 14, oversold: 30, overbought: 70, pivotAtrMult: 2, stopAtrBuffer: 0.5, rrTarget: 1.5 },
  horizonBars: 5
};

/* ---------------- data quality ---------------- */

/**
 * Reject duplicate / non-monotonic timestamps and granularity gaps
 * (> 2x expected spacing). Rejections are counted and logged once.
 */
export function validateCandles(candles, granularity) {
  const clean = [];
  const issues = { duplicates: 0, nonMonotonic: 0, gaps: 0 };
  let prevT = null;
  for (const c of (Array.isArray(candles) ? candles : [])) {
    if (!c || !Number.isFinite(c.time)) { issues.nonMonotonic++; continue; }
    if (prevT != null) {
      if (c.time === prevT) { issues.duplicates++; continue; }
      if (c.time < prevT) { issues.nonMonotonic++; continue; }
      if (granularity && c.time - prevT > granularity * 2) issues.gaps++;
    }
    clean.push(c);
    prevT = c.time;
  }
  if (issues.duplicates || issues.nonMonotonic || issues.gaps) {
    logger.info('setups', { event: 'candle_quality', duplicates: issues.duplicates, nonMonotonic: issues.nonMonotonic, gaps: issues.gaps });
  }
  /* dupes/non-monotonic are REJECTED (not silently cleaned); gaps logged but
     tolerated — session breaks (overnight/weekend) are normal market structure */
  return { clean, issues, ok: clean.length >= 60 && !issues.duplicates && !issues.nonMonotonic };
}

const cond = (name, passed, value) => ({ name, passed: !!passed, value: value == null ? null : (Math.round(Number(value) * 1e5) / 1e5) });
const money = (v) => Number.isFinite(v) ? Math.round(v * 1e5) / 1e5 : null;
const skip = (setup, validData, reason) => ({ setup, direction: null, entry: null, stop: null, tp1: null, rr: null, conditions: [], validData, reasonIfSkipped: reason, confidence: null });

function mkResult(setup, direction, entry, stop, tp1, conditions, confidence) {
  const risk = Math.abs(entry - stop);
  const rr = risk > 0 ? Math.round((Math.abs(tp1 - entry) / risk) * 100) / 100 : null;
  return { setup, direction, entry: money(entry), stop: money(stop), tp1: money(tp1), rr, conditions, validData: true, reasonIfSkipped: null, confidence };
}
const confFrom = (n) => Math.min(90, 50 + n * 10);

/* ---------------- 1) EMA_TREND_PULLBACK ---------------- */
export function emaTrendPullback(candles, cfg = DEFAULT_SETUP_CONFIG.emaPullback) {
  const closes = candles.map((c) => c.close);
  const f = emaSeries(closes, cfg.fast), s = emaSeries(closes, cfg.slow), a = atr(candles, 14);
  if (!f || !s || a == null) return skip('EMA_TREND_PULLBACK', false, 'insufficient_history');
  const i = closes.length - 1;
  const e20 = f[f.length - 1], e50 = s[s.length - 1];
  const e20prev = f[Math.max(0, f.length - 1 - cfg.slopeBars)];
  const slope = e20 - e20prev;
  const bar = candles[i], prevBar = candles[i - 1];
  const up = e20 > e50 && slope > 0;
  const dn = e20 < e50 && slope < 0;
  if (!up && !dn) return skip('EMA_TREND_PULLBACK', true, 'no_aligned_trend');
  const bandTop = Math.max(e20, e50) + cfg.bandAtrMult * a;
  const bandBot = Math.min(e20, e50) - cfg.bandAtrMult * a;
  const pulled = bar.low <= bandTop && bar.low >= bandBot;
  const confirmUp = up && bar.close > bar.open && bar.close > e20;
  const confirmDn = dn && bar.close < bar.open && bar.close < e20;
  const confirmed = up ? confirmUp : confirmDn;
  const conditions = [
    cond('EMA' + cfg.fast + '>EMA' + cfg.slow, e20 > e50, e20 - e50),
    cond('EMA' + cfg.fast + '>EMA' + cfg.slow + ' (short)', e20 < e50, e20 - e50),
    cond('slope ' + cfg.slopeBars + 'b', Math.abs(slope) > 0, slope),
    cond('pullback into band', pulled, (bar.low - e20) / a),
    cond('confirmation candle', confirmed, (bar.close - bar.open) / a)
  ];
  if (!(up || dn) ) return skip('EMA_TREND_PULLBACK', true, 'no_aligned_trend');
  if (!pulled) return skip('EMA_TREND_PULLBACK', true, 'no_pullback_into_band');
  if (!confirmed) return skip('EMA_TREND_PULLBACK', true, 'no_confirmation_candle');
  const sw = swingLevels(candles.slice(-30), 20);
  const direction = up ? 'BUY' : 'SELL';
  const entry = bar.close;
  const stop = up ? Math.min(sw.swingLow, bandBot) - cfg.stopAtrBuffer * a : Math.max(sw.swingHigh, bandTop) + cfg.stopAtrBuffer * a;
  const tp1 = up ? entry + cfg.rrTarget * Math.abs(entry - stop) : entry - cfg.rrTarget * Math.abs(entry - stop);
  const passed = conditions.filter((c) => c.passed).length;
  return mkResult('EMA_TREND_PULLBACK', direction, entry, stop, tp1, conditions, confFrom(passed));
}

/* ---------------- 2) VWAP_MEAN_REVERSION ---------------- */
export function vwapMeanReversion(candles, cfg = DEFAULT_SETUP_CONFIG.vwapRev, resetHourUTC = 0) {
  const a = atr(candles, 14);
  const vw = sessionVwap(candles, resetHourUTC);
  if (a == null || vw.vwap == null) return skip('VWAP_MEAN_REVERSION', false, vw.zeroVolume ? 'volume_not_traded_volume' : 'insufficient_history');
  const bar = candles[candles.length - 1], prevBar = candles[candles.length - 2];
  const stretch = bar.close - vw.vwap;
  const adxV = adx(candles, 14);
  const adxVal = adxV ? adxV.adx : null;
  const stretched = Math.abs(stretch) >= cfg.kAtr * a;
  const ranging = adxVal != null && adxVal < cfg.adxMax;
  const longRev = stretch < 0 && bar.close > bar.open && bar.close > prevBar.close;
  const shortRev = stretch > 0 && bar.close < bar.open && bar.close < prevBar.close;
  const confirmed = stretched ? (stretch < 0 ? longRev : shortRev) : false;
  const conditions = [
    cond('|close-VWAP| >= ' + cfg.kAtr + '*ATR', stretched, Math.abs(stretch) / a),
    cond('ADX < ' + cfg.adxMax, ranging, adxVal),
    cond('reversal candle', confirmed, (bar.close - bar.open) / a)
  ];
  if (vw.zeroVolume) return skip('VWAP_MEAN_REVERSION', false, 'volume_not_traded_volume');
  if (!stretched) return skip('VWAP_MEAN_REVERSION', true, 'not_stretched');
  if (!ranging) return skip('VWAP_MEAN_REVERSION', true, 'trending_adx_high');
  if (!confirmed) return skip('VWAP_MEAN_REVERSION', true, 'no_reversal_candle');
  const sw = swingLevels(candles.slice(-20), 14);
  const direction = stretch < 0 ? 'BUY' : 'SELL';
  const entry = bar.close;
  const stop = direction === 'BUY' ? sw.swingLow - cfg.stopAtrBuffer * a : sw.swingHigh + cfg.stopAtrBuffer * a;
  const tp1 = vw.vwap; /* target VWAP */
  const passed = conditions.filter((c) => c.passed).length;
  return mkResult('VWAP_MEAN_REVERSION', direction, entry, stop, tp1, conditions, confFrom(passed));
}

/* ---------------- 3) OPENING_RANGE_BREAKOUT ---------------- */
const ORB_CATEGORIES = ['forex', 'commodities', 'indices'];
export function openingRangeBreakout(candles, cfg = DEFAULT_SETUP_CONFIG.orb, category = 'forex') {
  if (!ORB_CATEGORIES.includes(category)) return skip('OPENING_RANGE_BREAKOUT', true, 'no_defined_session'); /* 24/7: synthetics, crypto */
  const dayMs = 86400000;
  const lastT = candles[candles.length - 1].time * 1000;
  const d = new Date(lastT);
  const dayStart = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), cfg.sessionStartUTC) / 1000);
  const rangeEnd = dayStart + cfg.rangeMinutes * 60;
  const rangeBars = candles.filter((c) => c.time >= dayStart && c.time < rangeEnd);
  const afterBars = candles.filter((c) => c.time >= rangeEnd);
  const a = atr(candles, 14);
  if (a == null || rangeBars.length < 2 || !afterBars.length) return skip('OPENING_RANGE_BREAKOUT', true, 'session_incomplete');
  const rHi = Math.max.apply(null, rangeBars.map((c) => c.high));
  const rLo = Math.min.apply(null, rangeBars.map((c) => c.low));
  const width = rHi - rLo;
  const tooNarrow = width < cfg.minRangeAtr * a;
  const tooWide = width > cfg.maxRangeAtr * a;
  const bar = afterBars[afterBars.length - 1];
  const brokeUp = bar.close > rHi;
  const brokeDn = bar.close < rLo;
  /* one trade per session per direction: an earlier close beyond the same
     side after the range means this session's breakout already happened */
  const priorUp = afterBars.slice(0, -1).some((c) => c.close > rHi);
  const priorDn = afterBars.slice(0, -1).some((c) => c.close < rLo);
  const conditions = [
    cond('range width >= ' + cfg.minRangeAtr + '*ATR', !tooNarrow, width / a),
    cond('range width <= ' + cfg.maxRangeAtr + '*ATR', !tooWide, width / a),
    cond('close above range high', brokeUp && !priorUp, (bar.close - rHi) / a),
    cond('close below range low', brokeDn && !priorDn, (rLo - bar.close) / a)
  ];
  if (tooNarrow) return skip('OPENING_RANGE_BREAKOUT', true, 'range_too_narrow');
  if (tooWide) return skip('OPENING_RANGE_BREAKOUT', true, 'range_too_wide');
  if (!(brokeUp || brokeDn)) return skip('OPENING_RANGE_BREAKOUT', true, 'no_breakout_close');
  if (brokeUp && priorUp) return skip('OPENING_RANGE_BREAKOUT', true, 'breakout_already_traded_up');
  if (brokeDn && priorDn) return skip('OPENING_RANGE_BREAKOUT', true, 'breakout_already_traded_down');
  const direction = brokeUp ? 'BUY' : 'SELL';
  const entry = bar.close;
  const stop = brokeUp ? rLo : rHi; /* opposite edge of the range */
  const tp1 = brokeUp ? entry + width : entry - width; /* measured move */
  const passed = conditions.filter((c) => c.passed).length;
  return mkResult('OPENING_RANGE_BREAKOUT', direction, entry, stop, tp1, conditions, confFrom(passed));
}

/* ---------------- 4) RSI_MEAN_REVERSION ---------------- */
export function rsiMeanReversion(candles, cfg = DEFAULT_SETUP_CONFIG.rsiRev) {
  const r = rsiFn(candles.map((c) => c.close), cfg.period);
  const a = atr(candles, 14);
  if (r == null || a == null) return skip('RSI_MEAN_REVERSION', false, 'insufficient_history');
  const bar = candles[candles.length - 1], prevBar = candles[candles.length - 2];
  const sw = swingLevels(candles.slice(-40), 30);
  const nearSupport = Math.abs(bar.low - sw.swingLow) <= cfg.pivotAtrMult * a || Math.abs(bar.close - sw.swingLow) <= cfg.pivotAtrMult * a;
  const nearResistance = Math.abs(bar.high - sw.swingHigh) <= cfg.pivotAtrMult * a || Math.abs(bar.close - sw.swingHigh) <= cfg.pivotAtrMult * a;
  const longSig = r < cfg.oversold, shortSig = r > cfg.overbought;
  const confirmUp = bar.close > bar.open && bar.close > prevBar.close;
  const confirmDn = bar.close < bar.open && bar.close < prevBar.close;
  const longOk = longSig && nearSupport && confirmUp;
  const shortOk = shortSig && nearResistance && confirmDn;
  const conditions = [
    cond('RSI < ' + cfg.oversold, longSig, r),
    cond('RSI > ' + cfg.overbought, shortSig, r),
    cond('near swing support', nearSupport, (bar.close - sw.swingLow) / a),
    cond('near swing resistance', nearResistance, (sw.swingHigh - bar.close) / a),
    cond('confirmation candle', longOk ? confirmUp : shortOk ? confirmDn : false, (bar.close - bar.open) / a)
  ];
  if (!longSig && !shortSig) return skip('RSI_MEAN_REVERSION', true, 'rsi_neutral');
  if (longSig && !nearSupport) return skip('RSI_MEAN_REVERSION', true, 'not_at_pivot');
  if (shortSig && !nearResistance) return skip('RSI_MEAN_REVERSION', true, 'not_at_pivot');
  if (!(longOk || shortOk)) return skip('RSI_MEAN_REVERSION', true, 'no_confirmation_candle');
  const direction = longOk ? 'BUY' : 'SELL';
  const entry = bar.close;
  const stop = longOk ? sw.swingLow - cfg.stopAtrBuffer * a : sw.swingHigh + cfg.stopAtrBuffer * a;
  const tp1 = longOk ? entry + cfg.rrTarget * Math.abs(entry - stop) : entry - cfg.rrTarget * Math.abs(entry - stop);
  const passed = conditions.filter((c) => c.passed).length;
  return mkResult('RSI_MEAN_REVERSION', direction, entry, stop, tp1, conditions, confFrom(passed));
}

/* ---------------- entry point ---------------- */

/**
 * Evaluate all four setups on ONE clean candle series (default: 5m).
 * category: 'forex'|'commodities'|'crypto'|'synthetics'|'indices'
 */
export function evaluateSetups({ symbol, candles, granularity = 300, category = 'forex', config = DEFAULT_SETUP_CONFIG, sessionStartUTC, resetHourUTC = 0 }) {
  const { clean, issues, ok } = validateCandles(candles, granularity);
  if (!ok) {
    return {
      symbol, ts: Date.now(), granularity,
      dataQuality: { accepted: clean.length, ...issues, valid: false },
      results: [
        skip('EMA_TREND_PULLBACK', false, 'insufficient_clean_candles'),
        skip('VWAP_MEAN_REVERSION', false, 'insufficient_clean_candles'),
        skip('OPENING_RANGE_BREAKOUT', category && !ORB_CATEGORIES.includes(category) ? true : false, 'insufficient_clean_candles'),
        skip('RSI_MEAN_REVERSION', false, 'insufficient_clean_candles')
      ]
    };
  }
  const orbCfg = sessionStartUTC != null ? Object.assign({}, config.orb, { sessionStartUTC }) : config.orb;
  return {
    symbol, ts: Date.now(), granularity,
    dataQuality: { accepted: clean.length, ...issues, valid: true },
    results: [
      emaTrendPullback(clean, config.emaPullback),
      vwapMeanReversion(clean, config.vwapRev, resetHourUTC),
      openingRangeBreakout(clean, orbCfg, category),
      rsiMeanReversion(clean, config.rsiRev)
    ]
  };
}
