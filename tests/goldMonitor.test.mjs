import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('Gold panel exposes actionable selected-source and retry status', () => {
  const html = read('../index.html');
  const main = read('../src/main.js');
  assert.match(html, /id="goldAnalysisNotice"/);
  assert.match(html, /id="goldAnalysisNoticeText"/);
  assert.match(html, /id="goldConnectBtn"/);
  assert.match(main, /Exness MT5 is unavailable in this tab/);
  assert.match(main, /A clearly labelled Deriv fallback was attempted/);
  assert.match(main, /Connect Exness \(read-only\)/);
});

test('enabling Auto-refresh triggers an immediate check; later retries are 60 seconds apart', () => {
  const main = read('../src/main.js');
  assert.match(main, /const GOLD_REFRESH_MS=60000/);
  assert.match(main, /auto\.onchange=\(\)=>\{state\.settings\.goldAuto=auto\.checked;save\(\);goldNextAttemptAt=0;if\(auto\.checked\)runGoldAnalysis\(\);else updateGoldAnalysisNotice\(\);\}/);
  assert.match(main, /goldNextAttemptAt=state\.settings\.goldAuto!==false\?Date\.now\(\)\+GOLD_REFRESH_MS:0/);
  assert.match(main, /Date\.now\(\)>=goldNextAttemptAt\)runGoldAnalysis\(\)/);
});

test('failed Exness analysis clears quote and uses only an explicitly-labelled fallback', () => {
  const main = read('../src/main.js');
  const start = main.indexOf('async function runGoldAnalysis');
  const end = main.indexOf('function startGoldMonitor', start);
  const section = main.slice(start, end);
  assert.match(section, /bridge\.bridgeHistory\('XAUUSD','M1',120\)/);
  assert.match(section, /goldDerivFallback\('Exness MT5 unavailable:/);
  assert.match(main, /Deriv public candles · labelled fallback \(reason:/);
  assert.match(section, /if\(goldDataSource\(\)==='mt5'\)goldMt5Quote=null/);
});
