import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicCandles, DERIV_PUBLIC_URL } from '../../src/marketdata.js';

function fakeSocketFactory(responder) {
  return class FakeWebSocket {
    static latest = null;
    constructor(url) {
      this.url = url;
      this.closed = false;
      FakeWebSocket.latest = this;
      queueMicrotask(() => this.onopen?.({}));
    }
    send(raw) { responder(this, JSON.parse(raw)); }
    close() { this.closed = true; }
  };
}

test('standalone public candle client requests mapped XAU/USD history and normalizes real candle fields', async () => {
  const Fake = fakeSocketFactory((ws, req) => queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({
    msg_type: 'candles', req_id: req.req_id,
    candles: [
      { epoch: 1793600000, open: '3900.10', high: '3902.00', low: '3898.50', close: '3901.20' },
      { epoch: 1793600060, open: '3901.20', high: '3904.00', low: '3900.00', close: '3903.50' }
    ]
  }) })));
  const candles = await fetchPublicCandles('XAU/USD', 60, 120, { WebSocketImpl: Fake, timeoutMs: 100 });
  assert.equal(Fake.latest.url, DERIV_PUBLIC_URL);
  assert.equal(Fake.latest.closed, true);
  assert.equal(candles.length, 2);
  assert.deepEqual(candles[0], { time: 1793600000, open: 3900.1, high: 3902, low: 3898.5, close: 3901.2, volume: 0 });
});

test('standalone candle client refuses unmapped symbols and malformed request sizes', async () => {
  await assert.rejects(fetchPublicCandles('NEW/PAIR', 60, 120, { WebSocketImpl: class {} }), /No verified Deriv candle mapping/);
  await assert.rejects(fetchPublicCandles('XAU/USD', 30, 120, { WebSocketImpl: class {} }), /Invalid Deriv candle request/);
});

test('standalone candle client surfaces Deriv errors and times out honestly', async () => {
  const Failing = fakeSocketFactory((ws, req) => queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({
    msg_type: 'error', req_id: req.req_id, echo_req: req, error: { code: 'MarketIsClosed', message: 'market unavailable' }
  }) })));
  await assert.rejects(fetchPublicCandles('XAU/USD', 60, 120, { WebSocketImpl: Failing, timeoutMs: 100 }), /market unavailable/);
  class SilentSocket {
    static latest = null;
    constructor() { SilentSocket.latest = this; queueMicrotask(() => this.onopen?.({})); }
    send() {}
    close() { this.closed = true; }
  }
  await assert.rejects(fetchPublicCandles('XAU/USD', 60, 120, { WebSocketImpl: SilentSocket, timeoutMs: 5 }), /Timed out/);
  assert.equal(SilentSocket.latest.closed, true);
});
