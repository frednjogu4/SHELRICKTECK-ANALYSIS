/*
 * What a headline or a calendar entry concerns, and when to stand aside
 * around a scheduled release.
 *
 * Pure functions: no network, no DOM, no clock of their own. Nothing here says
 * which way a market will move:
 *   - a headline is matched to the markets it names;
 *   - a calendar entry to the markets priced in its currency;
 *   - a high-impact release to a period in which no new trade is opened.
 * The direction shown beside a market comes from that market's own price
 * reading, never from the wording of a headline.
 */
import { INSTRUMENTS } from '../server/lib/symbols.js';

const BY_SYMBOL = Object.fromEntries(INSTRUMENTS.map((instrument) => [instrument.s, instrument]));
const listed = (symbols) => INSTRUMENTS.map((instrument) => instrument.s).filter((symbol) => symbols.includes(symbol));

/* The currency an index CFD is priced in. */
const INDEX_CURRENCY = Object.freeze({ US30: 'USD', NAS100: 'USD', US100: 'USD', SPX500: 'USD', GER40: 'EUR', UK100: 'GBP' });
const CURRENCIES = Object.freeze(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CHF', 'CAD', 'NZD']);

/** The currencies a market is priced in: both sides of a pair, the quote side of a metal or a coin. */
export function currenciesOf(symbol) {
  const instrument = BY_SYMBOL[symbol];
  if (!instrument) return [];
  if (instrument.c === 'forex') return String(symbol).split('/');
  if (instrument.c === 'commodities' || instrument.c === 'crypto') return [String(symbol).split('/')[1]];
  if (instrument.c === 'indices') return INDEX_CURRENCY[symbol] ? [INDEX_CURRENCY[symbol]] : [];
  return []; /* synthetic indices follow no currency and no news */
}

/** Every listed market priced in a currency, in the order of the instrument list. */
export function marketsForCurrency(currency) {
  const code = String(currency || '').toUpperCase();
  if (!CURRENCIES.includes(code)) return [];
  return INSTRUMENTS.map((instrument) => instrument.s).filter((symbol) => currenciesOf(symbol).includes(code));
}

/** '&amp;' -> '&', '&#x27;' -> "'": feeds escape their titles, and a name such as S&P must be readable. */
export function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text == null ? '' : text).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (whole, body) => {
    const key = body.toLowerCase();
    if (key[0] !== '#') return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : whole;
    const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const US_INDICES = ['US30', 'NAS100', 'US100', 'SPX500'];
const NASDAQ_AND_SP = ['NAS100', 'US100', 'SPX500'];
const company = (name) => name + ' is one of the largest companies in the Nasdaq-100 and the S&P 500, so news about it concerns those indices';
const firm = (re, label, name = label) => ({ re, label, markets: NASDAQ_AND_SP, why: company(name), explain: true });

/*
 * What a headline can name. Each entry: the words, the label shown, the
 * markets and the reason. Order matters: a longer name is looked for before a
 * shorter one it contains ("Australian dollar" before "dollar"), and what has
 * been matched is taken out of the text.
 */
const SUBJECTS = [
  /* companies whose size makes them an index matter */
  firm(/\b(Nvidia|NVDA|Jensen Huang)\b/i, 'Nvidia'),
  firm(/\b(Apple|AAPL)\b/, 'Apple'),
  firm(/\b(Microsoft|MSFT)\b/i, 'Microsoft'),
  firm(/\b(Amazon|AMZN)\b/, 'Amazon'),
  firm(/\b(Alphabet|Google|GOOGL?)\b/i, 'Alphabet (Google)', 'Alphabet'),
  firm(/\b(Meta Platforms|Facebook)\b|\bMeta\b/, 'Meta'),
  firm(/\b(Tesla|TSLA)\b/i, 'Tesla'),
  firm(/\b(Broadcom|AVGO)\b/i, 'Broadcom'),
  /* indices by name */
  { re: /\bS&P ?500\b|\bS&P\b|\bSPX\b/i, label: 'S&P 500', markets: ['SPX500'], why: 'the headline names the S&P 500' },
  { re: /\b(Nasdaq|NDX)\b/i, label: 'Nasdaq', markets: ['NAS100', 'US100'], why: 'the headline names the Nasdaq' },
  { re: /\bDow Jones\b|\bDJIA\b|\bDow\b/, label: 'Dow Jones', markets: ['US30'], why: 'the headline names the Dow Jones' },
  { re: /\bWall Street\b|\bU\.?S\.? (stocks|equities|shares|stock market)\b/i, label: 'US shares', markets: US_INDICES, why: 'the headline is about US shares as a whole' },
  { re: /\bDAX\b|\bGerman (stocks|shares|equities)\b/i, label: 'German shares', markets: ['GER40'], why: 'the headline names the DAX' },
  { re: /\bFTSE\b|\bU\.?K\.? (stocks|shares|equities)\b/i, label: 'UK shares', markets: ['UK100'], why: 'the headline names the FTSE' },
  /* metals, coins, oil */
  { re: /\b(gold|bullion|XAU)\b/i, label: 'Gold', markets: ['XAU/USD'], why: 'the headline names gold' },
  { re: /\b(silver|XAG)\b/i, label: 'Silver', markets: ['XAG/USD'], why: 'the headline names silver' },
  { re: /\b(bitcoin|BTC)\b/i, label: 'Bitcoin', markets: ['BTC/USD'], why: 'the headline names Bitcoin' },
  { re: /\b(ethereum|ether|ETH)\b/i, label: 'Ethereum', markets: ['ETH/USD'], why: 'the headline names Ethereum' },
  { re: /\bcrypto(currenc(y|ies))?\b/i, label: 'Crypto', markets: ['BTC/USD', 'ETH/USD'], why: 'the headline is about cryptocurrencies as a whole' },
  { re: /\b(crude|oil|Brent|WTI|OPEC)\b/i, label: 'Oil', markets: [], why: 'This application has no oil market', explain: true },
  /* currencies and their central banks: the named ones before the bare word "dollar" */
  { re: /\b(Australian dollar|Aussie|AUD|RBA|Reserve Bank of Australia)\b/i, label: 'Australian dollar', currency: 'AUD' },
  { re: /\b(Canadian dollar|loonie|CAD|Bank of Canada|BoC)\b/i, label: 'Canadian dollar', currency: 'CAD' },
  { re: /\b(New Zealand dollar|kiwi|NZD|RBNZ)\b/i, label: 'New Zealand dollar', currency: 'NZD' },
  { re: /\b(euro|EUR|ECB|European Central Bank|Lagarde|eurozone|euro area)\b/i, label: 'Euro', currency: 'EUR' },
  { re: /\b(pound|sterling|GBP|Bank of England|BoE)\b/i, label: 'British pound', currency: 'GBP' },
  { re: /\b(yen|JPY|Bank of Japan|BoJ)\b/i, label: 'Japanese yen', currency: 'JPY' },
  { re: /\b(Swiss franc|franc|CHF|SNB|Swiss National Bank)\b/i, label: 'Swiss franc', currency: 'CHF' },
  { re: /\b(US dollar|U\.S\. dollar|dollar|greenback|USD|DXY|Federal Reserve|FOMC|Powell|Treasury yields?|Treasuries)\b/i, label: 'US dollar', currency: 'USD' },
  { re: /\bFed\b/, label: 'US dollar', currency: 'USD' }
];

/**
 * The markets of this application a headline names.
 *
 *   { subjects: [{ label, markets, why, explain }], markets: [...], named: [...] }
 *
 * A pair written out ("EUR/USD", "USDJPY") is that one market. A currency or
 * its central bank is every listed market priced in it. A company is the
 * indices it is a large part of. `markets` holds each market once, in the
 * order of the instrument list; `named` are those among them that the
 * headline points at by more than a currency (a pair, a metal, a coin, an
 * index, a company), which a page shows first. An empty list means the
 * headline names nothing this application follows; no market is guessed.
 */
export function headlineConcerns(title) {
  let text = decodeEntities(title).replace(/\s+/g, ' ');
  const subjects = [];
  const named = [];
  /* `explain`: the reason is worth showing, because the market is not named in the headline itself */
  const add = (label, markets, why, explain = false, broad = false) => {
    if (!broad) named.push(...markets);
    const known = subjects.find((subject) => subject.label === label);
    if (known) { known.markets = listed([...known.markets, ...markets]); return; }
    subjects.push({ label, markets: listed(markets), why, explain });
  };
  /* pairs first: "EUR/USD rises" is about one market, not about every euro and dollar market */
  text = text.replace(/\b([A-Z]{3})[/ -]?([A-Z]{3})\b/g, (whole, base, quote) => {
    const symbol = base + '/' + quote;
    if (!BY_SYMBOL[symbol]) return whole;
    add(symbol, [symbol], 'the headline names ' + symbol);
    return ' ';
  });
  for (const subject of SUBJECTS) {
    const flags = subject.re.flags.includes('g') ? subject.re.flags : subject.re.flags + 'g';
    const re = new RegExp(subject.re.source, flags);
    if (!re.test(text)) continue;
    text = text.replace(new RegExp(subject.re.source, flags), ' ');
    if (subject.currency) add(subject.label, marketsForCurrency(subject.currency), 'every listed market priced in ' + subject.currency, false, true);
    else add(subject.label, subject.markets, subject.why, subject.explain === true);
  }
  return { subjects, markets: listed(subjects.flatMap((subject) => subject.markets)), named: listed(named) };
}

/** The markets a calendar entry concerns: those priced in its currency. `currency` is '' when the entry names none this application follows. */
export function eventConcerns(event) {
  const code = String((event && event.country) || '').toUpperCase();
  const markets = marketsForCurrency(code);
  return { currency: markets.length ? code : '', markets };
}

/** Epoch milliseconds of a calendar entry: its own `t`, or its UTC day and 'HH:MM'. null for an all-day entry. */
export function eventTime(event, dayUtc) {
  if (!event) return null;
  if (Number.isFinite(event.t) && event.t > 0) return event.t;
  const clock = String(event.time_utc || '');
  const day = String(event.day || dayUtc || '');
  if (!/^\d{1,2}:\d{2}$/.test(clock) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const base = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(base)) return null;
  const [hours, minutes] = clock.split(':').map(Number);
  return base + hours * 3600000 + minutes * 60000;
}

/* ---- Nairobi time: UTC+3 all year, no summer time ---- */
const EAT_MS = 3 * 3600000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (value) => String(value).padStart(2, '0');

/** 'YYYY-MM-DD' of the Nairobi day a moment falls in. */
export function eatDay(ms) { return new Date(ms + EAT_MS).toISOString().slice(0, 10); }
/** 'HH:MM' on the Nairobi clock. */
export function eatClock(ms) { const d = new Date(ms + EAT_MS); return two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()); }
/** '16:30 EAT', or 'Wed 16:30 EAT' when the moment is not on the Nairobi day of `nowMs`. '' for no time. */
export function eatStamp(ms, nowMs) {
  if (!Number.isFinite(ms)) return '';
  const other = Number.isFinite(nowMs) && eatDay(ms) !== eatDay(nowMs);
  return (other ? WEEKDAYS[new Date(ms + EAT_MS).getUTCDay()] + ' ' : '') + eatClock(ms) + ' EAT';
}
/** First and last millisecond bounds of the Nairobi day of a moment: [start, end). */
export function eatDayBounds(ms) {
  const start = Date.parse(eatDay(ms) + 'T00:00:00Z') - EAT_MS;
  return [start, start + 86400000];
}

/* ---- standing aside around a high-impact release ---- */

/** No new trade from this long before a high-impact release until this long after it. */
export const STAND_ASIDE = Object.freeze({ beforeMin: 30, afterMin: 30 });

/**
 * What was measured (scripts/news-window.mjs) and is the reason for the
 * period above. Gold, 1-minute prices, the high-impact US data releases and
 * rate decisions of a public copy of the ForexFactory calendar. Other markets
 * were not measured: the period is applied to them as a precaution.
 */
export const RELEASE_MEASURED = Object.freeze({
  market: 'gold', period: 'January 2020 to March 2023', releases: 379,
  /* the 1-minute price range in the minute of the release, as a multiple of the usual one */
  rangeAtRelease: 5.4,
  /* % of releases in which price was a full stop distance of the rule away within one minute, and the same
     at the same weekday and hour a week earlier, when there was no release */
  stopWithinOneMinute: 54, stopWithinOneMinuteUsual: 5,
  /* % in which it had been that far in both directions within 15 minutes, and the same without a release */
  bothWaysWithinFifteen: 21, bothWaysWithinFifteenUsual: 2,
  /* how long an alert of the rule stays open, at the median */
  medianMinutesOpen: 30
});

/** The measurement in one sentence, as shown under the calendar. */
export function releaseMeasuredText() {
  const m = RELEASE_MEASURED;
  return 'Measured on ' + m.market + ' around ' + m.releases + ' high-impact US releases (' + m.period + '): in the minute of the release the price range was '
    + m.rangeAtRelease + ' times the usual. Within one minute price was a full stop distance of this rule away from where it stood in ' + m.stopWithinOneMinute
    + '% of the releases (' + m.stopWithinOneMinuteUsual + '% at the same hour a week earlier, without a release); within 15 minutes it had been that far in both directions in '
    + m.bothWaysWithinFifteen + '% (' + m.bothWaysWithinFifteenUsual + '% without). Which way is not known beforehand, and a trade of this rule stays open '
    + m.medianMinutesOpen + ' minutes at the median. Not a forecast; other markets were not measured.';
}

/**
 * Where a moment stands against the period around a release at `tMs`:
 *
 *   ahead   the period has not begun           minutes: until it begins
 *   before  inside it, release still to come   minutes: until the release
 *   after   inside it, release has happened    minutes: until it ends
 *   over    the period has ended               minutes: 0
 */
export function standAside(tMs, nowMs) {
  const from = tMs - STAND_ASIDE.beforeMin * 60000;
  const until = tMs + STAND_ASIDE.afterMin * 60000;
  const minutes = (target) => Math.max(0, Math.ceil((target - nowMs) / 60000));
  if (nowMs < from) return { from, until, phase: 'ahead', minutes: minutes(from) };
  if (nowMs < tMs) return { from, until, phase: 'before', minutes: minutes(tMs) };
  if (nowMs < until) return { from, until, phase: 'after', minutes: minutes(until) };
  return { from, until, phase: 'over', minutes: 0 };
}

/**
 * The high-impact releases that concern one market, seen from `nowMs`.
 *
 *   null                                   none within `aheadMin`, or none listed
 *   { phase: 'ahead', from, until, t, events }    the next period has not begun
 *   { phase: 'aside', from, until, t, events }    inside a period: no new trade until `until`
 *
 * Periods that touch are one period: with releases at 15:30 and 16:00 the
 * market is left alone from 15:00 to 16:30. `t` is the next release still to
 * come, or the latest one that has happened. `events` are the entries with
 * their time as `t`. Entries without a time (holidays, all-day) are ignored.
 */
export function exposureFor(symbol, events, nowMs, options) {
  return exposureOf(currenciesOf(symbol), events, nowMs, options);
}

/** The same for one currency: the releases that concern every market priced in it. */
export function exposureForCurrency(currency, events, nowMs, options) {
  return exposureOf([String(currency || '').toUpperCase()], events, nowMs, options);
}

function exposureOf(currencies, events, nowMs, { aheadMin = 180, dayUtc = '' } = {}) {
  if (!currencies.length || !Array.isArray(events)) return null;
  const relevant = events
    .filter((event) => event && event.impact === 'High' && currencies.includes(String(event.country || '').toUpperCase()))
    .map((event) => ({ ...event, t: eventTime(event, dayUtc) }))
    .filter((event) => event.t != null && event.t + STAND_ASIDE.afterMin * 60000 > nowMs)
    .sort((a, b) => a.t - b.t);
  if (!relevant.length) return null;
  const first = relevant[0];
  let from = first.t - STAND_ASIDE.beforeMin * 60000;
  let until = first.t + STAND_ASIDE.afterMin * 60000;
  const chain = [first];
  for (const event of relevant.slice(1)) {
    if (event.t - STAND_ASIDE.beforeMin * 60000 > until) break;
    until = event.t + STAND_ASIDE.afterMin * 60000;
    chain.push(event);
  }
  if (nowMs < from && from - nowMs > aheadMin * 60000) return null;
  const next = chain.find((event) => event.t > nowMs);
  return { phase: nowMs < from ? 'ahead' : 'aside', from, until, t: next ? next.t : chain[chain.length - 1].t, events: chain };
}

/* ---- the timeframes of a reading, for the line above the chart ---- */

/**
 * "1m -4 SELL · 5m -3 SELL · 1h +2 WAIT" -> [{ timeframe, score, vote, lean }].
 * `lean` is 'up' from +2, 'down' from -2 and 'flat' between: the same limits
 * the rule uses for a lean. A timeframe without data has score null and lean ''.
 */
export function timeframeLeans(votes) {
  return String(votes || '').split('·').map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = part.match(/^(\S+)\s+([+\-\u2212]?\d+)\s+(BUY|SELL|WAIT)$/);
    if (!match) return { timeframe: part.split(/\s+/)[0], score: null, vote: '', lean: '' };
    const score = Number(match[2].replace('\u2212', '-'));
    return { timeframe: match[1], score, vote: match[3], lean: score >= 2 ? 'up' : score <= -2 ? 'down' : 'flat' };
  });
}

/** 'down on 1m and 5m, up on 1h' — what the candles show now, in words. '' when no timeframe has data. */
export function trendWords(votes) {
  const leans = timeframeLeans(votes).filter((entry) => entry.lean);
  if (!leans.length) return '';
  const join = (names) => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  const parts = [];
  for (const [lean, word] of [['down', 'down'], ['up', 'up'], ['flat', 'no clear direction']]) {
    const names = leans.filter((entry) => entry.lean === lean).map((entry) => entry.timeframe);
    if (names.length) parts.push(word + ' on ' + join(names));
  }
  return parts.join(', ');
}
