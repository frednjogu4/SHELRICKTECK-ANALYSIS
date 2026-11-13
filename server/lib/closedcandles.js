/* ================================================================
 * One reading per finished 5-minute candle.
 *
 * A 1m/5m/1h reading used to be made from whatever candles the feed held at
 * the moment of the look, including the three that were still forming. A
 * market looked at every minute could therefore change its mind every minute,
 * and each change was an alert: about 96 a day on gold.
 *
 * A reading is now made from finished candles only, as they stood at the last
 * 5-minute close the feed has shown. Two consequences:
 *
 *   - looking again before the next 5-minute close gives the same reading, so
 *     a market can change at most once per 5-minute candle;
 *   - every place that reads a market (the browser, the read-only Worker, the
 *     Exness paths of the PC app and, since 13 Nov 2026, the PC's own server in
 *     server/app.js) gets the same reading from the same candles.
 *
 * "The last 5-minute close the feed has shown" is taken from the candles
 * themselves, not from the clock of this device: a candle that starts at
 * 14:37 proves that 14:35 has passed. A device clock that is minutes off does
 * not move a reading.
 *
 * A candle counts as finished only when its own series proves it: the series
 * holds a later candle. The three series are fetched separately and a copy of
 * one of them can be a little older than the others (the candle caches keep
 * the 5-minute series for a minute and the 1-hour series for five). A copy
 * taken just before a close still shows that candle as it stood then, not as
 * it closed. So the close a reading belongs to is the latest one that all
 * three series can vouch for; until the slower copy is renewed the reading
 * stays the one of the close before, and it is never made from a candle that
 * may still have been moving.
 *
 * After a pause (the weekend, the daily break of gold, a quiet market) the
 * newest candle of the feed is new while every finished candle is from before
 * the pause. A reading made then would describe the market before the pause,
 * with an entry that is not the price now. It is not shown: closedCandleSets()
 * reports `current: false` until a 5-minute candle of the new session has
 * finished.
 *
 * What this is not: a better signal. The votes, thresholds and levels are the
 * ones in analyzer.js and localdecision.js; only the moment they are read at
 * changes. See the replay figures in src/measured.js and in the README.
 *
 * Pure functions: no DOM, no network, no clock other than the one passed in.
 * The page and the Worker import this file as src/closedcandles.js, which
 * hands on everything exported here.
 * ================================================================ */

/** A reading belongs to one 5-minute candle close. */
export const READING_PERIOD_SEC = 300;
/**
 * Candles per timeframe that go into a reading. The feeds are asked for 120;
 * up to five of the 1-minute candles lie after the last 5-minute close (up to
 * ten while one of the series is a copy from before that close), so 110 are
 * there, and a fixed number makes the reading the same whether it is made
 * five seconds or four minutes after that close.
 */
export const READING_CANDLES = 110;
/** A few seconds for the feed to publish the candle that has just closed. */
export const READING_SETTLE_MS = 5000;
/**
 * A reading is current while its close is less than two 5-minute candles
 * behind the newest candle of the feed: one candle is the normal distance just
 * before the next close, the second covers a copy of a series that is renewed
 * a little late and a single 5-minute candle without a price.
 */
export const READING_CURRENT_SEC = 2 * READING_PERIOD_SEC;

const PERIOD_SEC = Object.freeze({ m1: 60, m5: 300, h1: 3600 });
const TIMEFRAMES = Object.keys(PERIOD_SEC);

/* Candle times are epoch seconds on every feed used here; milliseconds are accepted as well. */
function startSec(candle) {
  const raw = Number(candle && candle.time);
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  return raw > 1e12 ? raw / 1000 : raw;
}

/* Start of the newest candle of one series; 0 when the series is missing, empty or carries no times. */
function newestStart(candles) {
  let newest = 0;
  if (Array.isArray(candles)) for (const candle of candles) { const start = startSec(candle); if (start > newest) newest = start; }
  return newest;
}

/* The latest 5-minute close that every series can vouch for; 0 when no candle carries a time. */
function vouchedClose(sets) {
  const minute = newestStart(sets && sets.m1), five = newestStart(sets && sets.m5), hour = newestStart(sets && sets.h1);
  const vouched = [];
  if (minute > 0) vouched.push(Math.floor(minute / READING_PERIOD_SEC) * READING_PERIOD_SEC);
  if (five > 0) vouched.push(Math.floor(five / READING_PERIOD_SEC) * READING_PERIOD_SEC);
  if (hour > 0) vouched.push(Math.floor(hour / PERIOD_SEC.h1) * PERIOD_SEC.h1 + PERIOD_SEC.h1 - READING_PERIOD_SEC);
  return vouched.length ? Math.min(...vouched) : 0;
}

/**
 * The 5-minute close a reading belongs to, in epoch seconds: the end of the
 * newest 5-minute candle that traded and that every series can vouch for.
 *
 * Vouching. In each series everything before its newest candle has finished,
 * and the newest candle may still be forming. That makes the latest close a
 * series can vouch for:
 *
 *   1-minute   its newest start, rounded down to five minutes
 *   5-minute   its newest start
 *   1-hour     55 minutes into its newest hour: up to there no reading needs
 *              that hour's candle, and at the full hour it would
 *
 * The earliest of the three is the limit. A series that is missing or empty
 * has no say (the analysis reports it itself).
 *
 * A candle that traded. Below that limit the reading belongs to the newest
 * 5-minute candle the feed actually has. A feed has no candle for five
 * minutes without a single price, so after a pause (the weekend, the daily
 * break of gold, a quiet market) the reading is still the one of the last
 * candle before the pause, with its own close time, until a candle of the new
 * session has finished. See `current` in closedCandleSets().
 *
 * 0 when no candle carries a time, or when the 5-minute series has no finished candle.
 */
export function lastCloseOf(sets) {
  const limit = vouchedClose(sets);
  const five = sets && sets.m5;
  if (!Array.isArray(five)) return limit;
  let traded = 0;
  for (const candle of five) {
    const end = startSec(candle) + PERIOD_SEC.m5;
    if (end > PERIOD_SEC.m5 && end <= limit && end > traded) traded = end;
  }
  return traded;
}

/**
 * The candles a reading is made from: for each timeframe, the last
 * READING_CANDLES candles that had finished by the reading's 5-minute close.
 *
 * @param {{m1:Array, m5:Array, h1:Array}} sets  candles as the feed returned them, oldest first
 * @returns {{close:number, current:boolean, sets:{m1:Array, m5:Array, h1:Array}}}
 *   close    the 5-minute close the reading belongs to, epoch seconds; 0 when there is none
 *   current  false when that close lies READING_CURRENT_SEC or more before the newest candle the
 *            feed holds: the market has resumed after a pause and no candle of the new session has
 *            finished yet. Such a reading describes the market before the pause; its entry is not
 *            the price now. Callers show no reading until `current` is true again.
 *            Also false when there is no close at all (close 0). That is a history without a
 *            finished 5-minute candle, not a pause: `sets` is empty then and the analysis reports
 *            the missing candles itself. A caller that says why there is no reading has to tell
 *            the two apart by `close`.
 *   sets     the finished candles (the same candle objects, never copies); a
 *            timeframe that was not an array is passed through as it was, so the
 *            analysis reports it as missing exactly as before
 */
export function closedCandleSets(sets) {
  const close = lastCloseOf(sets);
  const feedTime = Math.max(...TIMEFRAMES.map((key) => newestStart(sets && sets[key])));
  const out = {};
  for (const key of TIMEFRAMES) {
    const candles = sets && sets[key];
    if (!Array.isArray(candles)) { out[key] = candles; continue; }
    /* With no close to go by (0), nothing passes. */
    const finished = candles.filter((candle) => { const start = startSec(candle); return start > 0 && start + PERIOD_SEC[key] <= close; });
    out[key] = finished.length > READING_CANDLES ? finished.slice(-READING_CANDLES) : finished;
  }
  return { close, current: close > 0 && feedTime - close < READING_CURRENT_SEC, sets: out };
}

/**
 * When to look at a market again: `everyMs` from now, or a few seconds after
 * a 5-minute close on this device's clock when that moment comes first. Used
 * so that a new reading is on screen seconds after its candle closed, not up
 * to a whole check interval later.
 */
export function nextReadingCheck(nowMs, everyMs, settleMs = READING_SETTLE_MS) {
  const periodMs = READING_PERIOD_SEC * 1000;
  /* The first "close + settle" moment that is still ahead. */
  const afterClose = (Math.floor((nowMs - settleMs) / periodMs) + 1) * periodMs + settleMs;
  return Math.min(nowMs + everyMs, afterClose);
}
