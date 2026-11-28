import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { inspectMt5Quote } from '../../src/mt5sizing.js';
const now=1800000000000;
const q={symbol:'XAUUSDm',requested_symbol:'XAUUSD',bid:1424,ask:1425,time:now/1000};
const response=(quote=q)=>({quotes:[quote],server_time_ms:now});
test('fresh quotes use bridge UTC even when browser clock is far ahead or behind',()=>{
  for(const offset of [-86400000,0,86400000]){
    assert.equal(inspectMt5Quote(response(),{symbol:'XAU/USD',nowMs:now+offset,roundTripMs:100}).ok,true);
  }
});
test('millisecond tick timestamps normalize to seconds; original tick time is not replaced by receipt time',()=>{
  for(const quote of [{...q,time:now},{...q,time:now/1000-10,time_msc:now-1000}]){
    const checked=inspectMt5Quote(response(quote),{symbol:'XAU/USD',nowMs:now});
    assert.equal(checked.ok,true);
    assert.equal(checked.quote.time,quote.time_msc?(now-1000)/1000:now/1000);
  }
});
test('older bridge spec_at metadata fixes browser skew but never makes an old tick fresh',()=>{
  assert.equal(inspectMt5Quote({quotes:[{...q,spec_at:now/1000}]},{nowMs:now+3600000}).ok,true);
  assert.equal(inspectMt5Quote({quotes:[{...q,time:now/1000-120,spec_at:now/1000}]},{nowMs:now-3600000}).code,'STALE_QUOTE');
});
test('stale and future ticks remain blocked with actionable diagnostics',()=>{
  const stale=inspectMt5Quote(response({...q,time:now/1000-3600}),{nowMs:now});
  assert.equal(stale.code,'STALE_QUOTE');assert.equal(stale.retryable,false);
  assert.match(stale.reason,/3600s old/);assert.match(stale.reason,/Market may be closed/);
  const future=inspectMt5Quote(response({...q,time:now/1000+6}),{nowMs:now});
  assert.equal(future.code,'FUTURE_TICK');assert.match(future.reason,/Synchronize Windows/);
});
test('slow transport cannot deliver a tick past the unchanged 60s freshness limit',()=>{
  assert.equal(inspectMt5Quote(response({...q,time:now/1000-59}),{roundTripMs:2000}).code,'STALE_QUOTE');
  assert.equal(inspectMt5Quote(response({...q,time:now/1000-59}),{roundTripMs:500}).ok,true);
  assert.equal(inspectMt5Quote(response(),{roundTripMs:-1}).ok,false);
});
test('missing prices/timestamps, crossed quotes, mismatched symbols and invalid server clocks fail closed',()=>{
  for(const quote of [{...q,bid:0},{...q,ask:NaN},{...q,bid:2000},{...q,time:0},{...q,time:undefined},{...q,requested_symbol:'BTCUSD'}]){
    assert.equal(inspectMt5Quote(response(quote),{symbol:'XAU/USD'}).ok,false);
  }
  assert.equal(inspectMt5Quote({...response(),server_time_ms:0}).ok,false);
  assert.equal(inspectMt5Quote({quotes:[q,q]}).ok,false);
});
test('symbol-resolution errors retain broker guidance and absent first tick is explicitly retryable',()=>{
  const unavailable=inspectMt5Quote({quotes:[],unresolved:[{message:'Matches multiple broker symbols. Use exact name.'}]});
  assert.equal(unavailable.code,'SYMBOL_UNAVAILABLE');assert.match(unavailable.reason,/Use exact name/);assert.equal(unavailable.retryable,false);
  const pending=inspectMt5Quote({quotes:[],unresolved:[{resolved:'XAUUSDm',message:'No tick'}]});
  assert.equal(pending.code,'NO_TICK');assert.equal(pending.retryable,true);
});
const main=readFileSync(new URL('../../src/main.js',import.meta.url),'utf8');
const source=main.slice(main.indexOf('async function freshManualMt5Quote(sym)'),main.indexOf('\nasync function reviewManualMt5Minimum()'));
function helper(results){
  let count=0;
  const ctx={bridge:{quoteBridge:async()=>{const r=results[Math.min(count++,results.length-1)];if(r instanceof Error)throw r;return r;}},
    inspectMt5Quote,performance:{now:()=>0},Date:class extends Date{static now(){return now;}},setTimeout:fn=>fn()};
  return {run:vm.runInNewContext('('+source+')',ctx),count:()=>count};
}
test('actual manual helper makes at most one read-only first-tick retry, with no order submission path',async()=>{
  const f=helper([{quotes:[],unresolved:[{resolved:'XAUUSDm'}]},response()]);
  const quote=await f.run('XAU/USD');assert.equal(quote.symbol,'XAUUSDm');assert.equal(f.count(),2);
  const empty=helper([{quotes:[]}]);await assert.rejects(empty.run('XAU/USD'),/Market Watch/);assert.equal(empty.count(),2);
  assert.doesNotMatch(source,/placeBridgeOrder|placeBridgePendingOrder|closeBridgeOrder/);
});
test('actual manual helper does not loop on closed-market stale ticks or retry transport failures',async()=>{
  const stale=helper([response({...q,time:now/1000-3600})]);await assert.rejects(stale.run('XAU/USD'),/3600s old/);assert.equal(stale.count(),1);
  const failed=helper([new Error('bridge disconnected')]);await assert.rejects(failed.run('XAU/USD'),/disconnected/);assert.equal(failed.count(),1);
});
