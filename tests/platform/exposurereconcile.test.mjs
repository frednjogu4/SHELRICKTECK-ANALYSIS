import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { canonSymbol, sameInstrument, buildExposureReconcile, renderExposureReconcile } from '../../src/exposurereconcile.js';

test('canonSymbol strips separators and case', () => {
  assert.equal(canonSymbol('XAU/USD'), 'XAUUSD');
  assert.equal(canonSymbol('UKOILm'), 'UKOILM');
  assert.equal(canonSymbol('eurusd'), 'EURUSD');
  assert.equal(canonSymbol(''), '');
});

test('sameInstrument: broker suffixes and aliases match; different instruments do not', () => {
  /* Exness suffix variants of the same instrument. */
  assert.equal(sameInstrument('XAU/USD', 'XAUUSDm'), true);
  assert.equal(sameInstrument('US30', 'US30m'), true);
  assert.equal(sameInstrument('EUR/USD', 'EURUSDm'), true);
  /* App name vs broker name for the same index. */
  assert.equal(sameInstrument('SPX500', 'US500m'), true);
  /* The reported incident: gold reading vs an oil position. */
  assert.equal(sameInstrument('XAU/USD', 'UKOILm'), false);
  assert.equal(sameInstrument('EUR/USD', 'GBP/USD'), false);
  assert.equal(sameInstrument('', 'UKOILm'), false);
});

const mt5Broker = (account = {}) => ({
  type: 'mt5',
  account: Object.assign({ balance: 67.29, equity: 45.1, margin_free: 40.74, currency: 'USD' }, account)
});

test('different-instrument positions are an alert and name the instrument', () => {
  const model = buildExposureReconcile({
    reading: { symbol: 'XAU/USD', signal: 'SELL' },
    broker: mt5Broker(),
    positions: [
      { symbol: 'UKOILm', side: 'SELL', volume: 0.01, price: 87.143, profit: -11.18 },
      { symbol: 'UKOILm', side: 'SELL', volume: 0.01, price: 87.16, profit: -11.01 }
    ],
    snapshotAt: 1700000000000
  });
  assert.equal(model.mode, 'mt5');
  assert.equal(model.severity, 'alert');
  assert.equal(model.counts.mismatch, 2);
  assert.match(model.headline, /2 open MT5 positions in UKOILm/);
  assert.match(model.headline, /different instrument than this XAU\/USD reading/);
  assert.equal(model.account.balance, 67.29);
  assert.equal(model.account.freeMargin, 40.74);
});

test('an open position against the reading is a warning, not a mismatch', () => {
  const model = buildExposureReconcile({
    reading: { symbol: 'XAU/USD', signal: 'SELL' },
    broker: mt5Broker(),
    positions: [{ symbol: 'XAUUSDm', side: 'BUY', volume: 0.02, price: 3560, profit: -5 }],
    snapshotAt: 1
  });
  assert.equal(model.severity, 'warn');
  assert.equal(model.counts.conflict, 1);
  assert.equal(model.counts.mismatch, 0);
  assert.match(model.headline, /against this SELL reading/);
});

test('a same-direction position is info; suffix variants count as the same instrument', () => {
  const model = buildExposureReconcile({
    reading: { symbol: 'XAU/USD', signal: 'SELL' },
    broker: mt5Broker(),
    positions: [{ symbol: 'XAUUSDm', side: 'SELL', volume: 0.01, price: 3570, profit: 3 }],
    snapshotAt: 1
  });
  assert.equal(model.severity, 'info');
  assert.equal(model.counts.aligned, 1);
  assert.match(model.headline, /already follows this SELL reading/);
});

test('a WAIT reading compares the instrument but asserts no direction', () => {
  const model = buildExposureReconcile({
    reading: { symbol: 'XAU/USD', signal: 'WAIT' },
    broker: mt5Broker(),
    positions: [{ symbol: 'XAUUSDm', side: 'SELL', volume: 0.01, price: 3570, profit: 0 }],
    snapshotAt: 1
  });
  assert.equal(model.severity, 'info');
  assert.equal(model.counts.same, 1);
  assert.equal(model.counts.conflict, 0);
  assert.match(model.headline, /no BUY\/SELL direction to compare/);
});

test('without the MT5 bridge the state is UNAVAILABLE with an explicit reason', () => {
  const model = buildExposureReconcile({ reading: { symbol: 'XAU/USD', signal: 'SELL' }, broker: null, positions: null });
  assert.equal(model.mode, 'unavailable');
  assert.equal(model.reason, 'no_mt5_bridge');
  assert.match(model.headline, /cannot be compared with this reading/);
  assert.match(model.headline, /bridge is not connected/);
});

test('connected but no snapshot yet — distinct honest state', () => {
  const model = buildExposureReconcile({ reading: { symbol: 'XAU/USD' }, broker: mt5Broker(), positions: null });
  assert.equal(model.mode, 'unavailable');
  assert.equal(model.reason, 'no_snapshot');
  assert.match(model.headline, /no live MT5 positions snapshot yet/);
  const failed = buildExposureReconcile({ reading: { symbol: 'XAU/USD' }, broker: mt5Broker(), positions: null, snapshotFailed: true });
  assert.equal(failed.reason, 'snapshot_failed');
  assert.match(failed.headline, /refresh failed/);
});

test('connected with an empty list reports no positions, with the account strip', () => {
  const model = buildExposureReconcile({ reading: { symbol: 'XAU/USD', signal: 'BUY' }, broker: mt5Broker(), positions: [], snapshotAt: 1700000000000 });
  assert.equal(model.mode, 'mt5');
  assert.equal(model.severity, 'none');
  assert.equal(model.counts.total, 0);
  assert.match(model.headline, /no open positions/);
  assert.equal(model.account.equity, 45.1);
  assert.ok(model.notes.some((n) => /Read-only snapshot/.test(n)));
});

test('missing account numbers are omitted, never invented', () => {
  const model = buildExposureReconcile({ reading: null, broker: { type: 'mt5', account: {} }, positions: [] });
  assert.equal(model.account, null);
});

test('render: badges, account strip, and HTML-escaped fields', () => {
  const model = buildExposureReconcile({
    reading: { symbol: 'XAU/USD', signal: 'SELL' },
    broker: mt5Broker(),
    positions: [{ symbol: '<b>EVIL</b>', side: 'SELL', volume: 0.01, price: 1, profit: -2 }],
    snapshotAt: 1700000000000
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="c"></div></body></html>');
  const el = dom.window.document.getElementById('c');
  assert.equal(renderExposureReconcile(el, model), true);
  const text = el.textContent;
  assert.match(text, /OPEN POSITIONS vs THIS READING/);
  assert.match(text, /OTHER INSTRUMENT/);
  assert.match(text, /Balance/);
  assert.match(text, /67\.29 USD/);
  assert.match(text, /Free margin/);
  assert.ok(el.innerHTML.includes('&lt;b&gt;EVIL&lt;/b&gt;'), 'fields are escaped, never raw HTML');
  assert.ok(!el.innerHTML.includes('<b>EVIL</b>'), 'no injected markup survives');
  /* UNAVAILABLE renders with the grey badge and the explicit headline. */
  const off = buildExposureReconcile({ reading: { symbol: 'XAU/USD' }, broker: null, positions: null });
  renderExposureReconcile(el, off);
  assert.match(el.textContent, /UNAVAILABLE/);
  assert.match(el.textContent, /bridge is not connected/);
});
