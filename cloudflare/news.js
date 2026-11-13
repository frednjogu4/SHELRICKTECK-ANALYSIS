/*
 * Headlines and the economic calendar for the read-only Worker.
 *
 * Helpers only: text in, plain objects out. The Worker passes on what a named
 * public source published, with the source's name beside it, or says that the
 * source could not be read. Nothing is derived from a headline here: no
 * direction, no market call, no summary.
 */
import { RSS_SOURCES, parseRss, parseFfCalendar } from '../server/lib/news.js';
import { decodeEntities } from '../src/newsimpact.js';

/** The same three public feeds the PC server reads. */
export const HEADLINE_SOURCES = RSS_SOURCES;
export const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
export const CALENDAR_SOURCE = 'ForexFactory public weekly calendar';
export const HEADLINES_PER_SOURCE = 8;
export const HEADLINES_MAX = 24;
/** How much of one source's answer is read. A feed is a few hundred kilobytes at most. */
export const MAX_FEED_BYTES = 1000000;
/** How long an answer is kept before the source is asked again, and how long a failure is. */
export const HEADLINES_KEEP_MS = 5 * 60000;
export const HEADLINES_RETRY_MS = 60000;
export const CALENDAR_KEEP_MS = 30 * 60000;
export const CALENDAR_RETRY_MS = 2 * 60000;
/** While the calendar source does not answer, the copy that was last read is passed on for this long, with the
 *  time it was read: the schedule of a week is published days ahead and does not change with the minute. */
export const CALENDAR_LAST_GOOD_MS = 6 * 3600000;
export const NEWS_NOTE = 'Headlines as published by the sources named. No direction is derived from a headline: the reading beside a market comes from its prices.';

/** An http(s) address a headline may link to, or '' for anything else (javascript:, data:, a relative path). */
export function safeLink(value) {
  try {
    const url = new URL(String(value == null ? '' : value).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

/** The headlines of one source: readable title, checked link, the source's name and its own publication time. */
export function headlinesFrom(sourceName, xml, limit = HEADLINES_PER_SOURCE) {
  const out = [];
  for (const item of parseRss(xml)) {
    const link = safeLink(decodeEntities(item.link));
    const title = decodeEntities(item.title).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!link || !title) continue;
    out.push({ title, link, source: String(sourceName), published: String(item.published || '').slice(0, 64), t: Number.isFinite(item.t) ? item.t : null });
    if (out.length >= limit) break;
  }
  return out;
}

/** Several sources as one list, newest first. A headline without a time keeps its place after the dated ones. */
export function mergeHeadlines(lists, max = HEADLINES_MAX) {
  const all = [];
  for (const list of Array.isArray(lists) ? lists : []) for (const item of Array.isArray(list) ? list : []) all.push(item);
  const dated = all.filter((item) => item.t != null).sort((a, b) => b.t - a.t);
  return [...dated, ...all.filter((item) => item.t == null)].slice(0, max);
}

/**
 * Every entry of the calendar feed with its moment:
 *   { t, day, time_utc, country, event, impact, forecast, previous }
 * `t` is epoch milliseconds and null for an entry without a time (a holiday).
 * The fields are the ones the PC server sends for one day, so a page written
 * for either host reads both. Sorted by day, then by time.
 */
export function calendarWeek(rows) {
  const days = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = new Date(row && row.date);
    if (!Number.isNaN(date.getTime())) days.add(date.toISOString().slice(0, 10));
  }
  const out = [];
  for (const day of [...days].sort()) {
    for (const entry of parseFfCalendar(rows, day)) {
      out.push({ ...entry, day, t: entry.time_utc ? Date.parse(day + 'T' + entry.time_utc + ':00Z') : null });
    }
  }
  return out;
}

/** The text of a provider's answer, read chunk by chunk and cut at `maxBytes` so that no answer is buffered whole. */
export async function readProviderText(response, maxBytes = MAX_FEED_BYTES) {
  if (!response.body || typeof response.body.getReader !== 'function') return String(await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength >= room) {
      chunks.push(value.subarray(0, room));
      total += room;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Why a source could not be read, in words that are safe to show: 'HTTP 403', 'timed out', 'unreachable', 'unusable answer'. */
export function sourceFailure(error) {
  const message = String((error && error.message) || '');
  if (/^HTTP \d{3}$/.test(message)) return message;
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timed out';
  if (error && error.kind === 'shape') return 'unusable answer';
  return 'unreachable';
}
