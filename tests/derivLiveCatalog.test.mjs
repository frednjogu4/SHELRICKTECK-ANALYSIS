import test from 'node:test';
import assert from 'node:assert/strict';

class FakeWebSocket {
  static instances=[];
  constructor(url){this.url=url;this.readyState=0;this.sent=[];FakeWebSocket.instances.push(this);}
  send(value){this.sent.push(JSON.parse(value));}
  close(){this.readyState=3;}
  open(){this.readyState=1;this.onopen?.();}
  message(value){this.onmessage?.({data:JSON.stringify(value)});}
}

test('Cloudflare selected Deriv market streams one code and unsubscribes without built-in universe feeds', async()=>{
  const original=globalThis.WebSocket;
  globalThis.WebSocket=FakeWebSocket;
  try{
    const feed=await import('../src/marketdata.js?selected-catalog-test');
    feed.setDefaultSubscriptionsEnabled(false);
    const received=[];
    const unsubscribe=feed.subscribeDerivCode('frxEURUSD',(quote)=>received.push(quote));
    const socket=FakeWebSocket.instances.at(-1);
    socket.open();

    assert.equal(socket.sent.length,1,'no default watchlist subscriptions should be sent');
    assert.equal(socket.sent[0].ticks_history,'frxEURUSD');
    assert.equal(socket.sent[0].subscribe,1);

    socket.message({msg_type:'tick',tick:{symbol:'frxEURUSD',quote:1.075,epoch:1900000000},subscription:{id:'selected-sub'}});
    assert.equal(received.length,1);
    assert.equal(received[0].quote,1.075);
    assert.equal(received[0].status,'live');

    unsubscribe();
    assert.ok(socket.sent.some((message)=>message.forget==='selected-sub'));
    feed.stopFeed();
  }finally{
    globalThis.WebSocket=original;
  }
});

test('Deriv catalogue subscription rejects malformed codes', async()=>{
  const feed=await import('../src/marketdata.js?selected-catalog-validation');
  assert.throws(()=>feed.subscribeDerivCode('invalid/code',()=>{}),/Invalid Deriv market code/);
});

test('default Deriv instrument subscriptions deliver dashboard prices and only report live after a valid tick', async()=>{
  const original=globalThis.WebSocket;
  globalThis.WebSocket=FakeWebSocket;
  try{
    const feed=await import('../src/marketdata.js?default-dashboard-feed-test');
    feed.setDefaultSubscriptionsEnabled(true);
    const received=[];
    const statuses=[];
    feed.onTick((symbol,quote)=>received.push({symbol,quote}));
    feed.onStatus((status)=>statuses.push(status));
    feed.startFeed();
    const socket=FakeWebSocket.instances.at(-1);
    socket.open();

    assert.ok(socket.sent.some((message)=>message.ticks_history==='frxEURUSD'&&message.subscribe===1),
      'the dashboard forex universe should be subscribed');
    assert.equal(feed.feedStatus(),'connecting','socket open alone must not be reported as live');
    socket.message({msg_type:'tick',tick:{symbol:'frxEURUSD',quote:1.075,epoch:1900000000}});
    assert.equal(received.length,1);
    assert.equal(received[0].symbol,'EUR/USD');
    assert.equal(received[0].quote.px,1.075);
    assert.equal(feed.feedStatus(),'live');
    assert.ok(feed.lastTickAt()>0);
    assert.ok(statuses.includes('live'));

    socket.message({msg_type:'tick',tick:{symbol:'frxEURUSD',quote:'not-a-price',epoch:1900000001}});
    assert.equal(received.length,1,'invalid quotes must not overwrite the last valid dashboard price');
    feed.stopFeed();
  }finally{
    globalThis.WebSocket=original;
  }
});
