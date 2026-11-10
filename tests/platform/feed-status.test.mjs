/* Status reporting of the browser price engine (src/marketdata.js).
 *
 * The socket is a stand-in that the test opens and feeds by hand, and time is
 * the test runner's mock clock, so nothing here touches the network. The
 * quote values are placeholders: these tests check status transitions only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen && this.onopen(); }
  message(payload) { this.onmessage && this.onmessage({ data: JSON.stringify(payload) }); }
}

async function startFeed(t, tag) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const feed = await import('../../src/marketdata.js?' + tag);
  const statuses = [];
  feed.onStatus((status, detail) => statuses.push([status, detail]));
  feed.startFeed();
  const socket = FakeSocket.instances.at(-1);
  t.after(() => { feed.stopFeed(); globalThis.WebSocket = original; });
  return { feed, socket, statuses };
}

test('an open socket that never delivers a price leaves "connecting" after 30 seconds', async (t) => {
  const { feed, socket, statuses } = await startFeed(t, 'feed-status-silent');
  socket.open();
  assert.equal(feed.feedStatus(), 'connecting', 'an open socket alone is not live');

  t.mock.timers.tick(20000);
  socket.message({ msg_type: 'history', history: { prices: [], times: [] } }); /* traffic, but no tick */
  assert.equal(feed.feedStatus(), 'connecting');

  t.mock.timers.tick(15000);
  assert.equal(feed.feedStatus(), 'stale');
  assert.match(String(statuses.at(-1)[1]), /no valid tick has arrived since the connection opened/);
  assert.equal(feed.lastTickAt(), 0, 'no tick is claimed');
});

test('the first valid tick moves a waiting feed to live, and 30 quiet seconds move it back to stale', async (t) => {
  const { feed, socket } = await startFeed(t, 'feed-status-recover');
  socket.open();
  t.mock.timers.tick(20000);
  socket.message({ msg_type: 'history', history: { prices: [], times: [] } });
  t.mock.timers.tick(15000);
  assert.equal(feed.feedStatus(), 'stale');

  socket.message({ msg_type: 'tick', tick: { symbol: 'frxEURUSD', quote: 1.5, epoch: 1900000000 } });
  assert.equal(feed.feedStatus(), 'live');

  t.mock.timers.tick(20000);
  socket.message({ msg_type: 'history', history: { prices: [], times: [] } });
  assert.equal(feed.feedStatus(), 'live', 'still inside the 30 second window');
  t.mock.timers.tick(15000);
  assert.equal(feed.feedStatus(), 'stale');
});

test('a quote that is not a positive number never makes the feed live', async (t) => {
  const { feed, socket } = await startFeed(t, 'feed-status-invalid');
  socket.open();
  for (const quote of ['not-a-price', 0, -1, null]) {
    socket.message({ msg_type: 'tick', tick: { symbol: 'frxEURUSD', quote, epoch: 1900000000 } });
  }
  assert.equal(feed.feedStatus(), 'connecting');
  assert.equal(feed.lastTickAt(), 0);
  assert.equal(feed.quote('EUR/USD'), null, 'no price is stored for an invalid quote');
});
