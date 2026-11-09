import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';

const markets = [
  { code: 'frxEURUSD', name: 'EUR/USD', market: 'forex', submarket: 'major_pairs', subgroup: 'major_pairs', symbolType: 'forex', pipSize: 0.0001, open: true, suspended: false },
  { code: 'R_100', name: 'Volatility 100 Index', market: 'synthetic_index', submarket: 'random_index', subgroup: 'synthetics', symbolType: 'stockindex', pipSize: 0.01, open: true, suspended: false },
];
const candles = (n=60) => Array.from({ length:n }, (_,i)=>({ time: 1700000000+i*60, open: 1+i/10000, high: 1.002+i/10000, low: 0.999+i/10000, close: 1.001+i/10000, volume: 0 }));
let server, base, tmp, calls=[];
before(async () => {
  tmp=mkdtempSync(join(tmpdir(),'aurum-market-catalog-'));
  const feed={
    symbols:{},
    fetchCandles:async()=>candles(),
    fetchActiveSymbols:async()=>markets,
    fetchCandlesByCode:async(code,gran,count)=>{calls.push({kind:'candles',code,gran,count});return candles(count);},
    fetchTickByCode:async(code)=>{calls.push({kind:'tick',code});return {code,quote:1.2345,epoch:1700000000};},
  };
  const app=createApp({store:createStore(join(tmp,'store.json')),config:configFromEnv({}),feed});
  server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
  base=`http://127.0.0.1:${server.address().port}`;
});
after(()=>{server?.close();tmp&&rmSync(tmp,{recursive:true,force:true});});

const post=(url,body)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

test('broker catalogue returns only the injected Deriv active-symbol data and source label',async()=>{
  const r=await fetch(base+'/api/markets/deriv');
  assert.equal(r.status,200);
  const j=await r.json();
  assert.equal(j.source,'Deriv public active_symbols');
  assert.equal(j.markets.length,2);
  assert.equal(j.markets[1].code,'R_100');
});

test('dynamic Deriv candle route permits only active symbols and allowed timeframes',async()=>{
  const r=await post('/api/markets/deriv/candles',{code:'R_100',granularity:300,count:80});
  assert.equal(r.status,200);
  const j=await r.json();
  assert.equal(j.candles.length,80);
  assert.equal(j.source,'Deriv public candles');
  assert.deepEqual(calls.find(x=>x.kind==='candles'),{kind:'candles',code:'R_100',gran:300,count:80});
  assert.equal((await post('/api/markets/deriv/candles',{code:'NOT_ACTIVE',granularity:300})).status,404);
  assert.equal((await post('/api/markets/deriv/candles',{code:'R_100',granularity:15})).status,400);
});

test('dynamic Deriv tick route checks active-symbol membership before requesting a quote',async()=>{
  const r=await post('/api/markets/deriv/tick',{code:'frxEURUSD'});
  assert.equal(r.status,200);
  const j=await r.json();
  assert.equal(j.quote,1.2345);
  assert.equal(j.source,'Deriv public tick');
  assert.equal((await post('/api/markets/deriv/tick',{code:'NOT_ACTIVE'})).status,404);
});
