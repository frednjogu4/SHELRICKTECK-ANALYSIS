import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { initCommandCentre } from '../../src/commandcentre.js';

test('Command Centre mirrors existing overview values and previews without inventing market data', () => {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <section id="view-overview">
      <div id="feedText">Deriv feed · connected</div>
      <div id="derivPill">Deriv connected</div>
      <div id="mt5Status">Not connected</div>
      <div id="ovKpis"></div>
      <div id="ovMovers"><div class="mover"><b>BTC/USD</b><span data-px>60,500</span></div></div>
      <div id="ovSignals"><div class="mini-signal"><b>EUR/USD</b><span>WAIT</span></div></div>
      <div id="ovPositions"><p>No app-recorded open positions.</p></div>
    </section>
    <div id="kpiValue">$10,000.00</div><div id="kpiValueDelta">Broker equity</div>
    <div id="kpiPl">$0.00</div><div id="kpiPlCount">0 open positions</div>
    <div id="kpiMargin">Not connected</div><div id="kpiMarginSub">Connect a broker</div>
    <div id="kpiWin">—</div><div id="kpiWinSub">No closed trades yet</div>
  </body></html>`);
  const { document } = dom.window;

  assert.equal(initCommandCentre(document), true);
  const root = document.getElementById('shelrick-command-centre');
  assert.ok(root);
  assert.equal(root.querySelectorAll('.cc-kpi').length, 4);
  assert.equal(root.querySelector('.cc-kpi-value').textContent, '$10,000.00');
  assert.match(root.querySelector('#ccMovers').textContent, /BTC\/USD/);
  assert.match(root.querySelector('#ccSignals').textContent, /WAIT/);
  assert.match(root.querySelector('#ccPositions').textContent, /No app-recorded open positions/);
  assert.match(root.querySelector('#ccStatuses').textContent, /Deriv feed · connected/);
  assert.equal(root.querySelector('[data-goto="signals"]')?.textContent.trim(), 'Signal analyser ↗');
  assert.equal(initCommandCentre(document), true, 'initialization is idempotent');
  assert.equal(document.querySelectorAll('#shelrick-command-centre').length, 1);
  assert.equal(document.querySelectorAll('#shelrick-command-centre [id="ovMovers"]').length, 0, 'cloned previews do not duplicate source IDs');
  dom.window.close();
});

test('Command Centre does not mount when the existing overview contract is absent', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main></main></body></html>');
  assert.equal(initCommandCentre(dom.window.document), false);
  assert.equal(dom.window.document.getElementById('shelrick-command-centre'), null);
  dom.window.close();
});
