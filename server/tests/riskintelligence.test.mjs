import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRiskIntelligence, RISK_INTELLIGENCE_LIMITS } from '../lib/riskintelligence.js';

function series(n = 320, mode = 'trend') {
  return Array.from({ length: n }, (_, i) => {
    const base = mode === 'range'
      ? 100 + Math.sin(i / 3) * 0.2
      : 100 + i * 0.08 + Math.sin(i / 4) * 0.12;
    return {
      time: 1_800_000_000 + i * 300,
      open: base - 0.03, high: base + 0.18,
      low: base - 0.18, close: base, volume: 100 + (i % 7)
    };
  });
}

test('risk intelligence returns measured metrics for a fresh valid candle series', () => {
  const candles = series();
  const result = analyzeRiskIntelligence({
    candles, symbol: 'TEST', timeframeSeconds: 300,
    nowMs: (candles.at(-1).time + 60) * 1000
  });
  assert.equal(result.ok, true);
  assert.equal(result.symbol, 'TEST');
  assert.equal(result.dataQuality.stale, false);
  assert.ok(['NORMAL', 'CAUTION', 'DEFENSIVE'].includes(result.posture));
  assert.ok(Number.isFinite(result.metrics.atr14));
  assert.ok(result.metrics.atrPercentile >= 0 && result.metrics.atrPercentile <= 100);
  assert.ok(Number.isFinite(result.metrics.adx14));
  assert.ok(Number.isFinite(result.metrics.ema200));
  assert.ok(Number.isFinite(result.metrics.realizedVolatility30));
});

test('insufficient candles fail closed with UNKNOWN and no fabricated metrics', () => {
  const result = analyzeRiskIntelligence({ candles: series(80) });
  assert.equal(result.ok, false);
  assert.equal(result.posture, 'UNKNOWN');
  assert.equal(result.regime, 'UNKNOWN');
  assert.equal(result.metrics, null);
  assert.equal(result.reason, 'INSUFFICIENT_CANDLES');
});

test('stale candles fail closed with UNKNOWN', () => {
  const candles = series();
  const result = analyzeRiskIntelligence({
    candles, timeframeSeconds: 300,
    nowMs: (candles.at(-1).time + 901) * 1000
  });
  assert.equal(result.ok, false);
  assert.equal(result.posture, 'UNKNOWN');
  assert.equal(result.reason, 'STALE_CANDLE_SERIES');
});

test('out-of-order or malformed candles are rejected', () => {
  const candles = series();
  candles[20].time = candles[19].time;
  const result = analyzeRiskIntelligence({
    candles, nowMs: (candles.at(-1).time + 1) * 1000
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INVALID_CANDLE_SERIES');
  assert.equal(result.metrics, null);
});

test('risk intelligence does not accept non-positive or non-finite analysis context', () => {
  const candles = series();
  const result = analyzeRiskIntelligence({
    candles, timeframeSeconds: 0, nowMs: (candles.at(-1).time + 1) * 1000
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INVALID_ANALYSIS_CONTEXT');
});

test('published limits are explicit and immutable', () => {
  assert.equal(RISK_INTELLIGENCE_LIMITS.minCandles, 220);
  assert.equal(RISK_INTELLIGENCE_LIMITS.maxCandles, 1200);
  assert.equal(Object.isFrozen(RISK_INTELLIGENCE_LIMITS), true);
});
