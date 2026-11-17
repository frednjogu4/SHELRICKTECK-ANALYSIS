import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProScalper, attachDerivTickVolume, backtestProScalper, deriveProScalperTimeframe, parabolicSar } from '../lib/proscalper.js';

function bars({count=260, tf=60, now=Date.now(), slope=0.12, volume=100}={}) {
  const end=Math.floor(now/1000/tf)*tf-tf;
  return Array.from({length:count},(_,i)=>{
    const close=200+i*slope+Math.sin(i/3)*0.2;
    return {time:end-(count-i-1)*tf,open:close-0.04,high:close+0.25,low:close-0.25,close,volume:volume+(i%7)*4};
  });
}
const confirms={'5m':{signal:'BUY',valid:true},'15m':{signal:'BUY',valid:true}};

test('Pro Scalper emits evidence and strictly analytical output on validated inputs',()=>{
  const now=Date.now(), candles=bars({now});
  const result=analyzeProScalper({symbol:'TEST',timeframe:'1m',candles,confirmations:confirms,now});
  assert.equal(result.execution,'disabled');
  assert.ok(['BUY','SELL','WAIT'].includes(result.signal));
  assert.equal(result.indicators.ema200>0,true);
  assert.equal(result.indicators.adx.adx>=0,true);
  assert.ok(result.forecast && Math.abs(result.forecast.up+result.forecast.down+result.forecast.sideways-1)<1e-10);
  assert.match(result.forecast.method,/not statistically calibrated/);
  assert.ok(result.support.length && result.resistance.length);
});

test('short histories report the received closed-bar count instead of implying a reading',()=>{
  const now=Date.now(),result=analyzeProScalper({symbol:'T',timeframe:'1m',candles:bars({count:219,now}),now});
  assert.equal(result.signal,'WAIT');
  assert.match(result.rejectionReasons[0],/Need at least 220 closed candles for EMA 200; received 219/);
  assert.equal(result.forecast,null);
});

test('missing volume, malformed OHLC, stale and forming candles fail closed',()=>{
  const now=Date.now();
  let c=bars({now}); c[10]={...c[10],volume:null};
  assert.equal(analyzeProScalper({symbol:'T',candles:c,confirmations:confirms,now}).signal,'WAIT');
  c=bars({now});c[42]={...c[42],low:c[42].high+1};
  assert.match(analyzeProScalper({symbol:'T',candles:c,confirmations:confirms,now}).rejectionReasons[0],/Invalid or contradictory/);
  c=bars({now:now-1_000_000});
  assert.match(analyzeProScalper({symbol:'T',candles:c,confirmations:confirms,now}).rejectionReasons.join(' '),/stale/);
  c=bars({now}); c[c.length-1].time=Math.floor(now/1000/60)*60;
  assert.match(analyzeProScalper({symbol:'T',candles:c,confirmations:confirms,now}).rejectionReasons.join(' '),/still forming/);
});

test('contradictory higher timeframe evidence withholds signal and forecast',()=>{
  const now=Date.now(),c=bars({now});
  const result=analyzeProScalper({symbol:'T',candles:c,confirmations:{'5m':{signal:'BUY',valid:true},'15m':{signal:'SELL',valid:true}},now});
  assert.equal(result.signal,'WAIT');
  assert.equal(result.forecast,null);
  assert.ok(result.rejectionReasons.some(x=>/contradict/.test(x)));
});

test('heuristic scenario forecast is labelled while missing confirmations keep the signal at WAIT',()=>{
  const now=Date.now(),candles=bars({now,slope:-0.08});
  const result=analyzeProScalper({symbol:'T',candles,confirmations:{'5m':{signal:'SELL'},'15m':{signal:'SELL'}},now});
  assert.equal(result.signal,'WAIT');
  assert.ok(result.rejectionReasons.some(x=>/Two valid higher-timeframe confirmations/.test(x)));
  assert.equal(result.forecast.scope,'primary-timeframe scenarios; directional signal still requires multi-timeframe confirmation');
  assert.match(result.forecast.method,/not statistically calibrated/);
});

test('Deriv tick counts are labelled proxies and require complete coverage of the last 21 closed bars',()=>{
  const now=Date.now(),candles=bars({now}), recent=candles.slice(-21);
  const ticks=[{time:recent[0].time,price:recent[0].close},...recent.map(c=>({time:c.time+5,price:c.close}))];
  const full=attachDerivTickVolume(candles,ticks,'1m');
  assert.equal(full.valid,true);
  assert.equal(full.source,'Deriv tick-count proxy');
  assert.equal(full.candles.at(-1).volume,1);
  assert.equal(full.candles.at(-1).volumeSource,'Deriv tick-count proxy');
  const reading=analyzeProScalper({symbol:'T',timeframe:'1m',candles:full.candles,confirmations:confirms,now});
  assert.equal(reading.indicators.volume.source,'Deriv tick-count proxy');
  assert.ok(!reading.rejectionReasons.some(x=>/volume/i.test(x)));
  const partial=attachDerivTickVolume(candles,ticks.slice(1),'1m');
  assert.equal(partial.valid,false);
  assert.match(partial.reason,/does not cover the latest 21/);
  const withheld=analyzeProScalper({symbol:'T',timeframe:'1m',candles:partial.candles,confirmations:confirms,now});
  assert.equal(withheld.signal,'WAIT');
  assert.equal(withheld.indicators.volume.source,'unavailable');
  assert.ok(withheld.rejectionReasons.some(x=>/does not cover the latest 21/.test(x)));
  const invalid=attachDerivTickVolume(candles,[],'1m','tick-history request failed');
  assert.equal(invalid.valid,false);
  assert.match(invalid.reason,/request failed/);
});

test('timeframe derivation and PSAR are deterministic and reject invalid input',()=>{
  const now=Date.now(),c=bars({now});
  assert.ok(['BUY','SELL','WAIT'].includes(deriveProScalperTimeframe(c,'1m',now).signal));
  assert.equal(deriveProScalperTimeframe(c.slice(0,80),'1m',now).valid,false);
  assert.equal(parabolicSar(c),parabolicSar(c));
  assert.equal(parabolicSar([]),null);
});

test('walk-forward replay is isolated and reports no execution',()=>{
  const now=Date.now(), primary=bars({count:300,now}), high5=bars({count:300,tf:300,now}), high15=bars({count:300,tf:900,now});
  const replay=backtestProScalper({symbol:'T',timeframe:'1m',candles:primary,higherCandles:{'5m':high5,'15m':high15}});
  assert.equal(replay.execution,'disabled');
  assert.equal(replay.signals,replay.trades.length);
  assert.match(replay.disclaimer,/not a prediction/);
  assert.throws(()=>backtestProScalper({candles:primary.slice(0,100)}),/Need at least/);
});
