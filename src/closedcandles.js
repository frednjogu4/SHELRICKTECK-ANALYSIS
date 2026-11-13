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
 *   - every place that reads a market (this browser, the read-only Worker, the
 *     Exness paths of the PC app) gets the same reading from the same candles.
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
 * What this is not: a better signal. The votes, thresholds and levels are the
 * ones in server/lib; only the moment they are read at changes. See the
 * replay figures in src/measured.js and in the README.
 *
 * Pure functions: no DOM, no network, no clock other than the one passed in.
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

/**
 * The last 5-minute close that every series can vouch for, in epoch seconds.
 *
 * In each series everything before its newest candle has finished, and the
 * newest candle may still be forming. That makes the latest close a series
 * can vouch for:
 *
 *   1-minute   its newest start, rounded down to five minutes
 *   5-minute   its newest start
 *   1-hour     55 minutes into its newest hour: up to there no reading needs
 *              that hour's candle, and at the full hour it would
 *
 * The earliest of the three is the answer. A series that is missing or empty
 * has no say (the analysis reports it itself). 0 when no candle carries a time.
 */
export function lastCloseOf(sets) {
  const minute = newestStart(sets && sets.m1), five = newestStart(sets && sets.m5), hour = newestStart(sets && sets.h1);
  const vouched = [];
  if (minute > 0) vouched.push(Math.floor(minute / READING_PERIOD_SEC) * READING_PERIOD_SEC);
  if (five > 0) vouched.push(Math.floor(five / READING_PERIOD_SEC) * READING_PERIOD_SEC);
  if (hour > 0) vouched.push(Math.floor(hour / PERIOD_SEC.h1) * PERIOD_SEC.h1 + PERIOD_SEC.h1 - READING_PERIOD_SEC);
  return vouched.length ? Math.min(...vouched) : 0;
}

/**
 * The candles a reading is made from: for each timeframe, the last
 * READING_CANDLES candles that had finished by the last 5-minute close.
 *
 * @param {{m1:Array, m5:Array, h1:Array}} sets  candles as the feed returned them, oldest first
 * @returns {{close:number, sets:{m1:Array, m5:Array, h1:Array}}}
 *   close  the 5-minute close the reading belongs to, epoch seconds; 0 when it could not be told
 *   sets   the finished candles (the same candle objects, never copies); a
 *          timeframe that was not an array is passed through as it was, so the
 *          analysis reports it as missing exactly as before
 */
export function closedCandleSets(sets) {
  const close = lastCloseOf(sets);
  const out = {};
  for (const key of TIMEFRAMES) {
    const candles = sets && sets[key];
    if (!Array.isArray(candles)) { out[key] = candles; continue; }
    /* With no close to go by (0), nothing passes. */
    const finished = candles.filter((candle) => { const start = startSec(candle); return start > 0 && start + PERIOD_SEC[key] <= close; });
    out[key] = finished.length > READING_CANDLES ? finished.slice(-READING_CANDLES) : finished;
  }
  return { close, sets: out };
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
