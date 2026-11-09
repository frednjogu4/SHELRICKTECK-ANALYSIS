import test from 'node:test';
import assert from 'node:assert/strict';
import { placeBridgeOrder, closeBridgeOrder } from '../src/bridge.js';

test('Phase 1 client refuses Exness MT5 order sends before bridge transport', async () => {
  await assert.rejects(
    placeBridgeOrder({ symbol: 'US30', side: 'BUY', volume: 1 }),
    /disabled in this local verification build.*No order was sent/,
  );
});

test('Phase 1 client refuses Exness MT5 closes before bridge transport', async () => {
  await assert.rejects(
    closeBridgeOrder(123),
    /disabled in this local verification build.*No close was sent/,
  );
});
