import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { sniperMarketAllowed, normalizeSniperConfig, sniperScanBatch } from '../../src/sniperengine.js';
import { notificationSignalCandidates } from '../../src/notificationsignals.js';

const instruments=[{s:'EUR/USD',c:'forex',p:1},{s:'US30',c:'indices',p:1},{s:'XAU/USD',c:'commodities',p:1},{s:'BTC/USD',c:'crypto',p:1},{s:'VOL 25',c:'synthetics',p:1}];
const main=readFileSync(new URL('../../src/main.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
test('scope defaults to all, persists across normalization, and separates forex from stock/synthetic indices',()=>{
  assert.equal(normalizeSniperConfig({}).marketScope,'ALL');
  for(const scope of ['ALL','FOREX','INDICES'])assert.equal(normalizeSniperConfig(JSON.parse(JSON.stringify({marketScope:scope}))).marketScope,scope);
  assert.deepEqual(instruments.filter(i=>sniperMarketAllowed(i,'FOREX')).map(i=>i.s),['EUR/USD']);
  assert.deepEqual(instruments.filter(i=>sniperMarketAllowed(i,'INDICES')).map(i=>i.s),['US30']);
  assert.equal(instruments.filter(i=>sniperMarketAllowed(i,'ALL')).length,5);
  assert.equal(sniperMarketAllowed({c:'stockindices'},'INDICES'),true);
  assert.equal(sniperMarketAllowed(instruments[0],'invalid'),false);
});
test('market group is a saved Sniper rule, not a session filter or a replacement for other analysis pages',()=>{
  const doc=new JSDOM(html).window.document;
  const select=doc.getElementById('sniperMarketScope');
  assert.deepEqual([...select.options].map(o=>o.value),['ALL','FOREX','INDICES','SELECTED']);
  assert.match(main,/marketScope: \$\('#sniperMarketScope'\)\?\.value/);
  assert.match(main,/\$\('#sniperMarketScope'\)\.value = sniperExecConfig.marketScope/);
  const watcher=main.slice(main.indexOf('async function runDynamicProfitTargetWatcher'),main.indexOf('function initSniperAndProfitTargetEngine'));
  assert.doesNotMatch(watcher,/sniperMarketAllowed|marketScope/,'existing position targets remain managed regardless of new-entry scope');
});
test('notifications cannot add an excluded category to the scan',()=>{
  const now=Date.now();
  const alerts=instruments.map(i=>({signalType:'ENTRY_SIGNAL',symbol:i.s,direction:'BUY',status:'ACTIVE',broker:'ALL',accountMode:'',createdAtMs:now,expiresAtMs:now+60000,timeframe:'5m'}));
  const opts={broker:'mt5',environment:'demo',knownSymbols:new Set(instruments.map(i=>i.s)),instruments};
  assert.deepEqual(notificationSignalCandidates(alerts,{...opts,marketScope:'FOREX'},now).map(n=>n.symbol),['EUR/USD']);
  assert.deepEqual(notificationSignalCandidates(alerts,{...opts,marketScope:'INDICES'},now).map(n=>n.symbol),['US30']);
});
test('actual monitoring cycle filters base batch, watchlist, notifications and empty-universe fallback without widening scope',async()=>{
  const cycle=main.slice(main.indexOf('async function autoTradeCycle(){'),main.indexOf('\nasync function autoEntry('));
  for(const scope of ['ALL','FOREX','INDICES'])for(const noPrices of [false,true]){
    const scanned=[],statuses=[];
    const universe=instruments.map(i=>({...i,p:noPrices?null:i.p}));
    const now=Date.now();
    const alerts=universe.map(i=>({signalType:'ENTRY_SIGNAL',symbol:i.s,direction:'BUY',status:'ACTIVE',broker:'ALL',createdAtMs:now,expiresAtMs:now+60000,timeframe:'5m'}));
    const config=normalizeSniperConfig({marketScope:scope});
    const ctx={atTimer:1,atBusy:false,atSession:{},atCfg:()=>({mode:'active',dir:'both',conf:75}),atCooldownUntil:0,
      sniperExecConfig:config,automationSnapshotCheck:()=>({ok:true}),sniperMarketAllowed,INSTR:universe,
      sniperScanCursor:0,sniperScanBatch,sniperWatchSymbols:new Set(universe.map(i=>i.s)),
      getActiveBrokerIdentity:()=>({broker:'mt5',environment:'demo'}),notificationSignalCandidates,listNotifications:()=>alerts,
      scanSignalsPreferred:async symbols=>{scanned.push(...symbols);return [];},state:{mktScan:{},view:'overview'},
      renderSniperSignalAlerts(){},emitSniperSignalAlerts(){},atScanInfo:{},atStatusUI:(...args)=>statuses.push(args),atFails:0,notify(){}};
    await vm.runInNewContext('('+cycle+')',ctx)();
    assert.ok(scanned.length,scope);
    assert.ok(scanned.every(s=>sniperMarketAllowed(universe.find(i=>i.s===s),scope)),scope);
    assert.ok(!scanned.includes('VOL 25'),'synthetic opt-out must not be silently bypassed');
    if(scope==='INDICES')assert.deepEqual(scanned,['US30']);
    if(scope==='FOREX')assert.deepEqual(scanned,['EUR/USD']);
    assert.equal(ctx.atBusy,false);
  }
  // A selected category with no catalogue members must wait, not fall back to forex.
  const emptyCycle=cycle;
  const statuses=[];
  const ctx={atTimer:1,atBusy:false,atSession:{},atCfg:()=>({}),atCooldownUntil:0,
    sniperExecConfig:normalizeSniperConfig({marketScope:'INDICES'}),sniperMarketAllowed,
    INSTR:[instruments[0]],sniperScanCursor:0,sniperScanBatch,sniperWatchSymbols:new Set(['EUR/USD']),
    getActiveBrokerIdentity:()=>({broker:'mt5'}),notificationSignalCandidates,listNotifications:()=>[],
    scanSignalsPreferred:()=>{throw new Error('must not scan outside scope');},atStatusUI:(...args)=>statuses.push(args)};
  await vm.runInNewContext('('+emptyCycle+')',ctx)();
  assert.match(statuses[0][1],/No markets/);
});

test('exact-market selection is normalized, saved and enforced with an empty selection failing closed',()=>{
  const config=normalizeSniperConfig({marketScope:'SELECTED',selectedMarkets:[' eur/usd ','US30','EUR/USD',null,42,'']});
  assert.equal(config.marketScope,'SELECTED');
  assert.deepEqual(config.selectedMarkets,['EUR/USD','US30']);
  assert.deepEqual(normalizeSniperConfig(JSON.parse(JSON.stringify(config))).selectedMarkets,config.selectedMarkets);
  assert.equal(sniperMarketAllowed(instruments[0],'SELECTED',['EUR/USD']),true);
  assert.equal(sniperMarketAllowed(instruments[1],'SELECTED',['EUR/USD']),false);
  assert.equal(sniperMarketAllowed(instruments[0],'SELECTED',[]),false);
  assert.equal(sniperMarketAllowed(instruments[0],'SELECTED',['UNKNOWN']),false);
  const now=Date.now();
  const alerts=instruments.map(i=>({signalType:'ENTRY_SIGNAL',symbol:i.s,direction:'BUY',status:'ACTIVE',broker:'ALL',createdAtMs:now,expiresAtMs:now+60000,timeframe:'5m'}));
  const opts={marketScope:'SELECTED',selectedMarkets:['US30'],broker:'mt5',knownSymbols:new Set(instruments.map(i=>i.s)),instruments};
  assert.deepEqual(notificationSignalCandidates(alerts,opts,now).map(n=>n.symbol),['US30']);
  assert.equal(notificationSignalCandidates(alerts,{...opts,selectedMarkets:[]},now).length,0);
});

test('searchable checkbox picker retains filtered-out selections and the save handler persists exact symbols',()=>{
  const doc=new JSDOM(html).window.document;
  const $=s=>doc.querySelector(s),$$=s=>Array.from(doc.querySelectorAll(s));
  const context=vm.createContext({$, $$, INSTR:instruments.map(i=>({...i,n:i.s==='XAU/USD'?'Gold spot':i.s})),
    sniperExecConfig:normalizeSniperConfig({marketScope:'SELECTED',selectedMarkets:['US30']}),
    normalizeSniperConfig,saveSniperExecConfig(){},syncSniperUiControls(){},escHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')});
  const picker=main.slice(main.indexOf('function updateSniperSelectedMarketPicker()'),main.indexOf('function syncSniperUiControls()'));
  vm.runInContext(picker,context);
  $('#sniperMarketScope').value='SELECTED';
  context.renderSniperSelectedMarketPicker();
  assert.equal($('#sniperSelectedMarketPicker').classList.contains('hidden'),false);
  assert.ok($('#sniperMarketChoices input[value="US30"]').checked);
  $('#sniperMarketSearchInput').value='Gold';
  context.updateSniperSelectedMarketPicker();
  const gold=$('#sniperMarketChoices input[value="XAU/USD"]');
  assert.equal(gold.closest('label').classList.contains('hidden'),false);
  assert.equal($('#sniperMarketChoices input[value="US30"]').closest('label').classList.contains('hidden'),true);
  gold.checked=true;
  context.updateSniperSelectedMarketPicker();
  assert.match($('#sniperMarketSelectionCount').textContent,/2 market/);
  const save=main.slice(main.indexOf('  const readRulesFromInputs = () => {', main.indexOf('function initSniperAndProfitTargetEngine()')),main.indexOf("  $('#sniperExecToggle')?.addEventListener('change'",main.indexOf('function initSniperAndProfitTargetEngine()')));
  vm.runInContext(save+'\nreadRulesFromInputs();',context);
  assert.deepEqual(Array.from(context.sniperExecConfig.selectedMarkets),['US30','XAU/USD']);
  assert.equal(context.sniperExecConfig.marketScope,'SELECTED');
  context.renderSniperSelectedMarketPicker();
  assert.equal($('#sniperMarketChoices input[value="US30"]').checked,true);
  $('#sniperMarketScope').value='ALL';context.updateSniperSelectedMarketPicker();
  assert.equal($('#sniperSelectedMarketPicker').classList.contains('hidden'),true);
});

test('actual scan considers only exact selections even with other watchlist/notification symbols and missing prices',async()=>{
  const cycle=main.slice(main.indexOf('async function autoTradeCycle(){'),main.indexOf('\nasync function autoEntry('));
  for(const selectedMarkets of [['EUR/USD'],['US30'],['XAU/USD'],['EUR/USD','US30'],[],['UNKNOWN']]){
    const scanned=[],statuses=[];
    const universe=instruments.map(i=>({...i,p:null}));
    const now=Date.now();
    const alerts=universe.map(i=>({signalType:'ENTRY_SIGNAL',symbol:i.s,direction:'BUY',status:'ACTIVE',broker:'ALL',createdAtMs:now,expiresAtMs:now+60000,timeframe:'5m'}));
    const ctx={atTimer:1,atBusy:false,atSession:{},atCfg:()=>({mode:'active',dir:'both',conf:75}),atCooldownUntil:0,
      sniperExecConfig:normalizeSniperConfig({marketScope:'SELECTED',selectedMarkets}),automationSnapshotCheck:()=>({ok:true}),sniperMarketAllowed,INSTR:universe,
      sniperScanCursor:0,sniperScanBatch,sniperWatchSymbols:new Set(universe.map(i=>i.s)),
      getActiveBrokerIdentity:()=>({broker:'mt5',environment:'demo'}),notificationSignalCandidates,listNotifications:()=>alerts,
      scanSignalsPreferred:async symbols=>{scanned.push(...symbols);return [];},state:{mktScan:{},view:'overview'},
      renderSniperSignalAlerts(){},emitSniperSignalAlerts(){},atScanInfo:{},atStatusUI:(...args)=>statuses.push(args),atFails:0,notify(){}};
    await vm.runInNewContext('('+cycle+')',ctx)();
    const expected=selectedMarkets.filter(s=>instruments.some(i=>i.s===s));
    assert.deepEqual([...scanned].sort(),expected.sort());
    if(!expected.length)assert.match(statuses[0][1],/No markets/);
  }
});
