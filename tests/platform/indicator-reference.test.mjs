/*
 * server/lib/indicators.js against an independent calculation.
 *
 * The expected numbers below were not produced by the functions under test:
 * they come from a separate re-computation of the textbook definitions (done
 * in Python for the audit in docs/ANALYSIS_ENGINE_AUDIT.md) on the fixed
 * series built here. The series is arithmetic, not market data. The tests say
 * what each function computes and what cannot be computed from the number of
 * candles the application reads.
 *
 * RSI and ATR: until 13 November 2026 both were averages of the last 14 values
 * only, which is not what a charting platform shows. Since then they are
 * Wilder's, as on TradingView and MT5. The two tests below pin the new values
 * and keep the former ones beside them, because every figure measured before
 * that day was measured with the former definitions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { atr, bollingerBands, ema, macd, rsi, sma } from '../../server/lib/indicators.js';
import { analyzeTimeframe } from '../../server/lib/analyzer.js';
import { READING_CANDLES } from '../../src/closedcandles.js';

const CLOSES = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 3 + i * 0.07 + ((i * 7919) % 13 - 6) * 0.11);
const CANDLES = CLOSES.map((close, i) => ({ time: i * 300, open: close, high: close + 0.6 + ((i * 31) % 5) * 0.1, low: close - 0.5 - ((i * 17) % 4) * 0.1, close }));
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 5e-7, `${label}: ${actual} against ${expected}`);

test('EMA 20 and 50, MACD 12/26/9 and Bollinger 20/2 equal the independent calculation', () => {
  near(ema(CLOSES, 20), 106.643572, 'EMA20');
  near(ema(CLOSES, 50), 106.2978, 'EMA50');
  const m = macd(CLOSES);
  near(m.line, -0.514766, 'MACD line');
  near(m.signal, -0.020537, 'MACD signal');
  near(m.histogram, -0.514766 - -0.020537, 'MACD histogram');
  const bands = bollingerBands(CLOSES);
  near(bands.upper, 111.760227, 'upper band');
  near(bands.lower, 103.774486, 'lower band');
  near(bands.mid, sma(CLOSES, 20), 'middle band is the 20-candle average');
});

test('RSI 14 is the Wilder RSI a chart shows; the former simple-average RSI read the same series very differently', () => {
  near(rsi(CLOSES), 37.586140, 'Wilder RSI, independent calculation');
  /* The same value from the recurrence written out: the average of the first 14 changes, then each newer change with weight 1/14. */
  {
    let up = 0, down = 0;
    for (let i = 1; i <= 14; i++) { const d = CLOSES[i] - CLOSES[i - 1]; if (d > 0) up += d; else down -= d; }
    up /= 14; down /= 14;
    for (let i = 15; i < CLOSES.length; i++) { const d = CLOSES[i] - CLOSES[i - 1]; up = (up * 13 + Math.max(d, 0)) / 14; down = (down * 13 + Math.max(-d, 0)) / 14; }
    near(rsi(CLOSES), 100 - 100 / (1 + up / down), 'Wilder RSI, written out');
  }
  /* The former definition: the average of the last 14 changes and nothing before them. */
  let gain = 0, loss = 0;
  for (let i = CLOSES.length - 14; i < CLOSES.length; i++) { const d = CLOSES[i] - CLOSES[i - 1]; if (d > 0) gain += d; else loss -= d; }
  const former = 100 - 100 / (1 + gain / loss);
  near(former, 11.741539, 'the value this test pinned until 13 November 2026');
  assert.ok(Math.abs(rsi(CLOSES) - former) > 25, `on this series the two differ by ${Math.abs(rsi(CLOSES) - former).toFixed(1)} points`);
  /* A Wilder average carries the candles before the last 14 with it. Given 15 closes only, nothing is before them and it equals the former figure. */
  near(rsi(CLOSES.slice(-15)), former, 'seed only');
  /* From the candles of one reading it is within a few hundredths of the value from a longer history. */
  assert.ok(Math.abs(rsi(CLOSES.slice(-READING_CANDLES)) - rsi(CLOSES)) < 0.05);
});

test('ATR 14 is the Wilder average of the true ranges; the former plain average used the last 14 only', () => {
  near(atr(CANDLES), 1.581492, 'Wilder ATR, independent calculation');
  /* The same value from the recurrence written out. */
  const ranges = CANDLES.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - CANDLES[i].close), Math.abs(c.low - CANDLES[i].close)));
  let expected = ranges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
  for (const value of ranges.slice(14)) expected = (expected * 13 + value) / 14;
  near(atr(CANDLES), expected, 'Wilder ATR, written out');
  near(atr(CANDLES.slice(-15)), 1.587898, 'with 15 candles only the first average exists: the value pinned until 13 November 2026');
  assert.notEqual(atr(CANDLES), atr(CANDLES.slice(-15)), 'candles before the last 14 count');
  assert.ok(Math.abs(atr(CANDLES.slice(-READING_CANDLES)) - atr(CANDLES)) < 0.001);
});

test('EMA 200 and SMA 200 cannot be computed from the candles the application reads', () => {
  assert.ok(READING_CANDLES < 200, 'a reading is made from ' + READING_CANDLES + ' finished candles');
  assert.equal(ema(CLOSES, 200), null);
  assert.equal(sma(CLOSES, 200), null);
  const reading = analyzeTimeframe('EUR/USD', CANDLES.slice(-READING_CANDLES), '5m');
  assert.equal(reading.indicators.ema200, null);
  assert.equal(reading.indicators.sma200, null);
  assert.ok(Number.isFinite(reading.indicators.ema50) && Number.isFinite(reading.indicators.sma50));
});
