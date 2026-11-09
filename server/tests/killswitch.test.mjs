import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AURUM_DIAG_KEY = 'diag-test-key';
const { isTradingKilled, setTradingKilled, requireTrading } = await import('../lib/killswitch.js');

const mockRes = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } });

test('kill switch: disable always allowed; requireTrading returns 503 while on; closes are not routed through it', () => {
  assert.equal(isTradingKilled(), false);
  const off = setTradingKilled(true);
  assert.equal(off.ok, true);
  assert.equal(isTradingKilled(), true);
  const res = mockRes();
  let nexted = false;
  requireTrading({}, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'kill_switch');
});

test('kill switch: RE-ENABLING requires the diagnostics key when configured', () => {
  const bad = setTradingKilled(false, 'wrong-key');
  assert.equal(bad.ok, false);
  assert.equal(isTradingKilled(), true);
  const good = setTradingKilled(false, 'diag-test-key');
  assert.equal(good.ok, true);
  assert.equal(isTradingKilled(), false);
  const res = mockRes();
  let nexted = false;
  requireTrading({}, res, () => { nexted = true; });
  assert.equal(nexted, true);
});
