import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stochasticRsi, cci, williamsR, supertrend, ichimoku, keltnerChannels,
  onBalanceVolume, moneyFlowIndex, anchoredVwap, volumeProfile,
  buildProScalperSnapshot
} from '../lib/indicators.pro.js';

const makeCandles = (n = 100, opts = {}) => {
  const out = [];
  let close = opts.start ?? 100;
  for (let i = 0; i < n; i++) {
    const next = close + (opts.step ?? 0.25) + (i % 5 === 0 ? 0.08 : 0);
    out.push({
      time: 1700000000 + i * 300,
      open: close,
      high: Math.max(close, next) + 0.2,
      low: Math.min(close, next) - 0.2,
      close: next,
      volume: opts.volume === undefined ? 100 + i : opts.volume
    });
    close = next;
  }
  return out;
};

test('Stochastic RSI returns bounded K/D and null for insufficient history', () => {
  const closes = makeCandles().map((c) => c.close);
  const result = stochasticRsi(closes);
  assert.ok(result && result.k >= 0 && result.k <= 100);
  assert.ok(result.d >= 0 && result.d <= 100);
  assert.equal(stochasticRsi([1, 2, 3]), null);
});

test('CCI and Williams %R return finite values in their expected ranges', () => {
  const candles = makeCandles();
  assert.ok(Number.isFinite(cci(candles)));
  const wr = williamsR(candles);
  assert.ok(wr <= 0 && wr >= -100);
  assert.equal(williamsR(candles.slice(0, 5), 14), null);
});

test('Supertrend and Ichimoku return structured values after warmup', () => {
  const candles = makeCandles(100);
  const st = supertrend(candles);
  assert.ok(st && Number.isFinite(st.value));
  assert.ok(['UP', 'DOWN'].includes(st.direction));
  const ichi = ichimoku(candles);
  assert.ok(ichi && Number.isFinite(ichi.conversion) && Number.isFinite(ichi.spanB));
});

test('Keltner channels are ordered and centered on EMA', () => {
  const result = keltnerChannels(makeCandles());
  assert.ok(result.upper > result.mid && result.mid > result.lower);
});

test('OBV and MFI require genuine positive volume', () => {
  const candles = makeCandles();
  assert.ok(Number.isFinite(onBalanceVolume(candles)));
  assert.ok(moneyFlowIndex(candles) >= 0 && moneyFlowIndex(candles) <= 100);
  const missing = candles.map((c) => ({ ...c, volume: 0 }));
  assert.equal(onBalanceVolume(missing), null);
  assert.equal(moneyFlowIndex(missing), null);
});

test('Anchored VWAP starts at the requested candle and refuses missing volume', () => {
  const candles = makeCandles(20);
  const result = anchoredVwap(candles, candles[10].time);
  assert.ok(result && result.bars === 10);
  const missing = candles.map((c) => ({ ...c, volume: null }));
  assert.equal(anchoredVwap(missing, candles[0].time), null);
});

test('Volume Profile labels its OHLCV bar-close approximation and calculates POC', () => {
  const result = volumeProfile(makeCandles(40), 12);
  assert.ok(result && result.bins.length === 12);
  assert.ok(result.poc >= result.valueAreaLow && result.poc <= result.valueAreaHigh);
  assert.match(result.method, /not tick-level/);
});

test('snapshot fails closed on invalid candles and never authorizes execution', () => {
  assert.equal(buildProScalperSnapshot([]).ok, false);
  const candles = makeCandles(80);
  const result = buildProScalperSnapshot(candles, { anchorTime: candles[0].time });
  assert.equal(result.ok, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.status, 'ANALYSIS_ONLY');
  const noVolume = buildProScalperSnapshot(candles.map((c) => ({ ...c, volume: 0 })));
  assert.equal(noVolume.indicators.obv, null);
  assert.equal(noVolume.dataQuality.volumeAvailable, false);
});


test('EMA 200 returns null during warm-up and a finite value afterwards', async () => {
  const { emaSeries } = await import('../lib/indicators.pro.js');
  const closes = makeCandles(220).map((c) => c.close);
  assert.equal(emaSeries(closes.slice(0, 199), 200), null);
  assert.ok(Number.isFinite(emaSeries(closes, 200).at(-1)));
});

test('MACD returns line, signal and histogram after warm-up', async () => {
  const { macdSeries } = await import('../lib/indicators.pro.js');
  const closes = makeCandles(100).map((c) => c.close);
  const last = macdSeries(closes).at(-1);
  assert.ok(Number.isFinite(last.macd));
  assert.ok(Number.isFinite(last.signal));
  assert.ok(Number.isFinite(last.histogram));
});

test('Parabolic SAR produces finite directional points and validates parameters', async () => {
  const { parabolicSar } = await import('../lib/indicators.pro.js');
  const candles = makeCandles(80);
  const last = parabolicSar(candles).at(-1);
  assert.ok(Number.isFinite(last.value));
  assert.ok(['UP', 'DOWN'].includes(last.direction));
  assert.equal(parabolicSar(candles, 0.2, 0.02), null);
});

test('next-candle context is educational only and fails closed on insufficient history', async () => {
  const { nextCandleContext } = await import('../lib/indicators.pro.js');
  assert.equal(nextCandleContext(makeCandles(100)).available, false);
  const result = nextCandleContext(makeCandles(240));
  assert.equal(result.available, true);
  assert.match(result.note, /Not a next-candle prediction/);
  assert.equal(result.executionAuthorized, false);
  assert.ok(!('probability' in result));
});
