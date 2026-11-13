#!/usr/bin/env node
/* ================================================================
 * Market state over a price history.
 *
 * This is where the figures of the README section "Market state" come from.
 * It runs the application's own code (src/marketstate.js) over historical
 * 1-minute prices and counts three things:
 *
 *   1. how often each state occurs on each timeframe, and for how many
 *      candles a trend state lasts;
 *   2. how far back the four swings lie that a structure is read from (the
 *      sketch on the page has to reach them);
 *   3. what became of the alerts of the 1m/5m/1h rule (scripts/replay-rule.mjs)
 *      in each state: the share that reached target 1 before the stop.
 *
 * The third count is the one that decides what the page may say. A state
 * that separated better alerts from worse ones would be a reason to use it as
 * a filter; one that does not is a description and has to be shown as that.
 *
 * A state is computed exactly as the page computes it: from the last 599
 * finished candles of a timeframe, as of the close of the newest of them. An
 * alert is matched with the state of each timeframe as of the 5-minute close
 * the alert belongs to, so nothing that happened later is used.
 *
 * It needs price data that is NOT in this repository: 1-minute bars as CSV,
 * the same files scripts/replay-rule.mjs reads.
 *
 *   node scripts/state-replay.mjs --data /path/to/XAUUSD/1m --symbol XAU/USD \
 *        [--from 2020-01-01] [--to 2027-01-01] [--spread 0.25] [--no-alerts]
 *
 * --spread     price units taken off every alert in the results per alert
 * --no-alerts  the states only, without the rule's alerts (much faster)
 *
 * What it cannot tell: fills, a broker's own prices and spreads (--spread is
 * one assumed figure for every alert), or anything about the future. The
 * candles are built from the 1-minute bars of the file as its clock stands;
 * an archive that stamps its bars with broker time gives 4-hour candles that
 * start at other hours than Deriv's. What that does to the shares was not
 * measured.
 * ================================================================ */

import { pathToFileURL } from 'node:url';
import { loadBars, replay } from './replay-rule.mjs';
import { STATE_TIMEFRAMES, STATE_CANDLES, timeframeState, trendStateOf } from '../src/marketstate.js';

/** Thresholds tried beside the ones the page uses: [name, { adxTrend, adxRange }]. */
export const VARIANTS = Object.freeze([
  ['ADX 25 / 20 (the page)', { adxTrend: 25, adxRange: 20 }],
  ['ADX 20 / 20', { adxTrend: 20, adxRange: 20 }],
  ['ADX 30 / 20', { adxTrend: 30, adxRange: 20 }]
]);

/** Candles of `seconds` from 1-minute bars, oldest first. A candle exists only where a bar does. */
export function candlesFrom(bars, seconds) {
  const out = [];
  for (const bar of bars) {
    const start = Math.floor(bar.time / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.time === start) {
      if (bar.high > last.high) last.high = bar.high;
      if (bar.low < last.low) last.low = bar.low;
      last.close = bar.close;
    } else out.push({ time: start, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  }
  return out;
}

/**
 * The state at the close of every candle that has STATE_CANDLES - 1 finished
 * candles up to and including itself, as the page would have shown it then.
 *
 * @returns {Array<{end:number, trend:string, variants:string[], structure:string, volatility:string, swingAge:number|null}>}
 */
export function statesOver(candles, timeframe) {
  const held = STATE_CANDLES - 1;
  const out = [];
  for (let i = held - 1; i < candles.length; i++) {
    const last = candles[i];
    /* The candle that would be forming at that moment: its content is never read. */
    const forming = { time: last.time + timeframe.seconds, open: last.close, high: last.close, low: last.close, close: last.close };
    const reading = timeframeState([...candles.slice(i - held + 1, i + 1), forming], timeframe);
    if (!reading.ok) continue;
    const figures = { close: reading.price, ema20: reading.trend.ema20, ema50: reading.trend.ema50, ema200: reading.trend.ema200, adx: reading.trend.adx };
    const { prevHigh, prevLow } = reading.structure;
    out.push({
      end: reading.asOf,
      trend: reading.trend.state,
      variants: VARIANTS.map(([, thresholds]) => trendStateOf(figures, thresholds)),
      structure: reading.structure.state,
      volatility: reading.volatility.state,
      swingAge: prevHigh && prevLow ? reading.candles - 1 - Math.min(prevHigh.index, prevLow.index) : null
    });
  }
  return out;
}

function percent(part, whole) { return whole ? Math.round((part / whole) * 1000) / 10 : null; }

function quantile(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null; }

/** Shares of the values of one field, in percent of all states. */
export function shares(states, pick) {
  const counts = {};
  for (const state of states) { const key = pick(state); counts[key] = (counts[key] || 0) + 1; }
  return Object.fromEntries(Object.entries(counts).sort().map(([key, count]) => [key, percent(count, states.length)]));
}

/** For how many candles in a row a value lasts: the middle run and the mean, per value. */
export function runLengths(states, pick) {
  const runs = {};
  let current = null, length = 0;
  const end = () => { if (current !== null) (runs[current] = runs[current] || []).push(length); };
  for (const state of states) {
    const key = pick(state);
    if (key === current) length++;
    else { end(); current = key; length = 1; }
  }
  end();
  return Object.fromEntries(Object.entries(runs).sort().map(([key, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return [key, { runs: list.length, medianCandles: quantile(sorted, 0.5), meanCandles: Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 }];
  }));
}

/** The newest state whose close is not later than `time`; null before the first. */
export function stateAt(states, time) {
  let low = 0, high = states.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (states[middle].end <= time) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found < 0 ? null : states[found];
}

/** Where an alert stands against a trend or structure state: 'with', 'against', or the state itself. */
export function relation(signal, state) {
  if (state === 'UP') return signal === 'BUY' ? 'with' : 'against';
  if (state === 'DOWN') return signal === 'SELL' ? 'with' : 'against';
  return state.toLowerCase();
}

/* One alert into one row: its outcome, and the distance it won or lost in price units. */
function tallyInto(table, key, outcome, reading) {
  const row = table[key] = table[key] || { alerts: 0, target: 0, stop: 0, won: 0, lost: 0 };
  row.alerts++;
  if (outcome === 'target') { row.target++; row.won += Math.abs(reading.tp1 - reading.entry); }
  else if (outcome === 'stop') { row.stop++; row.lost += Math.abs(reading.entry - reading.stop_loss); }
}

/**
 * A table of rows as shares and results per alert.
 *   targetFirstPercent   share of finished alerts that reached target 1 before the stop
 *   breakEvenPercent     the share at which wins and losses cancel, from the row's own average win and
 *                        loss, with `spread` taken off every alert. For one alert a win is 1.5 times the
 *                        loss, which gives 40% before the spread; for a row it is 40% only when its
 *                        winners and its losers are of the same size on average
 *   perAlert             average result in price units before the spread; perAlertAfterSpread after it
 */
function finish(table, spread = 0) {
  const round = (value) => Math.round(value * 1000) / 1000;
  return Object.fromEntries(Object.entries(table).sort().map(([key, row]) => {
    const done = row.target + row.stop;
    const win = row.target ? row.won / row.target : 0, loss = row.stop ? row.lost / row.stop : 0;
    return [key, {
      alerts: row.alerts, target: row.target, stop: row.stop,
      targetFirstPercent: percent(row.target, done),
      breakEvenPercent: win + loss ? Math.round(((loss + spread) / (win + loss)) * 1000) / 10 : null,
      perAlert: done ? round((row.won - row.lost) / done) : null,
      perAlertAfterSpread: done ? round((row.won - row.lost) / done - spread) : null
    }];
  }));
}

/**
 * @param {Array}  bars     1-minute bars, oldest first
 * @param {object} options  symbol: the application's name for the market; alerts: false leaves the rule's
 *                          alerts out; spread: price units taken off every alert in the results per alert;
 *                          timeframes: the ones to compute (all four unless a test asks for fewer);
 *                          onMatch({ time, close, signal, entry, stop, target, outcome, states }): called
 *                          for every alert that was matched, with the state of each timeframe it was matched with
 */
export function measure(bars, { symbol, from = -Infinity, to = Infinity, alerts = true, spread = 0, timeframes = STATE_TIMEFRAMES, onMatch = null } = {}) {
  const perTimeframe = {};
  const states = {};
  for (const timeframe of timeframes) {
    const candles = candlesFrom(bars, timeframe.seconds);
    const all = statesOver(candles, timeframe);
    states[timeframe.key] = all;
    const counted = all.filter((state) => state.end >= from && state.end < to);
    const ages = counted.map((state) => state.swingAge).filter((age) => age != null).sort((a, b) => a - b);
    perTimeframe[timeframe.label] = {
      candles: candles.length,
      states: counted.length,
      trend: shares(counted, (state) => state.trend),
      trendRuns: runLengths(counted, (state) => state.trend),
      variants: Object.fromEntries(VARIANTS.map(([name], index) => [name, { shares: shares(counted, (state) => state.variants[index]), runs: runLengths(counted, (state) => state.variants[index]) }])),
      structure: shares(counted, (state) => state.structure),
      volatility: shares(counted, (state) => state.volatility),
      swingAgeCandles: { median: quantile(ages, 0.5), p90: quantile(ages, 0.9), p95: quantile(ages, 0.95), p99: quantile(ages, 0.99) }
    };
  }
  const result = { symbol, timeframes: perTimeframe };
  if (!alerts) return result;

  const byTrend = {}, byStructure = {}, byVolatility = {}, combined = {}, byYear = {};
  for (const timeframe of timeframes) { byTrend[timeframe.label] = {}; byStructure[timeframe.label] = {}; byVolatility[timeframe.label] = {}; }
  let matched = 0, unmatched = 0;
  const rule = replay(bars, {
    symbol, from, to,
    onAlert: ({ time, reading, outcome }) => {
      /* The alert is made on the first bar after a 5-minute close: that close is what it knows. */
      const close = Math.floor(time / 300) * 300;
      const found = timeframes.map((timeframe) => stateAt(states[timeframe.key], close));
      if (found.some((state) => !state)) { unmatched++; return; }
      matched++;
      if (onMatch) onMatch({ time, close, signal: reading.signal, entry: reading.entry, stop: reading.stop_loss, target: reading.tp1, outcome, states: Object.fromEntries(timeframes.map((timeframe, index) => [timeframe.key, found[index]])) });
      const relations = [], byKey = {};
      timeframes.forEach((timeframe, index) => {
        const state = found[index];
        const trend = relation(reading.signal, state.trend);
        relations.push(trend);
        byKey[timeframe.key] = trend;
        tallyInto(byTrend[timeframe.label], trend, outcome, reading);
        tallyInto(byStructure[timeframe.label], relation(reading.signal, state.structure), outcome, reading);
        tallyInto(byVolatility[timeframe.label], state.volatility.toLowerCase(), outcome, reading);
      });
      const { h1, h4 } = byKey;
      const groups = ['all alerts'];
      if (h4 === 'with') groups.push('H4 with the alert');
      if (h4 === 'against') groups.push('H4 against the alert');
      if (relations.length === 4 && relations.every((value) => value === 'with')) groups.push('all four timeframes with the alert');
      if (h1 === 'with' && h4 === 'with') groups.push('H1 and H4 with the alert');
      if (h1 === 'against' && h4 === 'against') groups.push('H1 and H4 against the alert');
      if (h1 === 'against' || h4 === 'against') groups.push('H1 or H4 against the alert');
      if (!relations.includes('against')) groups.push('no timeframe against the alert');
      if (relations.length === 4 && relations.every((value) => value === 'range')) groups.push('all four timeframes in a range');
      const year = String(new Date(time * 1000).getUTCFullYear());
      for (const group of groups) {
        tallyInto(combined, group, outcome, reading);
        tallyInto(byYear[group] = byYear[group] || {}, year, outcome, reading);
      }
    }
  });
  result.rule = { alerts: rule.alerts, targetFirstPercent: rule.targetFirstPercent, breakEvenPercent: rule.breakEvenPercent, matched, unmatched, spread };
  result.alertsByTrend = Object.fromEntries(Object.entries(byTrend).map(([label, table]) => [label, finish(table, spread)]));
  result.alertsByStructure = Object.fromEntries(Object.entries(byStructure).map(([label, table]) => [label, finish(table, spread)]));
  result.alertsByVolatility = Object.fromEntries(Object.entries(byVolatility).map(([label, table]) => [label, finish(table, spread)]));
  result.alertsCombined = finish(combined, spread);
  result.alertsCombinedByYear = Object.fromEntries(Object.entries(byYear).map(([group, table]) => [group, finish(table, spread)]));
  return result;
}

/* ---------------------------------------------------------------- command line */

function argument(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback;
}

function main() {
  const data = argument('data', '');
  const symbol = argument('symbol', '');
  if (!data || !symbol) { console.error('usage: node scripts/state-replay.mjs --data <dir or file> --symbol XAU/USD [--from 2020-01-01] [--to 2027-01-01] [--spread 0.25] [--no-alerts]'); process.exit(2); }
  const spread = Number(argument('spread', '0')) || 0;
  const fromSec = Date.parse(argument('from', '2000-01-01') + 'T00:00:00Z') / 1000;
  const toSec = Date.parse(argument('to', '2100-01-01') + 'T00:00:00Z') / 1000;
  /* 599 four-hour candles are about 100 trading days: that much history before the first counted state. */
  const WARM = 160 * 86400;
  const bars = loadBars(data, fromSec - WARM, toSec + 21 * 86400);
  const result = measure(bars, { symbol, from: fromSec, to: toSec, spread, alerts: !process.argv.includes('--no-alerts') });
  console.log(JSON.stringify({ firstBar: bars.length ? new Date(bars[0].time * 1000).toISOString() : null, lastBar: bars.length ? new Date(bars[bars.length - 1].time * 1000).toISOString() : null, bars: bars.length, ...result }, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
