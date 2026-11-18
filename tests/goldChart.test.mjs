import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGoldCandlestickChart } from '../src/goldchart.js';

const candles = [
  { time: 1800000000, open: 4000, high: 4004, low: 3998, close: 4003 },
  { time: 1800000300, open: 4003, high: 4005, low: 3999, close: 4000 }
];

test('Gold chart renders verified OHLC candles and a live price marker as an accessible SVG', () => {
  const svg = renderGoldCandlestickChart(candles, { price: 4002, digits: 2 });
  assert.match(svg, /<svg[^>]+role="img"/);
  assert.match(svg, /Gold XAU\/USD 5-minute candlestick price chart, 2 verified candles/);
  assert.match(svg, /var\(--green\)/);
  assert.match(svg, /var\(--red\)/);
  assert.match(svg, /LIVE 4,002\.00/);
  assert.match(svg, /chart only, not a signal/);
});

test('Gold chart omits malformed bars and withholds output when verified history is too short', () => {
  assert.equal(renderGoldCandlestickChart([{ time: 1, open: 2, high: 1, low: 3, close: 2 }]), '');
  assert.equal(renderGoldCandlestickChart(candles.slice(0, 1)), '');
  const svg = renderGoldCandlestickChart([...candles, { time: 1800000600, open: 10, high: 9, low: 11, close: 10 }]);
  assert.match(svg, /2 verified candles/);
});
