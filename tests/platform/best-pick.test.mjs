/*
 * "Today's best market" panel — which readings compete, and how a daily index
 * reading is dated (src/bestpick.js).
 *
 * The report these tests answer: the panel showed "US30 BUY 82%" from morning
 * to night. US30 is read once a day from daily closes and scores 50 + 8 per
 * check, so a BUY or SELL is 74, 82 or 90; a live 1m/5m/1h reading cannot
 * score more than 81. Ranked together, the index won all day. Now the pick is
 * made among the live readings, and the index gets a line of its own that
 * says which day its data is from.
 *
 * Every reading below is a hand-written input, not market data and not the
 * output of the analysis code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDailyReading, splitBestPick, dailyBarText, sharedDailyBarText, tradingDayText } from '../../src/bestpick.js';

const INDICES = ['NAS100', 'US30', 'SPX500'];

/* A live reading as the cloud viewer labels it (analysed in the browser). */
const live = (symbol, signal, confidence, extra = {}) => ({
  symbol, signal, confidence, tf: 'MTF 1m/5m/1h', model: 'technical', data_state: 'live',
  source: 'Deriv public candles · analysed in this browser', data_source: 'Deriv public candles · analysed in this browser', ...extra
});
/* A daily index reading as it reaches the cloud viewer from the AURUM cloud. */
const cloudDaily = (symbol, signal, confidence, extra = {}) => ({
  symbol, signal, confidence, tf: 'DAILY (index)', model: 'technical-daily', data_state: 'daily',
  source: 'Yahoo Finance public daily data · AURUM cloud analysis', data_source: 'Yahoo Finance public daily data · AURUM cloud analysis', ...extra
});
/* The same reading in the PC app: from the local API, relabelled as a fallback, without a state. */
const pcDaily = (symbol, signal, confidence) => ({
  symbol, signal, confidence, tf: 'DAILY (index)', model: 'technical-daily',
  source: 'Yahoo Finance public daily data · fallback (Exness unavailable: Exness bridge is not connected in this tab.)',
  data_source: 'Yahoo Finance public daily data · fallback (Exness unavailable: Exness bridge is not connected in this tab.)', fallback: true
});
const unavailable = (symbol) => ({ symbol, error: 'FEED_ERROR', data_state: 'unavailable', detail: 'not reached', source: 'unavailable', data_source: 'unavailable' });
const stale = (symbol) => ({ symbol, error: 'STALE_DATA', data_state: 'stale', detail: 'old candles', source: 'Deriv public candles', data_source: 'Deriv public candles · last candle 2 days ago' });

/* 2026-11-11 14:30:00 UTC, the open of the New York session of Wednesday 11 November 2026. */
const WED_11_NOV = 1794407400;

/* ---------------------------------------------------------------- the reported case */

test('the reported case: an index reading of 82 no longer takes the place of a live market', () => {
  const readings = [
    live('EUR/USD', 'WAIT', 38), live('GBP/USD', 'SELL', 61), live('USD/JPY', 'WAIT', 41),
    live('AUD/USD', 'BUY', 57), live('USD/CHF', 'WAIT', 41), live('USD/CAD', 'WAIT', 41),
    cloudDaily('NAS100', 'WAIT', 66), cloudDaily('US30', 'BUY', 82), cloudDaily('SPX500', 'BUY', 74)
  ];
  const pick = splitBestPick(readings, INDICES);
  assert.equal(pick.live.symbol, 'GBP/USD', 'the pick is the strongest live market');
  assert.equal(pick.live.confidence, 61);
  assert.equal(pick.daily.symbol, 'US30', 'the index is still shown, on its own line');
  assert.equal(pick.daily.confidence, 82);
  assert.deepEqual(pick.liveSide.map((r) => r.symbol), ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF', 'USD/CAD']);
  assert.deepEqual(pick.dailySide.map((r) => r.symbol), INDICES);
});

test('an index at 90 against a live market at the top of its own scale (81): the live market is the pick', () => {
  const pick = splitBestPick([live('EUR/USD', 'BUY', 81), cloudDaily('US30', 'SELL', 90)], INDICES);
  assert.equal(pick.live.symbol, 'EUR/USD');
  assert.equal(pick.daily.symbol, 'US30');
});

/* ---------------------------------------------------------------- the live line */

test('live line: the highest BUY or SELL wins; WAIT never does, whatever its score', () => {
  const pick = splitBestPick([live('EUR/USD', 'WAIT', 45), live('GBP/USD', 'BUY', 44), live('USD/JPY', 'SELL', 43)], INDICES);
  assert.equal(pick.live.symbol, 'GBP/USD');
});

test('live line: two markets level on score — the one scanned first is kept', () => {
  const pick = splitBestPick([live('EUR/USD', 'SELL', 61), live('GBP/USD', 'BUY', 61), live('USD/JPY', 'BUY', 60)], INDICES);
  assert.equal(pick.live.symbol, 'EUR/USD');
});

test('live line: no market has a setup — there is no pick, and the index does not fill the gap', () => {
  const pick = splitBestPick([live('EUR/USD', 'WAIT', 41), live('GBP/USD', 'WAIT', 38), cloudDaily('US30', 'BUY', 90)], INDICES);
  assert.equal(pick.live, null);
  assert.equal(pick.daily.symbol, 'US30');
});

test('live line: markets that could not be read never win, and are kept for the "not read" count', () => {
  const pick = splitBestPick([stale('EUR/USD'), unavailable('GBP/USD'), live('USD/JPY', 'SELL', 52), cloudDaily('US30', 'BUY', 82)], INDICES);
  assert.equal(pick.live.symbol, 'USD/JPY');
  assert.deepEqual(pick.liveSide.map((r) => r.symbol), ['EUR/USD', 'GBP/USD', 'USD/JPY']);
  assert.deepEqual(pick.liveSide.filter((r) => r.error).map((r) => r.data_state), ['stale', 'unavailable']);
});

test('live line: a reading marked as failed is never the pick, even if it still carries a direction and a score', () => {
  /* Not a shape either scan produces: a failed reading has no signal. Should one ever arrive,
     a direction without current candles must not be shown as today's pick. */
  const leftover = { ...stale('EUR/USD'), signal: 'BUY', confidence: 99 };
  const { live: pick, liveSide } = splitBestPick([leftover, live('GBP/USD', 'SELL', 52), live('USD/JPY', 'WAIT', 30)], INDICES);
  assert.equal(pick.symbol, 'GBP/USD');
  assert.equal(liveSide.length, 3, 'it is still counted among the live markets, as not read');
  assert.equal(splitBestPick([leftover, live('USD/JPY', 'WAIT', 30)], INDICES).live, null);
});

test('weekend: every live market is closed — no pick, although the index reading of Friday is still a BUY', () => {
  const pick = splitBestPick([...['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF', 'USD/CAD'].map(stale), cloudDaily('US30', 'BUY', 82)], INDICES);
  assert.equal(pick.live, null, 'before the change this panel named US30 all weekend');
  assert.equal(pick.liveSide.length, 6);
  assert.equal(pick.daily.symbol, 'US30');
});

/* ---------------------------------------------------------------- the daily line */

test('daily line: the strongest directional index reading; WAIT is not a trend', () => {
  const pick = splitBestPick([cloudDaily('NAS100', 'WAIT', 66), cloudDaily('US30', 'SELL', 74), cloudDaily('SPX500', 'SELL', 82)], INDICES);
  assert.equal(pick.daily.symbol, 'SPX500');
  assert.deepEqual(pick.dailyRead.map((r) => r.symbol), INDICES, 'all three were read');
});

test('daily line: two indices level on score — the one scanned first is kept', () => {
  const pick = splitBestPick([cloudDaily('NAS100', 'BUY', 82), cloudDaily('US30', 'BUY', 82)], INDICES);
  assert.equal(pick.daily.symbol, 'NAS100');
});

test('daily line: read, but no index has a direction — nothing to name, and the readings are still reported as read', () => {
  const pick = splitBestPick([live('EUR/USD', 'BUY', 60), cloudDaily('NAS100', 'WAIT', 58), cloudDaily('US30', 'WAIT', 50), cloudDaily('SPX500', 'WAIT', 66)], INDICES);
  assert.equal(pick.daily, null);
  assert.deepEqual(pick.dailyRead.map((r) => r.symbol), INDICES);
  assert.equal(pick.live.symbol, 'EUR/USD');
});

test('daily line: an index that could not be read belongs to this line, not to the live markets', () => {
  const pick = splitBestPick([live('EUR/USD', 'WAIT', 40), unavailable('NAS100'), unavailable('US30'), cloudDaily('SPX500', 'BUY', 74)], INDICES);
  assert.deepEqual(pick.liveSide.map((r) => r.symbol), ['EUR/USD'], 'an unread index is not counted as an unread live market');
  assert.deepEqual(pick.dailySide.map((r) => r.symbol), ['NAS100', 'US30', 'SPX500']);
  assert.deepEqual(pick.dailyRead.map((r) => r.symbol), ['SPX500']);
  assert.equal(pick.daily.symbol, 'SPX500');
});

/* ---------------------------------------------------------------- the PC app */

test('PC app: a daily reading from the local API is recognised without a state and gets its own line', () => {
  const pick = splitBestPick([
    { symbol: 'EUR/USD', signal: 'SELL', confidence: 61, tf: 'MTF 1m/5m/1h', model: 'technical', source: 'Deriv public candles · fallback (Exness unavailable: Exness bridge is not connected in this tab.)' },
    pcDaily('US30', 'BUY', 90)
  ], INDICES);
  assert.equal(pick.live.symbol, 'EUR/USD');
  assert.equal(pick.daily.symbol, 'US30');
});

test('PC app: an index read live from Exness MT5 is a live market — it competes with the others on the same scale', () => {
  const fromMt5 = { symbol: 'US30', signal: 'BUY', confidence: 76, tf: 'MTF 1m/5m/1h', model: 'technical', source: 'Exness MT5 local candles', data_source: 'Exness MT5 local candles' };
  const pick = splitBestPick([{ symbol: 'EUR/USD', signal: 'SELL', confidence: 61, tf: 'MTF 1m/5m/1h', model: 'technical', source: 'Exness MT5 local candles' }, fromMt5], INDICES);
  assert.equal(pick.live.symbol, 'US30');
  assert.equal(pick.daily, null);
  assert.deepEqual(pick.dailySide, [], 'no daily reading in this scan: the second line is not shown');
});

test('PC app: an index that failed without a state is not offered as a live market', () => {
  const pick = splitBestPick([{ symbol: 'US30', error: 'FEED_ERROR', detail: 'timeout' }, { symbol: 'EUR/USD', signal: 'WAIT', confidence: 20, tf: 'MTF 1m/5m/1h', model: 'technical' }], INDICES);
  assert.deepEqual(pick.liveSide.map((r) => r.symbol), ['EUR/USD']);
  assert.equal(pick.live, null);
});

/* ---------------------------------------------------------------- what counts as a daily reading */

test('isDailyReading: by state, by model, by timeframe label or by source — and never for a reading that failed', () => {
  assert.equal(isDailyReading(cloudDaily('US30', 'BUY', 82)), true);
  assert.equal(isDailyReading(pcDaily('US30', 'BUY', 82)), true);
  assert.equal(isDailyReading({ symbol: 'US30', signal: 'BUY', data_state: 'daily' }), true, 'state alone');
  assert.equal(isDailyReading({ symbol: 'US30', signal: 'BUY', model: 'technical-daily' }), true, 'model alone');
  assert.equal(isDailyReading({ symbol: 'US30', signal: 'BUY', tf: 'DAILY (index)' }), true, 'timeframe label alone');
  assert.equal(isDailyReading({ symbol: 'US30', signal: 'BUY', source: 'Yahoo Finance public daily data' }), true, 'source alone');
  assert.equal(isDailyReading({ symbol: 'US30', signal: 'BUY', data_source: 'Yahoo Finance public daily data · fallback (x)' }), true, 'relabelled source');

  assert.equal(isDailyReading(live('EUR/USD', 'BUY', 60)), false);
  assert.equal(isDailyReading({ symbol: 'US30', signal: 'BUY', tf: 'MTF 1m/5m/1h', source: 'Exness MT5 local candles' }), false, 'an index read live');
  assert.equal(isDailyReading(unavailable('US30')), false, 'a failed reading is not a daily reading');
  assert.equal(isDailyReading({ symbol: 'US30', error: 'FEED_ERROR', tf: 'DAILY (index)' }), false);
  assert.equal(isDailyReading(null), false);
  assert.equal(isDailyReading(undefined), false);
  assert.equal(isDailyReading({}), false);
});

test('nothing to split: no readings, missing readings, no index list', () => {
  for (const input of [undefined, null, [], [null, undefined]]) {
    assert.deepEqual(splitBestPick(input, INDICES), { live: null, liveSide: [], daily: null, dailySide: [], dailyRead: [] });
  }
  const pick = splitBestPick([live('EUR/USD', 'BUY', 60), cloudDaily('US30', 'BUY', 82)]);
  assert.equal(pick.live.symbol, 'EUR/USD', 'without an index list a daily reading is still kept off the live line');
  assert.equal(pick.daily.symbol, 'US30');
});

test('a score that is missing or not a number counts as zero, and never beats a real one', () => {
  const pick = splitBestPick([live('EUR/USD', 'BUY', undefined), live('GBP/USD', 'SELL', 'n/a'), live('USD/JPY', 'BUY', 5)], INDICES);
  assert.equal(pick.live.symbol, 'USD/JPY');
});

/* ---------------------------------------------------------------- which day the index line speaks for */

test('the day of a daily reading: a close, a session still open, or just the bar when the source does not say', () => {
  assert.equal(dailyBarText(cloudDaily('US30', 'BUY', 82, { daily_bar_time: WED_11_NOV, daily_bar_final: true })), 'daily close of Wed 11 Nov');
  assert.equal(dailyBarText(cloudDaily('US30', 'BUY', 82, { daily_bar_time: WED_11_NOV, daily_bar_final: false })), 'Wed 11 Nov, session open \u2014 not final');
  assert.equal(dailyBarText(cloudDaily('US30', 'BUY', 82, { daily_bar_time: WED_11_NOV, daily_bar_final: null })), 'daily bar of Wed 11 Nov');
  assert.equal(dailyBarText(cloudDaily('US30', 'BUY', 82, { daily_bar_time: WED_11_NOV })), 'daily bar of Wed 11 Nov');
  assert.equal(dailyBarText(cloudDaily('US30', 'BUY', 82, { daily_bar_time: WED_11_NOV, daily_bar_final: 'true' })), 'daily bar of Wed 11 Nov', 'only a real boolean is a statement');
});

test('the day of a daily reading: nothing is said when the reading carries no bar time (the PC app\'s local API)', () => {
  assert.equal(dailyBarText(pcDaily('US30', 'BUY', 82)), '');
  for (const value of [0, -1, null, undefined, '', 'yesterday', NaN, Infinity]) {
    assert.equal(dailyBarText(cloudDaily('US30', 'BUY', 82, { daily_bar_time: value, daily_bar_final: true })), '', `daily_bar_time ${String(value)}`);
  }
  assert.equal(dailyBarText(null), '');
  assert.equal(dailyBarText(undefined), '');
});

test('the day of a daily reading: a bar time in milliseconds is read as the same day', () => {
  assert.equal(dailyBarText({ daily_bar_time: WED_11_NOV * 1000, daily_bar_final: true }), 'daily close of Wed 11 Nov');
});

test('trading day text: weekday, day without a leading zero, month — across month and year ends', () => {
  assert.equal(tradingDayText(WED_11_NOV), 'Wed 11 Nov');
  assert.equal(tradingDayText(Date.UTC(2026, 10, 2, 14, 30) / 1000), 'Mon 2 Nov');
  assert.equal(tradingDayText(Date.UTC(2026, 10, 30, 14, 30) / 1000), 'Mon 30 Nov');
  assert.equal(tradingDayText(Date.UTC(2026, 11, 1, 14, 30) / 1000), 'Tue 1 Dec');
  assert.equal(tradingDayText(Date.UTC(2026, 11, 31, 14, 30) / 1000), 'Thu 31 Dec');
  assert.equal(tradingDayText(Date.UTC(2027, 0, 4, 14, 30) / 1000), 'Mon 4 Jan');
  assert.equal(tradingDayText(Date.UTC(2026, 5, 19, 13, 30) / 1000), 'Fri 19 Jun');
  /* A European index bar opens at 08:00 UTC and a bar stamped with its latest trade is later in the day: same day. */
  assert.equal(tradingDayText(Date.UTC(2026, 10, 11, 8, 0) / 1000), 'Wed 11 Nov');
  assert.equal(tradingDayText(Date.UTC(2026, 10, 11, 20, 59, 59) / 1000), 'Wed 11 Nov');
  assert.equal(tradingDayText(0), '');
  assert.equal(tradingDayText('abc'), '');
});

test('trading day text does not depend on the viewer\'s time zone: Nairobi, Kiritimati and Pago Pago read the same day', () => {
  const before = process.env.TZ;
  try {
    for (const zone of ['Africa/Nairobi', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/New_York', 'UTC']) {
      process.env.TZ = zone;
      /* Guard: the zone really changed for this process, so the assertion below means something. */
      const offsetHours = -new Date(WED_11_NOV * 1000).getTimezoneOffset() / 60;
      if (zone === 'Pacific/Kiritimati') assert.equal(offsetHours, 14);
      if (zone === 'Pacific/Pago_Pago') assert.equal(offsetHours, -11);
      assert.equal(tradingDayText(WED_11_NOV), 'Wed 11 Nov', zone);
      /* 20:59 UTC is already Thursday in Kiritimati and still Wednesday morning in Pago Pago. */
      assert.equal(tradingDayText(Date.UTC(2026, 10, 11, 20, 59) / 1000), 'Wed 11 Nov', zone);
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('several index readings: one description when they agree, none when they do not', () => {
  const close = { daily_bar_time: WED_11_NOV, daily_bar_final: true };
  assert.equal(sharedDailyBarText([cloudDaily('NAS100', 'WAIT', 58, close), cloudDaily('US30', 'WAIT', 50, close)]), 'daily close of Wed 11 Nov');
  assert.equal(sharedDailyBarText([cloudDaily('NAS100', 'WAIT', 58, close), cloudDaily('US30', 'WAIT', 50, { daily_bar_time: WED_11_NOV - 86400, daily_bar_final: true })]), '', 'different days');
  assert.equal(sharedDailyBarText([cloudDaily('NAS100', 'WAIT', 58, close), cloudDaily('US30', 'WAIT', 50, { daily_bar_time: WED_11_NOV, daily_bar_final: false })]), '', 'one closed, one open');
  assert.equal(sharedDailyBarText([cloudDaily('NAS100', 'WAIT', 58, close), pcDaily('US30', 'WAIT', 50)]), '', 'one of them does not say');
  assert.equal(sharedDailyBarText([pcDaily('NAS100', 'WAIT', 58), pcDaily('US30', 'WAIT', 50)]), '');
  assert.equal(sharedDailyBarText([]), '');
  assert.equal(sharedDailyBarText(null), '');
});
