import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAsterCandleEvidence } from '../lib/asterevidence.js';

function candles(tf, nowMs, trend = 1) {
  const period = { m15: 900, h1: 3600, h4: 14400, d1: 86400 }[tf];
  const end = Math.floor(nowMs / 1000 / period) * period;
  const rows = [];
  let price = 100;
  for (let i = 0; i < 120; i++) {
    const close = price + trend * (0.2 + (i % 3) * 0.02);
    rows.push({
      time: end - (119 - i) * period,
      open: price,
      high: Math.max(price, close) + 0.1,
      low: Math.min(price, close) - 0.1,
      close,
      volume: 10
    });
    price = close;
  }
  return rows;
}
const completeSets = (now) => Object.fromEntries(['m15', 'h1', 'h4', 'd1'].map(tf => [tf, candles(tf, now)]));

test('ASTER candle evidence reports closed multi-timeframe diagnostics without inventing external evidence', () => {
  const now = Date.now();
  const result = buildAsterCandleEvidence({ candleSets: completeSets(now), direction: 'LONG', now });
  assert.equal(result.evidence.ohlcValid, true);
  assert.equal(result.evidence.marketDataFresh, true);
  assert.equal(result.evidence.d1Trend, true);
  assert.equal(result.evidence.h4Trend, true);
  assert.equal(result.evidence.indicatorsValid, true);
  assert.equal(result.evidence.bidAskValid, null);
  assert.equal(result.evidence.spreadValid, null);
  assert.equal(result.evidence.newsValidated, null);
  assert.equal(result.evidence.positionSizingValid, null);
  assert.equal(result.evidence.brokerConstraintsValid, null);
  assert.equal(result.frames.m15.valid, true);
});

test('missing higher and lower timeframes remain UNKNOWN instead of being treated as failed evidence', () => {
  const now = Date.now();
  const result = buildAsterCandleEvidence({
    candleSets: { h1: candles('h1', now) },
    direction: 'LONG',
    now
  });
  assert.equal(result.evidence.ohlcValid, null);
  assert.equal(result.evidence.marketDataFresh, null);
  assert.equal(result.evidence.d1Trend, null);
  assert.equal(result.evidence.h4Trend, null);
  assert.equal(result.evidence.m15Confirmation, null);
  assert.equal(result.evidence.indicatorsValid, null);
});

test('malformed OHLC bars fail validation and do not produce trend evidence', () => {
  const now = Date.now();
  const sets = completeSets(now);
  sets.h4 = sets.h4.map((c, i) => i === 80 ? { ...c, high: c.low - 1 } : c);
  const result = buildAsterCandleEvidence({ candleSets: sets, direction: 'LONG', now });
  assert.equal(result.evidence.ohlcValid, false);
  assert.equal(result.evidence.h4Trend, null);
  assert.equal(result.evidence.structureValid, null);
});
