import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Signal Analyzer exposes the deterministic Forex JSON workflow without broker execution', () => {
  const html = read('../index.html'), main = read('../src/main.js'), logic = read('../server/lib/forexanalyst.js');
  for (const id of ['fxaPair', 'fxaTimeframe', 'fxaAnalyze', 'fxaUpdate', 'fxaOutput']) assert.match(html, new RegExp(`id="${id}"`));
  for (const tf of ['1m', '5m', '10m', '15m']) assert.match(html, new RegExp(`value="${tf}"`));
  assert.match(main, /historyCandles\(pair,FX_ANALYST_TIMEFRAMES\[tf\],100,\{acrossClosures:true\}\)/);
  assert.match(main, /currentPrice:quoteFresh\?instrument\.p:null/);
  assert.match(main, /output\.textContent=JSON\.stringify\(result,null,2\)/);
  assert.match(logic, /buys >= 2/);
  assert.match(logic, /sells >= 2/);
  assert.match(logic, /MAX_STOP_PIPS = 15/);
  assert.match(logic, /at least 1\.5:1 reward-to-risk/);
  assert.doesNotMatch(logic, /buy\(|placeOrder|sendOrder/);
});
