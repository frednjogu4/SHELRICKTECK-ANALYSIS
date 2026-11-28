import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createSniperRuntime, evaluatePositionProfitTarget, normalizeSniperConfig } from '../../src/sniperengine.js';
const main=readFileSync(new URL('../../src/main.js',import.meta.url),'utf8');
const watcher=main.slice(main.indexOf('async function runDynamicProfitTargetWatcher()'),main.indexOf('\nfunction initSniperAndProfitTargetEngine()'));
function fixture(){
  const position={ticket:101,symbol:'XAUUSD',side:'BUY',volume:0.01,price:100,profit:3.5,commission:-0.3,swap:-0.1,fee:0,net_profit:3.1,costs_verified:true};
  const calls=[],audits=[];
  const ident={broker:'mt5',authKey:'mt5:123:demo',connected:true,environment:'demo'};
  const ctx={profitTargetWatcherBusy:false,profitTargetCloseAttempts:new Set(),mt5ClosingTickets:new Set(),
    sniperExecConfig:normalizeSniperConfig({autoProfitCloseEnabled:true,authorizedKey:ident.authKey,netProfitTargetUsd:3}),
    sniperRuntime:createSniperRuntime(),getActiveBrokerIdentity:()=>({...ident}),isCloudflareReadonlyMode:()=>false,
    automationSnapshotCheck:()=>({ok:true}),refreshMt5Snapshot:async()=>true,evaluatePositionProfitTarget,
    state:{mt5LivePositions:[position],history:[],broker:{account:{net_target_close_supported:true}}},
    bridge:{closeBridgeOrder:async req=>{calls.push(req);return{type:'closed',ticket:101,environment:'demo',price:103};}},
    recordPlatformAudit:(...args)=>audits.push(args),save(){},toast(){},notify(){},$:()=>({textContent:''})};
  const run=vm.runInNewContext('('+watcher+')',ctx);
  return {ctx,position,calls,audits,ident,run};
}
test('auto-close uses a fresh complete snapshot, not cached profitable P&L',async()=>{
  const {ctx,position,calls,run}=fixture();
  ctx.refreshMt5Snapshot=async()=>{position.net_profit=2.9;return true;};
  await run();assert.equal(calls.length,0);
  position.net_profit=0;
  ctx.refreshMt5Snapshot=async()=>{position.net_profit=3.1;return true;};
  await run();assert.equal(calls.length,1);assert.equal(calls[0].netTargetUsd,3);
  assert.equal(ctx.state.history[0].pl,null,'trigger profit must not be reported as final realized P&L');
});
test('custom net override is applied per position; gross profit alone is not enough',async()=>{
  const {ctx,position,calls,run}=fixture();
  ctx.sniperExecConfig.perPositionTargets['mt5:101']=4.25;
  position.profit=5;position.net_profit=4.24;await run();assert.equal(calls.length,0);
  position.net_profit=4.25;await run();assert.equal(calls.length,1);assert.equal(calls[0].netTargetUsd,4.25);
});
test('auto-close is single-flight and never resends a confirmed ticket even if an old snapshot persists',async()=>{
  const {ctx,calls,run}=fixture();let resolve;
  ctx.bridge.closeBridgeOrder=async req=>{calls.push(req);return new Promise(r=>{resolve=r;});};
  const first=run();await new Promise(r=>setImmediate(r));
  await run();assert.equal(calls.length,1);
  resolve({type:'closed',ticket:101,environment:'demo',price:103});await first;await run();
  assert.equal(calls.length,1);assert.equal(ctx.profitTargetWatcherBusy,false);
});
test('failed snapshots, changed authorization, STOP ALL, disabled auto-close and older bridges cannot close',async()=>{
  for(const mode of ['snapshot','account','stop','off','oldbridge','stale','manual']){
    const {ctx,calls,ident,run}=fixture();
    ctx.refreshMt5Snapshot=async()=>{
      if(mode==='account')ident.authKey='mt5:456:real';
      if(mode==='stop')ctx.sniperExecConfig.emergencyHalted=true;
      if(mode==='off')ctx.sniperExecConfig.autoProfitCloseEnabled=false;
      return mode!=='snapshot';
    };
    if(mode==='oldbridge')ctx.state.broker.account.net_target_close_supported=false;
    if(mode==='stale')ctx.automationSnapshotCheck=()=>({ok:false});
    if(mode==='manual')ctx.mt5ClosingTickets.add(101);
    await run();assert.equal(calls.length,0,mode);assert.equal(ctx.profitTargetWatcherBusy,false);
  }
});
test('explicit broker no-send target skip continues monitoring; errors and unknown responses never retry',async()=>{
  for(const response of ['below','costs','error','unknown']){
    const {ctx,calls,run}=fixture();
    ctx.bridge.closeBridgeOrder=async req=>{calls.push(req);
      if(response==='error')throw new Error('bridge timeout: outcome uncertain');
      if(response==='unknown')return{type:'partial'};
      return{type:'close_skipped',ticket:101,reason:response==='below'?'NET_TARGET_NOT_REACHED':'NET_PROFIT_UNAVAILABLE'};
    };
    await run();await run();assert.equal(calls.length,response==='below'||response==='costs'?2:1,response);
    assert.equal(ctx.mt5ClosingTickets.size,0);assert.equal(ctx.sniperRuntime.closingLocks.size,0);
  }
});
test('unknown accrued costs or non-finite monetary fields cannot trigger a net target',()=>{
  for(const patch of [{costs_verified:false},{profit:Infinity},{commission:NaN},{net_profit:Infinity},{fee:'invalid'}]){
    assert.equal(evaluatePositionProfitTarget({profit:5,net_profit:5,...patch},normalizeSniperConfig({autoProfitCloseEnabled:true})).eligible,false);
  }
  assert.equal(normalizeSniperConfig({}).netTargetPrimary,false,'exit-policy change requires explicit opt-in');
  assert.equal(normalizeSniperConfig({netTargetPrimary:true}).netTargetPrimary,true);
  const first=normalizeSniperConfig({});first.perPositionTargets['mt5:999']=9;
  assert.equal(normalizeSniperConfig({}).perPositionTargets['mt5:999'],undefined,'position targets must not mutate defaults or another configuration');
});
test('close transport preserves target for terminal recheck; invalid targets never downgrade to an unconditional close',async()=>{
  const text=readFileSync(new URL('../../src/bridge.js',import.meta.url),'utf8');
  const fn=text.slice(text.indexOf('export function closeBridgeOrder('),text.indexOf('\nexport function bridgePositions(')).replace('export ','');
  const sent=[];
  const close=vm.runInNewContext('('+fn+')',{verifiedOrderEnvironment:()=>true,frame:o=>{sent.push(o);return o;}});
  close({ticket:101,environment:'demo',intentId:'targetIntent12345678',manualConfirmed:true,netTargetUsd:4.25});
  assert.equal(sent[0].net_target_usd,4.25);
  for(const netTargetUsd of [0,-1,NaN,Infinity,'bad'])await assert.rejects(close({ticket:101,environment:'demo',intentId:'i',manualConfirmed:true,netTargetUsd}),/Invalid net-profit/);
  assert.equal(sent.length,1);
});

test('net-target-first control is opt-in and a custom target edit does not silently enable automatic closing',()=>{
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  assert.match(html,/id="sniperNetTargetPrimary"/);
  assert.doesNotMatch(html,/id="sniperNetTargetPrimary"[^>]*\bchecked\b/);
  const a=main.indexOf("  $('#netProfitTargetInput')?.addEventListener('change'");
  const b=main.indexOf("  $('#sniperSaveRulesBtn')",a);
  const handler=main.slice(a,b);
  assert.match(handler,/SET_CUSTOM/);
  assert.match(handler,/runDynamicProfitTargetWatcher/);
  assert.doesNotMatch(handler,/autoProfitCloseEnabled\s*=\s*true/);
});
