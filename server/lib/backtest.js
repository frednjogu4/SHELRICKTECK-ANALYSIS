/* ================================================================
 * AURUM — backtesting engine (walk-forward on REAL Deriv candles).
 *
 * Decoupled by design: this module only consumes NORMALIZED candles
 * (from lib/derivfeed or an injected stub) and the pure indicator
 * engine (analyzeTimeframe) — it contains no data fetching and no
 * broker calls. The same rules as the live deterministic decision:
 *   entry at close of a signal bar, risk = 1.5 x ATR,
 *   tp1 = 2.25 x ATR, tp2 = 4 x ATR, max hold 48 bars.
 * Exits are evaluated conservatively (stop-loss first within a bar).
 * ================================================================ */

import { analyzeTimeframe, MIN_CANDLES } from './analyzer.js';

const MAX_HOLD_BARS = 48;
const RISK_MULT = 1.5;
const TP1_MULT = 2.25;
const TP2_MULT = 4;

/**
 * @param {object} o
 * @param {Array}  o.candles   normalized [{time,open,high,low,close,volume}]
 * @param {string} o.symbol
 * @param {number} [o.maxHold]
 */
export function runBacktest({ candles, symbol = 'SYM', maxHold = MAX_HOLD_BARS }) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES + 10) {
    throw new Error(`need at least ${MIN_CANDLES + 10} candles, got ${candles?.length ?? 0}`);
  }
  const n = candles.length;
  const warmup = Math.min(MIN_CANDLES + 10, Math.floor(n / 3));
  const trades = [];
  let pos = null; // {side, entry, risk, sl, tp1, tp2, openedIdx}
  const equity = []; // R-multiple curve

  const closePos = (i, exitPrice, result) => {
    const dir = pos.side === 'BUY' ? 1 : -1;
    const r = ((exitPrice - pos.entry) / pos.risk) * dir;
    trades.push({
      side: pos.side, entry: pos.entry, exit: exitPrice,
      openedTime: candles[pos.openedIdx].time, closedTime: candles[i].time,
      bars: i - pos.openedIdx, result, r: Math.round(r * 100) / 100
    });
    pos = null;
  };

  for (let i = warmup; i < n; i++) {
    const bar = candles[i];

    /* 1 — manage open position against THIS bar (conservative: SL first) */
    if (pos) {
      if (pos.side === 'BUY') {
        if (bar.low <= pos.sl) closePos(i, pos.sl, 'sl');
        else if (bar.high >= pos.tp2) closePos(i, pos.tp2, 'tp2');
        else if (bar.high >= pos.tp1) closePos(i, pos.tp1, 'tp1');
      } else {
        if (bar.high >= pos.sl) closePos(i, pos.sl, 'sl');
        else if (bar.low <= pos.tp2) closePos(i, pos.tp2, 'tp2');
        else if (bar.low <= pos.tp1) closePos(i, pos.tp1, 'tp1');
      }
    }

    /* decision on the bar so far (window = history up to and incl. bar) */
    const window = candles.slice(0, i + 1);
    const a = analyzeTimeframe(symbol, window, 'bt');

    if (pos) {
      /* exit on opposite signal (treat WAIT as hold) */
      const flip = (pos.side === 'BUY' && a.signal === 'SELL') ||
                   (pos.side === 'SELL' && a.signal === 'BUY');
      if (flip) closePos(i, bar.close, 'flip');
      else if (i - pos.openedIdx >= maxHold) closePos(i, bar.close, 'timeout');
    } else if (a.signal === 'BUY' || a.signal === 'SELL') {
      const atr = a.indicators?.atr;
      if (atr && atr > 0) {
        const dir = a.signal === 'BUY' ? 1 : -1;
        pos = {
          side: a.signal, entry: bar.close, risk: RISK_MULT * atr,
          sl: bar.close - dir * RISK_MULT * atr,
          tp1: bar.close + dir * TP1_MULT * atr,
          tp2: bar.close + dir * TP2_MULT * atr,
          openedIdx: i
        };
      }
    }

    /* R-equity curve (mark open position at close, conservatively uncapped) */
    if (pos) {
      const dir = pos.side === 'BUY' ? 1 : -1;
      equity.push(Math.round(((bar.close - pos.entry) / pos.risk) * dir * 100) / 100);
    } else {
      equity.push(trades.length ? Math.round(trades.reduce((s, t) => s + t.r, 0) * 100) / 100 : 0);
    }
  }

  /* close any still-open position at the final close (reported as 'open') */
  if (pos) {
    const last = candles[n - 1];
    const dir = pos.side === 'BUY' ? 1 : -1;
    trades.push({
      side: pos.side, entry: pos.entry, exit: last.close,
      openedTime: candles[pos.openedIdx].time, closedTime: last.time,
      bars: n - 1 - pos.openedIdx, result: 'open',
      r: Math.round(((last.close - pos.entry) / pos.risk) * dir * 100) / 100
    });
    pos = null;
  }

  const closed = trades.filter((t) => t.result !== 'open');
  const wins = closed.filter((t) => t.r > 0);
  const losses = closed.filter((t) => t.r <= 0);
  const grossWin = wins.reduce((s, t) => s + t.r, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.r, 0));
  const netR = Math.round(trades.reduce((s, t) => s + t.r, 0) * 100) / 100;

  let peak = -Infinity, maxDD = 0;
  let eq = 0;
  for (const t of trades) { eq += t.r; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, peak - eq); }

  const byResult = {};
  for (const t of trades) byResult[t.result] = (byResult[t.result] || 0) + 1;

  return {
    symbol, bars: n, warmup,
    stats: {
      trades: trades.length,
      closed: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : 0,
      netR,
      avgR: closed.length ? Math.round((netR / closed.length) * 100) / 100 : 0,
      profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? null : 0),
      maxDrawdownR: Math.round(maxDD * 100) / 100,
      byResult
    },
    trades: trades.slice(-50),
    note: 'Walk-forward on real Deriv candles · EMA/SMA/RSI/MACD/BB/ATR/Fib engine · risk 1.5×ATR, TP1 2.25×ATR, TP2 4×ATR, max hold ' + maxHold + ' bars.'
  };
}
