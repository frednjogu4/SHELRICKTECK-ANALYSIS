/*
 * Cloudflare Worker — headlines and economic calendar routes.
 *
 * No network: the three headline feeds and the calendar feed are replaced by
 * a stub that answers per address and counts how often it was asked. The feed
 * texts below are made-up test fixtures, not news; no assertion looks at what
 * a headline means for a market.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyWorker } from '../../cloudflare/worker.js';
import { WORKER_SECURITY_HEADERS } from '../../cloudflare/platform.js';
import {
  CALENDAR_KEEP_MS, CALENDAR_LAST_GOOD_MS, CALENDAR_RETRY_MS, CALENDAR_SOURCE, CALENDAR_URL, HEADLINE_SOURCES, HEADLINES_KEEP_MS, HEADLINES_MAX,
  HEADLINES_PER_SOURCE, HEADLINES_RETRY_MS, calendarWeek, headlinesFrom, mergeHeadlines, readProviderText, safeLink, sourceFailure
} from '../../cloudflare/news.js';

const ORIGIN = 'https://aurum-staging.example';
const START = Date.parse('2026-11-10T09:00:00Z');
const [FXSTREET, INVESTING, CNBC] = HEADLINE_SOURCES.map((source) => source.url);

const rss = (items) => '<?xml version="1.0"?><rss><channel><title>fixture</title>' + items.map((item) =>
  '<item><title>' + item.title + '</title><link>' + item.link + '</link>' + (item.date ? '<pubDate>' + item.date + '</pubDate>' : '') + '</item>').join('') + '</channel></rss>';
const FEEDS = {
  [FXSTREET]: rss([
    { title: 'Fixture headline one', link: 'https://fx.example/one', date: 'Tue, 10 Nov 2026 08:10:00 GMT' },
    { title: 'Fixture headline two', link: 'https://fx.example/two', date: 'Tue, 10 Nov 2026 07:00:00 GMT' }
  ]),
  [INVESTING]: rss([{ title: 'Fixture headline three', link: 'https://inv.example/three', date: 'Tue, 10 Nov 2026 08:30:00 GMT' }]),
  [CNBC]: rss([{ title: '<![CDATA[Fixture S&amp;P headline &#x27;four&#x27;]]>', link: 'https://cnbc.example/four', date: 'Tue, 10 Nov 2026 08:20:00 GMT' }])
};
const CALENDAR_ROWS = [
  { title: 'Fixture release A', country: 'USD', date: '2026-11-10T08:30:00-05:00', impact: 'High', forecast: '0.3%', previous: '0.2%' },
  { title: 'Fixture release B', country: 'EUR', date: '2026-11-10T05:00:00-05:00', impact: 'Medium', forecast: '', previous: '' },
  { title: 'Fixture bank holiday', country: 'JPY', date: '2026-11-11T00:00:00-05:00', impact: 'Holiday', forecast: '', previous: '' },
  { title: 'Fixture release C', country: 'GBP', date: '2026-11-11T02:00:00-05:00', impact: 'High', forecast: '0.1%', previous: '0.0%' }
];

function setup({ answers = {}, limiter } = {}) {
  const clock = { ms: START };
  const calls = { upstream: [], limiterKeys: [] };
  const logs = [];
  const table = { ...FEEDS, [CALENDAR_URL]: JSON.stringify(CALENDAR_ROWS), ...answers };
  const worker = createReadOnlyWorker({
    requestImpl: async () => { throw new Error('the news routes must not open the Deriv feed'); },
    fetchImpl: async (address, init = {}) => {
      calls.upstream.push({ address: String(address), headers: { ...(init.headers || {}) } });
      const answer = table[String(address)];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'number') return new Response('blocked', { status: answer });
      if (answer === undefined) throw new Error('fixture: no answer for ' + address);
      return new Response(answer, { status: 200 });
    },
    now: () => clock.ms,
    log: (level, event, fields = {}) => logs.push({ level, event, ...fields })
  });
  const allow = { limit: async ({ key }) => { calls.limiterKeys.push(key); return { success: true }; } };
  const env = { ASSETS: { fetch: async () => new Response('shell') }, AURUM_SIGNAL_LIMITER: allow, AURUM_MARKET_LIMITER: limiter === undefined ? allow : limiter };
  const send = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
  const asked = (address) => calls.upstream.filter((call) => call.address === address).length;
  return { clock, calls, logs, send, asked, table };
}

function assertSecurityHeaders(response, label) {
  for (const [name, value] of Object.entries(WORKER_SECURITY_HEADERS)) assert.equal(response.headers.get(name), value, `${label}: ${name}`);
  assert.equal(response.headers.get('cache-control'), 'no-store', `${label}: cache-control`);
  assert.equal(response.headers.get('access-control-allow-origin'), null, `${label}: no cross-origin grant`);
  assert.equal(response.headers.get('x-aurum-runtime'), 'cloudflare-readonly', `${label}: runtime marker`);
}

/* ------------------------------------------------------------- headlines */

test('headlines: every source that answers is passed on, newest first, with its name and nothing derived', async () => {
  const { send, calls } = setup();
  const res = await send('/api/news/feed');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assertSecurityHeaders(res, 'feed');
  const data = await res.json();
  assert.deepEqual(data.items.map((item) => item.title), ['Fixture headline three', "Fixture S&P headline 'four'", 'Fixture headline one', 'Fixture headline two']);
  assert.deepEqual(data.items.map((item) => item.source), ['Investing.com', 'CNBC', 'FXStreet', 'FXStreet']);
  for (const item of data.items) {
    assert.deepEqual(Object.keys(item).sort(), ['link', 'published', 'source', 't', 'title'], 'a headline carries no direction, bias or market call');
    assert.match(item.link, /^https:\/\//);
  }
  assert.equal(data.items[0].t, Date.parse('2026-11-10T08:30:00Z'));
  assert.deepEqual(data.sources, [{ name: 'FXStreet', ok: true, headlines: 2 }, { name: 'Investing.com', ok: true, headlines: 1 }, { name: 'CNBC', ok: true, headlines: 1 }]);
  assert.match(data.note, /No direction is derived from a headline/);
  assert.equal(data.fetched_at, START);
  assert.deepEqual(calls.limiterKeys, ['aurum:cloudflare-staging:news-feed:local-dev']);
  assert.deepEqual(calls.upstream.map((call) => call.address).sort(), [FXSTREET, INVESTING, CNBC].sort());
});

test('headlines: nothing of the visitor is sent to a source', async () => {
  const { send, calls } = setup();
  await send('/api/news/feed?x=1', { headers: { cookie: 'session=abc', authorization: 'Bearer secret', 'x-ai-key': 'sk-secret', 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(calls.upstream.length, 3);
  for (const call of calls.upstream) {
    assert.deepEqual(Object.keys(call.headers).sort(), ['accept', 'user-agent'], call.address);
    assert.doesNotMatch(JSON.stringify(call), /secret|session=|203\.0\.113\.9/);
    assert.doesNotMatch(call.address, /x=1/);
  }
});

test('headlines: a source that fails is named with the reason, the others are still shown', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { send, logs } = setup({ answers: { [FXSTREET]: 403, [INVESTING]: timeout } });
  const res = await send('/api/news/feed');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.items.map((item) => item.source), ['CNBC']);
  assert.deepEqual(data.sources, [{ name: 'FXStreet', ok: false, error: 'HTTP 403' }, { name: 'Investing.com', ok: false, error: 'timed out' }, { name: 'CNBC', ok: true, headlines: 1 }]);
  assert.deepEqual(logs.filter((entry) => entry.event === 'provider_feed_failed').map((entry) => entry.target).sort(), ['FXStreet', 'Investing.com']);
});

test('headlines: when no source answers the route says so and shows nothing in their place', async () => {
  const { send, asked, clock } = setup({ answers: { [FXSTREET]: 503, [INVESTING]: new Error('connect ECONNREFUSED 10.0.0.1:443'), [CNBC]: '<rss><channel></channel></rss>' } });
  const res = await send('/api/news/feed');
  assert.equal(res.status, 502);
  assertSecurityHeaders(res, 'feed 502');
  const data = await res.json();
  assert.equal(data.error, 'news_unavailable');
  assert.equal(data.items, undefined);
  assert.equal(data.detail, 'No headline source could be read from the cloud right now (FXStreet: HTTP 503; Investing.com: unreachable; CNBC: no headlines in the answer). No substitute headlines are shown.');
  assert.doesNotMatch(JSON.stringify(data), /ECONNREFUSED|10\.0\.0\.1/, 'an internal error text is not shown');

  /* The failure is kept for a minute: the sources are not asked again for every request. */
  clock.ms += HEADLINES_RETRY_MS - 1;
  assert.equal((await send('/api/news/feed')).status, 502);
  assert.equal(asked(FXSTREET), 1);
  clock.ms += 1;
  assert.equal((await send('/api/news/feed')).status, 502);
  assert.equal(asked(FXSTREET), 2);
});

test('headlines: an answer is kept for five minutes, then the sources are asked again', async () => {
  const { send, asked, clock } = setup();
  await send('/api/news/feed');
  clock.ms += HEADLINES_KEEP_MS - 1;
  const again = await (await send('/api/news/feed')).json();
  assert.equal(asked(CNBC), 1);
  assert.equal(again.fetched_at, START, 'the kept answer says when it was read');
  clock.ms += 1;
  const later = await (await send('/api/news/feed')).json();
  assert.equal(asked(CNBC), 2);
  assert.equal(later.fetched_at, START + HEADLINES_KEEP_MS);
});

test('headlines: a link that is not a web address, and a headline without one, are left out', async () => {
  const feed = rss([
    { title: 'Fixture unsafe', link: 'javascript:alert(1)' },
    { title: 'Fixture data', link: 'data:text/html,hello' },
    { title: 'Fixture relative', link: '/story' },
    { title: '&lt;b&gt;Fixture&lt;/b&gt; <i>kept</i>', link: 'https://fx.example/kept?a=1&amp;b=2' }
  ]);
  assert.deepEqual(headlinesFrom('Fixture wire', feed), [{ title: 'Fixture kept', link: 'https://fx.example/kept?a=1&b=2', source: 'Fixture wire', published: '', t: null }]);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.example/a', '/relative', '', null, undefined, 'not a url']) assert.equal(safeLink(bad), '', String(bad));
  assert.equal(safeLink(' https://x.example/a b '), 'https://x.example/a%20b');
});

test('headlines: at most eight per source and twenty-four in all, undated ones last', () => {
  const many = rss(Array.from({ length: 15 }, (_, i) => ({ title: 'Fixture ' + i, link: 'https://fx.example/' + i })));
  assert.equal(headlinesFrom('Fixture wire', many).length, HEADLINES_PER_SOURCE);
  const dated = (t) => ({ title: 'd' + t, t }); const undated = (name) => ({ title: name, t: null });
  assert.deepEqual(mergeHeadlines([[dated(1), undated('a')], [dated(3), dated(2)], [undated('b')]]).map((item) => item.title), ['d3', 'd2', 'd1', 'a', 'b']);
  assert.equal(mergeHeadlines([Array.from({ length: 40 }, (_, i) => dated(i))]).length, HEADLINES_MAX);
  assert.deepEqual(mergeHeadlines(null), []);
});

test('headlines: the rate limiter is asked first, and a missing or exhausted one stops the request', async () => {
  const missing = setup({ limiter: null });
  const res = await missing.send('/api/news/feed');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'rate_limiter_not_configured');
  assert.equal(missing.calls.upstream.length, 0);
  const exhausted = setup({ limiter: { limit: async () => ({ success: false }) } });
  const limited = await exhausted.send('/api/news/calendar');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(exhausted.calls.upstream.length, 0);
});

test('headlines and calendar are read-only routes: GET and HEAD only', async () => {
  const { send, calls } = setup();
  for (const path of ['/api/news/feed', '/api/news/calendar']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await send(path, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.match(res.headers.get('allow'), /GET/);
    }
    const head = await send(path, { method: 'HEAD' });
    assert.equal(head.status, 200, `HEAD ${path}`);
    assert.equal(await head.text(), '');
    const foreign = await send(path, { headers: { origin: 'https://elsewhere.example' } });
    assert.equal(foreign.status, 403, `cross-origin ${path}`);
  }
  assert.equal(calls.upstream.filter((call) => call.address === CALENDAR_URL).length, 1, 'refused requests reach no source');
});

/* -------------------------------------------------------------- calendar */

test('calendar: the day of the request in the PC shape, and the whole week with the moment of each entry', async () => {
  const { send, calls } = setup();
  const res = await send('/api/news/calendar');
  assert.equal(res.status, 200);
  assertSecurityHeaders(res, 'calendar');
  const data = await res.json();
  assert.equal(data.day, '2026-11-10');
  assert.equal(data.source, CALENDAR_SOURCE);
  assert.equal(data.fetched_at, START);
  assert.deepEqual(data.events, [
    { time_utc: '10:00', country: 'EUR', event: 'Fixture release B', impact: 'Medium', forecast: '', previous: '' },
    { time_utc: '13:30', country: 'USD', event: 'Fixture release A', impact: 'High', forecast: '0.3%', previous: '0.2%' }
  ]);
  assert.deepEqual(data.week.map((entry) => [entry.day, entry.time_utc, entry.event, entry.t]), [
    ['2026-11-10', '10:00', 'Fixture release B', Date.parse('2026-11-10T10:00:00Z')],
    ['2026-11-10', '13:30', 'Fixture release A', Date.parse('2026-11-10T13:30:00Z')],
    ['2026-11-11', '07:00', 'Fixture release C', Date.parse('2026-11-11T07:00:00Z')],
    ['2026-11-11', '', 'Fixture bank holiday', null]
  ]);
  for (const entry of data.week) assert.equal(entry.actual, undefined, 'the source gives no result, and none is added');
  assert.deepEqual(calls.limiterKeys, ['aurum:cloudflare-staging:news-calendar:local-dev']);
  assert.deepEqual(calls.upstream.map((call) => call.address), [CALENDAR_URL]);
  assert.deepEqual(Object.keys(calls.upstream[0].headers).sort(), ['accept', 'user-agent']);
});

test('calendar: kept for half an hour, and the day follows the clock without asking the source again', async () => {
  const { send, asked, clock } = setup();
  await send('/api/news/calendar');
  clock.ms = Date.parse('2026-11-10T09:29:59Z');
  await send('/api/news/calendar');
  assert.equal(asked(CALENDAR_URL), 1);
  clock.ms = START + CALENDAR_KEEP_MS;
  await send('/api/news/calendar');
  assert.equal(asked(CALENDAR_URL), 2);
  /* Across midnight UTC inside the half hour: the kept rows are read for the new day. */
  clock.ms = Date.parse('2026-11-10T23:50:00Z');
  await send('/api/news/calendar');
  const before = asked(CALENDAR_URL);
  clock.ms = Date.parse('2026-11-11T00:05:00Z');
  const data = await (await send('/api/news/calendar')).json();
  assert.equal(asked(CALENDAR_URL), before);
  assert.equal(data.day, '2026-11-11');
  assert.deepEqual(data.events.map((entry) => entry.event), ['Fixture release C', 'Fixture bank holiday']);
});

for (const [name, answer, reason] of [
  ['answers with an error status', 500, 'HTTP 500'],
  ['answers with something that is not JSON', '<html>blocked</html>', 'unusable answer'],
  ['answers with JSON that is not a list', '{"error":"limit"}', 'unusable answer'],
  ['cannot be reached', new Error('getaddrinfo ENOTFOUND nfs.faireconomy.media'), 'unreachable']
]) {
  test(`calendar: when the source ${name} the route says so and assumes no events`, async () => {
    const { send, asked, clock, logs } = setup({ answers: { [CALENDAR_URL]: answer } });
    const res = await send('/api/news/calendar');
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.error, 'calendar_unavailable');
    assert.equal(data.detail, `The calendar source could not be read from the cloud right now (${CALENDAR_SOURCE}: ${reason}). No events are assumed.`);
    assert.equal(data.events, undefined);
    assert.equal(data.week, undefined);
    assert.doesNotMatch(JSON.stringify(data), /ENOTFOUND/);
    assert.equal(logs.filter((entry) => entry.event === 'provider_feed_failed').length, 1);
    clock.ms += CALENDAR_RETRY_MS - 1;
    await send('/api/news/calendar');
    assert.equal(asked(CALENDAR_URL), 1, 'a failure is kept for two minutes');
    clock.ms += 1;
    await send('/api/news/calendar');
    assert.equal(asked(CALENDAR_URL), 2);
  });
}

test('calendar: while the source does not answer, the copy read last is passed on with the time it was read, for six hours and no longer', async () => {
  const { send, asked, clock, table, logs } = setup();
  const calendar = async () => { const res = await send('/api/news/calendar'); return { status: res.status, data: await res.json() }; };
  assert.equal((await calendar()).status, 200);

  /* Half an hour later the source refuses: the schedule that was read is still the answer, dated when it was read. */
  table[CALENDAR_URL] = 503;
  clock.ms = START + CALENDAR_KEEP_MS;
  const kept = await calendar();
  assert.equal(kept.status, 200);
  assert.equal(kept.data.fetched_at, START, 'the time the copy was read, not the time of the request');
  assert.equal(kept.data.week.length, 4);
  assert.deepEqual(kept.data.events.map((entry) => entry.event), ['Fixture release B', 'Fixture release A']);
  assert.equal(asked(CALENDAR_URL), 2);
  assert.equal(logs.filter((entry) => entry.event === 'provider_feed_failed').length, 1, 'the failure is logged although an answer was given');

  /* The source is asked again after the retry time, not after the half hour of a fresh copy. */
  clock.ms += CALENDAR_RETRY_MS - 1;
  await calendar();
  assert.equal(asked(CALENDAR_URL), 2);
  clock.ms += 1;
  assert.equal((await calendar()).data.fetched_at, START);
  assert.equal(asked(CALENDAR_URL), 3);

  /* When it answers again, the new copy replaces the old one. */
  table[CALENDAR_URL] = JSON.stringify(CALENDAR_ROWS.slice(0, 1));
  clock.ms += CALENDAR_RETRY_MS;
  const fresh = await calendar();
  const readAgain = clock.ms;
  assert.equal(fresh.data.fetched_at, readAgain);
  assert.equal(fresh.data.week.length, 1);

  /* Six hours without an answer: one millisecond before, the copy is still passed on; after that the route says it has none. */
  table[CALENDAR_URL] = new Error('fixture: connection refused');
  clock.ms = readAgain + CALENDAR_LAST_GOOD_MS - 1;
  const last = await calendar();
  assert.equal(last.status, 200);
  assert.equal(last.data.fetched_at, readAgain);
  clock.ms += CALENDAR_RETRY_MS;
  const gone = await calendar();
  assert.equal(gone.status, 502);
  assert.equal(gone.data.error, 'calendar_unavailable');
  assert.equal(gone.data.week, undefined);
  assert.equal(gone.data.detail, `The calendar source could not be read from the cloud right now (${CALENDAR_SOURCE}: unreachable). No events are assumed.`);
});

test('calendarWeek ignores rows without a date or a title and never throws on odd input', () => {
  assert.deepEqual(calendarWeek(null), []);
  assert.deepEqual(calendarWeek([null, {}, { title: 'x' }, { date: 'not a date', title: 'y' }, { date: '2026-11-10T08:30:00-05:00' }]), []);
});

/* ------------------------------------------------------- provider answers */

test('a provider answer is read up to the limit and no further', async () => {
  let pulled = 0; let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode('abcdefghij')); },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  const text = await readProviderText(new Response(body), 25);
  assert.equal(text, 'abcdefghijabcdefghijabcde');
  assert.equal(cancelled, true, 'the rest of the answer is not read');
  assert.ok(pulled <= 4, 'reading stops at the limit (' + pulled + ' chunks)');
  assert.equal(await readProviderText(new Response('short'), 25), 'short');
  assert.equal(await readProviderText({ text: async () => 'x'.repeat(40) }, 25), 'x'.repeat(25));
});

test('the reason shown for a failed source never repeats an internal error text', () => {
  assert.equal(sourceFailure(Object.assign(new Error('HTTP 429'), { kind: 'http' })), 'HTTP 429');
  assert.equal(sourceFailure(Object.assign(new Error('x'), { name: 'AbortError' })), 'timed out');
  assert.equal(sourceFailure(Object.assign(new Error('x'), { kind: 'shape' })), 'unusable answer');
  assert.equal(sourceFailure(new Error('internal error; reference = abc123')), 'unreachable');
  assert.equal(sourceFailure(null), 'unreachable');
  assert.equal(sourceFailure(new Error('HTTP 500 at https://internal.example/secret')), 'unreachable');
});
