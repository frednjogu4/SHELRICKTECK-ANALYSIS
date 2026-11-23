import test from 'node:test';
import assert from 'node:assert/strict';
import { placeBridgeOrder, previewBridgeOrder, closeBridgeOrder } from '../src/bridge.js';

test('client refuses Exness orders unless the connected MT5 account mode matches the explicit request', async () => {
  await assert.rejects(
    previewBridgeOrder({ environment: 'real', symbol: 'US30', side: 'BUY', volume: 1, sl: 99, tp: 101 }),
    /MT5 account mode does not match the explicitly selected REAL or DEMO preview.*no order was sent/i,
  );
  await assert.rejects(
    placeBridgeOrder({ environment: 'demo', symbol: 'US30', side: 'BUY', volume: 1, manualConfirmed: true, previewId: 'preview', intentId: 'demoIntent1234567890' }),
    /MT5 account mode does not match the explicitly selected REAL or DEMO order.*no order was sent/i,
  );
});

test('app-side Exness closes remain disabled in both account modes', async () => {
  await assert.rejects(closeBridgeOrder(123), /App-side Exness position closing is disabled/);
});
