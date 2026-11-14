/* ================================================================
 * AURUM Workspace — application entry
 * REAL DATA ONLY: Exness-first MT5 candles for signals with clearly-labelled
 * Deriv/Yahoo fallback, public market prices, TradingView charts, broker-gated trading
 * (Deriv PAT or Exness local bridge), AI guidance via server (Claude /
 * ChatGPT / Perplexity) with a shared daily budget. There is no
 * simulated price engine, no demo balance and no fake content.
 * ================================================================ */
import { INSTRUMENTS, INSTRUMENT_MAP, WATCHLIST_DEFAULTS, DERIV_CODE_MAP } from '../server/lib/symbols.js';
import { createSignalTracker, describeLive } from './signalrun.js';
import * as bridgeMod from './bridge.js';
import { readMt5Identity, saveMt5Identity, forgetMt5Identity } from './mt5identity.js';
import { marketStatus, typicalActiveWindow, MARKET_HOURS_NOTE } from '../server/lib/markethours.js';
import * as feed from './marketdata.js';
import * as tv from './tradingview.js';
import { planPosition } from './sizer.js';
import { isOnlyOpenTradesGateFailure, verifyBrokerOpenTradeCount } from './mt5Risk.js';
import { analyzeTimeframe, confirmMultiTimeframe, votesSummary, runDeterministicAnalysis, waitReason } from '../server/lib/analyzer.js';
import { localDecision } from '../server/lib/localdecision.js';
import { buildProScalperSnapshot } from '../server/lib/indicators.pro.js';
import { notify, initNotifications, enableNotifications, notifState, LEVEL_GUIDE } from './notify.js';
import { getKeys, setKeys, clearKeys, hasAnyKey, keyHeaders } from './vault.js';
import { derivHealth, derivProposal, derivConfirm, tickFeed } from './derivproxy.js';
import { derivWsAuthorize, derivWsProposal, derivWsBuy, derivWsSell } from './derivws.js';
import * as bridge from './bridge.js';
import { patternAnalyze, patternStudy, renderPatternChart, playbookHTML, performanceHTML } from './patterns.js';
import { cloudConfig, cloudSaveConfig, cloudClearConfig, cloudAuthStatus, cloudSignIn, cloudSignUp, cloudSignOut, cloudVerifyTables, cloudList, saveAnalysis, savePatternEvent, saveAlert, saveSignal } from './cloud.js';
import { initConnectivityNotices, registerServiceWorker, removeAiKeyHeaders } from './resilience.js';
import { candleHistory } from './derivhistory.js';
import { createHostedScanner, signalState, summarizeReadings, withheldReading, feedTimeMs, ageText } from './hostedscan.js';
import { STATE_TIMEFRAMES, STATE_CANDLES, ADX_TREND, ADX_RANGE, VOL_WINDOW, timeframeState, summarizeStates, summaryText, feedFreshness, structureWords, eatMoment, TREND_WORDS, VOLATILITY_WORDS, UNAVAILABLE_WORDS, STATE_MEASURED_TEXT } from './marketstate.js';
import { closedCandleSets, nextReadingCheck } from './closedcandles.js';
import { measuredText, measuredLine, isDailyReading } from './measured.js';
import { splitBestPick, dailyBarText, sharedDailyBarText } from './bestpick.js';
import { headlineConcerns, eventConcerns, eventTime, currenciesOf, marketsForCurrency, eatClock, eatDay, eatDayBounds, eatStamp, standAside, exposureFor, exposureForCurrency, releaseMeasuredText, trendWords, STAND_ASIDE } from './newsimpact.js';

const $  = (s,r)=> (r||document).querySelector(s);
const $$ = (s,r)=> Array.from((r||document).querySelectorAll(s));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

/* ---------- formatting (null-safe: no data renders as '—') ---------- */
const fmtMoney=(v,sign)=>{
  if(v==null||!Number.isFinite(v))return '—';
  const s=(v<0?'-':(sign?'+':''));
  return s+'$'+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
};
const fmtAcctMoney=(v,currency,sign=false)=>{
  if(v==null||!Number.isFinite(Number(v)))return '—';
  const n=Number(v), s=n<0?'-':(sign&&n>0?'+':'');
  return s+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+(currency?' '+currency:'');
};
const fmtPct=(v,sign)=>{ if(v==null||!Number.isFinite(v))return '—'; return (v<0?'':(sign?'+':''))+v.toFixed(2)+'%'; };
const fmtPx=(v,d)=>{ if(v==null||!Number.isFinite(v))return '—'; return v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}); };
const timeStr=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const dateStr=t=>new Date(t).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});

/* ---------- instrument universe (live prices only, from Deriv) ---------- */
const INSTR=INSTRUMENTS.map(I=>Object.assign({},I,{p:null,open:null,hist:[],t:0}));
const bySym=Object.fromEntries(INSTR.map(i=>[i.s,i]));
const chgOf=I=>{ if(I.p==null||I.open==null)return null; return ((I.p-I.open)/I.open)*100; };
/* ---------- live confidence (src/signalrun.js) ----------
   A reading's score is fixed when the analysis runs. These follow each BUY/SELL
   reading from the price it was first read at: the score shown loses points as the
   live price moves toward the stop and gains points as it moves toward target 1.
   Scan readings are followed market by market; the Gold monitor reads gold from a
   source of its own and keeps its own run. Display only: alerts and Sniper filters
   keep using the score as read. It is a score, never a chance of profit. */
/* The prices streaming into this page come from Deriv. A reading made from Exness candles has
   Exness levels: it is measured against the Exness price that came with its latest analysis,
   never against a Deriv tick, so its score moves at each analysis instead of at each tick. */
const STREAM_FEED='stream';
const feedOfReading=r=>r&&r.model==='technical-exness'?'exness':STREAM_FEED;
const signalRuns=createSignalTracker({feedOf:feedOfReading}), goldRuns=createSignalTracker();
/* Why an index card of the cloud has three empty boxes: said on the card itself, for BUY, SELL and WAIT alike. */
const DAILY_NOTE='Daily index reading from daily closing prices: it has no entry, stop or target, so nothing here moves with the price and there is no measured result. Levels need minute-by-minute prices, which for indices come only from Exness MT5 in the PC app.';
const NO_LEVELS_NOTE='This reading has no entry, stop or target, so its score does not move with the price.';
/* A market that ticks again after a pause, with every finished candle still from before it: no reading yet (closedcandles.js). */
const RESUMED_NOTE=what=>what+' has just resumed after a pause: no 5-minute candle has closed since. The first reading comes with the next 5-minute close.';
/* "14:35" for the 5-minute close a reading was made at; '' for a reading that does not say (the daily ones, and those of a PC server from before 13 Nov 2026). */
const timeHM=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
const closeText=r=>Number(r&&r.candle_close)>0?timeHM(Number(r.candle_close)*1000):'';
function liveReading(symbol){const I=bySym[symbol];return signalRuns.read(symbol,I&&I.p!=null?I.p:null,STREAM_FEED);}
function liveNoteText(live,symbol,short){const I=bySym[symbol],digits=(I&&I.d)||2;return describeLive(live,{short:!!short,time:timeStr,price:v=>fmtPx(v,digits),sampled:at=>'measured at the Exness price of '+at+', updated at each analysis'});}
const hasLevels=r=>Number(r&&r.entry)>0&&Number(r&&r.stop_loss)>0&&Number(r&&r.tp1)>0;
/* What the page shows for one reading: its score and its sentence as the market stands now.
   A reading on screen can be older than the newest analysis of its market (the scanner cards
   are a snapshot until Refresh). When the newest analysis is a different reading (another
   direction, another venue, WAIT or a failure), the card keeps its own score and says so; it
   never borrows the numbers of a different reading. */
function liveView(symbol,side,base,levels,short,feedName,daily){
  if(daily)return {score:base,note:short?'':DAILY_NOTE};
  const directional=side==='BUY'||side==='SELL';
  const live=directional?liveReading(symbol):null;
  if(live&&live.signal===side&&live.feed===feedName)return {score:live.confidence,note:liveNoteText(live,symbol,short)};
  if(!directional)return {score:base,note:''};
  if(!levels)return {score:base,note:short?'':NO_LEVELS_NOTE};
  return {score:base,note:short?'not the newest reading':'This '+side+' reading is no longer the newest for this market: refresh to see the latest.'};
}
const liveViewOf=(r,short)=>liveView(r.symbol,r.signal,Number(r.confidence)||0,hasLevels(r),short,feedOfReading(r),isDailyReading(r));
function liveScore(r){return r&&r.symbol?liveViewOf(r).score:(Number(r&&r.confidence)||0);}
/* The sentence beside a reading's score: how far the market has moved since it was first read. */
function liveNoteFor(r,short){return r&&!r.error?liveViewOf(r,short).note:'';}
/* What paintLiveConfidence() needs to redo that computation on every tick. `role` is Conf, Bar or Note. */
function setLiveData(el,r,role){el.dataset['live'+role]=r.symbol;el.dataset.liveSide=r.signal||'';el.dataset.liveBase=String(Number(r.confidence)||0);el.dataset.liveLevels=hasLevels(r)?'1':'0';el.dataset.liveFeed=feedOfReading(r);el.dataset.liveDaily=isDailyReading(r)?'1':'0';}
function liveData(r,role,short){return ' data-live-'+role+'="'+escHtml(r.symbol)+'" data-live-side="'+escHtml(r.signal||'')+'" data-live-base="'+(Number(r.confidence)||0)+'" data-live-levels="'+(hasLevels(r)?1:0)+'" data-live-feed="'+feedOfReading(r)+'" data-live-daily="'+(isDailyReading(r)?1:0)+'"'+(short?' data-live-short="1"':'');}
/* '<b data-live-conf="EUR/USD" …>75%</b>': a score that paintLiveConfidence() keeps current between renders. */
function liveScoreHtml(r,tag='b'){return '<'+tag+liveData(r,'conf')+'>'+liveScore(r)+'%</'+tag+'>';}
function liveNoteHtml(r,short){return '<div class="tiny faint"'+liveData(r,'note',short)+'>'+escHtml(liveNoteFor(r,short))+'</div>';}
/* Runs on every price tick: rewrites the scores, bars and sentences already on the page. */
function paintLiveConfidence(){
  const view=(el,symbol)=>liveView(symbol,el.dataset.liveSide,Number(el.dataset.liveBase)||0,el.dataset.liveLevels==='1',el.dataset.liveShort==='1',el.dataset.liveFeed,el.dataset.liveDaily==='1');
  $$('[data-live-conf]').forEach(el=>{el.textContent=view(el,el.dataset.liveConf).score+'%';});
  $$('[data-live-bar]').forEach(el=>{el.style.width=view(el,el.dataset.liveBar).score+'%';});
  $$('[data-live-note]').forEach(el=>{el.textContent=view(el,el.dataset.liveNote).note;});
  if(state.view==='gold')updateGoldConfidence();
}
/* Confidence cell of the Sniper tables: the live score and a short note for a BUY/SELL, the score as read for a WAIT, a dash when the reading carries no score. */
function sniperConfidenceCell(r){
  if(!r||r.error||r.confidence==null||!Number.isFinite(Number(r.confidence)))return '—';
  const score=r.signal==='BUY'||r.signal==='SELL'?liveScoreHtml(r)+liveNoteHtml(r,true):escHtml(String(Number(r.confidence)))+'%';
  return score+measuredShortHtml(r);
}
/* "measured 39.6%" / "not measured" under a score in a table; the full sentence is the tooltip. '' for a WAIT of the 1m/5m/1h rule. */
function measuredShortHtml(r){
  const short=measuredText(r,{short:true});
  return short?'<div class="tiny faint" data-measured="'+escHtml(r.symbol)+'" title="'+escHtml(measuredText(r)||DAILY_NOTE)+'">'+escHtml(short)+'</div>':'';
}

/* ---------- built-in WhatsApp number ----------
   Share buttons open WhatsApp with the Shelricktech number unless the device
   has its own number saved in Settings. International format, digits only.
   Declared here because the Settings field is filled in during start-up. */
const WA_DEFAULT='254721752212';

/* ---------- persistent state ---------- */
const store={
  get(k,d){ try{ const v=localStorage.getItem('aurum_'+k); return v==null?d:JSON.parse(v);}catch(e){return d;} },
  set(k,v){ try{ localStorage.setItem('aurum_'+k,JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem('aurum_'+k); }catch(e){} }
};
/* Move the legacy non-secret Exness identity into this tab's session storage,
   then remove its old localStorage copy. No password/token is migrated. */
try{
  const legacy=localStorage.getItem('aurum_mt5_account_server');
  if(legacy&&!sessionStorage.getItem('aurum_mt5_account_server'))sessionStorage.setItem('aurum_mt5_account_server',legacy);
  localStorage.removeItem('aurum_mt5_account_server');
}catch(e){}
/* MT5 identity in session storage contains only account login + exact server. */
function clearMt5IdentityFields(){
  forgetMt5Identity();
  clearMt5Session();
  ['exnessLogin','mt5Login','exnessServer','mt5Server','exnessPass','mt5Pass','mt5Token'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
}
{
  const saved=readMt5Identity();
  ['exnessLogin','mt5Login'].forEach(id=>{const e=document.getElementById(id);if(e&&!e.value)e.value=saved.login;});
  ['exnessServer','mt5Server'].forEach(id=>{const e=document.getElementById(id);if(e&&!e.value)e.value=saved.server;});
  const bind=(id,otherId,field)=>{const e=document.getElementById(id);if(!e)return;e.addEventListener('input',()=>{
    const value=e.value.trim(),other=document.getElementById(otherId);if(other)other.value=value;
    const login=field==='login'?value:((document.getElementById('exnessLogin')||document.getElementById('mt5Login')||{}).value||'').trim();
    const server=field==='server'?value:((document.getElementById('exnessServer')||document.getElementById('mt5Server')||{}).value||'').trim();
    saveMt5Identity(login,server);
  });};
  bind('exnessLogin','mt5Login','login');bind('mt5Login','exnessLogin','login');
  bind('exnessServer','mt5Server','server');bind('mt5Server','exnessServer','server');
  ['mt5ForgetAuth','mt5ForgetSettings'].forEach(id=>{const b=document.getElementById(id);if(b)b.addEventListener('click',()=>{clearMt5IdentityFields();toast('Saved Exness details removed','Account, server, password and bridge token cleared from this browser tab. The current connection, if active, remains until disconnected.','ok');});});
}
const state={
  user: null,
  mode: 'live',                 // 'live' | 'deriv' | 'mt5'
  broker: null,                 // {type:'deriv',pat,appId,account} | {type:'mt5',account}
  balance: null,                // broker balance; null = not connected
  mt5LivePositions: null,        // latest read-only MT5 positions snapshot; null = unavailable/not synced
  mt5LastSnapshotAt: null,
  mt5SnapshotFailed: false,
  positions: store.get('positions',[]),
  history: store.get('history',[]),
  bots: store.get('bots',null),
  settings: Object.assign({
    theme:'dark', compact:false, defAmt:100, maxRisk:2, confirmClose:true
  }, store.get('settings',{})),

  connections: store.get('connections',{deriv:false,mt5:false}),
  chart:{ sym:'EUR/USD' },
  view:'overview',
  side:'BUY',
  signals:[],
  scanStatus:'idle',
  mkt:{ q:'', cat:'all', sort:'change' }
};
state.settings.autotrade=Object.assign(
  { on:false, conf:70, stake:10, target:25, maxTrades:10, dir:'both', brakes:'run' },
  state.settings.autotrade||{}
);
const save=()=>{
  store.set('positions',state.positions); store.set('history',state.history);
  store.set('settings',state.settings); store.set('connections',state.connections);
  store.set('bots',state.bots); store.set('watchlist',state.watchlist);
};
/* watchlist: pinned instruments; defaults = owner's index list (TradingView-quoted) */
state.watchlist=store.get('watchlist',null)||WATCHLIST_DEFAULTS.map(w=>Object.assign({},w));
function saveWatchlist(){
  store.set('watchlist',state.watchlist);
  if(state.view==='markets'){ renderMarkets(true); mktScanRefresh(); }
  if(state.view==='watch'){ renderWatchChips(); renderWatch(); }
}
function renderWatchChips(){
  const el=$('#watchChips'); if(!el)return;
  const total=state.watchlist.length;
  el.innerHTML=state.watchlist.map((w)=>'<span class="chip'+(w.live?'':' idx')+'" title="'+escHtml(w.n)+(w.live?' · Deriv live':' · TradingView (may be delayed)')+'">'+escHtml(w.id)+' <button type="button" class="watch-del" data-id="'+escHtml(w.id)+'" aria-label="Remove '+escHtml(w.id)+'">×</button></span>').join('')
    +'<select class="input" id="watchAdd" style="width:auto" aria-label="Add to watchlist"><option value="">+ Add…</option>'
    +WATCHLIST_DEFAULTS.filter(w=>!state.watchlist.some(x=>x.id===w.id)).map(w=>'<option value="'+escHtml(w.id)+'">'+escHtml(w.id)+' — '+escHtml(w.n)+'</option>').join('')
    +INSTR.filter(I=>!state.watchlist.some(x=>x.id===I.s)).map(I=>'<option value="'+escHtml(I.s)+'">'+escHtml(I.s)+' — '+escHtml(I.n)+' (Deriv live)</option>').join('')
    +'</select>';
  $$('#watchChips .watch-del').forEach(b=>b.onclick=()=>{ state.watchlist=state.watchlist.filter(w=>w.id!==b.dataset.id); saveWatchlist(); });
  const add=$('#watchAdd');
  if(add)add.onchange=()=>{
    const v=add.value; if(!v)return;
    const def=WATCHLIST_DEFAULTS.find(w=>w.id===v), I=INSTRUMENT_MAP[v];
    const entry=def?Object.assign({},def):(I?{id:I.s,n:I.n,tv:I.tv,live:true}:null);
    if(entry&&!state.watchlist.some(w=>w.id===entry.id))state.watchlist.push(entry);
    saveWatchlist();
  };
  let hint=document.getElementById('watchHint');
  if(!hint){ el.insertAdjacentHTML('afterbegin','<span class="hint" id="watchHint" style="width:100%"></span>'); hint=document.getElementById('watchHint'); }
  hint.textContent=total+' pinned · live tiles stream from Deriv; index tiles come from TradingView (may be delayed).';
}

/* module-wide HTML escaper (used by signal cards, history tables, tooltips) */
const escHtml = (x) => String(x == null ? '' : x).replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

/* Broker secrets are session-only: they survive page refreshes in this tab,
   but never go to localStorage/server disk. Logout/disconnect clears them. */
const patStore={
  remembered(){ return true; },
  setRemember(_on){},
  forget(){
    try{ sessionStorage.removeItem('aurum_pat'); sessionStorage.removeItem('aurum_appid'); }catch(e){}
    /* Remove any legacy persistent remember-me copies from earlier builds. */
    try{ localStorage.removeItem('aurum_pat_bk'); localStorage.removeItem('aurum_appid_bk'); localStorage.removeItem('aurum_remember'); }catch(e){}
  },
  get(){ try{ return sessionStorage.getItem('aurum_pat')||''; }catch(e){ return ''; } },
  set(v){ try{ v?sessionStorage.setItem('aurum_pat',v):sessionStorage.removeItem('aurum_pat'); }catch(e){} },
  getAppId(){ try{ return sessionStorage.getItem('aurum_appid')||''; }catch(e){ return ''; } },
  setAppId(v){ try{ v?sessionStorage.setItem('aurum_appid',v):sessionStorage.removeItem('aurum_appid'); }catch(e){} }
};
/* Delete legacy persistent backups without disturbing this tab's active session. */
try{ localStorage.removeItem('aurum_pat_bk'); localStorage.removeItem('aurum_appid_bk'); localStorage.removeItem('aurum_remember'); }catch(e){}
const MT5_SESSION_KEY='aurum_mt5_session';
function readMt5Session(){
  try{ const v=JSON.parse(sessionStorage.getItem(MT5_SESSION_KEY)||'null'); return v&&typeof v==='object'?v:null; }catch(e){ return null; }
}
function saveMt5Session(value){
  try{ sessionStorage.setItem(MT5_SESSION_KEY,JSON.stringify({
    login:String(value.login||'').trim(), password:String(value.password||''),
    server:String(value.server||'').trim(), token:String(value.token||'').trim(),
    url:String(value.url||'').trim()
  })); }catch(e){}
}
function clearMt5Session(){ try{ sessionStorage.removeItem(MT5_SESSION_KEY); sessionStorage.removeItem('aurum_local_api_token'); }catch(e){} }
function restoreBrokerCredentialFields(){
  const appId=patStore.getAppId(), pat=patStore.get();
  ['derivAppId','derivApp'].forEach(id=>{const e=document.getElementById(id);if(e&&appId)e.value=appId;});
  ['derivPat','derivToken'].forEach(id=>{const e=document.getElementById(id);if(e&&pat)e.value=pat;});
  const m=readMt5Session(); if(!m)return;
  [['exnessLogin','mt5Login','login'],['exnessServer','mt5Server','server'],['exnessPass','mt5Pass','password'],['mt5Token','mt5Token','token'],['mt5Url','mt5Url','url']].forEach(([a,b,key])=>{
    let value=String(m[key]||'');
    if(key==='url'&&value)value=bridge.normalizeBridgeUrl(value);
    [a,b].forEach(id=>{const e=document.getElementById(id);if(e&&value)e.value=value;});
  });
}
restoreBrokerCredentialFields();

/* ---------- fetch helper (jsdom-safe) ---------- */
function isPrivateBridgePage(){
  try{
    const h=String(location.hostname||'').toLowerCase();
    const local=h==='localhost'||h==='127.0.0.1'||h==='::1'||h.endsWith('.local')||/^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h);
    return local&&String(location.port||'')==='8788';
  }catch(e){return false;}
}
let cloudflareReadonlyCheck=null;
let cloudflareReadonlyUi=false;
function isCloudflareReadonlyMode(){
  try{const h=String(location.hostname||'').toLowerCase();return cloudflareReadonlyUi||h.endsWith('.workers.dev')||h.endsWith('.pages.dev');}catch(_e){return cloudflareReadonlyUi;}
}
async function isCloudflareHostedApp(){
  try{
    const h=String(location.hostname||'').toLowerCase();
    if(h.endsWith('.workers.dev')||h.endsWith('.pages.dev'))return true;
    if(!cloudflareReadonlyCheck)cloudflareReadonlyCheck=api('/api/health').then(async r=>{
      if(!r||!r.ok)return false;
      const j=await r.json().catch(()=>null);return !!(j&&j.runtime==='cloudflare-readonly');
    }).catch(()=>false);
    return await cloudflareReadonlyCheck;
  }catch(e){return false;}
}
function localApiProxyToken(){
  let t='';
  try{const el=document.getElementById('mt5Token');t=String(el&&el.value||'').trim();}catch(e){}
  try{if(t){sessionStorage.setItem('aurum_local_api_token',t);return t;}return sessionStorage.getItem('aurum_local_api_token')||'';}catch(e){return t;}
}
try{document.addEventListener('input',(e)=>{if(e.target&&e.target.id==='mt5Token'&&isPrivateBridgePage()){const t=String(e.target.value||'').trim();try{t?sessionStorage.setItem('aurum_local_api_token',t):sessionStorage.removeItem('aurum_local_api_token');}catch(_){}}});}catch(e){}
async function hydrateLoopbackBridgeToken(){
  try{
    const host=String(location.hostname||'').toLowerCase();
    if(location.protocol!=='http:'||location.port!=='8788'||!['127.0.0.1','localhost','::1'].includes(host))return;
    const field=document.getElementById('mt5Token');
    if(field&&field.value)return;
    const r=await fetch('/local-config',{cache:'no-store',credentials:'same-origin'});
    if(!r.ok)return;
    const cfg=await r.json();
    const token=String(cfg&&cfg.bridgeToken||'').trim();
    const server=String(cfg&&cfg.exnessServer||'').trim();
    if(server){['exnessServer','mt5Server'].forEach(id=>{const el=document.getElementById(id);if(el&&!el.value)el.value=server;});}
    if(!token)return;
    const input=document.getElementById('mt5Token');
    if(input&&!input.value)input.value=token;
    try{sessionStorage.setItem('aurum_local_api_token',token);}catch(_e){}
  }catch(_e){}
}
void hydrateLoopbackBridgeToken();
function api(path,{method='GET',body,headers={},timeoutMs=0}={}){
  if(typeof fetch!=='function')return Promise.reject(new Error('fetch unavailable'));
  const request=()=>{
    const sig=(timeoutMs&&typeof AbortSignal!=='undefined'&&AbortSignal.timeout)?AbortSignal.timeout(timeoutMs):undefined;
    const reqHeaders=Object.assign({'content-type':'application/json'},headers);
    /* The Cloudflare read-only Worker is technical-only and never uses AI keys, so the per-device keys are not transmitted to it. */
    if(isCloudflareReadonlyMode())removeAiKeyHeaders(reqHeaders);
    if(String(path||'').startsWith('/api/')&&isPrivateBridgePage()){
      const proxyToken=localApiProxyToken();
      if(proxyToken)reqHeaders['x-aurum-local-api-token']=proxyToken;
    }
    return fetch(path,{method,headers:reqHeaders,body:body?JSON.stringify(body):undefined,signal:sig});
  };
  if(/^\/api\/deriv(?:\/|$)/.test(String(path||''))){
    return isCloudflareHostedApp().then((hosted)=>{
      if(hosted)throw new Error('Deriv account and trade API routes are disabled on Cloudflare staging. The browser-only Deriv session never sends credentials to this Worker.');
      return request();
    });
  }
  return request();
}

/* ---------- toasts ---------- */
function toast(title,msg,kind){
  const el=document.createElement('div');
  el.className='toast'+(kind?' '+kind:'');
  el.innerHTML='<b></b><span></span>';
  el.querySelector('b').textContent=title;
  el.querySelector('span').textContent=msg||'';
  $('#toasts').appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),320); },4200);
}
initNotifications(toast);
initConnectivityNotices({toast});

/* ---------- confirm modal ---------- */
const confirmBox=document.createElement('div');
confirmBox.className='modal-overlay';
confirmBox.innerHTML='<div class="modal"><h3 class="cbT">Are you sure?</h3><p class="msub cbM"></p><div class="modal-actions"><button class="btn ghost cbNo">Cancel</button><button class="btn primary cbYes">Confirm</button></div></div>';
document.body.appendChild(confirmBox);
let cbResolve=null;
function askConfirm(title,msg,yesLabel){
  confirmBox.querySelector('.cbT').textContent=title;
  confirmBox.querySelector('.cbM').textContent=msg||'';
  confirmBox.querySelector('.cbYes').textContent=yesLabel||'Confirm';
  confirmBox.classList.add('open');
  return new Promise(res=>{cbResolve=res;});
}
confirmBox.querySelector('.cbYes').onclick=()=>{confirmBox.classList.remove('open'); cbResolve&&cbResolve(true);};
confirmBox.querySelector('.cbNo').onclick=()=>{confirmBox.classList.remove('open'); cbResolve&&cbResolve(false);};

/* ---------- theme ---------- */
const mqDark=(typeof window.matchMedia==='function')
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : {matches:true, addEventListener:null};
function applyTheme(){
  const t=state.settings.theme;
  const eff=t==='system'?(mqDark.matches?'dark':'light'):t;
  document.documentElement.setAttribute('data-theme',eff);
  const icon=$('#themeIcon');
  if(icon) icon.innerHTML = eff==='dark'
    ? '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  $$('#themePick .theme-card').forEach(b=>b.classList.toggle('active',b.dataset.themePick===t));
}
mqDark.addEventListener&&mqDark.addEventListener('change',()=>{ if(state.settings.theme==='system')applyTheme(); });
$('#themeBtn').onclick=()=>{
  const eff=document.documentElement.getAttribute('data-theme');
  state.settings.theme = eff==='dark'?'light':'dark';
  save(); applyTheme(); tv.refreshChartTheme();
};

/* ---------- navigation ---------- */
const VIEW_META={
  overview:['Overview','Workspace · everything at a glance'],
  markets:['Markets','All instruments · live Deriv prices'],
  trade:['Chart & Trade','Live TradingView chart · broker-routed orders'],
  state:['Market state','Four timeframes · a description, not a signal'],
  signals:['Signal Analyzer','MTF confluence → validated decision'],
  sniper:['Sniper alerts','Choose markets · entry/exit notifications'],
  gold:['Gold / USD','Dedicated XAU/USD analysis · no orders'],
  news:['News','Live headlines & economic calendar'],
  portfolio:['Portfolio','Positions, balance & history'],
  automation:['Automation','Broker bridges & XML bots'],
  learn:['Calculator Lab','Risk education · hypothetical tools'],
  watch:['Watchlist','Your pinned markets · live charts & quick trade'],
  settings:['Settings','Appearance, AI keys & notifications']
};
function goto(view){
  if(!VIEW_META[view])view='overview';
  state.view=view;
  try{ document.body.setAttribute('data-view',view); }catch(e){}
  $$('.view').forEach(v=>v.classList.toggle('active',v.id==='view-'+view));
  $$('.nav-item').forEach(b=>{
    const current=b.dataset.view===view;
    b.classList.toggle('active',current);
    if(current)b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
  });
  $('#topTitle').textContent=VIEW_META[view][0];
  $('#topCrumb').textContent=VIEW_META[view][1];
  closeSidebar();
  render(view);
  if(view==='markets'){ mktScanRefresh(); }
  if(view==='trade') setTimeout(()=>tv.mountChart($('#tvChart'),state.chart.sym),40);
  if(view==='news'){ setTimeout(()=>{ tv.mountNews($('#tvNews')); tv.mountCalendar($('#tvCalendar')); },40); renderNewsFeed(); renderNewsCal(); mktScanRefresh(); }
  window.scrollTo({top:0,behavior:'instant'in window?'instant':'auto'});
}
$$('.nav-item').forEach(b=>b.onclick=()=>goto(b.dataset.view));
document.addEventListener('click',e=>{
  const g=e.target.closest('[data-goto]'); if(g) goto(g.dataset.goto);
});
/* The countdowns and stand-aside states of the News view, and the release note in the line above the chart,
   follow the clock and not the price feed: they keep running when no price tick arrives. */
setInterval(()=>{ try{
  /* The calendar is read again while the News view or the chart stays open: a page left open over a
     week-end must not go on showing last week's releases, and a read that failed is tried again. */
  if((state.view==='news'||state.view==='trade')&&calendarDue())loadCalendar().then(()=>{ if(state.view==='news')paintNewsCal(); }).catch(()=>{}); /* the chart's line is redrawn by the next round, a second later */
  if(state.view==='news')updateNewsTimeline(); else if(state.view==='trade')updateChartLevels(); else if(state.view==='state')msTick();
}catch(e){} },1000);
/* News view: a market named beside a headline or a release opens its chart. */
document.addEventListener('click',e=>{
  const m=e.target.closest('[data-news-open]'); if(!m)return;
  e.preventDefault();
  const sym=m.dataset.newsOpen;
  if(bySym[sym]){ setChartSymbol(sym); goto('trade'); }
});
function openSidebar(){ $('#sidebar').classList.add('open'); $('#scrim').classList.add('open'); $('#hamburger').setAttribute('aria-expanded','true'); try{ document.body.style.overflow='hidden'; }catch(e){} }
function closeSidebar(){ $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('open'); $('#hamburger').setAttribute('aria-expanded','false'); try{ document.body.style.overflow=''; }catch(e){} }
$('#hamburger').onclick=openSidebar;
$('#scrim').onclick=closeSidebar;

/* ================================================================
   SESSION / CONNECT (Deriv · Exness · live-markets-only)
   ================================================================ */
function showApp(name,mode){
  state.user=name; state.mode=mode||'live';
  store.set('session',{name,mode:state.mode,brokerMode:state.broker&&state.broker.mode||''});
  $('#authScreen').classList.add('hidden');
  $('#appShell').classList.add('ready');
  $('#sideName').textContent=name;
  $('#sideAvatar').textContent=(name[0]||'L').toUpperCase();
  const sub=state.mode==='deriv'?(state.broker?.mode==='cloud_readonly'?'Deriv · read-only':'Deriv account'):{mt5:'Exness via bridge',live:'Live markets · no trading'}[state.mode];
  $('#sideSub').textContent=sub;
  const h=new Date().getHours();
  $('#ovGreeting').textContent=(h<12?'Good morning':h<18?'Good afternoon':'Good evening')+', '+name.charAt(0).toUpperCase()+name.slice(1);
  updateSessionInfo();
  boot();
}
function updateSessionInfo(){
  const el=$('#sessionInfo'); if(!el)return;
  if(state.broker?.type==='deriv'){
    const a=state.broker.account||{};
    el.textContent=state.broker.mode==='cloud_readonly'
      ?'Deriv '+a.loginid+(a.fullname?' · '+a.fullname:'')+' · balance '+(a.balance!=null?a.balance+' '+a.currency:'—')+'. Read-only; token is held in this tab and sent directly to Deriv only — not to Cloudflare.'
      :'Deriv '+a.loginid+(a.fullname?' · '+a.fullname:'')+' · balance '+(a.balance!=null?a.balance+' '+a.currency:'—')+'. PAT held for this session only.';
  }else if(state.broker?.type==='mt5'){
    const a=state.broker.account||{};
    const refreshed=state.mt5LastSnapshotAt?new Date(state.mt5LastSnapshotAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):(state.mt5SnapshotFailed?'refresh failed':'sync pending');
    el.textContent='Exness via local bridge · account '+(a.login||'••••')+' · balance '+fmtAcctMoney(a.balance,a.currency)+' · equity '+fmtAcctMoney(a.equity,a.currency)+' · free margin '+fmtAcctMoney(a.margin_free,a.currency)+' · leverage '+(a.leverage?'1:'+a.leverage:'unknown')+' · MT5 sync '+refreshed+'.';
  }else{
    el.textContent='Live markets only — no broker connected, order placement locked.';
  }
}
function signOut(){
  sessLog.add('signed','Signed out');
  store.del('session'); state.user=null; state.broker=null; state.balance=null;
  state.mt5LivePositions=null; state.mt5LastSnapshotAt=null; state.mt5SnapshotFailed=false;
  state.connections={deriv:false,mt5:false}; save();
  patStore.forget(); clearMt5Session(); forgetMt5Identity();
  ['exnessLogin','mt5Login','exnessServer','mt5Server','exnessPass','mt5Pass','mt5Token','derivAppId','derivPat','derivApp','derivToken'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  try{ bridge.disconnectBridge('signed out'); }catch(e){}
  $('#appShell').classList.remove('ready');
  $('#authScreen').classList.remove('hidden');
  closeSidebar();
}

/* --- Deriv connect: server validates + hands out limits, then the
       browser authorizes on Deriv's official WS (Cloudflare blocks
       datacenter IPs, home/mobile networks are fine). PAT stays
       session-only. --- */
async function connectDeriv(appId,pat){
  if(await isCloudflareHostedApp()){
    /* Cloudflare staging authorizes directly with Deriv from this tab. The
       credential and account response are never sent to the Worker. */
    const info=await derivWsAuthorize(appId,pat);
    const scopes=Array.isArray(info.scopes)?info.scopes.map((s)=>String(s).toLowerCase()):[];
    if(!scopes.includes('read')||scopes.some((scope)=>scope!=='read')){
      throw new Error('Cloudflare staging accepts only a Deriv Classic API token with the Read scope and no other scopes. Create a read-only token; Trade, Payments, and Admin scopes are rejected.');
    }
    patStore.set(pat);
    patStore.setAppId(appId);
    state.broker={type:'deriv',pat,appId,account:info,mode:'cloud_readonly',limits:null};
    state.balance=info.balance!=null?Number(info.balance):null;
    state.connections.deriv=true; save();
    store.set('session',{name:'Deriv',mode:'deriv',brokerMode:'cloud_readonly'});
    return info;
  }
  const res=await api('/api/deriv/connect',{method:'POST',body:{appId},headers:{'x-deriv-pat':pat,'x-deriv-appid':appId||''}});
  if(!res.ok){ const e=await res.json().catch(()=>({})); throw new Error(e.detail||('Deriv connect failed ('+res.status+')')); }
  const gate=await res.json();
  const info=await derivWsAuthorize(appId,pat);
  patStore.set(pat);
  patStore.setAppId(appId);
  state.broker={type:'deriv',pat,appId,account:info,mode:'pat_browser',limits:gate.limits};
  state.balance=info.balance!=null?Number(info.balance):null;
  state.connections.deriv=true; save();
  store.set('session',{name:'Deriv',mode:'deriv',brokerMode:'pat_browser'});
  return info;
}
/* --- NEW-API PAT client (server-side session; browser only holds sid) --- */
async function patConnect(appId,pat){
  if(await isCloudflareHostedApp())throw new Error('New-API PAT/server sessions are disabled on Cloudflare staging. Use a Deriv Classic token with Read-only scope; it is authorized directly by Deriv from this browser tab.');
  const res=await api('/api/deriv/pat/session',{method:'POST',body:{appId},headers:{'x-deriv-pat':pat,'x-deriv-appid':appId||''}});
  const j=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(j.detail||j.error||('PAT connect failed ('+res.status+')'));
  return j;
}
async function patAfterConnect(sess,appId,pat){
  patStore.set(pat);
  state.broker={type:'deriv',mode:'pat_server',sid:sess.sid,accountId:sess.primary.account_id,appId,account:sess.primary,accounts:sess.accounts,limits:sess.limits,environment:sess.environment};
  state.balance=sess.primary.balance!=null?Number(sess.primary.balance):null;
  patStore.setAppId(appId);
  state.connections.deriv=true; save();
  store.set('session',{name:'Deriv',mode:'deriv',brokerMode:'pat_server'});
  renderPatAccounts();
  sessLog.add('connected','Deriv connected ('+(sess.environment||'')+')');
  showApp('Deriv','deriv');
  notify('Deriv connected (PAT)','Secure server session · '+sess.environment.toUpperCase()+' · account '+sess.primary.account_id+'.','ok');
}
async function patProposal(sess,{symbol,side,amount,duration,duration_unit}){
  const res=await api('/api/deriv/pat/proposal',{method:'POST',body:{sid:sess.sid,accountId:sess.accountId,symbol,side,amount,duration,duration_unit},headers:{'x-aurum-user':state.user||'local'}});
  const j=await res.json().catch(()=>({}));
  if(!res.ok)throw Object.assign(new Error(j.detail||j.error||('Quote failed ('+res.status+')')),{code:j.error});
  return j;
}
async function patConfirm(ticket){
  const res=await api('/api/deriv/pat/confirm',{method:'POST',body:{ticket},headers:{'x-aurum-user':state.user||'local'}});
  const j=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(j.detail||j.error||'Buy failed');
  return j;
}
async function patClose(contractId,stake){
  const doCall=()=>api('/api/deriv/pat/close',{method:'POST',body:{sid:state.broker.sid,contract_id:contractId,stake},headers:{'x-aurum-user':state.user||'local'}}).then(async(res)=>{
    const j=await res.json().catch(()=>({}));
    if(!res.ok)throw Object.assign(new Error(j.detail||j.error||'Close failed'),{code:j.error});
    return j;
  });
  return patCall(doCall);
}

/* --- Deriv contract duration: Deriv offers different ranges per symbol
   (forex usually starts at 15 minutes; synthetics allow 5m). The server
   clamps to the real range via contracts_for — this default just avoids
   the common 5m-on-forex rejection. --- */
function derivDurationFor(sym){
  return /^[A-Z]{3}\/[A-Z]{3}$/.test(String(sym||''))?{duration:15,duration_unit:'m'}:{duration:5,duration_unit:'m'};
}
/* Target-exit strategy: 1h forex / 15m synthetics — Deriv's resale (is_valid_to_sell)
   typically unlocks on these mid-life, so the auto target-close can really execute. */
function targetDurFor(sym){
  return /^[A-Z]{3}\/[A-Z]{3}$/.test(String(sym||''))?{duration:1,duration_unit:'h'}:{duration:15,duration_unit:'m'};
}
/* ---- index CFD quotes via the Exness bridge (no Deriv feed for these) ----
   When connected, polls the six supported analysis-only index symbols plus any
   held/watchlist symbols every 2.5s. Fresh broker tick + trade mode is used for
   the status badge; no order route is involved. */
let idxQuoteT=null;
function mt5IndicesNeedingQuotes(){
  if(!state.broker||state.broker.type!=='mt5')return [];
  const catalog=INSTR.filter((I)=>I.c==='indices').map((I)=>I.s);
  const held=state.positions.filter((p)=>{ const I=bySym[p.sym]; return I&&I.c==='indices'; }).map((p)=>p.sym);
  const cur=state.chart&&bySym[state.chart.sym]&&bySym[state.chart.sym].c==='indices'?[state.chart.sym]:[];
  const watch=(state.watchlist||[]).map((w)=>w.id).filter((id)=>bySym[id]&&bySym[id].c==='indices');
  return [...new Set([...catalog,...cur,...held,...watch])].slice(0,20);
}
async function pumpIndexQuotes(){
  const syms=mt5IndicesNeedingQuotes();
  if(!syms.length)return;
  try{
    const r=await bridgeMod.quoteBridge(syms);
    for(const q of (r&&r.quotes)||[]){
      const base=syms.find((sn)=>q.symbol&&q.symbol.toLowerCase().replace(/[^a-z0-9]/g,'').startsWith(sn.replace('/','').toLowerCase()));
      const target=base?bySym[base]:null;
      const px=(q.bid&&q.ask)?(q.bid+q.ask)/2:(q.bid||q.ask||null);
      if(target&&px!=null&&Number.isFinite(px)){
        const tickMs=Number(q.time)>0?Number(q.time)*1000:0;
        const newTick=tickMs>0&&tickMs!==target.t;
        target.p=px;
        target.t=tickMs;
        target.mt5TradeMode=q.trade_mode==null?null:Number(q.trade_mode);
        target.mt5QuoteSymbol=String(q.symbol||'');
        if(newTick){target.hist.push(px); if(target.hist.length>120)target.hist.shift();}
      }
    }
  }catch(e){ /* bridge not running — the login card says so; nothing to fake */ }
}
setInterval(()=>{ try{ pumpIndexQuotes(); }catch(e){} },2500);
function durMs(du){ return Number(du.duration)*(du.duration_unit==='m'?60000:du.duration_unit==='h'?3600000:du.duration_unit==='d'?86400000:1000); }
function durHuman(du){
  const n=Number(du.duration);
  if(du.duration_unit==='m')return n+(n===1?' minute':' minutes');
  if(du.duration_unit==='h')return n+(n===1?' hour':' hours');
  if(du.duration_unit==='d')return n+(n===1?' day':' days');
  return n+' ticks';
}
/* wall-clock settle preview: "in 23h 59m · settles tomorrow 05:59 (device time)" */
function settleText(du){
  const ms=durMs(du);
  const t=new Date(Date.now()+ms);
  const now=new Date();
  const dayDiff=Math.round((new Date(t.getFullYear(),t.getMonth(),t.getDate())-new Date(now.getFullYear(),now.getMonth(),now.getDate()))/86400000);
  const day=dayDiff===0?'today':dayDiff===1?'tomorrow':t.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'});
  return 'in '+expiresFmt(Math.max(1,Math.round(ms/1000)))+' · '+day+' '+t.toTimeString().slice(0,5)+' (device time)';
}
function longLockWarn(du,I){
  const mins=durMs(du)/60000;
  if(mins<60)return '';
  if(I&&(I.c==='forex'||I.c==='commodities'))return ' ⚠ LONG + Deriv-locked family: expect to hold this one to settlement.';
  return ' ⚠ Long contract — you may not be able to close it early.';
}
function readDurationSel(sym){
  const v=$('#orderDuration')?$('#orderDuration').value:'';
  const m=/^(\d+)([smhd])$/.exec(String(v||''));
  return m?{duration:Number(m[1]),duration_unit:m[2]}:derivDurationFor(sym);
}

/* --- real/demo account switcher (PAT session; balances refreshable) --- */
async function patRefreshAccounts(){
  const doCall=async()=>{
    const sess=state.broker; if(!sess||sess.type!=='deriv')throw new Error('No Deriv PAT session.');
    const res=await api('/api/deriv/pat/refresh',{method:'POST',body:{sid:sess.sid},headers:{'x-aurum-user':state.user||'local'}});
    const j=await res.json().catch(()=>({}));
    if(!res.ok)throw Object.assign(new Error(j.detail||j.error||'Refresh failed'),{code:j.error});
    return j.accounts||[];
  };
  return patCall(doCall);
}
function switchDerivAccount(accountId){
  const b=state.broker; if(!b||b.type!=='deriv'||!Array.isArray(b.accounts))return;
  const acct=b.accounts.find(a=>a.account_id===accountId); if(!acct)return;
  const wasDemo=b.environment==='demo';
  b.accountId=acct.account_id; b.account=acct;
  b.environment=/demo|virtual/i.test(acct.account_type)?'demo':'real';
  state.balance=acct.balance!=null?Number(acct.balance):null;
  save(); updateSessionInfo(); renderPortfolio(); renderPatAccounts();
  toast('Account switched',(b.environment==='demo'?'DEMO':'REAL')+' account · '+acct.currency+' · balance '+(acct.balance!=null?acct.balance:'—'),'ok');
  if(wasDemo&&b.environment==='real')notify('Real account selected','Orders now execute on your REAL Deriv account within the server-side limits (max stake, max open trades, daily loss).',{tag:'trade',kind:'err'});
}
function renderPatAccounts(){
  const b=state.broker;
  document.querySelectorAll('[data-pat-accounts]').forEach(el=>{
    if(!b||b.type!=='deriv'||!Array.isArray(b.accounts)||!b.accounts.length){ el.innerHTML=''; el.style.display='none'; return; }
    el.style.display='block';
    const only=b.accounts.length===1;
    el.innerHTML='<div class="faint" style="margin-bottom:6px">Trading account — tap to switch (balance + order target update instantly):</div>'
      +'<div style="display:flex;gap:6px;flex-wrap:wrap">'+b.accounts.map(a=>{
        const demo=/demo|virtual/i.test(a.account_type);
        const sel=a.account_id===b.accountId;
        return '<button type="button" class="side-btn'+(sel?' sel-buy':'')+'" data-acct="'+escHtml(a.account_id)+'" style="min-width:150px">'
          +(demo?'DEMO':'REAL')+' · '+escHtml(a.currency)+' · '+(a.balance!=null?escHtml(String(a.balance)):'—')+(sel?' ✓':'')+'</button>';
      }).join('')+'</div>'
      +(only?'<div class="hint" style="margin-top:6px">Deriv returned only this account for your PAT. If your REAL account is missing, open <b>app.deriv.com</b>, add/enable a real <b>Options</b> trading account, then press “Refresh balances” — it appears here without reconnecting.</div>':'')
      +'<button type="button" class="btn ghost sm" id="patRefreshBtn" style="margin-top:8px">Refresh balances</button>';
    el.querySelectorAll('[data-acct]').forEach(btn=>{ btn.onclick=()=>switchDerivAccount(btn.getAttribute('data-acct')); });
    const rb=el.querySelector('#patRefreshBtn');
    if(rb)rb.onclick=async()=>{
      rb.disabled=true; rb.textContent='Refreshing…';
      try{
        const accts=await patRefreshAccounts();
        state.broker.accounts=accts;
        const cur=accts.find(a=>a.account_id===state.broker.accountId)||accts[0];
        if(cur){ state.broker.accountId=cur.account_id; state.broker.account=cur; state.broker.environment=/demo|virtual/i.test(cur.account_type)?'demo':'real'; state.balance=cur.balance!=null?Number(cur.balance):null; }
        save(); renderPatAccounts(); updateSessionInfo(); renderPortfolio();
        toast('Balances updated','Fresh balances fetched from Deriv.','ok');
      }catch(e){ toast('Refresh failed',String(e.message||e),'err'); }
      finally{ rb.disabled=false; rb.textContent='Refresh balances'; }
    };
  });
}

/* --- session activity log (Settings): connects, restores, expiries, sign-outs --- */
const sessLog={
  entries(){ try{ return JSON.parse(localStorage.getItem('aurum_sesslog')||'[]'); }catch(e){ return []; } },
  add(kind,text){
    try{ const a=sessLog.entries(); a.unshift({t:Date.now(),kind,text:String(text||'').slice(0,90)}); localStorage.setItem('aurum_sesslog',JSON.stringify(a.slice(0,20))); }catch(e){}
    if(typeof renderSessLog==='function')renderSessLog();
  }
};
function renderSessLog(){
  const el=$('#sessLog'); if(!el)return;
  const a=sessLog.entries();
  el.innerHTML=a.length?a.slice(0,10).map((e)=>'<li style="margin:2px 0"><span class="faint tiny">'+new Date(e.t).toLocaleTimeString()+'</span> — '+escHtml(e.text)+'</li>').join(''):'<li class="faint">No session activity yet.</li>';
}

/* --- silent PAT session heal: server restarts and deploys wipe the
   in-memory session BY DESIGN (the PAT is never written to disk). If this
   browser still holds the session PAT + App ID, re-authenticate once and
   retry the failed action instead of nagging "Reconnect your PAT". --- */
let patHealInFlight=null;
async function patHeal(){
  if(patHealInFlight)return patHealInFlight;
  patHealInFlight=(async()=>{
    try{
      const pat=patStore.get(), appId=(state.broker&&state.broker.appId)||patStore.getAppId();
      if(!pat||!appId)throw new Error('no_session');
      const sess=await patConnect(appId,pat);
      state.broker={type:'deriv',mode:'pat_server',sid:sess.sid,accountId:sess.primary.account_id,appId,account:sess.primary,accounts:sess.accounts,limits:sess.limits,environment:sess.environment};
      state.balance=sess.primary.balance!=null?Number(sess.primary.balance):null;
      state.connections.deriv=true; save();
      renderPatAccounts(); updateSessionInfo();
      sessLog.add('restored','Session restored automatically (server restarted)');
      resumeAutoTrade();
      toast('Session restored','The server restarted — your Deriv session was re-established automatically.','ok');
      return state.broker;
    }finally{ setTimeout(()=>{patHealInFlight=null;},0); }
  })();
  return patHealInFlight;
}
function isNoSessionErr(e){ return /no_session|pat_session_failed|session expired|Reconnect your Deriv PAT/i.test(String((e&&e.message)||e)); }
async function patCall(fn){
  try{ return await fn(); }
  catch(e){
    if(!isNoSessionErr(e))throw e;
    await patHeal();
    return await fn(); /* retry once with the fresh sid */
  }
}

/* --- Exness connect (local bridge; honest failure when not running) --- */
/* ---- 20i: hard stop for the HTTPS-window trap ----
   An https page can NEVER open the PC's local bridge socket (the browser
   blocks it silently). Stop pretending: show the guaranteed path as the
   primary action instead of a wall of retry text. */
async function httpsLocalGuard(url){
  try{ if(location.protocol!=='https:') return true; }catch(e){ return true; }
  if(!/localhost|127\.0\.0\.1|\[::1\]/.test(String(url||''))) return true;
  try{ if(sessionStorage.getItem('aurum_https_override')==='1') return true; }catch(e){}
  return new Promise(resolve=>{
    const ov=document.createElement('div'); ov.className='modal-overlay open';
    ov.innerHTML='<div class="modal"><h3 class="cbT">Open the local trading app</h3>'
      +'<p class="msub">This HTTPS window <b>cannot</b> open the PC\'s local bridge — the browser blocks the connection before anything runs (your bridge is fine). '
      +'The <b>local trading app</b> works every time: same workspace, served by the bridge itself on one port.</p>'
      +'<div class="modal-actions"><button class="btn ghost" id="hlgAnyway">Try anyway (I allowed the browser permissions)</button>'
      +'<button class="btn primary" id="hlgOpen">Open the local app ↗</button></div></div>';
    document.body.appendChild(ov);
    ov.querySelector('#hlgOpen').onclick=()=>{ try{ window.open('http://127.0.0.1:8788/app','_blank','noopener'); }catch(e){} ov.remove(); resolve(false); };
    ov.querySelector('#hlgAnyway').onclick=()=>{ try{ sessionStorage.setItem('aurum_https_override','1'); }catch(e){} ov.remove(); resolve(true); };
  });
}
async function connectMt5(url,login,password,server,token){
  if(!String(server||'').trim())throw new Error('Enter the exact Exness MT5 server shown in the Exness Personal Area.');
  if(!(await httpsLocalGuard(url))) throw new Error('Stopped on purpose: press Connect in the LOCAL trading app (the tab that just opened — http://127.0.0.1:8788/app). That path always works.');
  const health=await bridge.healthBridge(url,token);
  if(!health.ok){ toast('Bridge not available',health.message,'err'); throw new Error(health.message); }
  const account=await bridge.connectBridge(health.url||url,{login,password,server:server||'',token,transport:health.transport||''});
  /* Session-only vault: reconnect after refresh, never persist to localStorage. */
  saveMt5Session({login,password,server,token,url:health.url||url});
  state.broker={type:'mt5',account};
  state.mt5LivePositions=null; state.mt5LastSnapshotAt=null; state.mt5SnapshotFailed=false;
  { /* leverage transparency: our CFD sizing treats the stake as NOTIONAL
      exposure, so P/L is identical at any leverage — leverage only changes
      how much margin is locked. Show the real numbers where you connect. */
    const lv=account&&account.leverage;
    if(lv)toast('Exness connected read-only','MT5 reports leverage 1:'+lv+'; leverage never multiplies your P/L in this app. Informational only; order sending remains disabled in this verification build.','ok');
  }
  state.balance=account.balance!=null?Number(account.balance):null;
  state.connections.mt5=true; save();
  store.set('session',{name:'Exness',mode:'mt5'});
  void refreshMt5Snapshot(true);
  return account;
}

let mt5SyncBusy=false;
async function refreshMt5Snapshot(showToast=false){
  if(state.broker?.type!=='mt5'||mt5SyncBusy)return false;
  mt5SyncBusy=true;
  try{
    const [acct,positions]=await Promise.all([bridge.bridgeAccount(),bridge.bridgePositions()]);
    if(state.broker?.type!=='mt5')return false;
    const a=state.broker.account||{};
    state.broker.account=Object.assign({},a,{
      balance:acct.balance,equity:acct.equity,margin_free:acct.margin_free,
      currency:acct.currency||a.currency,leverage:acct.leverage||a.leverage||null
    });
    state.balance=acct.balance!=null&&Number.isFinite(Number(acct.balance))?Number(acct.balance):null;
    state.mt5LivePositions=Array.isArray(positions.list)?positions.list:null;
    state.mt5LastSnapshotAt=Date.now(); state.mt5SnapshotFailed=false;
    updateSessionInfo(); updateKpis(); updatePortfolioLive();
    if(state.view==='overview')renderOverview();
    if(showToast)toast('MT5 refreshed',(state.mt5LivePositions||[]).length+' live position(s) · balance/equity from the connected terminal.','ok');
    return true;
  }catch(_e){
    state.mt5SnapshotFailed=true;
    updateSessionInfo(); updateKpis(); renderMt5BrokerPositions();
    if(showToast)toast('MT5 refresh failed','Could not refresh from the local bridge. Last confirmed values remain shown.','err');
    return false;
  }finally{ mt5SyncBusy=false; }
}
setInterval(()=>{ if(state.broker?.type==='mt5')void refreshMt5Snapshot(false); },15000);
const mt5RefreshBtn=$('#mt5RefreshBtn');
if(mt5RefreshBtn)mt5RefreshBtn.onclick=()=>void refreshMt5Snapshot(true);

/* token kind toggle: classic (browser WS) vs new-API PAT (server session) */
let derivKind='classic';
function connectDerivButtonLabel(){return cloudflareReadonlyUi?'Connect Deriv (read-only)':'Connect Deriv & trade';}
function syncDerivKind(){
  const cl=$('#derivKindClassic'), pt=$('#derivKindPat');
  if(!cl||!pt)return;
  cl.className='side-btn'+(derivKind==='classic'?' sel-buy':'');
  pt.className='side-btn'+(derivKind==='pat'?' sel-buy':'');
  if(cloudflareReadonlyUi){
    $('#derivPatLabel').textContent='Deriv Classic API token (Read-only scope)';
    $('#derivKindNote').innerHTML='Create a Classic API token with <b>Read only</b> scope in Deriv API Management. The browser authorizes directly with Deriv. This staging page does not upload the token or account response to Cloudflare; trading is disabled.';
    return;
  }
  $('#derivPatLabel').textContent=derivKind==='classic'?'Deriv API token (classic — Trade scope)':'Deriv PAT (new API — Trade scope)';
  $('#derivKindNote').innerHTML=derivKind==='classic'
    ?'Classic token: <b>home.deriv.com</b> → profile → API Management → API Tokens → create with <b>Trade</b> scope. Executes from your browser (Deriv blocks datacenter servers). Token stays in this browser session only. A new-API <i>PAT</i> will NOT work here — use the PAT tab.'
    :'PAT: generate in your Deriv dashboard with <b>Trade + Read</b> scopes. It is verified over Deriv\'s REST API and kept <b>on our server only</b> — this browser stores just a session id. A <i>Classic</i> token will always be rejected here — use the Classic tab for those.';
}
async function configureCloudflareReadonlyUi(){
  if(!(await isCloudflareHostedApp()))return;
  cloudflareReadonlyUi=true; derivKind='classic'; syncDerivKind();
  feed.setDefaultSubscriptionsEnabled(true); /* keep the dashboard's verified Deriv instruments streaming; catalogue follows add only selected extra markets */
  const patTab=$('#derivKindPat'); if(patTab)patTab.hidden=true;
  const mt5Tab=$('#authTabMt5'); if(mt5Tab){mt5Tab.hidden=true;mt5Tab.disabled=true;mt5Tab.title='Exness is available only in the PC-local app; Cloudflare cannot connect to its bridge.';}
  $('#exnessForm')?.querySelectorAll('input,button').forEach((el)=>{el.disabled=true;});
  const btn=$('#derivLoginBtn'); if(btn){btn.dataset.cloudflareReadonly='1';btn.textContent=connectDerivButtonLabel();}
  const remember=$('#rememberNote'); if(remember)remember.textContent='Read-only token is kept in this browser tab session only and sent directly to Deriv for authorization. It is never sent to or stored by Cloudflare. Disconnect/sign out to clear it.';
  const foot=$('#authFoot');if(foot)foot.textContent='Cloudflare staging is analysis-only: Deriv read-only account connection, no trade execution. Exness remains available only from the PC-local app.';
  const note=document.createElement('p'); note.className='hint'; note.id='cloudflareLocalOnlyNotice';
  note.textContent='Exness credentials, quotes, and candles remain PC-local. Connect Exness only from the local app at http://127.0.0.1:8788/app; this Cloudflare page cannot reach your PC bridge.';
  const tabs=$('#authTabDeriv')?.parentElement; if(tabs&&!$('#cloudflareLocalOnlyNotice'))tabs.insertAdjacentElement('afterend',note);
}
$('#derivKindClassic').onclick=()=>{derivKind='classic';syncDerivKind();};
/* auth connect tabs: Deriv <-> MT5/Exness (keeps the login screen to one viewport) */
{ const td=$('#authTabDeriv'), tm=$('#authTabMt5');
  if(td&&!td.__wired){ td.__wired=1;
    const setTab=(which)=>{ const der=which==='deriv';
      td.classList.toggle('sel-buy',der); tm.classList.toggle('sel-buy',!der);
      const pd=$('#authPaneDeriv'), pm=$('#authPaneMt5');
      if(pd)pd.classList.toggle('hidden',!der);
      if(pm)pm.classList.toggle('hidden',der);
    };
    td.onclick=()=>setTab('deriv'); tm.onclick=()=>setTab('mt5'); } }
$('#derivKindPat').onclick=()=>{derivKind='pat';syncDerivKind();};
syncDerivKind();
void configureCloudflareReadonlyUi();

$('#derivForm').onsubmit=async e=>{
  e.preventDefault();
  let appId=$('#derivAppId').value.trim(), pat=$('#derivPat').value.trim();
  const err=$('#authErr');
  /* NOTE: Deriv App IDs are copied EXACTLY and may contain letters — no
     shape-based swapping. Labels below explain which value goes where. */
  if(!pat){ err.textContent='Paste your PAT in the token field. The App ID goes in its own box, copied exactly from your Deriv application.'; err.style.display='block'; return; }
  if(await isCloudflareHostedApp()&&derivKind==='pat'){
    err.textContent='New-API PAT sessions are server-side and are not enabled on Cloudflare. Use a Classic Deriv API token with Read-only scope.';err.style.display='block';return;
  }
  const btn=$('#derivLoginBtn'); btn.disabled=true; btn.textContent='Connecting…';
  try{
    if(derivKind==='pat'){
      /* pre-flight SHAPE diagnosis (booleans only — the values are never
         logged or sent anywhere): catches the classic-token 401 and swapped
         boxes before wasting a round trip. App-ID shape is NOT policed
         (copied EXACTLY, may vary); a pat_-prefixed App ID is however always
         a token in the wrong box. */
      const patShaped=/^pat_[A-Za-z0-9_-]{6,}$/.test(pat);
      const appIdIsToken=/^pat_[A-Za-z0-9_-]{6,}$/.test(appId);
      const patIsNumeric=/^[0-9]+$/.test(pat);
      if(!patShaped||appIdIsToken||patIsNumeric){
        const notes=[];
        notes.push('PAT box: '+(patShaped?'looks like a new-API PAT (pat_…) ✓':(patIsNumeric?'a numeric string — that is an App ID, not a token ✗':'NOT pat_-shaped ✗ — if this is a CLASSIC token it will always 401 here')));
        notes.push('App ID box: '+(appIdIsToken?'a pat_… token — that belongs in the PAT box ✗':'kept as you pasted it (copied EXACTLY from your application)'));
        err.innerHTML='<b>Before connecting — check the two boxes:</b><br>• '+notes.join('<br>• ')
          +'<br><br>A new-API PAT is generated in your Deriv dashboard with <b>Trade + Read</b> scopes and always starts with <span class="mono">pat_</span>.'
          +'<div class="row" style="gap:8px;margin-top:10px">'
          +((appIdIsToken||patIsNumeric)?'<button type="button" class="btn sm" id="authSwapBtn">⇄ Swap the two boxes for me</button>':'')
          +'<button type="button" class="btn ghost sm" id="authForceBtn">Connect anyway</button></div>';
        err.style.display='block';
        const swapBtn=document.getElementById('authSwapBtn');
        if(swapBtn)swapBtn.onclick=()=>{ $('#derivAppId').value=pat; $('#derivPat').value=appId; err.style.display='none'; toast('Boxes swapped','App ID and PAT were exchanged — press Connect Deriv & trade again.','ok'); };
        const forceBtn=document.getElementById('authForceBtn');
        if(forceBtn)forceBtn.onclick=async()=>{
          err.style.display='none';
          btn.disabled=true; btn.textContent='Connecting…';
          try{
            const sess=await patConnect(appId,pat);
            await patAfterConnect(sess,appId,pat);
            err.style.display='none';
          }catch(ex2){ err.textContent=String(ex2.message||ex2); err.style.display='block'; }
finally{ btn.disabled=false; btn.textContent=connectDerivButtonLabel(); }
        };
btn.disabled=false; btn.textContent=connectDerivButtonLabel();
        return;
      }
      const sess=await patConnect(appId,pat);
      await patAfterConnect(sess,appId,pat);
      err.style.display='none';
      return;
    }
    await connectDeriv(appId,pat);
    err.style.display='none';
    showApp('Deriv','deriv');
    if(state.broker?.mode==='cloud_readonly')notify('Deriv connected · read-only','This tab is authorized directly with Deriv. Token/account data were not sent to Cloudflare; trading stays disabled.','ok');
    else notify('Deriv connected','Live account linked — trading enabled.','ok');
  }catch(ex){
    err.textContent=String(ex.message||ex); err.style.display='block';
  }finally{ btn.disabled=false; btn.textContent=connectDerivButtonLabel(); }
};
$('#exnessForm').onsubmit=async e=>{
  e.preventDefault();
  if(await isCloudflareHostedApp()){const err=$('#authErr');err.textContent='Exness is PC-local only. No Exness credential or bridge request is permitted from Cloudflare; open the local app at http://127.0.0.1:8788/app.';err.style.display='block';return;}
  const login=$('#exnessLogin').value.trim(), password=$('#exnessPass').value, server=$('#exnessServer').value.trim();
  saveMt5Identity(login,server);
  const err=$('#authErr');
  if(!login||!password||!server){ err.textContent='Enter your Exness account number, MT5 password, and exact Exness MT5 server.'; err.style.display='block'; return; }
  const btn=$('#exnessLoginBtn'); btn.disabled=true; btn.textContent='Connecting…';
  try{
    await connectMt5(($('#mt5Url')||{}).value||bridge.localBridgeWs(),login,password,server,($('#mt5Token')||{}).value||'');
    err.style.display='none';
    showApp('Exness','mt5');
    notify('Exness connected read-only','Local MT5 data linked for verification; order sending is disabled in this build.','ok');
  }catch(ex){
    const m=String(ex.message||ex);
    const onPc=/localhost|127\.0\.0\.1/.test(location.hostname);
    { const ol=document.getElementById('openLocalMode'); if(ol)ol.classList.toggle('hidden',onPc); } /* already local -> the link is pointless */
    const httpsLead=(location.protocol==='https:'&&!onPc)?'<b>This HTTPS app is blocked by the browser from opening the PC\'s local bridge socket — the bridge itself is fine.</b> Guaranteed path: on the PC open <span class=\'mono\'>http://127.0.0.1:8788/app</span> — or double-click the <b>“Fredrick TRADING (local app)”</b> desktop icon that SETUP_AND_RUN.bat creates — and connect there. ':'';
    err.innerHTML=httpsLead+(/unreachable|timeout|refused|closed|blocked/i.test(m)
      ? '<b>Bridge not reachable.</b> 1) On the trading PC run <b>SETUP_AND_RUN.bat</b> and keep Exness MT5 open — the bridge window prints its address; the local token is in bridge_token.txt. 2) '+(onPc?'Open this app on the PC (<span class=\'mono\'>http://127.0.0.1:8788/app</span>).':'You are on another device (phone/tablet): set <b>Bridge URL</b> to the address the bridge window prints (e.g. <span class=\'mono\'>ws://192.168.1.10:8787</span>) and copy the <b>bridge token</b> locally from <span class=\'mono\'>bridge_token.txt</span> — <span class=\'mono\'>127.0.0.1</span> from a phone is the phone itself, not your PC. Easiest: open <span class=\'mono\'>http://PC-IP:8788/app</span> exactly as printed by the bridge window (same wifi).')+' 3) If a padlock warning appears on the https app: padlock → Site settings → Insecure content → Allow, reload (the http://PC-IP:8788/app route has no such warning).'
      : '<b>'+escHtml(m)+'</b>')+' <div class="tiny faint" style="margin-top:6px">The account number and MT5 server must MATCH: use the exact Exness server shown in the Exness Personal Area for this account — mixing them is rejected. An investor/read-only password is sufficient for this build. Keep passwords local.</div>';
    err.style.display='block';
  }finally{ btn.disabled=false; btn.textContent='Connect Exness (read-only)'; }
};
/* ---- 20h: connection doctor (step-by-step) ---- */
{ const bb=document.getElementById('bridgeTestBtn'); if(bb) bb.addEventListener('click', async ()=>{
  const box=document.getElementById('bridgeDoctor'); if(!box) return;
  box.classList.remove('hidden');
  box.innerHTML='<div class="tiny faint">Running the step-by-step test…</div>';
  const g=(id)=>{const el=document.getElementById(id); return el?String(el.value||'').trim():'';};
  const url=g('mt5Url')||bridge.localBridgeWs();
  const token=g('mt5Token');
  const login=g('mt5Login'), password=g('mt5Pass'), server=g('mt5Server');
  try{
    const steps=await bridge.diagnoseBridge(url, token, (login&&password)?{login,password,server}:null);
    box.innerHTML=steps.map(s=>'<div class="tiny" style="margin:4px 0;line-height:1.5"><b style="color:'+(s.ok===true?'#3ecf8e':s.ok===false?'#ff6b6b':'#999')+'">'+(s.ok===true?'✓':s.ok===false?'✗':'ℹ')+'</b> <b>'+escHtml(s.name)+'</b> — <span class="faint">'+escHtml(s.detail)+'</span></div>').join('')+'<div class="tiny faint" style="margin-top:6px">Send back the first ✗ line (or a screenshot) — every red line has a known fix.</div>';
  }catch(e){ box.innerHTML='<div class="tiny">'+escHtml(String(e.message||e))+'</div>'; }
}); }
$('#guestBtn').onclick=()=>{
  state.broker=null; state.balance=null;
  state.connections={deriv:false,mt5:false}; save();
  patStore.forget(); clearMt5Session(); forgetMt5Identity();
  showApp('Live','live');
  toast('Live markets','Real prices, charts and analysis — trading locked until you connect a broker.','ok');
};
$('#logoutBtn').onclick=signOut;
const signOutBtn=$('#signOutBtn'); if(signOutBtn) signOutBtn.onclick=signOut;

/* ================================================================
   LIVE FEED (Deriv public WebSocket) + ticker
   ================================================================ */
let feedWired=false, tickN=0, feedLiveAnnounced=false;
let feedStatusDetail='', feedDownExplained=false;
function updateFeedPill(s){
  const txt=$('#feedText'), dot=$('#feedDot');
  const map={
    idle:['Deriv feed · idle','off'],
    connecting:['Deriv feed · connecting…','off'],
    live:['Deriv live feed','live'],
    stale:['Deriv feed · no recent ticks (stale)','off'],
    reconnecting:['Deriv feed · reconnecting…','off'],
    unavailable:['Deriv feed · unavailable','off'],
    stopped:['Deriv feed · stopped','off']
  };
  if(isCloudflareReadonlyMode()&&s==='live'){
    const lastTick=feed.lastTickAt();
    const fresh=lastTick>0&&Date.now()-lastTick<30000;
    map.live=fresh?['Deriv public feed · receiving ticks','live']:['Deriv feed · waiting for first tick','off'];
  }
  const [label,cls]=map[s]||map.idle;
  if(txt)txt.textContent=label;
  if(dot)dot.className='dot '+(cls==='live'?'live':'off');
  const about=$('#aboutFeed'); if(about)about.textContent=label;
  const pill=$('#feedPill');
  if(pill){
    if(s==='unavailable')pill.title='This browser could not open the public Deriv price feed'+(feedStatusDetail?' ('+feedStatusDetail.slice(0,140)+')':'')+'. Prices show “—”; nothing is estimated.';
    else if(s==='stale')pill.title='The public Deriv price feed is not delivering ticks'+(feedStatusDetail?' ('+feedStatusDetail.slice(0,140)+')':'')+'. Prices on screen may be old; nothing is estimated.';
    else pill.removeAttribute('title');
  }
}
function wireFeed(){
  if(feedWired)return; feedWired=true;
  feed.onStatus((s,detail)=>{
    feedStatusDetail=(s==='unavailable'||s==='stale')?String(detail||''):'';
    updateFeedPill(s);
    if(s==='live'){
      if(!isCloudflareReadonlyMode()&&!feedLiveAnnounced){ feedLiveAnnounced=true; notify('Live feed connected','Deriv real-time prices are streaming.','ok',{tag:'feed'}); }
      /* Cloud viewer: the feed reports 'live' only after a valid tick, so this is never a connection-only notice. */
      else if(isCloudflareReadonlyMode()&&!feedLiveAnnounced){ feedLiveAnnounced=true; notify('Live prices streaming','Public Deriv quotes are streaming directly in this browser. View only: no account is connected.','ok',{tag:'feed'}); }
    }else if(s==='unavailable'&&feedLiveAnnounced){
      notify('Feed unavailable','Live Deriv prices unreachable — quotes show “—”.','err',{tag:'feed'});
    }else if(s==='unavailable'&&isCloudflareReadonlyMode()&&!feedDownExplained){
      feedDownExplained=true;
      toast('Live prices unavailable','This browser could not open the public Deriv price feed, so prices show “—”. Nothing is estimated. Try reloading, another browser or another network.','warn');
    }
  });
  feed.onTick((sym,q)=>{
    if(isCloudflareReadonlyMode())updateFeedPill(feed.feedStatus());
    const I=bySym[sym]; if(!I)return;
    I.p=q.px; I.open=q.open; I.hist=q.hist||I.hist; I.t=q.time;
    /* live confidence: a stop or target crossed while the market is not on screen still ends its reading */
    signalRuns.read(sym,q.px,STREAM_FEED);
    if(sym===GOLD_SYMBOL)goldRuns.read(GOLD_SYMBOL,goldLivePrice());
    tickN++;
    tickUI(); checkStops();
    /* first ~24 ticks: keep re-rendering so movers/signals settle as
       quotes and session changes come in; afterwards throttle */
    if(state.view==='overview'&&(tickN%10===0||tickN<=24)) renderOverview();
    if(state.view==='markets'&&tickN%5===0){ renderMarkets(true); if(tickN%60===0) mktScanRefresh(); }
    if(state.view==='watch'&&tickN%2===0) renderWatchLive();
  });
  feed.startFeed();
}
function tickUI(){
  tickerRefs.forEach(r=>{
    const I=r.I, ch=chgOf(I);
    r.p.textContent=fmtPx(I.p,I.d);
    r.c.textContent=fmtPct(ch,true);
    r.c.className='c '+((ch==null||ch>=0)?'up':'down');
    if(ch==null)r.c.className='c';
  });
  $$('[data-px]').forEach(el=>{ const I=bySym[el.dataset.px]; if(I) el.textContent=fmtPx(I.p,I.d); });
  $$('[data-chg]').forEach(el=>{
    const I=bySym[el.dataset.chg]; if(!I)return;
    const ch=chgOf(I);
    el.textContent=fmtPct(ch,true);
    const keep=el.className.split(/\s+/)
      .filter(c=>!['up','down','buy','sell','badge'].includes(c)).join(' ');
    const pre=keep?keep+' ':'';
    if(ch==null){ el.className=el.classList.contains('badge')?pre+'badge gray':keep; return; }
    el.className=el.classList.contains('badge')
      ? pre+'badge '+(ch>=0?'buy':'sell')
      : pre+(ch>=0?'up':'down');
  });
  $$('[data-pnl-ov]').forEach(el=>{
    const p=state.positions.find(x=>x.id===el.dataset.pnlOv);
    if(p){ const pl=posPl(p); el.textContent=fmtMoney(pl,true);
      const keep=el.className.split(/\s+/).filter(c=>!['up','down'].includes(c)).join(' ');
      el.className=keep+' '+(pl==null?'':(pl>=0?'up':'down')); }
  });
  if(state.view==='trade'){ updateTradeHeader(); durPreviewUpdate(); updateChartLevels(); }
  if(state.view==='markets') updateMarketStatusBadges();
  if(state.view==='news'){ updateNewsValidity(); updateNewsTimeline(); }
  if(state.view==='portfolio') updatePortfolioLive();
  if(state.view==='overview') updateKpis();
  paintLiveConfidence();
}

/* level watcher: SL / TP1 / TP2 with guidance notifications */
function checkStops(){
  if(!state.positions.length)return;
  state.positions.forEach(p=>{
    const I=bySym[p.sym]; if(!I||I.p==null)return;
    p.flags=p.flags||{};
    const px=I.p, dir=p.side==='BUY'?1:-1;
    /* Deriv binary: the stake is already fully committed — the maximum loss is the
       stake itself no matter what price does. A local stop can never reduce that,
       so it must never fake-close the position. It does two honest things instead:
       sell early IF Deriv unlocks resale, otherwise alert ONCE that the level hit. */
    if(isBinaryPos(p)){
      if(p.tp1&&!p.flags.tp1&&((p.side==='BUY'&&px>=p.tp1)||(p.side==='SELL'&&px<=p.tp1))){
        p.flags.tp1=true; save();
        notify('TP1 reached',LEVEL_GUIDE.tp1(p.sym,p.side,fmtPx(p.tp1,I.d)),{tag:'tp1',kind:'ok'});
      }
      const slHit=p.sl&&((p.side==='BUY'&&px<=p.sl)||(p.side==='SELL'&&px>=p.sl));
      const tp2Hit=p.tp2&&((p.side==='BUY'&&px>=p.tp2)||(p.side==='SELL'&&px<=p.tp2));
      if(slHit||tp2Hit){
        if(p.canSell!==false){
          /* sellability unknown or unlocked: attempt the REAL sell (early exit).
             If Deriv refuses, its handler marks the contract locked — no retry storm. */
          closeWithBroker(p,null,(slHit?'stop-loss hit':'TP2 reached')+' — closing this contract early now.');
        }else if(!p.flags.binAlerted){
          p.flags.binAlerted=true; save();
          notify((slHit?'Stop level crossed':'TP2 level reached'),
            p.sym+' hit your level, but this contract is Deriv-locked to expiry. Max loss is capped at your '+fmtMoney(p.buy_price||p.amt)+' stake — '+(slHit?'it rides and can still recover by settlement.':'the payout books automatically at settlement.'),
            {tag:'trade',kind:'warn'});
        }
      }
      return; /* binaries never follow the CFD stop path (no fake local closes) */
    }
    /* stop-loss */
    if(p.sl&&((p.side==='BUY'&&px<=p.sl)||(p.side==='SELL'&&px>=p.sl))){
      closeWithBroker(p,p.sl,LEVEL_GUIDE.sl(p.sym,p.side,fmtPx(p.sl,I.d)));
      return;
    }
    /* TP1: guidance only (move stop to entry), once */
    if(p.tp1&&!p.flags.tp1&&((p.side==='BUY'&&px>=p.tp1)||(p.side==='SELL'&&px<=p.tp1))){
      p.flags.tp1=true; save();
      notify('TP1 reached',LEVEL_GUIDE.tp1(p.sym,p.side,fmtPx(p.tp1,I.d)),{tag:'tp1',kind:'ok'});
      return;
    }
    /* TP2: guidance + take profit, once */
    if(p.tp2&&!p.flags.tp2&&((p.side==='BUY'&&px>=p.tp2)||(p.side==='SELL'&&px<=p.tp2))){
      p.flags.tp2=true; save();
      notify('TP2 reached',LEVEL_GUIDE.tp2(p.sym,p.side,fmtPx(p.tp2,I.d)),{tag:'tp2',kind:'ok'});
      closeWithBroker(p,p.tp2,LEVEL_GUIDE.tp2(p.sym,p.side,fmtPx(p.tp2,I.d)));
      return;
    }
    /* legacy single-TP field behaves as an auto take-profit */
    if(p.tp&&!p.tp1&&!p.tp2&&((p.side==='BUY'&&px>=p.tp)||(p.side==='SELL'&&px<=p.tp))){
      closeWithBroker(p,p.tp,'Take-profit '+fmtPx(p.tp,I.d)+' hit on '+p.sym+'.');
    }
  });
}

/* ---------- ticker ---------- */
const tickerRefs=[];
function buildTicker(){
  const track=$('#tickerTrack'); track.innerHTML='';
  const picks=INSTR.slice(0,14);
  tickerRefs.length=0;
  for(let copy=0;copy<2;copy++){
    picks.forEach(I=>{
      const el=document.createElement('span');
      el.className='tk-item';
      el.innerHTML='<span class="s"></span><span class="p"></span><span class="c"></span>';
      el.querySelector('.s').textContent=I.s;
      track.appendChild(el);
      tickerRefs.push({I, p:el.querySelector('.p'), c:el.querySelector('.c')});
    });
  }
}

/* ---------- daily motivation + today's best market to forecast ---------- */
const DESK_QUOTES=[
  {q:'The goal of a successful trader is to make the best trades. Money is secondary.',a:'Alexander Elder'},
  {q:'It is not whether you are right or wrong that matters \u2014 it is how much you make when you are right and how much you lose when you are wrong.',a:'George Soros'},
  {q:'Markets are never wrong \u2014 opinions often are.',a:'Jesse Livermore'},
  {q:'The trend is your friend.',a:'trading proverb'},
  {q:'Risk comes from not knowing what you are doing.',a:'Warren Buffett'},
  {q:'Cut your losses quickly and let your winners run.',a:'trading proverb'},
  {q:'Amateurs think about how much they can make. Professionals think about how much they can lose.',a:'trading proverb'},
  {q:'Trade what you see, not what you feel.',a:'trading proverb'},
  {q:'The market rewards patience and punishes haste.',a:'trading proverb'},
  {q:'Consistency compounds: one good day proves nothing, one good process proves everything.',a:'Shelricktech desk'}
];
function dailyQuote(){
  const n=new Date();
  const doy=Math.floor((n-new Date(n.getFullYear(),0,0))/86400000);
  return DESK_QUOTES[doy%DESK_QUOTES.length];
}
function quoteHtml(){
  const q=dailyQuote();
  return '\uD83D\uDCA1 <b>Motivation of the day:</b> \u201C'+escHtml(q.q)+'\u201D <span class="faint">\u2014 '+escHtml(q.a)+'</span>';
}
function welcomeText(){
  const h=new Date().getHours();
  return (h<12?'Good morning':h<18?'Good afternoon':'Good evening')+', trader';
}
function renderAuthDaily(){
  const w=document.getElementById('authWelcome');
  if(w)w.textContent=welcomeText();
  const m=document.getElementById('authMotivation');
  if(m)m.innerHTML=quoteHtml();
}
/* Today's best market. Two lines, because two kinds of reading reach this panel and
   their scores are not on one scale (src/bestpick.js):
     - the pick: the strongest BUY/SELL among the LIVE readings (1m/5m/1h), with the
       time it was read;
     - the daily index trend: the strongest daily index reading, with the day its
       newest bar belongs to. It is never ranked against the live markets. */
const BEST_PICK_INDICES=['NAS100','US30','SPX500'];
const BEST_PICK_EVERY_MS=10*60*1000;
let bestPick={at:0,item:null,daily:null,dailyRead:[],dailyUnread:'',busy:false,unread:'',readable:0,unreachable:0,blocked:0};
/* Reads the panel's markets once. It runs at start-up, on every tick of the 10-minute
   timer near the end of this file, and once more when the visitor enters the workspace:
   the timer is the schedule. (A second condition used to stand here, "at least 10 minutes
   since the last result". A tick comes 10 minutes after the previous read STARTED, a few
   seconds short of that, so every second tick was skipped and the panel was read every
   20 minutes.) */
async function refreshBestPick(){
  if(bestPick.busy)return;
  bestPick.busy=true; renderBestPick();
  const syms=INSTR.slice(0,6).map(I=>I.s).concat(BEST_PICK_INDICES);
  /* A scan answers with one reading per symbol and reports a market it could not read inside
     that reading. Should the scan itself fail, the panel is filled from an empty list. */
  let results=[];
  try{ results=await scanSignalsPreferred(syms); }catch(e){}
  bestPick.blocked=results.filter(r=>!r.error&&!String(r.tf||'').toUpperCase().includes('DAILY')&&isDirectionalCandidate(r)&&!isAsterPublishable(r)).length;
  const eligible=results.filter(r=>r.error||String(r.tf||'').toUpperCase().includes('DAILY')||isAsterPublishable(r));
  const pick=splitBestPick(eligible,BEST_PICK_INDICES);
  bestPick.item=pick.live; bestPick.daily=pick.daily; bestPick.dailyRead=pick.dailyRead;
  /* Cloud viewer: a market that could not be read (stale, no data, unavailable) is not a market
     without a setup. Each line reports its own unread markets when it has nothing to show.
     Readings of the PC app carry no such state, so the wording of its first line stays as it was. */
  const counts=summarizeReadings(pick.liveSide);
  bestPick.unread=scanIssuesText(counts); bestPick.readable=counts.live; bestPick.unreachable=counts.unavailable;
  /* An index that could not be read is said so on the daily line in both apps: this line
     is new, and an index missing from it without a word would read as "no direction". */
  const unreadIndices=pick.dailySide.filter(r=>r.error).length;
  bestPick.dailyUnread=unreadIndices?unreadIndices+' unavailable':'';
  bestPick.at=Date.now();
  try{ emitSignalAlerts(results); }catch(e){}
  bestPick.busy=false; renderBestPick();
}
/* Cloud viewer: the pick shown on the sign-in screen was read by the AURUM cloud
   alone (no connection to Deriv is opened there). Once the visitor is in the
   workspace it is read again, this time with this browser's own Deriv candles. */
function repickAfterEntering(){
  if(!isCloudflareReadonlyMode())return;
  if(bestPick.busy){ setTimeout(repickAfterEntering,1500); return; }
  refreshBestPick();
}
function isAsterPublishable(reading){
  return !!(reading && reading.aster && reading.aster.publishable === true && reading.aster.publicationBlocked !== true && reading.aster.publicationDecision !== 'BLOCK_PUBLICATION');
}
function isDirectionalCandidate(reading){return !!(reading && (reading.signal==='BUY'||reading.signal==='SELL'));}
const INDEX_ONLY=['NAS100','US30','SPX500','US100','NASDAQ'];
const INDEX_BADGE=' <span class="badge gray">index CFD · analysis only</span>';
const DAILY_TREND_NOTE='A once-a-day reading from daily closing prices. It changes only while the index\u2019s own market is open, and its score (50 + 8 per check) is not comparable with the live markets above.';
/* First line: the strongest live reading, or why there is none. */
function bestPickLiveHtml(){
  const it=bestPick.item;
  if(!it&&bestPick.blocked)return '<span class="tiny faint">ASTER withheld '+bestPick.blocked+' technical candidate(s). Required validation evidence is missing, unknown or not approved; no signal is published.</span>';
  if(!it&&!bestPick.unread)return '<span class="tiny faint">No directional setup right now \u2014 the pick appears the moment the live scan finds one.</span>';
  if(!it){
    /* Sign-in screen of the cloud viewer: every reading there is the cloud's (no connection to
       Deriv is opened before the visitor enters). Where the cloud could not reach the feed,
       the visitor is told who reads the markets next. A closed market gets no such sentence:
       entering does not open it. */
    const next=bestPick.unreachable&&!enteredWorkspace?' Inside the workspace this browser reads the live markets itself.':'';
    return '<span class="tiny faint">'+(bestPick.readable?'No directional setup in the live markets that could be read. Not read: ':'No live market could be read right now: ')+escHtml(bestPick.unread)+'. Nothing is estimated \u2014 the pick appears when the scan finds one.'+next+'</span>';
  }
  return '<b>'+escHtml(it.symbol)+'</b> <span class="badge '+(it.signal==='BUY'?'buy':'sell')+'">'+escHtml(it.signal)+'</span> <b>'+(Number(it.confidence)||0)+'%</b>'
    +(INDEX_ONLY.includes(it.symbol)?INDEX_BADGE:'')
    +' <span class="tiny faint">votes '+escHtml(it.votes||'\u2014')+' \u00b7 source: '+escHtml(it.data_source||it.source||'unavailable')+' \u00b7 '+timeStr(bestPick.at)+'</span>';
}
/* Second line: the daily index trend. Its label carries the day of the bar it comes from,
   where the reading says it (the PC app's local API does not). '' when the scan brought no
   daily index reading at all (the PC app with every index read live from MT5). */
function bestPickDailyHtml(){
  const d=bestPick.daily, read=bestPick.dailyRead||[], unread=bestPick.dailyUnread;
  const open='<div class="bp-daily" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border-soft)" title="'+escHtml(DAILY_TREND_NOTE)+'">';
  const label=day=>'Daily index trend'+(day?' \u00b7 '+escHtml(day):'');
  if(d)return open+'<span class="tiny faint">'+label(dailyBarText(d))+'</span> <b>'+escHtml(d.symbol)+'</b> <span class="badge gray">ASTER blocked · daily direction withheld</span>'
    +INDEX_BADGE
    +' <span class="tiny faint">votes '+escHtml(d.votes||'\u2014')+' \u00b7 source: '+escHtml(d.data_source||d.source||'unavailable')+'</span></div>';
  if(read.length)return open+'<span class="tiny faint">'+label(sharedDailyBarText(read))+': no direction on '+escHtml(read.map(r=>r.symbol).join(', '))+'.'+(unread?' Not read: '+escHtml(unread)+'.':'')+'</span></div>';
  if(unread)return open+'<span class="tiny faint">Daily index trend: not read right now ('+escHtml(unread)+'). Nothing is estimated.</span></div>';
  return '';
}
function renderBestPick(){
  for(const id of ['authBestBody','ovBest']){
    const el=document.getElementById(id); if(!el)continue;
    /* Only the very first scan shows a placeholder: a later one keeps the previous lines on
       screen until its own result replaces them. */
    if(bestPick.busy&&!bestPick.at){ el.innerHTML='<span class="tiny faint">Scanning live markets\u2026</span>'; continue; }
    el.innerHTML='<div class="bp-live">'+bestPickLiveHtml()+'</div>'+bestPickDailyHtml();
  }
}
function renderOvDaily(){
  const ov=document.getElementById('view-overview'); if(!ov)return;
  let d=document.getElementById('ovDaily');
  if(!d){ d=document.createElement('div'); d.id='ovDaily'; d.className='card'; d.style.cssText='padding:12px 16px;margin-bottom:14px';
    d.innerHTML='<div id="ovMotivation" class="tiny"></div><div id="ovBest" style="margin-top:6px"></div>';
    ov.prepend(d); }
  const om=document.getElementById('ovMotivation');
  if(om)om.innerHTML=quoteHtml();
}
/* ================================================================
   SIGNAL SCANNER (real technical scan on live candles, $0 AI)
   ================================================================ */
/* Cloud viewer: there is no local API to start, so a failed request is explained as what it is. */
function cloudAnalysisDownHtml(e){
  const full=String(e&&e.message||e||''), msg=full.slice(0,160), st=e&&e.signalState;
  /* A reading from the cloud viewer's scan explains its own state in a full sentence. */
  if(st==='stale'||st==='no-data'||st==='unavailable')return escHtml(full.slice(0,420).replace(/[.\s]+$/,''))+'. Nothing is estimated.'+(st==='stale'?'':' Try again in a minute.');
  return 'The AURUM cloud analysis service did not return live data'+(msg&&msg!=='fetch unavailable'?' ('+escHtml(msg)+')':'')+'. Nothing is estimated. Try again in a minute.';
}
/* Cloud viewer: "2 stale (market closed or feed paused) · 1 unavailable", or '' when every reading is live. */
function scanIssuesText(c){
  const parts=[];
  if(c&&c.stale)parts.push(c.stale+' stale (market closed or feed paused)');
  if(c&&c.noData)parts.push(c.noData+' with no data');
  if(c&&c.unavailable)parts.push(c.unavailable+' unavailable');
  return parts.join(' \u00b7 ');
}
async function scanSignals(){
  const grid=$('#sigGrid');
  if(!grid)return;
  state.scanStatus='loading';
  grid.innerHTML='<div class="empty"><b>Scanning live candles…</b>1m / 5m / 1h across the active universe.</div>';
  $('#sigStamp').textContent='Scanning…';
  try{
    const syms=INSTR.filter(I=>I.p!=null).slice(0,6).map(I=>I.s);
    const useSyms=(syms.length?syms:INSTR.slice(0,6).map(I=>I.s)).slice();
    ['NAS100','US30','SPX500'].forEach(ix=>{ if(!useSyms.includes(ix))useSyms.push(ix); }); /* daily index reads */
    const results=await scanSignalsPreferred(useSyms);
    state.mktScan=state.mktScan||{};
    results.forEach(r=>{if(r&&r.symbol)state.mktScan[r.symbol]=r;});
    const data={results};
    emitSignalAlerts(results);
    state.signals=(data.results||[]).filter(r=>!r.error);
    state.scanStatus=state.signals.length?'ready':'empty';
    state.scanIssues=scanIssuesText(summarizeReadings(results.filter(r=>r&&r.error&&signalState(r))));
    $('#sigStamp').textContent='Updated '+timeStr(Date.now())+' · technical · live candles'+(state.scanIssues?' · '+state.scanIssues:'');
    const c=$('#navSigCount'); if(c)c.textContent=state.signals.length;
    renderSignals();
    if(state.view==='overview') renderOverview();
  }catch(e){
    state.scanStatus='error';
    grid.innerHTML='<div class="empty"><b>Live scan unavailable</b>'+(isCloudflareReadonlyMode()?cloudAnalysisDownHtml(e):(String(e.message||e)==='fetch unavailable'?'The API server is not running.':'Could not reach the local API. Start it with <code>npm run api</code>.'))+'</div>';
    $('#sigStamp').textContent='Scan failed '+timeStr(Date.now());
    const c=$('#navSigCount'); if(c)c.textContent='0';
  }
}
function renderSignals(){
  const g=$('#sigGrid'); if(!g)return;
  if(state.scanStatus==='loading')return;
  if(state.scanStatus==='error'){ return; }
  if(!state.signals.length){
    g.innerHTML=state.scanIssues
      ?'<div class="empty"><b>No live readings right now</b>'+escHtml(state.scanIssues)+'. Nothing is estimated — press refresh to check again.</div>'
      :'<div class="empty"><b>No signals right now</b>Live scan returned no setups — press refresh.</div>';
    return;
  }
  g.innerHTML='';
  state.signals.forEach(sig=>{
    const I=bySym[sig.symbol]||{n:sig.symbol,d:4};
    const approved=isAsterPublishable(sig),directional=isDirectionalCandidate(sig);
    const cls=approved?(sig.signal==='BUY'?'buy':sig.signal==='SELL'?'sell':'neutral'):'neutral';
    const card=document.createElement('div');
    card.className='sig-card';
    card.innerHTML=
      '<div class="sig-top">'+
        '<div class="row"><div class="sym-avatar"></div>'+
        '<div><div class="sym-name"></div><div class="sym-full"></div></div></div>'+
        '<span class="badge '+cls+'"></span>'+
      '</div>'+
      '<div class="row between"><span class="tiny muted">Confidence</span><b class="mono"></b></div>'+
      '<div class="conf-bar"><i></i></div>'+
      '<div class="tiny faint sig-live" style="margin-top:6px;line-height:1.45"></div>'+
      '<div class="tiny faint sig-measured" style="margin-top:4px;line-height:1.45"></div>'+
      '<div class="sig-levels">'+
        '<div><div class="k">Entry</div><div class="v" data-l="e"></div></div>'+
        '<div><div class="k">Stop</div><div class="v down" data-l="s"></div></div>'+
        '<div><div class="k">Target</div><div class="v up" data-l="t"></div></div>'+
      '</div>'+
      '<p class="sig-why"></p>'+
      '<div class="tiny faint sig-pro" style="margin:7px 0 3px;line-height:1.55"></div>'+
      '<div class="tiny faint sig-aster" style="margin-bottom:8px;line-height:1.5"></div>'+
      '<div class="row"><button class="btn sm grow sig-chart">Open chart</button><button class="btn primary sm grow sig-use">Use setup</button></div>';
    card.querySelector('.sym-avatar').textContent=sig.symbol.replace(/[^A-Z0-9]/g,'').slice(0,3);
    card.querySelector('.sym-name').textContent=sig.symbol;
    card.querySelector('.sym-full').textContent=I.n;
    card.querySelector('.badge').textContent=directional&&!approved?'ASTER BLOCKED':sig.signal;
    const cb=card.querySelector('.conf-bar i');
    const score=approved?liveScore(sig):null; cb.style.width=(score||0)+'%'; if(approved)setLiveData(cb,sig,'Bar');
    const cv=card.querySelector('.row.between b'); cv.textContent=approved?score+'%':'WITHHELD'; if(approved)setLiveData(cv,sig,'Conf');
    const cn=card.querySelector('.sig-live'); cn.textContent=directional&&!approved?'Technical candidate withheld: ASTER has not approved publication.':liveNoteFor(sig); if(approved)setLiveData(cn,sig,'Note');
    card.querySelector('.sig-measured').textContent=approved?measuredText(sig):'';
    card.querySelector('[data-l="e"]').textContent=approved?fmtPx(sig.entry,I.d):'—';
    card.querySelector('[data-l="s"]').textContent=approved?fmtPx(sig.stop_loss,I.d):'—';
    card.querySelector('[data-l="t"]').textContent=approved?fmtPx(sig.tp1,I.d):'—';
    card.querySelector('.sig-why').textContent=(directional&&!approved?'Multi-timeframe direction withheld by ASTER.':String(sig.mtf_signal||'').replace(/_/g,' ').toLowerCase())+' · '+sig.tf+' · source: '+String(sig.data_source||sig.source||'unavailable')+(closeText(sig)?' · read at the '+closeText(sig)+' candle close':'');
    const ps=sig.pro_scalper, pi=ps&&ps.indicators, proEl=card.querySelector('.sig-pro');
    if(ps&&ps.ok&&pi){
      const k=pi.stochasticRsi, ic=pi.ichimoku, vp=pi.volumeProfile;
      const cloud=ic?(ic.spanA>ic.spanB?'bullish':'bearish'):'—';
      proEl.textContent='PRO SCALPER · Stoch RSI '+(k?k.k.toFixed(1)+' / '+k.d.toFixed(1):'—')+' · CCI '+(Number.isFinite(pi.cci)?pi.cci.toFixed(1):'—')+' · Williams %R '+(Number.isFinite(pi.williamsR)?pi.williamsR.toFixed(1):'—')+' · Supertrend '+(pi.supertrend?.direction||'—')+' · Ichimoku '+cloud+' · Keltner '+(pi.keltner?pi.keltner.mid.toFixed(I.d):'—')+' · AVWAP '+(pi.anchoredVwap?pi.anchoredVwap.value.toFixed(I.d):'anchor not configured')+(ps.dataQuality?.volumeAvailable?' · OBV '+(Number.isFinite(pi.obv)?pi.obv.toFixed(0):'—')+' · MFI '+(Number.isFinite(pi.mfi)?pi.mfi.toFixed(1):'—')+' · VP POC '+(vp?vp.poc.toFixed(I.d):'—'):' · OBV/MFI/VP unavailable: real volume missing');
    }else proEl.textContent='PRO SCALPER · unavailable: '+String(ps?.status||'verified M5 candle snapshot not supplied').replaceAll('_',' ').toLowerCase();
    const ag=sig.aster, asterEl=card.querySelector('.sig-aster');
    asterEl.textContent='ASTER · '+(ag?.publishable===true?'READY FOR MANUAL REVIEW':ag?.status==='NOT_VALIDATED'?'NOT VALIDATED · publication blocked':'BLOCKED · '+String(ag?.status||'missing evidence'))+(ag?.rejectionReasons?.length?' · '+ag.rejectionReasons.slice(0,2).join('; '):'');
    card.querySelector('.sig-chart').onclick=()=>openSignalSymbol(sig.symbol);
    const useButton=card.querySelector('.sig-use');
    useButton.hidden=!(approved&&directional);
    if(approved&&directional)useButton.onclick=()=>{
      state.side=sig.signal==='SELL'?'SELL':'BUY';
      $('#orderSL').value=sig.stop_loss!=null?Number(sig.stop_loss).toFixed(I.d):'';
      $('#orderTP').value=sig.tp1!=null?Number(sig.tp1).toFixed(I.d):'';
      $('#orderTP2').value=sig.tp2!=null?Number(sig.tp2).toFixed(I.d):'';
      openSignalSymbol(sig.symbol); if(INSTRUMENT_MAP[sig.symbol])syncSide();
      toast('Setup loaded','Levels for '+sig.symbol+' applied to the ticket.','ok');
    };
    g.appendChild(card);
  });
}
$('#refreshSigs').onclick=()=>{ if(hostedScannerInstance)hostedScannerInstance.retryBrowser(); scanSignals(); }; /* cloud viewer: a refresh asked for by a person tries this browser's Deriv connection again */

/* ================================================================
   NEWS (TradingView widgets + Perplexity brief)
   ================================================================ */
async function fetchNewsBrief(){
  const body=$('#newsAiBody'), btn=$('#newsBriefBtn');
  if(!body)return;
  if(!hasAnyKey()){ body.innerHTML='<p class="hint">No AI key yet — add ANY of <b>Perplexity, Claude (Anthropic) or ChatGPT (OpenAI)</b> in <b>Settings → AI engines</b>, then press Get brief.</p>'; return; }
  btn.disabled=true; btn.textContent='Fetching…';
  body.innerHTML='<p class="hint">Asking the AI engine for current drivers and expected outcomes on '+state.chart.sym+'…</p>';
  try{
    const res=await api('/api/news/expectations',{method:'POST',body:{symbol:state.chart.sym},headers:keyHeaders()});
    if(!res.ok){ const e=await res.json().catch(()=>({})); throw new Error(e.detail||e.error||('API '+res.status)); }
    const data=await res.json();
    body.innerHTML='';
    const p=document.createElement('p');
    p.className='small muted'; p.style.lineHeight='1.65'; p.textContent=data.brief;
    body.appendChild(p);
    const meta=document.createElement('div');
    meta.className='tiny faint'; meta.textContent=(data.engine||'ai')+' · '+data.model+' · '+timeStr(data.ts);
    body.appendChild(meta);
    const wa=document.createElement('button');
    wa.className='btn sm ghost'; wa.style.marginTop='8px';
    wa.textContent='↗ Send brief to WhatsApp';
    wa.onclick=()=>{
      const d=waDigits();
      if(!d){ toast('WhatsApp number missing','Add it in Settings — stays on this device.','err'); return; }
      window.open('https://wa.me/'+d+'?text='+encodeURIComponent('📰 '+state.chart.sym+' brief ('+data.engine+')\n\n'+data.brief+'\n\nAI — not advice.'),'_blank','noopener');
    };
    body.appendChild(wa);
    pushWA('📰 '+state.chart.sym+' brief ('+data.engine+')\n\n'+data.brief+'\n\nAI — not advice.');
    notify('News brief ready',state.chart.sym+' — drivers, expectations and risks ('+(data.engine||'ai')+'). Sent to WhatsApp if auto-send is on.',{tag:'news',kind:'ok'});
  }catch(e){
    body.innerHTML='';
    const p=document.createElement('p');
    p.className='hint'; p.textContent='Brief unavailable: '+String(e.message||e);
    if(/no_perplexity_key|no_ai_key/.test(String(e.message||e)))p.textContent='Brief unavailable: add ANY of Perplexity / Claude / ChatGPT key in Settings → AI engines.';
    body.appendChild(p);
    toast('News brief failed',String(e.message||e),'err');
  }finally{ btn.disabled=false; btn.textContent='Get brief'; }
}
$('#newsBriefBtn').onclick=fetchNewsBrief;

/* ================================================================
   MARKETS TABLE (live only)
   ================================================================ */
function sparkSvg(I){
  const h=I.hist.slice(-30);
  if(h.length<2)return '<svg class="spark" width="64" height="22" viewBox="0 0 64 22" aria-hidden="true"></svg>';
  const mn=Math.min(...h), mx=Math.max(...h), rg=(mx-mn)||1;
  const pts=h.map((v,i)=>(i/(h.length-1)*62).toFixed(1)+','+(20-((v-mn)/rg)*18-1).toFixed(1)).join(' ');
  const ch=chgOf(I);
  const up=ch==null||ch>=0;
  return '<svg class="spark" width="64" height="22" viewBox="0 0 64 22" aria-hidden="true"><polyline points="'+pts+'" fill="none" stroke="'+(up?'var(--green)':'var(--red)')+'" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}
/* ---- Markets SIGNAL column: powered by the REAL scanner (MTF 1m/5m/1h) ---- */
state.mktScan = state.mktScan || {};      // symbol -> scan result
let mktScanBusy = false;
let mktScanAt = 0;
function marketCandleFresh(value,maxAgeMs){const n=Number(value),ms=n>1e12?n:n*1000,age=Date.now()-ms;return Number.isFinite(ms)&&ms>0&&age>=0&&age<=maxAgeMs;}
function signalPriceFromQuote(q){
  const bid=Number(q&&q.bid),ask=Number(q&&q.ask);
  if(bid>0&&ask>0)return (bid+ask)/2;
  if(bid>0)return bid;if(ask>0)return ask;
  return null;
}
async function exnessSignalFor(I,includeCandles=false){
  if(state.broker?.type!=='mt5')throw new Error('Exness MT5 bridge is not connected in this tab.');
  const [m1,m5,h1,qr]=await Promise.all([
    bridge.bridgeHistory(I.s,'M1',120),bridge.bridgeHistory(I.s,'M5',120),bridge.bridgeHistory(I.s,'H1',120),bridge.quoteBridge([I.s])
  ]);
  const sets={m1:m1&&m1.candles,m5:m5&&m5.candles,h1:h1&&h1.candles};
  if(!sets.m1||!sets.m5||!sets.h1)throw new Error('Exness MT5 did not return all required M1/M5/H1 candles.');
  const q=qr&&qr.quotes&&qr.quotes[0],price=signalPriceFromQuote(q);
  if(!q||!(price>0)||!marketCandleFresh(q.time,120000))throw new Error('No fresh Exness MT5 quote for '+I.s+'.');
  /* Finished candles only, as of the last 5-minute close (closedcandles.js). The freshness checks below are about
     the feed, so they keep looking at the newest candles it returned. */
  const closed=closedCandleSets(sets);
  const det=runDeterministicAnalysis(I.s,closed.sets),short=['m1','m5','h1'].find(k=>det.analyses[k].error);
  if(short){const a=det.analyses[short];throw new Error('Exness '+a.timeframe+' history: '+(a.have||0)+'/'+(a.required||50)+' verified candles.');}
  if(!closed.current)throw new Error(RESUMED_NOTE('Exness '+I.s));
  const newest={m1:sets.m1.at(-1),m5:sets.m5.at(-1),h1:sets.h1.at(-1)};
  const limits={m1:180000,m5:660000,h1:7260000};
  const stale=['m1','m5','h1'].find(k=>!newest[k]||!marketCandleFresh(newest[k].time,limits[k]));
  if(stale)throw new Error('Exness latest '+({m1:'M1',m5:'M5',h1:'H1'}[stale])+' candle is stale.');
  const dec=localDecision(det),wr=dec.signal==='WAIT'?waitReason(det,{maxAgeSec:3*3600+300}):null;
  const proScalperRaw=buildProScalperSnapshot(closed.sets.m5||[]);
  const proKeys=['stochasticRsi','cci','williamsR','supertrend','ichimoku','keltner'];
  const proMissing=proKeys.filter(key=>{const v=proScalperRaw.indicators&&proScalperRaw.indicators[key];return v==null||(typeof v==='object'?Object.values(v).some(x=>x==null||(typeof x==='number'&&!Number.isFinite(x))):typeof v==='number'&&!Number.isFinite(v));});
  const proScalper=Object.assign({},proScalperRaw,{validation:{priceIndicatorsValid:proScalperRaw.ok===true&&proMissing.length===0,missingPriceIndicators:proMissing,mode:'deterministic-candle-snapshot'}});
  return {symbol:I.s,price,signal:dec.signal,bias:dec.bias,confidence:dec.confidence,entry:dec.entry,stop_loss:dec.stop_loss,tp1:dec.tp1,tp2:dec.tp2,rrr:dec.rrr,mtf_signal:det.mtfSignal,data_ok:true,votes:votesSummary(det.analyses),wait_reason:wr&&wr.code,wait_detail:wr&&wr.detail,tf:'MTF 1m/5m/1h',model:'technical-exness',source:'Exness MT5 local candles',data_source:'Exness MT5 local candles · '+String(q.symbol||I.s),latest_candle_time:newest.m1.time,candle_close:closed.close,pro_scalper:proScalper,aster:{status:'NOT_VALIDATED',publishable:false,publicationBlocked:true,publicationDecision:'BLOCK_PUBLICATION',rejectionReasons:['This technical-only read does not include the complete ASTER evidence set.']},ts:Date.now(),fallback:false,...(includeCandles?{candle_sets:sets}: {})};
}
function fallbackSourceFor(r){
  if(r&&r.source)return String(r.source);
  return ['US30','NAS100','SPX500'].includes(String(r&&r.symbol||''))?'Yahoo Finance public daily data':'Deriv public candles';
}
/* One request per 14 symbols to the AURUM signal API: the local server on a PC, the read-only Worker when hosted. */
async function apiSignalScan(symbols){
  const found=new Map();
  for(let i=0;i<symbols.length;i+=14){
    const chunk=symbols.slice(i,i+14);
    const res=await api('/api/signals/scan',{method:'POST',body:{symbols:chunk},timeoutMs:30000});
    const j=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(j.detail||j.error||('fallback scan HTTP '+res.status));
    for(const r of j.results||[])found.set(r.symbol,r);
  }
  return found;
}
/* ---- Cloud viewer: who analyses what ----
   Deriv-backed markets are analysed in THIS BROWSER from Deriv's public
   candles (src/derivhistory.js + src/hostedscan.js). Index CFDs come from the
   AURUM cloud, which is also the labelled fallback when this browser cannot
   reach Deriv. Every reading carries an explicit state: live, daily, stale,
   no-data or unavailable. None of this runs in the PC app. */
let hostedScannerInstance=null;
/* True from the moment the visitor enters the workspace: the first statement of
   boot() sets it, before the workspace starts its first scan. */
let enteredWorkspace=false;
function hostedSignalBatch(symbols){
  if(!hostedScannerInstance)hostedScannerInstance=createHostedScanner({
    fetchCandles:(symbol,granularity,count)=>candleHistory.fetchCandles(symbol,granularity,count),
    cloudScan:apiSignalScan,
    feedClock:()=>feed.feedClock(),
    onScan:noteHostedScan
  });
  /* The sign-in screen opens no connection to Deriv: until the visitor has
     entered the workspace, every reading is asked of the AURUM cloud. From then
     on this browser reads the Deriv markets itself, including in the scan that
     boot() starts before it wires the price feed. */
  return hostedScannerInstance.scan(symbols,{browser:enteredWorkspace});
}
/* Diagnostics for the cloud viewer's scans: counts, states and reasons only.
   Market names and error text; never a token, an account detail or a header. */
const hostedDiag={scans:0,last:null,troubleKey:''};
function noteHostedScan(report){
  hostedDiag.scans+=1; hostedDiag.last=report;
  /* A closed market is a normal state, not a fault: only missing or unreachable data is logged,
     and only when the set of affected markets changes, not once per scan. */
  const trouble=report.problems.filter(x=>x.state!=='stale');
  const key=trouble.map(x=>x.symbol+':'+x.state).join('|');
  if(key===hostedDiag.troubleKey)return;
  hostedDiag.troubleKey=key;
  if(!trouble.length||typeof console==='undefined'||!console.warn)return;
  console.warn('[aurum] '+JSON.stringify({event:'hosted_scan_trouble',at:new Date(report.at).toISOString(),ms:report.ms,
    live:report.live,daily:report.daily,stale:report.stale,noData:report.noData,unavailable:report.unavailable,
    inBrowser:report.browser,fromCloud:report.cloud,usedBrowser:report.usedBrowser,browserPaused:report.browserPaused,askedCloudForDeriv:report.askedCloudForDeriv,problems:trouble.slice(0,26),candles:candleHistory.stats()}));
}
/* Support read-out, typed into the browser console: what the last scan found and how the candle connection is doing. */
window.__aurumDiagnostics=()=>({hosted:isCloudflareReadonlyMode(),feed:feed.feedStatus(),lastTickAt:feed.lastTickAt(),scans:hostedDiag.scans,lastScan:hostedDiag.last,candles:candleHistory.stats()});
async function fallbackSignalBatch(symbols,reason){
  if(await isCloudflareHostedApp())return hostedSignalBatch(symbols);
  const found=await apiSignalScan(symbols);
  return symbols.map(symbol=>{
    const r=found.get(symbol);
    if(!r)return {symbol,error:'FEED_ERROR',detail:'No fallback result returned for '+symbol+'.',source:'unavailable',data_source:'unavailable'};
    /* The PC's server reads at the 5-minute close, as the cloud does (closedcandles.js). A market that has just
       resumed after a pause has no reading yet: the server sends a row without one (server/app.js, resumedAnswer),
       and a reading that is only marked candle_current:false is withheld here. Either way the row is the cloud's.
       A history without a finished 5-minute candle is not a pause: that answer is a WAIT which says so, and stays one. */
    const withheld=withheldReading(r);
    if(withheld)return withheld;
    const label=fallbackSourceFor(r)+' · fallback (Exness unavailable: '+reason+')';
    return Object.assign({},r,{source:label,data_source:label,fallback:true,fallback_reason:reason});
  });
}
async function scanSignalsPreferred(symbols){
  const unique=[...new Set((symbols||[]).map(s=>String(s||'').toUpperCase().trim()).filter(Boolean))];
  if(!unique.length)return [];
  const exness=new Map(),missed=[];
  if(state.broker?.type==='mt5'){
    for(let i=0;i<unique.length;i+=2){
      await Promise.all(unique.slice(i,i+2).map(async symbol=>{
        const I=bySym[symbol];
        if(!I){missed.push({symbol,reason:'Symbol is not in the AURUM catalogue.'});return;}
        try{exness.set(symbol,await exnessSignalFor(I));}
        catch(e){missed.push({symbol,reason:String(e&&e.message||e).slice(0,120)});}
      }));
    }
  }else unique.forEach(symbol=>missed.push({symbol,reason:isCloudflareReadonlyMode()?'Exness is available only in the PC app.':'Exness bridge is not connected in this tab.'}));
  let fallback=[];
  if(missed.length){
    try{fallback=await fallbackSignalBatch(missed.map(x=>x.symbol),missed.length===unique.length?missed[0].reason:'one or more Exness symbols had no fresh data');}
    catch(e){
      const msg='Fallback signal service unavailable: '+String(e&&e.message||e).slice(0,120);
      fallback=missed.map(x=>({symbol:x.symbol,error:'FEED_ERROR',detail:x.reason+' · '+msg,source:'unavailable',data_source:'unavailable'}));
    }
  }
  const all=new Map([...exness.entries(),...fallback.map(r=>[r.symbol,r])]);
  const out=unique.map(symbol=>all.get(symbol)||{symbol,error:'FEED_ERROR',detail:'No verified signal data.',data_source:'unavailable'});
  out.forEach(r=>signalRuns.observe(r)); /* live confidence: a BUY/SELL reading is followed from here on */
  return out;
}
function emitSignalAlerts(results){
  for(const r of results||[]){
    if(!r||r.error)continue;
    const symbol=String(r.symbol||'');
    if(!symbol)continue;
    if(atTimer&&sniperWatchSymbols.has(symbol))continue; /* watched markets use the dedicated Sniper entry/exit alerts */
    const source=String(r.data_source||r.source||'source unavailable');
    const approved=isAsterPublishable(r),directional=isDirectionalCandidate(r);
    const signal=directional&&!approved?'ASTER_BLOCKED':String(r.signal||'WAIT');
    const digits=(bySym[symbol]&&bySym[symbol].d)||2;
    const level=(key)=>{const n=Number(r[key]);return Number.isFinite(n)&&n>0?fmtPx(n,digits):'—';};
    const fingerprint=[signal,source,'levels-v1'].join('|');
    const key='signalAlert_'+symbol,previous=store.get(key,'');
    if(previous===fingerprint)continue;
    store.set(key,fingerprint);
    if(approved&&(signal==='BUY'||signal==='SELL')){
      const details='Market: '+symbol+' · '+signal+' '+(Number(r.confidence)||0)+'% ('+(r.tf||'technical scan')+')\nEntry reference: '+level('entry')+' · SL: '+level('stop_loss')+' · TP1: '+level('tp1')+' · TP2 / exit reference: '+level('tp2')+'\nSource: '+source+'\nAnalysis only — no order was placed. Verify current price and spread before acting.'+(measuredLine(r)?'\n'+measuredLine(r):'');
      notify('Signal update · '+symbol,details,{tag:'signal-'+symbol+'-'+signal,kind:signal==='BUY'?'ok':'warn'});
    }else if(previous&&(String(previous).startsWith('BUY|')||String(previous).startsWith('SELL|'))){
      notify('Signal withdrawn · '+symbol,signal==='ASTER_BLOCKED'?'ASTER did not approve publication. The technical candidate is withheld until every required check passes. Source: '+source+'.':'The latest scan is WAIT. Source: '+source+'. Recheck before acting.',{tag:'signal-'+symbol+'-wait',kind:'warn'});
    }
  }
}
async function localMarketScan(I){
  try{return (await scanSignalsPreferred([I.s]))[0];}
  catch(e){return {symbol:I.s,error:'FEED_ERROR',detail:String(e&&e.message||e).slice(0,140),data_source:'unavailable'};}
}
async function localMarketsFallback(){
  const results=[];
  for(let i=0;i<INSTR.length;i+=8){
    const batch=await scanSignalsPreferred(INSTR.slice(i,i+8).map(I=>I.s));
    batch.forEach(r=>{state.mktScan[r.symbol]=r;results.push(r);});
    if(state.view==='markets')renderMarkets(true);
  }
  return results;
}
async function mktScanRefresh(force){
  if(mktScanBusy) return;
  if(!force && Date.now()-mktScanAt < 90*1000) return;
  mktScanBusy = true;
  try{
    const results=await scanSignalsPreferred(INSTR.map(I=>I.s));
    results.forEach(r=>{state.mktScan[r.symbol]=r;});
    state.mktScanFailed=!results.some(r=>!r.error);
    if(results.length){mktScanAt=Date.now();if(state.view!=='sniper')emitSignalAlerts(results);}
    if(state.view==='markets') renderMarkets(true);
    if(state.view==='news') paintNewsReadings();
    if(state.view==='sniper'){renderSniperMarketList();renderSniperSelectedDetail();renderSniperSignalAlerts(results,new Set());}
  }catch(e){state.mktScanFailed=true;if(state.view==='markets')renderMarkets(true);}
  finally{mktScanBusy=false;}
}
function scanLevelsHtml(I){
  const r=state.mktScan[I.s];
  if(!r||r.error)return '';
  const f=(v)=>Number.isFinite(Number(v))?Number(v).toFixed(I.d):null;
  /* Entry, stop and targets belong to a Buy or Sell reading only. A Wait carries placeholder numbers
     (always a stop below and targets above the price, whichever way the market leans): they are not shown. */
  if(!isAsterPublishable(r)||(r.signal!=='BUY'&&r.signal!=='SELL'))return '';
  const e=f(r.entry), sl=f(r.stop_loss), t1=f(r.tp1), t2=f(r.tp2);
  if(!e&&!sl)return '';
  return '<div class="tiny market-levels mono" title="Entry '+(e||'—')+' · Stop loss '+(sl||'—')+' · Take profit 1 '+(t1||'—')+(t2?' · Take profit 2 '+t2:'')+'" style="margin-top:3px;white-space:nowrap">'
    +'<span class="faint">E</span> '+(e||'\u2014')
    +' \u00b7 <span style="color:var(--red)">SL</span> '+(sl||'\u2014')
    +' \u00b7 <span style="color:var(--green)">TP1</span> '+(t1||'\u2014')
    +(t2?' \u00b7 <span style="color:var(--green)">TP2</span> '+t2:'')
    +'</div>';
}
function signalBadge(I){
  const r=state.mktScan[I.s];
  if(r){
    if(r.error){
      /* Cloud viewer states: stale (market closed or feed paused — a retry cannot help), no data, feed unavailable. */
      const st=signalState(r);
      if(st==='stale')return '<span class="badge gray" title="'+escHtml(r.detail||'')+'">Stale data</span>';
      return '<span class="badge gray" title="'+escHtml(r.detail||'No verified candle data; analysis resumes when a supported feed is available.')+'">'+(st==='unavailable'?'Feed unavailable':'No data')+' <button type="button" class="btn sm ghost msig-retry" aria-label="Retry scan for '+escHtml(I.s)+'" style="padding:0 5px;margin-left:4px">Retry</button></span>';
    }
    const v=escHtml(r.votes||'');
    const partial=r.data_ok===false?' (some timeframes lack data — not confirmable)':'';
    if(isDirectionalCandidate(r)&&!isAsterPublishable(r))return '<span class="badge gray" title="Technical candidate withheld because ASTER has not approved publication.">ASTER blocked</span>';
    if(r.signal==='BUY')  return '<span class="badge buy" title="ASTER approved · MTF confirmed — '+v+'">Buy '+liveScoreHtml(r,'span')+'</span>';
    if(r.signal==='SELL') return '<span class="badge sell" title="ASTER approved · MTF confirmed — '+v+'">Sell '+liveScoreHtml(r,'span')+'</span>';
    if(r.bias==='bullish'&&!isAsterPublishable(r))return '<span class="badge gray" title="Directional bias is withheld until ASTER validates the evidence.">ASTER pending</span>';
    if(r.bias==='bullish') return '<span class="badge lean lean-up" title="ASTER approved · direction leans up but timeframes are not fully confirmed'+partial+' — '+v+'">▲ Lean up</span>';
    if(r.bias==='bearish'&&!isAsterPublishable(r))return '<span class="badge gray" title="Directional bias is withheld until ASTER validates the evidence.">ASTER pending</span>';
    if(r.bias==='bearish')return '<span class="badge lean lean-dn" title="ASTER approved · direction leans down but timeframes are not fully confirmed'+partial+' — '+v+'">▼ Lean down</span>';
    const wr=r.wait_reason?(' ['+r.wait_reason+']'):'';
    const short={MTF_CONFLICT:'TFs disagree',MTF_NO_ALIGNMENT:'no alignment',MTF_LEAN_NOT_CONFIRMED:'lean unconfirmed',INSUFFICIENT_CANDLES:'data short',STALE_DATA:'stale feed',FEED_ERROR:'feed error'}[r.wait_reason]||'';
    return '<span class="badge wait" title="Wait'+wr+partial+' — '+(r.wait_detail||('no alignment — '+v))+'">Wait'+(short?' · '+escHtml(short):'')+'</span>';
  }
  if(state.mktScanFailed) return '<span class="badge gray">Scan unavailable <button type="button" class="btn sm ghost msig-retry" style="padding:0 8px;margin-left:6px">Retry</button></span>';
  return '<span class="badge gray">Scanning…</span>'; /* first scan in flight — honest, never a dead ellipsis */
}
function signalSourceHTML(I){const r=state.mktScan[I.s];return r?'<div class="tiny faint" style="margin-top:3px">source: '+escHtml(r.data_source||r.source||'unavailable')+'</div>':'';}
/* Cloud viewer: one line that says how many markets are live, stale, without data or unavailable. */
function renderMarketScanStatus(){
  const el=document.getElementById('mktScanStatus'); if(!el)return;
  const rows=isCloudflareReadonlyMode()?INSTR.map(I=>state.mktScan[I.s]).filter(r=>r&&signalState(r)):[];
  if(!rows.length){ el.classList.add('hidden'); return; }
  const c=summarizeReadings(rows), parts=[];
  if(c.live)parts.push(c.live+' live');
  if(c.daily)parts.push(c.daily+' daily index reading'+(c.daily===1?'':'s'));
  if(c.stale)parts.push(c.stale+' stale (market closed or feed paused)');
  if(c.noData)parts.push(c.noData+' with no data');
  if(c.unavailable)parts.push(c.unavailable+' unavailable');
  const text='Signal column: '+parts.join(' \u00b7 ')+(mktScanAt?' \u00b7 scanned '+timeStr(mktScanAt):'')+'. Deriv markets are analysed in this browser from Deriv public candles; index readings come from the AURUM cloud. Nothing is estimated.';
  if(el.textContent!==text)el.textContent=text;
  el.classList.remove('hidden');
}
const strength=I=>{ const ch=chgOf(I); return ch==null?-1:Math.abs(ch); };
function shortActiveWindow(inst){
  const full=typicalActiveWindow(inst);
  if(full.includes('London–New York overlap'))return 'LDN/NY · ~16–20 EAT';
  if(full.includes('Asia/Tokyo'))return 'Asia · ~03–09 EAT';
  if(full.includes('London session'))return 'London · ~10–19 EAT';
  if(full.includes('US cash-session'))return 'US open · 16:30/17:30 EAT';
  if(full.includes('European cash-session'))return 'Europe open · ~10 EAT';
  if(full.includes('London cash-session'))return 'London open · ~10–11 EAT';
  if(full.includes('24/7 synthetic'))return '24/7 · no fixed session';
  if(full.includes('24/7 availability'))return '24/7 · activity varies';
  if(full.includes('overlapping London/US'))return 'London/US · ~16–20 EAT';
  return 'Broker hours vary';
}
function renderMarkets(soft){
  if(!soft||!$('#mktBody').children.length){
    let rows=INSTR.filter(I=>
      (state.mkt.cat==='all'||I.c===state.mkt.cat)&&
      (!state.mkt.q||I.s.toLowerCase().includes(state.mkt.q)||I.n.toLowerCase().includes(state.mkt.q))
    );
    if(state.mkt.sort==='change_desc') rows.sort((a,b)=>(chgOf(b)??-999)-(chgOf(a)??-999));
    else if(state.mkt.sort==='change_asc') rows.sort((a,b)=>(chgOf(a)??999)-(chgOf(b)??999));
    else if(state.mkt.sort==='name') rows.sort((a,b)=>a.n.localeCompare(b.n));
    else rows.sort((a,b)=>strength(b)-strength(a));
    const body=$('#mktBody'); body.innerHTML='';
    rows.forEach(I=>{
      const ch=chgOf(I);
      const tr=document.createElement('tr');
      const pinned=state.watchlist.some(w=>w.id===I.s);
      tr.innerHTML=
        '<td><div class="sym-cell"><button type="button" class="watch-pin'+(pinned?' on':'')+'" data-sym="'+I.s+'" title="Pin to watchlist" aria-label="Pin '+I.s+' to watchlist">'+(pinned?'★':'☆')+'</button>'+
        '<div class="sym-avatar">'+I.s.replace(/[^A-Z0-9]/g,'').slice(0,3)+'</div>'+
        '<div class="mkt-symbol-text" title="'+escHtml(I.n+' · '+typicalActiveWindow(I))+'"><div class="sym-name">'+I.s+' <span class="badge gray" data-mstat="'+I.s+'" style="font-size:9px;padding:1px 5px;vertical-align:middle">…</span></div><div class="sym-full">Typical: '+escHtml(shortActiveWindow(I))+'</div></div></div></td>'+
        '<td class="num mono" data-px="'+I.s+'">'+fmtPx(I.p,I.d)+'</td>'+
        '<td class="num mono '+(ch==null?'':(ch>=0?'up':'down'))+'" data-chg="'+I.s+'">'+fmtPct(ch,true)+'</td>'+
        '<td class="num">'+sparkSvg(I)+'</td>'+
        '<td data-msig="'+I.s+'">'+signalBadge(I)+scanLevelsHtml(I)+signalSourceHTML(I)+'</td>'+
        '<td class="num"><button class="btn sm mkt-trade" data-sym="'+I.s+'">Trade</button></td>';
      body.appendChild(tr);
    });
    updateMarketStatusBadges();
    $$('.mkt-trade',body).forEach(b=>b.onclick=()=>{ setChartSymbol(b.dataset.sym); goto('trade'); });
    $$('.watch-pin',body).forEach(b=>b.onclick=()=>{
      const sym=b.dataset.sym, I=INSTRUMENT_MAP[sym];
      if(state.watchlist.some(w=>w.id===sym))state.watchlist=state.watchlist.filter(w=>w.id!==sym);
      else { state.watchlist.push({id:I.s,n:I.n,tv:I.tv,live:true}); toast('Pinned','Added to your Watchlist page — find it in the sidebar.','ok'); }
      saveWatchlist(); renderMarkets(true);
    });
    $('#mktEmpty').classList.toggle('hidden',rows.length>0);
    $('#mktTable').classList.toggle('hidden',rows.length===0);
  }else{
    $$('#mktBody [data-px]').forEach(td=>{
      const I=bySym[td.dataset.px]; if(!I)return;
      td.textContent=fmtPx(I.p,I.d);
      const tr=td.closest('tr');
      const chCell=tr.querySelector('[data-chg]');
      if(chCell){ const ch=chgOf(I); chCell.textContent=fmtPct(ch,true); chCell.className='num mono '+(ch==null?'':(ch>=0?'up':'down')); }
      const sp=tr.querySelector('.spark polyline');
      if(sp&&I.hist.length>1){
        const h=I.hist.slice(-30),mn=Math.min(...h),mx=Math.max(...h),rg=(mx-mn)||1;
        sp.setAttribute('points',h.map((v,i)=>(i/(h.length-1)*62).toFixed(1)+','+(20-((v-mn)/rg)*18-1).toFixed(1)).join(' '));
        const ch=chgOf(I);
        sp.setAttribute('stroke',ch==null||ch>=0?'var(--green)':'var(--red)');
      }
      const sigCell=tr.querySelector('[data-msig]');
      if(sigCell){ const html=signalBadge(I)+scanLevelsHtml(I)+signalSourceHTML(I); if(sigCell.dataset.h!==html){ sigCell.innerHTML=html; sigCell.dataset.h=html; } }
    });
  }
  renderMarketScanStatus();
}
/* Cloud viewer: the Markets scan also repeats on a clock, and when the tab is
   looked at again. The scan above is started by incoming ticks only, so with a
   silent price feed the last readings would stay on screen with nothing to mark
   them as old. mktScanRefresh() itself allows one scan per 90 seconds. */
function hostedMarketsRescan(){
  if(isCloudflareReadonlyMode()&&enteredWorkspace&&state.view==='markets'&&!document.hidden)mktScanRefresh();
}
setInterval(hostedMarketsRescan,30000);
document.addEventListener('visibilitychange',hostedMarketsRescan);
/* retry delegation for the markets signal column */
{ const mb=document.getElementById('mktBody');
  if(mb&&!mb.__sigRetry){ mb.__sigRetry=1;
    mb.addEventListener('click',(e)=>{ const b=e.target.closest('.msig-retry'); if(b){ e.preventDefault();
      /* Cloud viewer: a retry asked for by a person tries this browser's own Deriv connection again at once. */
      if(hostedScannerInstance)hostedScannerInstance.retryBrowser();
      mktScanRefresh(true); } }); } }
{ const hn=document.getElementById('mktHoursNote'); if(hn)hn.textContent=MARKET_HOURS_NOTE; }
/* market session badges: OPEN (green) / BREAK (amber) / CLOSED (red), plus an
   honest QUIET state when the schedule says open but the feed stopped ticking */
function updateMarketStatusBadges(){
  $$('#mktBody [data-mstat]').forEach(el=>{
    const I=bySym[el.dataset.mstat]; if(!I)return;
    let st=marketStatus(I);
    if(I.c==='indices'){
      const age=I.t?Date.now()-I.t:Infinity;
      const fresh=state.broker&&state.broker.type==='mt5'&&age>=0&&age<30000&&I.mt5QuoteSymbol;
      const mode=Number(I.mt5TradeMode);
      if(fresh&&[1,2,4].includes(mode)) st={status:'open',label:'OPEN*',detail:'Fresh Exness MT5 tick; terminal trade mode permits at least one entry side. Confirm exact symbol hours and restrictions in MT5.'};
      else if(fresh&&mode===3) st={status:null,label:'CLOSE ONLY',detail:'Fresh Exness MT5 tick; terminal is in close-only mode, so new entries are not indicated.'};
      else if(fresh&&mode===0) st={status:'closed',label:'NO ENTRY',detail:'Fresh Exness MT5 tick; terminal reports this symbol disabled for trading.'};
      else st={status:null,label:'UNKNOWN',detail:'No fresh Exness MT5 tick with a verified terminal trade mode; market open/closed is not confirmed.'};
    }
    let txt=st.label, tip=st.detail;
    if(st.open&&I.p!=null&&I.t&&(Date.now()-I.t)>300000){ txt='QUIET'; tip='Typical schedule says open, but the quote is stale by 5+ minutes; this does not prove the market is closed.'; }
    el.textContent=txt;
    el.className='badge '+(st.status==='open'?'buy':st.status==='closed'?'sell':'gray');
    if(st.status==='break'||st.label==='CLOSE ONLY')el.style.color='var(--amber)'; else el.style.color='';
    el.title=tip;
  });
}
$('#mktSearch').oninput=e=>{ state.mkt.q=e.target.value.trim().toLowerCase(); renderMarkets(); };
$('#mktSort').onchange=e=>{ state.mkt.sort=e.target.value; renderMarkets(); };
$$('#mktCats .chip').forEach(c=>c.onclick=()=>{
  state.mkt.cat=c.dataset.cat;
  $$('#mktCats .chip').forEach(x=>x.classList.toggle('active',x===c));
  renderMarkets();
});

/* ---------- broker-discovered, analysis-only catalogue ---------- */
let discoveredMarkets=[];
let brokerAnalysisSeq=0;
const LIVE_DERIV_MARKET_CAP=20;
const liveDerivCodes=new Set((Array.isArray(store.get('liveDerivCatalogCodes',[]))?store.get('liveDerivCatalogCodes',[]):[]).filter((code)=>/^[A-Za-z0-9_]{2,32}$/.test(String(code))).slice(0,LIVE_DERIV_MARKET_CAP));
const liveDerivUnsubs=new Map();
const liveDerivQuotes=new Map();
function liveDerivQuoteText(code){
  if(!liveDerivCodes.has(code))return 'Not subscribed';
  const q=liveDerivQuotes.get(code);
  if(!q)return 'CONNECTING · waiting for first tick';
  if(q.status==='error')return 'UNAVAILABLE · '+q.error;
  if(!Number.isFinite(Number(q.quote)))return 'CONNECTING · waiting for first tick';
  const age=Date.now()-Number(q.time||0), freshness=age>=0&&age<30000?'LIVE':age<120000?'STALE':'STALE';
  return freshness+' · '+Number(q.quote).toLocaleString(undefined,{maximumFractionDigits:8})+(q.time?' · '+new Date(q.time).toLocaleTimeString():'');
}
function refreshLiveMarketCells(code){
  document.querySelectorAll('[data-live-code]').forEach((el)=>{if(el.dataset.liveCode===code)el.textContent=liveDerivQuoteText(code);});
}
setInterval(()=>{for(const code of liveDerivCodes)refreshLiveMarketCells(code);if(isCloudflareReadonlyMode())updateFeedPill(feed.feedStatus());},10000);
function updateSelectedDerivQuote(code,q){
  liveDerivQuotes.set(code,q);refreshLiveMarketCells(code);
  if(isCloudflareReadonlyMode()){
    updateFeedPill(feed.feedStatus());
    if(q.status==='live'&&!feedLiveAnnounced){feedLiveAnnounced=true;notify('Selected Deriv quotes live',code+' is receiving public ticks directly in this browser. Unselected catalogue markets are not streamed.','ok',{tag:'feed'});}
  }
  const status=$('#brokerMarketsStatus');if(status)status.textContent='Deriv public feed · '+liveDerivCodes.size+'/'+LIVE_DERIV_MARKET_CAP+' selected market(s) subscribed in this browser. Quotes are live only after a tick arrives; catalogue availability is not a promise of a current quote.';
}
function followDerivMarket(m){
  if(m.source!=='Deriv')return;
  const code=String(m.code||'');
  if(liveDerivCodes.has(code)){
    const stop=liveDerivUnsubs.get(code);if(stop)stop();
    liveDerivUnsubs.delete(code);liveDerivCodes.delete(code);liveDerivQuotes.delete(code);
    store.set('liveDerivCatalogCodes',[...liveDerivCodes]);
    renderBrokerMarkets();
    const status=$('#brokerMarketsStatus');if(status)status.textContent='Live subscriptions: '+liveDerivCodes.size+'/'+LIVE_DERIV_MARKET_CAP+'. Removed '+code+'; only selected Deriv markets stream quotes.';
    return;
  }
  if(liveDerivCodes.size>=LIVE_DERIV_MARKET_CAP){toast('Live-feed limit','Select up to '+LIVE_DERIV_MARKET_CAP+' Deriv catalogue markets at once. Unfollow one first; the full catalogue remains available.','warn');return;}
  liveDerivCodes.add(code);liveDerivQuotes.set(code,{status:'connecting'});
  store.set('liveDerivCatalogCodes',[...liveDerivCodes]);
  try{
    const stop=feed.subscribeDerivCode(code,(q)=>updateSelectedDerivQuote(code,q));
    liveDerivUnsubs.set(code,stop);
  }catch(e){liveDerivQuotes.set(code,{status:'error',error:String(e.message||e)});}
  renderBrokerMarkets();
}
function resumeLiveDerivSelections(rows){
  const available=new Set(rows.filter((row)=>row.source==='Deriv').map((row)=>row.code));
  for(const code of [...liveDerivCodes])if(!available.has(code)){const stop=liveDerivUnsubs.get(code);if(stop)stop();liveDerivUnsubs.delete(code);liveDerivCodes.delete(code);liveDerivQuotes.delete(code);}
  store.set('liveDerivCatalogCodes',[...liveDerivCodes]);
  for(const code of liveDerivCodes){
    const m=rows.find((row)=>row.source==='Deriv'&&row.code===code);
    if(m&&!liveDerivUnsubs.has(code)){
      liveDerivQuotes.set(code,{status:'connecting'});
      try{liveDerivUnsubs.set(code,feed.subscribeDerivCode(code,(q)=>updateSelectedDerivQuote(code,q)));}
      catch(e){liveDerivQuotes.set(code,{status:'error',error:String(e.message||e)});}
    }
  }
}
const brokerCatLabels={forex:'Forex',commodities:'Commodities',metals:'Metals',energies:'Energies',indices:'Indices',stocks:'Stocks',etfs:'ETFs',bonds:'Bonds',crypto:'Crypto',synthetics:'Synthetics',other:'Other / unclassified'};
function derivCatalogCategory(m){
  const market=String(m.market||'').toLowerCase(), sub=String(m.submarket||'').toLowerCase();
  if(market==='forex')return 'forex';
  if(market==='commodities')return /metal/.test(sub)?'metals':/energy|oil|gas/.test(sub)?'energies':'commodities';
  if(market==='indices')return 'indices';
  if(market==='synthetic_index')return 'synthetics';
  if(market==='cryptocurrency')return 'crypto';
  if(/\bstock\b|equity/.test(market))return 'stocks';
  if(/\betf\b/.test(market))return 'etfs';
  if(/bond/.test(market))return 'bonds';
  return 'other';
}
function renderBrokerMarkets(){
  const body=$('#brokerMarketsBody'), empty=$('#brokerMarketsEmpty'); if(!body)return;
  const q=String($('#brokerMarketSearch')?.value||'').trim().toLowerCase();
  const source=$('#brokerMarketSource')?.value||'all', category=$('#brokerMarketCategory')?.value||'all';
  const rows=discoveredMarkets.filter(m=>(source==='all'||m.source===source)&&(category==='all'||m.category===category)&&(!q||(m.code+' '+m.name+' '+(m.path||m.submarket||'')).toLowerCase().includes(q)))
    .sort((a,b)=>a.category.localeCompare(b.category)||a.name.localeCompare(b.name)||a.source.localeCompare(b.source));
  body.replaceChildren();
  for(const m of rows){
    const tr=document.createElement('tr');
    const add=(value,cls='')=>{const td=document.createElement('td');if(cls)td.className=cls;td.textContent=value;tr.appendChild(td);return td;};
    add(m.code,'mono');
    add(m.name+(m.path?' · '+m.path:(m.submarket?' · '+m.submarket:'')),'tiny');
    add(brokerCatLabels[m.category]||m.category,'tiny');
    add(m.source+' · '+m.status,'tiny');
    const live=add(m.source==='Deriv'?liveDerivQuoteText(m.code):'PC-local only · no Cloudflare feed','tiny mono');
    if(m.source==='Deriv')live.dataset.liveCode=m.code;
    const action=add('','num');
    if(m.source==='Deriv'){
      const follow=document.createElement('button');follow.type='button';follow.className='btn sm';follow.textContent=liveDerivCodes.has(m.code)?'Stop live':'Follow live';follow.onclick=()=>followDerivMarket(m);action.appendChild(follow);
    }else{
      const local=document.createElement('span');local.className='tiny faint';local.textContent='Analyze on PC';action.appendChild(local);
    }
    const b=document.createElement('button');b.type='button';b.className='btn sm';b.textContent='Analyze';b.onclick=()=>analyzeBrokerMarket(m);action.appendChild(b);
    body.appendChild(tr);
  }
  if(empty)empty.classList.toggle('hidden',rows.length>0);
}
async function loadDerivMarkets(){
  const status=$('#brokerMarketsStatus'), button=$('#loadDerivMarkets');
  if(button){button.disabled=true;button.textContent='Loading…';}
  if(status)status.textContent='Fetching Deriv’s current public active-symbol catalogue…';
  try{
    const r=await api('/api/markets/deriv');const j=await r.json().catch(()=>({}));
    if(!r.ok||!Array.isArray(j.markets))throw new Error(j.detail||j.error||'Deriv catalogue unavailable');
    const rows=j.markets.map(m=>({source:'Deriv',code:m.code,name:m.name,category:derivCatalogCategory(m),market:m.market,submarket:m.submarket,
      status:m.suspended?'suspended':m.open?'exchange open':'exchange closed',raw:m}));
    discoveredMarkets=discoveredMarkets.filter(m=>m.source!=='Deriv').concat(rows);
    resumeLiveDerivSelections(rows);
    if(status)status.textContent='Deriv catalogue loaded: '+rows.length+' broker-listed symbols · public catalogue · '+liveDerivCodes.size+'/'+LIVE_DERIV_MARKET_CAP+' selected live feeds. Select Follow live per market; unselected symbols are not streamed.';
    renderBrokerMarkets();
  }catch(e){if(status)status.textContent='Deriv catalogue unavailable: '+String(e.message||e)+' · existing markets remain visible.';}
  finally{if(button){button.disabled=false;button.textContent='Refresh Deriv catalogue';}}
}
async function loadMt5Markets(){
  const status=$('#brokerMarketsStatus'), button=$('#loadMt5Markets');
  if(button){button.disabled=true;button.textContent='Loading…';}
  if(status)status.textContent='Reading the connected PC-local MT5 symbol catalogue…';
  try{
    const r=await bridge.bridgeSymbols();
    if(!r||!Array.isArray(r.symbols))throw new Error('MT5 symbol catalogue unavailable; connect the local Exness bridge first.');
    const rows=r.symbols.map(m=>({source:'Exness / MT5',code:m.symbol,name:m.name||m.symbol,category:brokerCatLabels[m.category]?m.category:'other',path:m.path||'',
      status:'listed on local terminal',raw:m}));
    discoveredMarkets=discoveredMarkets.filter(m=>m.source!=='Exness / MT5').concat(rows);
    if(status)status.textContent='Local MT5 catalogue loaded: '+rows.length+' symbols'+(r.truncated?' · list capped at 5,000':'')+' · names and category metadata remain on this PC.';
    renderBrokerMarkets();
  }catch(e){if(status)status.textContent='Exness/MT5 catalogue unavailable: '+String(e.message||e)+' · the bridge must be running and authenticated on this PC.';}
  finally{if(button){button.disabled=false;button.textContent='Load Exness / MT5 symbols';}}
}
async function analyzeBrokerMarket(m){
  const panel=$('#brokerMarketAnalysis'),title=$('#brokerAnalysisTitle'),meta=$('#brokerAnalysisMeta'),priceEl=$('#brokerAnalysisPrice'),framesEl=$('#brokerAnalysisFrames'),votesEl=$('#brokerAnalysisVotes');
  if(!panel||!m)return;
  const seq=++brokerAnalysisSeq;panel.classList.remove('hidden');title.textContent=m.code+' · '+m.name;meta.textContent=m.source+' · '+(brokerCatLabels[m.category]||m.category)+' · analysis only';
  priceEl.textContent='Loading verified broker candles and latest quote…';framesEl.replaceChildren();votesEl.textContent='';
  const timeframes=[['M1',60,'1m'],['M5',300,'5m'],['H1',3600,'1h']];
  const getBars=async([mt5tf,gran,tag])=>{
    try{
      if(m.source==='Exness / MT5'){
        const r=await bridge.bridgeHistory(m.code,mt5tf,120);
        if(!r||!Array.isArray(r.candles))throw new Error('history unavailable');
        return {tag,candles:r.candles,source:'local MT5'};
      }
      const r=await api('/api/markets/deriv/candles',{method:'POST',body:{code:m.code,granularity:gran,count:120}});
      const j=await r.json().catch(()=>({}));if(!r.ok||!Array.isArray(j.candles))throw new Error(j.detail||j.error||'history unavailable');
      return {tag,candles:j.candles,source:j.source||'Deriv public'};
    }catch(e){return {tag,candles:null,error:String(e.message||e)};}
  };
  const quoteTask=(async()=>{
    try{
      if(m.source==='Exness / MT5'){
        const q=await bridge.quoteBridge([m.code]);const row=q?.quotes?.[0];if(!row)throw new Error('No current MT5 tick');
        const mid=row.bid>0&&row.ask>0?(row.bid+row.ask)/2:(row.bid||row.ask);return {price:Number(mid),time:Number(row.time||0)*1000,source:'local MT5'};
      }
      const r=await api('/api/markets/deriv/tick',{method:'POST',body:{code:m.code}});const j=await r.json().catch(()=>({}));
      if(!r.ok||!Number.isFinite(Number(j.quote)))throw new Error(j.detail||j.error||'No current Deriv tick');
      return {price:Number(j.quote),time:Number(j.epoch||0)*1000,source:'Deriv public'};
    }catch(_e){return null;}
  })();
  const [bars,quote]=await Promise.all([Promise.all(timeframes.map(getBars)),quoteTask]);
  if(seq!==brokerAnalysisSeq)return;
  const byTf=Object.fromEntries(bars.map(x=>[x.tag,x]));
  const analyses={m1:analyzeTimeframe(m.code,byTf['1m']?.candles||[],'1m'),m5:analyzeTimeframe(m.code,byTf['5m']?.candles||[],'5m'),h1:analyzeTimeframe(m.code,byTf['1h']?.candles||[],'1h')};
  const verdict=confirmMultiTimeframe(analyses);
  const last=bars.find(x=>x.candles?.length)?.candles?.at(-1);
  const closes=(byTf['1m']?.candles||[]).slice(-80).map(c=>Number(c.close)).filter(Number.isFinite);
  const line=$('#brokerAnalysisLine');
  if(line&&closes.length>1){const mn=Math.min(...closes),mx=Math.max(...closes),rg=mx-mn||1;line.setAttribute('points',closes.map((v,i)=>(8+i*624/(closes.length-1)).toFixed(1)+','+(112-(v-mn)*104/rg).toFixed(1)).join(' '));line.setAttribute('stroke',closes.at(-1)>=closes[0]?'var(--green)':'var(--red)');}
  else if(line)line.setAttribute('points','');
  let priceText='UNAVAILABLE · no current quote or candle history';
  if(quote&&quote.price>0){const age=Date.now()-quote.time;const freshness=quote.time&&age>=0&&age<60000?'LIVE':quote.time&&age<15*60000?'DELAYED':'HISTORICAL';priceText=freshness+' quote '+fmtPx(quote.price,Number.isInteger(m.raw?.digits)?m.raw.digits:5)+' · '+quote.source+(quote.time?' · '+new Date(quote.time).toLocaleString():'');}
  else if(last)priceText='HISTORICAL · last candle close '+fmtPx(Number(last.close),Number.isInteger(m.raw?.digits)?m.raw.digits:5)+' · quote unavailable';
  priceEl.textContent=priceText;
  framesEl.replaceChildren();
  for(const tag of ['1m','5m','1h']){
    const a=analyses[tag==='1m'?'m1':tag==='5m'?'m5':'h1'];const box=document.createElement('div');box.className='card';box.style.cssText='padding:10px;min-width:120px;flex:1';
    const label=document.createElement('b');label.textContent=tag.toUpperCase()+' · '+(a.error?'UNAVAILABLE':a.signal);box.appendChild(label);
    const detail=document.createElement('div');detail.className='tiny faint';detail.textContent=a.error?(byTf[tag]?.error||'Insufficient verified candle history'):'score '+(a.biasScore>=0?'+':'')+a.biasScore+' · '+a.trend;box.appendChild(detail);framesEl.appendChild(box);
  }
  const count=bars.filter(x=>x.candles?.length).length;
  votesEl.textContent='MTF result: '+verdict.replace(/_/g,' ')+' · '+votesSummary(analyses)+' · candles: '+count+'/3 timeframes · source '+(m.source==='Exness / MT5'?'PC-local MT5':'Deriv public feed')+'.';
}
$('#loadDerivMarkets')?.addEventListener('click',loadDerivMarkets);
$('#loadMt5Markets')?.addEventListener('click',loadMt5Markets);
$('#brokerMarketSearch')?.addEventListener('input',renderBrokerMarkets);
$('#brokerMarketSource')?.addEventListener('change',renderBrokerMarkets);
$('#brokerMarketCategory')?.addEventListener('change',renderBrokerMarkets);
$('#brokerAnalysisClose')?.addEventListener('click',()=>{brokerAnalysisSeq++;$('#brokerMarketAnalysis')?.classList.add('hidden');});

/* ================================================================
   CHART & TRADE (TradingView chart + broker-routed orders)
   ================================================================ */
const INDEX_TV={NAS100:'TVC:NDX',NASDAQ:'TVC:NDX',US100:'TVC:NDX',US30:'TVC:DJI',SPX500:'TVC:SPX'};
function openSignalSymbol(sym){
  if(INSTRUMENT_MAP[sym]){
    setChartSymbol(sym); goto('trade');
    if(INSTRUMENT_MAP[sym].c==='indices'){
      toast('Index CFD · analysis only',state.broker?.type==='mt5'?'Local Exness quotes/history can be inspected; order sending is disabled in this verification build.':'Connect Exness for verified local quotes/history. This build does not send index orders.',{kind:'warn'});
    }
    return;
  }
  const tv=INDEX_TV[sym];
  if(tv)window.open('https://www.tradingview.com/chart/?symbol='+encodeURIComponent(tv),'_blank','noopener');
  toast('Index — analysis only','This index is not orderable through Deriv. The Exness MT5 bridge can provide verified local quotes/history; order execution is disabled in this build.',{kind:'warn'});
}
function setChartSymbol(sym,keepLevels){
  if(!bySym[sym])return;
  const previousSym=state.chart.sym;
  state.chart.sym=sym;
  $('#chartSymbol').value=sym;
  updateTradeHeader();
  tv.switchChartSymbol(sym);
  if(!keepLevels&&previousSym!==sym){
    /* Never leave another instrument's prices beside the newly selected chart. */
    levelsForSym=null;
    ['orderSL','orderTP','orderTP2'].forEach((id)=>{ const el=$('#'+id); if(el)el.value=''; });
    const note=$('#levelsNote');
    if(note)note.textContent='Changed to '+sym+' — prior symbol levels cleared. Waiting for a current verified setup.';
    updateRisk();
  }else if(!keepLevels&&levelsForSym!=='__manual__'){
    levelsForSym=null; /* refresh the same symbol without discarding user edits */
  }
  autofillLevels(sym);
}
/* auto-fill SL/TP in the order ticket from the LIVE analysis of the selected
   market (scan result levels — entry/stop/tp1/tp2 from the 1m/5m/1h engine).
   Only confirmed setups fill the fields; a WAIT says so instead of inventing
   levels. User-edited fields are only overwritten on symbol change or via
   the "Use signal levels" button. */
let levelsForSym=null;
let levelsRequestSeq=0;
['orderSL','orderTP','orderTP2'].forEach((id)=>{ const el=document.getElementById(id); if(el)el.addEventListener('input',()=>{ levelsForSym='__manual__'; }); });
async function autofillLevels(sym){
  loadCalendar().catch(()=>{}); /* scheduled releases for the line above the chart; at most one read in ten minutes */
  const requestId=++levelsRequestSeq;
  const isCurrent=()=>requestId===levelsRequestSeq&&state.chart.sym===sym;
  const note=$('#levelsNote'); if(!note)return;
  try{
    let sig;
    if(await isCloudflareHostedApp()){
      /* Cloud viewer: the same reading the Markets table shows (this browser first, AURUM cloud as labelled fallback). */
      sig=(await hostedSignalBatch([sym]))[0];
      if(!isCurrent())return; /* a slower answer for the previous symbol is stale */
    }else{
      const r=await api('/api/signals/scan',{method:'POST',body:{symbols:[sym]},timeoutMs:30000});
      if(!isCurrent())return;
      if(!r.ok)throw 0;
      const j=await r.json();
      if(!isCurrent())return; /* a slower response for the previous symbol is stale */
      sig=(j.results||[])[0];
      /* A market that has just resumed after a pause has no reading yet (closedcandles.js): nothing from before
         the pause may fill the ticket. The PC's server sends a row without a reading; one that is only marked is
         withheld here, by the decision the Markets table uses (withheldReading). */
      sig=(sig&&withheldReading(sig))||sig;
    }
    /* shared: chart strip + markets badges. A cloud-viewer state (stale, no data, unavailable) replaces
       an older reading too, so levels from before a market closed never stay on screen as current. */
    if(sig&&(!sig.error||signalState(sig)))state.mktScan[sym]=sig;
    updateChartLevels();
    if(!sig||sig.error){
      /* The market is closed, paused or has just resumed: levels that came from an earlier reading go with it.
         Levels the trader typed, or took over from the analysis panel, stay (levelsForSym '__manual__'); so does
         everything when the answer merely failed. */
      if(sig&&signalState(sig)==='stale'&&levelsForSym!=='__manual__'){
        ['orderSL','orderTP','orderTP2'].forEach((id)=>{ const el=$('#'+id); if(el)el.value=''; });
        levelsForSym=null; updateRisk();
      }
      note.textContent=sig&&signalState(sig)&&sig.detail?String(sig.detail):'Live levels unavailable for '+sym+' right now.'; return;
    }
    if(levelsForSym==='__manual__'){ /* user/AI applied levels meanwhile — do not stomp */
      note.innerHTML='Ticket levels kept (applied manually / from the AI signal) — <a href="#" id="levelsAgain">use live signal levels instead</a>.';
      const a=$('#levelsAgain'); if(a)a.onclick=(e)=>{ e.preventDefault(); levelsForSym=null; autofillLevels(sym); };
      return;
    }
    if(isDirectionalCandidate(sig)&&!isAsterPublishable(sig)){
      if(levelsForSym===sym){['orderSL','orderTP','orderTP2'].forEach(id=>{const el=$('#'+id);if(el)el.value='';});levelsForSym=null;updateRisk();}
      note.textContent='Technical candidate withheld: ASTER has not approved publication. Automatic ticket levels remain disabled.';return;
    }
    if(sig.signal!=='BUY'&&sig.signal!=='SELL'){
      note.textContent='No confirmed setup for '+sym+' yet ('+(sig.wait_reason||'waiting').toLowerCase().replace(/_/g,' ')+') — SL/TP fill when the timeframes align.';
      return;
    }
    const I=bySym[sym]; const d=(I&&I.d)!=null?I.d:5;
    const f=(v)=> (v!=null&&Number.isFinite(Number(v)))?String(Number(v).toFixed(d)):'';
    const sl=f(sig.stop_loss), t1=f(sig.tp1), t2=f(sig.tp2);
    if($('#orderSL'))$('#orderSL').value=sl;
    if($('#orderTP'))$('#orderTP').value=t1;
    if($('#orderTP2'))$('#orderTP2').value=t2;
    levelsForSym=sym;
    if(sig.signal!==state.side&&(state.side==='BUY'||state.side==='SELL')){
      state.side=sig.signal; syncSide();
      note.innerHTML='Levels from live analysis — <b>'+sig.signal+'</b> · '+sig.confidence+'% conf · side switched to match. Edit freely or <a href="#" id="levelsAgain">re-apply</a>.';
    }else{
      note.innerHTML='Levels from live analysis — <b>'+sig.signal+'</b> · '+sig.confidence+'% conf. Edit freely or <a href="#" id="levelsAgain">re-apply</a>.';
    }
    const a=$('#levelsAgain'); if(a)a.onclick=(e)=>{ e.preventDefault(); autofillLevels(sym); };
    updateRisk();
  }catch(e){ if(!isCurrent())return; if(note)note.textContent='Live levels unavailable for '+sym+' right now.'; }
}
function updateChartLevels(){
  const el=document.getElementById('chartLevels'); if(!el)return;
  const I=bySym[state.chart.sym]; if(!I){ el.innerHTML=''; return; }
  const r=state.mktScan[I.s];
  let out;
  if(!r||r.error){
    /* no reading, or a market that is closed, stale or unavailable: nothing is called live */
    out='<span class="faint">'+(r&&r.detail?escHtml(String(r.detail)):'No confirmed levels yet \u2014 the scan fills entry/SL/TP when timeframes align.')+'</span>';
  }else{
    /* Direction first: Buy, Sell or Wait with the agreement score, then what each timeframe shows now,
       then the levels (a Buy or Sell only) and what was measured for signals of this rule. */
    const raw=scanLevelsHtml(I);
    const levels=raw?raw.replace(/^<div[^>]*>/,'<span>').replace(/<\/div>$/,'</span>'):'';
    const approved=isAsterPublishable(r);
    const trend=approved&&!isDailyReading(r)?trendWords(r.votes):'';
    const measured=approved?measuredText(r,{short:true}):'';
    out='<span class="faint">LIVE SIGNAL LEVELS</span>&nbsp; '+readingChip(I.s).html
      +(trend?' <span data-chart-trend title="What the finished candles of each timeframe show at the last 5-minute close. It describes the market now; it does not say that the direction will continue.">now: '+escHtml(trend)+'</span>':'')
      +(levels?' '+levels:' <span class="faint">no entry, stop or target: they come only with a Buy or Sell reading</span>')
      +(measured?' <span class="faint" data-chart-measured title="'+escHtml(measuredText(r)||'')+'">'+escHtml(measured)+'</span>':'')
      +' <span class="faint" data-chart-score-note>% = how strongly the timeframes agree, not the chance of profit</span>';
  }
  out+=chartEventHtml(I.s);
  if(el.dataset.h!==out){ el.innerHTML=out; el.dataset.h=out; }
}
/* The line above the chart: a high-impact release that concerns this market, now or within three hours.
   Without a calendar the line says so: an unknown calendar is not an empty one. */
function chartEventHtml(sym){
  if(!currenciesOf(sym).length)return '';
  const entries=calendarEntries();
  if(entries==null)return state.calAt?' <span class="faint" data-chart-event="unknown" title="'+escHtml(state.calError||'')+'">calendar not available: scheduled releases unknown</span>':'';
  const now=Date.now();
  const x=exposureFor(sym,entries,now,{aheadMin:180});
  if(!x)return '';
  const what=x.events.slice(0,2).map(e=>(e.country||'')+' '+(e.event||'')).join(', ')+(x.events.length>2?' and '+(x.events.length-2)+' more':'');
  return x.phase==='aside'
    ?' <span class="chart-event on" data-chart-event="aside" title="'+escHtml(releaseMeasuredText())+'">Stand aside · '+escHtml(what)+' at '+escHtml(eatStamp(x.t,now))+' · no new trade until '+eatClock(x.until)+' EAT</span>'
    :' <span class="chart-event" data-chart-event="ahead" title="'+escHtml(releaseMeasuredText())+'">High-impact release '+escHtml(eatStamp(x.t,now))+' · '+escHtml(what)+' · no new trade from '+eatClock(x.from)+' EAT</span>';
}
function updateTradeHeader(){
  const I=bySym[state.chart.sym]; if(!I)return;
  const ch=chgOf(I);
  $('#chartPrice').textContent=fmtPx(I.p,I.d);
  const chEl=$('#chartChg');
  chEl.textContent=fmtPct(ch,true);
  chEl.className='mono small '+(ch==null?'':(ch>=0?'up':'down'));
  $('#bidPx').textContent=fmtPx(I.p,I.d);
  $('#askPx').textContent=fmtPx(I.p,I.d);
  updateRisk();
  const mode=$('#ticketMode');
  if(state.broker?.type==='deriv'){
    const demo=/demo|virtual/i.test(state.broker.account?.account_type||'');
    mode.textContent='Deriv · '+(demo?'DEMO':'REAL'); mode.className='badge '+(demo?'demo':'buy');
  }
  else if(state.broker?.type==='mt5'){ mode.textContent='Exness bridge · live'; mode.className='badge buy'; }
  else { mode.textContent='No broker'; mode.className='badge gray'; }
  renderResaleNote(I);
  const info=$('#instrInfo');
  const ms=marketStatus(I);
  const rows=[['Market status',ms.label+(ms.detail?' \u00b7 '+ms.detail:'')],
    ['Category',I.c.charAt(0).toUpperCase()+I.c.slice(1)],
    ['Last',fmtPx(I.p,I.d)],
    ['Session change',fmtPct(ch,true)],
    ['Feed','Deriv public · live'],
    ['Contract','1 unit'],['Chart','TradingView']];
  info.innerHTML=rows.map(r=>'<li><span class="k">'+r[0]+'</span><span class="v">'+r[1]+'</span></li>').join('');
}
/* early-exit (resale) guidance for the ticket — family-level, honest, live-verified after buy */
function renderResaleNote(I){
  const el=$('#resaleNote'); if(!el)return;
  if(!I){ el.textContent='Early exit (resale): pick a market to see its family guidance.'; return; }
  const r=I.resale||'unknown';
  if(I&&I.c==='indices'){
    el.innerHTML='<span class="badge buy">CFD — stop anytime ✓</span> Index CFD via your Exness bridge: no expiry, close any moment the market is open, and your SL/TP execute on Exness\'s server even with this app closed. <span class="tiny faint">Quoted live from MT5; market breaks (21:00–22:00 UTC + short daily index breaks) pause closes.</span>';
    return;
  }
  const body=r==='usually'
    ? '<span class="badge buy">Early exit: usually allowed ✓</span> synthetics — Deriv usually allows resale here, so Close and your profit target genuinely stop the trade.'
    : r==='rarely'
    ? '<span class="badge sell">Early exit: usually NOT allowed ✗</span> Deriv locks this family for the whole contract life (live-tested) — plan to hold to settlement; max loss is exactly your stake.'
    : '<span class="badge gray">Early exit: not verified —</span> Deriv has not been live-tested for resale on this family; treat it as locked until the position row shows otherwise.';
  el.innerHTML=body+' <span class="tiny faint">Deriv decides per contract — Aurum checks can-sell live the moment it is bought, and Close always tries the real sell first.</span>';
}
function syncSide(){
  const buy=state.side==='BUY';
  $('#sideBuy').classList.toggle('sel-buy',buy);
  $('#sideSell').classList.toggle('sel-sell',!buy);
  const btn=$('#placeOrderBtn');
  btn.textContent='Place '+state.side+' order';
  btn.classList.toggle('buy',buy); btn.classList.toggle('sell',!buy);
}
$('#sideBuy').onclick=()=>{ state.side='BUY'; syncSide(); };
$('#sideSell').onclick=()=>{ state.side='SELL'; syncSide(); };
$$('#view-trade .quick-amts button').forEach(b=>b.onclick=()=>{ $('#orderAmount').value=b.dataset.amt; updateRisk(); });
/* duration chips + live settle preview: the time frame is a visible choice,
   never a dropdown silently left on yesterday's value */
function syncDurChips(){
  const v=$('#orderDuration')?$('#orderDuration').value:'';
  $$('#durChips button').forEach(b=>b.classList.toggle('active',b.dataset.dur===v));
}
function durPreviewUpdate(){
  const el=$('#durPreview'); if(!el)return;
  const sym=state.chart.sym; const I=bySym[sym];
  const du=readDurationSel(sym);
  const sel=$('#orderDuration')?$('#orderDuration').value:'';
  const autoNote=sel===''?' (Auto: 15m forex · 5m synthetics)':'';
  const txt='This order settles '+settleText(du)+autoNote+'.'+longLockWarn(du,I);
  if(el.textContent!==txt)el.textContent=txt;
  syncDurChips();
}
$$('#durChips button').forEach(b=>b.onclick=()=>{ const sel=$('#orderDuration'); if(sel)sel.value=b.dataset.dur; durPreviewUpdate(); });
$('#orderDuration').addEventListener('change',()=>durPreviewUpdate());
function updateRisk(){
  const I=bySym[state.chart.sym]; if(!I)return;
  const amt=parseFloat($('#orderAmount').value)||0;
  const sl=parseFloat($('#orderSL').value);
  const el=$('#riskTxt');
  if(!sl||isNaN(sl)){ el.textContent='unlimited (no stop)'; el.className=''; return; }
  if(I.p==null||state.balance==null){ el.textContent='— (connect a broker for equity %)'; el.className=''; return; }
  const risk=Math.abs(sl-I.p)/I.p*amt;
  const pct=risk/(state.balance||1)*100;
  el.textContent=fmtMoney(risk)+' ('+pct.toFixed(1)+'% of equity)';
  el.className=pct>state.settings.maxRisk?'down':'up';
}
['orderAmount','orderSL','orderTP','orderTP2'].forEach(id=>{ const el=$('#'+id); if(el)el.addEventListener('input',updateRisk); });

/* ---------- daily loss guard: cap how much a bad day can cost ---------- */
function histPersist(){ try{ store.set('history',state.history.slice(0,200)); }catch(e){} }
function atHealth(){
  const rows=state.history.filter((h)=>h.at&&h.pl!=null);
  const w=rows.filter((h)=>h.pl>0).length, l=rows.length-w;
  const net=rows.reduce((a,h)=>a+h.pl,0);
  return {n:rows.length,w,l,net};
}
function atHealthHtml(){
  const h=atHealth();
  if(!h.n)return '<span class="tiny faint">Auto-trade record: no closed sniper trades yet.</span>';
  const be=h.w+h.l>0?(h.l/(h.w+h.l)*100).toFixed(0):'—';
  return '<span class="tiny '+(h.net>=0?'up':'down')+'">Auto-trade record: '+h.w+'W / '+h.l+'L \u00b7 net '+fmtMoney(h.net,true)
    +' \u00b7 win rate '+(h.w+h.l?Math.round(h.w/(h.w+h.l)*100):0)+'%</span>'
    +' <span class="tiny faint">(need &gt;'+be+'% just to break even at this payout)</span>';
}
function guardStatusHtml(){
  const day=dayRealized(), L=lossGuardLimit();
  const on=L>0;
  return '<span class="tiny">Today\u2019s closed P&amp;L: <b class="'+(day<0?'down':'up')+'">'+fmtMoney(day,true)+'</b> \u00b7 guard '
    +(on?('at \u2212'+fmtMoney(L)+' \u2192 <b class="'+(lossGuardTripped()?'down':'up')+'">'+(lossGuardTripped()?'TRIPPED \u2014 orders stand down':'active')+'</b>'):
    '<b class="down">OFF \u2014 nothing stops a bad day</b>')
    +'</span>';
}
function guardRecheckAfterClose(){
  if(lossGuardTripped()){
    disableAutoTrade('loss','Daily loss guard hit ('+fmtMoney(dayRealized(),true)+') \u2014 sniper stood down until tomorrow.');
    notify('Daily loss guard hit','Today '+fmtMoney(dayRealized(),true)+' reached your \u2212'+fmtMoney(Math.abs(lossGuardLimit()))+' stop \u2014 sniper stood down until tomorrow.','err'==='err'?{tag:'auto',kind:'err'}:{tag:'auto',kind:'err'});
  }
}
function dayRealized(){
  const d=new Date(); const start=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
  return state.history.filter((h)=>h.pl!=null&&h.t>=start).reduce((a,h)=>a+h.pl,0);
}
function lossGuardLimit(){ const v=Number(state.settings.lossGuard); return Number.isFinite(v)?v:25; }
function lossGuardTripped(){ const L=lossGuardLimit(); return L>0&&dayRealized()<=-Math.abs(L); }
function guardStopIfTripped(){
  if(!lossGuardTripped())return false;
  toast('Daily loss guard hit','Today '+fmtMoney(dayRealized(),true)+' reached your \u2212'+fmtMoney(Math.abs(lossGuardLimit()))+' stop. New orders stand down until tomorrow (Automation \u2192 Daily loss guard to adjust). Losses cannot be un-made by chasing \u2014 protect the account.','err');
  return true;
}
function beWinRateText(stake,payout){
  stake=Number(stake); payout=Number(payout);
  if(!(payout>stake)||!(stake>0))return '';
  const be=stake/(stake+payout)*100;
  return '\u2265'+be.toFixed(0)+'% of these trades must WIN just to break even \u00b7 pays '+(payout/stake).toFixed(2)+'\u00d7 stake \u2014 size accordingly';
}
{ const lg=$('#lossGuardAmt');
  if(lg&&!lg.__wired){ lg.__wired=true; lg.value=lossGuardLimit();
    lg.addEventListener('change',()=>{ let v=Number(lg.value); if(!Number.isFinite(v)||v<0)v=25; state.settings.lossGuard=v; save(); lg.value=v;
      toast('Daily loss guard',v>0?('Orders stand down at \u2212'+fmtMoney(v)+' closed losses in a day.'):'Guard disabled \u2014 server-side caps remain the only backstop.','ok'); }); } }

async function releaseMt5RiskReservation(once){
  if(!once)return;
  try{ await api('/api/risk/fill',{method:'POST',body:{kind:'release',once},headers:{'x-aurum-user':state.user||'local'}}); }catch(_e){}
}
function mt5ResultAmbiguous(message){ return /timeout|timed out|bridge closed|socket closed|connection lost/i.test(String(message||'')); }
function mt5GateError(gate){
  const base=String(gate?.detail||gate?.error||'Rejected by the risk gate');
  const openCheck=Array.isArray(gate?.checks)&&gate.checks.find(c=>c.name==='open_trades'&&c.status==='FAILED');
  return openCheck?base+' This is the app-side server counter, not a live MT5 position scan. This attempt was blocked before calling MT5; no order was sent. Do not raise or reset the cap blindly.':base;
}
async function verifyAndConfirmMt5OpenLimit(gate){
  if(!isOnlyOpenTradesGateFailure(gate))throw new Error(mt5GateError(gate));
  let snap;
  try{ snap=await bridge.bridgePositions(); }
  catch(_e){ throw new Error('MT5 open positions could not be verified through the local bridge. Risk gate remains blocked; no order was sent.'); }
  const verified=verifyBrokerOpenTradeCount(gate,snap&&snap.list);
  if(!verified.ok)throw new Error(verified.reason+' Do not reset or raise the cap to bypass this check.');
  const check=gate.checks.find(c=>c.name==='open_trades');
  const appCount=(String(check.evidence||'').match(/opens=(\d+)/)||[])[1];
  const appState=appCount?appCount+'/'+verified.limit:'at the configured limit';
  const ok=await askConfirm('Verify MT5 open-trade limit',
    'The app server counter is '+appState+', but the connected MT5 terminal reports '+verified.count+'/'+verified.limit+' open positions. Only the app counter check is being replaced; all other required server risk checks passed. The local bridge will re-check the same limit immediately before sending. Continue with this Exness order?',
    'Continue once');
  if(!ok)throw new Error('Cancelled before the MT5 order call. No order was sent.');
  return verified.limit;
}
async function placeOrder(){
  if(isCloudflareReadonlyMode()){
    toast('Read-only staging','Cloudflare staging is analysis-only. It cannot request trade quotes, buy, or close Deriv contracts. Use the PC-local app for Exness.','warn');
    return;
  }
  let mt5RiskOnce=null, mt5OrderAttempted=false;
  if(guardStopIfTripped())return;
  const I=bySym[state.chart.sym];
  const amt=parseFloat($('#orderAmount').value);
  if(!amt||amt<1){ toast('Invalid amount','Enter at least $1 to place an order.','err'); return; }
  const px=I.p;
  if(px==null){ toast('No live price',I.s+' has no live quote yet — wait for the feed or pick another symbol.','err'); return; }
  const sl=parseFloat($('#orderSL').value), tp=parseFloat($('#orderTP').value), tp2=parseFloat($('#orderTP2').value);
  if(!isNaN(sl)&&state.side==='BUY'&&sl>=px){ toast('Invalid stop','Stop-loss must be below the entry for a BUY.','err'); return; }
  if(!isNaN(sl)&&state.side==='SELL'&&sl<=px){ toast('Invalid stop','Stop-loss must be above the entry for a SELL.','err'); return; }

  /* broker gate — no demo fills, ever.
     Precedence: env proxy (server-side token) -> Deriv PAT -> Exness bridge -> locked.
     Deriv paths open the CONFIRM modal (spec: nothing is bought unconfirmed). */
  const dh=state.derivHealth;
  const proxyReady=!!(dh&&dh.authorized&&dh.tradingEnabled);
  if(!proxyReady&&!state.broker){
    const hint=dh&&dh.tokenSet?' The server proxy has a token but trading is OFF — set DERIV_TRADING_ENABLED=true in the server .env.':'';
    toast('Trading locked','Connect your Deriv account (PAT) or Exness (MT5 bridge) to place orders. Live markets stay available for analysis.'+hint,'err');
    notify('Trading locked','No broker connected — connect Deriv or Exness from the Connect screen or Automation.',{tag:'trade',kind:'err'});
    return;
  }
  if(!proxyReady&&state.broker?.type==='deriv'&&state.balance!=null&&amt>state.balance){
    toast('Insufficient balance','Deriv balance is '+fmtMoney(state.balance)+'.','err'); return;
  }
  /* fail fast on the server's stake cap instead of after the quote */
  const lim=(state.broker&&state.broker.limits)||(dh&&dh.limits)||null;
  if(state.broker&&lim&&amt>lim.maxStakeUsd){
    toast('Over server limit','Stake $'+amt.toFixed(2)+' exceeds the server-side limit of $'+lim.maxStakeUsd+' per trade.','err'); return;
  }

  if(proxyReady){
    openTradeModal({mode:'proxy',I,amt,sl,tp,tp2,px,dur:readDurationSel(I.s)}); return;   /* env-token path */
  }
  if(state.broker?.type==='deriv'){
    openTradeModal({mode:state.broker.mode==='pat_server'?'pat_server':'pat',I,amt,sl,tp,tp2,px,dur:readDurationSel(I.s)}); return;
  }

  /* index CFDs route ONLY through Exness — never Deriv */
  if(I.c==='indices'&&state.broker?.type!=='mt5'){
    toast('Index CFDs need Exness','Connect your Exness/MT5 bridge first (Automation → MT5 bridge). Index CFDs are not orderable on Deriv — probe-verified.','err');
    return;
  }
  if(state.broker?.type==='mt5'){
    toast('Exness verification is read-only','This local Phase 1 build can refresh account data and positions, but cannot send an order. Separate approval is required before execution can be enabled.','warn');
    return;
  }
  /* Exness via local MT5 bridge (direct — outside Deriv proxy scope) */
  const btn=$('#placeOrderBtn'); btn.disabled=true; const btnTxt=btn.textContent; btn.textContent='Sending…';
  try{
    let mt5ServerReserved=true, mt5OpenLimit=10;
    /* server is the single source of truth for risk limits — Exness included.
       once = idempotency key for THIS order intent: a duplicated submit
       (double-fire, retry) is rejected server-side instead of double-booked. */
    /* honest exposure check FIRST: a live quote is also the evidence that the
       market is open (the risk gate must not guess). broker min-lot can exceed
       the requested stake — a $1 request on US30 (min 0.1 lots) is really a
       ~$4-5k position; refuse silent oversizing. */
    let minq=null; try{ minq=await bridge.quoteBridge([I.s.replace('/','')]); }catch(_e){}
    const minqr=minq&&minq.quotes&&minq.quotes[0];
    const onceId=Date.now().toString(36)+Math.random().toString(36).slice(2,8);
    mt5RiskOnce=onceId;
    const slN=isNaN(sl)?null:sl, tpN=isNaN(tp)?null:tp;
    const g=await api('/api/risk/gate',{method:'POST',body:{
      amount:amt,venue:'mt5',once:onceId,
      entry:(minqr&&minqr.ask>0)?minqr.ask:(isNaN(px)?null:px),
      sl:slN,tp:tpN,
      marketHours:(minqr&&minqr.ask>0)?true:null,
      newsBlocked:false /* no event-ban policy active; STALE stand-down is enforced at entry */
    },headers:{'x-aurum-user':state.user||'local'}});
    const gate=await g.json().catch(()=>({}));
    if(!g.ok){
      if(isOnlyOpenTradesGateFailure(gate)){
        mt5RiskOnce=null; mt5ServerReserved=false;
        mt5OpenLimit=await verifyAndConfirmMt5OpenLimit(gate);
      }else{ mt5RiskOnce=null; throw new Error(mt5GateError(gate)); }
    }else{
      const serverLimit=Number(gate.limits?.maxOpenTrades);
      mt5OpenLimit=Number.isSafeInteger(serverLimit)&&serverLimit>0?serverLimit:10;
    }
    if(gate.checks)console.log('risk checks',gate.checks);
    if(minqr&&minqr.volume_min>0&&minqr.contract_size>0&&minqr.ask>0){
      const minNotional=minqr.volume_min*minqr.contract_size*minqr.ask;
      if(minNotional>amt*1.5){
        throw new Error('Refused: broker minimum lot '+minqr.volume_min+' on '+I.s+' implies about $'+Math.round(minNotional)+' of notional exposure, above your requested $'+amt+'. No order was sent. Do not raise the stake or server-side cap; choose an instrument or broker account whose verified minimum exposure fits your existing risk limit.');
      }
    }
    mt5OrderAttempted=true;
    const o=await bridge.placeBridgeOrder({symbol:I.s.replace('/',''),side:state.side,volume:amt,sl:isNaN(sl)?0:sl,tp:isNaN(tp)?0:tp,maxOpenTrades:mt5OpenLimit});
    if(mt5ServerReserved)api('/api/risk/fill',{method:'POST',body:{kind:'open',once:onceId},headers:{'x-aurum-user':state.user||'local'}}).catch(()=>{});
    mt5RiskOnce=null; // local MT5 is authoritative for broker positions when the cloud count was stale
    const pos={ id:Date.now()+'_h'+(o.ticket||''), sym:I.s, side:state.side, amt,
      entry:o.price||px, sl:isNaN(sl)?null:sl, tp1:isNaN(tp)?null:tp, tp2:isNaN(tp2)?null:tp2,
      t:Date.now(), broker:'mt5', ticket:o.ticket, riskOnce:mt5ServerReserved?onceId:null, flags:{} };
    state.positions.push(pos); save();
    renderNavCounts(); renderPortfolio();
    toast('Order filled',state.side+' '+fmtMoney(amt)+' '+I.s+' @ '+fmtPx(o.price||px,I.d)+(o.lots?' — filled '+o.lots+' lots'+(o.effective_notional?' ≈ $'+Math.round(o.effective_notional)+' exposure':''):''),'ok');
    notify('Trade opened','Exness '+state.side+' '+I.s+' '+fmtMoney(amt)+' @ '+fmtPx(o.price||px,I.d)+' · ticket '+(o.ticket||'—')+'.',{tag:'trade',kind:'ok'});
  }catch(e){
    const em=String(e.message||e);
    if(mt5RiskOnce&&(!mt5OrderAttempted||!mt5ResultAmbiguous(em))) await releaseMt5RiskReservation(mt5RiskOnce);
    toast('Order failed',em,'err');
    notify('Order failed',em,{tag:'trade',kind:'err'});
  }finally{ btn.disabled=false; btn.textContent=btnTxt; }
}

/* ---------- Deriv trade confirmation modal (trading is OFF until this) ---------- */
let tmCtx=null, tmUnsub=null;
function tmClose(){
  $('#tmModal').classList.remove('open');
  tmUnsub&&tmUnsub(); tmUnsub=null; tmCtx=null;
}
async function openTradeModal({mode,I,amt,sl,tp,tp2,px,dur}){
  if(isCloudflareReadonlyMode()){toast('Read-only staging','Order quotes and execution are disabled on Cloudflare staging.','warn');return;}
  const dh=state.derivHealth||{};
  const du=dur||derivDurationFor(I.s);
  tmCtx={mode,I,amt,sl,tp,tp2,px,dur:du,ticket:null,side:state.side};
  $('#tmSymbol').textContent=I.s;
  const sideEl=$('#tmSide'); sideEl.textContent=state.side; sideEl.className=state.side==='BUY'?'b-buy':'b-sell';
  $('#tmStake').textContent=fmtMoney(amt);
  $('#tmDuration').textContent='requesting '+durHuman(du)+' · settles '+settleText(du)+'…';
  $('#tmBE').textContent='—';
  $('#tmPayout').textContent='—';
  $('#tmLive').textContent=fmtPx(px,I.d);
  $('#tmLimits').textContent=(dh.limits?('stake ≤ $'+dh.limits.maxStakeUsd+' · open ≤ '+dh.limits.maxOpenTrades+' · daily loss ≤ $'+dh.limits.dailyLossLimitUsd):(state.broker&&state.broker.limits?('stake ≤ $'+state.broker.limits.maxStakeUsd+' · open ≤ '+state.broker.limits.maxOpenTrades+' · daily loss ≤ $'+state.broker.limits.dailyLossLimitUsd):'—'));
  const env=$('#tmEnv');
  const demo=mode==='proxy'?!!dh.demo:/demo|virtual/i.test(state.broker?.account?.account_type||'');
  env.textContent=demo?'DEMO (Deriv virtual)':'LIVE (Deriv real)';
  env.className='badge '+(demo?'demo':'live');
  const acctEl=$('#tmAccount');
  if(acctEl){
    const a=(state.broker&&state.broker.account)||{};
    acctEl.textContent=(demo?'DEMO':'REAL')+' · '+(a.currency||'USD')+' · …'+String(a.account_id||'').slice(-4);
  }
  $('#tmGate').classList.add('hidden');
  $('#tmHint').textContent=mode==='pat_server'
    ?'Server checks your risk limits, then fetches a live quote from Deriv’s official API with your PAT (held only in this server’s memory). The FINAL quote is fetched the instant you press Confirm — the payout may differ slightly from the one shown. Your browser never sends the order.'
    :mode==='proxy'
    ?'Server-side quote via /api/deriv — your token never leaves the server. Nothing is executed until you press Confirm.'
    :'Classic token: quote and buy run from your browser over the official Deriv WebSocket (Deriv blocks datacenter servers). Nothing is executed until you press Confirm.';
  const okBtn=$('#tmConfirm'); okBtn.disabled=true; okBtn.textContent='Fetching quote…';
  $('#tmModal').classList.add('open');

  /* live price over the WS relay (real ticks) */
  tmUnsub&&tmUnsub();
  tmUnsub=tickFeed(I.s,(t)=>{ if(t&&t.quote!=null)$('#tmLive').textContent=fmtPx(t.quote,I.d); });

  if(mode==='pat_server'){
    try{
      const q=await patCall(()=>patProposal(state.broker,{symbol:I.s,side:state.side,amount:amt,duration:du.duration,duration_unit:du.duration_unit}));
      if(!tmCtx||tmCtx.mode!=='pat_server')return;
      tmCtx.ticket=q.ticket;
      $('#tmPayout').textContent=fmtMoney(q.quote.payout)+' ('+q.quote.currency+')';
      $('#tmPayout').textContent=fmtMoney(q.quote.payout)+' ('+q.quote.currency+')';
      $('#tmBE').textContent=beWinRateText(amt,q.quote.payout);
      $('#tmStake').textContent=fmtMoney(q.quote.stake);
      $('#tmBE').textContent=beWinRateText(q.quote.stake,q.quote.payout);
      const qdu={duration:q.quote.duration,duration_unit:q.quote.duration_unit};
      $('#tmDuration').textContent=durHuman(qdu)+' contract · settles '+settleText(qdu)+(q.quote.clamped&&q.quote.requested?(' · auto-adjusted from '+q.quote.requested.duration+q.quote.requested.unit+' to match Deriv’s range for '+I.s):'')
        +(q.quote.lineup_note?(' ⚠ '+q.quote.lineup_note):'')+longLockWarn(qdu,I);
      okBtn.disabled=false; okBtn.textContent='Confirm trade';
    }catch(e){
      const g=$('#tmGate'); g.classList.remove('hidden');
      g.innerHTML='<b>'+String(e.code||'Quote failed')+'</b><br>'+String(e.message||e)
        +(/duration/i.test(String(e.message||e))?'<br><span class="faint">Pick a different duration in the order ticket and try again.</span>':'')
        +(isNoSessionErr(e)?'<br><button class="btn sm" id="tmRetry" style="margin-top:8px">Reconnect &amp; retry</button>':'');
      const rb=$('#tmRetry');
      if(rb)rb.onclick=async()=>{ rb.disabled=true; rb.textContent='Reconnecting…'; tmClose(); try{await patHeal();}catch(_){} placeOrder(); };
      okBtn.textContent='Quote unavailable';
    }
  }else if(mode==='proxy'){
    try{
      const q=await derivProposal({symbol:I.s,side:state.side,amount:amt,duration:du.duration,duration_unit:du.duration_unit});
      if(!tmCtx||tmCtx.mode!=='proxy')return; /* modal closed while awaiting */
      tmCtx.ticket=q.ticket;

      $('#tmBE').textContent=beWinRateText(amt,q.quote.payout);
      $('#tmStake').textContent=fmtMoney(q.quote.stake);
      const qdu2=(q.quote.duration!=null)?{duration:q.quote.duration,duration_unit:q.quote.duration_unit}:du;
      $('#tmDuration').textContent=durHuman(qdu2)+' contract · settles '+settleText(qdu2)+longLockWarn(qdu2,I);
      okBtn.disabled=false; okBtn.textContent='Confirm trade';
    }catch(e){
      const g=$('#tmGate'); g.classList.remove('hidden');
      g.innerHTML='<b>'+escHtml(String(e.code||'Quote failed'))+'</b><br>'+escHtml(String(e.message||e))+(e.hint?'<br><span class="faint">'+escHtml(e.hint)+'</span>':'')+(/duration/i.test(String(e.message||e))?'<br><span class="faint">Pick a different duration in the order ticket and try again.</span>':'');
      okBtn.textContent='Quote unavailable';
    }
  }else{
    okBtn.disabled=false; okBtn.textContent='Confirm trade';
  }
}
$('#tmCancel').onclick=tmClose;
$('#tmModal').addEventListener('click',(e)=>{ if(e.target===$('#tmModal'))tmClose(); });
$('#tmConfirm').onclick=async ()=>{
  if(isCloudflareReadonlyMode()){tmClose();toast('Read-only staging','Order execution is disabled on Cloudflare staging.','warn');return;}
  const t=tmCtx; if(!t)return;
  const okBtn=$('#tmConfirm'); okBtn.disabled=true; okBtn.textContent='Sending…';
  const g=$('#tmGate'); g.classList.add('hidden');
  try{
    let pos=null;
    if(t.mode==='proxy'){
      const r=await derivConfirm(t.ticket);
      const o=r.order;
      pos={ id:Date.now()+'_p'+o.contract_id, sym:t.I.s, side:t.side, amt:t.amt,
        entry:t.px, sl:isNaN(t.sl)?null:t.sl, tp1:isNaN(t.tp)?null:t.tp, tp2:isNaN(t.tp2)?null:t.tp2,
        t:Date.now(), broker:'deriv', contract_id:o.contract_id, payout:o.payout,
        dur:{duration:t.dur.duration,duration_unit:t.dur.duration_unit},
        flags:{proxy:true, env:r.environment, demo:!!r.demo} };
      notify('Trade opened',(r.demo?'DEMO · ':'')+'Deriv proxy '+t.side+' '+t.I.s+' · stake '+fmtMoney(o.stake)+' · payout '+fmtMoney(o.payout)+' · contract #'+o.contract_id+'.',{tag:'trade',kind:'ok'});
      toast('Order filled',(r.demo?'DEMO ':'')+t.side+' '+fmtMoney(o.stake)+' '+t.I.s+' · payout '+fmtMoney(o.payout),'ok');
    }else if(t.mode==='pat_server'){
      const r=await patConfirm(t.ticket);
      const o=r.order;
      if(o.balance_after!=null){ state.balance=Number(o.balance_after); updateKpis(); updateSessionInfo(); renderPatAccounts(); } /* authoritative deduction from Deriv */
      pos={ id:Date.now()+'_s'+o.contract_id, sym:t.I.s, side:t.side, amt:t.amt,
        entry:t.px, sl:isNaN(t.sl)?null:t.sl, tp1:isNaN(t.tp)?null:t.tp, tp2:isNaN(t.tp2)?null:t.tp2,
        t:Date.now(), broker:'deriv', contract_id:o.contract_id, payout:o.payout,
        buy_price:o.buy_price||t.amt, settleAt:Date.now()+t.dur.duration*(t.dur.duration_unit==='m'?60000:t.dur.duration_unit==='h'?3600000:t.dur.duration_unit==='d'?86400000:1000),
        dur:{duration:t.dur.duration,duration_unit:t.dur.duration_unit},
        flags:{pat_server:true} };
      notify('Trade opened',(state.broker.account?.account_type==='demo'?'DEMO · ':'')+'Deriv PAT '+t.side+' '+t.I.s+' · stake '+fmtMoney(o.buy_price||t.amt)+' · payout '+fmtMoney(o.payout)+' · contract #'+o.contract_id+'.',{tag:'trade',kind:'ok'});
      toast('Order filled',t.side+' '+fmtMoney(o.buy_price||t.amt)+' '+t.I.s+(o.balance_after!=null?(' · balance '+fmtMoney(Number(o.balance_after))):'')+' · settles in '+t.dur.duration+' '+t.dur.duration_unit,'ok');
    }else{
      /* server risk gate first — limits enforced before anything moves */
      const onceId=Date.now().toString(36)+Math.random().toString(36).slice(2,8);
      const g=await api('/api/deriv/order',{method:'POST',body:{symbol:t.I.s,amount:t.amt,side:t.side,duration:t.dur.duration,duration_unit:t.dur.duration_unit,once:onceId},headers:{'x-deriv-pat':state.broker.pat,'x-deriv-appid':state.broker.appId||''}});
      const gate=await g.json().catch(()=>({}));
      if(!g.ok)throw new Error(gate.detail||gate.error||'Order rejected by server-side risk limits');
      const dsym=(INSTRUMENT_MAP[t.I.s]||{}).deriv; if(!dsym)throw new Error('No Deriv symbol mapped for '+t.I.s);
      const pr=await derivWsProposal(state.broker.appId,state.broker.pat,{derivSymbol:dsym,side:t.side,amount:t.amt,duration:t.dur.duration,duration_unit:t.dur.duration_unit});
      const o=await derivWsBuy(state.broker.appId,state.broker.pat,pr.id,pr.ask_price);
      pos={ id:Date.now()+'_d'+o.contract_id, sym:t.I.s, side:t.side, amt:t.amt,
        entry:t.px, sl:isNaN(t.sl)?null:t.sl, tp1:isNaN(t.tp)?null:t.tp, tp2:isNaN(t.tp2)?null:t.tp2,
        t:Date.now(), broker:'deriv', contract_id:o.contract_id, payout:o.payout,
        dur:{duration:t.dur.duration,duration_unit:t.dur.duration_unit}, flags:{pat:true} };
      api('/api/deriv/fill',{method:'POST',body:{kind:'open',contract_id:o.contract_id,stake:o.buy_price},headers:{'x-aurum-user':state.user||'local'}}).catch(()=>{});
      notify('Trade opened','Deriv '+t.side+' '+t.I.s+' · stake '+fmtMoney(o.stake||t.amt)+' · payout '+fmtMoney(o.payout)+' · '+t.dur.duration+t.dur.duration_unit+' contract.',{tag:'trade',kind:'ok'});
      toast('Order filled',t.side+' '+fmtMoney(t.amt)+' '+t.I.s+' · payout '+fmtMoney(o.payout),'ok');
    }
    state.positions.push(pos); save();
    renderNavCounts(); renderPortfolio();
    tmClose();
  }catch(e){
    g.classList.remove('hidden');
    g.innerHTML='<b>Order not placed</b><br>'+String(e.message||e);
    okBtn.disabled=false; okBtn.textContent='Confirm trade';
    notify('Order failed',String(e.message||e),{tag:'trade',kind:'err'});
  }
};

/* ---------- Deriv proxy health pill (topbar) ---------- */
/* Cloud + PC are one workspace in two places. The cloud viewer has no broker
   proxy, so the same pill names the place instead of asking a route that is
   disabled by design (and reporting it as "offline"). */
function showCloudViewerMode(){
  state.derivHealth={state:'offline'};
  const dot=$('#derivDot'), txt=$('#derivText'), pill=$('#derivPill');
  if(dot)dot.style.background='var(--text-3,#666)';
  if(txt)txt.textContent='Cloud · view only';
  if(pill)pill.title='AURUM cloud viewer: live public prices and analysis, viewable anywhere. Orders, accounts and Exness/MT5 are available only in the PC app.';
  const mode=$('#aboutMode'); if(mode)mode.textContent='Cloud viewer · read-only';
  const trading=$('#aboutTrading'); if(trading)trading.textContent='Not available here · use the PC app';
  const analysis=$('#aboutAnalysis'); if(analysis)analysis.textContent='Deriv markets: this browser, from Deriv public candles · indices: AURUM cloud';
}
async function refreshDerivPill(){
  if(isCloudflareReadonlyMode()){ showCloudViewerMode(); return; }
  const h=await derivHealth();
  state.derivHealth=h;
  const dot=$('#derivDot'), txt=$('#derivText');
  if(!dot||!txt)return;
  const st=h.state||'offline';
  const envTag=h.environment==='demo'?'DEMO':(h.environment||'');
  if(st==='authorized'){ dot.style.background='var(--green)'; txt.textContent='proxy · '+envTag+(h.tradingEnabled?'':' (trading off)'); }
  else if(st==='connecting'||st==='authenticating'){ dot.style.background='var(--amber,#f59e0b)'; txt.textContent='proxy · connecting…'; }
  else if(st==='not_configured'){ dot.style.background='var(--text-3,#666)'; txt.textContent='proxy · not configured'; }
  else { dot.style.background='var(--text-3,#666)'; txt.textContent='proxy · '+st; }
  $('#derivPill').title='Deriv proxy: '+st+(h.authorized?' · authorized':'')+(h.environment?' · '+h.environment:'')+(h.missing&&h.missing.length?' · missing '+h.missing.join(', '):'')+' (token is server-side only)';
}
refreshDerivPill();
setInterval(refreshDerivPill,30000);

/* ---------- Backtest (walk-forward on real Deriv candles) ---------- */
$('#btRun').onclick=async ()=>{
  const sym=$('#azSymbol').value;
  if(!sym){ toast('No symbol','Pick a symbol in “Analyze a symbol” first.','err'); return; }
  const gran=Number($('#btGran').value), bars=Number($('#btBars').value);
  const btn=$('#btRun'); btn.disabled=true; btn.textContent='Running…';
  try{
    const res=await api('/api/backtest',{method:'POST',body:{symbol:sym,granularity:gran,bars}});
    const d=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(d.detail||d.error||('backtest failed ('+res.status+')'));
    const st=d.stats||{};
    $('#btStats').innerHTML=[
      ['TRADES',st.trades??0],['WIN RATE',(st.winRate??0)+'%'],['NET R',(st.netR>0?'+':'')+(st.netR??0)],
      ['PROFIT FACTOR',st.profitFactor==null?'∞':st.profitFactor],['MAX DD (R)',st.maxDrawdownR??0],
      ['WINS / LOSSES',(st.wins??0)+' / '+(st.losses??0)]
    ].map(([k,v])=>'<div class="az-tile"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');
    const rows=(d.trades||[]).slice(-30);
    $('#btTrades').innerHTML=rows.map((t,i)=>{
      const cls=t.result==='sl'?'down':(t.result==='tp1'||t.result==='tp2'?'up':'');
      const r=(t.r>0?'+':'')+t.r;
      return '<tr><td class="muted">'+(i+1)+'</td><td>'+t.side+'</td><td class="right mono">'+t.entry+'</td><td class="right mono">'+t.exit+'</td><td class="right">'+t.bars+'</td><td><span class="badge '+(cls==='up'?'green':cls==='down'?'red':'gray')+'">'+t.result+'</span></td><td class="right '+cls+'"><b>'+r+'</b></td></tr>';
    }).join('');
    $('#btNote').textContent=(d.note||'')+' · '+(d.bars||bars)+' bars · '+(d.source||'deriv-candles')+' · '+(d.trades&&d.trades.length>30?'last 30 trades shown':'')+'. Past performance on history is not a guarantee — always risk-test forward.';
    $('#btEmpty').classList.add('hidden'); $('#btResult').classList.remove('hidden');
    toast('Backtest done',sym+' · '+st.trades+' trades · '+(st.winRate??0)+'% win · net '+(st.netR>0?'+':'')+(st.netR??0)+'R','ok');
  }catch(e){
    toast('Backtest failed',String(e.message||e),'err');
  }finally{ btn.disabled=false; btn.textContent='Run backtest'; }
};
/* ---------- Rule-based setups (ANALYSIS-ONLY: display + journaling, never orders) ---------- */
{
  const suEsc=(x)=>String(x==null?'':x).replace(/[<>&"]/g,(c)=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const suParams=()=>{
    const sym=($('#suSymbol').value||'').trim()||($('#azSymbol').value||'').trim();
    return { symbol:sym, granularity:Number($('#suGran').value) };
  };
  const suCondChip=(cd)=>{
    const ok=cd.passed, val=cd.value==null?'':(' = '+(typeof cd.value==='number'? (Math.abs(cd.value)>=100?cd.value.toFixed(0):cd.value.toFixed(4).replace(/0+$/,'').replace(/\.$/,'')) : cd.value));
    return '<span class="badge '+(ok?'green':'gray')+'" style="font-weight:400" title="'+suEsc(cd.value==null?'':String(cd.value))+'">'+(ok?'\u2713':'\u2717')+' '+suEsc(cd.name)+suEsc(val)+'</span>';
  };
  const suRow=(r)=>{
    const fired=!!r.direction, dirCls=r.direction==='BUY'?'green':(r.direction==='SELL'?'red':'gray');
    const conf=r.confidence==null?'—':r.confidence+'%';
    const lv=fired
      ? '<div class="row wrap mono" style="gap:14px;margin-top:8px">'
        +'<span class="tiny faint">ENTRY <b class="mono">'+suEsc(r.entry)+'</b></span>'
        +'<span class="tiny faint">STOP <b class="mono" style="color:var(--red)">'+suEsc(r.stop)+'</b></span>'
        +'<span class="tiny faint">TP1 <b class="mono" style="color:var(--green,#2e9e5b)">'+suEsc(r.tp1)+'</b></span>'
        +'<span class="tiny faint">R:R <b class="mono">'+suEsc(r.rr)+'</b></span></div>'
      : '';
    const reason=fired?'':'<div class="tiny faint" style="margin-top:6px">Skipped: <span class="mono">'+suEsc(r.reasonIfSkipped)+'</span>'+(r.validData?'':' · data not valid for this setup (never fabricated)')+'</div>';
    return '<div class="card" style="margin-bottom:10px;'+(fired?'':'opacity:.62')+'">'
      +'<div class="row between wrap" style="gap:8px">'
      +'<div><b>'+suEsc(r.setup.replaceAll('_',' '))+'</b> <span class="badge '+dirCls+'">'+(r.direction||'NO SIGNAL')+'</span>'
      +(fired?' <span class="tiny faint">confidence '+conf+'</span>':'')+'</div>'
      +(fired?'<button class="btn tiny" data-su-journal="'+suEsc(r.setup)+'">Journal</button>':'')
      +'</div>'
      +(r.conditions.length?'<div class="row wrap" style="gap:6px;margin-top:8px">'+r.conditions.map(suCondChip).join('')+'</div>':'')
      +lv+reason+'</div>';
  };
  const suJournal=async(r,sym,gran)=>{
    try{ if(!cloudConfig())return; await saveAnalysis('setups',sym,String(gran),{setup:r.setup,direction:r.direction,entry:r.entry,stop:r.stop,tp1:r.tp1,rr:r.rr,confidence:r.confidence,conditions:r.conditions,reasonIfSkipped:r.reasonIfSkipped}); toast('Journaled',r.setup+' saved to analysis history','ok'); }
    catch(e){ toast('Journal failed',String(e.message||e),'err'); }
  };
  let suLast=null;
  $('#suRun').onclick=async()=>{
    const p=suParams();
    if(!p.symbol){ toast('No symbol','Type a symbol (e.g. EURUSD) or pick one in “Analyze a symbol”.','err'); return; }
    const btn=$('#suRun'); btn.disabled=true; btn.textContent='Checking…';
    try{
      const res=await api('/api/setups/analyze',{method:'POST',body:p});
      const d=await res.json().catch(()=>({}));
      if(res.status===503&&d.error==='setups_disabled'){ $('#suEmpty').classList.remove('hidden'); $('#suResult').classList.add('hidden'); $('#suEmpty').innerHTML='<b>Setups module is OFF</b>'+suEsc(d.hint||'')+' This module is analysis-only and opt-in.'; return; }
      if(!res.ok)throw new Error(d.detail||d.error||('setups failed ('+res.status+')'));
      suLast={results:d.results,symbol:d.symbol,gran:p.granularity};
      $('#suResult').innerHTML='<div class="row between wrap" style="margin-bottom:10px;gap:8px"><span class="tiny faint">'+suEsc(d.symbol)+' · '+suEsc(String(p.granularity/60))+'m · category '+suEsc(d.category)+' · data '+(d.dataQuality&&d.dataQuality.accepted)+' bars'+(d.dataQuality&&(d.dataQuality.gaps||d.dataQuality.duplicates)?' <span style="color:var(--amber)">(quality issues logged)</span>':'')+' · analysis only, no orders</span></div>'
        +d.results.map(suRow).join('')
        +'<p class="hint">Rule evaluation on real candles. A listed signal is NOT a trade — nothing here places orders. Validity checks: '+(d.results.filter(r=>!r.validData).map(r=>suEsc(r.setup)).join(', ')||'all setups valid')+'</p>';
      $('#suEmpty').classList.add('hidden'); $('#suResult').classList.remove('hidden');
      $('#suResult').querySelectorAll('[data-su-journal]').forEach((b)=>{ b.onclick=()=>{ const r=suLast.results.find((x)=>x.setup===b.getAttribute('data-su-journal')); if(r)suJournal(r,suLast.symbol,suLast.gran); }; });
      if(cloudConfig())saveAnalysis('setups_scan',d.symbol,String(p.granularity),{results:d.results}).catch(()=>{});
      toast('Setups checked',d.results.filter((r)=>r.direction).length+' of 4 fired for '+d.symbol,'ok');
    }catch(e){ toast('Setups failed',String(e.message||e),'err'); }
    finally{ btn.disabled=false; btn.textContent='Check setups'; }
  };
  $('#suBacktest').onclick=async()=>{
    const p=suParams();
    if(!p.symbol){ toast('No symbol','Type a symbol (e.g. EURUSD) or pick one in “Analyze a symbol”.','err'); return; }
    const btn=$('#suBacktest'); btn.disabled=true; btn.textContent='Backtesting…';
    try{
      const res=await api('/api/setups/backtest',{method:'POST',body:p});
      const d=await res.json().catch(()=>({}));
      if(res.status===503&&d.error==='setups_disabled'){ $('#suEmpty').classList.remove('hidden'); $('#suResult').classList.add('hidden'); $('#suEmpty').innerHTML='<b>Setups module is OFF</b>'+suEsc(d.hint||''); return; }
      if(!res.ok)throw new Error(d.detail||d.error||('setups backtest failed ('+res.status+')'));
      const rows=Object.entries(d.perSetup).map(([name,m])=>{
        const o=m.oos||{};
        return '<tr><td><b>'+suEsc(name.replaceAll('_',' '))+'</b>'+(m.warning?'<div class="tiny" style="color:var(--amber)">'+suEsc(m.warning)+'</div>':'')+'</td>'
          +'<td class="right">'+(o.trades??0)+'</td><td class="right">'+(o.winRate??0)+'%</td><td class="right '+(o.expectancyR>0?'up':(o.expectancyR<0?'down':''))+'">'+(o.expectancyR>0?'+':'')+(o.expectancyR??0)+'R</td>'
          +'<td class="right">'+(o.profitFactor==null?'—':o.profitFactor)+'</td><td class="right">'+(o.maxDrawdownR??0)+'R</td><td class="right">'+(o.longestLossStreak??0)+'</td></tr>';
      }).join('');
      $('#suResult').innerHTML='<div class="tiny faint" style="margin-bottom:10px">'+suEsc(d.symbol)+' · out-of-sample = last '+Math.round((d.outOfSampleShare||0.3)*100)+'% of '+suEsc(String(d.barsEvaluated))+' evaluated bars · '+suEsc(d.scoring==='r'?'R-multiples (pessimistic spread + slippage, SL-first)':'binary outcome at fixed horizon')+' · analysis only</div>'
        +'<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Setup</th><th class="right">OOS trades</th><th class="right">Win rate</th><th class="right">Expectancy</th><th class="right">Profit factor</th><th class="right">Max DD</th><th class="right">Losing streak</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
        +'<p class="hint" style="margin-top:10px">'+suEsc(d.note||'')+' Fewer than 30 out-of-sample trades is flagged — those numbers are NOT conclusive.</p>';
      $('#suEmpty').classList.add('hidden'); $('#suResult').classList.remove('hidden');
      if(cloudConfig())saveAnalysis('setups_backtest',d.symbol,String(p.granularity),{perSetup:d.perSetup,scoring:d.scoring}).catch(()=>{});
      toast('Setups backtest done','Out-of-sample stats computed — see warnings per setup','ok');
    }catch(e){ toast('Setups backtest failed',String(e.message||e),'err'); }
    finally{ btn.disabled=false; btn.textContent='Backtest setups'; }
  };
}
$('#placeOrderBtn').onclick=placeOrder;
/* ---------- Chart pattern recognition (server-side detection) ---------- */
{
  const esc = (x) => String(x == null ? '' : x).replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const patGranEl = $('#patGran');
  try { const g = localStorage.getItem('aurum.patGran'); if (g && patGranEl) patGranEl.value = g; } catch {}
  patGranEl && patGranEl.addEventListener('change', () => { try { localStorage.setItem('aurum.patGran', patGranEl.value); } catch {} });
  const pb = $('#playbook');
  if (pb) pb.innerHTML = playbookHTML();

  let patData = null;
  let patSel = 0;
  const patIcon = { bullish: '▲', bearish: '▼', neutral: '◆' };

  function renderPatDetections() {
    const grid = $('#patDetections');
    if (!grid || !patData) return;
    const list = patData.patterns || [];
    if (!list.length) {
      grid.innerHTML = '<div class="empty"><b>No textbook patterns in the last ' + patData.bars + ' bars</b>Markets trend or chop without forming a classic geometry — try another timeframe (1h / 4h / 1D), or run “Success rates” to see which patterns historically work on this pair.</div>';
      return;
    }
    grid.innerHTML = list.map((d, i) =>
      '<div class="pat-card' + (i === patSel ? ' sel' : '') + '" data-pat-i="' + i + '">' +
        '<div class="hd"><b>' + esc(patIcon[d.direction] || '◆') + ' ' + esc(d.pattern) + '</b>' +
        '<span class="badge ' + (d.action === 'BUY' ? 'buy' : d.action === 'SELL' ? 'sell' : 'gray') + '">suggest: ' + esc(d.action) + '</span>' +
        '<span class="tiny faint">' + esc(d.status) + '</span></div>' +
        '<div class="cs">' + esc(d.detail || '') + '</div>' +
        '<div class="lb"><span>confidence ' + d.confidence + '%</span><span>' + patData.granularity + 's · ' + patData.bars + ' bars</span></div>' +
      '</div>').join('');
    grid.querySelectorAll('[data-pat-i]').forEach((el) => el.addEventListener('click', () => {
      patSel = parseInt(el.getAttribute('data-pat-i'), 10) || 0;
      showPatSelection();
    }));
  }

  function showPatSelection() {
    if (!patData) return;
    const list = patData.patterns || [];
    if (patSel >= list.length) patSel = 0;
    const d = list[patSel];
    renderPatDetections();
    const meta = $('#patMeta'), levels = $('#patLevels');
    if (!d) {
      if (meta) meta.textContent = '—';
      if (levels) levels.textContent = '';
      renderPatternChart($('#patChart'), patData.candles, null);
      return;
    }
    if (meta) meta.innerHTML = '<b>' + esc(d.pattern) + '</b> · ' + esc(d.direction) + ' · ' + esc(d.status) +
      ' · age ' + d.ageBars + ' bar' + (d.ageBars === 1 ? '' : 's') + ' · suggested <b>' + esc(d.action) + '</b>';
    if (levels) levels.textContent = ['entry ' + (d.entry ?? '—'), 'stop ' + (d.stop ?? '—'), 'target ' + (d.target ?? '—')].join(' · ') +
      (d.status === 'forming' ? ' · forming: wait for the break — action stays HOLD' : '');
    renderPatternChart($('#patChart'), patData.candles, d);
  }

  async function runPatternScan() {
    const symbol = ($('#azSymbol')?.value || '').trim();
    if (!symbol) { toast('No symbol', 'Pick a pair in “Analyze a symbol” first (e.g. EURUSD).', 'err'); return; }
    const btn = $('#patRun');
    const gran = parseInt(patGranEl?.value || '300', 10);
    if (btn) { btn.disabled = true; btn.textContent = 'scanning…'; }
    try {
      patData = await patternAnalyze(symbol, gran, 120);
      const emptyEl = $('#patEmpty'), resEl = $('#patResults');
      if (emptyEl) emptyEl.hidden = true;
      if (resEl) resEl.hidden = false;
      const list = patData.patterns || [];
      const fi = list.findIndex((x) => x.status === 'formed' && x.confidence >= 60);
      patSel = fi >= 0 ? fi : 0;
      showPatSelection();
      const hot = list.filter((x) => x.status === 'formed' && x.confidence >= 60 && x.action !== 'HOLD').slice(0, 3);
      if (hot.length) {
        notify('Pattern alert · ' + symbol.toUpperCase(),
          hot.map((x) => x.pattern + ' ' + x.direction + ' ' + x.confidence + '% → ' + x.action).join(' · '),
          { tag: 'patterns', kind: hot[0].action === 'BUY' ? 'ok' : 'err' });
      }
      if (!list.length) toast('No patterns', symbol.toUpperCase() + ' ' + gran + 's has no textbook geometry right now.', 'ok');
      if (cloudConfig()) {
        saveAnalysis('pattern_scan', symbol, String(gran), {
          bars: patData.bars,
          patterns: list.map((x) => ({ key: x.key, status: x.status, confidence: x.confidence, action: x.action }))
        });
        const lastClose = (patData.candles && patData.candles.length) ? patData.candles[patData.candles.length - 1].close : null;
        list.filter((x) => x.status === 'formed').slice(0, 6).forEach((x) => savePatternEvent(x, symbol, String(gran), lastClose));
        if (hot.length) saveAlert('patterns', 'Pattern alert · ' + symbol, hot.map((x) => x.pattern + ' ' + x.direction + ' ' + x.confidence + '% → ' + x.action).join(' · '));
      }
    } catch (e) {
      toast('Pattern scan failed', e.code === 'insufficient_history'
        ? 'Not enough candles on this pair yet — try a longer timeframe.'
        : String(e.message || e), 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Detect patterns'; }
    }
  }

  async function runPatternStudy() {
    const symbol = ($('#azSymbol')?.value || '').trim();
    if (!symbol) { toast('No symbol', 'Pick a pair in “Analyze a symbol” first.', 'err'); return; }
    const btn = $('#patStudy');
    if (btn) { btn.disabled = true; btn.textContent = 'replaying history…'; }
    try {
      const granSt = parseInt(patGranEl?.value || '300', 10);
      const st = await patternStudy(symbol, granSt, 600);
      const wrap = $('#patPerfWrap');
      if (wrap) wrap.hidden = false;
      const w = $('#patPerf');
      if (w) w.innerHTML = performanceHTML(st);
      toast('Success rates', st.signals + ' signals in ' + st.window + ' bars · walk-forward on real candles.', 'ok');
      if (cloudConfig()) saveAnalysis('pattern_study', symbol, String(granSt), { window: st.window, signals: st.signals, patterns: (st.patterns || []).slice(0, 8) });
    } catch (e) {
      toast('Study failed', String(e.message || e), 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Success rates'; }
    }
  }

  $('#patRun').onclick = runPatternScan;
  $('#patStudy').onclick = runPatternStudy;
}


/* ================================================================
   PORTFOLIO
   ================================================================ */
function renderNavCounts(){
  const n=state.positions.length;
  const el=$('#navPosCount');
  if(el){el.textContent=n;el.style.display=n?'grid':'none';}
  const sniper=$('#navSniperCount');if(sniper){sniper.textContent=sniperWatchSymbols.size;sniper.style.display=sniperWatchSymbols.size?'grid':'none';}
}
function isBinaryPos(p){ return !!(p.contract_id&&(p.external||(p.flags&&(p.flags.pat_server||p.flags.pat)))); }
function posPl(p){
  if(p.settling)return null;
  /* Deriv binaries: use Deriv's own live valuation (bid − buy). Marking a
     binary to spot with the CFD formula is meaningless — a $10 stake is
     escrowed, not lost, and returns as payout or 0 at expiry. */
  if(isBinaryPos(p))return (p.liveProfit!=null&&Number.isFinite(Number(p.liveProfit)))?Number(p.liveProfit):null;
  const I=bySym[p.sym]; if(!I||I.p==null)return null;
  const dir=p.side==='BUY'?1:-1;
  const v=((I.p-p.entry)/p.entry)*p.amt*dir;
  return Number.isFinite(v)?v:null; /* a NaN/Infinity here would poison equity + open P&L */
}
async function closeWithBroker(p,exitPx,reason){
  if(isCloudflareReadonlyMode()){
    toast('Read-only staging','Cloudflare staging cannot close or manage Deriv contracts. Use the Deriv platform directly for any open position; Exness remains PC-local.','warn');
    return;
  }
  const I=bySym[p.sym];
  try{
    if(p.broker==='deriv'&&p.flags?.proxy){
      /* closed through the secure server proxy (env-token path) */
      const res=await api('/api/deriv/close',{method:'POST',body:{contract_id:p.contract_id}});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.detail||data.error||'Deriv proxy close failed');
      closePosition(p,data.result?.sold_for??exitPx,true);
      notify('Trade closed',(reason||'Position closed')+' · sold for '+fmtMoney(data.result?.sold_for),{tag:'trade',kind:'ok'});
    }else if(p.broker==='deriv'&&(p.flags?.pat_server||(p.external&&state.broker?.mode==='pat_server'))&&state.broker?.mode==='pat_server'){
      try{
        const r=await patClose(p.contract_id,p.amt);
        closePosition(p,r.result?.sold_for??exitPx,true);
        notify('Trade closed',(reason||'Position closed')+' · sold for '+fmtMoney(r.result?.sold_for),{tag:'trade',kind:'ok'});
      }catch(ex){
        /* Deriv refuses resale on many short binaries [InvalidToSell] — explain
           instead of failing: the settle watcher books the result at expiry. */
        if(/InvalidToSell|not offered|resale/i.test(String(ex.message||ex))){
          p.canSell=false; p.closeOnUnlock=true; save(); renderPortfolio();
          toast('Force close queued',p.sym+' is Deriv-locked until settlement — the sell was refused again. It is now QUEUED: the moment Deriv unlocks resale, Aurum closes it automatically (checked every 5s, no need to watch). Max loss is capped at the stake you already paid. Deriv locks this contract to expiry unless it unlocks — then it books either way.',{kind:'warn'});
          notify('Force close queued',p.sym+' — resale refused. Aurum will close it automatically the instant Deriv unlocks.',{tag:'trade',kind:'warn'});
          return;
        }
        if(/RateLimit|rate limit|sell_throttled/i.test(String(ex.message||ex)+' '+String(ex.code||''))){
          p.closeOnUnlock=true; save();
          toast('Deriv is limiting sells','Sell requests are capped per second on Deriv. '+p.sym+' is QUEUED — Aurum closes it at the first moment Deriv accepts (and at settlement at the latest). Nothing is lost by waiting.',{kind:'warn'});
          return;
        }
        throw ex;
      }
    }else if(p.broker==='deriv'&&state.broker?.type==='deriv'){
      const g=await api('/api/deriv/close',{method:'POST',body:{contract_id:p.contract_id},headers:{'x-deriv-pat':state.broker.pat,'x-deriv-appid':state.broker.appId||'','x-aurum-user':state.user||'local'}});
      const gate=await g.json().catch(()=>({}));
      if(!g.ok)throw new Error(gate.detail||gate.error||'Close rejected');
      const sold=await derivWsSell(state.broker.appId,state.broker.pat,p.contract_id);
      api('/api/deriv/fill',{method:'POST',body:{kind:'close',contract_id:p.contract_id,pnl:Number(sold.price)-Number(p.amt||0)},headers:{'x-aurum-user':state.user||'local'}}).catch(()=>{});
      closePosition(p,sold?.price??exitPx,true);
      notify('Trade closed',(reason||'Position closed')+' · sold for '+fmtMoney(sold?.price),{tag:'trade',kind:'ok'});
    }else if(p.broker==='hfm'){
      toast('Legacy HFM record','This saved record is not linked to Exness. Check its original broker terminal; no close was sent and the record was not cleared.','warn');
      return;
    }else{
      closePosition(p,exitPx,true);
      notify('Trade closed',reason||('Position '+p.sym+' closed.'),{tag:'trade',kind:'ok'});
    }
  }catch(e){
    toast('Close failed',String(e.message||e),'err');
    notify('Close failed',p.sym+' — '+String(e.message||e),{tag:'trade',kind:'err'});
  }
}
function closePosition(p,exitPx,silent){
  const I=bySym[p.sym];
  const px=exitPx!=null?exitPx:(I&&I.p!=null?I.p:null);
  const pl=(px!=null)?((px-p.entry)/p.entry)*p.amt*(p.side==='BUY'?1:-1):null;
  const wasAuto=!!(p.flags&&p.flags.at);
  state.history.unshift({sym:p.sym,side:p.side,amt:p.amt,entry:p.entry,exit:px,pl,t:Date.now(),broker:p.broker||null,at:wasAuto});
  state.positions=state.positions.filter(x=>x.id!==p.id);
  histPersist(); guardRecheckAfterClose();
  save(); renderNavCounts(); renderPortfolio(); updateKpis();
  if(wasAuto){
    /* loss-streak guard counts Exness/CFD closes too (Deriv settlements count in
       the contract watcher) — 3 straight sniper losses stand it down per brakes */
    if(atSession){
      if(pl!=null&&pl<0){
        atSession.consecLosses=(atSession.consecLosses||0)+1;
        if(atSession.consecLosses>=3){
          atSession.consecLosses=0;
          if(atCfg().brakes==='stop'){
            disableAutoTrade('loss','3 losses in a row — stood down (loss guard)');
            notify('Sniper stood down','3 sniper losses in a row. Auto-trade is disarmed — review the Sniper record and re-arm when ready.',{tag:'auto',kind:'warn'});
          }else{
            notify('3 sniper losses in a row','Still running per your runs-until-stopped setting — watch the Sniper record; the server-side caps remain.',{tag:'auto',kind:'warn'});
          }
        }
      }else if(pl!=null&&pl>0)atSession.consecLosses=0;
    }
    atCheckProfit();
  }
  if(!silent)toast('Position closed',p.sym+' · P&L '+fmtMoney(pl,true),pl==null?'':(pl>=0?'ok':'err'));
}
async function closePosWithConfirm(p){
  const lockedNote=(p.canSell===false)?'\n\nDeriv last reported this contract as resale-locked — the sell will likely be refused. Aurum tries anyway, and if refused it QUEUES the force close: the instant Deriv unlocks resale, it closes automatically.':'';
  if(state.settings.confirmClose){
    const ok=await askConfirm('Close position?','Close '+p.sym+' '+p.side+' '+fmtMoney(p.amt)+' at market?'+lockedNote,'Close');
    if(!ok)return;
  }
  await closeWithBroker(p,null,null);
}
function posRow(p){
  const I=bySym[p.sym], pl=posPl(p), up=pl!=null&&pl>=0;
  const bin=isBinaryPos(p);
  const tr=document.createElement('tr');
  let currentCol,slCol,closeCol;
  if(bin){
    /* Deriv binary: stake escrowed → payout or 0 at expiry. Show Deriv's live
       valuation + expiry countdown. Resale only when Deriv allows it. */
    const durLbl=p.dur?(p.dur.duration+p.dur.duration_unit):'';
    const settle=p.settleAt?('settles '+new Date(p.settleAt).toTimeString().slice(0,8)+(durLbl?' · '+durLbl+' contract':'')):'awaiting expiry';
    currentCol='<td class="num mono tiny faint" data-exp="'+p.id+'" title="Countdown to Deriv settlement. Until resale unlocks, Deriv itself will not accept an early close — the result books automatically at settlement.">'+settle+'<div data-expin="'+p.id+'" class="faint"></div></td>';
    const tgtState=p.targetHit?'<span class="badge gray" style="color:var(--amber)">TARGET HIT — settles automatically</span>'
      :(p.profitTarget?('<span class="tiny faint">target +$'+p.profitTarget+(p.canSell===false?' · alerts only (Deriv-locked)':' · auto-close when resale unlocks')+'</span>'):'');
    slCol='<td class="num mono tiny faint">payout '+fmtMoney(p.payout||((p.buy_price||p.amt)*1.9))+' if win'
      +(p.canSell===false?'<div class="tiny faint" style="margin-top:2px">Deriv-locked · rides to expiry</div>':'')
      +(p.closeOnUnlock?'<div class="badge" data-unqueue="'+p.id+'" title="Force close is queued — it closes automatically the instant Deriv unlocks resale. Click to cancel and let it ride to settlement." style="color:var(--amber);margin-top:4px;cursor:pointer">FORCE QUEUED — auto-closes when Deriv unlocks ✕</div>':'')
      +(tgtState?'<div style="margin-top:2px">'+tgtState+'</div>':'')
      +'<div style="display:flex;gap:4px;align-items:center;margin-top:4px">'
      +'<input class="input mono" data-ptarget="'+p.id+'" type="number" step="0.5" min="0.5" placeholder="+$" value="'+(p.profitTarget||'')+'" style="width:64px;padding:2px 6px;font-size:11px" title="Alert + auto-close at this profit (if Deriv allows resale)">'
      +'</div></td>';
    closeCol='<td class="num"><button class="btn sm danger pos-close">Close</button></td>';
  }else{
    currentCol='<td class="num mono" data-px="'+p.sym+'">'+fmtPx(I?I.p:null,I?I.d:4)+'</td>';
    slCol='<td class="num mono tiny faint">'+(p.sl?fmtPx(p.sl,I?I.d:4):'—')+' / '+(p.tp1?fmtPx(p.tp1,I?I.d:4):(p.tp?fmtPx(p.tp,I?I.d:4):'—'))+'</td>';
    closeCol='<td class="num"><button class="btn sm danger pos-close">Close</button></td>';
  }
  tr.innerHTML=
    '<td><div class="sym-cell"><div class="sym-avatar">'+p.sym.replace(/[^A-Z0-9]/g,'').slice(0,3)+'</div><div><div class="sym-name">'+p.sym+'</div><div class="sym-full">'+(bin?(p.external?'synced from your Deriv account':'Deriv binary · stake held'):dateStr(p.t))+'</div></div></div></td>'+
    '<td><span class="badge '+(p.side==='BUY'?'buy':'sell')+'">'+p.side+'</span></td>'+
    '<td class="num mono">'+fmtMoney(p.amt)+'</td>'+
    '<td class="num mono">'+fmtPx(p.entry,I?I.d:4)+'</td>'+
    currentCol+
    '<td class="num pl-pos '+(pl==null?'':(up?'up':'down'))+'" data-pnl="'+p.id+'">'+(pl==null?(bin?'·':'—'):fmtMoney(pl,true))+'</td>'+
    slCol+
    closeCol;
  const uq=tr.querySelector('[data-unqueue]');
  if(uq)uq.onclick=()=>{ p.closeOnUnlock=false; save(); renderPortfolio(); toast('Force close cancelled',p.sym+' will ride to settlement and the result books automatically.','ok'); };
  const cb=tr.querySelector('.pos-close');
  if(cb){
    cb.title=(p.canSell===false)?'Deriv last reported no resale on this contract — clicking still tries, and if refused it rides to expiry with the result booked automatically.':'Sell this contract back at the current bid.';
    cb.disabled=!!p.__selling;
    cb.onclick=()=>{
      if(p.__selling)return;
      p.__selling=true; cb.disabled=true;
      Promise.resolve(closePosWithConfirm(p)).catch(()=>{}).finally(()=>{ setTimeout(()=>{ p.__selling=false; if(cb.isConnected)cb.disabled=false; },1200); });
    };
  }
  const ti=tr.querySelector('[data-ptarget]');
  if(ti)ti.onchange=()=>{
    const v=parseFloat(ti.value);
    p.profitTarget=(Number.isFinite(v)&&v>0)?v:null; p.targetHit=false;
    save();
    if(p.profitTarget)toast('Profit target set',p.sym+' — you will be alerted at +'+fmtMoney(p.profitTarget)+(p.canSell?' and it will close automatically.':' (Deriv locks this contract to expiry — you will still be alerted).'), 'ok');
  };
  return tr;
}
function renderPortfolio(){
  const body=$('#posBody'); body.innerHTML='';
  state.positions.forEach(p=>body.appendChild(posRow(p)));
  $('#posEmpty').classList.toggle('hidden',state.positions.length>0);
  $('#posWrap').classList.toggle('hidden',state.positions.length===0);
  const hb=$('#histBody'); hb.innerHTML='';
  /* Today listed; past days collapsed into one summary row each (click expands) */
  const todayKey=new Date().toDateString();
  const days=new Map();
  state.history.slice(0,120).forEach(h=>{
    const k=new Date(h.t).toDateString();
    if(!days.has(k))days.set(k,[]);
    days.get(k).push(h);
  });
  const expanded=state.histExpanded=state.histExpanded||new Set();
  [...days.entries()].forEach(([k,rows])=>{
    const isToday=k===todayKey;
    const net=rows.reduce((a,h)=>a+(h.pl||0),0);
    const wins=rows.filter(h=>(h.pl||0)>=0).length;
    if(!isToday&&!expanded.has(k)&&days.size>1){
      const sr=document.createElement('tr');
      sr.className='hist-day';
      sr.style.cursor='pointer';
      sr.innerHTML='<td colspan="7" class="tiny"><span class="faint mono">'+new Date(rows[0].t).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'})+'</span> · <b>'+rows.length+' trade'+(rows.length===1?'':'s')+'</b> · '+wins+'W/'+(rows.length-wins)+'L · net <b class="'+(net>=0?'up':'down')+'">'+fmtMoney(net,true)+'</b> <span class="faint">(tap to expand)</span></td>';
      sr.onclick=()=>{ expanded.has(k)?expanded.delete(k):expanded.add(k); renderPortfolio(); };
      hb.appendChild(sr);
      if(!expanded.has(k))return;
    }
    rows.forEach(h=>{
      const I=bySym[h.sym]||{d:2};
      const tr=document.createElement('tr');
      tr.innerHTML='<td class="tiny faint mono">'+dateStr(h.t)+'</td><td><b>'+h.sym+'</b></td>'+
        '<td><span class="badge '+(h.side==='BUY'?'buy':'sell')+'">'+h.side+'</span></td>'+
        '<td class="num mono">'+fmtMoney(h.amt)+'</td>'+
        '<td class="num mono">'+fmtPx(h.entry,I.d)+'</td>'+
        '<td class="num mono">'+fmtPx(h.exit,I.d)+'</td>'+
        '<td class="num pl-pos '+(h.pl==null?'':(h.pl>=0?'up':'down'))+'">'+fmtMoney(h.pl,true)+'</td>';
      hb.appendChild(tr);
    });
  });
  $('#histEmpty').classList.toggle('hidden',state.history.length>0);
  $('#histWrap').classList.toggle('hidden',state.history.length===0);
  updatePortfolioLive();
}
const plFlash={};
function flashEl(el,dir){
  if(!el)return;
  const c=dir>=0?'flash-up':'flash-down';
  el.classList.remove('flash-up','flash-down');
  void el.offsetWidth;
  el.classList.add(c);
  setTimeout(()=>el.classList.remove(c),700);
}
/* human expiry format: 45s / 74m / 25h 9m / 1d 3h — never a bare "1510m"
   that reads like 15 minutes (the exact misread this fixes) */
function expiresFmt(s){
  if(s<60)return s+'s';
  const m=Math.ceil(s/60);
  if(m<90)return m+'m';
  const h=Math.floor(s/3600), rm=Math.round((s%3600)/60);
  if(h<48)return h+'h '+rm+'m';
  return Math.floor(h/24)+'d '+(h%24)+'h';
}
function paintExpiries(){
  state.positions.forEach((p)=>{
    if(!isBinaryPos(p)||!p.settleAt||p.settled)return;
    const ex=document.querySelector('[data-expin="'+p.id+'"]');
    if(ex){ const s=Math.max(0,Math.round((p.settleAt-Date.now())/1000)); ex.textContent='expires in '+expiresFmt(s); }
  });
}
/* tick every second on its own timer — the countdown must visibly move even
   when the market feed stalls or the painter loop is busy */
setInterval(()=>{ try{ if(state.view==='portfolio')paintExpiries(); }catch(e){} },1000);
function renderMt5BrokerPositions(){
  const card=$('#mt5PositionsCard'); if(!card)return;
  const active=state.broker?.type==='mt5';
  card.style.display=active?'block':'none';
  if(!active)return;
  const meta=$('#mt5PositionsMeta'), body=$('#mt5PositionsBody'), empty=$('#mt5PositionsEmpty'), wrap=$('#mt5PositionsWrap');
  const list=state.mt5LivePositions;
  if(meta){
    if(state.mt5SnapshotFailed)meta.textContent=state.mt5LastSnapshotAt?'Latest refresh failed; showing last confirmed MT5 snapshot.':'MT5 refresh failed; no live position snapshot is available.';
    else if(!Array.isArray(list))meta.textContent='Waiting for the first live MT5 account/positions snapshot.';
    else meta.textContent='Read-only broker snapshot · '+list.length+' open position'+(list.length===1?'':'s')+' · refreshed '+(state.mt5LastSnapshotAt?new Date(state.mt5LastSnapshotAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—');
  }
  if(!body||!empty||!wrap)return;
  body.innerHTML='';
  if(!Array.isArray(list)){
    wrap.classList.add('hidden'); empty.classList.remove('hidden');
    empty.textContent='Live MT5 positions are not available yet. Use Refresh MT5 or reconnect the bridge.';
    return;
  }
  if(!list.length){
    wrap.classList.add('hidden'); empty.classList.remove('hidden');
    empty.textContent='MT5 reports no currently open positions.';
    return;
  }
  empty.classList.add('hidden'); wrap.classList.remove('hidden');
  const currency=state.broker?.account?.currency||'';
  body.innerHTML=list.map(p=>'<tr><td class="mono tiny">'+escHtml(String(p.ticket??'—'))+'</td><td><b>'+escHtml(String(p.symbol||'—'))+'</b></td><td>'+escHtml(String(p.side||'—'))+'</td><td class="num mono">'+fmtPx(p.volume==null?null:Number(p.volume),2)+'</td><td class="num mono">'+fmtPx(p.price==null?null:Number(p.price),5)+'</td><td class="num mono">'+escHtml(fmtAcctMoney(p.profit,currency,true))+'</td><td class="num mono">'+fmtPx(p.sl==null?null:Number(p.sl),5)+'</td><td class="num mono">'+fmtPx(p.tp==null?null:Number(p.tp),5)+'</td></tr>').join('');
}
function updatePortfolioLive(){
  renderMt5BrokerPositions();
  state.positions.forEach(p=>{
    const el=$('[data-pnl="'+p.id+'"]');
    if(el){ const pl=posPl(p); if(pl!=null){ el.textContent=fmtMoney(pl,true); el.className='num pl-pos '+(pl>=0?'up':'down');
      if(plFlash[p.id]!=null&&plFlash[p.id]!==pl)flashEl(el,pl-plFlash[p.id]);
      plFlash[p.id]=pl;
    } else if(isBinaryPos(p)){ el.textContent='·'; el.className='num faint'; } }
    if(isBinaryPos(p)){
      paintExpiries();
      return; /* binaries are never marked to spot */
    }
    const I=bySym[p.sym];
    const cur=$$('#posBody [data-px="'+p.sym+'"]').find(td=>td.closest('tr').querySelector('[data-pnl]').dataset.pnl===p.id);
    if(cur&&I)cur.textContent=fmtPx(I.p,I.d);
  });
  const connected=!!state.broker, isMt5=state.broker?.type==='mt5';
  const acct=state.broker?.account||{}, bal=state.balance;
  const mt5Pos=Array.isArray(state.mt5LivePositions)?state.mt5LivePositions:null;
  const mt5Pl=mt5Pos?mt5Pos.reduce((sum,p)=>sum+(Number.isFinite(Number(p.profit))?Number(p.profit):0),0):null;
  const binSum=state.positions.filter(isBinaryPos).reduce((acc,p)=>acc+((p.liveProfit!=null&&Number.isFinite(Number(p.liveProfit)))?Number(p.liveProfit):0),0);
  const appPl=(openPl()==null&&binSum)?binSum:(openPl()!=null?openPl()+binSum:null);
  const pl=isMt5?mt5Pl:appPl;
  setText('#pfBalance',connected?(isMt5?fmtAcctMoney(bal,acct.currency):fmtMoney(bal)):'Not connected');
  const equity=isMt5?acct.equity:(bal!=null?bal+(pl||0):null);
  setText('#pfEquity',connected?(isMt5?fmtAcctMoney(equity,acct.currency):fmtMoney(equity)):'Not connected');
  setText('#pfEquityDelta',connected?(pl==null?'—':(isMt5?fmtAcctMoney(pl,acct.currency,true):fmtMoney(pl,true))):'—');
  setText('#pfPl',pl==null?'—':(isMt5?fmtAcctMoney(pl,acct.currency,true):fmtMoney(pl,true)));
  $('#pfPl').className='value '+(pl==null?'':(pl>=0?'up':'down'));
  if(pl!=null){ if(plFlash.__kpi!=null&&plFlash.__kpi!==pl)flashEl($('#pfPl'),pl-plFlash.__kpi); plFlash.__kpi=pl; }
  setText('#pfPlCount',isMt5?(mt5Pos?mt5Pos.length+' MT5 position'+(mt5Pos.length===1?'':'s'):'MT5 positions unavailable'):state.positions.length+' app position'+(state.positions.length===1?'':'s'));
  setText('#pfClosed',state.history.length);
  const closed=state.history.filter(h=>h.pl!=null);
  const wins=closed.filter(h=>h.pl>0).length;
  setText('#pfClosedSub',closed.length? (wins/closed.length*100).toFixed(0)+'% win rate':'—');
}
const openPl=()=>{
  const vals=state.positions.map((p)=>{ const v=posPl(p); return (v!=null&&Number.isFinite(v))?v:null; });
  if(vals.some(v=>v==null))return vals.some(v=>v!=null)?vals.reduce((a,v)=>a+(v||0),0):null;
  return vals.reduce((a,v)=>a+v,0);
};
$('#closeAllBtn').onclick=async()=>{
  if(!state.positions.length)return;
  const binLocked=state.positions.filter((p)=>isBinaryPos(p)&&p.canSell===false).length;
  const ok=state.settings.confirmClose
    ? await askConfirm('Close all?',binLocked
        ?('Flatten '+state.positions.length+' position(s)? '+binLocked+' Deriv contract(s) do not allow resale right now — the sell is tried, and any refusal QUEUES a force close that executes the instant Deriv unlocks (settlement books the result otherwise).')
        :'Flatten '+state.positions.length+' open position(s) at market?','Close all')
    : true;
  if(!ok)return;
  state.positions.slice().forEach(p=>closeWithBroker(p,null,null));
  toast('Closing','Sent for '+state.positions.length+' position(s) — locked contracts will report as riding to expiry.','ok');
};
function setText(sel,v){ const el=$(sel); if(el)el.textContent=v; }
function updateKpis(){
  const connected=!!state.broker;
  const isMt5=state.broker?.type==='mt5';
  const acct=state.broker?.account||{};
  const mt5Pos=Array.isArray(state.mt5LivePositions)?state.mt5LivePositions:null;
  const mt5Pl=mt5Pos?mt5Pos.reduce((sum,p)=>sum+(Number.isFinite(Number(p.profit))?Number(p.profit):0),0):null;
  const pl=isMt5?mt5Pl:openPl();
  if(!connected){
    setText('#kpiValue','Not connected');
    setText('#kpiValueDelta','—');
    setText('#kpiValueDeltaLabel','broker equity');
    setText('#kpiPl','—');
    setText('#kpiPlCount',state.positions.length+' app position'+(state.positions.length===1?'':'s'));
    setText('#kpiMargin','Not connected');
    setText('#kpiMarginSub','connect Deriv or Exness');
  }else{
    const bal=state.balance;
    const value=isMt5?fmtAcctMoney(acct.equity,acct.currency):fmtMoney(bal);
    setText('#kpiValue',value);
    setText('#kpiValueDelta',pl==null?'—':(isMt5?fmtAcctMoney(pl,acct.currency,true):fmtMoney(pl,true)));
    setText('#kpiValueDeltaLabel',isMt5?'MT5 floating P&L':'broker equity');
    const vdelta=$('#kpiValueDelta'); if(vdelta)vdelta.className='v '+(pl==null?'':(pl>=0?'up':'down'));
    setText('#kpiPl',pl==null?'—':(isMt5?fmtAcctMoney(pl,acct.currency,true):fmtMoney(pl,true)));
    const ple=$('#kpiPl'); if(ple)ple.className='value '+(pl==null?'':(pl>=0?'up':'down'));
    setText('#kpiPlCount',isMt5?(mt5Pos?mt5Pos.length+' live MT5 position'+(mt5Pos.length===1?'':'s'):'MT5 positions unavailable'):state.positions.length+' app position'+(state.positions.length===1?'':'s'));
    setText('#kpiMargin',isMt5?fmtAcctMoney(acct.margin_free,acct.currency):fmtMoney(bal));
    setText('#kpiMarginSub',isMt5?'MT5 free margin':bal!=null?'broker balance':'—');
  }
  const closed=state.history.filter(h=>h.pl!=null);
  const wins=closed.filter(h=>h.pl>0).length;
  if(closed.length){
    setText('#kpiWin',(wins/closed.length*100).toFixed(0)+'%');
    setText('#kpiWinSub',wins+'W / '+(closed.length-wins)+'L last '+closed.length);
  }else{ setText('#kpiWin','—'); setText('#kpiWinSub','No closed trades yet'); }
}

/* ================================================================
   OVERVIEW
   ================================================================ */
function renderProScalperDashboard(){
  const ov=$('#view-overview'); if(!ov)return;
  let panel=$('#ovProScalper');
  if(!panel){ panel=document.createElement('div'); panel.id='ovProScalper'; panel.className='card'; panel.style.cssText='padding:14px 16px;margin-bottom:14px'; const daily=$('#ovDaily'); if(daily&&daily.parentNode===ov)daily.insertAdjacentElement('afterend',panel); else ov.prepend(panel); }
  const rows=Object.values(state.mktScan||{}).filter(r=>r&&!r.error&&r.pro_scalper?.ok&&r.data_state!=='daily').sort((a,b)=>(Number(b.confidence)||0)-(Number(a.confidence)||0));
  const best=rows[0];
  if(!best){ panel.innerHTML='<div class="row between wrap"><b>Pro Scalper indicators</b><span class="badge gray">Awaiting verified M5 data</span></div><p class="tiny faint" style="margin-top:6px">Indicator values appear when the scanner has enough closed candles. Missing volume and unsupported timeframes remain unavailable.</p>'; return; }
  const p=best.pro_scalper, i=p.indicators||{}, k=i.stochasticRsi, ic=i.ichimoku, kc=i.keltner, vp=i.volumeProfile, a=best.aster;
  const fmt=(v,d=2)=>Number.isFinite(Number(v))?Number(v).toFixed(d):'—';
  const gate=a?.publishable===true?'READY FOR MANUAL REVIEW':a?.status==='NOT_VALIDATED'?'NOT VALIDATED · BLOCKED':'BLOCKED · '+String(a?.status||'missing evidence');
  const volume=p.dataQuality?.volumeAvailable===true;
  const metrics=[
    ['Stochastic RSI',k?fmt(k.k,1)+' / '+fmt(k.d,1):'unavailable'],
    ['CCI',fmt(i.cci,1)],
    ['Williams %R',fmt(i.williamsR,1)],
    ['Supertrend',i.supertrend?i.supertrend.direction+' · '+fmt(i.supertrend.value,4):'unavailable'],
    ['Ichimoku',ic?'Tenkan '+fmt(ic.conversion,4)+' · Kijun '+fmt(ic.base,4)+' · Cloud '+(ic.spanA>ic.spanB?'bullish':'bearish'):'unavailable'],
    ['Keltner',kc?'L '+fmt(kc.lower,4)+' · M '+fmt(kc.mid,4)+' · U '+fmt(kc.upper,4):'unavailable'],
    ['OBV',volume&&Number.isFinite(i.obv)?fmt(i.obv,0):'unavailable · real volume required'],
    ['MFI',volume&&Number.isFinite(i.mfi)?fmt(i.mfi,1):'unavailable · real volume required'],
    ['Anchored VWAP',i.anchoredVwap?fmt(i.anchoredVwap.value,4):'anchor not configured'],
    ['Volume Profile',volume&&vp?'POC '+fmt(vp.poc,4)+' · VA '+fmt(vp.valueAreaLow,4)+'–'+fmt(vp.valueAreaHigh,4):'unavailable · real volume required']
  ];
  panel.innerHTML='<div class="row between wrap"><div><b>Pro Scalper indicators</b><div class="tiny faint">'+escHtml(best.symbol)+' · closed M5 candles · '+escHtml(best.data_source||best.source||'source unavailable')+'</div></div><span class="badge gray">ASTER '+escHtml(gate)+'</span></div>'
    +'<div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;margin-top:10px">'
    +metrics.map(([label,value])=>'<div style="padding:8px 10px;border:1px solid var(--border-soft);border-radius:7px;background:var(--surface-2)"><div class="tiny faint">'+label+'</div><div class="small mono" style="margin-top:3px">'+escHtml(value)+'</div></div>').join('')
    +'</div><p class="tiny faint" style="margin-top:8px">Volume Profile is a bar-close OHLCV approximation, not tick-level volume-at-price. Anchored VWAP requires an explicit market/session anchor. Analysis only; ASTER blocks publication when required evidence is missing, unknown, stale or invalid. No order authorization.</p>';
}
function renderOverview(){
  updateKpis();
  renderProScalperDashboard();
  renderOvDaily(); renderBestPick();
  const posEl=$('#ovPositions');
  if(posEl){
    if(state.broker?.type==='mt5'&&Array.isArray(state.mt5LivePositions)){
      posEl.innerHTML=state.mt5LivePositions.length
        ? '<div class="hint"><b>MT5 reports '+state.mt5LivePositions.length+' open position(s).</b> See Portfolio → Live MT5 positions for the broker snapshot.</div>'
        : '<div class="hint"><b>MT5 reports no open positions.</b> Last confirmed from the connected terminal.</div>';
    }else if(state.broker?.type==='mt5'){
      posEl.innerHTML='<div class="hint">Waiting for a live MT5 positions snapshot. Use Refresh MT5 in Portfolio.</div>';
    }else{
      posEl.innerHTML=state.positions.length
        ? '<div class="hint">'+state.positions.length+' app-recorded position(s). See Portfolio for details.</div>'
        : '<div class="hint"><b>No app-recorded open positions</b> — live Exness positions appear separately when the bridge is connected.</div>';
    }
  }
  const movers=INSTR.filter(I=>chgOf(I)!=null).sort((a,b)=>Math.abs(chgOf(b))-Math.abs(chgOf(a))).slice(0,6);
  const mv=$('#ovMovers'); mv.innerHTML='';
  if(!movers.length){
    mv.innerHTML='<div class="hint">Waiting for the first live ticks from the Deriv feed…</div>';
  }
  movers.forEach(I=>{
    const ch=chgOf(I);
    const d=document.createElement('div');
    d.className='mover';
    d.innerHTML='<div class="sym-avatar">'+I.s.replace(/[^A-Z0-9]/g,'').slice(0,3)+'</div>'+
      '<div><div class="sym-name">'+I.s+'</div><div class="sym-full">'+I.n+'</div></div>'+
      sparkSvg(I)+
      '<div class="right" style="min-width:96px"><div class="mono" style="font-weight:650" data-px="'+I.s+'">'+fmtPx(I.p,I.d)+'</div>'+
      '<div class="mono tiny '+(ch==null?'':(ch>=0?'up':'down'))+'" data-chg="'+I.s+'">'+fmtPct(ch,true)+'</div></div>';
    d.onclick=()=>{ setChartSymbol(I.s); goto('trade'); };
    mv.appendChild(d);
  });
  /* signals */
  const sv=$('#ovSignals'); sv.innerHTML='';
  if(!state.signals.length){
    sv.innerHTML='<div class="hint">No scan results yet — open AI Signals to run a live technical scan.</div>';
  }
  state.signals.slice(0,3).forEach(sig=>{
    const I=bySym[sig.symbol]||{d:4},approved=isAsterPublishable(sig),directional=isDirectionalCandidate(sig);
    const d=document.createElement('div');
    d.className='mini-signal';
    d.innerHTML='<div class="top"><b>'+escHtml(sig.symbol)+'</b><span class="badge '+(approved?(sig.signal==='BUY'?'buy':sig.signal==='SELL'?'sell':'neutral'):'gray')+'">'+(directional&&!approved?'ASTER BLOCKED':escHtml(sig.signal||'WAIT'))+(approved?' · '+liveScoreHtml(sig,'span'):'')+'</span></div>'+
      '<div class="meta">'+(approved?'entry '+fmtPx(sig.entry,I.d)+' · SL '+fmtPx(sig.stop_loss,I.d)+' · TP '+fmtPx(sig.tp1,I.d)+' · ASTER approved':'Technical candidate withheld · required ASTER evidence not approved')+'</div>';
    d.onclick=()=>goto('signals');
    sv.appendChild(d);
  });
}

/* ================================================================
   AUTOMATION (Deriv + Exness bridge only)
   ================================================================ */
const DEFAULT_BOTS=[
 {name:'Digit Over 6 — Pair',desc:'Rises-falls style digit strategy with a fixed stake and a hard stop-loss after 3 losses.',risk:'MEDIUM',type:'over/under',armed:false},
 {name:'Even/Odd Momentum',desc:'Follows even/odd streaks on Volatility indexes with capped recovery.',risk:'MEDIUM',type:'even/odd',armed:false},
 {name:'Crash 1000 Spike Catcher',desc:'Buys into Crash 1000 pullbacks using RSI divergence on M1 candles.',risk:'LOW',type:'trend',armed:false},
 {name:'V75 Martingale Ladder',desc:'Classic doubling recovery on Volatility 75. High risk — can drain a balance fast.',risk:'HIGH',type:'recovery',armed:false}
];
if(!state.bots)state.bots=DEFAULT_BOTS.map(b=>Object.assign({},b));
function renderBots(){
  const g=$('#botGrid'); g.innerHTML='';
  state.bots.forEach((b,idx)=>{
    const badge=b.risk==='HIGH'?'sell':b.risk==='MEDIUM'?'wait':'buy';
    const el=document.createElement('div');
    el.className='bot-card';
    el.innerHTML='<div class="row between" style="margin-bottom:6px"><h4>'+b.name+'</h4><span class="badge '+badge+'">'+b.risk+'</span></div>'+
      '<div class="d">'+b.desc+'</div>'+
      '<div class="row between"><span class="tiny faint mono">'+b.type+'</span>'+
      '<button class="btn sm '+(b.armed?'':'primary')+' bot-arm">'+(b.armed?'Disarm':'Arm')+'</button></div>';
    el.querySelector('.bot-arm').onclick=async()=>{
      if(!b.armed&&!state.broker){
        toast('Broker required','Connect Deriv or Exness before arming a bot — no simulated execution.','err');
        return;
      }
      if(!b.armed&&b.risk==='HIGH'){
        const ok=await askConfirm('High-risk bot','This bot uses recovery-style stake increases. Arm anyway?','Arm');
        if(!ok)return;
      }
      b.armed=!b.armed; save(); renderBots();
      toast(b.armed?'Bot armed':'Bot disarmed',b.name+(b.armed?' armed on the connected broker.':' stopped.'),b.armed?'ok':'');
    };
    g.appendChild(el);
  });
}
function connUI(){
  const derivOn=state.broker?.type==='deriv';
  const mt5On=state.broker?.type==='mt5';
  [['deriv','#derivStatus',derivOn],['mt5','#mt5Status',mt5On]].forEach(([k,sel,on])=>{
    const el=$(sel); if(!el)return;
    el.classList.toggle('on',on);
    let label=on?'Connected · live session':'Not connected';
    if(k==='mt5'&&bridge.bridgeStatus().status==='connecting')label='Bridge connecting…';
    if(k==='mt5'&&bridge.bridgeStatus().status==='error')label='Bridge error — is it running?';
    el.innerHTML='<span class="dot '+(on?'live':'off')+'"></span> '+label;
    const btn=$('.conn-btn[data-conn="'+k+'"]');
    if(btn)btn.textContent=on?'Disconnect':'Connect '+({deriv:'Deriv',mt5:'bridge'}[k]);
  });
}
$$('.conn-btn').forEach(btn=>btn.onclick=async()=>{
  const k=btn.dataset.conn;
  if(k==='live')return;
  if(state.broker&&((k==='deriv'&&state.broker.type==='deriv')||(k==='mt5'&&state.broker.type==='mt5'))){
    if(k==='mt5')bridge.disconnectBridge('user');
    state.broker=null; state.balance=null; state.mode='live';
    state.connections[k==='deriv'?'deriv':'mt5']=false; save();
    store.set('session',{name:state.user||'Live',mode:'live'});
    if(k==='deriv'){patStore.forget();}
    if(k==='mt5'){clearMt5Session();forgetMt5Identity();['exnessLogin','mt5Login','exnessServer','mt5Server','exnessPass','mt5Pass','mt5Token'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});}
    connUI(); updateSessionInfo(); updateTradeHeader(); updateKpis();
    toast('Disconnected',(k==='deriv'?'Deriv':'Exness bridge')+' session closed.');
    return;
  }
  btn.disabled=true; const old=btn.textContent; btn.textContent='Connecting…';
  try{
    if(k==='deriv'){
      let pat=$('#derivToken').value.trim(), appId=$('#derivApp').value.trim();
      if(!pat)throw new Error('Paste your PAT in the API token field, and your App ID (copied EXACTLY — may contain letters) in the Deriv-App-ID field.');
      /* PAT flow per Deriv: Authorization Bearer + Deriv-App-ID, verified and
         held SERVER-SIDE — never in browser code, never on the classic WS. */
      const sess=await patConnect(appId,pat);
      patStore.set(pat);
      state.broker={type:'deriv',mode:'pat_server',sid:sess.sid,accountId:sess.primary.account_id,appId,account:sess.primary,accounts:sess.accounts,limits:sess.limits,environment:sess.environment};
      state.balance=sess.primary.balance!=null?Number(sess.primary.balance):null;
      patStore.setAppId(appId);
      state.connections.deriv=true; save();
      renderPatAccounts();
      sessLog.add('connected','Deriv connected ('+(sess.environment||'')+')');
      toast('Deriv connected (PAT)','Secure server session · '+sess.environment.toUpperCase()+' · account '+sess.primary.account_id+' · balance '+(sess.primary.balance??'—')+'.','ok');
      notify('Deriv connected','PAT verified server-side (Bearer + Deriv-App-ID) · trading enabled on account '+sess.primary.account_id+'.',{tag:'connect',kind:'ok'});
    }else{
      const url=($('#mt5Url').value||'').trim()||bridge.localBridgeWs();
      const login=$('#mt5Login').value.trim(), password=$('#mt5Pass').value;
      const server=(($('#mt5Server')||{}).value||'').trim();
      saveMt5Identity(login,server);
      if(!login||!password)throw new Error('Enter your Exness account number and MT5 password.');
      if(!server)throw new Error('Enter the exact Exness MT5 server shown in the Exness Personal Area.');
      const bridgeToken=($('#mt5Token')&&$('#mt5Token').value.trim())||'';
      await connectMt5(url,login,password,server,bridgeToken);
      toast('Exness connected read-only','Local MT5 balance/positions linked · orders remain disabled in this verification build.','ok');
      notify('Exness connected read-only','Local MT5 data linked; order sending is disabled in this build.',{tag:'connect',kind:'ok'});
    }
    connUI(); updateSessionInfo(); updateTradeHeader(); updateKpis();
  }catch(e){
    toast('Connection failed',String(e.message||e),'err');
    connUI();
  }finally{ btn.disabled=false; btn.textContent=old; }
});
$('#importBotBtn').onclick=()=>$('#botFile').click();
$('#botFile').onchange=e=>{
  const f=e.target.files&&e.target.files[0]; if(!f)return;
  const r=new FileReader();
  r.onload=()=>{
    const txt=String(r.result||'');
    const risky=/martingale|recovery|double\s*stake|increase\s*(the\s*)?stake|alembert/i.test(txt);
    const nameMatch=txt.match(/<name>([^<]{3,60})<\/name>/i);
    const name=nameMatch?nameMatch[1].trim():f.name.replace(/\.[^.]+$/,'');
    state.bots.unshift({name,desc:'Imported from '+f.name+'. '+(risky?'⚠ Recovery-style stake progression detected.':'No aggressive recovery pattern detected.'),risk:risky?'HIGH':'LOW',type:risky?'recovery':'imported',armed:false});
    save(); renderBots();
    toast('Bot imported',name+' scanned and added.','ok');
  };
  r.readAsText(f);
  e.target.value='';
};

/* ================================================================
   SETTINGS (theme, defaults, AI keys, notifications, data)
   ================================================================ */
$$('#themePick .theme-card').forEach(b=>b.onclick=()=>{
  state.settings.theme=b.dataset.themePick; save(); applyTheme(); tv.refreshChartTheme();
});
$('#compactChk').onchange=e=>{
  state.settings.compact=e.target.checked;
  document.body.classList.toggle('compact',state.settings.compact);
  save();
};
$('#defAmt').onchange=e=>{
  const v=parseFloat(e.target.value); if(v>=1){ state.settings.defAmt=v; $('#orderAmount').value=v; save(); }
};
$('#riskRange').oninput=e=>{
  state.settings.maxRisk=parseFloat(e.target.value);
  $('#riskVal').textContent=state.settings.maxRisk.toFixed(1)+'%';
  save(); updateRisk();
};
$('#confirmChk').onchange=e=>{ state.settings.confirmClose=e.target.checked; save(); };

/* ---------- Auto-trade (sniper) bindings ---------- */
const atResaleChk=$('#atResale');
if(atResaleChk&&!atResaleChk.__wired){
  atResaleChk.__wired=true;
  atResaleChk.checked=!!atCfg().prefResale;
  atResaleChk.addEventListener('change',()=>{
    const c=atCfg(); c.prefResale=atResaleChk.checked; save();
    toast('Prefer early-exit markets',atResaleChk.checked
      ?'The sniper now hunts ONLY early-exit-friendly markets (synthetics — where Deriv usually allows resale, so Close genuinely stops the trade).'
      :'Back to the normal universe — all families hunted as before.','ok');
    if(atTimer)autoTradeCycle();
  });
}
$('#atBrakes').onchange=e=>{
  const c=atCfg(); c.brakes=e.target.value; save();
  toast(c.brakes==='run'?'Runs until you stop it':'Stops at targets & guards',
    c.brakes==='run'?'The sniper keeps hunting (and notifying) through targets and guards. The server-side stake, open-trade and daily-loss caps are the hard backstop.':'Classic behavior: the sniper disarms itself at the session profit target, loss guard, or after repeated losses.','ok');
};
/* mobile quick-order bar */
const mobOrderBtn=$('#mobOrderBtn');
if(mobOrderBtn&&!mobOrderBtn.__wired){ mobOrderBtn.__wired=true; mobOrderBtn.onclick=()=>{ const t=$('#ticketCard'); if(t){ t.scrollIntoView({behavior:'smooth',block:'start'}); } else { goto('trade'); setTimeout(()=>{ const t2=$('#ticketCard'); if(t2)t2.scrollIntoView({behavior:'smooth'}); },350); } }; }
const mobPortfolioBtn=$('#mobPortfolioBtn');
if(mobPortfolioBtn&&!mobPortfolioBtn.__wired){ mobPortfolioBtn.__wired=true; mobPortfolioBtn.onclick=()=>goto('portfolio'); }
const newsFeedBtn=$('#newsFeedBtn'); if(newsFeedBtn&&!newsFeedBtn.__wired){ newsFeedBtn.__wired=true; newsFeedBtn.onclick=()=>renderNewsFeed(); }
const newsCalBtn=$('#newsCalBtn'); if(newsCalBtn&&!newsCalBtn.__wired){ newsCalBtn.__wired=true; newsCalBtn.onclick=()=>renderNewsCal(); }
const newsCalShare=$('#newsCalShare'); if(newsCalShare&&!newsCalShare.__wired){ newsCalShare.__wired=true; newsCalShare.onclick=()=>shareCalBrief(); }
const waInput=$('#waNumber');
if(waInput&&!waInput.__wired){ waInput.__wired=true;
  waInput.value=waDigits();
  waInput.addEventListener('input',()=>{ state.settings.wa=waInput.value.replace(/[^0-9+]/g,'').slice(0,16); save(); });
}
const waAutoChk=$('#waAuto');
if(waAutoChk&&!waAutoChk.__wired){ waAutoChk.__wired=true;
  waAutoChk.checked=state.settings.waAuto!==false;
  waAutoChk.addEventListener('change',()=>{ state.settings.waAuto=waAutoChk.checked; save(); toast('WhatsApp auto-send',waAutoChk.checked?'Signals, briefs and trade results will push automatically while the app is open (and always, once the server Cloud API is configured).':'Automatic sending is OFF — you are back to one-tap shares.','ok'); });
  waServerStatus().then((st)=>{
    const el=document.getElementById('waAutoStatus'); if(!el)return;
    el.textContent=st.configured?('Server Cloud API: CONNECTED · auto feed '+(st.auto?'ON':'OFF')+' · to '+st.to_masked):'Server auto-push: not configured — add WA_PHONE_NUMBER_ID, WA_TOKEN, WA_TO (+ WA_AUTO_SHARE=true) on Railway to share even when the app is closed. One-tap WA buttons always work.';
  });
}
$$('#atExitRow .chip').forEach(b=>b.onclick=()=>{
  const c=atCfg(); c.durMode=b.dataset.exit; save();
  $$('#atExitRow .chip').forEach(x=>x.classList.toggle('active',x.dataset.exit===c.durMode));
  toast(c.durMode==='target'?'Target exit armed':'Fast expiry armed',c.durMode==='target'
    ?'Sniper buys 1h forex / 15m synthetic contracts — resale typically unlocks mid-life, so it closes automatically at your target.'
    :'Sniper buys the shortest contracts (15m forex / 5m synthetics). Deriv locks these — they run to expiry; targets alert only.','ok');
  if(atTimer)autoTradeCycle();
});
$('#atConc').onchange=e=>{
  const c=atCfg(); let v=parseInt(e.target.value,10); if(!Number.isFinite(v))v=1;
  c.maxConc=Math.max(1,Math.min(3,v)); save(); e.target.value=c.maxConc;
  toast('Sniper positions set','Up to '+c.maxConc+' concurrent sniper position(s), each on a different symbol. The server-side open-trades cap remains the hard backstop.','ok');
};
$('#atTargetPct').onchange=e=>{
  const c=atCfg(); let v=parseFloat(e.target.value);
  if(!Number.isFinite(v))v=50; v=Math.min(90,Math.max(20,v));
  c.targetPct=v; save(); e.target.value=v;
  toast('Auto target set','Sniper positions will aim for +'+v+'% of stake live profit (close when resale allows, alert when locked).','ok');
};
$$('#atModeRow .chip').forEach(b=>b.onclick=()=>{
  const c=atCfg(); c.mode=b.dataset.mode;
  if(b.dataset.mode==='active'&&c.conf>62){ c.conf=60; }
  if(b.dataset.mode==='careful'&&c.conf<68){ c.conf=70; }
  save();
  $('#atConf').value=c.conf; $('#atConfVal').textContent=c.conf+'%';
  $$('#atModeRow .chip').forEach(x=>x.classList.toggle('active',(x.dataset.mode||'active')===(c.mode||'active')));
  $$('#atExitRow .chip').forEach(x=>x.classList.toggle('active',(x.dataset.exit||'fast')===(c.durMode||'fast')));
  const tp=$('#atTargetPct'); if(tp)tp.value=c.targetPct??50;
  renderAtRecord();
  $$('#atModeRow .chip').forEach(x=>x.classList.toggle('active',x.dataset.mode===c.mode));
  if(atTimer){ atStatusUI('scan','🔍 hunting ('+(c.mode==='careful'?'careful':'active')+')','mode applied — the very next cycle uses it'); autoTradeCycle(); }
});
$('#atConf').oninput=e=>{
  state.settings.autotrade.conf=Number(e.target.value);
  $('#atConfVal').textContent=state.settings.autotrade.conf+'%';
  save(); if(atTimer)atStatusUI('armed','armed · hunting every 30s · ≥ '+state.settings.autotrade.conf+'% confidence','buy');
};
$('#atStake').onchange=e=>{
  const v=parseFloat(e.target.value); if(v>=1){ state.settings.autotrade.stake=v; save(); }
};
$('#atTarget').onchange=e=>{
  const v=parseFloat(e.target.value); if(v>=1){ state.settings.autotrade.target=v; save(); }
};
$('#atMax').onchange=e=>{
  const v=Number(e.target.value); if(v>=1){ state.settings.autotrade.maxTrades=Math.min(50,v); save(); }
};
$('#atDir').onchange=e=>{ state.settings.autotrade.dir=e.target.value; save(); };
$('#atChk').onchange=e=>{
  if(e.target.checked) enableAutoTrade(); else disableAutoTrade('off','auto-trade off — you turned it off.');
};

/* AI key vault */
function loadKeysUI(){
  renderSessLog();
  const fw=$('#forgetDeviceBtn');
  if(fw&&!fw.__wired){ fw.__wired=true; fw.onclick=()=>{ patStore.forget(); clearMt5IdentityFields(); store.del('session'); ['derivAppId','derivPat','derivApp','derivToken'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';}); sessLog.add('signed','Saved broker details cleared from this tab'); toast('Broker details cleared','Session-only broker credentials and saved Exness identity were removed from this browser tab. The current connection remains until disconnected.'); }; }
  const k=getKeys();
  const c=$('#aiClaudeKey'), o=$('#aiOpenaiKey'), p=$('#aiPerpKey');
  if(c)c.value=k.claude;
  if(o)o.value=k.openai;
  if(p)p.value=k.perplexity;
  const st=$('#aiKeyStatus');
  if(st){
    const n=[k.claude,k.openai,k.perplexity].filter(Boolean).length;
    st.textContent=n?(n+' key'+(n>1?'s':'')+' set'):'no keys';
    st.className='badge '+(n?'buy':'gray');
  }
}
$('#aiKeysSave').onclick=()=>{
  setKeys({claude:$('#aiClaudeKey').value,openai:$('#aiOpenaiKey').value,perplexity:$('#aiPerpKey').value});
  loadKeysUI(); azFetchBudget();
  toast('Keys saved',hasAnyKey()?'AI engines will be used on the next analysis.':'No keys stored — technical mode only.','ok');
};
$('#aiKeysClear').onclick=()=>{ clearKeys(); loadKeysUI(); toast('Keys cleared','All AI keys removed from this browser.'); };
function refreshNotifBtn(){
  const b=$('#notifBtn'); if(!b)return;
  const s=notifState();
  b.textContent={granted:'Enabled ✓',denied:'Blocked by browser',unsupported:'Unsupported',default:'Enable'}[s]||'Enable';
  b.disabled=(s==='granted'||s==='unsupported');
}
$('#notifBtn').onclick=async()=>{
  const s=await enableNotifications();
  refreshNotifBtn();
  if(s==='granted')notify('Notifications on','You will get news, trade and SL/TP alerts.',{tag:'notif',kind:'ok'});
  else if(s==='denied')toast('Blocked','Notifications are blocked in browser settings for this site.','err');
  else toast('Unsupported','This browser does not support notifications.');
};
$('#exportBtn').onclick=()=>{
  const data={exported:new Date().toISOString(),user:state.user,mode:state.mode,
    positions:state.positions,history:state.history,settings:state.settings};
  try{
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download='aurum-journal.json';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Export ready','aurum-journal.json downloaded.','ok');
  }catch(e){ toast('Export blocked','Downloads are blocked in this preview context.','err'); }
};
$('#resetBtn').onclick=async()=>{
  const ok=await askConfirm('Reset workspace data?','This clears local positions, history and bots. Broker accounts are not affected.','Reset');
  if(!ok)return;
  state.positions=[]; state.history=[]; state.bots=DEFAULT_BOTS.map(b=>Object.assign({},b));
  try{ store.set('history',[]); }catch(e){}
  save(); renderNavCounts(); renderPortfolio(); renderBots(); updateKpis();
  toast('Workspace data cleared','Local journal reset.');
};

/* ================================================================
   SIGNAL ANALYZER UI (Express API; real candles; honest fallbacks)
   ================================================================ */
let lastAz = null;

function azPopulateSymbols() {
  const sel = $('#azSymbol');
  if (!sel) return;
  sel.innerHTML = INSTR.map(I => '<option value="' + I.s + '">' + I.s + ' — ' + I.n + '</option>').join('');
  sel.value = state.chart.sym in bySym ? state.chart.sym : 'EUR/USD';
}

function azFetchBudget() {
  const pill = $('#azBudget');
  if (typeof fetch !== 'function') return; // jsdom / very old browsers
  api('/api/signals/usage', { headers: { 'x-aurum-user': state.user || 'local' } })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(u => {
      if(pill){ pill.classList.remove('hidden'); pill.textContent = 'AI today $' + Number(u.cost||0).toFixed(2) + ' / $' + Number(u.cap||0).toFixed(2); }
      const t=$('#aiBudgetTxt');
      if(t)t.textContent='Spent today: $'+Number(u.cost||0).toFixed(2)+' / $'+Number(u.cap||0).toFixed(2);
    })
    .catch(() => { if(pill)pill.classList.add('hidden'); });
}

async function azAnalyze() {
  const sym = $('#azSymbol').value;
  const btn = $('#azRun');
  btn.disabled = true;
  $('#azEmpty').classList.add('hidden');
  $('#azResult').classList.add('hidden');
  $('#azLoading').classList.remove('hidden');
  $('#azLoadingTxt').textContent = 'Fetching live 1m / 5m / 1h candles for ' + sym + '…';

  try {
    let data,meta;
    try{
      const bundle=await exnessSignalFor(bySym[sym],true);
      if(await isCloudflareHostedApp()){
        /* Cloudflare staging is public-facing. Keep Exness candles entirely in
           this browser: never POST local MT5 history to the hosted Worker. */
        /* The same finished candles the scanner reading was made from, so the same reading results. (bundle.candle_sets
           are the candles as MT5 returned them: the PC's server, which is sent them in the other branch, refuses a
           1-minute series whose newest candle is more than three minutes old.) */
        const closedSets=closedCandleSets(bundle.candle_sets).sets,det=runDeterministicAnalysis(sym,closedSets),decision=localDecision(det);
        const wr=decision.signal==='WAIT'?waitReason(det,{maxAgeSec:3*3600+300}):null;
        data=Object.assign({},decision,{
          symbol:sym,price:det.analyses.m1&&det.analyses.m1.currentPrice,
          mtf_signal:det.mtfSignal,votes:votesSummary(det.analyses),
          data_ok:det.ok,data_source:'Exness MT5 local candles · analyzed in this browser',
          latest_candle_time:bundle.latest_candle_time,candle_close:bundle.candle_close,
          sentiment_score:50,sentiment_source:'derived',news:{available:false,reason:'exness_local_only'},
          wait_reason:wr&&wr.code||null,wait_detail:wr&&wr.detail||null
        });
        meta={mode:'technical',reason:'exness_local_only_cloudflare',engines:[],spent:0,cap:0};
      }else{
        try{
          const res=await api('/api/signals/analyze',{
            method:'POST',headers:Object.assign({'x-aurum-user':state.user||'local'},keyHeaders()),
            body:{symbol:sym,force:true,withNews:hasAnyKey(),candleSets:bundle.candle_sets,dataSource:'Exness MT5 local candles'}
          });
          if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.detail||e.error||('API '+res.status));}
          data=await res.json();
          {const held=withheldReading(data);if(held)throw new Error(held.detail);} /* never shown: the Exness reading above is the current one */
        }catch(apiError){data=Object.assign({},bundle,{candle_sets:undefined,ai_note:'AI service unavailable; displaying Exness technical analysis.'});meta={mode:'technical',reason:'exness_local_fallback',engines:[]};}
      }
    }catch(exnessError){
      const fallback=(await scanSignalsPreferred([sym]))[0];
      if(!fallback||fallback.error){const failure=new Error((fallback&&fallback.detail)||String(exnessError&&exnessError.message||exnessError));failure.signalState=signalState(fallback);throw failure;}
      /* A reading analysed in this browser already is the full technical decision; only a server or cloud reading is completed by the API. */
      if(String(fallback.data_source||'').startsWith('Deriv public candles')&&fallback.computed!=='browser'){
        try{
          const res=await api('/api/signals/analyze',{method:'POST',headers:Object.assign({'x-aurum-user':state.user||'local'},keyHeaders()),body:{symbol:sym,force:true,withNews:hasAnyKey()}});
          const j=await res.json();if(!res.ok)throw new Error(j.detail||j.error||'analysis fallback unavailable');
          {const held=withheldReading(j);if(held)throw new Error(held.detail);} /* never shown: the scan reading above is the current one */
          data=Object.assign({},j,{data_source:fallback.data_source,fallback:true,fallback_reason:fallback.fallback_reason});
        }catch(_fallbackAnalysisError){data=fallback;meta={mode:'technical',reason:'labelled_source_fallback',engines:[]};}
      }else{data=fallback;meta={mode:'technical',reason:'labelled_source_fallback',engines:[]};}
    }
    if(data.candle_sets)delete data.candle_sets;
    meta=meta||data.meta||{mode:data.model==='technical-exness'?'technical':'technical',reason:'unknown',engines:[]};
    if(!data.data_source)data.data_source=data.source||'source unavailable';
    $('#azLoading').classList.add('hidden');
    renderAz(data,meta);
    emitSignalAlerts([data]);
    notify('Analysis ready',sym+' — '+data.signal+' '+data.confidence+'% · source: '+data.data_source,{tag:'az',kind:'ok'});
    if(cloudConfig()){
      saveAnalysis('mtf_scan',sym,'MTF',{signal:data.signal,confidence:data.confidence,mtf_signal:data.mtf_signal,data_ok:data.data_ok,data_source:data.data_source});
      saveSignal(Object.assign({},data,{engine:(data.meta&&(data.meta.engines||[])[0])||data.model||(data.meta&&data.meta.mode)||'technical'}));
    }
  } catch (e) {
    /* honest failure: no local simulated fallback */
    $('#azLoading').classList.add('hidden');
    $('#azEmpty').classList.remove('hidden');
    const msg=String(e.message||e);
    $('#azEmpty').innerHTML='<b>Analysis unavailable</b>'+(isCloudflareReadonlyMode()?cloudAnalysisDownHtml(e):(msg==='fetch unavailable'?'The API server is not running (<code>npm run api</code>). Live-candle analysis needs the local server.':escHtml(msg)));
    toast('Analysis failed',msg,'err');
  } finally {
    btn.disabled = false;
  }
}

function azModeLabel(meta) {
  if (meta.mode === 'ai') return meta.engines && meta.engines.length ? 'AI · ' + meta.engines.join('+').toUpperCase() : 'AI';
  const reasons = {
    no_keys: 'TECHNICAL · NO KEYS',
    no_key: 'TECHNICAL · NO KEYS',
    budget_exceeded: 'TECHNICAL · BUDGET CAP',
    engine_error: 'TECHNICAL · AI ERROR',
    server_unreachable: 'API OFFLINE',
    cached: 'CACHED'
  };
  return reasons[meta.reason] || 'TECHNICAL';
}

function renderAz(p, meta) {
  lastAz = p;
  const approved=isAsterPublishable(p),directional=isDirectionalCandidate(p);
  const cls = { BUY: 'buy', SELL: 'sell', WAIT: 'neutral' };
  const dec = (bySym[p.symbol] && bySym[p.symbol].d) || 4;

  const badge = $('#azBadge');
  badge.className = 'badge ' + (approved?(cls[p.signal] || 'neutral'):'gray');
  badge.textContent = directional&&!approved?'ASTER BLOCKED':p.signal;
  const sig = $('#azSignal');
  sig.textContent = directional&&!approved?'WITHHELD':p.signal;
  sig.className = approved&&p.signal === 'BUY' ? 'up' : approved&&p.signal === 'SELL' ? 'down' : 'faint';

  const mode = $('#azMode');
  mode.className = 'badge ' + (meta.mode === 'ai' ? 'gold' : 'gray');
  mode.textContent = azModeLabel(meta);
  $('#azMtf').textContent = approved?'Analysis timeframe: M1 / M5 / H1 confluence · MTF: ' + String(p.mtf_signal || '—').replace(/_/g, ' ').toLowerCase() + ' · source: ' + String(p.data_source||p.source||'unavailable'):'ASTER publication blocked · MTF direction withheld · source: '+String(p.data_source||p.source||'unavailable');
  $('#azSignalTiming').textContent = 'Suggested review: after the next 5-minute candle closes (about 5 min); re-check sooner if price, spread or market status changes. Guidance only — no fixed signal expiry or holding-time guarantee.';

  $('#azConf').textContent = approved?p.confidence:'—';
  $('#azConfTxt').textContent = approved?p.confidence + '%':'WITHHELD';
  $('#azConfBar').style.width = approved?p.confidence + '%':'0%';

  $('#azEntry').textContent = approved?fmtPx(p.entry, dec):'—';
  $('#azSl').textContent = approved?fmtPx(p.stop_loss, dec):'—';
  $('#azTp1').textContent = approved?fmtPx(p.tp1, dec):'—';
  $('#azTp2').textContent = approved?fmtPx(p.tp2, dec):'—';
  $('#azRrr').textContent = approved?(p.rrr != null ? Number(p.rrr).toFixed(2) : '—') + ' : 1':'—';

  const sent = $('#azSentiment');
  sent.className = 'badge neutral';
  sent.textContent = (p.sentiment_score != null ? p.sentiment_score : 50) + ' / 100';
  const sentHint=sent.nextElementSibling;
  if(sentHint&&sentHint.classList.contains('tiny'))sentHint.textContent=p.sentiment_source?('source: '+p.sentiment_source):'derived from live candles';

  $('#azRationale').textContent = approved?(p.rationale || '—'):'Technical rationale withheld until ASTER approves publication.';
  $('#azTech').textContent = approved?(p.technical_summary || '—'):'Technical summary withheld until ASTER approves publication.';
  $('#azWatch').textContent = approved?(p.next_watch || '—'):'No directional watch item is published while ASTER is blocked.';

  /* WAIT transparency: reason code + human reason + per-timeframe votes + auto-trade gate */
  const azWhy = $('#azWhy');
  if (azWhy) {
    if(directional&&!approved){
      const reasons=Array.isArray(p.aster?.rejectionReasons)?p.aster.rejectionReasons.join('; '):'Complete ASTER evidence is missing or has not been validated.';
      azWhy.innerHTML='<div class="az-why"><b>Signal withheld by ASTER:</b> '+escHtml(reasons)+'</div><div class="az-why tiny faint">Technical direction and levels are not published because mandatory checks have not passed.</div>';
      azWhy.classList.remove('hidden');
    } else if (p.signal === 'WAIT') {
      const atConf = ((typeof atCfg === 'function' && atCfg()) ? (atCfg().conf ?? 70) : 70);
      azWhy.innerHTML = '<div class="az-why"><b>Why WAIT:</b> ' + escHtml(p.wait_detail || 'Timeframes did not confirm 2-of-3.') +
        '</div><div class="az-why tiny faint">reason: ' + escHtml(p.wait_reason || 'MTF_NO_ALIGNMENT') +
        ' · votes: ' + escHtml(p.votes || 'n/a') +
        ' · auto-trade only enters on confirmed signals with confidence ≥ ' + atConf + '% (this one: ' + p.confidence + '%)</div>';
      azWhy.classList.remove('hidden');
    } else {
      azWhy.classList.add('hidden');
      const atConf = ((typeof atCfg === 'function' && atCfg()) ? (atCfg().conf ?? 70) : 70);
      azWhy.innerHTML = '<div class="az-why tiny faint">votes: ' + escHtml(p.votes || 'n/a') +
        ' · auto-trade enters when confidence ≥ ' + atConf + '% (this one: ' + p.confidence + '%)</div>';
    }
  }

  const lvlRow = (v, side) =>
    '<div class="az-level-row"><span class="mono">' + fmtPx(v, dec) + '</span><span class="tiny faint">' + side + '</span></div>';
  const levels = p.key_levels || { support: [], resistance: [] };
  $('#azSupport').innerHTML = approved?((levels.support || []).map(v => lvlRow(v, 'support')).join('') || '<div class="tiny faint">—</div>'):'<div class="tiny faint">Withheld by ASTER</div>';
  $('#azResistance').innerHTML = approved?((levels.resistance || []).map(v => lvlRow(v, 'resistance')).join('') || '<div class="tiny faint">—</div>'):'<div class="tiny faint">Withheld by ASTER</div>';

  $('#azRisks').innerHTML = (p.risks || []).map(r => '<li>' + escHtml(r) + '</li>').join('') || '<li>No major risks identified</li>';
  $('#azUse').disabled = !approved || !directional;
  $('#azUse').title = approved?'Load this ASTER-approved setup':'Blocked until ASTER approves publication';

  $('#azResult').classList.remove('hidden');
  azAddHistory(p, meta);
  loadPipelineFlow(); /* six-role workflow presentation (spec §5 BOSS) */
  if (meta.spent != null && meta.cap != null) {
    const pill = $('#azBudget');
    if(pill){ pill.classList.remove('hidden'); pill.textContent = 'AI today $' + Number(meta.spent).toFixed(2) + ' / $' + Number(meta.cap).toFixed(2); }
  }
}

function azAddHistory(p, meta) {
  const body = $('#azHistBody');
  const cls = { BUY: 'buy', SELL: 'sell', WAIT: 'neutral' };
  const dec = (bySym[p.symbol] && bySym[p.symbol].d) || 4;
  const modelTag = meta.mode === 'ai' ? (meta.engines||['ai']).join('+') : 'technical';
  const visibleSignal=isAsterPublishable(p)?p.signal:(isDirectionalCandidate(p)?'WITHHELD':p.signal);
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td class="tiny faint mono">' + timeStr(Date.now()) + '</td>' +
    '<td><b>' + p.symbol + '</b></td>' +
    '<td><span class="badge ' + (isAsterPublishable(p)?(cls[p.signal] || 'neutral'):'gray') + '">' + visibleSignal + '</span></td>' +
    '<td class="num mono">' + (isAsterPublishable(p)?p.confidence+'%':'—') + '</td>' +
    '<td class="num mono">' + (isAsterPublishable(p)?fmtPx(p.entry, dec):'—') + '</td>' +
    '<td><span class="badge ' + (meta.mode === 'ai' ? 'gold' : 'gray') + '">' + modelTag + '</span></td>';
  body.insertBefore(tr, body.firstChild);
  while (body.children.length > 10) body.removeChild(body.lastChild);
  $('#azHistEmpty').classList.add('hidden');
}

function azUseSetup() {
  if (!lastAz) return;
  const p = lastAz;
  if(!isAsterPublishable(p)||!isDirectionalCandidate(p)){toast('ASTER blocked','This technical candidate has not passed the complete publication gate.','warn');return;}
  const dec = (bySym[p.symbol] && bySym[p.symbol].d) || 4;
  $('#orderSL').value = Number(p.stop_loss).toFixed(dec);
  $('#orderTP').value = Number(p.tp1).toFixed(dec);
  const tp2=$('#orderTP2'); if(tp2)tp2.value = p.tp2!=null?Number(p.tp2).toFixed(dec):'';
  levelsForSym='__manual__'; /* AI-signal levels win — don't let the ticket autofill race stomp them */
  if (p.signal === 'BUY' || p.signal === 'SELL') { state.side = p.signal; syncSide(); }
  setChartSymbol(bySym[p.symbol] ? p.symbol : state.chart.sym, true);
  goto('trade');
  toast('Setup loaded', p.symbol + ' ' + p.signal + ' — SL / TP1 / TP2 applied to the ticket.', 'ok');
}

/* ================================================================
   RENDER DISPATCH + BOOT
   ================================================================ */
/* ================= Calculator Lab (risk education, non-transactional) =================
   All results are hypothetical arithmetic on user assumptions or labelled real
   history from the server-validated /api/history/candles endpoint. Nothing here
   orders, predicts, or advises. */
const GRAN_LABELS={60:'1m',180:'3m',300:'5m',900:'15m',1800:'30m',3600:'1h',14400:'4h',86400:'1D'};
let learnWired=false;
function learnInit(){
  const sel=$('#ddSym');
  if(sel&&!sel.options.length) INSTR.forEach(I=>sel.insertAdjacentHTML('beforeend','<option value="'+I.s+'">'+I.s+'</option>'));
  const pick=$('#volPick');
  if(pick&&!pick.dataset.built){
    pick.dataset.built='1';
    INSTR.slice(0,8).forEach((I,i)=>{
      pick.insertAdjacentHTML('beforeend','<label class="row" style="gap:5px;align-items:center;font-size:12px"><input type="checkbox" class="volSym" value="'+I.s+'"'+(i<3?' checked':'')+'> '+I.s+'</label>');
    });
  }
  if(learnWired)return; learnWired=true;
  const num=(id)=>parseFloat($(id).value);
  $('#pctBtn').onclick=()=>{
    const a=num('#pctFrom'), b=num('#pctTo'), out=$('#pctOut');
    if(!(Number.isFinite(a)&&Number.isFinite(b))||a===0){ out.innerHTML='<span class="faint">Enter two values (“from” cannot be 0).</span>'; return; }
    const chg=((b-a)/Math.abs(a))*100;
    const back=a===b?0:((a-b)/Math.abs(b))*100;
    out.innerHTML='<div>Change: <b class="'+(chg>=0?'up':'down')+'">'+(chg>=0?'+':'')+chg.toFixed(4)+'%</b></div>'
      +'<div>Multiplier: <b>'+(a===0?'—':(b/a).toFixed(4))+'×</b></div>'
      +'<div>To get back to '+a.toLocaleString()+': <b class="'+(back>0?'up':'')+'">'+(back>=0?'+':'')+back.toFixed(4)+'%</b></div>'
      +(chg<-25?'<div class="faint">Note the asymmetry — big losses need disproportionately bigger recoveries.</div>':'');
  };
  $('#plBtn').onclick=()=>{
    const dir=$('#plDir').value, entry=num('#plEntry'), exit=num('#plExit');
    const units=num('#plUnits'), lev=Math.max(1,num('#plLev')||1), fee=Math.max(0,num('#plFee')||0)/100, slip=Math.max(0,num('#plSlip')||0);
    const out=$('#plOut');
    if(!(entry>0&&exit>0&&Number.isFinite(units)&&units>0)){ out.innerHTML='<span class="faint">Enter entry, exit and units (all positive).</span>'; return; }
    const sign=dir==='long'?1:-1;
    const gross=(exit-entry)*units*sign;
    const feeCost=(entry+exit)*units*fee;
    const slipCost=slip*2*units;
    const net=gross-feeCost-slipCost;
    const notional=entry*units, margin=notional/lev;
    const roi=margin>0?(net/margin)*100:0;
    const f=fee, beExit=dir==='long'
      ?(entry*(1+f)+2*slip)/(1-f)
      :(entry*(1-f)-2*slip)/(1+f);
    out.innerHTML='<div class="row" style="gap:16px;flex-wrap:wrap">'
      +'<div>Notional: <b>'+fmtMoney(notional)+'</b></div>'
      +'<div>Margin @ '+lev+'×: <b>'+fmtMoney(margin)+'</b></div>'
      +'<div>Gross: <b class="'+(gross>=0?'up':'down')+'">'+fmtMoney(gross,true)+'</b></div>'
      +'<div>Fees: <b>−'+fmtMoney(feeCost)+'</b></div>'
      +'<div>Slippage: <b>−'+fmtMoney(slipCost)+'</b></div>'
      +'<div>Net (hypothetical): <b class="'+(net>=0?'up':'down')+'">'+fmtMoney(net,true)+'</b></div>'
      +'<div>Return on margin: <b class="'+(roi>=0?'up':'down')+'">'+(roi>=0?'+':'')+roi.toFixed(2)+'%</b></div>'
      +'<div>Break-even exit: <b>'+(Number.isFinite(beExit)?beExit.toPrecision(6):'—')+'</b></div></div>'
      +'<div class="faint">Hypothetical arithmetic on your assumptions — not a forecast and not an order.</div>';
  };
  $('#ddBtn').onclick=()=>learnDrawdown();
  $('#volBtn').onclick=()=>learnVolatility();
  const cv=$('#ddChart');
  if(cv){
    cv.onmousemove=(ev)=>{
      if(!learnDD||!learnDD.series||!learnDD.series.length){ $('#ddTip').style.display='none'; return; }
      const rect=cv.getBoundingClientRect();
      const x=ev.clientX-rect.left, n=learnDD.series.length;
      const i=Math.min(n-1,Math.max(0,Math.round((x/rect.width)*(n-1))));
      const pt=learnDD.series[i];
      const tip=$('#ddTip');
      tip.textContent=new Date(pt.t).toLocaleDateString()+' · '+pt.dd.toFixed(2)+'%';
      tip.style.display='block';
      tip.style.left=Math.min(rect.width-120,Math.max(0,x+8))+'px'; tip.style.top='6px';
    };
    cv.onmouseleave=()=>{ $('#ddTip').style.display='none'; };
  }
  if(typeof window!=='undefined'&&!window.__ddResize){ window.__ddResize=true; window.addEventListener('resize',()=>{ if(learnDD&&$('#view-learn').classList.contains('active'))learnDrawdown(learnDD.payload); }); }
}
let learnDD=null;
function learnDrawdown(payload){
  const sym=$('#ddSym').value, g=Number($('#ddGran').value), status=$('#ddStatus');
  const run=(p)=>{
    const closes=p.candles.map(c=>c.close);
    let peak=closes[0], maxDd=0, maxAt=closes[0], series=[];
    const rows=p.candles.map((c,i)=>{
      peak=Math.max(peak,closes[i]);
      const dd=(closes[i]/peak-1)*100;
      if(dd<maxDd){ maxDd=dd; maxAt=c.time; }
      series.push({t:c.time*1000,dd});
      return dd;
    });
    learnDD={payload:p,series};
    const cv=$('#ddChart'); cv.style.display='block';
    const dpr=window.devicePixelRatio||1, W=cv.clientWidth||cv.parentElement.clientWidth||600, H=180;
    cv.width=W*dpr; cv.height=H*dpr;
    const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr); ctx.clearRect(0,0,W,H);
    const min=Math.min(-1,Math.min.apply(null,rows))*1.05;
    const X=i=>8+(i/(rows.length-1))*(W-16), Y=v=>8+(v/min)*(H-24);
    ctx.strokeStyle='rgba(255,255,255,.14)'; ctx.beginPath(); ctx.moveTo(8,Y(0)); ctx.lineTo(W-8,Y(0)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(0),Y(rows[0]));
    rows.forEach((v,i)=>ctx.lineTo(X(i),Y(v)));
    ctx.lineTo(X(rows.length-1),Y(0)); ctx.lineTo(X(0),Y(0)); ctx.closePath();
    ctx.fillStyle='rgba(229,72,77,.25)'; ctx.fill();
    ctx.beginPath(); rows.forEach((v,i)=>i?ctx.lineTo(X(i),Y(v)):ctx.moveTo(X(i),Y(v)));
    ctx.strokeStyle='#e5484d'; ctx.lineWidth=1.5; ctx.stroke();
    const cur=rows[rows.length-1];
    $('#ddStats').innerHTML='<div>Max drawdown: <b class="down">'+maxDd.toFixed(2)+'%</b></div>'
      +'<div>Depth reached: <b>'+new Date(maxAt).toLocaleDateString()+'</b></div>'
      +'<div>Current drawdown from peak: <b class="'+(cur<0?'down':'')+'">'+cur.toFixed(2)+'%</b></div>'
      +'<div class="faint">Method: running peak on close prices · '+rows.length+' candles · '+(GRAN_LABELS[g]||g)+'</div>';
    $('#ddSrc').textContent='Source: '+p.source+' (live provider) · '+p.instrument+' · fetched '+new Date(p.fetched_at).toLocaleTimeString()+' · past drawdown does not bound future drawdown.';
    status.textContent='';
  };
  if(payload&&payload.instrument===sym&&payload.granularity===g){ run(payload); return; }
  status.textContent='Loading real history from the live feed…';
  historyCandles(sym,g,400)
    .then(run)
    .catch((e)=>{ status.textContent='History unavailable ('+(e.message||'error')+'). The panel stays empty rather than showing invented data.'; $('#ddChart').style.display='none'; $('#ddStats').innerHTML=''; });
}
/* Real candle history for the calculator panels and the Market state view.
   Cloud viewer: read by this browser from the Deriv public feed first; the
   AURUM API is the fallback there and the only source on the PC. Never
   invented: a failure rejects.
   `acrossClosures`: the newest `count` candles there are. Without it Deriv
   answers with the candles of the last `count` candle widths of time, which
   are fewer after a weekend (src/derivhistory.js, fetchCandlesByCode). */
async function historyCandles(sym,granularity,count,{acrossClosures=false}={}){
  if(DERIV_CODE_MAP[sym]&&await isCloudflareHostedApp()){
    try{
      const candles=await candleHistory.fetchCandles(sym,granularity,count,{acrossClosures});
      if(candles.length>=30)return {source:'Deriv public feed, read by this browser',instrument:sym,granularity,count:candles.length,fetched_at:new Date().toISOString(),candles};
    }catch(_e){ /* this browser could not get it: ask the AURUM cloud */ }
  }
  const r=await api('/api/history/candles',{method:'POST',body:acrossClosures?{sym,granularity,count,across_closures:true}:{sym,granularity,count}});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.detail||j.error||'history unavailable');
  return j;
}
const volCache={};
function learnVolatility(){
  const g=Number($('#volGran').value), syms=[...document.querySelectorAll('.volSym:checked')].map(c=>c.value).slice(0,5);
  const out=$('#volOut');
  if(!syms.length){ out.innerHTML='<span class="faint">Tick at least one instrument.</span>'; return; }
  out.innerHTML='<span class="faint">Comparing realized volatility on real candles…</span>';
  const ppy=(365*24*3600)/g;
  Promise.all(syms.map((sym)=>{
    const key=sym+'|'+g;
    if(volCache[key])return Promise.resolve(volCache[key]);
    return historyCandles(sym,g,400)
      .then((j)=>{ volCache[key]=j; return j; })
      .catch(()=>null);
  })).then((res)=>{
    const rows=res.map((p,i)=>{
      if(!p)return{sym:syms[i],na:true};
      const closes=p.candles.map(c=>Math.log(c.close));
      const rets=closes.slice(1).map((v,i)=>v-closes[i]);
      const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
      const sd=Math.sqrt(rets.reduce((a,b)=>a+(b-mean)*(b-mean),0)/(rets.length-1||1));
      return{sym:syms[i],vol:sd*Math.sqrt(ppy)*100,n:rets.length};
    });
    const ok=rows.filter(r=>!r.na), max=Math.max.apply(null,[1].concat(ok.map(r=>r.vol)));
    out.innerHTML=rows.map((r)=>{
      if(r.na)return'<div class="row between" style="margin:4px 0"><span>'+r.sym+'</span><span class="faint">unavailable</span></div>';
      const w=Math.max(2,Math.round((r.vol/max)*70));
      return'<div class="row between" style="margin:4px 0"><span style="min-width:86px">'+r.sym+'</span><span style="flex:1;margin:0 10px"><span style="display:inline-block;height:9px;width:'+w+'%;background:linear-gradient(90deg,var(--brand),#e5b567);border-radius:4px;vertical-align:middle"></span></span><b class="mono">'+r.vol.toFixed(1)+'%/yr</b></div>';
    }).join('')
    +'<div class="hint">Annualized realized volatility, last '+ (ok[0]?ok[0].n:0) +' candles per instrument · statistical description of the past, not a forecast.</div>';
    $('#volSrc').textContent='Source: deriv-public (live provider) · method: stdev of log returns × √(periods/year) on '+(GRAN_LABELS[g]||g)+' closes.';
  });
}

/* Sniper record: honest tally of the sniper's own booked trades on this device */
function renderAtRecord(){
  const el=$('#atRecord'); if(!el)return;
  const rows=(state.history||[]).filter(h=>h.at);
  if(!rows.length){ el.textContent='No sniper trades booked yet.'; return; }
  const wins=rows.filter(h=>(h.pl||0)>=0).length, losses=rows.length-wins;
  const net=rows.reduce((a,h)=>a+(h.pl||0),0);
  el.innerHTML='<b>'+wins+'W / '+losses+'L</b> ('+Math.round(wins/rows.length*100)+'% win rate) · net <b class="'+(net>=0?'up':'down')+'">'+fmtMoney(net,true)+'</b> over '+rows.length+' sniper trade'+(rows.length===1?'':'s')+'. Losses are part of trading — the guard pauses the sniper after 3 in a row.';
}

/* ================= Brand & logo (Settings) =================
   BRAND_DEFAULT is the built-in Shelricktech brand every device starts with.
   A name/tagline/logo set in Settings replaces it on THAT device only
   (localStorage via settings). The logo below is generated from
   branding/shelricktech-logo.jpg by scripts/make-brand-assets.py. */
const BRAND_DEFAULT={name:'Shelricktech',tag:'INVESTMENT',logo:'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAQDAwQDAwQEBAQFBQQFBwsHBwYGBw4KCggLEA4RERAOEA8SFBoWEhMYEw8QFh8XGBsbHR0dERYgIh8cIhocHRz/2wBDAQUFBQcGBw0HBw0cEhASHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBz/wAARCADcANwDAREAAhEBAxEB/8QAHQABAAICAwEBAAAAAAAAAAAAAAcIBQYBAwQJAv/EAFsQAAEDAgIFBgYJEAcECwAAAAEAAgMEBQYRBxIhMUETUWFxgZEIIjKhscEJFBUjQlKCstIWFzM0Q1VWYnJzdZKUlbPRGCQ3U2Oi0yUmVMInNURFRmR0g5Ph8P/EABsBAQACAwEBAAAAAAAAAAAAAAAFBgMEBwIB/8QAPxEAAQMCAgYIBQMBBwUBAAAAAAECAwQFESEGEjFBUXETImGBkaGx0RQyweHwM0JSIwcVJENTcvEWNIKSomL/2gAMAwEAAhEDEQA/AL/IAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCA4Lg0EkgAcSviqiJiowMZVYktFGcprjTNcOHKAnuCj5rvQwfqTNTv9jajoqiT5WL4GOkx7YY91YX/AJMTj6loP0otjf8AMx5IvsbDbRVu/Z5odX1w7F/xEo/9lyxppXbf5r4Ke/7lq/4+aHphxxYJ8gLjG0nhI1zfSFsx6RW2TZMic8U9TE+1Vbdsa92ZmKa4UlaM6aphmH+G8O9ClIamGZMYno7kqKab4pI/naqc0PSs5jCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAxl1v8AQWVmdXOGvIzEbdr3dQUdX3aloG41D8F4b17jZp6OaoXCNuPoaLdNI1ZMSyghZTx8HyeM89m4edUev0zneqtpGaqcVzX2TzJ+nscbc5nY9ibDUa66VtxJdVVc02fB7zl3blVai4VVUuM8iu78vDYTEVNDCmEbUQ8G7ctbJDYPz8FfEU9IfjnXo+n5cdi+oemnXrujcHMJa4biDke9e2KrVxauB6VEVMFM7bsb3u16ojrXzRj7nP447ztHepuk0gr6bJJNZOC5/fzI+a0Uk21mC9mX2N3s2lOiqdWO5wmkkOzlWeNH28R51baDS2CXBtU3UXjtT3QgarR+aPrQLrJw2L9zfKeohq4WTQSslieM2vY7MHtVsjkZI1HsXFF3oQD2OYqtcmCnavZ5CAIAgCAIAgCAIAgCAIAgCAID8ySMiY573BrGjMuccgAvL3tY1XOXBEPqIqrghH2IsfucX01pOQ3OqSN/5I9ZVAvGlyrjDQf+3t7qWKis2x9R4e5oUs0k0rpJXue9+1znHMk9aockjpHK964qu9SwMajERrUwQ6iSvJkU4OWW1EB+Y43SPDGNc953NaMyexZWsdIuqxMV7D6qtamLlwQy9NhC91gHJ2+VoPGXJg86lqfR64zZtiVOeXqaUl0pI9r8eWZkodGl6kHjvpIuuQn0BSkeh9e75lanf9jVdfqZNiKvd9zuOiy6ZfblH/m/ks//AEXV/wCo3z9jwmkMCfsXyPHUaML3HmWOpJehshHpCxP0Qr2/KrV7/dDMzSCldtRU7vuYauwdfaBpMtsnc0fCiykH+XNR09iuEGb4lw7M/Q3obpSSfLInfl6mvPa6Nxa8Frxva4ZEdii3NVq4OTBSRaqOTFFxQyNkxHccPT8rRTlrSc3xO2xv62+sbVv2+51NA/WhdlvTcvca9XQQVjcJUz470JkwpjqhxM0Qn+rXADMwPPldLTxHnXSbTfILgmr8r+HtxKTcbTNRLrbW8ffgbUpsiggCAIAgCAIAgCAIAgCAIDrqKiKlhfNM9scUY1nOcdgCxTTMgjWWVcGptU9MY57ka1MVUibFGKpr5M6GIujoGnxWbi/pd/Jcmv2kMlxescXViTdx7V+iFut9ubTJrvzf6cjWnZquJjgShwdy9YH09dttNZdpuRo4HSuHlHc1vWdwW7RW6prn9HTsx9E5qYZ6qKnbjKuBvlq0bU8erJcp3Su3mKLxW9p3nzK9UGhkTMH1btZeCZJ47V8iv1F9e7KBME4rtNxobXRWxmpSUsULfxG5E9Z3lW6moqelbqwMRqdiELLPJMuMjlU9a2jEeS4XOktcPK1czY2cNhJPUBtK9MY564NMckrI0xeuBpl10s2q3a3JWrEFaB8Kntcob3vDVuxW6R+1zU5uQjZrxDFsY93Jq/XA1G4eEbQ0LsnYaurD/wCYLYvSt9lie7/Mb3ZkXJpTGzbE7vyPHH4TdvcfHw9VhvO2oYfUF7XR6RP3p4KYk0uiXbEvih6ZNOOBb+0R3a01rM/hy07X6vymu1h2KOrNFFqG4Sta/wBSRpNM4Ylxarmenkp5n0GDsSEnDWJqVlQd1JWPLCTzAuAPpVGuegEsaK+nRW9i5p4psLrbNOaaZUZK5HeS+C7TAXG1XHD1UxtXDLTTNOtG8HYSOLXDYexUaeiqaCRElarVTYvspeKeqp6yNVjVHIu1PdCUcB6RBdXRWy6vDa7dFMdgm6DzO9KvFjv6VOFPUrg/cvH7+pU7xZVp8Z4M2b04fb0JGVqK4EAQBAEAQBAEAQBAEAJyGZ3Iq4AirGWJjdqg0tO7+ownePujhx6ubvXJ9J76tdL8PCv9Nv8A9Lx5Ju8S2Wug6BvSvTrL5J7mp8VVCZOHEAr01QbnhvAstwDKq460NMdrYhse8dPMPOrrZNFX1KJPWYtZuTevPgnmQlfeUjxjgzXjuT3JIpKKnoIGwU0LIom7mtGQXRaemipo0ihajWpuQrEkj5Haz1xU71nPAQBAEAyQHXLBHOwsljZIw72vAI86+oqpmh5c1HJgqGp3rRbhG/BxqrHSNlcPstO3kXjpzZl51uQ3Gph+V6+vqR9RZ6Ko+eNMezL0IrxP4NzmtfNhy5lxG0U1dx6BI0ekdqmKe/7p296exXazRTa6lf3L7kJ3/Dd2wxWGju9BNSTfBEjc2v6Wu3OHUp+CojnbrROxQqlVRzUrtSdqov5sPbZscXuywGlhrXTUB8qjqhysJ+S7d1tIK1K600dexY6iNFRTct97rrc9H00qph3oZqmxdRVUjS+J1FIeAeXMB6Hbx2965Lf/AOz6opMai2Kr2/x/cnLj6nYNHv7R6Wrwp7oiRv2a37V58PQsTo3xyMQUwt9bIDcYGZtkJ+zs+N1jj3r5Y7q6patPUZSN47/vxJG82tKdUqIM43cN32XcSArEQIQBAEAQBAEAQBAEBpmPL+aKlFugeRPUNzkI3tZ/9+jNUzS68fDQ/BxL1n7exv39CatFH0r+memTfX7EZErl5aT8ofSR8IYMEIjuFyjzmPjRQuHkdLuno4LpOjejSRIlXWN621G8O1e3s3FZud018YoVy3rx+xvavRAhAEAQBAEAQBAEAQHgvFkt2IKGShudHDV0sm+OVuY6xzHpG1ZIpXxO141wUwz08VQxY5WoqdpXHSNoIq7Eya5Yc5Wtt7QXSUrvGmhHO347fOOlWigvTZVSOoyXjuX2KPddHHwIstL1m8N6cuPqQup8qpnMOYprsNV1PVUkpBheHtaTsB6PWOKrd50apri5KhnUmTY5PRyb08y1WDSuqtSLTv8A6kDtrF9WruXyLlYNxZRYzsNNc6J7TrjKWIHN0Ug3tP8A+2jIquSQTQLqTtwd5d3YXeCrgqm9JTuxb596blM+sZnCAIAgCAIAgNTrMQuueLosN26TbSMFVcpm/c2fAiB+M87TzNB51tNg1YemfvyT6r3epHvqukqUpo92bl4cE5r6GzVdVHRUs1RM7KOJpe49AUfUTsp4nTSLk1MVJONjpHIxu1SD7lXy3Ovnq5vLldnl8UcB2BcNrqx9bUPqJNrl8E3J3IXqngbBEkbdx5VqGY3bAmGRVPF0q2ZwsPvLDuc4fC6hw6epXrROxJMqV1QnVT5U4rx7t3aQN3r9RPh41z3+xJS6SVoIAgCAIAgCAIAgCAIAgCAg/S7oZZdmT37DsAZcW5vqKNgyFRzuaOD+j4XXvn7XdliwhnXq7l4fb0KnfLCkyLUUydbenHl2+pWogtJBBBGwgjIhWrEoaoqZGy4HxtccC3llfQO1o35NqKdxyZOzmPMeY8OrMLVrKNlXHqP27l4G/brhLQS9JHs3pxLk4ZxJQYss1PdLbLylPMNoPlRuG9rhwIVGqIH08ixyJmh1Ckqo6uJJolxRfzAy6wmyEAQBAEBqukLGUOB8MVVzfquqT71TROP2SU7h1DaT0ArboqVaqZI02b+RH3OubQ07pV27ETiprmhC0zwYVkvdc50tyvs7quWV/lObnk3Pzn5S2rvK1Z+iZ8rEwQ0dH4HNplnkzdIuK/QzWkO5GCghoWHxqh2s/wDJb/M5dy5pprX9FTNpWrm9cV5J7qXiywa8qyr+31UjM71zItJkbDaJL1c4qVuYYfGkcPgsG8+rtUpZ7a641bYE2bVXgn5katZVJTRK/fu5k1QQR00McMTAyONoa1o3ABdsiibExI2JgiZIUhzlcqudtU7F7PIQBAEAQBAEAQBAEAQBAEAQFeNO+jEQmXFVohAY4518LBuJ+6gfO7+dWWzXDHCmlXl7exStI7QiY1kKf7k+vv4kAblZSmEi6ItIT8EX5sdTIfcatcGVLTujO4Sjq4846goy6UKVUWLfmTZ7E5Y7mtDNqvXqO29nb+bi4DHNe1rmkOa4Zgg5ghUg6Wi4pihyh9CAIAgKoaZsSy41x3FZaJ5fS0UgooQ07HTOcA93fk35PSrhaYEpqZZn7Vz7txzu/Vbq2tSnjXJq4JzXb7FpbbQxWu3UlFCMoaaJsLB0NAA9CqMj1e5XrtU6BFGkTGxt2ImBFuNK727iCoAJ1IMoR2b/ADkrjmlVX8RcXomxnV8NvmXS0w9HTtXjma7xKrpJko4BtQo7Uax7cpqs6w6GDd37SuraIW74ej+IcnWkz7t3uVO8VHSTdGmxvrvNtVtIgIDjNAM0BzmgGaAZoAgGaAZoBmgGaAZoBmgCA654I6mGSGZjZIpGlj2OGYcCMiCOZfUVUXFDy5qORWrsUphpOwS7AuKJ6GMONvnHLUjzxjJ8nPnadnceKvVurPioUcvzJkv52nLrxb1oalWJ8q5py4dxpgOS3yKLVaA8aOv+G32erl1q605MaXHa+A+QezIt7AqdeqToZukamTvXedE0ar1qKfoXr1mem72JcUMWQIAgNa0gYk+pLCF1urSOXhiLYQeMrvFZ5yD2Laoqf4idsfH03mhc6v4SlfNvRMua7Cq+iKhN10k2JkhL9SZ1S8u25ljS7M9oCt90ckdI/Dkc9scazV8eOeePhmXLc4MYXOOwDMqiOcjUVVOoomJBVTO6pqJpnHN0j3PJ6zmuCVMqzTPkX9yqvipf4majGtTcgoaR1dXQUrPKmeGZ82ZXuipnVU7IG/uVEPk0vRRukXchOkMTIIY4mDJkbQ1o5gF3eKNsbEY3YiYeBQnOVyq5dqnFRURUkEtRPKyKCJpe+R7g1rGgZkkncANua9nwoHps8Nq93S41Vp0cSNt1niJj913xh9RU5bC6NrgRGw8CQXHf4u5AVmvGkrGl/kdLdMW36sc7aeWuEpHcHZDuQGEdfrg45uutaeurf9JAPd2vP/etZ+1v+kgHu3XffSr/AGt/0kBP3gZ3SqqtPloilrqiZhoawlj53PB975iUBKXsgdfPR3HAQhq5oNaGtJEcrmZ+NDzEZoCmAvlf99Kv9qf9JADe6/76Vf7U/wCkgOReLjvFxrf2mT+aAG9XBu+5Vg66p/0kBx7uV+X/AFpWZf8Aq3/SQD3brvvpV/tT/pID666D5HS6HcBSPe57nWWjJc45knkm7c+KA35ARtptwgMT4NqKiGLXuFrzqYchtLQPHb2t29bQpS0VXQVCIux2S/QgtIKH4qkVzU6zM0+qeBUIq7qc0N00VYldhbHFrqi/Vpp3+1ajbsLHkDM9R1T2KPudP09M5u9M07iVstWtLWMeuxcl5KXSVEOphAEBAvhLXt0dBZbNG77PI+qlHQwarfO49ysWj8OL3yruy8Sn6WVGEccCb1xXu2GmeDvSCfH75SPtehlcOsuY31lb19dhTInFU+pF6LM1q1XcGr9C0N2k5K11snxYXn/KVQ7g/UpJXcGu9DpMCYytTtQg4bGjqXB0L6bLgKk9s4hZKR4tPG6Tt3D0q16H0/S3BHr+xFX6fUi7zJqU2rxX7ksLrJUStPhvY2qcMaImWmjldFPiKsbRSOacjyAaZJBn06rWnocUB83qKjnuVdS0VLGZaqqlZDFGPhPe4NaO0kID6eaLvBM0fYFstI27WSixBftUOqa64Rcs0vy2iON3itaDu2Z85KAkwaKMBD/wRhr91QfQQHP1qcBfgRhr91QfQQHH1qcBfgRhr91QfQQHutOAsKWCtbXWnDFlt9awFraikoIopADvAc1oORQHpvmEsP4mdC692K2XN0AIiNdSRzGMHLPV1gcs8hu5kBifrU4C/AjDX7qg+ggH1qsB/gThr91QfQQHyi0u0tPQ6Vcb0tJBFT0sF5q44oYmBrI2iVwDWtGwADgEBZrwEMKWHE1Njz3bsdsunteSiERrqSOfk82y56uuDlnkM8uZAXD+tTgL8CMNfuqD6CAfWqwH+BOGv3VB9BAbPSUdPb6SGko4IqalgYI4oYWBjI2gZBrWjYABwCAxeHb57qe3qSctFxt0xgqGDZnxa8Dmc3I944LBDLr4tXai4L+dprwTdJrNXa1cF+i95mnNDmkEAg7weKzmwuZR/SBh76lsYXa1taWwxTF0P5t3jN8xy7F0Chn6enbJv380OTXOl+FqnxbkXLkuaGtgkeScncDzLbNDkXowXePqgwnZrkXaz6mlje8/j5ZO84K55VRdDM+PgqnXaCf4imjl4ohnVrm2EBUzwgLk6t0hT0+tm2ipooQOYkF5+cFcrHHq0utxVfY5xpNLr1yt/iiJ9TKeDXl9WN0z3+55y/8AkYsV/wD0G8/obGif/dP/ANv1QsffQTZbhl/cP+aVQbsirQzYfxd6HR6X9dnNPUhPguGF7N50aw51Fxmy3NYzzk+pX/QWPrzSck9Sv352TG8yQ10UrhTT2QemldhnA9SAeRir6iNx4BzogR5muQFIcK3puHcUWO8uYZG22ugq3MG9wjka8juagPszY73b8R2iiu1rq4qu3V0TZoJ4jm2RjhmCEBkEAQBAEAQBAEB8edM39r+Pv05W/wAZyAtZ7HoP6rpCP+LQ/NmQF2kAQBAQ/jC8OwRpQoLrnlQXOnbHVDgQHapd1t8U96h6iT4erSTc5MyCq5fha1su5yZkvtcHNDgQQdoI4qYJ0rZ4StmEF7s12Y3IVUDqd5HFzDmPM89ytOj8uMb4+C4+JRdLINWWOZN6YeH/ACQarCVEtxoCrTV6OKOMn7Vnmh7NfWHzlS70zVq3LxwU6Vo3Jr0DU4KqeZJyiSeB3IClWlac1GkXEb3HPKqLB1Na1vqV8tiatJGnYcrvTtavlXtNn8HiqEGkB0ROXtiilYBzkFrvUVqX1uNMi8FT6m/ou/VrcOLV+haauiM9FUxDe+Nze8FUarj6SB7OKKnkdJidqvR3BSCxsAHFcEwwyL8ikg6NPsNy59dnoK6NoL+lPzT0Url++dnJTe1fSAIp8InRZJpd0XXSxUmoLvC5tZby85N5ePPJpPAOaXMz4a2fBAfJ6vttVaa6poK+mmpa2lkMU1PMwskieDkWuB3EIDbME6XMcaOWOiwxia4W2me7XdTMeHwl3PybwW59ICA3weF9plGQ+q9p67dTf6aA/TfDB0yNcD9VsZy4G203+mgNmw54cuk201LXXWOzXqn+EyWl9rvI6HxnIHraUBdHQlp8w3putM01sD6K8UYBrLXUOBkhB3PaRsewnZrDjsIBQErIAgCA+POmf+1/H36crf4zkBa32PT7U0hfnaH5syAuygCAICHdPtGHW+y1eX2OaSInoc0H/lUNeG9Vju0gb63qMd2m06JsQG+4PpmyP1qmhJpZMztIb5J/VI7lt26bpYEx2pkbtrn6anTHamRrHhG0IqMEUtVlm6lrWHPmDmuafOQrTYX4VKt4opFaVR61Gj+Dk88irCt5z0tF4NsrnYMuDCfFZXuy7Y2Ko39P8Q1ez6qdA0UXGkcn/wCvohMqgy0BAUi0kgt0gYmB3+35T51frf8A9rHyQ5Rd0/x03+5T16JrmLVpFsE7jkySf2uT+caWekheLnH0lI9E3Jj4GSyS9FXxO4rh45F0uCoh1MhC70ntG6VlPt97lcB1Z5jzFcKudOtNWSwrucvhu8i9UsnSQsem9DbdGsuU1yi5wx3pCuOgsnWnj/2r6kPfm/I7mSEuiFdCAjTSXoEwHpYdy+IrIx1yDQxtwpXmGpaBuGu3ygOZwIQEH3D2P7B00rnUOKsQU7DubI2CXLt1AgMcfY97D+HF4/Y4UB1z+x62d0ZEGO7myTgZKGJw7gR6UBW/Th4O2JdB09JPX1EFysda8xU9xpmlg1wM+TkYcyxxAJG0ggHI7CEBrWh3H1Vo00k4exHTSuZFBUsiq2g7JaZ7g2Vp+Sc+toPBAfYRpDgCDmDxQHKAID486Zznpex7+nK3+M5AWt9j0+09IX52h+bMgLsoAgCAjHTqwHCFM7i2tZ816i7v+gi9pD3pP8Oi9qfU1DQPdjBfLjbXHxKqATNH4zDl6HeZadolwe5i7zRskuEjo13pj4G96cKcT6Mr0Tvi5KQdkrVcrQuFYzv9Dc0hbjb5OzD1Qp2d6vBzEtP4OUHJ4Gq5P72vkPcxg9Sp9+XGpROxPqdC0VbhRqvFy/Ql9QpZgdyAplphozR6ScQMIyEkrZR1OY0q9Wp2tSM8PM5dfY9SvlTiuPihpdLUyUNTDUwnKaB7ZWH8ZpBHnC33tRzVau8i43qxyPbtTPwL6We5RXi1UVwhIMVXCyZuR4OAPrXOZWLG9WLuyOwQSpNG2RuxURfEj/SFQGC6xVYadSpZkT+M3Z6Mu5cs01o1iq21CJk9PNPsW2yTa0Sxru9FPNgGq5DEHJE7KiJzO0bR6CsGhtR0dw6Nf3tVPDMy3qPWp9bgpKy6uVIIAgCAIAgK8eGuymdoEupnDeUZW0Zg1t4fywGzp1S7zoD5jPzMb8t+qckB9sLHr+4tu5TPlPa8etnz6gzQGQQBAfHnTOP+l7Hv6crf4zkBa32PT7U0hfnaH5syAuygCAICL9O0obhKkjz2vrWeZj1FXdf6KJ2kPe1wgRO33Iq0WVZo8e2d2eyVz4T8phHpyUTb3atQ0hLW/VqmeHkTRpoeGaMb/n8KOMd8jFfLSmNZH+bibvy4W+XknqhTbeVeTl5cPQhb/aGja0EjJ1TylQflPOXmyVIu8mvVv7MvBDp2j8XR0EfbivipIajCaCAq34RtqNJjKjrwPErqQAnndG4g+ZzVbrDLrQOZwX1Of6VQ6tU2T+SehDqnCsYlqvB8xKLtg59qkfnUWmTkwOJidm5h7DrDsVPvdP0dR0ibHeu86HoxV9NS9Cu1nouwkDFlpN3s00bG5zxe+xdJHDtGYVJ0ht3x9E5jU6yZpzTd37C5W6p+HnRy7FyUiW21pt9ypavb7zI1x6s9vmzXJLfUrSVUc/8AFUX3LhURdNC6PihOjHtkY17CC1wzBHELurXI5qObsUoSpguCmJxXie34Mw5c8QXaR8dttsDqid8bC9wY3eQ0bT1L0fCDj4bOiMHI3O6fuub+SAf02dEf30un7rm/kgOP6beiP753T91zfyQH4n8N7RNFC57K27zOG6OO2SBx/WyHnQFTfCP8Jio03GjtFtoJrbhehm5dsU7gZqqXIhr36uxoaCcmgneSTuyAjrQ5o+rNJ2kiwYdpYnvgmnbNWSNGyGmY4OkeebZ4o5y4DigPsG0BrQAMgNw5kBygCA+POmb+17Hv6crf4zkBaz2PT7U0hfnaH5syAu0gCAICGNP1YBBY6MO2ufJMR1ANHzioS8uyY0gL67qsbzUjDArizGdgI/42Id5yUVRr/XZzIehyqY+aEzaf6v2ro5qo88jU1EMQ6fG1v+VdGsrdarReCKTGkr9WgcnFUTzKmwQSVU8cEQLpZniNgHFxOQ85Vyc5Gorl2Ic4YxXuRqbVL52O2R2WzW+3RZcnSQMhGXHVaB6lzuWRZHueu9cTsFPEkMTYk3IieB71jMwQEP8AhE4fNzwdBc42ky2ucPcRwjf4rvPqnsU1Yp9SoWNf3J5oVrSil6WkSVNrF8lyX6FWNyuBzw3jRRjD6jMY0lVM/Vt9V/VqrmDHHY75Lsj1ZqPudL8TTq1NqZoS9krvg6pHO+Vcl9+4ucCHAEEEHiFRTqKEUY4sJtVxNVC3KkqiXbNzH8R27+9cn0rtHwdT8RGnUf5LvTv2oW201nTRdG5es30NxwLdRcLKyFzs5qT3t3Pq/BPds7FcdFLh8XQpG5etHkvLd5ehDXan6GdXJsdn7mI03YfuWK9EuMbLZ6Y1V0r7dLBTwB7WmR5GwZuIA7SrORZ853eCZpiOf+5c37bTf6iA/P8ARL0yHfgyX9tpv9RAcjwStMYz/wBy5f22m/1EB3QeCHpjnOqMIcn0yXCmA/iIDdcK+AlpCu1Qz3dr7PZKTMa5EpqpcuhrQG59bkBdHQ5oOwxoVs0lHZIpJ6+qyNXcanIz1BG4bNjWjbk0bB0nagJLQBAEB81dJ/gxaVsQaScX3a3YSknt9fdaqop5RWU7RJG+VzmuyMgIzBG9AWE8DLRPjDRdTYzbi2zOtjrhJSOpw6eOTlAwS63kOOWWsN/OgLTIAgCArhpruYrsY+1mnNtDAyI/lO8Y+kKs3aTWn1eCFTvMuvUavBDXNH0JnxvYWgZ5VTXfq5n1LWokxqGJ2mrb241LOZvHhL3UNoLDa2u8aWV9S8dDW6o87z3LqOj8WL3ycEw8TNpbNhHHCm9VXw/5I70H4aOIMeUkz2Z0tsHtuQ8NYbGD9Y5/JKk7xUdFTK1NrsvchdHqT4isa5djM/bzLfKlHSggCA8N4tdPe7VW22qbrU9XE6F46HDJe4pFjej27UMU8LZo3RP2KmBRW9WmosV2rbZVt1amjldC/pIO8dBGR7V0KGVs0aSN2KciqIHQSuiftauB4VlMJafQVpCZiGytsNbL/tS2xgRlx2zQjYD0luwHsKp95oehk6ZidV3kp0LRy5pUQ/DyL12+afYlW5W+C6UctLUN1o5Bl0g8COkKt1tHFWQugmTFF/MS1wzPhekjFzQjKhNTgjEYZU5mnk8VzgNj4ydjh0j+a5pSLNo7c9Sb5HZY7lTj3byzzalypdZnzJ68O8lZrg9oc0gtIzBG4rqjXI5MUKoqYZKc5DmX0+DIcyAZDmQDJAEAQBAEAQDIIAgCAIDpq6qKipZqmdwZDCwyPceDQMyV8c5Gorl3Hlzka1XLsQp7ebnJertXXGXy6uZ0pHNmdg7BkFS5pFker13lDmlWWR0i71Nz0MW81mN4ZtXNlHBJMesjVHzlvWpmtUIvBCQs7NepReCL7Gq6cb+L3j+uYyTWp7cxtIzmBbtf/mJHYuuWeDoqVFXa7P2ILSKq6etcibG5e/mTnoPwc7C+D46mpj1LhdSKmUEbWsy97aeobetxVfu9V086o3Y3L3Lbo9QfC0qOcnWfmv0QkxRRPBAEAQFefCJwSWyU+KqSPxXatPWho3Hcx5+afkqy2Kr20zuafVPqUrSm37Kxidjvov08Cv6spTD3WW9VuH7rS3K3zGGspn68bxu6QRxBGwjmKxTQsmYsb9imanqJKeRJYlwVC5uAMdUOPLHHXUxbHVR5MqabPN0L/W07weI6c1Rq2jfSyajtm5eJ1G23GOvhSRm3enBfzYZq82amvdI6nqG7d7HjymHnCg7lbYLjCsMycl3ovYTNNUvpn67P+TDYenq7LM2y3M5j/slR8GRvxc+ccyiLPLPQPS3Vn/g7cqcOacDcrWx1CfEwf+ScF48jalZyLCAIAgCAIAgCAIAgCA89dXU9to56urmZDTQML5JHnINaN5XprVeqNamKqeJJGxtV71wRDigqJKukinkhdCZRrCN/lNB3A8xy3jgjkwXARuVzUcqYYkdaa8Si2YeZaYX5VVyOTgN7Yh5Xech3qJus+pF0abXehFXio6OHok2u9Cu6rRVSWdHFVFg7BOJMWVIGYygpwfhubuA63uA7FaNHaNZ34J+5cO5NpM0UjaOklq3ck/OZoeiPAs2OsUurq9pktlHJy9U9+6aQnWDOnM7T0da6LdKxtLD0bPmXJOxOJX7JbnV1T0subWrivavD3LcgZDIblSzpIQBAEAQHkultpbxbqmgrYmy0tTGY5GHi0he45HRuR7VwVDHNEyZixvTFFyKV48wXV4GxBUW2o1nw+XTzkbJoidh6xuI5x1K+UVW2qiSRNu9OCnK7lQPoZ1ids3LxT82mrkbVtkeZ3CeK7lg28Q3O2S6krPFfG7yJmcWOHEejeFr1NLHVRrHIn2NuirZaKVJYl9lTgpb7AmkC1Y9toqaF/J1UYHL0jyOUhPrbzOG/r2Kk1lFJSP1X7Ny8TpluucNfHrxrnvTen5xNnqKaKriMczA9h25HgeBHMelR00LJm6kiYoSbXuYuLVOxrdVobmTkMszvKyImCYHk5X0BAEAQBAEAQBAEB566uprZSTVdZPHBTQtL5JZHZNaOclemMc9yNamKqeJJGxtV71wRCMbNdZ9LOIRVMjfFgy0TB0bXjI3CobtaXD4jNjsufLPmErNElBFqr+o7/wCU91IGnnddZtdEwhYv/s72Qk6trYLdRz1dVK2KngYXve7c0DeVDOcjEVztiE+97WNVzlyQqhjDEs2LL/VXKQFsbjqQxn7nGPJHXxPSSqjVVCzyK9e7kUirqVqZVkXZu5GEgglqZ4oYWF80rgxjRvc4nIDvWu1quXBNprtRXKjU2qb9jChrMQV1i0aWDKRtsaJK+YeQJiM3OceZusT0lwG8Lqlkp47bSfES8ME7f+V8jZuTZKqWO1037fmXdj28vVSecJ4XocH2KmtNA08lCM3yOHjSvPlPd0n+Q4KKqah9RIsj9qltoqOOjhSGPYnmvEzawG2EAQBAEAQGpaQsB0WPrG6iqCIquLN9LUgZmJ+XnadxHrAW5Q1j6STXbs3pxI2526Ovh6N2SpsXgv5tKcX6w3DDV1qLZc6d0FXAcnNO5w4OaeLTwKvEE7J2JJGuKKcwqaaSlkWKVMFQxqzGA9tpu1dYq+Gvt1VLS1cJzZLGciOjpB4g7CscsTJmKyRMUUywTyQPSSJ2CoWOwBp+t92bFQ4lDKCv2NFU3ZBKen4h69nSNyq9bZJI8XwdZOG9PcvNt0limwjquq7juX29CaI5WTRtkje18bxm1zTmCOcFQSoqLgpaUVHJih+18PoQBAEAQBAEAQGo400kWLA9O43CpElYRnHRwkOlfzbPgjpOQW5SUM1UuEaZcdxG191p6Fv9V2fBNpBsFXifT5iEU8jnUOHKV4dKyI5xwjhmfhyEbs9g35DjPubBaYtZOtIv53IVRr6q/Taq9WNNuGz7qWStFpo7DbKa3UELYaSmYGRsbwHrJ3k8SVWJZXSvV71xVS8QQsgjSKNMEQgzS3pBF7ndZLbKHW6B/v8AK07J3jgOdoPeepVm5VvSL0Ua5Jt7Su3WvSVehjXJNvaRUVEKQhvmjyx175H3ejpRPWsJht7JPI5cjxpXngyMHM85IA2qesdG2SXppsmN8+RJUMEn6saYu2N4Y8V7E9cicMD4Ho8F2+SNj3VNxqncrWVsg8eokO0k8wzJyHrVmq6t1S7FckTJE4IWC329lGxUTNy5qu9VNqWoSAQBAEAQBAEAQGn6QNHdsx9bhFVDka6EH2vVsGbozzH4zTxHdkVu0VdJSP1m5ou1CMudrir49V+Tk2Lw+3YVIxdg67YLubqG605Y45mKZu2OZvO13Hq3jirpS1cVUzXjXu3oc3rqCeik6OZOS7l5GAWyaQQG1YU0iYiwa4C13B4ps8zSze+Qn5J3dmS06m3wVP6jc+KbSRorrVUWUTsuC5p+ciZ8O+Enb6hrY79a5qWXjNSHlYz06pycPOoGosEjc4XY88lLTS6VxOyqGK1eKZp7kmWfSRhS+tBor9Qucfuckgjf+q7IqKloKiL52KT0F1o5/wBORPHD1NnZIyVgexwc07i05grVVMNpvoqLmh+l8PozQHguN8tloYX19wpKVo3meZrPSVkZE+TJjVUwy1EUSYyOROamgX3TzhC0tc2lqpbnONzKSMluf5bsh3ZqRhs1VJ8yaqdpDVOklFDk12svZ7kP4r0+4kvofBbAy0UjtmcJ15iOl53fJA61N01kgizk6y+RWq3Saqn6sPUTz8fYxuj7Rbd9Idb7eqXywWkv1pq6XMvmPEMz8o/jHYOncstdcoqNuozN3DhzNe2Wee4v6R+KM3qu1eXHmWssVhtuFbRDbrbAymooATlnvPFzjxJ4kqnzTvmeski4qdFp6eKljSKJMEQiHSXpXFYyazWGU8g7NlRWMOWuOLWHm53ceHOq5X3HWxjhXLevsQdyuiORYoVy3r7EODdkoQr5ncJYVq8XXiKgpQWs8qabLMRM4k9PADiVs01O6oejG95tUlK+pk1G95aq0WiksdupqGiiEdPTsDGjjlzk8STmesq2xxtjYjG7ELrFE2JiMYmSHuXsyBAEAQBAEAQBAEAQGOvlhtuJLfJQXSjiqqWTeyQbjzg7wekbVkimfC5HxrgphqKeKoYscrcUUrpjjwfbna3y1eG3uuNFtd7VeQJ2dAO5/mPWrPR3xj01ajJeO77FIuOjEsSq+l6ycN/3IaqaWejnfBUwywTsOTopWlrmnpB2hTrXNems1cUKu+NzHK16YL2nUvR4G1fQHbRtAPWvgPRS19XRHOmq6iA/4Urmegrw+NjvmRF7jIyaRnyOVO8ybMY4jjGTL/dWjdkKyT+axfCU67Y08EM6V9UmyV3ip0VGJL1VjVqLxcZRzPqpCPSvTaeFvysTwQ8OrKh+TpFXvUxjna7tZ2bnc52nvWVMskNdcVzUy2H8MXjFVV7Xs9vnq5PhFg8Rn5TjsHaVhnqYqdNaV2Bs0tFPVO1YWK708SfsCeD3R210VbieVldUDxhRx58g0/jHe/q2DrVbrL4+TFkHVTjv+xc7doxHFhJVLrLw3ff0JRv+K7Hg2jZ7dqI4A1uUVNEM3uA3BrBw7gqzUVUcPWkXPzLFPUw0reuuHZ9iBcb6ULnizXpIAaK1H7gx3jyj8d3qGzrVeq7i+fqpk0rNbc5KjqNyb68zRFHEWZnDWF7hiq5NobfFrO3ySO2Mib8Zx9W8rPT07536rENmmpZKl+pGn2LO4RwlQ4PtTaKjGtI7xpp3DxpX856OYcFaqamZTs1GlypaVlMzUZ3rxM+tg2QgCAIAgCAIAgCAIAgCAIDCYgwhY8UwiO72ynq8vJe9uT29ThtHYVngqZYFxicqGrU0VPVJhMxF/OJE1/8ABsttRryWS7T0jjtENS0Ss6tYZOHnUzDf5G5StReWRXKnRSF2cD1b2LmnuQtifR5f8JVXI3KjDWk5MmY7OOT8l3q3rY/6noWLhNrM5pinimJWKuz1VK7B7e/ca+631TfuD+wZrZj0gtkmydvfkaK00qftO6mslxrXasFJI93NsHpKz/3xQf67fFD0ykmeuDWqbHb9FWLbjkY7YxjT8KaqiYPnZry69UKf5iLyzN6OyVsmxmHNUT6m123QFc5dV11v1ot8XENl5V49A8605tI6ZvyJjzwQkYdGJlzmka3z9jc7Xo10ZYYLZbteoLnO3e2eobqZ/m2b+3NQtTpK52SPRqdm0loLNbKbrSv1l7Vy8ENln0vYRsFKKWz0sk0cexkVLAIYh35ehV6e8RYquKuX84kit1pIG6kKYom5EwQ0O/6ab/dGvioGxWyB2zOLx5cvyjsHYFFzXWZ+TOqnmR095nkyZ1U8yO6iplq5nzVEskszzm6SRxc5x6SVGucrlxVcVIlznOXWcuKnXnkF8wPBv+DNFN1xM6OprGvoLYdvKSN98kH4jT6Ts61I0tukm6zskJWjtUs+Dn9VvmpYOw4ft+G6BlFbadsMLdpO9zz8Zx4lWKGFkLdViYIWmCCOBmpGmCGTWUzBAEAQBAEAQBAEAQBAEAQBAEAQHRV0dPX076eqgjngkGTo5GhzT1gr45qOTByYoeXMa9NVyYoRfiLQdbK5z5rNUvt8p28i8GSI9XFveepRU9pjfnGuHoQ9RZYn9aJdVfIjG9aLMT2cuL7Y6rhH3SkPKj9Xyh3KKlt88f7ceRDT2upiX5cU7MzUJqd9JIWTQuheN7ZGahHYVpK1WrgqYGg5qtycmB+NVruDT2L4eTkADcMupfAgLgN5A7V9GJkLfY7pd3BtBbqupJ/uonEd+5ZY4ZJPkaqmaOnll+Rqqb3ZNCeILiWvuD4LdCd4eeUky/Jbs7ypCG1TPzfkhJwWWd+ci6qeKkrYY0W2DDRZMKc1la3b7YqsnEH8Vu4enpUvBb4Yc0TFeKk3TW2CDNExXipuq3SQCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIDpqKSnq2alRBFMz4sjA4edeXNR21Dy5rXZOTEw1RgfDdUSZbFbiTxFO0egLC6kgdtYngYHUVO7axPA6G6O8KsOYsNB2xArz8FT/AMEPH9303+mhkKTDFkocjTWigiI4sp2A9+SyNp4m/K1PAzNpoWfKxE7jKtaGgAAADgFmMxygCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAIAgCAID/9k='};
/* Once per device: clearing the name or tagline field used to store a copy of the
   built-in text of that time ("FREDRICK" / "TRADING"). Such a copy is not a custom
   value, so it is dropped and the device follows the current built-in brand. The
   marker keeps this to a single run: either word typed in Settings afterwards stays. */
if(!state.settings.brandMigrated){
  const b=state.settings.brand;
  if(b&&typeof b==='object'){ if(b.name==='FREDRICK')delete b.name; if(b.tag==='TRADING')delete b.tag; }
  state.settings.brandMigrated=1; store.set('settings',state.settings);
}
function brandName(){ return String((state.settings.brand&&state.settings.brand.name)||BRAND_DEFAULT.name).slice(0,24); }
function applyBrand(){
  const b=state.settings.brand||BRAND_DEFAULT;
  const name=String(b.name||BRAND_DEFAULT.name).slice(0,24);
  const tag=String(b.tag||BRAND_DEFAULT.tag).slice(0,24);
  const bn=$('#brandName'), bt=$('#brandTag'), bm=$('#brandMark');
  if(bn)bn.textContent=name; if(bt)bt.textContent=tag;
  if(bm){
    if(b.logo||BRAND_DEFAULT.logo){ bm.innerHTML='<img src="'+(b.logo||BRAND_DEFAULT.logo)+'" alt="logo" style="width:26px;height:26px;border-radius:8px;object-fit:cover;display:block">'; }
    else bm.textContent=(name.trim()[0]||'S').toUpperCase();
  }
  const al=document.getElementById('authLogo');
  if(al)al.src=b.logo||BRAND_DEFAULT.logo; /* login dashboard shows the brand mark */
  document.title=name.replace(/\b\w/g,c=>c.toUpperCase())+' — Trading Workspace';
  const ni=$('#brandNameInput'), ti=$('#brandTagInput');
  if(ni&&document.activeElement!==ni)ni.value=b.name===undefined?'':b.name;
  if(ti&&document.activeElement!==ti)ti.value=b.tag===undefined?'':b.tag;
}
/* Also at start-up: the login screen shows the logo before anyone has entered the app. */
applyBrand();
function bindBrand(){
  const ni=$('#brandNameInput'); if(ni&&!ni.__wired){ ni.__wired=true;
    ni.addEventListener('input',()=>{ const b=state.settings.brand=state.settings.brand||{}; const v=ni.value.trim(); if(v)b.name=v; else delete b.name; save(); applyBrand(); });
  }
  const ti=$('#brandTagInput'); if(ti&&!ti.__wired){ ti.__wired=true;
    ti.addEventListener('input',()=>{ const b=state.settings.brand=state.settings.brand||{}; const v=ti.value.trim(); if(v)b.tag=v; else delete b.tag; save(); applyBrand(); });
  }
  const fi=$('#brandLogo'); if(fi&&!fi.__wired){ fi.__wired=true;
    fi.addEventListener('change',()=>{
      const f=fi.files&&fi.files[0]; if(!f)return;
      if(!/^image\//.test(f.type)){ toast('Not an image','Pick a picture file (PNG, JPG…).','err'); return; }
      if(f.size>150*1024){ toast('Too large','Please use a picture under 150 KB (screenshots are usually much bigger).','err'); return; }
      const rd=new FileReader();
      rd.onload=()=>{ const b=state.settings.brand=state.settings.brand||{}; b.logo=String(rd.result); save(); applyBrand(); toast('Logo updated','Your picture now shows in the sidebar on this device.','ok'); };
      rd.readAsDataURL(f);
    });
  }
  const rs=$('#brandReset'); if(rs&&!rs.__wired){ rs.__wired=true;
    rs.onclick=()=>{ state.settings.brand={}; save(); applyBrand(); const fi2=$('#brandLogo'); if(fi2)fi2.value=''; toast('Brand reset','Back to the built-in Shelricktech name and logo.','ok'); };
  }
}

/* ================= News: market-moving feed + today's calendar (UTC) ================= */
/* The number saved on this device, otherwise the built-in one (WA_DEFAULT, top of this file). */
function waDigits(){ return String(state.settings.wa||'').replace(/\D/g,'')||WA_DEFAULT; }
function waLink(text){
  const d=waDigits();
  if(!d||d.length<8){ toast('WhatsApp number missing','Add your number in Settings (international format, digits only) — it stays on this device.','err'); return null; }
  return 'https://wa.me/'+d+'?text='+encodeURIComponent(text);
}
/* Auto WhatsApp: client pushes (signals/brief/trade results) when the toggle is
   on; the server's own timer covers the app-closed case when WA_AUTO_SHARE=true. */
function pushWA(text){
  if(state.settings.waAuto===false)return;
  api('/api/wa/push',{method:'POST',body:{text}}).catch(()=>{}); /* silent: wa.me taps remain the fallback */
}
async function waServerStatus(){
  try{ const r=await api('/api/wa/status'); return await r.json().catch(()=>({})); }catch(e){ return {}; }
}
/* Dedicated Gold/USD monitor: deterministic only; no orders and no silent source fallback. */
const GOLD_SYMBOL='XAU/USD';
const GOLD_REFRESH_MS=60000;
const GOLD_NEWS_MATCH=/(gold|xau|bullion|dollar|\bUSD\b|federal reserve|\bfed\b|powell|CPI|PCE|payroll|nonfarm|inflation|interest rate|treasury yield)/i;
let goldMonitorTimer=null, goldAnalysisBusy=false, goldNewsBusy=false, goldAnalysisAt=0, goldNextAttemptAt=0, goldAnalysisError='', goldNewsAt=0;
let goldCalendarDay='', goldCalendarEvents=[], goldCalendarError='', goldHeadlineItems=[], goldHeadlineError='', goldMt5Quote=null, goldLastNotifiedKey=(()=>{try{return localStorage.getItem('aurum_gold_signal_last')||'';}catch(_e){return '';}})();
function goldCalendarTime(e){
  /* The moment of an entry: its own `t` and day where the calendar gives them (the cloud's whole week), else its UTC clock on the calendar's day. */
  return goldCalendarDay&&e?eventTime(e,goldCalendarDay):null;
}
function goldEATTime(t){try{return new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Nairobi',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(t));}catch(_e){return '—';}}
function goldUsdEvent(e){ return /^(USD|US|UNITED STATES)$/i.test(String(e&&e.country||'').trim()); }
function goldEventAlertSeen(key){
  try{const a=JSON.parse(localStorage.getItem('aurum_gold_event_alerts')||'[]');return Array.isArray(a)&&a.includes(key);}catch(_e){return false;}
}
function markGoldEventAlert(key){
  try{const a=JSON.parse(localStorage.getItem('aurum_gold_event_alerts')||'[]');const n=Array.isArray(a)?a:[];n.push(key);localStorage.setItem('aurum_gold_event_alerts',JSON.stringify(n.slice(-200)));}catch(_e){}
}
function renderGoldEvents(){
  const el=$('#goldEvents');if(!el)return;
  if(goldCalendarError){el.innerHTML='<div class="empty"><b>USD calendar unavailable</b>'+escHtml(goldCalendarError)+' No upcoming-event claim is being made.</div>';return;}
  const now=Date.now();
  const rows=goldCalendarEvents.filter(e=>goldUsdEvent(e)&&(e.impact==='High'||e.impact==='Medium'))
    .map(e=>Object.assign({},e,{_time:goldCalendarTime(e)}))
    .filter(e=>e._time==null||(e._time>=now-2*3600000&&e._time<=now+24*3600000));
  if(!rows.length){el.innerHTML='<div class="hint">No scheduled USD medium/high-impact entries are listed in the current public calendar. This does not mean there will be no unscheduled news.</div>';return;}
  el.innerHTML='<div class="tbl-wrap"><table class="tbl news-tbl"><thead><tr><th>Time UTC / EAT</th><th>Impact</th><th>Event</th><th>Countdown</th></tr></thead><tbody>'+rows.map(e=>'<tr><td class="mono tiny nowrap">'+(e._time!=null?escHtml(e.time_utc)+' UTC · '+escHtml(eatStamp(e._time,now)):'All day')+'</td><td class="nowrap"><span class="badge '+(e.impact==='High'?'sell':'gray')+'">'+escHtml(e.impact)+'</span></td><td class="tiny">'+escHtml(e.event||'')+(e.impact==='High'&&e._time!=null?'<div class="faint" data-gold-aside-span style="white-space:nowrap">no new trade '+eatClock(e._time-STAND_ASIDE.beforeMin*60000)+'–'+eatClock(e._time+STAND_ASIDE.afterMin*60000)+' EAT</div>':'')+'</td><td class="nowrap">'+(e._time==null?'<span class="badge gray">time unavailable</span>':'<span class="badge tiny gray" data-gold-event="'+e._time+'">—</span>')+'</td></tr>').join('')+'</tbody></table></div><div class="hint tiny">Calendar: ForexFactory public weekly schedule via AURUM API · times UTC · refreshes periodically. Scheduled events only; breaking headlines may arrive without warning.</div>';
  updateGoldEventCountdowns();
}
/* Under the Gold signal: the same note as above the chart. A reading stays shown during a stand-aside
   period; the note says that no new trade belongs in it. */
function updateGoldAside(){
  const el=$('#goldAside');if(!el)return;
  const out=chartEventHtml(GOLD_SYMBOL).trim();
  if(el.dataset.h!==out){el.innerHTML=out;el.dataset.h=out;}
}
function updateGoldEventCountdowns(){
  const now=Date.now();
  updateGoldAside();
  $$('#goldEvents [data-gold-event]').forEach(el=>{
    const t=Number(el.dataset.goldEvent), d=t-now, mins=d/60000;
    el.textContent=d>0?newsTLabel(t):(d>=-15*60000?'released '+Math.max(0,Math.floor(-d/60000))+'m ago':'passed');
    el.className='badge tiny '+(d<=0?'gray':mins<=15?'sell':mins<=60?'':'gray');
  });
  if(goldCalendarError||!goldCalendarDay)return;
  for(const e of goldCalendarEvents){
    if(!goldUsdEvent(e)||e.impact!=='High')continue;
    const t=goldCalendarTime(e);if(t==null)continue;
    const mins=(t-now)/60000;
    for(const milestone of [15,5]){
      if(mins<=milestone&&mins>milestone-1.2){
        const key=[e.day||goldCalendarDay,e.time_utc,e.country,e.event,milestone].join('|');
        if(goldEventAlertSeen(key))continue;
        markGoldEventAlert(key);
        const aside='Stand aside: no new Gold trade '+eatClock(t-STAND_ASIDE.beforeMin*60000)+'–'+eatClock(t+STAND_ASIDE.afterMin*60000)+' EAT ('+STAND_ASIDE.beforeMin+' min before to '+STAND_ASIDE.afterMin+' min after).';
        const current=state.goldAnalysis?'\nGold reading now, for information only (the stand-aside period applies to it):\n'+goldSignalMessage(state.goldAnalysis):'\nGold signal unavailable right now; no direction is invented.';
        const message='USD high-impact event in about '+milestone+' minutes: '+e.event+' ('+e.time_utc+' UTC / '+goldEATTime(t)+' EAT). '+aside+' Expect possible volatility; check the live quote and spread.'+current;
        notify('Gold news alert',message,{tag:'gold-news-'+key,kind:'warn'});
        pushWA('🟡 Gold/USD scheduled-news alert\n'+message+'\nAURUM analysis only — no order sent.');
      }
    }
  }
}
function renderGoldHeadlines(){
  const el=$('#goldHeadlines');if(!el)return;
  if(goldHeadlineError){el.innerHTML='<div class="empty"><b>Headline feed unavailable</b>'+escHtml(goldHeadlineError)+' No substitute headlines are shown.</div>';return;}
  const list=goldHeadlineItems.filter(it=>GOLD_NEWS_MATCH.test(String(it.title||''))).slice(0,6);
  if(!list.length){el.innerHTML='<div class="hint">No Gold/USD-related headlines found in the available feed. This is not confirmation that no news exists.</div>';return;}
  el.innerHTML=list.map(it=>'<div class="news-row"><div class="grow"><a class="headline" href="'+escHtml(it.link||'#')+'" target="_blank" rel="noopener">'+escHtml(it.title)+'</a><div class="src">'+escHtml(it.source||'')+(it.published?' · '+escHtml(it.published):'')+'</div></div><span class="badge gray">HEADLINE</span></div>').join('');
}
async function refreshGoldNews(force){
  if(goldNewsBusy)return;goldNewsBusy=true;
  try{
    /* The calendar is the page's one calendar (News view, the line above the chart, this page): the
       stand-aside period shown here is then the same one as everywhere else. */
    const [,headResult]=await Promise.allSettled([loadCalendar(force===true),api('/api/news/feed')]);
    if(state.calError)goldCalendarError=state.calError;
    else{goldCalendarDay=state.calDay;goldCalendarEvents=calendarEntries()||[];goldCalendarError='';}
    if(headResult.status==='fulfilled'){
      const nr=headResult.value,nj=await nr.json().catch(()=>({}));
      if(nr.ok){goldHeadlineItems=Array.isArray(nj.items)?nj.items:[];goldHeadlineError='';}
      else{goldHeadlineItems=[];goldHeadlineError=nj.detail||nj.error||'Headline feed unavailable';}
    }else{goldHeadlineItems=[];goldHeadlineError=String(headResult.reason&&headResult.reason.message||'Headline feed unavailable');}
    renderGoldEvents();renderGoldHeadlines();updateGoldAside();
  }finally{goldNewsAt=Date.now();goldNewsBusy=false;}
}
function goldQuotePrice(q){
  const bid=Number(q&&q.bid),ask=Number(q&&q.ask);
  if(bid>0&&ask>0)return (bid+ask)/2;
  if(bid>0)return bid;if(ask>0)return ask;
  return null;
}
function goldEpochMs(value){const n=Number(value);return !Number.isFinite(n)||n<=0?0:(n>1e12?n:n*1000);}
function goldFreshTimestamp(value,maxAgeMs=120000){const t=goldEpochMs(value),age=Date.now()-t;return t>0&&age>=0&&age<maxAgeMs;}
function goldDataSource(){
  const selected=state.settings.goldSource||'auto';
  if(selected==='deriv'||selected==='mt5')return selected;
  return state.broker&&state.broker.type==='mt5'?'mt5':'deriv';
}
function goldUsingExnessResult(){return state.goldAnalysis?String(state.goldAnalysis.data_source||'').startsWith('Exness MT5'):goldDataSource()==='mt5';}
function updateGoldQuoteDisplay(){
  updateGoldConfidence();
  const badge=$('#goldQuoteState'),priceEl=$('#goldPrice'),sourceEl=$('#goldSource'),timeEl=$('#goldQuoteTime');if(!badge)return;
  const I=bySym[GOLD_SYMBOL];let q=null,source='';
  if(goldUsingExnessResult()){
    q=goldMt5Quote;source='Exness MT5 local bridge';
  }else if(I&&I.p!=null&&I.t){
    q={price:I.p,time:I.t/1000,digits:I.d,trade_mode:null};source='Deriv public live tick; analysis uses Deriv public candles';
  }
  if(!q){badge.textContent=goldUsingExnessResult()?'UNAVAILABLE':'WAITING';badge.className='badge gray';priceEl.textContent='—';sourceEl.textContent=source||'Waiting for a public price feed.';timeEl.textContent='Quote time: —';return;}
  const tickMs=goldEpochMs(q.time),age=tickMs?Date.now()-tickMs:Infinity;
  const fresh=age>=0&&age<120000&&Number(q.price)>0;
  const rawDigits=q.digits,digitValue=rawDigits==null?NaN:Number(rawDigits);
  const digits=Number.isInteger(digitValue)&&digitValue>=0&&digitValue<=8?digitValue:(I&&I.d)||2;
  priceEl.textContent=Number(q.price)>0?fmtPx(Number(q.price),digits):'—';sourceEl.textContent=source;
  timeEl.textContent='Quote time: '+(tickMs?new Date(tickMs).toLocaleString():'unknown')+(fresh?' · updated '+Math.max(0,Math.floor(age/1000))+'s ago':' · timestamp stale/unknown');
  badge.textContent=fresh?'FRESH':'STALE';badge.className='badge '+(fresh?'buy':'gray');
  if(goldUsingExnessResult()&&fresh){
    const mode=Number(q.trade_mode);
    if(mode===3){badge.textContent='CLOSE ONLY';badge.className='badge gray';}
    else if(mode===0){badge.textContent='NO ENTRY';badge.className='badge gray';}
    else if(![1,2,4].includes(mode)){badge.textContent='MODE UNKNOWN';badge.className='badge gray';}
  }
}
async function refreshGoldQuote(){
  if(goldDataSource()==='mt5'){
    try{
      const r=await bridge.quoteBridge(['XAUUSD']);const q=r&&r.quotes&&r.quotes[0],price=goldQuotePrice(q);
      if(!q||!Number(q.time)||!(price>0))throw new Error('No current Exness MT5 tick');
      goldMt5Quote={symbol:String(q.symbol||''),price,time:Number(q.time),digits:q.digits,trade_mode:q.trade_mode};
    }catch(_e){goldMt5Quote=null;}
  }
  updateGoldQuoteDisplay();
}
/* The live price the Gold monitor is showing, or null when it has no fresh one. */
function goldLivePrice(){
  if(goldUsingExnessResult())return goldMt5Quote&&goldFreshTimestamp(goldMt5Quote.time)&&Number(goldMt5Quote.price)>0?Number(goldMt5Quote.price):null;
  const I=bySym[GOLD_SYMBOL];
  return I&&I.p!=null&&goldFreshTimestamp(I.t)?I.p:null;
}
/* Gold monitor score: the analysis' own figure, moved by the price since this BUY/SELL was first read. */
function updateGoldConfidence(){
  const el=$('#goldConfidence'),bar=$('#goldConfidenceBar'),note=$('#goldConfidenceNote'),measured=$('#goldMeasured');if(!el)return;
  const d=state.goldAnalysis;
  if(measured)measured.textContent=d?measuredText(goldReading(d)):'';
  if(!d){el.textContent='—';if(bar)bar.style.width='0%';if(note)note.textContent='No current analysis, so no score is shown.';return;}
  if(!isAsterPublishable(goldReading(d))){el.textContent='WITHHELD';if(bar)bar.style.width='0%';if(note)note.textContent='ASTER has not approved publication; the technical confidence score is withheld.';if(measured)measured.textContent='';return;}
  const live=goldRuns.read(GOLD_SYMBOL,goldLivePrice()),score=live?live.confidence:(Number(d.confidence)||0),dig=goldDisplayDigits();
  el.textContent=score+'%';if(bar)bar.style.width=score+'%';
  if(note)note.textContent=live?describeLive(live,{time:timeStr,price:v=>fmtPx(v,dig)}):'No confirmed direction, so there is no entry, stop or target to follow.';
}
function goldDisplayDigits(){const raw=goldMt5Quote&&goldMt5Quote.digits,d=raw==null?NaN:Number(raw);return Number.isInteger(d)&&d>=0&&d<=8?d:((bySym[GOLD_SYMBOL]&&bySym[GOLD_SYMBOL].d)||2);}
function goldFmtLevel(value,digits){return value==null||!Number.isFinite(Number(value))?'—':fmtPx(Number(value),digits);}
function goldSignalMessage(d){
  if(!isAsterPublishable(goldReading(d)))return 'Gold/USD technical candidate withheld by ASTER. Required evidence has not passed validation. No directional signal or levels are published.';
  const dig=goldDisplayDigits();
  return '🟡 Gold/USD technical signal · '+d.signal+'\nSource: '+(d.data_source||'verified live candles')+'\nMTF: '+(d.mtf_signal||'—')+' · quality score '+(d.confidence??'—')+' (not probability of profit)\nEntry '+goldFmtLevel(d.entry,dig)+' · SL '+goldFmtLevel(d.stop_loss,dig)+' · TP1 '+goldFmtLevel(d.tp1,dig)+' · TP2 '+goldFmtLevel(d.tp2,dig)+'\n'+(d.signal==='WAIT'?'No 2-of-3 confirmation; stand aside.':'Levels are technical references only; verify spread, news and broker terms.')+'\nAnalysis-only; no order was sent.'+(measuredLine(goldReading(d))?'\n'+measuredLine(goldReading(d)):'');
}
/* The Gold monitor's analysis as a reading of XAU/USD, for the helpers that look a market up by its symbol. */
function goldReading(d){return Object.assign({},d,{symbol:GOLD_SYMBOL});}
function renderGoldAnalysis(){
  const d=state.goldAnalysis;if(!d)return;
  const approved=isAsterPublishable(goldReading(d)),directional=isDirectionalCandidate(d),dig=goldDisplayDigits();
  const badge=$('#goldSignalBadge');
  badge.textContent=directional&&!approved?'ASTER BLOCKED':(d.signal||'WAIT');
  badge.className='badge '+(approved?(d.signal==='BUY'?'buy':d.signal==='SELL'?'sell':'gray'):'gray');
  $('#goldSignal').textContent=directional&&!approved?'WITHHELD':(d.signal||'WAIT');
  $('#goldSignal').className=approved&&d.signal==='BUY'?'up':approved&&d.signal==='SELL'?'down':'faint';
  $('#goldVotes').textContent=approved?'Analysis timeframe: M1 / M5 / H1 · '+(d.mtf_signal||'no confirmation')+' · '+(d.data_source||''):'ASTER publication blocked · timeframe direction is withheld until required evidence passes.';
  $('#goldSignalUpdated').textContent=(closeText(d)?'Reading of the '+closeText(d)+' candle close · checked ':'Last analysis: ')+(d.updatedAt?new Date(d.updatedAt).toLocaleString():'—')+(closeText(d)?' · the next reading comes with the next 5-minute close; no fixed expiry.':' · review after next M5 candle; no fixed expiry.');
  $('#goldEntry').textContent=approved?goldFmtLevel(d.entry,dig):'—';$('#goldSL').textContent=approved?goldFmtLevel(d.stop_loss,dig):'—';$('#goldTP1').textContent=approved?goldFmtLevel(d.tp1,dig):'—';$('#goldTP2').textContent=approved?goldFmtLevel(d.tp2,dig):'—';
  const votes=String(d.votes||''),buy=(votes.match(/BUY/g)||[]).length,sell=(votes.match(/SELL/g)||[]).length,wait=(votes.match(/WAIT/g)||[]).length;
  $('#goldPressure').textContent=approved?'Timeframe vote tally: '+buy+' BUY · '+sell+' SELL · '+wait+' WAIT. '+(d.signal==='BUY'?'Bullish technical confluence is confirmed.':d.signal==='SELL'?'Bearish technical confluence is confirmed.':'No directional majority; the monitor stands aside.'):'Technical vote details are withheld because ASTER has not approved publication.';
  $('#goldRationale').textContent=approved?(d.rationale||d.technical_summary||'No rationale returned.'):'Technical rationale is withheld until ASTER validates all mandatory evidence.';
  $('#goldRisks').innerHTML=(Array.isArray(d.risks)?d.risks:[]).map(x=>'<li>'+escHtml(x)+'</li>').join('')||'<li>No additional risk detail supplied.</li>';
  const key=[approved?d.signal:'ASTER_BLOCKED',d.mtf_signal,d.data_source].join('|');
  if(goldLastNotifiedKey!==key){
    const previous=goldLastNotifiedKey;
    goldLastNotifiedKey=key;try{localStorage.setItem('aurum_gold_signal_last',key);}catch(_e){}
    if(approved&&directional){
      const msg=goldSignalMessage(d);
      notify(previous?'Gold/USD signal changed':'Gold/USD signal ready',msg,{tag:'gold-signal-'+key,kind:d.signal==='BUY'?'ok':'warn'});
      pushWA(msg);
    }else if(!approved&&(String(previous||'').startsWith('BUY|')||String(previous||'').startsWith('SELL|'))){
      notify('Gold/USD candidate withheld','ASTER no longer approves publication. The technical candidate and its levels are withheld until all required checks pass.',{tag:'gold-signal-aster-blocked',kind:'warn'});
    }
  }
}
function goldAnalysisNoticeText(){
  const auto=state.settings.goldAuto!==false;
  const retry=auto&&goldNextAttemptAt?Math.max(0,Math.ceil((goldNextAttemptAt-Date.now())/1000)):null;
  /* A reading that names no close was made by an AURUM server from before 13 Nov 2026 (server/app.js), which looked
     at the forming candles every minute. The page says so instead of promising the 5-minute rule for it. On the PC
     that is a server process started before the package folder was brought up to date: START_LOCAL_API.bat leaves
     a running one alone. */
  const everyMinute=!!state.goldAnalysis&&!closeText(state.goldAnalysis);
  const rule=everyMinute?'this reading can change every minute: it comes from an older version of the AURUM server, which does not read at the 5-minute close yet'+(isPrivateBridgePage()?'. If that server runs on this PC, close the "Fredrick AURUM Local API" window and run START_ALL_LOCAL.bat again':''):'a reading changes only when a 5-minute candle closes';
  const cadence=auto?(retry==null?'Automatic retry is scheduled after this check.':'Auto-refresh '+(goldAnalysisError?'retry':'next check')+' in '+retry+'s ('+rule+').'):'Auto-refresh is off; use Analyze now to retry.';
  if(goldAnalysisBusy)return 'Fetching fresh '+(goldDataSource()==='mt5'?'Exness MT5 XAUUSD':'Gold')+' quote and M1 / M5 / H1 candles. '+cadence;
  if(goldAnalysisError){
    const raw=String(goldAnalysisError);
    const disconnected=goldDataSource()==='mt5'&&bridge.bridgeStatus().status!=='connected';
    if(disconnected||/bridge not connected|login required|auth_required|not logged in|bridge token rejected/i.test(raw))
      return 'Exness MT5 is unavailable in this tab. A clearly labelled Deriv fallback was attempted but did not return fresh data. Connect Exness (read-only) and keep MT5 open for the primary source. '+cadence;
    if(goldDataSource()==='mt5')return raw+' A labelled fallback was attempted but no fresh substitute is shown. '+cadence;
    return raw+' No old signal is shown as current. '+cadence;
  }
  if(state.goldAnalysis)return 'Verified source: '+(state.goldAnalysis.data_source||'live candles')+'. Last successful check '+(goldAnalysisAt?Math.max(0,Math.floor((Date.now()-goldAnalysisAt)/1000))+'s ago. ':'')+cadence;
  return 'Waiting for verified live data from '+(goldDataSource()==='mt5'?'the Exness MT5 local bridge':'Deriv public candles')+'. '+cadence;
}
function updateGoldAnalysisNotice(){
  const box=$('#goldAnalysisNotice');if(!box)return;
  const title=$('#goldAnalysisNoticeTitle'),text=$('#goldAnalysisNoticeText'),connect=$('#goldConnectBtn');
  const failed=!!goldAnalysisError;
  box.classList.remove('hidden');box.classList.toggle('warn',failed);
  if(title)title.textContent=goldAnalysisBusy?'Gold analysis running':failed?'Gold analysis unavailable':state.goldAnalysis?'Gold data status':'Waiting for Gold data';
  if(text)text.textContent=goldAnalysisNoticeText();
  if(connect){const needsConnect=goldDataSource()==='mt5'&&failed&&bridge.bridgeStatus().status!=='connected';connect.classList.toggle('hidden',!needsConnect);}
}
function openGoldExnessConnect(){
  const auth=$('#authScreen'),shell=$('#appShell');
  if(shell)shell.classList.remove('ready');
  if(auth)auth.classList.remove('hidden');
  const tab=$('#authTabMt5');if(tab)tab.click();
  const field=$('#exnessPass');if(field)field.focus();
}
function goldFallbackReason(){
  if(state.settings.goldSource==='deriv')return 'Deriv explicitly selected in Gold settings';
  return state.broker?.type==='mt5'?'Exness MT5 did not provide fresh Gold data':'Exness MT5 bridge is not connected';
}
async function goldDerivFallback(reason){
  goldMt5Quote=null;
  const label='Deriv public candles · labelled fallback (reason: '+String(reason||'Exness MT5 data unavailable').slice(0,120)+')';
  const tick=bySym[GOLD_SYMBOL];
  if(!tick||!tick.p||!goldFreshTimestamp(tick.t))throw new Error('Deriv Gold live tick is stale or unavailable; Exness fallback reason: '+reason);
  try{
    const res=await api('/api/signals/analyze',{method:'POST',body:{symbol:GOLD_SYMBOL,force:true,technicalOnly:true,withNews:false}});
    const j=await res.json().catch(()=>({}));if(!res.ok)throw new Error(j.detail||j.error||'Live Gold analysis unavailable');
    if(!goldFreshTimestamp(j.latest_candle_time))throw new Error('Deriv Gold M1 candle timestamp is stale or unavailable.');
    if(j.candle_current===false)throw new Error('The signal API has no current Gold reading.'); /* for whichever reason: this browser reads the candles below and says which */
    return Object.assign({},j,{data_source:label,fallback:true,fallback_reason:reason});
  }catch(serverError){
    const [m1,m5,h1]=await Promise.all([feed.fetchPublicCandles(GOLD_SYMBOL,60,120),feed.fetchPublicCandles(GOLD_SYMBOL,300,120),feed.fetchPublicCandles(GOLD_SYMBOL,3600,120)]);
    const closed=closedCandleSets({m1,m5,h1}),det=runDeterministicAnalysis(GOLD_SYMBOL,closed.sets);
    const short=['m1','m5','h1'].find(k=>det.analyses[k].error);
    if(short){const a=det.analyses[short];throw new Error('Deriv '+a.timeframe+' history has '+(a.have||0)+' verified candles; at least '+(a.required||50)+' are needed.');}
    const lastCandle=m1[m1.length-1];if(!lastCandle||!goldFreshTimestamp(lastCandle.time))throw new Error('Deriv Gold M1 candles are stale; no live signal will be shown.');
    if(!closed.current)throw new Error(RESUMED_NOTE('Deriv Gold'));
    return Object.assign({},localDecision(det),{symbol:GOLD_SYMBOL,mtf_signal:det.mtfSignal,votes:votesSummary(det.analyses),data_ok:true,data_source:label,fallback:true,fallback_reason:reason,latest_candle_time:lastCandle.time,candle_close:closed.close,meta:{mode:'technical',reason:'labelled_deriv_fallback'}});
  }
}
async function runGoldAnalysis(){
  if(goldAnalysisBusy)return;goldAnalysisBusy=true;goldAnalysisError='';goldNextAttemptAt=0;
  const btn=$('#goldAnalyzeBtn');if(btn)btn.disabled=true;
  const status=$('#goldFeedStatus');if(status)status.textContent='ANALYZING · '+(goldDataSource()==='mt5'?'Exness MT5':'Deriv public');
  updateGoldAnalysisNotice();
  try{
    let d;
    if(goldDataSource()==='mt5'){
      try{
      /* Exness MT5 is primary; on a verified failure the approved, labelled fallback is attempted. */
      const [m1,m5,h1,qReply]=await Promise.all([
        bridge.bridgeHistory('XAUUSD','M1',120),bridge.bridgeHistory('XAUUSD','M5',120),bridge.bridgeHistory('XAUUSD','H1',120),bridge.quoteBridge(['XAUUSD'])
      ]);
      const sets={m1:m1&&m1.candles,m5:m5&&m5.candles,h1:h1&&h1.candles};
      if(!sets.m1||!sets.m5||!sets.h1)throw new Error('Exness MT5 did not return all required Gold timeframes.');
      const closed=closedCandleSets(sets);
      const det=runDeterministicAnalysis(GOLD_SYMBOL,closed.sets),decision=localDecision(det),q=qReply&&qReply.quotes&&qReply.quotes[0],price=goldQuotePrice(q),lastCandle=sets.m1[sets.m1.length-1];
      if(!q||!Number(q.time)||!(price>0)||!goldFreshTimestamp(q.time))throw new Error('No fresh Exness Gold tick; live signal is paused rather than reused.');
      if(!lastCandle||!goldFreshTimestamp(lastCandle.time))throw new Error('Exness Gold M1 candles are stale; refresh when current history returns.');
      /* Not current: just resumed after a pause, or (no close at all) a history without a finished 5-minute candle. */
      if(!closed.current)throw new Error(closed.close>0?RESUMED_NOTE('Exness Gold'):'Exness Gold history gives no finished 5-minute candle to read at yet.');
      goldMt5Quote={symbol:String(q.symbol||''),price,time:Number(q.time),digits:q.digits,trade_mode:q.trade_mode};
      d=Object.assign({},decision,{price:det.analyses.m1&&det.analyses.m1.currentPrice,mtf_signal:det.mtfSignal,votes:votesSummary(det.analyses),data_ok:det.ok,data_source:'Exness MT5 local candles',latest_candle_time:lastCandle.time,candle_close:closed.close,meta:{mode:'technical',reason:'local_read_only'}});
      }catch(exnessError){goldMt5Quote=null;d=await goldDerivFallback('Exness MT5 unavailable: '+String(exnessError&&exnessError.message||exnessError).slice(0,100));}
    }else{
      d=await goldDerivFallback(goldFallbackReason());
    }
    d.updatedAt=Date.now();state.goldAnalysis=d;goldAnalysisAt=Date.now();goldAnalysisError='';
    goldRuns.observe(Object.assign({},d,{symbol:GOLD_SYMBOL})); /* live confidence follows this BUY/SELL from its first reading */
    renderGoldAnalysis();updateGoldQuoteDisplay();
    if(status)status.textContent=(d.data_ok===false?'CHECK DATA · ':'LIVE ANALYSIS · ')+(d.data_source||'');
  }catch(e){
    state.goldAnalysis=null;goldRuns.forget(GOLD_SYMBOL);goldAnalysisAt=Date.now();goldAnalysisError=String(e&&e.message||e||'Live analysis unavailable');
    if(goldDataSource()==='mt5')goldMt5Quote=null;
    if(status)status.textContent='ANALYSIS UNAVAILABLE';
    const r=$('#goldRationale');if(r)r.textContent=goldAnalysisError+' No old signal is being presented as current.';
    const v=$('#goldVotes');if(v)v.textContent='No current verified timeframe votes.';
    const p=$('#goldPressure');if(p)p.textContent='Buyer/seller pressure unavailable without fresh timeframe data.';
    const risks=$('#goldRisks');if(risks)risks.innerHTML='';
    const b=$('#goldSignalBadge');if(b){b.textContent='UNAVAILABLE';b.className='badge gray';}
    const s=$('#goldSignal');if(s){s.textContent='—';s.className='faint';}
    ['goldEntry','goldSL','goldTP1','goldTP2'].forEach(id=>{const e2=$('#'+id);if(e2)e2.textContent='—';});
    updateGoldQuoteDisplay();
  }finally{
    goldAnalysisBusy=false;if(btn)btn.disabled=false;
    goldNextAttemptAt=state.settings.goldAuto!==false?Date.now()+GOLD_REFRESH_MS:0;
    /* A reading changes only at a 5-minute close: look again seconds after the next one, so it is shown while its entry is still the price. */
    if(goldNextAttemptAt)goldNextAttemptAt=nextReadingCheck(Date.now(),GOLD_REFRESH_MS);
    updateGoldAnalysisNotice();
  }
}
function startGoldMonitor(){
  if(goldMonitorTimer)return;
  refreshGoldNews();refreshGoldQuote();
  goldMonitorTimer=setInterval(()=>{
    updateGoldEventCountdowns();
    if(Date.now()-goldNewsAt>5*60000)refreshGoldNews();
    if(state.settings.goldAuto!==false&&!goldAnalysisBusy&&goldNextAttemptAt&&Date.now()>=goldNextAttemptAt)runGoldAnalysis();
    updateGoldAnalysisNotice();
    if(state.view==='gold'&&Date.now()-Number(goldQuotePollAt||0)>10000){goldQuotePollAt=Date.now();refreshGoldQuote();}
    else if(state.view==='gold')updateGoldQuoteDisplay();
  },10000);
}
function renderGold(){
  const src=$('#goldSourceSelect');if(src){src.value=state.settings.goldSource||'auto';src.onchange=()=>{
    const next=['auto','deriv','mt5'].includes(src.value)?src.value:'auto';state.settings.goldSource=next;save();
    state.goldAnalysis=null;goldRuns.forget(GOLD_SYMBOL);goldAnalysisAt=0;goldNextAttemptAt=0;goldAnalysisError='';goldMt5Quote=null;
    const badge=$('#goldSignalBadge');if(badge){badge.textContent='ANALYZING';badge.className='badge gray';}
    const sig=$('#goldSignal');if(sig){sig.textContent='—';sig.className='faint';}
    ['goldEntry','goldSL','goldTP1','goldTP2'].forEach(id=>{const el=$('#'+id);if(el)el.textContent='—';});
    const votes=$('#goldVotes');if(votes)votes.textContent='Fetching fresh M1 / M5 / H1 data from the selected source.';
    const rationale=$('#goldRationale');if(rationale)rationale.textContent='Source changed explicitly; waiting for fresh verified candles.';
    const status=$('#goldFeedStatus');if(status)status.textContent='SOURCE CHANGED · refreshing';
    updateGoldQuoteDisplay();updateGoldAnalysisNotice();runGoldAnalysis();
  };}
  const auto=$('#goldAuto');if(auto){auto.checked=state.settings.goldAuto!==false;auto.onchange=()=>{state.settings.goldAuto=auto.checked;save();goldNextAttemptAt=0;if(auto.checked)runGoldAnalysis();else updateGoldAnalysisNotice();};}
  const connectGold=$('#goldConnectBtn');if(connectGold)connectGold.onclick=openGoldExnessConnect;
  const btn=$('#goldAnalyzeBtn');if(btn)btn.onclick=()=>runGoldAnalysis();
  const shareBtn=$('#goldShareBtn');if(shareBtn)shareBtn.onclick=()=>{if(!state.goldAnalysis){toast('No current Gold signal','Wait for a fresh analysis before sharing.','warn');return;}const u=waLink(goldSignalMessage(state.goldAnalysis));if(u)window.open(u,'_blank','noopener');};
  const newsBtn=$('#goldNewsRefresh');if(newsBtn)newsBtn.onclick=()=>refreshGoldNews(true);
  const notifyBtn=$('#goldNotifyBtn');if(notifyBtn)notifyBtn.onclick=async()=>{const p=await enableNotifications();toast('Gold alerts',p==='granted'?'Browser alerts enabled.':'Browser notifications '+p+'; in-app alerts remain available while AURUM is open.','ok');};
  startGoldMonitor();
  if(!goldAnalysisBusy&&(!goldAnalysisAt||Date.now()-goldAnalysisAt>=GOLD_REFRESH_MS))runGoldAnalysis();
  updateGoldQuoteDisplay();updateGoldAnalysisNotice();renderGoldAnalysis();renderGoldEvents();renderGoldHeadlines();
}
let goldQuotePollAt=0;

/* ================= News: which markets, what their prices say, when to stand aside =================
   A headline names markets; it does not say which way they will go. The Buy / Sell / Wait beside a
   market is that market's own price reading (the one the Markets view shows), and the period around a
   high-impact release is one in which no new trade is opened (src/newsimpact.js). */
const NEWS_READING_NOTE='The Buy, Sell or Wait beside a market is that market’s own price reading at this moment (the 1m/5m/1h rule; for an index, the daily reading). It is not a forecast of what the news will do to the price: a headline does not tell the direction.';
const NEWS_CHIPS=4;
const safeHref=(link)=>/^https?:\/\//i.test(String(link||''))?String(link):'#';
/* What the price reading of one market says now, as a badge. kind: trade (Buy or Sell), wait, none. */
function readingChip(sym){
  const r=state.mktScan[sym];
  if(!r)return {kind:'none',html:'<span class="badge gray" title="No reading of this market has been made yet.">no reading yet</span>'};
  if(r.error)return {kind:'none',html:'<span class="badge gray" title="'+escHtml(r.detail||'No reading is available for this market right now.')+'">no reading</span>'};
  const daily=isDailyReading(r);
  const tip=escHtml((daily?'Daily reading from daily closing prices. ':'Reading of the 1m/5m/1h rule'+(closeText(r)?' at the '+closeText(r)+' candle close. ':'. '))+(r.votes?'Timeframes: '+r.votes+'. ':'')+'The percentage is how strongly the timeframes agree, not a chance of profit.');
  if(isDirectionalCandidate(r)&&!isAsterPublishable(r))return {kind:'wait',html:'<span class="badge gray" title="Technical candidate withheld until ASTER approves publication.">ASTER blocked</span>'};
  if((r.bias==='bullish'||r.bias==='bearish')&&!isAsterPublishable(r))return {kind:'wait',html:'<span class="badge gray" title="Directional bias withheld until ASTER validates the evidence.">ASTER pending</span>'};
  if(r.signal==='BUY'||r.signal==='SELL')return {kind:'trade',html:'<span class="badge '+(r.signal==='BUY'?'buy':'sell')+'" title="'+tip+'">'+(r.signal==='BUY'?'Buy ':'Sell ')+liveScoreHtml(r,'span')+(daily?' · daily':'')+'</span>'};
  if(r.bias==='bullish')return {kind:'wait',html:'<span class="badge lean lean-up" title="'+tip+'">Wait · leans up</span>'};
  if(r.bias==='bearish')return {kind:'wait',html:'<span class="badge lean lean-dn" title="'+tip+'">Wait · leans down</span>'};
  return {kind:'wait',html:'<span class="badge wait" title="'+tip+'">Wait</span>'};
}
/* The markets a headline or a release concerns, each with its reading. First the markets the headline points at
   by name (`named`) and the market that is on the chart, then the Buy and Sell readings among the rest; what
   does not fit is counted. */
function newsMarketsHtml(markets,named){
  if(!markets.length)return '<span class="faint">no market of this application</span>';
  const rank={trade:0,wait:1,none:2}, first=(named||[]).concat(state.chart&&state.chart.sym?[state.chart.sym]:[]);
  const rows=markets.map((sym,i)=>({sym,i,named:first.includes(sym)?0:1,chip:readingChip(sym)})).sort((a,b)=>a.named-b.named||(a.named?rank[a.chip.kind]-rank[b.chip.kind]:0)||a.i-b.i);
  const shown=rows.slice(0,NEWS_CHIPS), rest=rows.slice(NEWS_CHIPS);
  const count=(kind)=>rest.filter(x=>x.chip.kind===kind).length;
  const restText=[count('trade')?count('trade')+' with a Buy or Sell':'',count('wait')?count('wait')+' on Wait':'',count('none')?count('none')+' without a reading':''].filter(Boolean).join(', ');
  return shown.map(x=>'<span class="news-mkt"><a href="#" data-news-open="'+escHtml(x.sym)+'" title="Open the '+escHtml(x.sym)+' chart">'+escHtml(x.sym)+'</a> '+x.chip.html+'</span>').join(' ')
    +(rest.length?' <span class="faint" title="'+escHtml(rest.map(x=>x.sym).join(', '))+'">+ '+rest.length+' more ('+restText+')</span>':'');
}
function newsMarketsBox(markets,named){ return '<span data-news-markets="'+escHtml(markets.join(','))+'" data-news-named="'+escHtml((named||[]).join(','))+'">'+newsMarketsHtml(markets,named)+'</span>'; }
/* After a scan the readings beside headlines and releases are redrawn; the feeds are not read again. */
function paintNewsReadings(){ const list=(text)=>text?text.split(','):[]; $$('#view-news [data-news-markets]').forEach(el=>{ el.innerHTML=newsMarketsHtml(list(el.dataset.newsMarkets),list(el.dataset.newsNamed)); }); }
function headlineConcernHtml(title){
  const c=headlineConcerns(title);
  if(!c.subjects.length)return '<div class="tiny faint news-concern">Names no market of this application.</div>';
  const why=c.subjects.filter(s=>s.explain).map(s=>s.why);
  return '<div class="tiny news-concern"><span class="faint">Concerns</span> '+c.subjects.map(s=>'<b title="'+escHtml(s.why)+'">'+escHtml(s.label)+'</b>').join(', ')
    +(c.markets.length?' <span class="faint">→</span> '+newsMarketsBox(c.markets,c.named):'')+(why.length?'<div class="faint">'+escHtml(why.join('. '))+'.</div>':'')+'</div>';
}
function newsSourcesHtml(j){
  if(!Array.isArray(j.sources)||!j.sources.length)return '';
  return '<div class="hint tiny" id="newsSources">Sources: '+j.sources.map(s=>escHtml(s.name)+' — '+(s.ok?(Number(s.headlines)===1?'1 headline':escHtml(String(s.headlines))+' headlines'):'not available ('+escHtml(String(s.error||'no answer'))+')')).join(' · ')
    +(j.fetched_at?' · read at '+escHtml(eatStamp(Number(j.fetched_at),Date.now())):'')+'</div>';
}
/* News signal validity: a headline is a SNIPER entry — its edge decays fast.
   Transparent rule (no fake precision): a directional news signal is actionable
   for 25 minutes from publish; after that it is STALE and the Execute button
   stands down until the next headline. Unknown publish time -> honest
   'freshness unknown' (never a made-up countdown). */
const NEWS_VALIDITY_MIN=25;
function newsValidity(it){
  if(!it||!it.t)return { unknown:true, label:'⏱ freshness unknown', stale:false };
  const ageMin=Math.max(0,(Date.now()-it.t)/60000);
  const leftMin=Math.max(0,NEWS_VALIDITY_MIN-ageMin);
  return { unknown:false, ageMin, leftMin, stale:leftMin<=0,
    label: leftMin>0?('⏱ valid ~'+Math.ceil(leftMin)+'m left'):('⏱ STALE ('+Math.floor(ageMin)+'m old)') };
}
function updateNewsValidity(){
  $$('#newsFeed [data-nv]').forEach(el=>{
    const it=state.newsItems[Number(el.dataset.nv)]; if(!it)return;
    const v=newsValidity(it);
    if(el.textContent!==v.label)el.textContent=v.label;
    el.className='badge tiny '+(v.unknown?'gray':(v.stale?'sell':(v.leftMin<=10?'neutral':'buy')));
    el.style.color=(v.stale)?'var(--amber)':'';
    el.title=v.unknown?'Publish time not provided by the source — treat news edges as short-lived.'
      :(v.stale?'Published '+Math.floor(v.ageMin)+'m ago — the news edge has likely played out. Wait for the next headline.'
      :'News edges decay fast: enter inside this window and pair with short contracts (≤15m).');
    const ex=$('#newsFeed .news-exec[data-i="'+el.dataset.nv+'"]');
    if(ex){ ex.disabled=v.stale; ex.title=v.stale?'Signal stale — Execute stands down until the next headline.':ex.title; }
  });
}
function newsSignalText(it){
  const b=it.bias||{};
  if(!b.dir){ /* a headline without a direction is a headline, not a trading signal */
    const c=headlineConcerns(it.title);
    return '📰 '+brandName()+' — headline\n'
      +'Headline: '+it.title+'\n'
      +(it.source?'Source: '+it.source+'\n':'')
      +'Concerns: '+(c.markets.length?c.markets.join(', '):'no market of this application')+'\n'
      +'Link: '+it.link+'\n'
      +'A headline does not tell the direction. Not advice.';
  }
  return '🚨 '+brandName()+' trading signal\n'
    +(b.pair||b.ccy||'?')+' — '+(b.dir?b.dir+' (heuristic news read)':'no direction (no confident tone)')+'\n'
    +'Headline: '+it.title+'\n'
    +(it.source?'Source: '+it.source+'\n':'')
    +(it.t&&!newsValidity(it).stale?'Valid window: ~'+Math.ceil(newsValidity(it).leftMin)+' min (news edges decay fast — sniper entry, short contracts)\n':'')
    +(it.t&&newsValidity(it).stale?'⚠ Signal is STALE (published '+Math.floor(newsValidity(it).ageMin)+'m ago) — wait for a fresh headline.\n':'')
    +'Link: '+it.link+'\n'
    +'Heuristic — not AI, not advice. Verify before trading.';
}
function executeNewsSignal(it){
  if(guardStopIfTripped())return;
  const b=it.bias||{};
  if(!b.pair||!b.dir){ toast('Not orderable','This headline has no orderable market direction.','warn'); return; }
  const v=newsValidity(it);
  if(v.stale){ toast('Signal stale','Published '+Math.floor(v.ageMin)+'m ago — outside the '+NEWS_VALIDITY_MIN+'m news window. Sniper entries only count inside it; wait for the next headline.','warn'); return; }
  const I=INSTRUMENT_MAP[b.pair];
  if(!I){ toast('Analysis only',b.pair+' is not orderable through Deriv — open its TradingView chart from the Watchlist.','warn'); return; }
  const dh=state.derivHealth;
  const proxyReady=!!(dh&&dh.authorized&&dh.tradingEnabled);
  const amt=Math.max(1,Number(atCfg().stake)||10);
  state.side=b.dir; syncSide();
  if(proxyReady||state.broker?.type==='deriv'){
    const mode=proxyReady?'proxy':(state.broker.mode==='pat_server'?'pat_server':'pat');
    openTradeModal({mode,I,amt,sl:null,tp:null,tp2:null,px:(bySym[b.pair]&&bySym[b.pair].p)||null,dur:derivDurationFor(b.pair)});
    return;
  }
  setChartSymbol(b.pair); goto('trade');
  toast('Ticket ready',b.dir+' '+b.pair+' preset — the MT5 bridge path confirms inside Chart & Trade.','ok');
}
async function shareCalBrief(){
  try{
    const r=await api('/api/news/calendar');
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!Array.isArray(j.events))throw new Error('calendar unavailable'); /* never share "no events" for a calendar that did not load */
    const ev=(j.events||[]).filter(e2=>e2.impact==='High'||e2.impact==='Medium').slice(0,8);
    const line=(e2)=>{
      const t=eventTime(e2,j.day);
      const aside=e2.impact==='High'&&t!=null?' — no new trade '+eatClock(t-STAND_ASIDE.beforeMin*60000)+'–'+eatClock(t+STAND_ASIDE.afterMin*60000):'';
      return (t!=null?eatClock(t)+' EAT':'all day')+' '+e2.impact.toUpperCase()+' · '+e2.country+' '+e2.event+aside;
    };
    let txt='📅 '+brandName()+' — today, Nairobi time (EAT)\n';
    txt+=ev.length?ev.map(line).join('\n'):'No high/medium events listed today.';
    const sig=(state.newsItems||[]).filter(it=>it.bias&&it.bias.dir).slice(0,5);
    if(sig.length)txt+='\n\nNews signals (heuristic):\n'+sig.map(it=>'• '+(it.bias.pair||it.bias.ccy)+' '+it.bias.dir+' — '+it.title).join('\n');
    txt+='\n\nA release can move a market either way: the calendar gives no direction. Not advice.';
    const u=waLink(txt); if(u)window.open(u,'_blank','noopener');
  }catch(e){ toast('Calendar unavailable','Nothing to share yet — refresh the calendar first.','warn'); }
}
function biasChip(b){
  if(!b||!b.dir)return '<span class="badge gray" title="No confident keyword tone — no direction is invented.">—</span>';
  const cls=b.dir==='BUY'?'buy':'sell';
  return '<span class="badge '+cls+'" title="Keyword heuristic ('+escHtml(b.ccy)+' '+(b.tone==='up'?'positive':'negative')+') — not AI, not advice. Add an AI key in Settings for real AI calls.">'+b.dir+' '+escHtml(b.pair||b.ccy)+' · heuristic</span>';
}
async function renderNewsFeed(){
  const el=$('#newsFeed'); if(!el)return;
  try{
    const r=await api('/api/news/feed');
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.detail||j.error||('HTTP '+r.status));
    state.newsItems=j.items||[];
    const now=Date.now();
    /* The PC server adds a keyword chip to a headline; the cloud sends headlines only. The chip column and the
       order button exist only where the server supplied them. */
    const anyBias=state.newsItems.some(it=>it.bias);
    const anyOrderable=state.newsItems.some(it=>it.bias&&it.bias.pair&&it.bias.dir&&!!INSTRUMENT_MAP[it.bias.pair]);
    el.innerHTML=newsSourcesHtml(j)+'<div class="tbl-wrap"><table class="tbl news-tbl"><tbody>'
      +state.newsItems.map((it,idx)=>{
        const b=it.bias||{};
        const orderable=b.pair&&b.dir&&!!INSTRUMENT_MAP[b.pair];
        const when=it.t?eatStamp(Number(it.t),now):(it.published||'');
        return '<tr>'+(anyBias?'<td>'+biasChip(it.bias)+'</td>':'')
          +'<td><a href="'+escHtml(safeHref(it.link))+'" target="_blank" rel="noopener">'+escHtml(it.title)+'</a><div class="hint tiny">'+escHtml(it.source||'')+(when?' · '+escHtml(when):'')+'</div>'+headlineConcernHtml(it.title)+'</td>'
          +'<td class="num nowrap">'
          +(orderable?'<span class="badge tiny gray" data-nv="'+idx+'" style="margin-right:6px">⏱ …</span>':'')
          +(orderable?'<button class="btn sm primary news-exec" data-i="'+idx+'" title="One click opens the confirm sheet — deduction happens on your linked account after you confirm">⚡ Execute</button> ':'')
          +'<button class="btn sm ghost news-wa" data-i="'+idx+'" title="Share this headline to WhatsApp">↗ WA</button> '
          +'<a class="btn sm ghost" href="'+escHtml(safeHref(it.link))+'" target="_blank" rel="noopener">Open ↗</a></td></tr>';
      }).join('')
      +'</tbody></table></div><div class="hint tiny">'+escHtml(j.note||'')+' '+escHtml(NEWS_READING_NOTE)
      +(anyOrderable?' ⚡ opens the confirm sheet on the linked account — nothing executes without your confirm. Each directional signal shows its validity window: news is a sniper entry — it counts for ~'+NEWS_VALIDITY_MIN+' minutes from publish, then goes STALE and Execute stands down. Pair news entries with short contracts (≤15m).':'')+'</div>';
    updateNewsValidity();
    $$('#newsFeed .news-exec').forEach(btn=>btn.onclick=()=>executeNewsSignal(state.newsItems[Number(btn.dataset.i)]||{}));
    /* AUTO: push new directional signals (skipped when the server timer already auto-shares) */
    if(state.settings.waAuto!==false){
      waServerStatus().then((st)=>{
        if(st.auto)return; /* server timer owns the feed pushes */
        let seen=[]; try{ seen=JSON.parse(localStorage.getItem('aurum_wa_seen')||'[]'); }catch(e){}
        const has=(l)=>seen.indexOf(l)>=0;
        let n=0;
        (j.items||[]).forEach((it)=>{
          if(n>=3||!it.bias||!it.bias.dir||has(it.link))return;
          seen.push(it.link); n++;
          pushWA(newsSignalText(it));
        });
        try{ localStorage.setItem('aurum_wa_seen',JSON.stringify(seen.slice(-100))); }catch(e){}
      });
    }
    $$('#newsFeed .news-wa').forEach(btn=>btn.onclick=()=>{ const u=waLink(newsSignalText(state.newsItems[Number(btn.dataset.i)]||{})); if(u)window.open(u,'_blank','noopener'); });
  }catch(e){
    el.innerHTML='<div class="empty"><b>Headline feed unavailable</b>'+escHtml(String(e.message||e))+' The TradingView timeline below is independent and may still work — no substitute headlines are invented.</div>';
  }
}
/* The calendar is read once for the whole page (News view, the line above the chart): at most every ten
   minutes unless asked. A failure is remembered, so that nothing reads "no releases" from a calendar
   that did not load. */
let calendarPending=null;
/* The cloud reads its calendar source every half hour and this page asks the cloud every ten minutes: a copy
   older than 45 minutes means the source has stopped answering, and the calendar card says so. */
const CALENDAR_COPY_NOTE_MS=45*60000;
/* A calendar that was read is kept ten minutes; after a read that failed, the next try comes after one. */
function calendarDue(){ return !calendarPending&&(!state.calAt||Date.now()-state.calAt>=(state.calError?60000:10*60000)); }
function loadCalendar(force){
  if(calendarPending)return calendarPending;
  if(!force&&!calendarDue())return Promise.resolve();
  calendarPending=(async()=>{
    try{
      const r=await api('/api/news/calendar');
      const j=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(j.detail||j.error||('HTTP '+r.status));
      state.calDay=j.day||new Date().toISOString().slice(0,10);
      state.calSource=j.source||'ForexFactory public weekly calendar';
      state.calEvents=j.events||[];
      state.calWeek=Array.isArray(j.week)?j.week:null;
      state.calFetched=Number(j.fetched_at)>0?Number(j.fetched_at):null; /* when the source was read: the cloud passes on an earlier copy while the source does not answer */
      state.calError='';
    }catch(e){ state.calError=String((e&&e.message)||e)||'Calendar unavailable'; }
    finally{ state.calAt=Date.now(); calendarPending=null; }
  })();
  return calendarPending;
}
/* Every calendar entry with its moment as `t` (null: all day). null while the calendar has not loaded: unknown, not empty. */
function calendarEntries(){
  if(!state.calAt||state.calError)return null;
  return (state.calWeek||state.calEvents||[]).map((e)=>Object.assign({},e,{t:eventTime(e,state.calDay)}));
}
async function renderNewsCal(){
  if(!$('#newsCal'))return;
  await loadCalendar(true);
  paintNewsCal();
}
/* The calendar card from what was read last: the timeline, or the reason there is none. */
function paintNewsCal(){
  const el=$('#newsCal'); if(!el)return;
  if(state.calError){
    el.innerHTML='<div class="empty"><b>Calendar unavailable</b>'+escHtml(state.calError)+' The TradingView calendar below is independent and may still work. Scheduled releases are unknown until the calendar loads: nothing here says there are none.</div>';
    return;
  }
  renderNewsTimeline();
}
/* timeline buckets: UPCOMING / JUST RELEASED (last 15 min = current news) /
   PAST 2 HOURS. Exact epoch from the calendar's date + HH:MM UTC. */
function newsEvT(e){ return eventTime(e,state.calDay); }
function newsBucket(t){
  const now=Date.now();
  if(t>now)return 'up';
  if(now-t<=15*60000)return 'now';
  return 'past';
}
function newsTLabel(t){
  const s=Math.round((t-Date.now())/1000);
  if(s>0)return 'in '+(s>=3600?(Math.floor(s/3600)+'h '+Math.round((s%3600)/60)+'m'):(s>=60?Math.ceil(s/60)+'m':s+'s'));
  const age=-s;
  if(age<=15*60)return 'released '+Math.max(0,Math.floor(age/60))+'m ago';
  return (age>=3600?(Math.floor(age/3600)+'h '+(Math.round((age%3600)/60)||0)+'m'):Math.max(1,Math.floor(age/60))+'m')+' ago';
}
function newsChip(v){ return v==='High'?'<span class="badge sell">High</span>':v==='Medium'?'<span class="badge" style="background:#e5b56722;color:#e5b567">Medium</span>':'<span class="badge gray">Low</span>'; }
/* "No new trade 16:00–17:00 EAT" for a high-impact release, and where the clock stands in that period. */
function standAsideLine(t,now){
  const s=standAside(t,now);
  const span=eatClock(s.from)+'–'+eatClock(s.until)+' EAT';
  if(s.phase==='ahead')return {on:false,text:'No new trade '+span+' (30 min before to 30 min after)'};
  if(s.phase==='before')return {on:true,text:'STAND ASIDE NOW · release in '+s.minutes+' min · no new trade until '+eatClock(s.until)+' EAT'};
  if(s.phase==='after')return {on:true,text:'STAND ASIDE · released · no new trade for another '+s.minutes+' min, until '+eatClock(s.until)+' EAT'};
  return {on:false,text:'Stand-aside period over since '+eatClock(s.until)+' EAT'};
}
/* The box above the calendar: per currency, the period that is running now or the next one within three hours. */
function newsAsideHtml(entries,now){
  const lines=[];
  for(const ccy of ['USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD']){
    const x=exposureForCurrency(ccy,entries,now,{aheadMin:180});
    if(!x)continue;
    const names=x.events.slice(0,3).map(e=>e.event).join(', ')+(x.events.length>3?' and '+(x.events.length-3)+' more':'');
    lines.push({on:x.phase==='aside',from:x.from,html:'<div class="news-aside-line'+(x.phase==='aside'?' on':'')+'"><b>'+(x.phase==='aside'?'Stand aside now':'Next')+' · '+ccy+'</b> — '+escHtml(names)+' at '+escHtml(eatStamp(x.t,now))
      +'. No new trade in '+ccy+' markets '+(x.phase==='aside'?'until '+eatClock(x.until)+' EAT':'from '+eatClock(x.from)+' to '+eatClock(x.until)+' EAT')+' <span class="faint">('+escHtml(marketsForCurrency(ccy).join(', '))+')</span></div>'});
  }
  lines.sort((a,b)=>(Number(b.on)-Number(a.on))||(a.from-b.from));
  return lines.length?lines.map(l=>l.html).join(''):'<div class="news-aside-line">No high-impact release is listed for the next 3 hours. Unscheduled news is in no calendar.</div>';
}
function renderNewsTimeline(){
  const el=$('#newsCal'); if(!el)return;
  const all=calendarEntries()||[];
  const now=Date.now();
  const dayEnd=eatDayBounds(now)[1];
  const timed=all.filter((e)=>e.t!=null);
  const allday=all.filter((e)=>e.t==null&&(!e.day||e.day===eatDay(now)));
  const cur=timed.filter((e)=>newsBucket(e.t)==='now').sort((a,b)=>b.t-a.t);
  const up=timed.filter((e)=>newsBucket(e.t)==='up'&&e.t<dayEnd).sort((a,b)=>a.t-b.t);
  const past=timed.filter((e)=>newsBucket(e.t)==='past'&&now-e.t<=2*3600000).sort((a,b)=>b.t-a.t);
  const tomorrow=timed.filter((e)=>e.t>=dayEnd&&e.t<dayEnd+86400000&&e.impact==='High').sort((a,b)=>a.t-b.t);
  const row=(e)=>{
    const major=e.impact==='High'||e.impact==='Medium';
    const c=major?eventConcerns(e):null;
    const aside=e.impact==='High'&&e.t!=null?standAsideLine(e.t,now):null;
    /* The markets and the stand-aside period go on a line of their own under the release, across the whole
       width, so that they wrap on a phone instead of running out of sight. */
    const detail=(c?'<div class="tiny news-concern">'+(c.markets.length?'<span class="faint">'+escHtml(c.currency)+' markets</span> '+newsMarketsBox(c.markets):'<span class="faint">no market of this application is priced in '+escHtml(e.country||'this currency')+'</span>')+'</div>':'')
      +(aside&&c&&c.markets.length?'<div class="tiny news-aside'+(aside.on?' on':'')+'" data-sa="'+e.t+'">'+escHtml(aside.text)+'</div>':'');
    return '<tr'+(detail?' class="news-main"':'')+'><td class="mono tiny nowrap"'+(e.t!=null?' title="'+escHtml(new Date(e.t).toISOString().slice(0,16).replace('T',' ')+' UTC')+'"':'')+'>'+(e.t!=null?escHtml(eatStamp(e.t,now)):'all day')+'</td>'
    +'<td class="tiny nowrap">'+escHtml(e.country||'')+'</td>'
    +'<td class="tiny">'+escHtml(e.event||'')+(e.forecast?' <span class="tiny faint">f: '+escHtml(e.forecast)+(e.previous?' · p: '+escHtml(e.previous):'')+'</span>':'')+'</td>'
    +'<td class="nowrap">'+newsChip(e.impact)+'</td>'
    +'<td class="nowrap">'+(e.t!=null?'<span class="badge tiny gray" data-nt="'+e.t+'" data-b="'+newsBucket(e.t)+'">'+escHtml(newsTLabel(e.t))+'</span>':'<span class="badge tiny gray">all day</span>')+'</td></tr>'
    +(detail?'<tr class="news-sub"><td colspan="5">'+detail+'</td></tr>':'');
  };
  const sec=(title,arr)=>'<div class="tiny faint" style="margin:12px 0 4px"><b>'+title+'</b></div>'
    +(arr.length?'<div class="tbl-wrap"><table class="tbl news-tbl"><tbody>'+arr.map(row).join('')+'</tbody></table></div>':'<div class="hint tiny">— none —</div>');
  el.innerHTML='<div class="news-aside-box" id="newsAside">'+newsAsideHtml(all,now)+'</div>'
    +sec('🔴 JUST RELEASED — current news (last 15 min)',cur)
    +sec('⏭ UPCOMING TODAY — exact times, live countdown',up)
    +sec('🕘 PAST 2 HOURS',past)
    +(state.calWeek?sec('🗓 TOMORROW — high impact only',tomorrow):'')
    +(allday.length?sec('📅 ALL-DAY / UNSCHEDULED',allday):'')
    +'<div class="hint tiny">Source: '+escHtml(state.calSource||'')+(state.calFetched?' · read at '+escHtml(eatStamp(state.calFetched,Date.now()))+(Date.now()-state.calFetched>CALENDAR_COPY_NOTE_MS?' (the source has not answered since: this is the schedule as it stood then)':''):'')+' · times are Nairobi time (EAT, UTC+3); point at a time for UTC · countdowns update live. Around a high-impact release no new trade is opened from '
    +STAND_ASIDE.beforeMin+' minutes before until '+STAND_ASIDE.afterMin+' minutes after, in the markets priced in its currency. '+escHtml(releaseMeasuredText())
    +' The calendar gives the forecast and the previous figure, not the result: which way a release moves a market is not shown, because it is not known.</div>';
  updateNewsTimeline();
}
function updateNewsTimeline(){
  let need=false;
  const now=Date.now();
  $$('#newsCal [data-nt]').forEach((el)=>{
    const t=Number(el.dataset.nt); const b=newsBucket(t);
    if(b!==el.dataset.b){ need=true; return; } /* crossed a boundary -> re-section */
    const txt=newsTLabel(t);
    if(el.textContent!==txt)el.textContent=txt;
    el.className='badge tiny '+(b==='now'?'sell':b==='up'?'buy':'gray');
  });
  if(need){ renderNewsTimeline(); return; }
  $$('#newsCal [data-sa]').forEach((el)=>{
    const s=standAsideLine(Number(el.dataset.sa),now);
    if(el.textContent!==s.text)el.textContent=s.text;
    el.classList.toggle('on',s.on);
  });
  const box=$('#newsAside');
  if(box){ const html=newsAsideHtml(calendarEntries()||[],now); if(box.dataset.h!==html){ box.innerHTML=html; box.dataset.h=html; } }
}

/* ================= Watchlist page =================
   Separate view. Live instruments: REAL streaming Deriv ticks on canvas.
   Indices (not on Deriv — probe-verified): TradingView tiles, labelled delayed. */
function renderWatch(){
  renderWatchChips();
  try{ mktScanRefresh(); }catch(e){}
  const liveIds=state.watchlist.filter(w=>INSTRUMENT_MAP[w.id]);
  const idx=state.watchlist.filter(w=>!INSTRUMENT_MAP[w.id]);
  const lw=$('#watchLiveWrap'), tw=$('#watchTvWrap'), empty=$('#watchEmpty');
  if(empty)empty.classList.toggle('hidden',state.watchlist.length>0);
  if(lw)lw.classList.toggle('hidden',!liveIds.length);
  if(tw)tw.classList.toggle('hidden',!idx.length);
  const lg=$('#watchLiveGrid');
  if(lg){
    lg.innerHTML=liveIds.map((w)=>{
      const I=INSTRUMENT_MAP[w.id];
      const lbl=I.c==='indices'?(state.broker&&state.broker.type==='mt5'?'● Exness live · bridge':'● Exness — connect bridge'):'● Deriv live';
      return '<div class="watch-tile"><div class="watch-tile-head" title="Open the full chart"><b>'+I.s+'</b><span class="watch-tile-name">'+lbl+'</span></div>'
        +'<div class="row between" style="padding:6px 10px 0"><span class="mono" data-wpx="'+I.s+'">'+fmtPx(I.p,I.d)+'</span><span class="mono tiny" data-wch="'+I.s+'">'+fmtPct(chgOf(I),true)+'</span></div>'
        +'<div class="watch-tile-body"><canvas class="watchCanvas" data-wcv="'+I.s+'" height="120" style="width:100%;height:120px;display:block"></canvas></div>'
        +'<div class="row" style="gap:6px;padding:8px 10px">'
        +'<button class="btn sm primary watch-trade" data-sym="'+I.s+'">Trade</button>'
        +'<button class="btn sm ghost watch-del" data-id="'+I.s+'">Remove</button></div></div>';
    }).join('');
    $$('#watchLiveGrid .watch-trade').forEach(b=>b.onclick=()=>{ setChartSymbol(b.dataset.sym); goto('trade'); });
    $$('#watchLiveGrid .watch-del').forEach(b=>b.onclick=()=>{ state.watchlist=state.watchlist.filter(w=>w.id!==b.dataset.id); saveWatchlist(); });
  }
  if(idx.length)tv.mountWatchlist($('#watchWidget'),idx);
  renderWatchLive();
}
function renderWatchLive(){
  $$('#watchLiveGrid .watchCanvas').forEach((cv)=>{
    const I=bySym[cv.dataset.wcv]; if(!I)return;
    const h=(I.hist||[]).slice(-60);
    const dpr=window.devicePixelRatio||1,W=cv.clientWidth||260,H=120;
    cv.width=W*dpr; cv.height=H*dpr;
    const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr); ctx.clearRect(0,0,W,H);
    if(h.length<2){ ctx.fillStyle='#8b93a3'; ctx.font='11px system-ui'; ctx.fillText(I.c==='indices'?'waiting for Exness bridge quotes…':'building live chart from streamed ticks…',10,H/2); }
    else{
      const mn=Math.min.apply(null,h),mx=Math.max.apply(null,h),rg=(mx-mn)||1;
      ctx.beginPath();
      h.forEach((v,i)=>{ const x=2+(i/(h.length-1))*(W-4),y=6+(1-(v-mn)/rg)*(H-12); if(i)ctx.lineTo(x,y); else ctx.moveTo(x,y); });
      const up=h[h.length-1]>=h[0];
      ctx.strokeStyle=up?'#2fbf71':'#e5484d'; ctx.lineWidth=1.6; ctx.stroke();
      /* live signal levels: entry (gold) / SL (red) / TP1+TP2 (green) from the scan */
      const sr=state.mktScan[cv.dataset.wcv];
      if(sr&&!sr.error&&isAsterPublishable(sr)){
        const yFor=(v)=>6+(1-(v-mn)/rg)*(H-12);
        const inR=(v)=>v!=null&&Number.isFinite(Number(v))&&v>mn-0.6*rg&&v<mx+0.6*rg;
        const line=(v,color,label)=>{
          if(!inR(v))return;
          ctx.save(); ctx.strokeStyle=color; ctx.setLineDash([3,2]); ctx.lineWidth=1;
          ctx.beginPath(); ctx.moveTo(2,yFor(v)); ctx.lineTo(W-2,yFor(v)); ctx.stroke();
          ctx.setLineDash([]); ctx.fillStyle=color; ctx.font='8px system-ui';
          ctx.fillText(label,4,Math.max(8,yFor(v)-2)); ctx.restore();
        };
        const conf=sr.signal==='BUY'||sr.signal==='SELL';
        const tag=(l)=>conf?l:(l+'?');
        if(inR(sr.entry))line(Number(sr.entry),'#e0b45c',tag('E'));
        if(inR(sr.stop_loss))line(Number(sr.stop_loss),'#e5484d',tag('SL'));
        if(inR(sr.tp1))line(Number(sr.tp1),'#2fbf71',tag('TP1'));
        if(inR(sr.tp2))line(Number(sr.tp2),'#2fbf71',tag('TP2'));
      }
      ctx.lineTo(W-2,H); ctx.lineTo(2,H); ctx.closePath();
      const g2=ctx.createLinearGradient(0,0,0,H);
      g2.addColorStop(0,up?'rgba(47,191,113,.20)':'rgba(229,72,77,.20)'); g2.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=g2; ctx.fill();
    }
    const pxEl=document.querySelector('[data-wpx="'+I.s+'"]'); if(pxEl)pxEl.textContent=fmtPx(I.p,I.d);
    const chEl=document.querySelector('[data-wch="'+I.s+'"]'); if(chEl){ const ch=chgOf(I); chEl.textContent=fmtPct(ch,true); chEl.className='mono tiny '+(ch==null?'':(ch>=0?'up':'down')); }
  });
}

/* ================================================================
   MARKET STATE: trend, structure and volatility on four timeframes.
   A description, computed in src/marketstate.js from finished candles. It
   takes no part in a signal, an alert or an order, and nothing here reads
   or changes the readings of the signal pages.
   ================================================================ */
const MS_SHOWN=[...STATE_TIMEFRAMES].reverse(); /* the larger picture first */
/* After a look that came just too early for the feed, the next one follows this soon. */
const MS_RETRY_MS=30000;
const msView={sym:'',shown:'',readings:{},sources:{},failed:{},readAt:{},run:0,busy:false,nextAt:0,wired:false};
function msMarkets(){ return INSTR.filter(I=>DERIV_CODE_MAP[I.s]); }
/* Candle times are the feed's: its clock when a recent tick tells it, this device's otherwise. */
function msNowSec(){ return feedTimeMs(Date.now(),feed.feedClock())/1000; }
function msInit(){
  const sel=$('#msSym'); if(!sel)return;
  if(!sel.options.length)sel.innerHTML=msMarkets().map(I=>'<option value="'+escHtml(I.s)+'">'+escHtml(I.s+' — '+I.n)+'</option>').join('');
  if(!msView.wired){
    msView.wired=true;
    sel.onchange=()=>{ msView.sym=sel.value; msLoad({force:true}); };
    $('#msBtn').onclick=()=>msLoad({force:true});
    $('#msMeasured').textContent=STATE_MEASURED_TEXT;
  }
  /* First visit: the market of the chart when it has candles here, gold otherwise. */
  if(!msView.sym){ const chart=state.chart&&state.chart.sym; msView.sym=DERIV_CODE_MAP[chart]?chart:DERIV_CODE_MAP['XAU/USD']?'XAU/USD':((msMarkets()[0]||{}).s||''); }
  sel.value=msView.sym;
  msRender();
  msLoad();
}
/* Reads the timeframes whose state may have changed (all of them with `force`), then draws the view.
   A look that is overtaken by a newer one (another market, Read again) draws nothing. */
async function msLoad({force=false}={}){
  const sym=msView.sym; if(!sym)return;
  const run=++msView.run;
  if(msView.shown!==sym){ msView.shown=sym; msView.readings={}; msView.sources={}; msView.failed={}; msView.readAt={}; }
  msView.busy=true;
  msView.nextAt=nextReadingCheck(Date.now(),STATE_TIMEFRAMES[0].seconds*1000);
  msRender();
  const read=async(tf)=>{
    try{
      /* The newest 600 candles, also when the market was closed in between: a state needs 400 finished ones. */
      const p=await historyCandles(sym,tf.seconds,STATE_CANDLES,{acrossClosures:true});
      if(run!==msView.run)return;
      msView.readings[tf.key]=timeframeState(p.candles,tf);
      msView.sources[tf.key]=p.source;
      msView.readAt[tf.key]=Date.now();
      delete msView.failed[tf.key];
    }catch(e){
      if(run!==msView.run)return;
      const said=String((e&&e.message)||e||'no answer').slice(0,160);
      const detail=/rate.?limit|too many requests/i.test(said)?'too many candle requests within one minute; it is read again after the next 5-minute close':said;
      /* A state already on screen stays what it was at its close; its card says that the new look failed. */
      if(msView.readings[tf.key]&&msView.readings[tf.key].ok)msView.failed[tf.key]=detail;
      else msView.readings[tf.key]={ok:false,timeframe:tf.key,label:tf.label,name:tf.name,seconds:tf.seconds,reason:'FEED',detail};
    }
  };
  /* A series is read again when a candle of its timeframe may have finished since: the time that has
     provably passed lies in a later period than the newest candle the series holds. */
  const due=(tf,provenSec)=>{ const r=msView.readings[tf.key]; return force||!r||!r.ok||!!msView.failed[tf.key]||Math.floor(provenSec/tf.seconds)*tf.seconds>r.newestStart; };
  const shortest=STATE_TIMEFRAMES[0];
  const nowSec=msNowSec();
  if(due(shortest,nowSec))await read(shortest);
  if(run!==msView.run)return;
  /* For the longer timeframes the newest 5-minute candle is the proof. On a closed market it does not
     move, and they are not read again. */
  const first=msView.readings[shortest.key];
  const moving=!!(first&&first.newestStart>0&&!msView.failed[shortest.key]);
  await Promise.all(STATE_TIMEFRAMES.slice(1).filter(tf=>due(tf,moving?first.newestStart:nowSec)).map(read));
  if(run!==msView.run)return;
  /* The newest candle the feed showed is the one that has just closed: the feed (or a copy of the
     series kept for a minute) has not shown the next one yet. Look again soon, not at the next close. */
  if(moving&&Math.floor(msNowSec()/shortest.seconds)*shortest.seconds-first.newestStart===shortest.seconds)msView.nextAt=Math.min(msView.nextAt,Date.now()+MS_RETRY_MS);
  msView.busy=false;
  msRender();
}
/* Called every second while the view is open: the line about the feed follows the clock, and a new
   look is taken a few seconds after each 5-minute close. */
function msTick(){
  if(!msView.sym)return;
  msFreshness();
  if(msView.busy||Date.now()<msView.nextAt)return;
  try{ if(document.hidden)return; }catch(e){}
  msLoad();
}
/* How old the newest candle is, and what that means for the states on screen. It depends on the time,
   not only on what was read: a feed that stops while the view is open turns into "closed or paused" here. */
function msFreshness(){
  const dot=$('#msFeedDot'), text=$('#msFeedText'), note=$('#msNote'); if(!dot||!text||!note)return;
  const sym=msView.sym;
  const read=STATE_TIMEFRAMES.map(tf=>msView.readings[tf.key]).filter(Boolean);
  const fresh=feedFreshness(read,msNowSec());
  /* The timeframe the freshness is judged by: the shortest one with candles. */
  const by=STATE_TIMEFRAMES.find(tf=>tf.label===fresh.label);
  const readAt=by&&msView.readAt[by.key]?' · read '+eatClock(msView.readAt[by.key])+' EAT':'';
  let mark,line;
  if(msView.busy){ mark='dot warn'; line='Reading…'; }
  else if(!read.length){ mark='dot off'; line='Not read yet'; }
  else if(fresh.ageSec==null){ mark='dot off'; line='No candles'; }
  /* Whether the feed is current is not known when the look that would tell it failed. */
  else if(by&&msView.failed[by.key]){ mark='dot warn'; line='Last look failed'+readAt; }
  else if(fresh.current){ mark='dot live'; line='Feed current'+readAt; }
  else { mark='dot warn'; line='Market closed or feed paused'; }
  /* An old candle means a closed market or a paused feed only when the look that found it worked.
     After a failed look nothing is concluded about the market: the age is said, and that the look failed. */
  const lookFailed=!!(by&&msView.failed[by.key]);
  let words='';
  if(fresh.ageSec!=null){
    words=lookFailed
      ?'The newest '+fresh.label+' candle that was read started '+ageText(fresh.ageSec)+' ago.'
      :fresh.current
      ?'The newest '+fresh.label+' candle started '+ageText(fresh.ageSec)+' ago. Each state is as of the close named on its card and changes at most once per candle of its timeframe.'
      :'The newest '+fresh.label+' candle of '+sym+' started '+ageText(fresh.ageSec)+' ago, so the market is closed or the feed has paused. Each state below is as of the close named on its card, not the state now.';
  }
  const failed=MS_SHOWN.filter(tf=>msView.failed[tf.key]).map(tf=>tf.label);
  if(failed.length)words+=(words?' ':'')+'The last look failed for '+failed.join(', ')+': the state shown there is the one read before, as of the close named on its card.';
  if(dot.className!==mark)dot.className=mark;
  if(text.textContent!==line)text.textContent=line;
  if(note.textContent!==words)note.textContent=words;
  note.classList.toggle('warn',fresh.ageSec!=null&&(!fresh.current||lookFailed));
}
function msRender(){
  const grid=$('#msGrid'); if(!grid)return;
  const sym=msView.sym, I=bySym[sym]||{}, dec=I.d==null?2:I.d, nowSec=msNowSec();
  const readings=STATE_TIMEFRAMES.map(tf=>msView.readings[tf.key]||null);
  const read=readings.filter(Boolean);
  const sum=$('#msSummary');
  if(read.length<readings.length)sum.textContent=msView.busy?'Reading '+sym+'…':'';
  else sum.textContent=sym+' · '+summaryText(summarizeStates(readings));
  msFreshness();
  const ctx={px:(v)=>fmtPx(v,dec),when:(sec)=>escHtml(eatMoment(sec,nowSec))};
  grid.innerHTML=MS_SHOWN.map(tf=>msCard(tf,msView.readings[tf.key],ctx)).join('');
}
function msCard(tf,r,ctx){
  const open=(stateName,extra)=>'<article class="card ms-card" data-ms-tf="'+tf.key+'" data-ms-state="'+stateName+'"'+(extra||'')+' aria-label="'+tf.name+'">';
  const title='<div><span class="ms-tf">'+tf.label+'</span><span class="faint">'+tf.name+'</span></div>';
  if(!r)return open(msView.busy?'reading':'none')+'<div class="ms-card-head">'+title+'</div><div class="empty">'+(msView.busy?'<b>Reading…</b>The last '+STATE_CANDLES+' candles of this timeframe.':'<b>Not read yet</b>')+'</div></article>';
  if(!r.ok){
    const why=UNAVAILABLE_WORDS[r.reason]||UNAVAILABLE_WORDS.FEED;
    const more=r.reason==='NOT_ENOUGH_CANDLES'?' '+r.have+' of the '+r.need+' needed.':r.detail?' ('+r.detail+')':'';
    return open('unavailable')+'<div class="ms-card-head">'+title+'</div><div class="empty"><b>No state</b>'+escHtml(why+more)+' Nothing is estimated.</div></article>';
  }
  const t=r.trend, s=r.structure, v=r.volatility, px=ctx.px, when=ctx.when;
  const source=msView.sources[tf.key]==='deriv-public'?'Deriv public candles, read through the AURUM API':'Deriv public candles, read by this browser';
  const head='<div class="ms-card-head">'+title+'<div class="ms-asof">as of '+when(r.asOf)+' EAT · '+r.candles+' finished candles'+(msView.failed[tf.key]?' · last look failed':'')+'</div></div>';
  /* trend */
  const trendBadge={UP:['ms-up','▲ '],DOWN:['ms-down','▼ '],RANGE:['ms-flat','↔ '],UNCLEAR:['ms-flat','']}[t.state];
  const n=t.candlesInState;
  const held=t.sinceOpen?'for at least '+n+' candles':'for '+n+' candle'+(n===1?'':'s')+', since '+when(t.since);
  const order={up:'EMA 20 above EMA 50 above EMA 200, close above EMA 50',down:'EMA 20 below EMA 50 below EMA 200, close below EMA 50',mixed:'averages and close not in one order'}[t.stack];
  const strength=t.adx>=ADX_TREND?ADX_TREND+' or more':t.adx<ADX_RANGE?'below '+ADX_RANGE:'between '+ADX_RANGE+' and '+ADX_TREND;
  const trend='<div class="ms-row"><dt>Trend</dt><dd><span class="badge '+trendBadge[0]+'">'+trendBadge[1]+TREND_WORDS[t.state]+'</span><span class="ms-held">'+held+'</span>'
    +'<div class="ms-evidence">EMA 20 <b>'+px(t.ema20)+'</b> · EMA 50 <b>'+px(t.ema50)+'</b> · EMA 200 <b>'+px(t.ema200)+'</b> · close <b>'+px(r.price)+'</b>: '+order+'. ADX 14 <b>'+t.adx.toFixed(1)+'</b>: '+strength+'.</div></dd></div>';
  /* structure */
  const structBadge=s.state==='UP'?['ms-up','▲ ']:s.state==='DOWN'?['ms-down','▼ ']:['ms-flat',''];
  const swing=(point)=>'<b>'+px(point.price)+'</b> ('+when(point.time)+')';
  const place={above:'above the last swing high',below:'below the last swing low',inside:'between the last swing low and the last swing high'}[s.position];
  const structure='<div class="ms-row"><dt>Structure</dt><dd><span class="badge '+structBadge[0]+'">'+structBadge[1]+escHtml(structureWords(s))+'</span>'
    +'<div class="ms-evidence">'+(s.state==='UNKNOWN'
      ?'Fewer than two swing highs and two swing lows in the candles read.'
      :'Highs: '+swing(s.lastHigh)+' after '+swing(s.prevHigh)+'. Lows: '+swing(s.lastLow)+' after '+swing(s.prevLow)+'. Last close <b>'+px(r.price)+'</b>: '+place+'.')+'</div></dd></div>';
  /* volatility */
  const volBadge={QUIET:'ms-flat',NORMAL:'ms-flat',HIGH:'ms-warn',EXTREME:'ms-hot',UNKNOWN:'ms-flat'}[v.state];
  const volatility='<div class="ms-row"><dt>Volatility</dt><dd><span class="badge '+volBadge+'">'+VOLATILITY_WORDS[v.state]+'</span>'
    +'<div class="ms-evidence">'+(v.state==='UNKNOWN'
      ?'ATR 14 <b>'+px(v.atr)+'</b>; too few candles to compare it with.'
      :'ATR 14 <b>'+px(v.atr)+'</b> ('+v.atrPct.toFixed(2)+'% of the price): higher than in <b>'+Math.round(v.rank)+'%</b> of the '+VOL_WINDOW+' candles before it'+(v.ratio?', '+v.ratio.toFixed(1)+' times their middle value':'')+(v.change?', '+v.change:'')+'.')+'</div></dd></div>';
  return open('ok',' data-ms-trend="'+t.state+'" data-ms-structure="'+s.state+'" data-ms-volatility="'+v.state+'"')+head+msSketch(tf,r)
    +'<div class="ms-key"><span><i class="e50"></i>EMA 50</span><span><i class="e200"></i>EMA 200</span><span>HH, HL, LH, LL: a swing against the one before it</span></div>'
    +'<dl class="ms-rows">'+trend+structure+volatility+'</dl><div class="ms-asof" style="margin-top:8px">'+source+'</div></article>';
}
/* The candles of one timeframe as high-low bars, with EMA 50 and EMA 200 and the swings the structure was read from. */
function msSketch(tf,r){
  const W=320,H=120,padX=8,padTop=15,padBottom=15;
  const cs=r.sketch.candles,n=cs.length;
  let lo=Infinity,hi=-Infinity;
  for(const c of cs){ if(c.low<lo)lo=c.low; if(c.high>hi)hi=c.high; }
  const span=hi>lo?hi-lo:(hi*0.001||1);
  const X=(i)=>padX+(n>1?i/(n-1):0.5)*(W-2*padX), Y=(v)=>padTop+(1-(v-lo)/span)*(H-padTop-padBottom);
  const f=(v)=>v.toFixed(1);
  let up='',down='';
  cs.forEach((c,i)=>{ const seg='M'+f(X(i))+' '+f(Y(c.high))+'V'+f(Y(c.low)); if(c.close>=c.open)up+=seg; else down+=seg; });
  const line=(values)=>{ let d='',pen=false; values.forEach((v,i)=>{ if(typeof v!=='number'){ pen=false; return; } d+=(pen?'L':'M')+f(X(i))+' '+f(Y(v)); pen=true; }); return d; };
  const width=Math.max(0.7,Math.min(1.6,((W-2*padX)/Math.max(1,n-1))*0.55)).toFixed(2);
  let marks='',levels='';
  const labelled={high:-99,low:-99}, lastOf={high:null,low:null};
  for(const sw of r.sketch.swings){
    const x=X(sw.index),y=Y(sw.price),high=sw.kind==='high';
    lastOf[sw.kind]=sw;
    marks+='<circle class="ms-swing" cx="'+f(x)+'" cy="'+f(y)+'" r="1.9"/>';
    /* Marks that would run into the one before them on the same side are left out; the dot stays. */
    if(x-labelled[sw.kind]>=15){ marks+='<text x="'+f(Math.min(W-9,Math.max(9,x)))+'" y="'+f(high?y-4.5:y+10.5)+'" text-anchor="middle">'+sw.mark+'</text>'; labelled[sw.kind]=x; }
  }
  for(const sw of [lastOf.high,lastOf.low])if(sw)levels+='<path class="ms-level" d="M'+f(X(sw.index))+' '+f(Y(sw.price))+'H'+f(W-padX)+'"/>';
  const clip='msClip-'+tf.key;
  return '<svg class="ms-sketch" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+tf.label+': the last '+n+' finished candles with EMA 50, EMA 200 and the swing highs and lows">'
    +'<defs><clipPath id="'+clip+'"><rect x="0" y="0" width="'+W+'" height="'+H+'"/></clipPath></defs>'
    +'<g fill="none" stroke-linecap="round" clip-path="url(#'+clip+')">'
    +'<path class="ms-ema200" d="'+line(r.sketch.ema200)+'"/><path class="ms-ema50" d="'+line(r.sketch.ema50)+'"/>'
    +levels
    +'<path class="ms-bar-up" stroke-width="'+width+'" d="'+up+'"/><path class="ms-bar-down" stroke-width="'+width+'" d="'+down+'"/></g>'
    +marks+'</svg>';
}

function render(view){
  switch(view){
    case 'overview': renderOverview(); break;
    case 'markets': renderMarkets(); break;
    case 'trade': updateTradeHeader(); syncSide(); break;
    case 'state': msInit(); break;
    case 'signals': if(state.scanStatus==='idle')scanSignals(); else renderSignals(); break;
    case 'sniper': renderSniperView(); break;
    case 'gold': renderGold(); break;
    case 'portfolio': renderPortfolio(); break;
    case 'automation': connUI(); renderBots(); break;
    case 'learn': learnInit(); break;
    case 'watch': renderWatch(); break;
    case 'settings': loadKeysUI(); refreshNotifBtn(); azFetchBudget(); bindBrand(); applyBrand(); break;
  }
}
let booted=false;
function boot(){
  enteredWorkspace=true; /* cloud viewer: from here on this browser may read Deriv candles (see hostedSignalBatch) */
  applyBrand();
  setTimeout(()=>{ if(atCfg().on)resumeAutoTrade(); },6000); /* armed survives reloads/deploys */
  if(booted){
    /* re-login: refresh connection-dependent UI without re-wiring */
    wireFeed();
    renderNavCounts(); renderPortfolio(); renderBots(); connUI();
    updateKpis(); updateTradeHeader(); updateSessionInfo();
    render(state.view||'overview');
    return;
  }
  booted=true;
  applyTheme();
  document.body.classList.toggle('compact',!!state.settings.compact);
  $('#compactChk').checked=!!state.settings.compact;
  $('#defAmt').value=state.settings.defAmt;
  $('#orderAmount').value=state.settings.defAmt;
  $('#riskRange').value=state.settings.maxRisk;
  $('#riskVal').textContent=Number(state.settings.maxRisk).toFixed(1)+'%';
  $('#confirmChk').checked=state.settings.confirmClose;
  renderAutoTrade();
  buildTicker();
  const sel=$('#chartSymbol');
  sel.innerHTML=INSTR.map(I=>'<option value="'+I.s+'">'+I.s+' — '+I.n+'</option>').join('');
  sel.value=state.chart.sym;
  sel.onchange=()=>setChartSymbol(sel.value);
  syncSide(); updateTradeHeader();
  scanSignals();
  azPopulateSymbols();
  azFetchBudget();
  $('#azRun').onclick = azAnalyze;
  $('#azUse').onclick = azUseSetup;
  loadKeysUI(); refreshNotifBtn();
  renderNavCounts(); renderPortfolio(); renderBots(); connUI();
  render('overview');
  wireFeed();
  tickUI();
  repickAfterEntering();
}

/* ================================================================
   SNIPER — read-only signal scanner.
   Scans Exness-first with labelled fallback; shows market, entry,
   SL, TP1 and TP2/exit references. Entries are explicitly blocked.
   ================================================================ */
const AT_INTERVAL=30000; /* Active preset cadence — careful users just get faster scans, same strict gates */
let atTimer=null, atBusy=false, atFails=0;
let atScanInfo={ at:0, checked:0, best:null };
const sniperWatchSymbols=new Set((()=>{const v=store.get('sniperWatchSymbols',[]);return Array.isArray(v)?v:[];})());
let sniperSelectedSymbol='',sniperPickerOpen=false;
function saveSniperWatchSymbols(){store.set('sniperWatchSymbols',[...sniperWatchSymbols]);renderNavCounts();}
function setSniperWatch(symbol,on){
  if(on)sniperWatchSymbols.add(symbol);else sniperWatchSymbols.delete(symbol);
  saveSniperWatchSymbols();
  const active=store.get('sniperActiveSetups',{});if(!on&&active&&active[symbol]){delete active[symbol];store.set('sniperActiveSetups',active);}
  renderSniperMarketList();
  renderSniperSignalAlerts(Object.values(state.mktScan||{}),new Set());
  if(on&&atTimer)autoTradeCycle();
}
function renderSniperView(){
  renderSniperMarketList();
  const search=$('#sniperMarketSearch');if(search)search.oninput=renderSniperMarketList;
  const picker=$('#sniperPickerToggle');if(picker)picker.onclick=()=>{sniperPickerOpen=!sniperPickerOpen;picker.textContent=sniperPickerOpen?'Hide unselected':'Add markets';picker.setAttribute('aria-expanded',String(sniperPickerOpen));renderSniperMarketList();};
  const refresh=$('#sniperRefreshMarkets');if(refresh)refresh.onclick=async()=>{refresh.disabled=true;refresh.textContent='Refreshing…';try{await mktScanRefresh(true);renderSniperMarketList();}finally{refresh.disabled=false;refresh.textContent='Refresh signals';}};
  const toggle=$('#sniperMonitorToggle');if(toggle)toggle.onclick=()=>{const c=$('#atChk');if(!c)return;if(!atTimer&&!sniperWatchSymbols.size){toast('Select a market first','Check at least one market for Sniper entry/exit alerts.','warn');return;}c.checked=!atTimer;c.dispatchEvent(new Event('change',{bubbles:true}));renderSniperMonitorUi();};
  const body=$('#sniperWatchList');if(body){body.onchange=e=>{const c=e.target.closest('[data-sniper-watch]');if(c)setSniperWatch(c.dataset.sniperWatch,c.checked);};body.onclick=e=>{const b=e.target.closest('[data-sniper-view]');if(b){sniperSelectedSymbol=b.dataset.sniperView;renderSniperSelectedDetail();}};}
  renderSniperMonitorUi();renderSniperSignalAlerts(Object.values(state.mktScan||{}),new Set());
  if(!mktScanAt||Date.now()-mktScanAt>90*1000)mktScanRefresh(true).then(renderSniperMarketList).catch(()=>{});
}
function renderSniperMonitorUi(){
  const on=!!atTimer,b=$('#sniperMonitorToggle'),badge=$('#sniperMonitorState');
  if(b){b.textContent=on?'Stop monitoring':'Start monitoring';b.classList.toggle('primary',!on);}
  if(badge){badge.textContent=on?'Monitoring active · read-only':'Monitoring off';badge.className='badge '+(on?'buy':'gray');}
}
function renderSniperMarketList(){
  const body=$('#sniperWatchList');if(!body)return;
  const q=String(($('#sniperMarketSearch')||{}).value||'').trim().toLowerCase();
  const matches=INSTR.filter(I=>!q||I.s.toLowerCase().includes(q)||I.n.toLowerCase().includes(q));
  const rows=(sniperPickerOpen||q)?matches:matches.filter(I=>sniperWatchSymbols.has(I.s));
  if(!rows.length){
    const message=q?'No markets match that search.':(sniperWatchSymbols.size?'No selected markets.':'No markets selected yet — choose Add markets to pick what to monitor.');
    body.innerHTML='<tr><td colspan="10" class="faint">'+escHtml(message)+'</td></tr>';return;
  }
  const price=(r,key,digits)=>{const n=Number(r&&r[key]);return Number.isFinite(n)&&n>0?fmtPx(n,digits):'—';};
  body.innerHTML=rows.map(I=>{
    const r=state.mktScan[I.s],checked=sniperWatchSymbols.has(I.s),available=r&&!r.error;
    const approved=available&&isAsterPublishable(r),directional=available&&isDirectionalCandidate(r);
    const signal=available?'<span class="badge '+(approved?(r.signal==='BUY'?'buy':r.signal==='SELL'?'sell':'gray'):'gray')+'">'+(directional&&!approved?'ASTER BLOCKED':escHtml(r.signal||'WAIT'))+'</span>':'<span class="badge gray">'+(r?(signalState(r)==='stale'?'STALE':signalState(r)==='no-data'?'NO DATA':'UNAVAILABLE'):'WAITING')+'</span>';
    const source=available?(r.data_source||r.source||'source unavailable'):(r&&r.data_source||'—'),digits=I.d||2;
    /* Score of the reading as it stands now; a BUY/SELL also says how far the market has moved since it was first read. */
    const confidence=approved?sniperConfidenceCell(r):'—';
    return '<tr><td><input type="checkbox" data-sniper-watch="'+escHtml(I.s)+'" aria-label="Notify on entry and exit for '+escHtml(I.s)+'" '+(checked?'checked':'')+'></td><td><b>'+escHtml(I.s)+'</b><div class="tiny faint">'+escHtml(I.n)+'</div></td><td>'+signal+'</td><td class="mono">'+confidence+'</td><td class="tiny">'+escHtml(available?(r.tf||'—'):'—')+'</td><td class="mono">'+(approved?price(r,'entry',digits):'—')+'</td><td class="mono down">'+(approved?price(r,'stop_loss',digits):'—')+'</td><td class="mono up">'+(approved?price(r,'tp1',digits):'—')+'</td><td class="tiny">'+escHtml(source)+'</td><td><button class="btn ghost sm" type="button" data-sniper-view="'+escHtml(I.s)+'" title="View '+escHtml(I.s)+' signal details" aria-label="View '+escHtml(I.s)+' signal details"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg></button></td></tr>';
  }).join('');
}
function renderSniperSelectedDetail(){
  const el=$('#sniperSelectedDetail');if(!el)return;
  const symbol=sniperSelectedSymbol,r=state.mktScan[symbol];
  if(!symbol||!r){el.innerHTML='<div class="empty"><b>No current scan result</b>Refresh signals to load this market.</div>';return;}
  if(r.error){el.innerHTML='<div class="empty"><b>Signal unavailable for '+escHtml(symbol)+'</b>'+escHtml(r.detail||'No verified source data.')+' No levels are shown as current.</div>';return;}
  const approved=isAsterPublishable(r),directional=isDirectionalCandidate(r),I=bySym[symbol],digits=I&&I.d||2,fmt=k=>{const n=Number(r[k]);return approved&&directional&&Number.isFinite(n)&&n>0?fmtPx(n,digits):'—';},source=r.data_source||r.source||'unavailable';
  el.innerHTML='<div class="row between wrap"><div><b style="font-size:18px">'+escHtml(symbol)+'</b> <span class="badge '+(approved?(r.signal==='BUY'?'buy':r.signal==='SELL'?'sell':'gray'):'gray')+'">'+(directional&&!approved?'ASTER BLOCKED':escHtml(r.signal||'WAIT'))+'</span></div><label class="row tiny" style="gap:6px"><input type="checkbox" data-sniper-detail-watch="'+escHtml(symbol)+'" '+(sniperWatchSymbols.has(symbol)?'checked':'')+'> Notify on entry &amp; exit</label></div><div class="az-tiles" style="margin-top:12px"><div class="az-tile"><div class="k">ENTRY REFERENCE</div><div class="v">'+fmt('entry')+'</div></div><div class="az-tile"><div class="k">STOP LOSS</div><div class="v down">'+fmt('stop_loss')+'</div></div><div class="az-tile"><div class="k">TP1</div><div class="v up">'+fmt('tp1')+'</div></div><div class="az-tile"><div class="k">TP2 / EXIT</div><div class="v up">'+fmt('tp2')+'</div></div></div><div class="hint">Price: '+(Number(r.price)>0?fmtPx(Number(r.price),digits):'—')+' · Confidence: '+(approved?liveScoreHtml(r,'span'):'withheld by ASTER')+' · Source: '+escHtml(source)+' · '+escHtml(r.tf||'')+(closeText(r)?' · read at the '+closeText(r)+' candle close':'')+'. Analysis only — no order sent.</div>'+(approved?liveNoteHtml(r,false):'<div class="hint">Technical candidate withheld by ASTER. No directional setup or levels are published.</div>')+(approved&&measuredText(r)?'<div class="tiny faint" data-measured="'+escHtml(symbol)+'">'+escHtml(measuredText(r))+'</div>':'');
  const watch=el.querySelector('[data-sniper-detail-watch]');if(watch)watch.onchange=()=>setSniperWatch(symbol,watch.checked);
}
function renderSniperSignalAlerts(results,qualifiedSymbols=new Set()){
  const targets=[$('#atSignalAlerts'),$('#sniperSignalList')].filter(Boolean);if(!targets.length)return;
  if(!sniperWatchSymbols.size){targets.forEach(el=>el.innerHTML='<div class="tiny faint">No markets selected. Choose markets above to show only the alerts you want.</div>');return;}
  const rows=(results||[]).filter(r=>r&&!r.error&&isAsterPublishable(r)&&sniperWatchSymbols.has(r.symbol)&&(r.signal==='BUY'||r.signal==='SELL'))
    .sort((a,b)=>(Number(b.confidence)||0)-(Number(a.confidence)||0));
  if(!rows.length){targets.forEach(el=>el.innerHTML='<div class="tiny faint">No ASTER-approved directional setup in your selected markets yet. Waiting for fresh evidence.</div>');return;}
  const level=(r,key)=>{const n=Number(r[key]);if(!Number.isFinite(n)||n<=0)return '—';const digits=(bySym[r.symbol]&&bySym[r.symbol].d)||2;return fmtPx(n,digits);};
  const html='<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Market</th><th>Signal</th><th>Confidence</th><th>Timeframe</th><th>Entry</th><th>SL</th><th>TP1</th><th>Source</th></tr></thead><tbody>'+rows.map(r=>{
    const qualified=qualifiedSymbols.has(r.symbol), cls=r.signal==='BUY'?'buy':'sell';
    return '<tr><td><b>'+escHtml(r.symbol)+'</b></td><td><span class="badge '+cls+'">'+escHtml(r.signal)+'</span><div class="tiny faint">'+(qualified?'filter match':'selected market')+'</div></td><td class="mono">'+sniperConfidenceCell(r)+'</td><td class="tiny">'+escHtml(r.tf||'—')+'</td><td class="mono">'+level(r,'entry')+'</td><td class="mono down">'+level(r,'stop_loss')+'</td><td class="mono up">'+level(r,'tp1')+'</td><td class="tiny">'+escHtml(r.data_source||r.source||'unavailable')+'</td></tr>';
  }).join('')+'</tbody></table></div><div class="tiny faint" style="margin-top:5px">Updated '+new Date().toLocaleTimeString()+' · technical references only; no order was placed.</div>';
  targets.forEach(el=>el.innerHTML=html);
}
function emitSniperSignalAlerts(qualified,allResults){
  const subscribed=new Set(sniperWatchSymbols),current=new Map((qualified||[]).filter(r=>isAsterPublishable(r)&&isDirectionalCandidate(r)&&subscribed.has(r.symbol)).map(r=>[r.symbol,r]));
  const active=store.get('sniperActiveSetups',{})||{},latest=new Map((allResults||[]).filter(r=>r&&!r.error).map(r=>[r.symbol,r])),started=new Set();
  const level=(symbol,value)=>Number.isFinite(Number(value))&&Number(value)>0?fmtPx(Number(value),(bySym[symbol]&&bySym[symbol].d)||2):'—';
  for(const r of current.values()){
    const source=String(r.data_source||r.source||'source unavailable'),old=active[r.symbol];
    if(old&&old.signal===r.signal&&old.source===source)continue;
    const fingerprint=[r.signal,source,'levels-v1'].join('|');
    const details='Market: '+r.symbol+' · '+r.signal+' '+(Number(r.confidence)||0)+'%\nTimeframe: '+String(r.tf||'—')+'\nEntry: '+level(r.symbol,r.entry)+' · SL: '+level(r.symbol,r.stop_loss)+' · TP1: '+level(r.symbol,r.tp1)+' · TP2 / exit: '+level(r.symbol,r.tp2)+'\nSource: '+source+'\nSignal alert only — no order was placed.'+(measuredLine(r)?'\n'+measuredLine(r):'');
    notify('Sniper entry setup · '+r.symbol,details,{tag:'sniper-'+r.symbol+'-entry',kind:r.signal==='BUY'?'ok':'warn'});
    active[r.symbol]={signal:r.signal,source,entry:r.entry,stop_loss:r.stop_loss,tp1:r.tp1,tp2:r.tp2,tf:r.tf||'',stage:0,startedAt:Date.now(),fingerprint};
    started.add(r.symbol);
  }
  for(const symbol of Object.keys(active)){
    if(!subscribed.has(symbol)){delete active[symbol];continue;}
    const setup=active[symbol],r=latest.get(symbol);if(!r||started.has(symbol))continue;
    if(setup.closed){if(!current.has(symbol))delete active[symbol];continue;}
    if(!isAsterPublishable(r)){
      notify('Sniper setup withdrawn · '+symbol,'The latest ASTER gate no longer approves this candidate. Entry/exit monitoring has stopped; no order was placed.',{tag:'sniper-'+symbol+'-aster-blocked',kind:'warn'});
      delete active[symbol];continue;
    }
    if(!isDirectionalCandidate(r)){
      notify('Sniper setup withdrawn · '+symbol,'The latest reading is no longer directional. Entry/exit monitoring has stopped; no order was placed.',{tag:'sniper-'+symbol+'-withdrawn',kind:'warn'});
      delete active[symbol];continue;
    }
    const isDaily=String(r.tf||'').toUpperCase().includes('DAILY')||String(r.data_source||r.source||'').startsWith('Yahoo Finance');
    const price=Number(r.price);
    if(!isDaily&&price>0){
      const buy=setup.signal==='BUY',sl=Number(setup.stop_loss),tp1=Number(setup.tp1),tp2=Number(setup.tp2);
      const slHit=sl>0&&(buy?price<=sl:price>=sl),tp1Hit=tp1>0&&(buy?price>=tp1:price<=tp1),tp2Hit=tp2>0&&(buy?price>=tp2:price<=tp2);
      if(slHit){notify('Sniper SL touched · '+symbol,'Market: '+symbol+' · '+setup.signal+' setup stop level touched at '+level(symbol,price)+' (SL '+level(symbol,sl)+'). Source: '+String(r.data_source||r.source||setup.source)+'. Analysis only — no position was closed.',{tag:'sniper-'+symbol+'-sl',kind:'warn'});setup.closed=true;setup.closedReason='SL';continue;}
      if(tp1Hit&&!setup.tp1Notified){setup.tp1Notified=true;setup.stage=Math.max(1,Number(setup.stage)||0);notify('Sniper TP1 reached · '+symbol,'Market: '+symbol+' · price '+level(symbol,price)+' reached TP1 '+level(symbol,tp1)+'. TP2/exit reference: '+level(symbol,tp2)+' · SL: '+level(symbol,sl)+'. Source: '+String(r.data_source||r.source||setup.source)+'. Analysis only — no order was closed.',{tag:'sniper-'+symbol+'-tp1',kind:'ok'});}
      if(tp2Hit){notify('Sniper exit target reached · '+symbol,'Market: '+symbol+' · price '+level(symbol,price)+' reached TP2/exit reference '+level(symbol,tp2)+'. Source: '+String(r.data_source||r.source||setup.source)+'. Analysis only — no position was closed.',{tag:'sniper-'+symbol+'-tp2',kind:'ok'});setup.closed=true;setup.closedReason='TP2';continue;}
      setup.lastPrice=price;
    }
    if(!current.has(symbol)){
      notify('Sniper setup withdrawn · '+symbol,'Market: '+symbol+' no longer meets the selected Sniper filters. No TP/SL touch was confirmed; no order was placed. Latest source: '+String(r.data_source||r.source||setup.source)+'.',{tag:'sniper-'+symbol+'-withdrawn',kind:'warn'});
      delete active[symbol];
    }
  }
  store.set('sniperActiveSetups',active);
}
setInterval(()=>{ /* 1s countdown repaint while read-only scanning runs */
  if(!atTimer||!atScanInfo.at)return;
  const left=Math.max(0,Math.ceil((atScanInfo.at+AT_INTERVAL-Date.now())/1000));
  const b=$('#atStatus'); if(!b||!/scanning|hunting|analysis-only/.test(b.textContent||''))return;
  if(atScanInfo.best){
    b.textContent='🔍 analysis-only · best '+atScanInfo.best.symbol+' '+atScanInfo.best.signal+' '+atScanInfo.best.confidence+'% (filter ≥ '+atCfg().conf+'%) · next scan '+left+'s';
  }else{
    b.textContent='🔍 analysis-only · '+atScanInfo.checked+' markets checked · no setup ≥ '+atCfg().conf+'% · next scan '+left+'s';
  }
},1000);
let atSession=null; /* {startedAt, entries} */

function atCfg(){ const c=state.settings.autotrade; if(c.brakes==null)c.brakes='run'; if(c.durMode==null)c.durMode='fast'; if(c.targetPct==null)c.targetPct=50; if(c.mode==null)c.mode='active'; if(c.maxConc==null)c.maxConc=1; if(c.prefResale==null)c.prefResale=false; if(c.atSynth==null)c.atSynth=false; /* synthetics are random-walks: excluded from AUTO by default */ if(c.conf==null)c.conf=70; return c; }
/* Runs-until-stopped: armed survives reloads/deploys; session-expiry pauses it and
   the session heal re-arms automatically. Only the user's switch stops it for good. */
let atCooldownUntil=0;
{ /* one-time migration: 60% was the old default bar — 70% reflects the payout math */
  const c=state.settings.autotrade||{};
  if(c.conf===60){ c.conf=70; try{ toast('Sniper bar raised','Confidence minimum moved 60% \u2192 70% (60% had almost no edge after payouts \u2014 change it back in Automation if you disagree).','ok'); }catch(e){} } }
function resumeAutoTrade(){
  const c=atCfg();
  if(!c.on||atTimer)return;
  enableAutoTrade(true);
  toast('Sniper analysis resumed','Read-only signal scanning is active; entries remain blocked.','ok');
}
function atBrokerPath(){
  const dh=state.derivHealth;
  if(dh&&dh.authorized&&dh.tradingEnabled)return 'proxy';
  if(state.broker?.type==='deriv')return state.broker.mode==='pat_server'?'pat_server':'pat';
  if(state.broker?.type==='mt5')return 'mt5';
  return null;
}
function atStatusUI(kind,text,title){
  const el=$('#atStatus'); if(!el)return;
  const map={off:'gray',armed:'buy',scan:'neutral',pos:'neutral',target:'buy',max:'neutral',loss:'sell',err:'sell',wait:'gray'};
  el.className='badge '+(map[kind]||'gray');
  el.textContent=text;
  if(title!=null)el.title=title;
}
function renderAutoTrade(){
  const c=atCfg();
  $('#atChk').checked=!!c.on&&!!atTimer; /* armed intent persists; boot resume restarts the loop */
  $('#atConf').value=c.conf; $('#atConfVal').textContent=c.conf+'%';
  $('#atStake').value=c.stake; $('#atTarget').value=c.target;
  { const t=document.getElementById('atSynth'); if(t){ t.checked=!!c.atSynth; if(!t.__wired){ t.__wired=1; t.addEventListener('change',()=>{ c.atSynth=t.checked; save();
    toast('Synthetics in auto-trade',t.checked?'Re-included \u2014 random-walk families (VOL/BOOM/CRASH) can be sniper-traded again.':'Excluded \u2014 the sniper only hunts forex, metals and crypto (manual trading unrestricted).','ok'); }); } } }
  { const hEl=document.getElementById('atHealth'); if(hEl)hEl.innerHTML=atHealthHtml(); }
  { const gEl=document.getElementById('guardStatus'); if(gEl)gEl.innerHTML=guardStatusHtml(); }
  $('#atMax').value=c.maxTrades; $('#atDir').value=c.dir;
  $('#atBrakes').value=c.brakes||'run';
  $('#atConc').value=c.maxConc||1;
  if(!atTimer)atStatusUI('off','off','Read-only Sniper signal scanning is stopped; no entries are possible.');
}
function atRealized(){
  if(!atSession)return 0;
  let sum=0;
  for(const h of state.history){
    if(h.at&&h.t>=atSession.startedAt&&typeof h.pl==='number')sum+=h.pl;
  }
  return sum;
}
function atCheckProfit(){
  if(!atTimer||!atSession)return;
  const c=atCfg(), r=Math.round(atRealized()*100)/100;
  if(r>=c.target){
    if(c.brakes==='stop'){
      disableAutoTrade('target','Profit target reached: '+fmtMoney(r,true)+' ≥ '+fmtMoney(c.target)+'. Auto-trade stopped.');
      notify('Auto-trade target reached','Session profit '+fmtMoney(r,true)+' — the sniper stood down until you re-arm it.',{tag:'auto',kind:'ok'});
      return;
    }
    if(!atSession.targetNotified){ atSession.targetNotified=true;
      notify('Session target passed — still running','Session profit '+fmtMoney(r,true)+' passed your '+fmtMoney(c.target)+' mark. The sniper keeps hunting until you stop it (server caps remain).',{tag:'auto',kind:'ok'});
    }
  }else if(r<=-c.target){
    if(c.brakes==='stop'){
      disableAutoTrade('loss','Loss guard hit: '+fmtMoney(r,true)+'. Auto-trade stopped.');
      notify('Auto-trade stopped (loss guard)','Session P&L '+fmtMoney(r,true)+' reached the -'+fmtMoney(c.target)+' guard. Positions remain managed by SL/TP.',{tag:'auto',kind:'err'});
      return;
    }
    if(!atSession.lossNotified){ atSession.lossNotified=true;
      notify('Session loss guard passed — still running','Session P&L '+fmtMoney(r,true)+' passed −'+fmtMoney(c.target)+'. Still hunting per your runs-until-stopped setting — the server-side daily loss limit is the hard backstop.',{tag:'auto',kind:'err'});
    }
  }
  atStatusUI(atTimer?'armed':'off','running · session P&L '+fmtMoney(r,true),atSession.entries+' entries so far · until you stop it');
}
function enableAutoTrade(silent){
  const c=atCfg(); c.on=true; save();
  if(!atSession)atSession={startedAt:Date.now(),entries:0};
  atFails=0;
  atStatusUI('armed','analysis-only · scanning','Exness-first signal analysis with labelled fallback. Sniper entries are blocked; no broker orders can be placed.');
  if(!silent)notify('Sniper analysis armed','Read-only signal scanning is active. Exness is primary, fallbacks are labelled, and no entries will be placed.',{tag:'auto',kind:'ok'});
  if(atTimer)clearInterval(atTimer);
  atTimer=setInterval(autoTradeCycle,AT_INTERVAL);
  renderSniperMonitorUi();
  autoTradeCycle();
}
function disableAutoTrade(reason,text,keepArmed){
  const c=atCfg(); if(!keepArmed){ c.on=false; save(); }
  if(atTimer){ clearInterval(atTimer); atTimer=null; }
  renderSniperMonitorUi();
  atStatusUI(reason==='off'?'off':reason, text||('stopped ('+(reason||'off')+')'));
  if(reason==='off'){$('#atChk').checked=false;}
}
async function autoTradeCycle(){
  if(!atTimer||atBusy||!atSession)return;
  const c=atCfg();
  const mode=c.mode||'active';
  atBusy=true;
  try{
    if(Date.now()<atCooldownUntil){ atStatusUI('scan','cool-down after scan failures · still armed','retrying in '+Math.ceil((atCooldownUntil-Date.now())/1000)+'s'); atBusy=false; return; }
    const breadth=(c.mode||'active')==='careful'?6:10;
    /* early-exit pool (optional, default OFF): hunt only families Deriv usually
       lets you resell (synthetics). Falls back to the full universe if the pool
       has no live prices yet — the sniper never dead-ends. */
    let universe=INSTR.filter(I=>I.p!=null||I.c==='indices'); /* index CFDs can be scanned via Exness or labelled daily fallback without a Deriv tick */
    /* synthetics (VOL/BOOM/CRASH/STEP) are engineered random-walks — candle
       signals have no edge there, so AUTO skips them unless you explicitly
       re-include them in Automation. Manual trading is never restricted. */
    if(!c.atSynth){ const noSynth=universe.filter(I=>I.c!=='synthetics'); if(noSynth.length)universe=noSynth; }
    /* Keep existing analysis filter setting, but no execution follows a scan. */
    if(c.prefResale){ const early=universe.filter(I=>I.resale==='usually'); if(early.length)universe=early; }
    const syms=universe.slice(0,breadth).map(I=>I.s);
    const baseSyms=syms.length?syms:INSTR.slice(0,breadth).map(I=>I.s);
    const useSyms=[...new Set([...baseSyms,...sniperWatchSymbols])];
    const results=await scanSignalsPreferred(useSyms);
    results.forEach(r=>{state.mktScan[r.symbol]=r;});
    if(state.view==='sniper'){renderSniperMarketList();renderSniperSelectedDetail();}
    const data={results};
    const sigs=(data.results||[]).filter(r=>!r.error&&isAsterPublishable(r)
      &&(r.signal==='BUY'||r.signal==='SELL')
      &&(c.dir==='both'||r.signal===c.dir)
      &&(r.confidence||0)>=c.conf
      /* quality gate: reward:risk >= 1 (skipped only if levels are missing) */
      &&(()=>{const e=Number(r.entry),sl=Number(r.stop_loss),t=Number(r.tp1); if(!(e>0&&sl>0&&t>0))return true; return Math.abs(t-e)/Math.abs(e-sl)>=1.0;})())
      .sort((a,b)=>(b.confidence||0)-(a.confidence||0));
    renderSniperSignalAlerts(data.results||[],new Set(sigs.map(r=>r.symbol)));
    emitSniperSignalAlerts(sigs,results);
    if(!sigs.length){
      /* best candidate across all checked markets (direction-aware) for the hunting display */
      const cands=(data.results||[]).filter(r=>!r.error&&isAsterPublishable(r)&&(r.signal==='BUY'||r.signal==='SELL')&&(c.dir==='both'||r.signal===c.dir));
      const best=cands.length?cands.reduce((a,b)=>((b.confidence||0)>(a.confidence||0)?b:a)):null;
      const source=best&&String(best.data_source||best.source||'source unavailable');
      atScanInfo={ at:Date.now(), checked:(data.results||[]).length, best:best?{symbol:best.symbol,signal:best.signal,confidence:best.confidence||0,source}:null };
      atStatusUI('scan','🔍 analysis-only · '+atScanInfo.checked+' markets · no setup ≥ '+c.conf+'%',
        best?('closest setup: '+best.symbol+' '+best.signal+' '+best.confidence+'% — waiting for ≥'+c.conf+'% · source: '+source):'no directional setups yet · no entries are placed');
      return;
    }
    const candidate=sigs[0], source=String(candidate.data_source||candidate.source||'source unavailable');
    atScanInfo={at:Date.now(),checked:results.length,best:{symbol:candidate.symbol,signal:candidate.signal,confidence:candidate.confidence||0,source}};
    atStatusUI('scan','🔍 analysis-only · '+candidate.symbol+' '+candidate.signal+' '+(candidate.confidence||0)+'%','Sniper entry is blocked. Source: '+source+' · no order placed.');
    return;
  }catch(e){
    const msg=String(e&&e.message||e||'Signal scan unavailable');
    atFails++;
    atStatusUI('err','signal scan unavailable ('+atFails+')',msg.slice(0,140)+' · no entries were placed');
    if(atFails>=3){atFails=0;atCooldownUntil=Date.now()+60000;notify('Sniper scan paused','Three consecutive scan failures. Analysis will retry in one minute; no entry was placed.',{tag:'auto-scan',kind:'warn'});}
  }finally{ atBusy=false; }
}
async function autoEntry(sig,path){
  throw new Error('Sniper entries are disabled; the Sniper is analysis-only. No broker order was sent.');
  const c=atCfg(), dh=state.derivHealth;
  const I=bySym[sig.symbol];
  const px=(I&&I.p!=null)?I.p:sig.entry;
  if(px==null)throw new Error('no live price for '+sig.symbol);
  const limMax=Number(dh?.limits?.maxStakeUsd)||Number(state.broker?.limits?.maxStakeUsd)||c.stake;
  const stake=Math.min(c.stake, limMax);
  const du=(c.durMode==='target')?targetDurFor(sig.symbol):derivDurationFor(sig.symbol);
  const atTarget=stake*((c.targetPct??50)/100); /* sniper auto-closes (or alerts) at this live profit */
  const side=sig.signal==='SELL'?'SELL':'BUY';
  const sl=sig.stop_loss!=null?Number(sig.stop_loss):null;
  const tp1=sig.tp1!=null?Number(sig.tp1):null;
  const tp2=sig.tp2!=null?Number(sig.tp2):null;
  let pos=null;
  if(path==='proxy'){
    const q=await derivProposal({symbol:sig.symbol,side,amount:stake,duration:du.duration,duration_unit:du.duration_unit});
    const r=await derivConfirm(q.ticket);
    const o=r.order;
    pos={id:Date.now()+'_p'+o.contract_id,sym:sig.symbol,side,amt:stake,entry:px,sl,tp1,tp2,t:Date.now(),
      broker:'deriv',contract_id:o.contract_id,payout:o.payout,target:atTarget,
      dur:{duration:du.duration,duration_unit:du.duration_unit},flags:{at:true,proxy:true,env:r.environment,demo:!!r.demo}};
  }else if(path==='pat_server'){
    const q=await patCall(()=>patProposal(state.broker,{symbol:sig.symbol,side,amount:stake,duration:du.duration,duration_unit:du.duration_unit}));
    const r=await patConfirm(q.ticket);
    const o=r.order;
    if(o.balance_after!=null){ state.balance=Number(o.balance_after); updateKpis(); updateSessionInfo(); }
    pos={id:Date.now()+'_s'+o.contract_id,sym:sig.symbol,side,amt:stake,entry:px,sl,tp1,tp2,t:Date.now(),
      broker:'deriv',contract_id:o.contract_id,payout:o.payout,
      buy_price:o.buy_price||stake, settleAt:Date.now()+du.duration*(du.duration_unit==='m'?60000:du.duration_unit==='h'?3600000:du.duration_unit==='d'?86400000:1000),
      dur:{duration:du.duration,duration_unit:du.duration_unit},
      target:atTarget,flags:{at:true,pat_server:true}};
  }else if(path==='pat'){
    const g=await api('/api/deriv/order',{method:'POST',body:{symbol:sig.symbol,amount:stake,side,duration:du.duration,duration_unit:du.duration_unit,once:Date.now().toString(36)+Math.random().toString(36).slice(2,8)},headers:{'x-deriv-pat':state.broker.pat,'x-deriv-appid':state.broker.appId||'','x-aurum-user':state.user||'local'}});
    const gate=await g.json().catch(()=>({}));
    if(!g.ok)throw new Error(gate.detail||gate.error||'Rejected by server-side risk limits');
    const dsym=(INSTRUMENT_MAP[sig.symbol]||{}).deriv; if(!dsym)throw new Error('No Deriv symbol mapped for '+sig.symbol);
    const pr=await derivWsProposal(state.broker.appId,state.broker.pat,{derivSymbol:dsym,side,amount:stake,duration:du.duration,duration_unit:du.duration_unit});
    const o=await derivWsBuy(state.broker.appId,state.broker.pat,pr.id,pr.ask_price);
    pos={id:Date.now()+'_d'+o.contract_id,sym:sig.symbol,side,amt:stake,entry:px,sl,tp1,tp2,t:Date.now(),target:atTarget,
      broker:'deriv',contract_id:o.contract_id,payout:o.payout,dur:{duration:du.duration,duration_unit:du.duration_unit},flags:{at:true,pat:true}};
    api('/api/deriv/fill',{method:'POST',body:{kind:'open',contract_id:o.contract_id,stake:o.buy_price},headers:{'x-aurum-user':state.user||'local'}}).catch(()=>{});
  }else{
    const once=Date.now().toString(36)+Math.random().toString(36).slice(2,8);
    let orderAttempted=false, gateApproved=false, serverReserved=false, mt5OpenLimit=10;
    try{
      const g=await api('/api/risk/gate',{method:'POST',body:{
        amount:stake,venue:'mt5',once,
        entry:isNaN(px)?null:px, sl:isNaN(sl)?null:sl, tp:isNaN(tp1)?null:tp1,
        marketHours:true /* entry only fires from a live scan of open markets */,
        newsBlocked:false /* no event-ban policy active; the 25m STALE stand-down runs before this */
      },headers:{'x-aurum-user':state.user||'local'}});
      const gate2=await g.json().catch(()=>({}));
      if(!g.ok){
        if(isOnlyOpenTradesGateFailure(gate2))mt5OpenLimit=await verifyAndConfirmMt5OpenLimit(gate2);
        else throw new Error(mt5GateError(gate2));
      }else{
        gateApproved=true; serverReserved=true;
        const serverLimit=Number(gate2.limits?.maxOpenTrades);
        mt5OpenLimit=Number.isSafeInteger(serverLimit)&&serverLimit>0?serverLimit:10;
      }
      orderAttempted=true;
      const o=await bridge.placeBridgeOrder({symbol:sig.symbol.replace('/',''),side,volume:stake,sl:sl||0,tp:tp1||0,maxOpenTrades:mt5OpenLimit});
      gateApproved=false; // the local MT5 bridge is authoritative for open-position count
      if(serverReserved)api('/api/risk/fill',{method:'POST',body:{kind:'open',once},headers:{'x-aurum-user':state.user||'local'}}).catch(()=>{});
      pos={id:Date.now()+'_h'+(o.ticket||''),sym:sig.symbol,side,amt:stake,entry:o.price||px,sl,tp1,tp2,t:Date.now(),
        broker:'mt5',ticket:o.ticket,riskOnce:serverReserved?once:null,flags:{at:true}};
    }catch(e){
      const em=String(e.message||e);
      /* On gate/network failure, release is safe: order_send has not started.
         After order_send starts, retain on timeout/closed because fill is ambiguous. */
      if(gateApproved&&(!orderAttempted||!mt5ResultAmbiguous(em))) await releaseMt5RiskReservation(once);
      else if(!gateApproved&&!orderAttempted) await releaseMt5RiskReservation(once); // harmless 409 if gate never reserved
      throw e;
    }
  }
  state.positions.push(pos);
  atSession.entries++; atFails=0; save();
  renderNavCounts(); renderPortfolio();
  const envTag=pos.flags.demo?'DEMO · ':'';
  notify('Auto-trade entry',envTag+side+' '+sig.symbol+' @ '+fmtPx(pos.entry,(I&&I.d)||4)+' · stake '+fmtMoney(stake)+' · confidence '+(sig.confidence||0)+'% · entry '+atSession.entries+'/'+atCfg().maxTrades+'.',{tag:'auto',kind:'ok'});
  pushWA('🚨 SNIPER '+side+' '+sig.symbol+' @ '+fmtPx(pos.entry,(I&&I.d)||4)+' · stake '+fmtMoney(stake)+' · conf '+(sig.confidence||0)+'%'+(envTag?' · '+envTag.trim():''));
  toast('Auto-trade entry',side+' '+sig.symbol+' '+(sig.confidence||0)+'% · SL/TP armed','ok');
  atStatusUI('pos','entered '+sig.symbol+' '+(sig.confidence||0)+'% · trade #'+atSession.entries,'exit managed by SL/TP watcher');
}

/* ---------- Cloud sync (Supabase) settings + online history ---------- */
{
  const esc = (x) => String(x == null ? '' : x).replace(/[<>&\"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','\"':'&quot;'}[c]));
  const when = (t) => t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '—';
  const setMsg = (txt) => { const el = document.getElementById('cloudMsg'); if (el) el.textContent = txt; };
  const setPill = (txt, cls) => { const el = document.getElementById('cloudStatus'); if (el) { el.textContent = 'cloud · ' + txt; el.className = 'pill' + (cls ? ' ' + cls : ''); } };
  const value = (id) => document.getElementById(id)?.value || '';
  const setAuthButtons = () => {
    const signed = cloudAuthStatus().signedIn;
    const out = document.getElementById('cloudSignOut');
    if (out) out.style.display = signed ? '' : 'none';
    const si = document.getElementById('cloudSignIn'), su = document.getElementById('cloudSignUp');
    if (si) si.style.display = signed ? 'none' : '';
    if (su) su.style.display = signed ? 'none' : '';
  };
  const updateCloudState = () => {
    const cfg = cloudConfig(), auth = cloudAuthStatus();
    setAuthButtons();
    if (cfg && auth.signedIn) {
      setPill('signed in');
      setMsg('Signed in as ' + (auth.email || 'your Supabase user') + '. Select Save & test to verify secure history access.');
    } else if (cfg) {
      setPill('sign in');
      setMsg('Project saved on this device. Sign in with the same Supabase account on each device to sync.');
    } else {
      setPill('off');
      setMsg('Not connected — history stays on this device only.');
    }
  };
  const saveConfigFromForm = () => cloudSaveConfig(value('cloudUrl'), value('cloudKey'));
  const showVerifyResult = (result) => {
    if (result.ok) {
      setPill('connected');
      setMsg('Connected & verified — all four history tables are readable under your account RLS.');
      toast('Cloud sync', 'Supabase connected — your analysis history is online.', 'ok');
    } else if (result.reason === 'not_configured') {
      setPill('off'); setMsg('Enter the Project URL and publishable/anon key first.');
    } else if (result.reason === 'not_signed_in') {
      setPill('sign in'); setMsg('Project saved. Sign in or create a Supabase account before testing sync.');
    } else if (result.reason === 'session_expired') {
      setPill('sign in'); setMsg('Your cloud session expired. Sign in again; your saved history is unchanged.');
    } else if (result.reason === 'missing_tables') {
      const missing = (result.checks || []).filter(x => !x.ok).map(x => x.table);
      setPill('setup needed'); setMsg('Missing table(s): ' + missing.join(', ') + '. In Supabase SQL Editor, run migrations 0001_init.sql, 0002_signals.sql, then 0003_cloud_sync.sql; save & test again.');
    } else if (result.reason === 'auth_denied') {
      setPill('access denied'); setMsg('Supabase denied this account. Confirm the email, sign in to the intended project, and verify the migrations/RLS policies.');
    } else {
      setPill('error'); setMsg('Could not verify cloud tables. Check the Project URL, internet connection, Supabase status, and that the migrations completed.');
    }
  };

  const cfg0 = cloudConfig();
  if (cfg0) {
    const u = document.getElementById('cloudUrl'), k = document.getElementById('cloudKey');
    if (u) u.value = cfg0.url;
    if (k) k.value = cfg0.key;
  }
  updateCloudState();

  const cloudSignInBtn = document.getElementById('cloudSignIn');
  if (cloudSignInBtn) cloudSignInBtn.onclick = async () => {
    try {
      saveConfigFromForm();
      cloudSignInBtn.disabled = true; cloudSignInBtn.textContent = 'signing in…';
      const result = await cloudSignIn(value('cloudEmail'), value('cloudPassword'));
      const pass = document.getElementById('cloudPassword'); if (pass) pass.value = '';
      updateCloudState();
      toast('Cloud sync', 'Signed in. Save & test to verify the RLS tables.', 'ok');
      const v = await cloudVerifyTables();
      if (v.ok) showVerifyResult(v);
      else if (v.reason === 'missing_tables') showVerifyResult(v);
      else if (v.reason === 'auth_denied') showVerifyResult(v);
    } catch (e) {
      const pass = document.getElementById('cloudPassword'); if (pass) pass.value = '';
      setPill('sign-in failed'); setMsg(String(e.message || 'Sign-in failed. Check the email/password and Supabase Auth settings.').slice(0, 220));
      toast('Cloud sync', 'Sign-in failed; check the message below.', 'err');
    } finally { cloudSignInBtn.disabled = false; cloudSignInBtn.textContent = 'Sign in'; }
  };

  const cloudSignUpBtn = document.getElementById('cloudSignUp');
  if (cloudSignUpBtn) cloudSignUpBtn.onclick = async () => {
    try {
      saveConfigFromForm();
      cloudSignUpBtn.disabled = true; cloudSignUpBtn.textContent = 'creating…';
      const result = await cloudSignUp(value('cloudEmail'), value('cloudPassword'));
      const pass = document.getElementById('cloudPassword'); if (pass) pass.value = '';
      if (result.confirmationRequired) {
        setPill('confirm email');
        setMsg('Account created. Check your email for Supabase confirmation, then return and sign in on each device.');
        toast('Cloud sync', 'Confirm your email, then sign in.', 'ok');
      } else {
        updateCloudState();
        const v = await cloudVerifyTables();
        if (v.ok || v.reason === 'missing_tables' || v.reason === 'auth_denied') showVerifyResult(v);
        else setMsg('Account created and signed in. Select Save & test to verify tables.');
      }
    } catch (e) {
      const pass = document.getElementById('cloudPassword'); if (pass) pass.value = '';
      setPill('sign-up failed'); setMsg(String(e.message || 'Account creation failed. Check Supabase Auth settings.').slice(0, 220));
      toast('Cloud sync', 'Account creation failed; check the message below.', 'err');
    } finally { cloudSignUpBtn.disabled = false; cloudSignUpBtn.textContent = 'Create account'; }
  };

  const cloudSignOutBtn = document.getElementById('cloudSignOut');
  if (cloudSignOutBtn) cloudSignOutBtn.onclick = async () => {
    await cloudSignOut();
    updateCloudState();
    toast('Cloud sync', 'Signed out on this device. Cloud history remains in your project.');
  };

  const cloudSaveBtn = document.getElementById('cloudSave');
  if (cloudSaveBtn) cloudSaveBtn.onclick = async () => {
    try { saveConfigFromForm(); }
    catch (e) {
      setPill('error'); setMsg(String(e.message || e));
      toast('Cloud sync', String(e.message || e), 'err');
      return;
    }
    cloudSaveBtn.disabled = true; cloudSaveBtn.textContent = 'testing…';
    try { showVerifyResult(await cloudVerifyTables()); }
    finally { cloudSaveBtn.disabled = false; cloudSaveBtn.textContent = 'Save & test'; setAuthButtons(); }
  };

  const cloudClearBtn = document.getElementById('cloudClear');
  if (cloudClearBtn) cloudClearBtn.onclick = async () => {
    await cloudSignOut();
    cloudClearConfig();
    const u = document.getElementById('cloudUrl'), k = document.getElementById('cloudKey');
    if (u) u.value = ''; if (k) k.value = '';
    const p = document.getElementById('cloudPassword'); if (p) p.value = '';
    updateCloudState();
    toast('Cloud sync', 'Disconnected on this device. Cloud rows remain in Supabase.');
  };

  const histLoadBtn = document.getElementById('cldLoad');
  if (histLoadBtn) histLoadBtn.onclick = async () => {
    if (!cloudConfig() || !cloudAuthStatus().signedIn) {
      setPill(cloudConfig() ? 'sign in' : 'off');
      toast('Cloud not connected', 'Add the project URL/key and sign in under Settings → Cloud sync.', 'err');
      return;
    }
    histLoadBtn.disabled = true; histLoadBtn.textContent = 'loading…';
    const [a, p, al, sg] = await Promise.all([
      cloudList('analysis_history', 15), cloudList('pattern_events', 15),
      cloudList('alerts', 15), cloudList('signals', 15)
    ]);
    histLoadBtn.disabled = false; histLoadBtn.textContent = 'Load history';
    if (a == null && p == null && al == null && sg == null) {
      setPill('error'); toast('History', 'Could not read this account’s cloud history. Check login and migrations.', 'err'); return;
    }
    const body = document.getElementById('cldBody'), empty = document.getElementById('cldEmpty');
    if (empty) empty.hidden = true;
    if (body) body.hidden = false;
    const ta = document.getElementById('cldAnalyses');
    if (ta) ta.innerHTML = (a || []).length ? a.map((r, i) =>
      '<tr><td class="muted">' + (i + 1) + '</td><td>' + esc(r.kind) + '</td><td>' + esc(r.symbol) + '</td><td>' + esc(r.timeframe) + '</td><td class="right mono">' + when(r.created_at) + '</td></tr>').join('')
      : '<tr><td colspan="5" class="muted">No analyses saved yet — run a pattern scan.</td></tr>';
    const tp = document.getElementById('cldPatterns');
    if (tp) tp.innerHTML = (p || []).length ? p.map((r, i) =>
      '<tr><td class="muted">' + (i + 1) + '</td><td>' + esc(r.pattern_key) + '</td><td>' + esc(r.direction) + '</td><td>' + esc(r.action) + '</td><td class="right mono">' + esc(r.confidence) + '%</td><td>' + esc(r.status) + '</td><td class="right mono">' + when(r.created_at) + '</td></tr>').join('')
      : '<tr><td colspan="7" class="muted">No pattern events yet.</td></tr>';
    const tl = document.getElementById('cldAlerts');
    if (tl) tl.innerHTML = (al || []).length ? al.map((r, i) =>
      '<tr><td class="muted">' + (i + 1) + '</td><td>' + esc(r.title) + '</td><td>' + esc(r.body) + '</td><td class="right mono">' + when(r.created_at) + '</td></tr>').join('')
      : '<tr><td colspan="4" class="muted">No alerts yet.</td></tr>';
    const ts = document.getElementById('cldSignals');
    if (ts) ts.innerHTML = (sg || []).length ? sg.map((r, i) => {
      const approved=!!(r.aster&&r.aster.publishable===true&&r.aster.publicationBlocked!==true&&r.aster.publicationDecision!=='BLOCK_PUBLICATION');
      const visible=approved?r.signal:((r.signal==='BUY'||r.signal==='SELL')?'WITHHELD':r.signal);
      const cls = approved?({ BUY: 'up', SELL: 'down', WAIT: 'faint' }[r.signal] || 'faint'):'faint';
      const d = (bySym[r.symbol] && bySym[r.symbol].d) != null ? bySym[r.symbol].d : 4;
      const fx = (v) => (approved&&v != null ? Number(v).toFixed(d) : '—');
      return '<tr><td class="muted">' + (i + 1) + '</td><td><span class="' + cls + '">' + esc(visible) + '</span></td><td>' + esc(r.symbol) + '</td><td class="right mono">' + (approved?esc(r.confidence)+'%':'—') + '</td><td class="right mono">' + fx(r.entry_price) + '</td><td class="right mono">' + fx(r.stop_loss) + '</td><td class="right mono">' + fx(r.take_profit_1) + '</td><td class="tiny">' + esc(r.engine || 'technical') + (approved?'':' · ASTER not recorded') + '</td><td class="right mono">' + when(r.created_at) + '</td></tr>';
    }).join('')
      : '<tr><td colspan="9" class="muted">No signals yet — run an MTF analysis.</td></tr>';
    updateCloudState();
    setPill('connected');
  };
}

/* ---------- PWA: service worker + install button ---------- */
/* --- Deriv contract settlement watcher: poll Deriv for each open binary
   contract; on expiry Deriv credits the payout (win) or not (loss). We book
   the settled trade into history exactly like a manual close, then sync the
   authoritative balance from Deriv (account list) so demo AND real balances
   always end up correct. --- */
let derivSyncBusy=false;
async function syncDerivContracts(){
  if(derivSyncBusy)return;
  const open=(state.positions||[]).filter(p=>p.broker==='deriv'&&p.contract_id&&!p.settled);
  if(!open.length)return;
  if(!state.broker||state.broker.type!=='deriv')return;
  derivSyncBusy=true;
  try{
    /* ---- account reconciliation: Deriv is the source of truth. Pull the
       account's full open-contract list so EVERY device shows EVERY open
       contract (fixes "3 on the computer vs 1 on the phone"). ---- */
    try{
      const pres=await api('/api/deriv/pat/portfolio',{method:'POST',body:{sid:state.broker.sid,accountId:state.broker.accountId},headers:{'x-aurum-user':state.user||'local'}});
      if(pres.ok){
        const pj=await pres.json().catch(()=>null);
        const rows=(pj&&pj.contracts)||[];
        const rev={}; for(const [k,v] of Object.entries(DERIV_CODE_MAP||{})) rev[v]=k;
        const known=new Set(open.map((p)=>p.contract_id));
        let added=0;
        for(const c of rows){
          if(known.has(Number(c.contract_id)))continue;
          const raw=c.symbol||'', sym=rev[raw]||raw||'DERIV';
          state.positions.push({ id:'x'+c.contract_id, sym, side:c.contract_type==='PUT'?'SELL':'BUY',
            amt:c.buy_price||0, entry:null, t:c.date_start?c.date_start*1000:Date.now(),
            broker:'deriv', contract_id:c.contract_id, payout:c.payout, buy_price:c.buy_price,
            settleAt:c.date_settlement?c.date_settlement*1000:(c.date_expiry?c.date_expiry*1000:null),
            external:true, flags:{} });
          added++;
        }
        if(added){ save(); renderNavCounts(); renderPortfolio(); toast('Account sync',added+' open contract(s) synced from your Deriv account — this device now shows every trade on the account.','ok'); }
      }
    }catch(e){ /* reconciliation is best-effort; the per-contract watcher below still runs */ }
    for(const p of state.positions.filter((x)=>x.broker==='deriv'&&x.contract_id&&!x.settled)){
      try{
        const res=await api('/api/deriv/pat/contract_status',{method:'POST',body:{sid:state.broker.sid,accountId:state.broker.accountId,contract_id:p.contract_id},headers:{'x-aurum-user':state.user||'local'}});
        if(!res.ok)continue;
        const j=await res.json().catch(()=>null);
        const c=j&&j.contract; if(!c)continue;
        if(c.is_expired&&c.is_sold){
        const profit=(c.profit!=null)?Number(c.profit):(c.payout!=null?(Number(c.payout)-Number(p.buy_price||p.amt)):-Number(p.buy_price||p.amt));
        p.settled=true;
        state.history.unshift({sym:p.sym,side:p.side,amt:p.amt,entry:p.entry,exit:c.exit_spot!=null?Number(c.exit_spot):null,
          pl:profit,t:Date.now(),broker:'deriv',at:!!(p.flags&&p.flags.at),contract:p.contract_id,result:profit>=0?'won':'lost'});
        histPersist(); guardRecheckAfterClose();
        state.positions=state.positions.filter(x=>x.id!==p.id);
        if(p.flags&&p.flags.at&&typeof atSession!=='undefined'&&atSession){
          if(profit>=0)atSession.consecLosses=0;
          else atSession.consecLosses=(atSession.consecLosses||0)+1;
          if(atSession.consecLosses>=3){
            atSession.consecLosses=0;
            if((atCfg().brakes)==='stop'){
              notify('Sniper stood down','3 sniper losses in a row. Auto-trade is disarmed — review the Sniper record and re-arm when ready.',{tag:'auto',kind:'warn'});
              disableAutoTrade('loss','3 losses in a row — stood down (loss guard)');
            }else{
              notify('3 sniper losses in a row','Still running per your runs-until-stopped setting — watch the Sniper record; the server-side caps remain.',{tag:'auto',kind:'warn'});
            }
          }
        }
        if(typeof renderAtRecord==='function')renderAtRecord();
        save(); renderNavCounts(); renderPortfolio(); updateKpis();
        toast(profit>=0?'Contract won 🎉':'Contract lost',p.sym+' '+p.side+' · P&L '+fmtMoney(profit,true)+(state.balance!=null?(' · balance '+fmtMoney(state.balance)):''),profit>=0?'ok':'err');
        pushWA((profit>=0?'✅ WON ':'❌ LOST ')+p.sym+' '+p.side+' · P&L '+fmtMoney(profit,true)+' · balance '+fmtMoney(state.balance));
        notify(profit>=0?'Contract won':'Contract lost',p.sym+' '+p.side+' settled · P&L '+fmtMoney(profit,true)+' · contract #'+p.contract_id+'.',{tag:'trade',kind:profit>=0?'ok':'err'});
        }else{
          /* still open: refresh Deriv's own live valuation + sellability + expiry */
          if(c.is_expired){ p.liveProfit=null; p.settling=true; }
          else if(c.profit!=null)p.liveProfit=Number(c.profit);
          const wasSellable=!!p.canSell;
          p.canSell=!!c.can_sell;
          if(p.canSell&&!wasSellable){
            notify('Early exit unlocked',p.sym+' can now be closed before expiry — the Close button on its row is live.'+(p.profitTarget?' Your +$'+p.profitTarget+' target stays armed and closes it automatically if reached.':''),{tag:'trade',kind:'ok'});
            renderPortfolio();
          }
          /* target already reached while Deriv-locked: keep the force close armed */
          if(p.targetHit&&!p.canSell)p.closeOnUnlock=true;
          /* FORCE CLOSE QUEUE: user asked to stop this trade — the instant Deriv
             unlocks resale, close it for real (every 5s check, no babysitting) */
          if(p.canSell&&p.closeOnUnlock&&!p.__selling){
            p.__selling=true;
            notify('Force close executing',p.sym+' resale just unlocked — closing now as you queued.',{tag:'trade',kind:'ok'});
            Promise.resolve(closeWithBroker(p,null,'force close (unlocked)')).finally(()=>{ p.__selling=false; try{save();}catch(e){} });
          }
          if(c.date_settlement)p.settleAt=c.date_settlement*1000;
          else if(c.date_expiry)p.settleAt=c.date_expiry*1000;
          const tgt=p.profitTarget||((p.flags&&p.flags.at)?p.target:null);
          if(tgt&&!p.targetHit&&p.liveProfit!=null&&p.liveProfit>=tgt){
            p.targetHit=true; save(); renderPortfolio();
            if(p.canSell){
              notify('🎯 Target hit — closing',p.sym+' +'+fmtMoney(p.liveProfit,true)+' — resale allowed, booking the profit now.',{tag:'trade',kind:'ok'});
              closeWithBroker(p,null,'target reached');
            }else{
              p.closeOnUnlock=true; save(); /* target reached while locked — close the instant Deriv unlocks */
              notify('Profit target reached',p.sym+' +'+fmtMoney(p.liveProfit,true)+' — Deriv locks this contract to expiry; the profit is already yours at settlement.',{tag:'trade',kind:'ok'});
              toast('🎯 +'+fmtMoney(p.liveProfit,true)+' on '+p.sym,'Target hit. Deriv does not allow resale on this one — it settles '+(p.settleAt?('in '+expiresFmt(Math.max(0,Math.round((p.settleAt-Date.now())/1000)))):'moments')+' and the profit books automatically.','ok');
            }
          }
        }
      }catch(e){ /* skip this one this round; retried next cycle */ }
    }
    if(document.querySelector('#view-portfolio.active,#view-portfolio:not(.hidden)'))renderPortfolio();
    updatePortfolioLive();
    /* authoritative balance refresh (covers wins/losses server-side) */
    if(state.broker&&state.broker.type==='deriv'&&state.broker.sid){
      patRefreshAccounts().then((accts)=>{
        state.broker.accounts=accts;
        const cur=accts.find(a=>a.account_id===state.broker.accountId)||accts[0];
        if(cur&&cur.balance!=null){ state.balance=Number(cur.balance); save(); updateKpis(); renderPortfolio(); renderPatAccounts(); updateSessionInfo(); }
      }).catch(()=>{});
    }
  }finally{ derivSyncBusy=false; }
}
/* MT5-style live P&L: while contracts are open, poll Deriv's own valuation every
   5s (still Deriv's real numbers — no interpolation); 20s when idle. */
let derivSyncT=null;
function scheduleDerivSync(){
  if(derivSyncT)clearTimeout(derivSyncT);
  const open=(state.positions||[]).filter((p)=>p.broker==='deriv'&&p.contract_id&&!p.settled).length;
  derivSyncT=setTimeout(()=>{ try{ syncDerivContracts(); }catch(e){} scheduleDerivSync(); }, open?5000:20000);
}
scheduleDerivSync();
renderAuthDaily(); renderOvDaily(); refreshBestPick();
setInterval(()=>{ try{ refreshBestPick(); }catch(e){} },BEST_PICK_EVERY_MS);

/* --- activity login: any real use of the app (click/key) quietly restores
   the Deriv session from this computer's remembered token if the server
   dropped it (restart/deploy) — you notice nothing while you work. --- */
let lastActHeal=0;
['click','keydown'].forEach((ev)=>document.addEventListener(ev,()=>{
  if(Date.now()-lastActHeal<60000)return;
  lastActHeal=Date.now();
  try{
    if(state.broker&&state.broker.type==='deriv')return;            /* healthy */
    const sess=store.get('session',null);
    if(!sess||sess.mode!=='deriv')return;                            /* not a deriv session */
    if(!patStore.get())return;                                       /* nothing remembered */
    patHeal().catch(()=>{});
  }catch(e){}
},{passive:true}));

/* --- stale-tab guard: every deploy restarts the server and mints a new
   boot id. If the running page sees a different id, it was loaded before
   the latest deploy — show a Reload banner (this is how old UI survived
   across deploys and kept hitting fixed bugs). --- */
(async function(){
  const showBanner=()=>{
    if($('#buildBanner'))return;
    const b=document.createElement('div');
    b.id='buildBanner';
    b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;background:#8a6d1a;color:#fff;padding:8px 14px;font-size:13px;display:flex;gap:10px;align-items:center;justify-content:center';
    b.innerHTML='<span>The server was just updated — this page is running the previous version.</span>';
    const btn=document.createElement('button');
    btn.className='btn primary sm'; btn.textContent='Reload now';
    btn.onclick=()=>location.reload();
    b.appendChild(btn);
    document.body.appendChild(b);
  };
  const check=async()=>{
    try{
      const r=await api('/api/health'); if(!r||!r.ok)return;
      const j=await r.json().catch(()=>null); if(!j||!j.build)return;
      const prev=(()=>{try{return sessionStorage.getItem('aurum_build')}catch(e){return null}})();
      if(prev&&prev!==j.build)showBanner();
      try{sessionStorage.setItem('aurum_build',j.build)}catch(e){}
    }catch(e){}
  };
  check(); setInterval(check,60000);
})();
/* The app works without the offline shell, so a failed registration is not
   fatal — but it is reported on the console instead of being swallowed. */
registerServiceWorker();
{
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    const b = document.getElementById('installBtn');
    if (b) b.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    const b = document.getElementById('installBtn');
    if (b) b.classList.add('hidden');
  });
  const btn = document.getElementById('installBtn');
  if (btn) btn.onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch {}
    deferred = null;
    btn.classList.add('hidden');
  };
}

/* ---------- restore session ---------- */
applyTheme();
(function(){
  const s=store.get('session',null);
  if(!s)return;
  if(s.mode==='deriv'){
    const pat=patStore.get(), appId=patStore.getAppId();
    if(!pat||!appId){ store.del('session'); return; }
    const restore=async()=>{
      try{
        if(s.brokerMode==='pat_browser'||s.brokerMode==='cloud_readonly'||await isCloudflareHostedApp()){
          await connectDeriv(appId,pat);
        }else{
          const sess=await patConnect(appId,pat);
          state.broker={type:'deriv',mode:'pat_server',sid:sess.sid,accountId:sess.primary.account_id,appId,account:sess.primary,accounts:sess.accounts,limits:sess.limits,environment:sess.environment};
          state.balance=sess.primary.balance!=null?Number(sess.primary.balance):null;
          state.connections.deriv=true; save(); renderPatAccounts();
        }
        sessLog.add('restored','Auto-reconnected from this browser tab');
        resumeAutoTrade();
        showApp(s.name||'Deriv','deriv');
      }catch(e){
        store.del('session');
        sessLog.add('expired','Deriv session could not be restored — reconnect needed');
        showApp('Live','live');
        toast('Deriv reconnect needed',String(e.message||'The saved PAT session could not be restored. Reconnect from the Connect screen.'),'err');
      }
    };
    void restore();
    return;
  }
  if(s.mode==='mt5'){
    const restoreMt5=async()=>{
      if(await isCloudflareHostedApp()){
        store.del('session'); clearMt5Session();
        showApp('Live','live');
        toast('Exness stays local','Cloudflare staging does not read saved Exness credentials or contact the PC bridge. Open the local app at http://127.0.0.1:8788/app.','warn');
        return;
      }
      const m=readMt5Session();
      if(!m||!m.login||!m.password||!m.server){ store.del('session'); return; }
      const err=$('#authErr');
      if(err){err.textContent='Restoring your Exness connection…';err.style.display='block';}
      connectMt5(m.url||bridge.localBridgeWs(),m.login,m.password,m.server,m.token||'')
        .then(()=>{
          sessLog.add('restored','Exness reconnected from this browser tab');
          if(err)err.style.display='none';
          showApp(s.name||'Exness','mt5');
        })
        .catch(e=>{
          state.connections.mt5=false; save();
          const tab=$('#authTabMt5');if(tab)tab.click();
          if(err){err.textContent='Could not restore Exness connection: '+String(e.message||e)+'. Your details remain only in this browser tab; check that the PC bridge and MT5 terminal are running, then connect again.';err.style.display='block';}
          $('#authScreen').classList.remove('hidden');
        });
    };
    void restoreMt5();
    return;
  }
  const restoredName=(s.mode==='hfm'||s.name==='HFM')?'Live':(s.name||'Live');
  showApp(restoredName,'live');
})();

/* ---------- kill switch (master §16): Settings toggle ---------- */
{
  const btn=$('#killSwitchBtn'), stEl=$('#killSwitchState');
  if(btn){
    const paint=(on)=>{ if(!stEl)return; stEl.textContent=on?'ON — all new orders blocked':'off'; stEl.style.color=on?'var(--red,#e5484d)':'var(--muted,#8b93a7)'; };
    const refresh=async()=>{ try{ const r=await (await api('/api/ctl/killswitch')).json(); paint(!!r.enabled); }catch(_e){ if(stEl)stEl.textContent='?'; } };
    refresh();
    btn.onclick=async()=>{
      try{
        const cur=!!(await (await api('/api/ctl/killswitch')).json()).enabled;
        let diag='';
        if(!cur){ const v=prompt('Re-enabling trading requires the diagnostics key (AURUM_DIAG_KEY set on the server). Paste it, or leave empty if none is configured:'); if(v===null)return; diag=(v||'').trim(); }
        const r=await (await api('/api/ctl/killswitch',{method:'POST',body:{on:!cur},headers:diag?{'x-aurum-diag':diag}:{}})).json();
        if(r&&r.ok===false||r?.error){ toast('Kill switch',r.detail||r.error||'refused','err'); }
        else toast('Kill switch',r.enabled?'ALL new orders are now blocked server-side (closing positions stays allowed).':'Trading re-enabled.','ok');
        paint(!!r.enabled);
      }catch(e){ toast('Kill switch','Request failed: '+String(e.message||e),'err'); }
    };
  }
}

/* ---------- position sizer + trade planner (master §11) ---------- */
async function sizePlanSpecs(){
  /* contract specs come from the broker quote (volume_min/contract_size, 20a)
     — cached 30s; WITHOUT them the plan stays INCOMPLETE (never assumed) */
  const I=bySym[state.chart&&state.chart.sym];
  if(!I)return null;
  if(state.cfdSpec&&state.cfdSpec.sym===I.s&&Date.now()-state.cfdSpec.at<30000)return state.cfdSpec;
  if(state.broker&&state.broker.type==='mt5'){
    try{
      const q=await bridge.quoteBridge([I.s.replace('/','')]);
      const r=q&&q.quotes&&q.quotes[0];
      if(r&&r.volume_min>0&&r.contract_size>0){
        state.cfdSpec={sym:I.s,at:Date.now(),volumeMin:r.volume_min,contractSize:r.contract_size,ask:r.ask||null,bid:r.bid||null};
        return state.cfdSpec;
      }
    }catch(_e){}
  }
  return state.cfdSpec&&state.cfdSpec.sym===I.s?state.cfdSpec:null;
}
function renderSizePlan(){
  const el=document.getElementById('sizePlanBody'); if(!el)return;
  const I=bySym[state.chart&&state.chart.sym];
  const amt=parseFloat(($('#orderAmount')||{}).value), sl=parseFloat(($('#orderSL')||{}).value), tp=parseFloat(($('#orderTP')||{}).value);
  const riskPct=Number(($('#riskRange')||{}).value)||2;
  const acct=state.broker&&state.broker.account||{};
  const isMt5=state.broker?.type==='mt5';
  // Exness CFD risk sizing must use the terminal-reported equity; never substitute balance.
  const reportedEquity=isMt5&&acct.equity!=null&&Number.isFinite(Number(acct.equity))?Number(acct.equity):null;
  const equity=isMt5?reportedEquity:state.balance, equityCurrency=acct.currency||'USD';
  const fixedRisk=!isMt5;
  const plan=planPosition(fixedRisk
    ? {venue:'fixed',stake:isNaN(amt)?null:amt,currency:'USD',equity,riskPct}
    : {
        venue:'cfd',equity,equityCurrency,orderCurrency:'USD',
        conversionRate:(equityCurrency==='USD')?1:Number(($('#convRate')||{}).value)||null,
        riskPct,entry:(I&&I.p!=null)?I.p:null,
        sl:isNaN(sl)?null:sl,tp1:isNaN(tp)?null:tp,side:state.side||'BUY',
        contractSize:(state.cfdSpec&&state.cfdSpec.sym===(I&&I.s))?state.cfdSpec.contractSize:null,
        volumeMin:(state.cfdSpec&&state.cfdSpec.sym===(I&&I.s))?state.cfdSpec.volumeMin:null,
        volumeStep:(state.cfdSpec&&state.cfdSpec.sym===(I&&I.s))?Math.min(0.01,state.cfdSpec.volumeMin/10)||0.01:null,
        leverage:acct.leverage?Number(acct.leverage):null
      });
  const cur=plan.currency||'USD';
  let h='';
  const row=(k,v)=>'<div class="row between" style="gap:8px"><span class="faint">'+k+'</span><b class="mono">'+v+'</b></div>';
  if(isMt5){
    const equityText=reportedEquity==null?'unavailable — refresh/reconnect Exness':reportedEquity.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' '+escHtml(equityCurrency);
    const lev=Number(acct.leverage);
    const leverageText=acct.leverage!=null&&Number.isFinite(lev)&&lev>0?'1:'+lev.toLocaleString('en-US',{maximumFractionDigits:2}):'unknown — margin not estimated';
    h+=row('MT5 equity (latest broker snapshot)',equityText);
    h+=row('MT5 leverage',leverageText);
  }
  if(plan.status==='INCOMPLETE'){
    h+='<div style="color:var(--amber)">INCOMPLETE — '+escHtml(plan.reason)+'</div>';
    if(equityCurrency!=='USD'&&!Number(($('#convRate')||{}).value)){
      h+='<div class="row" style="margin-top:8px"><span>'+escHtml(equityCurrency)+'→USD rate (you supply — never fetched or assumed):</span><input class="input mono" id="convRate" type="number" step="any" style="width:110px" placeholder="e.g. 129"></div>';
      const cr=document.getElementById('convRate'); if(cr)cr.addEventListener('input',()=>{ state.settings.usdConvRate=Number(cr.value)||null; save(); renderSizePlan(); });
      if(state.settings.usdConvRate&&cr)cr.value=state.settings.usdConvRate;
    }
  }else if(plan.status==='BLOCKED'){
    h+='<div style="color:var(--red,#e5484d)">BLOCKED — '+escHtml(plan.reason)+'</div>';
    if(plan.minNotional)h+=row('Broker minimum exposure','≈ '+fmtMoney(plan.minNotional));
    if(plan.expectedLoss&&plan.status==='BLOCKED'&&plan.lots===0)h+=row('Min-lot risk at this stop',fmtMoney(plan.expectedLoss));
  }else{
    if(plan.lots!=null)h+=row('Valid size (rounded DOWN to broker step)','<b>'+plan.lots+' lots</b>');
    h+=row('Risk budget ('+escHtml(String(riskPct))+'% of equity)',fmtMoney(plan.riskBudget||0));
    h+=row('Expected loss at SL (max estimate)',fmtMoney(plan.expectedLoss||0)+(plan.currency!=='USD'?' '+escHtml(plan.currency):''));
    if(plan.notional!=null)h+=row('Notional exposure','≈ '+fmtMoney(plan.notional));
    if(plan.rr!=null)h+=row('Reward-to-risk (TP1)',plan.rr.toFixed(2)+'×');
    if(plan.marginEstimate!=null)h+=row('Estimated margin'+(plan.leverage?' @1:'+plan.leverage:''),'≈ '+fmtMoney(plan.marginEstimate));
    else h+=row('Estimated margin','— (leverage unknown, not assumed)');
    if(plan.tiers&&plan.lots!=null){
      h+='<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">';
      for(const t of ['SMALL','MEDIUM','FULL']){
        const v=plan.tiers[t];
        h+='<button type="button" class="chip size-tier" data-tier="'+t+'" '+(v==null?'disabled':'')+'>'+t+(v!=null?' '+v+'L':' (below min)')+'</button>';
      }
      h+='</div><div class="faint" style="margin-top:4px">Tiers only shrink — they never exceed the risk cap.</div>';
    }
    $$('#sizePlan .size-tier').forEach(b=>b.onclick=()=>{
      const v=plan.tiers[b.dataset.tier]; if(v==null)return;
      const spec=state.cfdSpec; const px=(I&&I.p)||0;
      if(spec&&px>0){ const usd=v*spec.contractSize*px; const amtEl=$('#orderAmount'); if(amtEl){ amtEl.value=Math.round(usd); toast('Sizer','Amount set to ≈'+fmtMoney(usd)+' ('+v+' lots at '+fmtPx(px,I&&I.d||2)+')','ok'); } }
    });
  }
  h+='<details class="faint" style="margin-top:8px"><summary style="cursor:pointer">Formula + assumptions</summary><div style="margin-top:6px">'+escHtml(plan.formula||'')+'</div>'+(plan.warnings||[]).map(w=>'<div>• '+escHtml(w)+'</div>').join('')+'</details>';
  el.innerHTML=h;
}
{ const wire=['orderAmount','orderSL','orderTP','orderTP2'];
  wire.forEach(id=>{ const el=document.getElementById(id); if(el)el.addEventListener('input',()=>renderSizePlan()); });
  const rr2=document.getElementById('riskRange'); if(rr2)rr2.addEventListener('input',()=>renderSizePlan());
  /* specs arrive from the broker quote (never assumed) — fetch, then render */
  renderSizePlan();
  sizePlanSpecs().then(()=>renderSizePlan()).catch(()=>{});
}

/* ---------- six-role pipeline workflow presentation (spec §5) ---------- */
async function loadPipelineFlow(){
  const box=$('#azResult'); const sym=($('#azSymbol')||{}).value; if(!box||!sym)return;
  const old=document.getElementById('pipelineFlow'); if(old)old.remove();
  const div=document.createElement('div'); div.id='pipelineFlow'; div.style.marginTop='12px';
  div.innerHTML='<div class="tiny faint">Six-role pipeline (SCOUT \u2192 NEWS \u2192 CHARTS \u2192 STRATEGY \u2192 RISK \u2192 BOSS) running\u2026</div>';
  box.appendChild(div);
  if(await isCloudflareHostedApp()){
    div.innerHTML='<div class="tiny faint">Cloudflare staging is technical-only. The AI / six-role pipeline is not migrated; Exness candles remain in this browser and are not sent to Cloudflare.</div>';
    return;
  }
  try{
    let body={symbol:sym,newsItems:Array.isArray(state.newsItems)?state.newsItems.slice(0,20):null},sourceLabel='';
    try{
      const bundle=await exnessSignalFor(bySym[sym],true);
      body.candleSets=bundle.candle_sets;body.dataSource='Exness MT5 local candles';sourceLabel='Exness MT5 local candles';
    }catch(exnessError){
      const fallback=(await scanSignalsPreferred([sym]))[0];
      if(!fallback||fallback.error)throw new Error((fallback&&fallback.detail)||String(exnessError&&exnessError.message||exnessError));
      sourceLabel=String(fallback.data_source||fallback.source||'source unavailable');
      if(sourceLabel.startsWith('Yahoo Finance'))throw new Error(sourceLabel+' is a daily index fallback; the M1/M5/H1 pipeline cannot represent it.');
    }
    const response=await api('/api/pipeline/analyze',{method:'POST',body,timeoutMs:30000});
    const r=await response.json();
    if(!response.ok)throw new Error(r&&r.detail||r&&r.error||'pipeline request failed');
    /* Six roles that judged the market as it was before a pause are not shown (a server that only marks its answer; the current one refuses above). */
    const held=r&&withheldReading({symbol:sym,candle_current:r.candle_current,candle_close:r.candle_close});
    if(held)throw new Error(held.detail);
    const p=r&&r.pipeline; if(!p)throw new Error(r&&r.detail||'no pipeline result');
    sourceLabel=sourceLabel||String(r.data_source||'source unavailable');
    const chip=(w)=>{
      const ok=w.state==='DONE', bad=w.state==='UNAVAILABLE';
      const cls=w.role==='BOSS'?(p.boss.verdict==='READY FOR MANUAL REVIEW'?'buy':(p.boss.verdict==='REJECTED'?'sell':'neutral')):(ok?'buy':(bad?'sell':'neutral'));
      return '<div style="flex:1;min-width:118px"><div class="badge tiny '+cls+'">'+w.role+' \u00b7 '+escHtml(String(w.state||''))+'</div><div class="tiny faint" style="margin-top:4px">'+escHtml(String(w.summary||'').slice(0,110))+'</div></div>';
    };
    div.innerHTML='<div class="tiny" style="font-weight:600;margin-bottom:6px">Six-role pipeline \u2014 Boss verdict: <b>'+escHtml(p.boss.verdict)+'</b> <span class="faint">\u00b7 source: '+escHtml(sourceLabel)+' \u00b7 '+(p.executes?'':'analysis only \u2014 this panel never executes')+'</span></div>'
      +'<div class="row" style="gap:6px;flex-wrap:wrap">'+p.workflow.map(chip).join('')+'</div>'
      +'<details class="tiny faint" style="margin-top:8px"><summary style="cursor:pointer">Role reports (timestamped, with evidence)</summary><pre style="white-space:pre-wrap;max-height:240px;overflow:auto">'+escHtml(JSON.stringify({
        scout:{score:p.scout.score,scoreLabel:p.scout.scoreLabel,direction:p.scout.direction,factors:p.scout.factors},
        news:{state:p.news.state,fresh:p.news.fresh.length,stale:p.news.stale.length,unknown:p.news.unknown.length,restriction:p.news.restriction,authorizes:p.news.authorizes},
        charts:{state:p.charts.state,mtfSignal:p.charts.mtfSignal,dataAgeSec:p.charts.dataAgeSec,votes:p.charts.votes},
        strategy:{setup:p.strategy.setup,conditions:p.strategy.conditions,version:p.strategy.version,expiry:p.strategy.expiry},
        risk:{verdict:p.risk.verdict,checks:p.risk.checks},
        boss:p.boss
      },null,1))+'</pre></details>';
  }catch(e){
    div.innerHTML='<div class="tiny" style="color:var(--amber)">Pipeline unavailable: '+escHtml(String(e.message||e))+'</div>';
  }
}

/* Startup marker for the guard script in index.html: reaching this line means
   the whole module evaluated without throwing. Keep it the LAST statement. */
window.__aurumAppStarted=true;
