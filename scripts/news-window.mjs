#!/usr/bin/env node
/*
 * What a market does around scheduled high-impact releases.
 *
 * A measurement on past 1-minute prices and a past economic calendar. It is
 * the reason for the "no new trade from 30 minutes before a high-impact
 * release until 30 minutes after" period in src/newsimpact.js. It says how far
 * and how fast price moved at a release, never which way: the direction of a
 * release is not known beforehand, and nothing here predicts it.
 *
 *   node scripts/news-window.mjs --bars <folder of 1-minute CSV files> \
 *        --events <calendar CSV> --from 2020-01-06 --to 2023-04-01 \
 *        [--bars-clock eet] [--currency USD] [--symbol XAU/USD]
 *
 * --events      a CSV with the columns Currency, Impact (3 = high), title and
 *               timeofevent ("YY/M/D H:MM" on the New York clock), as in the
 *               public copy of the ForexFactory calendar on GitHub
 *               (EPSOFT/dataset-forexfactory, January 2007 to March 2023).
 * --bars-clock  "utc" (default) or "eet": some price archives stamp their
 *               bars with broker time (Athens: UTC+2, UTC+3 in summer) and
 *               call it UTC. The gold archive used for the replay does so
 *               until mid-2025. The check printed first shows whether the
 *               clocks agree: at a release the largest move of the hours
 *               around it should fall on the listed minute.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { atr } from '../server/lib/indicators.js';
import { loadBars, replay } from './replay-rule.mjs';

/* ---- clocks ---- */

/** 01:00 UTC on the last Sunday of a month (0 = January): when Europe changes its clocks. */
function lastSunday(year, month) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1) / 1000;
}

/** A bar time written on the Athens clock but stored as if it were UTC -> the real UTC second. */
export function eetToUtc(seconds) {
  const winter = seconds - 7200;
  const year = new Date(winter * 1000).getUTCFullYear();
  return winter >= lastSunday(year, 2) && winter < lastSunday(year, 9) ? seconds - 10800 : winter;
}

const NEW_YORK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
function newYorkOffsetMs(utcMs) {
  const parts = Object.fromEntries(NEW_YORK.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - Math.floor(utcMs / 60000) * 60000;
}

/** A New York wall-clock time -> epoch seconds (UTC). */
export function newYorkToUtc(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  return (wall - newYorkOffsetMs(wall + 5 * 3600000)) / 1000;
}

/* ---- the calendar ---- */

function splitCsvLine(line) {
  const out = []; let field = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) { if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

/** Calendar CSV -> [{ t, currency, impact, title, allDay }], t in epoch seconds. Rows without a readable time are left out. */
export function parseEvents(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((name) => name.trim().toLowerCase());
  const column = (name) => header.indexOf(name);
  const at = { currency: column('currency'), impact: column('impact'), title: column('title'), time: column('timeofevent') };
  if (Object.values(at).some((index) => index < 0)) throw new Error('calendar CSV needs the columns Currency, Impact, title and timeofevent');
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const match = String(cells[at.time] || '').trim().match(/^(\d{2})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})$/);
    if (!match) continue;
    const [, yy, month, day, hour, minute] = match.map(Number);
    out.push({
      t: newYorkToUtc(2000 + yy, month, day, hour, minute), currency: String(cells[at.currency] || '').trim().toUpperCase(),
      impact: Number(cells[at.impact]) || 0, title: String(cells[at.title] || '').trim(), allDay: hour === 0 && minute === 0
    });
  }
  return out;
}

/** A speech, a hearing, a meeting or minutes: an entry without one instant at which a number is published. */
export function isTalk(title) { return /Speaks|Testifies|Press Conference|Meetings|Symposium|Summit|Vote|Election|Hearing|Minutes/i.test(String(title || '')); }

/** The distinct moments of the releases asked for, ascending. `talk`: false = data and decisions, true = speeches, null = both. */
export function releaseTimes(events, { currency = 'USD', impact = 3, talk = false, from = -Infinity, to = Infinity } = {}) {
  const wanted = events.filter((event) => !event.allDay && event.impact === impact && event.t >= from && event.t < to
    && (currency === '*' ? event.currency !== 'ALL' : event.currency === currency) && (talk === null || isTalk(event.title) === talk));
  return [...new Set(wanted.map((event) => event.t))].sort((a, b) => a - b);
}

/**
 * The comparison: the same weekday and clock time one week before each
 * release, leaving out the moments that are within an hour of any release in
 * `busy`. What the market does at that hour of the day without a release.
 */
export function controlTimes(times, busy) {
  const sorted = [...busy].sort((a, b) => a - b);
  const near = (t) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < t - 3600) lo = mid + 1; else hi = mid; } return lo < sorted.length && sorted[lo] <= t + 3600; };
  return [...new Set(times.map((t) => t - 7 * 86400).filter((t) => !near(t)))].sort((a, b) => a - b);
}

/* ---- the measurement ---- */

export function quantile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;
}
const percent = (count, of) => of ? Math.round(100 * count / of) : NaN;

/** 1.5 x ATR14 of the 5-minute candles finished before `t`: the stop distance the rule would set there. NaN without 15 whole candles. */
function stopDistance(bars, index, t) {
  const boundary = Math.floor(t / 300) * 300;
  const candles = [];
  for (let k = 15; k >= 1; k--) {
    let high = -Infinity, low = Infinity, close = null;
    for (let m = 0; m < 5; m++) { const i = index.get(boundary - k * 300 + m * 60); if (i == null) continue; high = Math.max(high, bars[i].high); low = Math.min(low, bars[i].low); close = bars[i].close; }
    if (close == null) return NaN;
    candles.push({ high, low, close });
  }
  const unit = atr(candles, 14);
  return unit > 0 ? 1.5 * unit : NaN;
}

/**
 * Price around each release time.
 *
 *   releases, withPrices     how many times were asked for, and how many had prices
 *   onTheMinute              in how many the largest 1-minute range of the two hours either side fell on the listed minute (the clock check)
 *   range(from, to)          the 1-minute range as a multiple of the usual one, median over the releases, averaged over the minutes from..to
 *   releaseOverStop          the range of the release minute against the rule's stop distance: { median, p75, p90 }
 *   stopWithin[1|5|15|30]    % of releases in which price went a full stop distance from the release price, either way, within so many minutes
 *   bothWaysWithin[5|15|30]  % in which it did so in both directions
 *
 * "The usual" is the median 1-minute range of the hour that ends half an hour before the release.
 */
export function profile(bars, times) {
  const index = new Map(bars.map((bar, i) => [bar.time, i]));
  const ratios = new Map(); for (let k = -30; k <= 59; k++) ratios.set(k, []);
  const stopWithin = { 1: 0, 5: 0, 15: 0, 30: 0 }, bothWaysWithin = { 5: 0, 15: 0, 30: 0 };
  const overStop = [];
  let withPrices = 0, withStop = 0, onTheMinute = 0;
  for (const t of times) {
    const at = index.get(t);
    if (at == null) continue;
    const usualRanges = [];
    for (let k = -90; k <= -31; k++) { const i = index.get(t + k * 60); if (i != null) usualRanges.push(bars[i].high - bars[i].low); }
    const usual = usualRanges.length >= 50 ? quantile(usualRanges, 0.5) : NaN;
    if (!(usual > 0)) continue;
    withPrices++;
    for (let k = -30; k <= 59; k++) { const i = index.get(t + k * 60); if (i != null) ratios.get(k).push((bars[i].high - bars[i].low) / usual); }
    let largest = null;
    for (let k = -120; k <= 120; k++) { const i = index.get(t + k * 60); if (i == null) continue; const range = bars[i].high - bars[i].low; if (!largest || range > largest.range) largest = { k, range }; }
    if (largest && largest.k === 0) onTheMinute++;
    const stop = stopDistance(bars, index, t);
    if (!(stop > 0)) continue;
    withStop++;
    overStop.push((bars[at].high - bars[at].low) / stop);
    const start = bars[at].open; let up = 0, down = 0;
    for (let k = 0; k < 30; k++) {
      const i = index.get(t + k * 60);
      if (i != null) { up = Math.max(up, bars[i].high - start); down = Math.max(down, start - bars[i].low); }
      const minutes = k + 1;
      if (stopWithin[minutes] != null && Math.max(up, down) >= stop) stopWithin[minutes]++;
      if (bothWaysWithin[minutes] != null && up >= stop && down >= stop) bothWaysWithin[minutes]++;
    }
  }
  const range = (from, to) => { let sum = 0, n = 0; for (let k = from; k <= to; k++) { const m = quantile(ratios.get(k) || [], 0.5); if (Number.isFinite(m)) { sum += m; n++; } } return n ? sum / n : NaN; };
  for (const key of Object.keys(stopWithin)) stopWithin[key] = percent(stopWithin[key], withStop);
  for (const key of Object.keys(bothWaysWithin)) bothWaysWithin[key] = percent(bothWaysWithin[key], withStop);
  return {
    releases: times.length, withPrices, withStop, onTheMinute, range, stopWithin, bothWaysWithin,
    releaseOverStop: { median: quantile(overStop, 0.5), p75: quantile(overStop, 0.75), p90: quantile(overStop, 0.9) }
  };
}

/**
 * The rule's own alerts by their distance to a release: how many, and how
 * many reached target 1 before the stop. Each group is a few hundred alerts
 * at most, so each figure comes with the width of its 95% interval.
 */
export function alertsByDistance(bars, times, { symbol, from, to }) {
  const groups = new Map();
  const add = (name, alert) => { const g = groups.get(name) || { alerts: 0, target: 0, stop: 0 }; g.alerts++; if (alert.outcome === 'target') g.target++; if (alert.outcome === 'stop') g.stop++; groups.set(name, g); };
  const held = [];
  const around = (t) => { let lo = 0, hi = times.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; } return { next: lo < times.length ? (times[lo] - t) / 60 : Infinity, previous: lo > 0 ? (t - times[lo - 1]) / 60 : Infinity }; };
  replay(bars, { symbol, timing: 'close', from, to, onAlert: (alert) => {
    const { next, previous } = around(alert.time);
    if (alert.outcome !== 'open') held.push(alert.bars);
    add('all alerts', alert);
    if (next <= 30) add('a release within the next 30 minutes', alert);
    else if (next <= 60) add('a release in 30 to 60 minutes', alert);
    if (previous > 0 && previous < 30) add('up to 30 minutes after a release', alert);
    else if (previous >= 30 && previous < 60) add('30 to 60 minutes after a release', alert);
    if (next > 60 && previous >= 60) add('no release within an hour either side', alert);
  } });
  const rows = [...groups].map(([name, g]) => {
    const decided = g.target + g.stop; const share = decided ? g.target / decided : NaN;
    return { name, alerts: g.alerts, targetFirstPercent: Math.round(1000 * share) / 10, plusMinus: Math.round(1960 * Math.sqrt(share * (1 - share) / decided)) / 10 };
  });
  return { rows, medianMinutesOpen: quantile(held, 0.5), openWithin: { 30: percent(held.filter((m) => m <= 30).length, held.length), 60: percent(held.filter((m) => m <= 60).length, held.length) } };
}

/* ---- command line ---- */

function argument(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at > -1 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

function main() {
  const barsPath = argument('bars'), eventsPath = argument('events');
  if (!barsPath || !eventsPath) { console.error('usage: node scripts/news-window.mjs --bars <folder> --events <calendar.csv> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--bars-clock eet|utc] [--currency USD] [--symbol XAU/USD]'); process.exit(2); }
  const from = Date.parse(argument('from', '2020-01-06') + 'T00:00:00Z') / 1000, to = Date.parse(argument('to', '2023-04-01') + 'T00:00:00Z') / 1000;
  const clock = argument('bars-clock', 'utc'), currency = argument('currency', 'USD'), symbol = argument('symbol', 'XAU/USD');
  let bars = loadBars(barsPath, from - 40 * 86400, to + 5 * 86400);
  if (clock === 'eet') bars = bars.map((bar) => ({ ...bar, time: eetToUtc(bar.time) }));
  const events = parseEvents(readFileSync(eventsPath, 'utf8'));
  const day = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
  console.log(symbol + ', ' + bars.length + ' one-minute bars (clock: ' + clock + '), calendar entries: ' + events.length + ', period ' + day(from) + ' to ' + day(to));
  const sets = [
    ['high-impact ' + currency + ' data releases and decisions', releaseTimes(events, { currency, impact: 3, talk: false, from, to })],
    ['high-impact ' + currency + ' speeches, hearings and minutes', releaseTimes(events, { currency, impact: 3, talk: true, from, to })],
    ['medium-impact ' + currency + ' data releases', releaseTimes(events, { currency, impact: 2, talk: false, from, to })]
  ];
  const fixed = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
  const everyHigh = releaseTimes(events, { currency, impact: 3, talk: null });
  sets.push(['comparison: the same weekday and time a week before each high-impact data release, no release within an hour', controlTimes(sets[0][1], everyHigh)]);
  for (const [name, times] of sets) {
    const p = profile(bars, times);
    console.log('\n' + name + ': ' + p.releases + ' times, ' + p.withPrices + ' with prices; the largest move of the surrounding four hours fell on the listed minute in ' + p.onTheMinute);
    console.log('  1-minute range against the usual: 30-16 min before ' + fixed(p.range(-30, -16), 2) + ' | 15-1 before ' + fixed(p.range(-15, -1), 2) + ' | release minute ' + fixed(p.range(0, 0), 1)
      + ' | minute 1 ' + fixed(p.range(1, 1), 1) + ' | 2-4 ' + fixed(p.range(2, 4), 1) + ' | 5-14 ' + fixed(p.range(5, 14), 1) + ' | 15-29 ' + fixed(p.range(15, 29), 1) + ' | 30-59 ' + fixed(p.range(30, 59), 1));
    console.log('  release minute range / stop distance of the rule: median ' + fixed(p.releaseOverStop.median, 2) + ', upper quarter from ' + fixed(p.releaseOverStop.p75, 2) + ', top tenth from ' + fixed(p.releaseOverStop.p90, 2));
    console.log('  price a full stop distance away from the release price: within 1 min ' + p.stopWithin[1] + '% | 5 min ' + p.stopWithin[5] + '% | 15 min ' + p.stopWithin[15] + '% | 30 min ' + p.stopWithin[30] + '%'
      + '   in both directions: within 5 min ' + p.bothWaysWithin[5] + '% | 15 min ' + p.bothWaysWithin[15] + '% | 30 min ' + p.bothWaysWithin[30] + '%  (of ' + p.withStop + ')');
  }
  const byDistance = alertsByDistance(bars, sets[0][1], { symbol, from, to });
  console.log('\nalerts of the 1m/5m/1h rule by their distance to a high-impact ' + currency + ' data release:');
  for (const row of byDistance.rows) console.log('  ' + row.name.padEnd(40) + String(row.alerts).padStart(7) + ' alerts   target 1 first ' + fixed(row.targetFirstPercent) + '%  (plus or minus ' + fixed(row.plusMinus) + ' points)');
  console.log('  an alert stays open ' + byDistance.medianMinutesOpen + ' minutes at the median; ' + byDistance.openWithin[30] + '% are decided within 30 minutes, ' + byDistance.openWithin[60] + '% within 60');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
