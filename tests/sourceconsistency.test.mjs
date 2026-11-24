/* Data-source consistency: provenance registry, TradingView honesty,
 * selector labels, session-vs-provider separation, wiring regressions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROVIDERS, sessionNow, mccProvenance, goldProvenanceRows } from '../src/provenance.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const appJs = readFileSync(join(root, 'server/app.js'), 'utf8');
const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8');

test('TradingView is registered as display-only, never an analysis feed', () => {
  assert.equal(PROVIDERS.tvWidget.role.includes('DISPLAY only'), true);
  assert.equal(PROVIDERS.tvWidget.role.includes('never used for internal calculations'), true);
  assert.equal(PROVIDERS.markethours.role.includes('not a data provider'), true);
});

test('MCC provenance line names actual providers and separates session', () => {
  const line = mccProvenance(Date.UTC(2026, 10, 24, 13, 0));
  assert.match(line, /Deriv public ticks/);
  assert.match(line, /TradingView widget — display only/);
  assert.match(line, /analyzer\.js/);
  assert.match(line, /MARKET SESSION: London \/ New York overlap/);
  assert.match(line, /time classification, not a data source/);
});

test('sessionNow classifies Asian / London / New York / overlap', () => {
  assert.match(sessionNow(Date.UTC(2026, 10, 24, 3, 0)).label, /Asian/);
  assert.match(sessionNow(Date.UTC(2026, 10, 24, 9, 0)).label, /London/);
  assert.match(sessionNow(Date.UTC(2026, 10, 24, 13, 0)).label, /overlap/);
  assert.match(sessionNow(Date.UTC(2026, 10, 24, 18, 0)).label, /New York/);
  assert.match(sessionNow(Date.UTC(2026, 10, 24, 18, 0)).label, /session/);
});

test('gold provenance rows: truthful status maths, UNKNOWN when unverifiable', () => {
  const fresh = goldProvenanceRows({ source: 'Deriv closed candles', lastUpdateMs: Date.now() - 5000 });
  const find = (rows, k) => rows.find((r) => r.k === k).v;
  assert.equal(find(fresh, 'SOURCE STATUS'), 'CONNECTED');
  assert.equal(find(fresh, 'DATA SOURCE'), 'Deriv closed candles');
  assert.match(find(fresh, 'CHART DISPLAY'), /display only/);
  const none = goldProvenanceRows({});
  assert.equal(find(none, 'SOURCE STATUS'), 'UNKNOWN');
  assert.equal(find(none, 'DATA AGE'), 'UNKNOWN');
  const old = goldProvenanceRows({ source: 'x', lastUpdateMs: Date.now() - 40 * 60 * 1000 });
  assert.equal(find(old, 'SOURCE STATUS'), 'DEGRADED');
});

test('Command Centre renders a provenance line; gold strength block exists', () => {
  assert.match(html, /id="ovProvenance"/);
  assert.match(html, /id="goldStrength"/);
  for (const id of ['strengthBuyPct', 'strengthSellPct', 'strengthNeutralPct', 'strengthClass', 'strengthMethod']) {
    assert.ok(html.includes(`id="${id}"`), 'missing #' + id);
  }
  assert.match(html, /GOLD MARKET STRENGTH/);
  assert.match(html, /not a probability of profit/i);
});

test('source selectors stay honest: no TradingView/NY option as a provider', () => {
  const srcSel = html.match(/<select[^>]*id="brokerMarketSource"[\s\S]*?<\/select>/);
  assert.ok(srcSel, 'brokerMarketSource exists');
  assert.match(srcSel[0], /Deriv/);
  assert.match(srcSel[0], /Exness/);
  assert.equal(/TradingView/.test(srcSel[0]), false, 'TradingView must not be a data-source option');
  assert.equal(/New York/.test(srcSel[0]), false, 'a session must not be a data-source option');
  const msSym = html.match(/<select[^>]*id="msSym"[\s\S]*?<\/select>/);
  assert.ok(msSym && /Instrument/.test(html.slice(msSym.index - 120, msSym.index + 60)), 'msSym labelled Instrument, not Market');
});

test('strength wiring: server payload + client fallback both attach it', () => {
  assert.match(appJs, /strength:\s*marketStrength\(/);
  assert.match(mainJs, /import \{ marketStrength \} from '\.\.\/server\/lib\/strength\.js'/);
  assert.match(mainJs, /strength:\s*marketStrength\(/);
  assert.match(mainJs, /renderGoldStrength\(/);
});

test('no silent provider switch: labelled fallback text retained', () => {
  assert.match(mainJs, /labelled fallback|labelled_deriv_fallback/);
  assert.match(mainJs, /No old signal is shown as current/);
});
