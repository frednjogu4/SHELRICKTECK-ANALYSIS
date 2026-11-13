/* ================================================================
 * What a replay of the 1m/5m/1h rule measured, shown beside its signals.
 *
 * The confidence score says how strongly the timeframes agree. It does not
 * say how often such a signal has worked. That was measured separately, by
 * replaying the rule on historical 1-minute prices (scripts/replay-rule.mjs):
 * every new BUY or SELL was followed until the price reached its stop or its
 * target 1, and the share that reached target 1 first was counted.
 *
 * With a stop of 1.5 x ATR and a target 1 of 2.25 x ATR, a win pays 1.5 times
 * what a loss costs, so 40% of signals must reach target 1 just to break even,
 * before the spread is paid. The figures below are the measured shares.
 *
 * They are facts about the past on one price series per market. They are not
 * a forecast and not a property of any single signal. They are fixed numbers
 * from the replay runs named in the README; they do not update by themselves.
 *
 *   close   the rule as it runs now: finished candles, one reading per
 *           5-minute close (src/closedcandles.js)
 *   minute  the rule as it ran until November 2026, and as the PC's own
 *           server still runs it: a look every minute, forming candles included
 *
 * No DOM, no network.
 * ================================================================ */

/** Share of signals that must reach target 1 first to break even before the spread: 1 / (1 + 1.5). */
export const BREAK_EVEN_PERCENT = 40;

const SIX_MONTHS = 'Mar \u2013 Sep 2026';
const figure = (percent, alerts, perDay) => Object.freeze({ percent, alerts, perDay });

/**
 * percent  share of finished alerts that reached target 1 before the stop
 * alerts   new BUY or SELL readings in the replay
 * perDay   alerts per weekday
 */
export const MEASURED = Object.freeze({
  'XAU/USD': Object.freeze({ name: 'gold', span: 'Jan 2020 \u2013 Nov 2026', close: figure(39.6, 82324, 46), minute: figure(39.8, 177715, 100) }),
  'EUR/USD': Object.freeze({ name: 'EUR/USD', span: SIX_MONTHS, close: figure(40.2, 6458, 49), minute: figure(39.9, 13990, 106) }),
  'GBP/USD': Object.freeze({ name: 'GBP/USD', span: SIX_MONTHS, close: figure(36.9, 6448, 49), minute: figure(36.8, 13876, 105) }),
  'AUD/USD': Object.freeze({ name: 'AUD/USD', span: SIX_MONTHS, close: figure(39.3, 6564, 50), minute: figure(39.4, 13968, 106) }),
  'USD/JPY': Object.freeze({ name: 'USD/JPY', span: SIX_MONTHS, close: figure(40.5, 6278, 48), minute: figure(40.1, 13703, 104) }),
  'USD/CHF': Object.freeze({ name: 'USD/CHF', span: SIX_MONTHS, close: figure(38.6, 6277, 48), minute: figure(38.7, 13523, 102) }),
  'USD/CAD': Object.freeze({ name: 'USD/CAD', span: SIX_MONTHS, close: figure(40.9, 6366, 48), minute: figure(41.2, 13887, 105) }),
  US30: Object.freeze({ name: 'US30', span: SIX_MONTHS, close: figure(39.8, 6105, 46), minute: figure(39.9, 13055, 99) }),
  NAS100: Object.freeze({ name: 'NAS100', span: SIX_MONTHS, close: figure(40.8, 5857, 44), minute: figure(41.4, 12536, 95) }),
  SPX500: Object.freeze({ name: 'SPX500', span: SIX_MONTHS, close: figure(40.6, 5976, 45), minute: figure(40.3, 12923, 98) })
});

const hasLevels = (reading) => Number(reading && reading.entry) > 0 && Number(reading && reading.stop_loss) > 0 && Number(reading && reading.tp1) > 0;

/** A reading made from daily closes (the index readings of the cloud): direction and score, no stop, no target. */
export function isDailyReading(reading) {
  if (!reading) return false;
  return reading.model === 'technical-daily' || reading.data_state === 'daily' || /^DAILY/i.test(String(reading.tf || ''));
}

/**
 * True for what the replay followed: a BUY or SELL of the 1m/5m/1h rule, with
 * its stop and its target 1. A decision written by an AI model, a WAIT, and a
 * daily reading are not that.
 */
export function isMeasuredKind(reading) {
  if (!reading || reading.error || isDailyReading(reading)) return false;
  if (reading.signal !== 'BUY' && reading.signal !== 'SELL') return false;
  const model = String(reading.model || 'technical');
  return (model === 'technical' || model === 'technical-exness') && hasLevels(reading);
}

/* Which timing made the reading: one made from finished candles says which 5-minute close it belongs to. */
const timingOf = (reading) => (Number(reading && reading.candle_close) > 0 ? 'close' : 'minute');

/** The replay figure for a reading's own market and timing, or null when that market was not replayed. */
export function measuredFor(reading) {
  if (!isMeasuredKind(reading)) return null;
  const market = MEASURED[String(reading.symbol || '')];
  if (!market) return null;
  return { name: market.name, span: market.span, timing: timingOf(reading), ...market[timingOf(reading)] };
}

/** "37\u201341%": the lowest and the highest share among the replayed markets, in whole percent. */
export function measuredRange(timing = 'close') {
  const shares = Object.values(MEASURED).map((market) => market[timing].percent);
  return Math.round(Math.min(...shares)) + '\u2013' + Math.round(Math.max(...shares)) + '%';
}

const count = (value) => Number(value).toLocaleString('en-US');

/**
 * The sentence shown beside a reading.
 *
 *   full   under a card's score, on the Gold monitor, in the Sniper detail
 *   short  in a table cell: "measured 39.6%" / "not measured"
 *
 * '' for a reading with nothing to say about (a WAIT of the 1m/5m/1h rule, an
 * error, a decision that did not come from the rule). A daily reading has
 * the short form only: where there is room for a sentence, the page already
 * shows one that explains the daily reading and says it has no measured result.
 */
export function measuredText(reading, { short = false } = {}) {
  if (!reading || reading.error) return '';
  if (isDailyReading(reading)) return short ? 'not measured' : '';
  if (!isMeasuredKind(reading)) return '';
  const found = measuredFor(reading);
  if (short) return found ? 'measured ' + found.percent + '%' : 'not measured';
  const needed = BREAK_EVEN_PERCENT + '% is needed to break even, before the spread.';
  if (!found) {
    return 'Not measured on this market. On the ' + Object.keys(MEASURED).length + ' markets replayed, signals of this rule reached target 1 before the stop '
      + measuredRange(timingOf(reading)) + ' of the time; ' + needed;
  }
  return 'Measured in a replay on ' + found.name + ' (' + found.span + '): ' + found.percent + '% of ' + count(found.alerts)
    + ' signals of this rule reached target 1 before the stop; ' + needed + ' Not a forecast.';
}

/** One line for a notification or a shared message. '' when there is nothing to say. */
export function measuredLine(reading) {
  if (!reading || reading.error) return '';
  if (isDailyReading(reading)) return 'Not measured: a daily reading has no stop or target.';
  if (!isMeasuredKind(reading)) return '';
  const found = measuredFor(reading);
  const needed = 'break-even ' + BREAK_EVEN_PERCENT + '% before the spread';
  return found
    ? 'Measured in a replay on ' + found.name + ': ' + found.percent + '% of such signals reached TP1 before the SL (' + needed + '). Not a forecast.'
    : 'Not measured on this market; on ' + Object.keys(MEASURED).length + ' others ' + measuredRange(timingOf(reading)) + ' of such signals reached TP1 before the SL (' + needed + ').';
}
