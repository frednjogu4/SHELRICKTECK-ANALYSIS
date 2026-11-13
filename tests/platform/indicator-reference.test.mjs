/*
 * server/lib/indicators.js against an independent calculation.
 *
 * The expected numbers below were not produced by the functions under test:
 * they come from a separate re-computation of the textbook definitions (done
 * in Python for the audit in docs/ANALYSIS_ENGINE_AUDIT.md) on the fixed
 * series built here. The series is arithmetic, not market data. The tests say
 * what each function computes, including the two places where its definition
 * is not the one a charting platform shows (RSI and ATR), and what cannot be
 * computed from the number of candles the application reads.
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

test('RSI 14 is the simple-average RSI, which is not the Wilder RSI a chart shows', () => {
  near(rsi(CLOSES), 11.741539, 'RSI as coded');
  /* Wilder: the same first average, then each new change enters with weight 1/14. */
  let gain = 0, loss = 0;
  for (let i = 1; i <= 14; i++) { const d = CLOSES[i] - CLOSES[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= 14; loss /= 14;
  for (let i = 15; i < CLOSES.length; i++) { const d = CLOSES[i] - CLOSES[i - 1]; gain = (gain * 13 + Math.max(d, 0)) / 14; loss = (loss * 13 + Math.max(-d, 0)) / 14; }
  const wilder = 100 - 100 / (1 + gain / loss);
  assert.ok(Math.abs(rsi(CLOSES) - wilder) > 5, `on this series the two differ by ${Math.abs(rsi(CLOSES) - wilder).toFixed(1)} points`);
  /* The simple-average RSI of a window depends only on its last 15 closes. */
  assert.equal(rsi(CLOSES), rsi(CLOSES.slice(-15)));
});

test('ATR 14 is the plain average of the last 14 true ranges, not the Wilder average', () => {
  near(atr(CANDLES), 1.587898, 'ATR as coded');
  assert.equal(atr(CANDLES), atr(CANDLES.slice(-15)), 'only the last 15 candles count');
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
