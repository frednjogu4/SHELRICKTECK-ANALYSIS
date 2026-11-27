import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { checkMt5OrderSize } from '../../src/mt5sizing.js';
const main=readFileSync(new URL('../../src/main.js',import.meta.url),'utf8');
const review=main.slice(main.indexOf('async function reviewManualMt5Minimum()'),main.indexOf('\nfunction renderManualMt5SizingHelp()'));
const manual=main.slice(main.indexOf('async function placeMt5ManualOrder('),main.indexOf('\nasync function executeDerivDirect('));
const live={symbol:'XAUUSDm',bid:1424.26,ask:1424.26,time:Date.now()/1000,contract_size:100,volume_min:0.01,volume_max:100,volume_step:0.01};
function setup(){
  const els=Object.fromEntries(['orderLots','orderAmount','orderEntryPrice','orderSL','orderTP','orderTypeSelect','strictMinLotChk','reviewMt5MinSizeBtn','placeOrderBtn'].map(id=>['#'+id,{value:'',disabled:false,checked:true}]));
  els['#orderAmount'].value='1';els['#orderTypeSelect'].value='MARKET';
  const ident={broker:'mt5',connected:true,authKey:'demo:123',accountId:'123',environment:'demo'};
  const sent=[],toasts=[],confirms=[];
  const ctx={$:id=>els[id],getActiveBrokerIdentity:()=>ident,
    state:{chart:{sym:'XAU/USD'},side:'BUY',broker:{type:'mt5',account:{environment:'demo',demo:true}},settings:{oneClick:true}},
    freshManualMt5Quote:async()=>({...live}),checkMt5OrderSize,
    askConfirm:async(...args)=>{confirms.push(args);return true;},toast:(...args)=>toasts.push(args),
    save(){},syncOneClickUI(){},renderSizePlan(){},refreshTicketSupervisorBanner(){},
    isCloudflareReadonlyMode:()=>false,
    bridge:{placeBridgeOrder:async o=>{sent.push(o);return{type:'filled',demo:true,environment:'demo',lots:o.lots,ticket:1,price:1424.26};},
      placeBridgePendingOrder:async o=>{sent.push(o);return{type:'pending_placed',ticket:2,lots:o.lots};}},
    notify(){},refreshMt5Snapshot:async()=>true,fmtPx:String,fmtMoney:String,fmtAcctMoney:String,
  };
  return {ctx,els,sent,toasts,confirms,ident};
}
test('minimum-lot selection shows exposure and requires explicit consent; it sends no order and disables 1-click',async()=>{
  const {ctx,els,sent,confirms}=setup();
  await vm.runInNewContext('('+review+')',ctx)();
  assert.equal(confirms.length,1);
  assert.match(confirms[0][1],/1424.26 notional/);
  assert.match(confirms[0][1],/NOT required margin, maximum loss/);
  assert.equal(els['#orderLots'].value,'0.01');
  assert.equal(els['#orderAmount'].value,'1','never rewrite the dollar budget');
  assert.equal(ctx.state.settings.oneClick,false);
  assert.equal(sent.length,0);
});
test('cancel, changed symbol/account or stale/missing quote never apply a minimum',async()=>{
  for(const action of ['cancel','symbol','account','quote']){
    const {ctx,els,sent,ident}=setup();
    if(action==='quote')ctx.freshManualMt5Quote=async()=>{throw new Error('Stale quote');};
    ctx.askConfirm=async()=>{if(action==='symbol')ctx.state.chart.sym='EUR/USD';if(action==='account')ident.authKey='real:456';return action!=='cancel';};
    await vm.runInNewContext('('+review+')',ctx)();
    assert.equal(els['#orderLots'].value,'',action);
    assert.equal(ctx.state.settings.oneClick,true);
    assert.equal(sent.length,0);
    assert.equal(els['#reviewMt5MinSizeBtn'].disabled,false);
  }
});
test('manual market and pending orders reject $1 notional locally, without any send or size increase',async()=>{
  for(const kind of ['MARKET','BUY_LIMIT','SELL_LIMIT','BUY_STOP','SELL_STOP']){
    const {ctx,els,sent,toasts}=setup();
    els['#orderTypeSelect'].value=kind;els['#orderEntryPrice'].value='1424';
    const fn=vm.runInNewContext('('+manual+')',ctx);
    await fn({I:{s:'XAU/USD'},amt:1,sl:0,tp:0});
    assert.equal(sent.length,0,kind);
    assert.equal(els['#orderAmount'].value,'1');
    assert.equal(els['#orderLots'].value,'');
    assert.match(toasts[0][1],/Review broker minimum lots/);
    assert.equal(els['#placeOrderBtn'].disabled,false);
  }
});
test('explicit broker-valid lots override USD for a user-initiated direct market order, without modifying lots',async()=>{
  const {ctx,els,sent}=setup();els['#orderLots'].value='0.01';
  await vm.runInNewContext('('+manual+')',ctx)({I:{s:'XAU/USD'},amt:1,sl:0,tp:0});
  assert.equal(sent.length,1);
  assert.equal(sent[0].lots,0.01);
  assert.equal(sent[0].volume,1);
});
test('manual sizing is single-flight; a ticket changed while fetching specs cannot dispatch',async()=>{
  const {ctx,els,sent}=setup();els['#orderLots'].value='0.01';
  let resolve;ctx.freshManualMt5Quote=()=>new Promise(r=>{resolve=r;});
  const fn=vm.runInNewContext('('+manual+')',ctx);
  const first=fn({I:{s:'XAU/USD'},amt:1,sl:0,tp:0});
  await fn({I:{s:'XAU/USD'},amt:1,sl:0,tp:0});
  els['#orderLots'].value='1';resolve({...live});await first;
  assert.equal(sent.length,0);
});
test('actual preview request and send carry the same explicit lots and minimum guard',async()=>{
  const {ctx,els,sent}=setup();els['#orderLots'].value='0.01';ctx.state.settings.oneClick=false;
  const previews=[];
  ctx.bridge.previewBridgeOrder=async o=>{previews.push(o);return{environment:'demo',demo:true,manual_only:true,side:'BUY',symbol:'XAUUSDm',lots:0.01,exposure:1424.26,price:1424.26,sl:1424,tp:1425,preview_id:'preview'};};
  await vm.runInNewContext('('+manual+')',ctx)({I:{s:'XAU/USD'},amt:1,sl:1424,tp:1425});
  assert.equal(previews.length,1);assert.equal(sent.length,1);
  assert.equal(previews[0].lots,0.01);assert.equal(sent[0].lots,0.01);
  assert.equal(previews[0].strictMinVolume,true);assert.equal(sent[0].strictMinVolume,true);
});
test('bridge preview transport preserves the chosen lots and strict-minimum option',()=>{
  const source=readFileSync(new URL('../../src/bridge.js',import.meta.url),'utf8');
  const f=source.slice(source.indexOf('export function previewBridgeOrder('),source.indexOf('\nexport function placeBridgeOrder(')).replace('export ','');
  const fn=vm.runInNewContext('('+f+')',{verifiedOrderEnvironment:()=>true,frame:payload=>payload});
  const payload=fn({environment:'demo',symbol:'XAUUSD',side:'BUY',volume:1,lots:0.01,strictMinVolume:true});
  assert.equal(payload.lots,0.01);assert.equal(payload.strict_min_volume,true);
});
test('all market categories use broker specs rather than hard-coded 0.01 lots',()=>{
  for(const [symbol,min,contract,px] of [['EURUSD',0.01,100000,1.1],['XAUUSD',0.01,100,1424.26],['US30Cash',0.1,1,44000],['BTCUSD',0.001,1,90000],['AAPL',1,1,230],['OIL',0.05,1000,70]]){
    const quote={symbol,bid:px,ask:px,volume_min:min,volume_max:1000,volume_step:min,contract_size:contract};
    assert.equal(checkMt5OrderSize({quote,side:'BUY',usdSize:1}).ok,false,symbol);
    const selected=checkMt5OrderSize({quote,side:'SELL',usdSize:1,lotSize:min});
    assert.equal(selected.ok,true,symbol);assert.ok(Math.abs(selected.notional-min*contract*px)<1e-6);
  }
});

test('mismatched bridge lot preview or edits during confirmation cannot place an order',async()=>{
  for(const mismatch of ['lots','edit']){
    const {ctx,els,sent}=setup();els['#orderLots'].value='0.01';ctx.state.settings.oneClick=false;
    ctx.bridge.previewBridgeOrder=async()=>({environment:'demo',demo:true,manual_only:true,side:'BUY',symbol:'XAUUSDm',lots:mismatch==='lots'?0.02:0.01,preview_id:'p'});
    ctx.askConfirm=async()=>{els['#orderLots'].value='1';return true;};
    await vm.runInNewContext('('+manual+')',ctx)({I:{s:'XAU/USD'},amt:1,sl:1424,tp:1425});
    assert.equal(sent.length,0,mismatch);
  }
});

test('ticket starts at editable 0.01 lots and the adaptive sizer is hidden',async()=>{
  const {JSDOM}=await import('jsdom');
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html);
  const doc=dom.window.document;
  const lots=doc.querySelector('#orderLots');
  assert.equal(lots.value,'0.01');
  assert.equal(lots.step,'0.01');
  assert.equal(lots.disabled,false);
  const sizer=doc.querySelector('#sizePlan');
  assert.equal(sizer.hidden,true);
  assert.equal(dom.window.getComputedStyle(sizer).display,'none');
  assert.equal(doc.querySelector('#sniperFixedLots').value,'0.01');
  lots.value='0.05';assert.equal(lots.value,'0.05');
  dom.window.close();
});
test('changing MT5 markets resets lots to 0.01, while refreshing the same market preserves edits',async()=>{
  const {JSDOM}=await import('jsdom');
  const dom=new JSDOM('<select id="chartSymbol"><option>EUR/USD</option><option>XAU/USD</option></select><input id="orderLots" value="0.05"><input id="orderSL"><input id="orderTP"><input id="orderTP2"><div id="levelsNote"></div>');
  const lots=dom.window.document.querySelector('#orderLots');
  const fn=main.slice(main.indexOf('function setChartSymbol(sym,keepLevels)'),main.indexOf('/* auto-fill SL/TP in the order ticket'));
  const ctx={bySym:{'EUR/USD':{},'XAU/USD':{}},state:{chart:{sym:'EUR/USD'},broker:{type:'mt5'},view:'other'},$:s=>dom.window.document.querySelector(s),
    chartDisplayMode:'tv',tv:{switchChartSymbol(){}},updateTradeHeader(){},updateRisk(){},autofillLevels(){},renderSizePlan(){},refreshMt5SizePlan(){},DERIV_CODE_MAP:{},levelsForSym:null};
  const set=vm.runInNewContext('('+fn+')',ctx);
  set('XAU/USD');assert.equal(lots.value,'0.01');
  lots.value='0.08';set('XAU/USD');assert.equal(lots.value,'0.08');
  set('EUR/USD');assert.equal(lots.value,'0.01');
  dom.window.close();
});
