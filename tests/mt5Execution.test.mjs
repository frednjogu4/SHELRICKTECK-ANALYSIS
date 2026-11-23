import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../src/bridge.js';

test('the Exness browser client exposes read-only data methods but no order or close methods', () => {
  for (const name of ['previewBridgeOrder', 'placeBridgeOrder', 'closeBridgeOrder']) {
    assert.equal(Object.hasOwn(bridge, name), false, `${name} must not be exported in the read-only release`);
  }
  for (const name of ['bridgePositions', 'bridgeAccount', 'bridgeSymbols', 'bridgeHistory']) {
    assert.equal(typeof bridge[name], 'function', `${name} remains available for read-only data`);
  }
});
