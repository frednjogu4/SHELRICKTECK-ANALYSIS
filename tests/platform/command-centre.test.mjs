import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { splitBestPick } from '../../src/bestpick.js';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8');

test('Command Centre has one authoritative, read-only overview structure', () => {
  const doc = new JSDOM(html).window.document;
  const overview = doc.getElementById('view-overview');
  assert.ok(overview);
  for (const id of ['marketStatusTitle', 'marketOverviewTitle', 'analysisSummaryTitle', 'portfolioOverviewTitle', 'workspaceNavTitle']) {
    assert.equal(overview.querySelectorAll('#' + id).length, 1, id + ' appears once');
  }
  for (const id of ['ovMovers', 'ovPositions', 'ovSignals', 'ovNews', 'ovKpis', 'tickerTrack']) {
    assert.equal(doc.getElementById(id), null, id + ' legacy duplicate removed');
  }
  for (const id of ['pfBalance', 'pfEquity', 'pfPl', 'pfClosed']) {
    assert.equal(doc.querySelectorAll('#' + id).length, 1, id + ' has one authoritative portfolio display');
  }
  assert.ok(doc.getElementById('settingsConnections').contains(doc.getElementById('atHealth')));
  assert.equal([...overview.querySelectorAll('button')].some((button) => /new order|place order|execute/i.test(button.textContent)), false, 'overview has no order/execute CTA');
  for (const view of ['markets', 'watch', 'trade', 'news', 'signals', 'portfolio', 'settings', 'automation']) {
    assert.ok(doc.querySelector('.nav-item[data-view="' + view + '"]'), view + ' specialist navigation preserved');
  }
  assert.match(main, /function renderCommandMarkets\(\)/);
  assert.match(main, /const freshness=!hasPrice\?'unavailable':age<=30000\?'live':'stale'/);
  assert.match(main, /Timestamp unavailable/);
  assert.match(main, /card\.querySelector\('\.badge'\)\.textContent=incomplete\?'INCOMPLETE'/);
  assert.match(main, /useButton\.disabled=true;useButton\.textContent=contextOnly\?'No trade plan':'INCOMPLETE'/);
  assert.match(html, /@media\(max-width:960px\)\{\.command-market-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(html, /@media\(max-width:640px\)\{\.command-market-grid,\.command-nav-grid\{grid-template-columns:1fr\}/);
});

test('missing or invalid trade levels are explicitly incomplete and never win complete-analysis ranking', () => {
  const validBuy = { symbol: 'EUR/USD', signal: 'BUY', confidence: 62, entry: 1.1, stop_loss: 1.09, tp1: 1.12, source: 'test' };
  const missingEntry = { ...validBuy, symbol: 'GBP/USD', entry: undefined, confidence: 99 };
  const missingStop = { ...validBuy, symbol: 'USD/JPY', stop_loss: null, confidence: 98 };
  const missingTarget = { ...validBuy, symbol: 'AUD/USD', tp1: undefined, take_profit: undefined, confidence: 97 };
  const wrongDirection = { ...validBuy, symbol: 'USD/CHF', stop_loss: 1.11, confidence: 96 };
  const pick = splitBestPick([missingEntry, missingStop, missingTarget, wrongDirection, validBuy]);
  assert.equal(pick.live.symbol, 'EUR/USD');
  for (const symbol of ['GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF']) {
    const record = pick.liveSide.find((reading) => reading.symbol === symbol);
    assert.equal(record.analysis_status, 'INCOMPLETE', symbol);
    assert.ok(record.incomplete_reasons.length, symbol + ' reason recorded');
  }
  assert.equal(pick.liveSide.filter((reading) => reading.analysis_status === 'INCOMPLETE').length, 4);
});

test('all incomplete directional readings produce no best-pick candidate', () => {
  const pick = splitBestPick([
    { symbol: 'EUR/USD', signal: 'BUY', confidence: 90, entry: 1.1, stop_loss: 1.09 },
    { symbol: 'GBP/USD', signal: 'SELL', confidence: 89, entry: 1.2, stop_loss: 1.21, tp1: 0 }
  ]);
  assert.equal(pick.live, null);
  assert.equal(pick.liveSide.filter((reading) => reading.analysis_status === 'INCOMPLETE').length, 2);
});
