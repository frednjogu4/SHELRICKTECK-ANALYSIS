import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('short-horizon outlook is attached to Gold, Chart & Trade, Watchlist graphs, and the selected drawdown market', () => {
  const html = read('../index.html');
  const main = read('../src/main.js');
  assert.match(html, /id="chartOutlook"/);
  assert.match(html, /id="goldOutlook"/);
  assert.match(main, /data-short-outlook/);
  assert.match(html, /id="watchTvOutlooks"/);
  assert.match(html, /id="ddOutlook"/);
  assert.match(main, /function refreshChartOutlook/);
  assert.match(main, /function refreshGoldOutlook/);
  assert.match(main, /function refreshWatchOutlooks/);
  assert.match(main, /function refreshDrawdownOutlook/);
});

test('short-horizon history is fetched from the selected real provider and refreshes without order execution', () => {
  const main = read('../src/main.js');
  assert.match(main, /bridge\.bridgeHistory\(mt5Symbol,'M1',300\)/);
  assert.match(main, /historyCandles\(symbol,60,300,\{acrossClosures:true\}\)/);
  assert.match(main, /analyzeShortOutlook\(candles,\{granularity:60,now:Date\.now\(\),maxAgeSeconds:180\}\)/);
  assert.match(main, /if\(view==='trade'\).*refreshChartOutlook\(true\)/);
  assert.match(main, /const SHORT_OUTLOOK_REFRESH_MS=60000/);
  assert.match(read('../src/shortoutlook.js'), /No substitute prices are used/);
  const integration = main.slice(main.indexOf('const SHORT_OUTLOOK_REFRESH_MS='), main.indexOf('const volCache={}'));
  assert.doesNotMatch(integration, /derivProposal\(|derivConfirm\(|derivWsBuy\(|derivWsSell\(|placeOrder\(/);
});
