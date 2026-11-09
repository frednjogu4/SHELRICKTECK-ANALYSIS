import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCandleFetcher, fetchActiveSymbols } from '../lib/derivfeed.js';

test('Deriv active-symbol response is normalized from documented fields and rejects malformed codes',async()=>{
  const rows=await fetchActiveSymbols({force:true,requestImpl:async(req)=>{
    assert.deepEqual(req,{active_symbols:'brief',req_id:1});
    return {active_symbols:[
      {underlying_symbol:'frxEURUSD',underlying_symbol_name:'EUR/USD',market:'forex',submarket:'major_pairs',subgroup:'major_pairs',underlying_symbol_type:'forex',pip_size:0.0001,exchange_is_open:1,is_trading_suspended:0},
      {underlying_symbol:'BAD CODE',underlying_symbol_name:'invalid',market:'forex'},
    ]};
  }});
  assert.equal(rows.length,1);
  assert.deepEqual(rows[0],{code:'frxEURUSD',name:'EUR/USD',market:'forex',submarket:'major_pairs',subgroup:'major_pairs',symbolType:'forex',pipSize:0.0001,open:true,suspended:false});
});

test('dynamic candle fetcher accepts validated Deriv codes and returns real provider bars without a static symbol map',async()=>{
  const seen=[];
  const fetcher=createCandleFetcher({requestImpl:async(req)=>{
    seen.push(req);
    return [{epoch:1700000000,open:'1',high:'2',low:'0.5',close:'1.5'}];
  },ttlOverrideMs:1});
  const rows=await fetcher.fetchCandlesByCode('R_100',300,100,0);
  assert.equal(rows.length,1);
  assert.equal(rows[0].close,1.5);
  assert.equal(seen[0].ticks_history,'R_100');
  await assert.rejects(()=>fetcher.fetchCandlesByCode('not valid',300,100,0),/invalid Deriv market code/);
});
