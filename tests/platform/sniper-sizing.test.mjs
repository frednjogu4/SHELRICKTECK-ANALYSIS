import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { checkSniperMt5Size, sniperSizingGuidance } from '../../src/sniperengine.js';

const quote = { symbol: 'XAUUSD', bid: 2189.25, ask: 2190, contract_size: 100, volume_min: 0.01, volume_max: 100, volume_step: 0.01 };
test('$2 is notional, not target profit or margin; both directions reject without changing input', () => {
  for (const side of ['BUY', 'SELL']) {
    const input = { quote, side, usdSize: 2 };
    const before = JSON.stringify(input);
    const result = checkSniperMt5Size(input);
    assert.equal(result.ok, false);
    assert.equal(result.minLots, 0.01);
    assert.equal(result.minNotional, side === 'BUY' ? 2190 : 2189.25);
    assert.match(result.reason, /not required margin or the profit target/);
    assert.equal(JSON.stringify(input), before);
  }
});
test('broker-valid explicit lots are independent of USD target; use authoritative contract size', () => {
  const result = checkSniperMt5Size({ quote, side: 'BUY', usdSize: 2, lotSize: 0.01 });
  assert.equal(result.ok, true);
  assert.equal(result.lots, 0.01);
  assert.equal(result.notional, 2190);
  assert.equal(checkSniperMt5Size({ quote, side: 'BUY', usdSize: 2, lotSize: 0.001 }).ok, false);
  assert.equal(checkSniperMt5Size({ quote, side: 'BUY', usdSize: 2, lotSize: 101 }).ok, false);
});
test('valid USD size rounds down, never inflates to minimum', () => {
  const result = checkSniperMt5Size({ quote, side: 'SELL', usdSize: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.lots, 0.02);
  assert.ok(result.notional <= 5000);
  assert.equal(checkSniperMt5Size({ quote, side: 'SELL', usdSize: 2189.25 }).ok, true);
});
test('missing or invalid broker specs, price, direction or requested size fail closed', () => {
  for (const key of ['contract_size', 'volume_min', 'volume_step', 'ask']) {
    for (const value of [undefined, 0, -1, NaN, Infinity]) {
      assert.equal(checkSniperMt5Size({ quote: { ...quote, [key]: value }, side: 'BUY', usdSize: 5000 }).ok, false, `${key}=${value}`);
    }
  }
  assert.equal(checkSniperMt5Size({ quote: null, side: 'BUY', usdSize: 5000 }).ok, false);
  assert.equal(checkSniperMt5Size({ quote, side: 'HOLD', usdSize: 5000 }).ok, false);
  assert.equal(checkSniperMt5Size({ quote, side: 'BUY', usdSize: NaN }).ok, false);
});
test('sizing controls explain mode and disable irrelevant lot input without changing saved sizes', () => {
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const paint = main.slice(main.indexOf('function paintSniperSizingHelp()'), main.indexOf('\nfunction syncSniperUiControls()'));
  const els = { '#sniperSizingMode': { value: 'fixed_usd' }, '#sniperFixedUsd': { value: '2' }, '#sniperFixedLots': { value: '0.01' }, '#sniperSizingHelp': {} };
  const run = vm.runInNewContext('(' + paint + ')', { $: id => els[id], sniperExecConfig: {}, sniperSizingGuidance });
  run();
  assert.equal(els['#sniperFixedUsd'].disabled, false);
  assert.equal(els['#sniperFixedLots'].disabled, true);
  assert.match(els['#sniperSizingHelp'].textContent, /\$2.00 means NOTIONAL/);
  els['#sniperSizingMode'].value = 'fixed_lots';
  run();
  assert.equal(els['#sniperFixedUsd'].disabled, true);
  assert.equal(els['#sniperFixedLots'].disabled, false);
  assert.equal(els['#sniperFixedUsd'].value, '2');
  assert.equal(els['#sniperFixedLots'].value, '0.01');
  assert.match(els['#sniperSizingHelp'].textContent, /request 0.01 lots/);
  assert.match(sniperSizingGuidance('risk_pct', 2, 0.01), /not a maximum loss/);
});
