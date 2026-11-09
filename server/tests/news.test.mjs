import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, biasFor, calendarTodayUtc, parseFfCalendar } from '../lib/news.js';

test('parseRss extracts title/link, strips CDATA and tags', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Fed signals <b>hawkish</b> pause]]></title><link>https://x.com/a</link><pubDate>Tue, 14 Oct 2026 05:00:00 GMT</pubDate></item>
    <item><title>ECB cuts rates</title><link>https://x.com/b</link></item>
    <item><title>no link item</title></item>
  </channel></rss>`;
  const rows = parseRss(xml);
  assert.equal(rows[0].t, Date.parse('Tue, 14 Oct 2026 05:00:00 GMT'));
  assert.equal(rows[1].t, null); /* no pubDate -> honest null, never a made-up time */
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Fed signals hawkish pause');
  assert.equal(rows[0].link, 'https://x.com/a');
});

test('biasFor: hawkish Fed -> USD up -> BUY USD/JPY; dovish ECB -> SELL EUR/USD; labelled heuristic', () => {
  const a = biasFor('Fed hints hawkish stance as inflation jumps');
  assert.equal(a.ccy, 'USD'); assert.equal(a.tone, 'up');
  assert.equal(a.pair, 'USD/JPY'); assert.equal(a.dir, 'BUY'); assert.equal(a.engine, 'heuristic');
  const b = biasFor('ECB cuts rates and expands stimulus');
  assert.equal(b.ccy, 'EUR'); assert.equal(b.dir, 'SELL');
  const c = biasFor('Tech earnings mixed in New York');
  assert.ok(c === null || c.dir === null, 'no confident tone -> no direction invented');
});

test('parseFfCalendar: filters to UTC day, maps impact, keeps forecast/previous', () => {
  const rows = [
    { title: 'CPI m/m', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '0.3%', previous: '0.2%' },
    { title: 'German ZEW', country: 'EUR', date: '2026-10-14T09:00:00Z', impact: 'Medium', forecast: '', previous: '' },
    { title: 'Next-day event', country: 'USD', date: '2026-10-15T08:30:00Z', impact: 'High' },
    { title: 'no date' }
  ];
  const out = parseFfCalendar(rows, '2026-10-14T00:00:00Z');
  assert.deepEqual(out.map((r) => r.event), ['German ZEW', 'CPI m/m']);
  assert.equal(out[1].impact, 'High');
  assert.equal(out[1].time_utc, '12:30');
  assert.equal(out[1].forecast, '0.3%');
});

test('calendarTodayUtc filters to the UTC day and maps impact', () => {
  const rows = [
    { Date: '2026-10-14T08:30:00-04:00', Country: 'United States', Event: 'CPI m/m', Importance: 'High' },
    { Date: '2026-10-15T08:30:00Z', Country: 'United States', Event: 'next day', Importance: 'Medium' },
    { Date: '2026-10-14T09:00:00Z', Country: 'Germany', Event: 'ZEW', Importance: 'Medium' },
    { Event: 'no date' }
  ];
  const out = calendarTodayUtc(rows, '2026-10-14T00:00:00Z');
  assert.deepEqual(out.map((r) => r.event), ['ZEW', 'CPI m/m']); /* 12:30Z CPI sorts after 09:00Z */
  assert.equal(out[1].impact, 'High');
  assert.equal(out[1].time_utc, '12:30');
});
