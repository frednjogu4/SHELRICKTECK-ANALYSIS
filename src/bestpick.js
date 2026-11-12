/* ================================================================
 * AURUM — "Today's best market" panel: which readings compete, and how a
 * daily index reading is described (no DOM).
 *
 * Two kinds of reading reach the panel, and their scores are not on one scale:
 *
 *   live    1m/5m/1h reading of a market (Deriv candles, or Exness MT5 in the
 *           PC app). Score: 15 + 7 per timeframe + up to 25 for bias + 20 when
 *           confirmed. With three timeframes it cannot exceed 81.
 *   daily   end-of-day reading of an index CFD from Yahoo daily bars.
 *           Score: 50 + 8 per net vote. A BUY or SELL is always 74, 82 or 90.
 *
 * Ranked together, a daily reading of 82 or 90 beat every live market, and it
 * only changes when a daily bar does: the panel named the same index all day
 * and through the weekend. So the pick is made among the live readings only,
 * and the strongest daily index reading is shown on a line of its own, with
 * the day its newest bar belongs to instead of the time the page last looked.
 * ================================================================ */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * True for an end-of-day index reading that could be read, wherever it was
 * computed: the AURUM cloud (data_state 'daily') or the PC app's local API
 * (tf 'DAILY (index)', model 'technical-daily', a Yahoo Finance source).
 */
export function isDailyReading(reading) {
  if (!reading || reading.error) return false;
  if (reading.data_state === 'daily' || reading.model === 'technical-daily') return true;
  if (/DAILY/i.test(String(reading.tf || ''))) return true;
  return String(reading.data_source || reading.source || '').startsWith('Yahoo Finance');
}

const isDirectional = (reading) => !reading.error && (reading.signal === 'BUY' || reading.signal === 'SELL');

/* The BUY or SELL with the highest score; the first one when two are level. */
function strongest(readings) {
  const directional = readings.filter(isDirectional);
  if (!directional.length) return null;
  return directional.reduce((best, reading) => ((Number(reading.confidence) || 0) > (Number(best.confidence) || 0) ? reading : best));
}

/**
 * Splits the readings of one best-market scan into the two lines of the panel.
 *
 * @param {object[]} readings      one per scanned symbol, as the scan returns them
 * @param {string[]} indexSymbols  the scanned symbols that are read as daily index readings
 *                                 when no live source has them
 * @returns {{ live: object|null, liveSide: object[], daily: object|null, dailySide: object[], dailyRead: object[] }}
 *   live       the strongest BUY or SELL among the live readings
 *   liveSide   every reading that competes for it, unread ones included
 *   daily      the strongest BUY or SELL among the daily index readings
 *   dailySide  the daily index readings, plus the index symbols that could not be read at all
 *   dailyRead  the daily index readings that could be read, whatever they say
 */
export function splitBestPick(readings, indexSymbols = []) {
  const indices = new Set(indexSymbols);
  const all = (readings || []).filter(Boolean);
  const dailyRead = all.filter(isDailyReading);
  const dailySide = all.filter((reading) => isDailyReading(reading) || (reading.error && indices.has(reading.symbol)));
  const liveSide = all.filter((reading) => !dailySide.includes(reading));
  return { live: strongest(liveSide), liveSide, daily: strongest(dailyRead), dailySide, dailyRead };
}

/* Epoch seconds of the newest daily bar behind a reading; 0 when the reading does not say. */
function dailyBarSeconds(reading) {
  const raw = Number(reading && reading.daily_bar_time);
  if (!(raw > 0)) return 0;
  return raw > 1e12 ? raw / 1000 : raw;
}

/**
 * "Wed 11 Nov": the trading day a daily bar belongs to. The index sessions
 * read here (New York, Frankfurt, London) do not cross midnight UTC, so the
 * UTC date of the bar is its trading day whatever the viewer's time zone is.
 */
export function tradingDayText(epochSeconds) {
  const seconds = Number(epochSeconds);
  if (!(seconds > 0)) return '';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return DAY_NAMES[date.getUTCDay()] + ' ' + date.getUTCDate() + ' ' + MONTH_NAMES[date.getUTCMonth()];
}

/**
 * Which day a daily index reading speaks for:
 *
 *   'daily close of Wed 11 Nov'                  that day's session had ended when the data was read
 *   'Thu 12 Nov, session open — not final'       the bar was still forming
 *   'daily bar of Wed 11 Nov'                    the source did not say which of the two
 *   ''                                           the reading carries no bar time
 */
export function dailyBarText(reading) {
  const day = tradingDayText(dailyBarSeconds(reading));
  if (!day) return '';
  if (reading.daily_bar_final === true) return 'daily close of ' + day;
  if (reading.daily_bar_final === false) return day + ', session open \u2014 not final';
  return 'daily bar of ' + day;
}

/**
 * The same for several daily readings at once: their common description, or
 * '' when they do not agree or none of them says.
 */
export function sharedDailyBarText(readings) {
  const texts = [...new Set((readings || []).map(dailyBarText))];
  return texts.length === 1 ? texts[0] : '';
}
