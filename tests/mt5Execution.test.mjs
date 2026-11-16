import test from 'node:test';
import assert from 'node:assert/strict';
import { placeBridgeOrder, closeBridgeOrder } from '../src/bridge.js';

test('client refuses Exness order sends unless MT5 verifies a demo account', async () => {
  await assert.rejects(
    placeBridgeOrder({ symbol: 'US30', side: 'BUY', volume: 1, manualConfirmed: true, previewId: 'preview', intentId: 'demoIntent1234567890' }),
    /demo-only.*MT5 has not verified a demo account.*No order was sent/,
  );
});

test('app-side Exness closes remain disabled even in demo mode', async () => {
  await assert.rejects(closeBridgeOrder(123), /not enabled in the app/);
});
