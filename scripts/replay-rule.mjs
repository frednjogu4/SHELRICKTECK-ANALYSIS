#!/usr/bin/env node
/* ================================================================
 * Replay of the 1m/5m/1h signal rule on historical 1-minute prices.
 *
 * This is where the figures in src/measured.js and in the README come from.
 * It runs the application's own code (server/lib/analyzer.js,
 * server/lib/localdecision.js, src/closedcandles.js) over a price history,
 * minute by minute, and counts what a person following the alerts would have
 * met:
 *
 *   - a reading is made as the application makes it (see --timing);
 *   - an ALERT is a reading that says BUY or SELL when the reading before it
 *     said something else, which is when the application notifies;
 *   - each alert is followed on the 1-minute bars that come after it until
 *     the price reaches its stop or its target 1. When both lie inside the
 *     same bar the stop is counted.
 *
 * Beside every alert two controls are followed in the same way, with the same
 * two distances: the opposite direction, and a direction drawn by a seeded
 * coin. They show what the method itself gives when the direction carries no
 * information, which is what the rule has to beat.
 *
 * It needs price data that is NOT in this repository: 1-minute bars as CSV
 * with a header naming a time column (timestamp in ms, or time/datetime) and
 * open, high, low, close. Any directory of such files will do; they are read
 * in file-name order.
 *
 *   node scripts/replay-rule.mjs --data /path/to/XAUUSD/1m --symbol XAU/USD \
 *        --from 2020-01-01 --to 2026-12-31 [--timing close|minute] [--spread 0.25] [--by-year]
 *
 * --timing close   (default) the rule as shipped: finished candles, as of the
 *                  last 5-minute close; a new reading once per 5-minute candle.
 * --timing minute  the rule as it ran until November 2026: a look at the end
 *                  of every minute, forming candles included.
 *
 * What it cannot tell: fills, slippage, a broker's own prices, or anything
 * about the future. A replay says how a rule would have done on one price
 * series; it is not a forecast.
 * ================================================================ */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDeterministicAnalysis } from '../server/lib/analyzer.js';
import { localDecision } from '../server/lib/localdecision.js';
import { closedCandleSets, READING_PERIOD_SEC } from '../src/closedcandles.js';

/** Candles the application asks a feed for, per timeframe. */
const HELD = 120;
const SCORE_BUCKETS = [[0, 59, 'below 60'], [60, 64, '60-64'], [65, 69, '65-69'], [70, 74, '70-74'], [75, 79, '75-79'], [80, 100, '80 and above']];

/* One more 1-minute bar into a series of longer candles (the newest candle is updated in place). */
function addToCandles(list, bar, periodSec) {
  const start = Math.floor(bar.time / periodSec) * periodSec;
  const last = list[list.length - 1];
  if (last && last.time === start) {
    if (bar.high > last.high) last.high = bar.high;
    if (bar.low < last.low) last.low = bar.low;
    last.close = bar.close;
  } else {
    list.push({ time: start, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  }
}

/**
 * What became of a BUY or SELL: 'target', 'stop', or 'open' when the data
 * ends first. `from` is the index of the first bar the position is exposed to.
 */
export function follow(bars, from, reading) {
  const buy = reading.signal === 'BUY';
  const stop = Number(reading.stop_loss), target = Number(reading.tp1);
  for (let j = from; j < bars.length; j++) {
    const bar = bars[j];
    if (buy ? bar.low <= stop : bar.high >= stop) return { outcome: 'stop', at: bar.time, bars: j - from + 1 };
    if (buy ? bar.high >= target : bar.low <= target) return { outcome: 'target', at: bar.time, bars: j - from + 1 };
  }
  return { outcome: 'open', at: 0, bars: bars.length - from };
}

/**
 * @param {Array<{time:number, open:number, high:number, low:number, close:number}>} bars
 *        1-minute bars, oldest first, `time` = start of the minute in epoch seconds
 * @param {object}  options
 * @param {string}  options.symbol        the application's name for the market ('XAU/USD')
 * @param {string}  [options.timing]      'close' (default) or 'minute', see the top of this file
 * @param {number}  [options.from]        count alerts from this time on (epoch seconds); earlier bars only warm the rule up
 * @param {number}  [options.to]          count alerts before this time
 * @param {number}  [options.spread]      price units taken off every finished alert
 * @param {Function} [options.onAlert]    called with ({ time, reading, outcome }) for every counted alert
 */
export function replay(bars, { symbol, timing = 'close', from = -Infinity, to = Infinity, spread = 0, onAlert = null } = {}) {
  if (timing !== 'close' && timing !== 'minute') throw new Error('timing must be "close" or "minute"');
  const m5 = [], h1 = [];
  const stats = {
    symbol, timing, readings: 0, shown: { BUY: 0, SELL: 0, WAIT: 0 },
    alerts: 0, target: 0, stop: 0, open: 0,
    bySide: { BUY: { alerts: 0, target: 0, stop: 0 }, SELL: { alerts: 0, target: 0, stop: 0 } },
    byScore: SCORE_BUCKETS.map(([, , label]) => ({ label, alerts: 0, target: 0, stop: 0 })),
    /* How many of the three timeframes voted for the alert's direction, and what the 1-hour one said. */
    byVotes: { '2 of 3': { alerts: 0, target: 0, stop: 0 }, '3 of 3': { alerts: 0, target: 0, stop: 0 } },
    byHour: { agrees: { alerts: 0, target: 0, stop: 0 }, neutral: { alerts: 0, target: 0, stop: 0 }, against: { alerts: 0, target: 0, stop: 0 } },
    controls: { opposite: { target: 0, stop: 0 }, coin: { target: 0, stop: 0 } },
    won: 0, lost: 0, stopDistance: 0, barsHeld: 0, weekdays: 0
  };
  const days = new Set();
  let previous = '';
  /* A fixed sequence of coin tosses, so that a run can be repeated. */
  let seed = 20261113;
  const coin = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 < 0.5; };
  const tally = (group, outcome) => { group.alerts++; if (outcome !== 'open') group[outcome]++; };
  /* The same two distances on the other side of the entry. */
  const mirrored = (reading) => ({ signal: reading.signal === 'BUY' ? 'SELL' : 'BUY', stop_loss: 2 * reading.entry - reading.stop_loss, tp1: 2 * reading.entry - reading.tp1 });

  /* One reading and, when it is a new BUY or SELL, its alert. `exposedFrom` is the first bar that can hit a level. */
  function read(sets, at, exposedFrom) {
    const det = runDeterministicAnalysis(symbol, sets);
    const reading = localDecision(det);
    const signal = reading.signal;
    const counted = at >= from && at < to;
    if (counted) { stats.readings++; stats.shown[signal] = (stats.shown[signal] || 0) + 1; }
    if (counted && signal !== previous && (signal === 'BUY' || signal === 'SELL')) {
      const result = follow(bars, exposedFrom, reading);
      const score = Number(reading.confidence) || 0;
      const bucket = stats.byScore[SCORE_BUCKETS.findIndex(([low, high]) => score >= low && score <= high)];
      const votes = ['m1', 'm5', 'h1'].map((key) => det.analyses[key] && det.analyses[key].signal);
      tally(stats.byVotes[votes.filter((vote) => vote === signal).length === 3 ? '3 of 3' : '2 of 3'], result.outcome);
      tally(stats.byHour[votes[2] === signal ? 'agrees' : votes[2] === 'BUY' || votes[2] === 'SELL' ? 'against' : 'neutral'], result.outcome);
      const other = mirrored(reading);
      for (const [name, control] of [['opposite', other], ['coin', coin() ? reading : other]]) {
        const outcome = follow(bars, exposedFrom, control).outcome;
        if (outcome !== 'open') stats.controls[name][outcome]++;
      }
      stats.alerts++; stats.bySide[signal].alerts++; if (bucket) bucket.alerts++;
      if (result.outcome === 'open') stats.open++;
      else {
        stats[result.outcome]++; stats.bySide[signal][result.outcome]++; if (bucket) bucket[result.outcome]++;
        if (result.outcome === 'target') stats.won += Math.abs(reading.tp1 - reading.entry);
        else stats.lost += Math.abs(reading.entry - reading.stop_loss);
        stats.stopDistance += Math.abs(reading.entry - reading.stop_loss);
        stats.barsHeld += result.bars;
      }
      if (onAlert) onAlert({ time: at, reading, ...result });
    }
    previous = signal;
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.time >= from && bar.time < to) { const day = new Date(bar.time * 1000); if (day.getUTCDay() >= 1 && day.getUTCDay() <= 5) days.add(Math.floor(bar.time / 86400)); }

    if (timing === 'close') {
      /* The first bar after a 5-minute close is the moment the application can make the reading of that
         close. It holds the candles finished so far and this bar, of which only the start time is known. */
      const newClose = i > 0 && Math.floor(bar.time / READING_PERIOD_SEC) !== Math.floor(bars[i - 1].time / READING_PERIOD_SEC);
      if (newClose && i >= HELD) {
        /* The first tick of this bar: a 1-minute candle of which only the start and the first price are known,
           and with it a new 5-minute candle and, on the hour, a new 1-hour candle. */
        const firstTick = (start) => ({ time: start, open: bar.open, high: bar.open, low: bar.open, close: bar.open });
        const withTick = (list, period) => {
          const start = Math.floor(bar.time / period) * period, tail = list.slice(-HELD);
          return tail.length && tail[tail.length - 1].time === start ? tail : [...tail.slice(-(HELD - 1)), firstTick(start)];
        };
        const held = { m1: [...bars.slice(i - (HELD - 1), i), firstTick(bar.time)], m5: withTick(m5, 300), h1: withTick(h1, 3600) };
        const { close, current, sets } = closedCandleSets(held);
        if (close > Math.floor(bar.time / READING_PERIOD_SEC) * READING_PERIOD_SEC) throw new Error('replay: a reading cannot belong to a close that has not passed');
        /* Nothing that starts at or after the close may be part of the reading. */
        for (const [key, period] of [['m1', 60], ['m5', 300], ['h1', 3600]]) {
          for (const candle of sets[key]) if (candle.time + period > close) throw new Error('replay: a candle that had not finished went into a reading');
        }
        /* After a pause the application shows no reading until a 5-minute candle of the new session has finished:
           the look is skipped, and the last reading shown stays the one to compare the next with. */
        if (current) read(sets, bar.time, i);
      }
      addToCandles(m5, bar, 300); addToCandles(h1, bar, 3600);
    } else {
      addToCandles(m5, bar, 300); addToCandles(h1, bar, 3600);
      /* The look at the end of this minute: every candle as it stands now, the forming ones included. */
      if (i >= HELD - 1) read({ m1: bars.slice(i - (HELD - 1), i + 1), m5: m5.slice(-HELD), h1: h1.slice(-HELD) }, bar.time + 60, i + 1);
    }
  }
  stats.weekdays = days.size;
  return summarize(stats, spread);
}

function summarize(stats, spread) {
  const done = stats.target + stats.stop;
  const rate = (target, stop) => (target + stop ? Math.round((target / (target + stop)) * 1000) / 10 : null);
  const averageWin = stats.target ? stats.won / stats.target : 0, averageLoss = stats.stop ? stats.lost / stats.stop : 0;
  return {
    symbol: stats.symbol, timing: stats.timing, weekdays: stats.weekdays,
    readings: stats.readings, shown: stats.shown,
    alerts: stats.alerts, alertsPerWeekday: stats.weekdays ? Math.round((stats.alerts / stats.weekdays) * 10) / 10 : null,
    target: stats.target, stop: stats.stop, stillOpen: stats.open,
    targetFirstPercent: rate(stats.target, stats.stop),
    /* The share of targets at which wins and losses cancel, from the average win and the average loss. */
    breakEvenPercent: averageWin + averageLoss ? Math.round((averageLoss / (averageWin + averageLoss)) * 1000) / 10 : null,
    averageStop: done ? stats.stopDistance / done : null,
    averageMinutesHeld: done ? Math.round(stats.barsHeld / done) : null,
    perAlert: done ? (stats.won - stats.lost) / done : null,
    perAlertAfterSpread: done ? (stats.won - stats.lost) / done - spread : null,
    bySide: Object.fromEntries(Object.entries(stats.bySide).map(([side, s]) => [side, { alerts: s.alerts, target: s.target, stop: s.stop, targetFirstPercent: rate(s.target, s.stop) }])),
    byScore: stats.byScore.map((s) => ({ label: s.label, alerts: s.alerts, target: s.target, stop: s.stop, targetFirstPercent: rate(s.target, s.stop) })),
    byVotes: Object.fromEntries(Object.entries(stats.byVotes).map(([name, s]) => [name, { alerts: s.alerts, target: s.target, stop: s.stop, targetFirstPercent: rate(s.target, s.stop) }])),
    byHour: Object.fromEntries(Object.entries(stats.byHour).map(([name, s]) => [name, { alerts: s.alerts, target: s.target, stop: s.stop, targetFirstPercent: rate(s.target, s.stop) }])),
    controls: Object.fromEntries(Object.entries(stats.controls).map(([name, s]) => [name, { target: s.target, stop: s.stop, targetFirstPercent: rate(s.target, s.stop) }]))
  };
}

/* ---------------------------------------------------------------- reading the price files */

function csvFiles(path) {
  const info = statSync(path);
  if (info.isFile()) return [path];
  return readdirSync(path).sort().flatMap((name) => {
    const full = join(path, name);
    const child = statSync(full);
    if (child.isDirectory()) return csvFiles(full);
    return name.toLowerCase().endsWith('.csv') ? [full] : [];
  });
}

/** 1-minute bars from one CSV text. Lines that do not parse are skipped. */
export function parseBars(text) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].toLowerCase().split(',').map((name) => name.trim());
  const column = (...names) => header.findIndex((name) => names.includes(name));
  const at = column('timestamp', 'time', 'datetime', 'datetime_utc', 'date');
  const open = column('open'), high = column('high'), low = column('low'), close = column('close');
  if ([at, open, high, low, close].some((index) => index < 0)) throw new Error('CSV header needs a time column and open, high, low, close');
  const bars = [];
  for (let n = 1; n < lines.length; n++) {
    if (!lines[n]) continue;
    const cells = lines[n].split(',');
    const raw = cells[at];
    let time = Number(raw);
    if (Number.isFinite(time)) time = time > 1e12 ? Math.floor(time / 1000) : time;
    else time = Math.floor(Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z') / 1000);
    const bar = { time, open: Number(cells[open]), high: Number(cells[high]), low: Number(cells[low]), close: Number(cells[close]) };
    if (bar.time > 0 && bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0) bars.push(bar);
  }
  return bars;
}

/** Bars between two times from every CSV under `path`, oldest first, one per minute. */
export function loadBars(path, fromSec, toSec) {
  const bars = [];
  for (const file of csvFiles(path)) {
    /* Daily files carry their date in the name: skip the ones that cannot matter without opening them. */
    const dated = /(\d{4})-(\d{2})-(\d{2})/.exec(file);
    if (dated) {
      const day = Date.UTC(Number(dated[1]), Number(dated[2]) - 1, Number(dated[3])) / 1000;
      if (day + 86400 <= fromSec || day >= toSec) continue;
    }
    for (const bar of parseBars(readFileSync(file, 'utf8'))) if (bar.time >= fromSec && bar.time < toSec) bars.push(bar);
  }
  bars.sort((a, b) => a.time - b.time);
  return bars.filter((bar, index) => index === 0 || bar.time !== bars[index - 1].time);
}

/* ---------------------------------------------------------------- command line */

function argument(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback;
}

function main() {
  const data = argument('data', '');
  const symbol = argument('symbol', '');
  if (!data || !symbol) { console.error('usage: node scripts/replay-rule.mjs --data <dir or file> --symbol XAU/USD [--from 2020-01-01] [--to 2026-12-31] [--timing close|minute] [--spread 0.25] [--by-year]'); process.exit(2); }
  const timing = argument('timing', 'close');
  const spread = Number(argument('spread', '0')) || 0;
  const fromSec = Date.parse(argument('from', '2000-01-01') + 'T00:00:00Z') / 1000;
  const toSec = Date.parse(argument('to', '2100-01-01') + 'T00:00:00Z') / 1000;
  const WARM = 21 * 86400; /* enough history before the first counted alert for 120 hourly candles, and bars after the last one to finish it */
  const spans = [];
  if (process.argv.includes('--by-year')) {
    for (let year = new Date(fromSec * 1000).getUTCFullYear(); year <= new Date((toSec - 1) * 1000).getUTCFullYear(); year++) {
      spans.push([Math.max(fromSec, Date.UTC(year, 0, 1) / 1000), Math.min(toSec, Date.UTC(year + 1, 0, 1) / 1000), String(year)]);
    }
  } else spans.push([fromSec, toSec, 'all']);
  const out = [];
  for (const [start, end, label] of spans) {
    const bars = loadBars(data, start - WARM, end + WARM);
    const result = replay(bars, { symbol, timing, from: start, to: end, spread });
    out.push({ span: label, firstBar: bars.length ? new Date(bars[0].time * 1000).toISOString() : null, lastBar: bars.length ? new Date(bars[bars.length - 1].time * 1000).toISOString() : null, ...result });
  }
  console.log(JSON.stringify(out, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
