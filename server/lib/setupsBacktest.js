/* ================================================================
 * AURUM — walk-forward scoring for the rule-based setups
 * (ANALYSIS ONLY). Same philosophy and conventions as the existing
 * lib/backtest.js harness (walk bars, conservative SL-first exits,
 * R accounting) — that file stays untouched so its own tests prove
 * no regression. Reports OUT-OF-SAMPLE metrics only, with a
 * small-sample warning; results are never presented as conclusive.
 *
 * Scoring:
 *   'binary' — Deriv-style: did close finish in the setup's direction
 *              after `horizonBars` (default 5)?
 *   'r'      — MT5-style: R-multiples with spread & slippage applied
 *              pessimistically (entry worse by slippage, exits worse by
 *              spread + slippage), SL-first within a bar, max hold 12.
 * ================================================================ */

import { validateCandles, evaluateSetups } from './setups.js';
import { DEFAULT_SETUP_CONFIG } from './setups.js';

const MAX_HOLD_R = 12;

export function setupMetrics(trades) {
  const closed = trades;
  const wins = closed.filter((t) => t.win || t.r > 0);
  const losses = closed.filter((t) => !(t.win || t.r > 0));
  const grossWin = wins.reduce((s, t) => s + (t.r != null ? t.r : 1), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.r != null ? t.r : -1), 0));
  let eq = 0, peak = -Infinity, maxDD = 0, streak = 0, worstStreak = 0;
  for (const t of closed) {
    const v = t.r != null ? t.r : (t.win ? 1 : -1);
    eq += v;
    if (eq > peak) peak = eq;
    maxDD = Math.max(maxDD, peak - eq);
    if (v <= 0) { streak++; worstStreak = Math.max(worstStreak, streak); } else streak = 0;
  }
  const netR = Math.round(closed.reduce((s, t) => s + (t.r != null ? t.r : (t.win ? 1 : -1)), 0) * 100) / 100;
  return {
    trades: closed.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : 0,
    expectancyR: closed.length ? Math.round((netR / closed.length) * 100) / 100 : 0,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? null : 0),
    maxDrawdownR: Math.round(maxDD * 100) / 100,
    longestLossStreak: worstStreak,
    netR
  };
}

/**
 * @param {object} o
 * @param {'binary'|'r'} [o.scoring]         default 'binary' (Deriv paths)
 * @param {number} [o.horizonBars]           binary horizon (default 5)
 * @param {number} [o.spreadPips]            r scoring, default 2 (pessimistic)
 * @param {number} [o.slippagePips]          r scoring, default 1 (pessimistic)
 * @param {number} [o.oosFraction]           out-of-sample share (default 0.3)
 * @param {number} [o.evaluateBars]          cap on walked bars (default 400, most recent)
 */
export function runSetupsBacktest({ symbol = 'SYM', category = 'forex', candles, granularity = 300, config = DEFAULT_SETUP_CONFIG, scoring = 'binary', horizonBars = config.horizonBars || 5, spreadPips = 2, slippagePips = 1, pipSize = 0.0001, oosFraction = 0.3, evaluateBars = 400 }) {
  const { clean, issues, ok } = validateCandles(candles, granularity);
  if (!ok || clean.length < 120) throw new Error('need at least 120 clean candles, got ' + clean.length);
  const spread = spreadPips * pipSize, slip = slippagePips * pipSize;
  const start = Math.max(0, clean.length - evaluateBars);
  const warm = 70;
  const raw = { EMA_TREND_PULLBACK: [], VWAP_MEAN_REVERSION: [], OPENING_RANGE_BREAKOUT: [], RSI_MEAN_REVERSION: [] };
  const cooldownUntil = { EMA_TREND_PULLBACK: 0, VWAP_MEAN_REVERSION: 0, OPENING_RANGE_BREAKOUT: 0, RSI_MEAN_REVERSION: 0 };
  const hold = scoring === 'r' ? MAX_HOLD_R : horizonBars;
  const lastEval = clean.length - hold - 1;

  for (let i = start + warm; i <= lastEval; i++) {
    const window = clean.slice(0, i + 1);
    const out = evaluateSetups({ symbol, category, candles: window, granularity, config });
    for (const r of out.results) {
      if (!r.direction || raw[r.setup] == null) continue;
      if (i < cooldownUntil[r.setup]) continue;
      cooldownUntil[r.setup] = i + hold + 1; /* one active evaluation per setup */
      const dir = r.direction === 'BUY' ? 1 : -1;
      if (scoring === 'binary') {
        const exitClose = clean[i + horizonBars].close;
        const win = dir > 0 ? exitClose > r.entry : exitClose < r.entry;
        raw[r.setup].push({ i, setup: r.setup, direction: r.direction, entry: r.entry, exit: exitClose, win });
      } else {
        const entryAdj = r.entry + dir * slip; /* pessimistic fill */
        const risk = Math.abs(r.entry - r.stop);
        if (!(risk > 0)) continue;
        let closedR = null;
        for (let j = i + 1; j <= Math.min(i + MAX_HOLD_R, clean.length - 1) && closedR == null; j++) {
          const b = clean[j];
          if (dir > 0 ? b.low <= r.stop : b.high >= r.stop) closedR = ((r.stop - dir * spread) - entryAdj) / risk * dir; /* SL first */
          else if (dir > 0 ? b.high >= r.tp1 : b.low <= r.tp1) closedR = ((r.tp1 - dir * (spread + slip)) - entryAdj) / risk * dir;
        }
        if (closedR == null) {
          const b = clean[Math.min(i + MAX_HOLD_R, clean.length - 1)];
          closedR = (b.close - entryAdj) / risk * dir;
        }
        raw[r.setup].push({ i, setup: r.setup, direction: r.direction, entry: r.entry, win: closedR > 0, r: Math.round(closedR * 100) / 100 });
      }
    }
  }

  const totalEvaluated = lastEval - start - warm + 1;
  const oosStartIdx = start + warm + Math.floor((lastEval - start - warm) * (1 - oosFraction));
  const perSetup = {};
  for (const [name, trades] of Object.entries(raw)) {
    const oos = trades.filter((t) => t.i >= oosStartIdx);
    perSetup[name] = {
      oos: setupMetrics(oos),
      warning: oos.length < 30 ? 'Only ' + oos.length + ' out-of-sample trades — below the 30-trade minimum. NOT conclusive.' : null
    };
  }
  return {
    symbol, scoring, granularity,
    barsEvaluated: totalEvaluated,
    outOfSampleShare: oosFraction,
    dataQuality: { accepted: clean.length, ...issues },
    perSetup,
    note: scoring === 'binary'
      ? 'Binary outcome at fixed horizon (' + horizonBars + ' bars) on out-of-sample bars only. Educational analysis — NOT conclusive evidence, no execution implied.'
      : 'R-multiples with pessimistic spread (' + spreadPips + ' pips) + slippage (' + slippagePips + ' pips), SL-first, max hold ' + MAX_HOLD_R + ' bars, out-of-sample only. Educational analysis — NOT conclusive evidence, no execution implied.'
  };
}
