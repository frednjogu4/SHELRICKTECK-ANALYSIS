import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAnnotatedCandlestickChart } from '../src/annotatedchart.js';

function fakeCanvas() {
  const labels = [];
  const ctx = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    if (key === 'fillText') return text => labels.push(String(text));
    return () => {};
  }, set(target, key, value) { target[key] = value; return true; } });
  return { labels, canvas: { clientWidth: 720, dataset: { height: '240' }, style: {}, getContext: () => ctx } };
}
function candles() {
  const start = 1_800_000_000;
  return Array.from({ length: 55 }, (_, i) => {
    const close = 1.08 + i * 0.0001;
    return { time: start + i * 60, open: close - 0.00002, high: close + 0.00005, low: close - 0.00005, close };
  });
}

test('annotated renderer keeps BUY/SELL and Entry off-chart by default while retaining supplied SL/TP levels', () => {
  const { canvas, labels } = fakeCanvas();
  const rows = candles(), last = rows.at(-1);
  const frame = {
    candles: rows,
    ema9: rows.map(c => ({ time: c.time, value: c.close - 0.00001 })),
    ema21: rows.map(c => ({ time: c.time, value: c.close - 0.00003 })),
    support_resistance: { support: [1.082], resistance: [1.086] },
    support_resistance_zones: { support: [{ low: 1.0819, high: 1.0821 }], resistance: [{ low: 1.0859, high: 1.0861 }] },
    trendlines: { highs: [{ from: { time: rows[4].time, value: rows[4].high }, to: { time: rows[35].time, value: rows[35].high } }], lows: [] },
    overlays: { signal: 'BUY', entry: last.close, sl: 1.081, tp: 1.087 }
  };
  const result = renderAnnotatedCandlestickChart(canvas, frame, { symbol: 'EUR/USD', timeframe: '1m' });
  assert.equal(result.drawn, true);
  assert.equal(result.candles, 55);
  assert.equal(result.levels.entry, last.close);
  assert.equal(result.levels.sl, 1.081);
  assert.equal(result.levels.tp1, 1.087);
  assert.ok(!labels.some(label => /^(BUY|SELL)\b|^Entry\b/i.test(label)));
  assert.ok(labels.some(label => label.startsWith('SL ')));
  assert.ok(labels.some(label => label.startsWith('TP1 ')));
});

test('Chart & Trade mode draws BUY entry arrow and Entry, SL and TP lines only when explicitly enabled', () => {
  const { canvas, labels } = fakeCanvas(), rows = candles(), last = rows.at(-1);
  const result = renderAnnotatedCandlestickChart(canvas, {
    candles: rows, overlays: { signal: 'BUY', entry: last.close, sl: 1.081, tp1: 1.087 }
  }, { symbol: 'EUR/USD', timeframe: 'M5', showTradeMarkers: true });
  assert.equal(result.drawn, true);
  assert.equal(result.levels.entry, last.close);
  assert.ok(labels.some(label => label.startsWith('BUY entry ')));
  assert.ok(labels.some(label => label.startsWith('SL ')));
  assert.ok(labels.some(label => label.startsWith('TP1 ')));
});

test('SELL chart uses its own downward marker and validated levels', () => {
  const { canvas, labels } = fakeCanvas(), rows = candles();
  const result = renderAnnotatedCandlestickChart(canvas, {
    candles: rows, overlays: { signal: 'SELL', entry: 1.084, sl: 1.085, tp1: 1.083 }
  }, { symbol: 'EUR/USD', timeframe: 'M5', showTradeMarkers: true });
  assert.equal(result.drawn, true);
  assert.ok(labels.some(label => label.startsWith('SELL entry ')));
  assert.ok(labels.some(label => label.startsWith('SL ')));
  assert.ok(labels.some(label => label.startsWith('TP1 ')));
});

test('provided empty-template JSON never plots its zero placeholders or ambiguous direction', () => {
  const { canvas, labels } = fakeCanvas(), rows = candles();
  const template = {
    candles: rows, entry: 0, sl: 0, tp1: 0, tp2: 0, support: [], resistance: [], trendline_points: [],
    direction: 'BUY/SELL', confidence_5m: 0, confidence_10m: 0
  };
  const result = renderAnnotatedCandlestickChart(canvas, template, { symbol: 'EUR/USD', timeframe: '1m', showTradeMarkers: true });
  assert.equal(result.drawn, true);
  assert.deepEqual(result.levels, { entry: null, sl: null, tp1: null, tp2: null });
  assert.ok(result.notes.includes('No complete validated entry / SL / TP; SL/TP markers withheld'));
  assert.ok(!labels.some(label => /^(BUY|SELL) entry|^SL |^TP1 |^TP2 /.test(label)));
});

test('WAIT never draws trade levels or invents an unprovided future path', () => {
  const { canvas, labels } = fakeCanvas(), rows = candles();
  const result = renderAnnotatedCandlestickChart(canvas, {
    candles: rows, overlays: { signal: 'WAIT', entry: 0, sl: 0, tp: 0 }, predicted_path: []
  }, { symbol: 'GBP/USD', timeframe: '5m', showTradeMarkers: true });
  assert.equal(result.drawn, true);
  assert.deepEqual(result.levels, { entry: null, sl: null, tp1: null, tp2: null });
  assert.ok(result.notes.includes('No priced forecast path'));
  assert.ok(!labels.some(label => /^(BUY|SELL) entry|^SL |^TP1 /.test(label)));
});
