/* ================================================================
 * AURUM news helpers — pure functions (unit-tested).
 * Headlines: public RSS (keyless), parsed defensively.
 * Direction bias: conservative keyword heuristic, ALWAYS labelled
 * 'heuristic' — it is not AI and not advice. Real AI calls need a
 * key (Settings) via the existing AI endpoints.
 * Calendar: TradingEconomics documented guest access, filtered to
 * "today" in UTC, impact mapped to Low/Medium/High.
 * ================================================================ */

export const RSS_SOURCES = [
  { name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' },
  { name: 'Investing.com', url: 'https://www.investing.com/rss/news_1.rss' },
  { name: 'CNBC', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' }
];

const stripCdata = (s) => String(s || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
const stripTags = (s) => stripCdata(String(s || '')).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** Parse an RSS/XML string into {title, link, published} items. Never throws on odd items. */
export function parseRss(xml) {
  const out = [];
  const items = String(xml || '').split(/<item[\s>]/i).slice(1);
  for (const raw of items) {
    const title = stripTags((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    let link = stripTags((raw.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
    if (!link) { const m = raw.match(/href="([^"]+)"/i); if (m) link = m[1]; }
    const published = stripTags((raw.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    const tp = published ? Date.parse(published) : NaN; /* RFC-822 in most feeds */
    if (title && link) out.push({ title: title.slice(0, 200), link, published, source: '', t: Number.isFinite(tp) ? tp : null });
    if (out.length >= 20) break;
  }
  return out;
}

/* --- currency-tone heuristic (conservative keyword map) --- */
const CCYS = [
  [/\b(USD|US dollar|dollar|greenback|fed|federal reserve|fomc|powell)\b/i, 'USD'],
  [/\b(EUR|euro|ecb|european central bank|lagarde)\b/i, 'EUR'],
  [/\b(GBP|pound|sterling|boe|bank of england)\b/i, 'GBP'],
  [/\b(JPY|yen|boj|bank of japan|ueda)\b/i, 'JPY'],
  [/\b(AUD|aussie|rba)\b/i, 'AUD'],
  [/\b(CHF|franc|snb|swiss national bank)\b/i, 'CHF'],
  [/\b(CAD|loonie|boc|bank of canada)\b/i, 'CAD'],
  [/\b(NZD|kiwi|rbnz)\b/i, 'NZD'],
  [/\b(gold|XAU)\b/i, 'XAU']
];
const UP = /\b(hawkish|rate hike|raises? rates|rate rise|inflation (jump|surge|accelerat|pick)|hotter|beats? expectations|strong(er)? data|rally|surge|soars?|jumps?|upbeat|record high)\b/i;
const DOWN = /\b(dovish|rate cut|cuts? rates|stimulus|inflation (cools|eases|fall|slow)|softer|misses? expectations|weak(er)? data|slides?|plunges?|tumbles?|falls?|drops?|recession fears?|risk[- ]off)\b/i;

/** Canonical major pair for a currency + direction for a tone. Returns null when unmappable. */
export function biasFor(title) {
  const t = String(title || '');
  let ccy = null, tone = null;
  for (const [re, c] of CCYS) { if (re.test(t)) { ccy = c; break; } }
  if (!ccy) return null;
  if (UP.test(t)) tone = 'up';
  else if (DOWN.test(t)) tone = 'down';
  else return { ccy, tone: null, pair: null, dir: null, engine: 'heuristic' };
  const basePairs = { EUR: 'EUR/USD', GBP: 'GBP/USD', AUD: 'AUD/USD', NZD: 'NZD/USD', USD: 'USD/JPY', CHF: 'USD/CHF', CAD: 'USD/CAD', XAU: null };
  const pair = ccy === 'JPY' ? 'USD/JPY' : basePairs[ccy];
  let dir = null;
  if (pair) {
    const ccyIsBase = pair.indexOf(ccy) === 0;
    dir = (tone === 'up') === ccyIsBase ? 'BUY' : 'SELL';
  }
  return { ccy, tone, pair, dir, engine: 'heuristic' };
}

/** Normalize the public ForexFactory weekly-calendar JSON (faireconomy.media,
 *  the feed behind FF's own calendar widgets) to one UTC date. */
export function parseFfCalendar(rows, dayUtc) {
  const day = (dayUtc instanceof Date ? dayUtc : new Date(dayUtc)).toISOString().slice(0, 10);
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || !r.date || !r.title) continue;
    const d = new Date(r.date);
    if (isNaN(d) || d.toISOString().slice(0, 10) !== day) continue;
    const imp = String(r.impact || '').toLowerCase();
    out.push({
      time_utc: imp === 'holiday' ? '' : d.toISOString().slice(11, 16),
      country: String(r.country || '').slice(0, 24),
      event: String(r.title).slice(0, 120),
      impact: imp.includes('high') ? 'High' : imp.includes('med') ? 'Medium' : imp === 'holiday' ? 'Holiday' : 'Low',
      forecast: r.forecast ? String(r.forecast).slice(0, 24) : '',
      previous: r.previous ? String(r.previous).slice(0, 24) : ''
    });
    if (out.length >= 60) break;
  }
  out.sort((a, b) => (a.time_utc || '99').localeCompare(b.time_utc || '99'));
  return out;
}

/** Filter a TradingEconomics calendar array to one UTC date, normalized. */
export function calendarTodayUtc(rows, dayUtc) {
  const day = (dayUtc instanceof Date ? dayUtc : new Date(dayUtc)).toISOString().slice(0, 10);
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || !r.Date || !r.Event) continue;
    const d = new Date(r.Date);
    if (isNaN(d) || d.toISOString().slice(0, 10) !== day) continue;
    const imp = String(r.Importance || '').toLowerCase();
    out.push({
      time_utc: r.AllDay ? '' : d.toISOString().slice(11, 16),
      country: String(r.Country || '').slice(0, 24),
      event: String(r.Event).slice(0, 120),
      impact: imp.includes('high') ? 'High' : imp.includes('med') ? 'Medium' : 'Low'
    });
    if (out.length >= 40) break;
  }
  out.sort((a, b) => (a.time_utc || '99') .localeCompare(b.time_utc || '99'));
  return out;
}
