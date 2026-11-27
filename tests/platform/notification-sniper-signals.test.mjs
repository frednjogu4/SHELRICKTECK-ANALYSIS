import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { signalNotificationFields, notificationSignalCandidates } from '../../src/notificationsignals.js';
import { notify, listNotifications, pushNotificationItem, updateNotificationStatusBySignal } from '../../src/notify.js';
import { sniperMarketAllowed, trySniperCandidates, sniperScanBatch } from '../../src/sniperengine.js';

const now = 1800000000000;
const context = { broker: 'mt5', environment: 'demo', knownSymbols: new Set(['EUR/USD', 'XAU/USD', 'BTC/USD', 'VOL10']),
  instruments: [{s:'VOL10',c:'synthetics'}] };
const fields = signalNotificationFields({symbol:'EUR/USD',signal:'SELL',confidence:85,entry:10,stop_loss:11,tp1:8,source:'Exness MT5'}, {}, now);
const entry = {id:'signal-1', ...fields, broker:'ALL', accountMode:'', status:'ACTIVE', createdAtMs:now};
test('structured BUY/SELL entries are candidates; selection is independent of read/unread filters', () => {
  assert.equal(fields.direction, 'SELL');
  assert.equal(fields.signalType, 'ENTRY_SIGNAL');
  const found = notificationSignalCandidates([{...entry,read:true}], context, now);
  assert.equal(found[0].symbol, 'EUR/USD');
  assert.equal(found[0].direction, 'SELL');
  assert.equal(found[0].notificationId, 'signal-1');
  assert.equal(found[0].entry, undefined, 'stored prices must never become an order payload');
});
test('news, trade confirmations, historical, expired, invalidated, malformed and wrong-account alerts cannot seed entries', () => {
  for (const patch of [
    {signalType:'INFO'}, {signalType:undefined}, {direction:'INFO'}, {status:'EXECUTED'}, {status:'CLOSED'},
    {status:'INVALIDATED'}, {status:'EXPIRED'}, {createdAtMs:now-180001}, {createdAtMs:now+1},
    {expiresAtMs:now}, {expiresAtMs:null}, {symbol:'UNKNOWN'}, {broker:'DERIV'}, {accountMode:'REAL'},
    {timeframe:'1d'}, {source:'Yahoo Finance'}, {symbol:'VOL10'},
  ]) assert.equal(notificationSignalCandidates([{...entry,...patch}], context, now).length, 0, JSON.stringify(patch));
  assert.equal(signalNotificationFields({signal:'WAIT',confidence:90}).signalType, 'CONTEXT');
  assert.equal(signalNotificationFields({signal:'BUY',confidence:90,source:'Yahoo Finance'}).signalType, 'CONTEXT');
});
test('newest signal per symbol is deduplicated; explicit symbol/timeframe/synthetic restrictions remain enforced', () => {
  const recent = {...entry,id:'new',direction:'BUY',createdAtMs:now+10};
  assert.equal(notificationSignalCandidates([entry,recent],context,now+10)[0].direction,'BUY');
  assert.equal(notificationSignalCandidates([entry],{...context,allowedInstruments:['BTC/USD']},now).length,0);
  assert.equal(notificationSignalCandidates([entry],{...context,allowedTimeframes:['15m']},now).length,0);
  assert.equal(notificationSignalCandidates([{...entry,timeframe:'MTF 1m/5m/1h'}],{...context,allowedTimeframes:['5m','15m','1h']},now).length,1);
  assert.equal(notificationSignalCandidates([{...entry,symbol:'VOL10'}],{...context,allowSynthetics:true},now).length,1);
});
test('notify preserves explicit entry metadata, SELL direction and expiry; subsequent fills/invalidation remove candidates', () => {
  const reading={symbol:'XAU/USD',signal:'SELL',confidence:88,entry:2500,stop_loss:2505,tp1:2490,source:'MT5'};
  notify('Gold signal test','Signal only',{tag:'notification-sniper-test',...signalNotificationFields(reading)});
  const record=listNotifications().find(n=>n.symbol==='XAU/USD'&&n.signalType==='ENTRY_SIGNAL');
  assert.equal(record.direction,'SELL');
  assert.equal(record.entry,2500);
  assert.equal(record.source,'MT5');
  assert.ok(record.expiresAtMs>Date.now());
  pushNotificationItem({...record,id:'opposite',direction:'BUY',dedupeKey:'opposite-signal-test'});
  assert.equal(record.status,'INVALIDATED');
  updateNotificationStatusBySignal('XAU/USD','BUY','EXECUTED');
  assert.equal(notificationSignalCandidates(listNotifications(),context).length,0);
});

test('scan cycle includes notification-only symbol, reanalyses it, and dispatches only while explicitly armed', async () => {
  const source=readFileSync(new URL('../../src/main.js',import.meta.url),'utf8');
  const cycle=source.slice(source.indexOf('async function autoTradeCycle(){'),source.indexOf('\nasync function autoEntry('));
  for (const scenario of ['disarmed','armed','expired','invalidated','reversed']) {
    const armed=scenario!=='disarmed';
    const scanned=[],attempted=[];
    const instrument={s:'EUR/USD',c:'forex',p:1};
    const notification={...entry,createdAtMs:Date.now(),expiresAtMs:Date.now()+180000};
    const ctx={
      atTimer:1,atBusy:false,atSession:{},atCfg:()=>({mode:'active',dir:'both',conf:75}),atCooldownUntil:0,
      sniperExecConfig:{execEnabled:armed,allowedInstruments:[],allowedTimeframes:[]}, automationSnapshotCheck:()=>({ok:true}),
      sniperMarketAllowed, INSTR:[instrument],sniperScanCursor:0,sniperScanBatch,sniperWatchSymbols:new Set(),
      getActiveBrokerIdentity:()=>({broker:'mt5',environment:'demo',authKey:'locked'}),
      notificationSignalCandidates,listNotifications:()=>[{...notification,symbol:'XAU/USD'}],
      scanSignalsPreferred:async symbols=>{
        scanned.push(...symbols);
        if(scenario==='expired')notification.expiresAtMs=Date.now()-1;
        if(scenario==='invalidated')notification.status='INVALIDATED';
        return [{symbol:'XAU/USD',signal:scenario==='reversed'?'BUY':'SELL',confidence:90}];
      },
      state:{mktScan:{},view:'overview'},renderSniperSignalAlerts(){},emitSniperSignalAlerts(){},
      atScanInfo:{},atStatusUI(){},isSniperExecutionArmedNow:()=>armed,trySniperCandidates,
      autoEntry:async candidate=>{attempted.push(candidate);return {status:'filled'};},atFails:0,notify(){},AT_INTERVAL:30000,
    };
    // XAU is known but outside this cycle's priced base batch.
    ctx.INSTR.push({s:'XAU/USD',c:'commodities',p:null});
    const execute=vm.runInNewContext('('+cycle+')',ctx);
    await execute();
    assert.ok(scanned.includes('XAU/USD'));
    assert.equal(attempted.length,scenario==='armed'?1:0,scenario);
    if(scenario==='armed') assert.equal(attempted[0].symbol,'XAU/USD');
    assert.equal(ctx.atBusy,false);
  }
});

test('all directional alert producers include typed metadata instead of requiring title/body parsing', () => {
  const main=readFileSync(new URL('../../src/main.js',import.meta.url),'utf8');
  for (const tag of ["tag:'signal-'+symbol+'-'+signal", "tag:'az'", "tag:'gold-signal-'+key", "tag:'sniper-'+r.symbol+'-entry'"]) {
    const line=main.split('\n').find(line=>line.includes(tag));
    assert.ok(line?.includes('signalNotificationFields('),tag);
  }
});
