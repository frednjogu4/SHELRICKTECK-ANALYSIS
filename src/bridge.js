/* ================================================================
 * AURUM — Exness (MT5) bridge client.
 * Talks to the LOCAL bridge process the user runs next to MetaTrader
 * 5 (default ws://127.0.0.1:8787 — configurable in Automation).
 * The bridge is NOT part of this app: until it is running the status
 * stays 'not running' and trading through Exness stays locked. No fake
 * connection states, ever.
 *
 * Bridge protocol (JSON text frames, every request carries an `id`
 * that the reply echoes back):
 *   -> {id, type:'login',    login, password, server}
 *   <- {id, type:'logged',   balance, equity, currency, account}
 *   -> {id, type:'order',    symbol, side, volume, sl, tp, max_open_trades, exec:'market'}
 *   <- {id, type:'filled',   ticket, price}
 *   -> {id, type:'close',    ticket}
 *   <- {id, type:'closed',   ticket, profit}
 *   -> {id, type:'positions'}
 *   <- {id, type:'positions', list:[{ticket,symbol,side,volume,price,profit,sl,tp}]}
 *   -> {id, type:'account'}
 *   <- {id, type:'account', balance, equity, margin_free, currency, leverage}
 *   -> {id, type:'symbols'} (authenticated local terminal catalogue)
 *   -> {id, type:'history', symbol, timeframe:'M1'|'M5'|'H1', count}
 * ================================================================ */

// Phase 1 Exness migration is read-only: keep this hard-coded OFF until a
// separate risk review and explicit user approval authorizes real execution.
const MT5_EXECUTION_ENABLED = false;

const statusCbs = new Set();
let sock = null;
let st = 'not_running'; // not_running | connecting | connected | error
let account = null;
let reqSeq = 1;
const pending = new Map();

const maskAccountId = (value) => {
  const text = String(value || '');
  if (/^[•*x]{3,}/i.test(text)) return text;
  return text.length > 4 ? '••••' + text.slice(-4) : '••••';
};

const isLoopback = (u) => {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '::1' || /^127\./.test(h);
  } catch (e) { return false; }
};
const isLocalHost = (u) => {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local');
  } catch (e) { return false; }
};
export function normalizeBridgeUrl(value) {
  const raw = String(value || '').trim();
  try {
    const u = new URL(raw);
    // Accept the common copy/paste mistake from the HTTP health-check URL,
    // but only rewrite private/local bridge hosts. A bridge still uses WS.
    if ((u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(raw)) {
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      return u.href.replace(/\/$/, '');
    }
  } catch (e) { /* leave validation to assertBridgeSafety */ }
  return raw;
}
function assertBridgeSafety(url, token) {
  let u; try { u = new URL(url); } catch (e) { throw new Error('Bridge URL is not valid: ' + url); }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error('Bridge URL must use WebSocket: ws://127.0.0.1:8787 on this PC (not http://).');
  }
  if (u.protocol === 'ws:' && !isLocalHost(url)) {
    throw new Error('Refusing unencrypted bridge to a public host (' + u.host + '). Use wss:// with TLS, or run the bridge on your home network (ws://<PC-IP>:8787 — the bridge window prints the address).');
  }
  if (!isLoopback(url) && !token) {
    throw new Error('A bridge on another device (' + u.host + ') requires a shared bridge token — SETUP_AND_RUN.bat stores it locally in bridge_token.txt; copy it into the Bridge token field on that device.');
  }
}

/** When the app is served over HTTPS but the bridge is plain ws:// on this
    machine, Chrome/Edge treat it as mixed content and may block it SILENTLY —
    which looks exactly like "bridge not running". Tell the user how to tell
    the two cases apart and how to allow the local connection. */
export function localBridgeWs(){
  try{
    const h=location.hostname;
    if((h==='127.0.0.1'||h==='localhost')&&(location.port==='8788'||location.port==='8787')) return 'ws://'+location.host;
    /* opened via the PC's LAN address (http://192.168.x.x:8788/app from a
       phone) -> the trading socket is on the same host, port 8787 */
    if(h && h!=='127.0.0.1' && h!=='localhost' && isLocalHost('ws://'+h+':8787/')) return 'ws://'+h+':8787';
  }catch(e){}
  return 'ws://127.0.0.1:8787';
}
function unreachableMsg(url, how) {
  let https = false;
  try { https = typeof location !== 'undefined' && location.protocol === 'https:' && /^ws:\/\//.test(url); } catch (e) {}
  const base = 'Bridge not reachable at ' + url + ' (' + how + ').';
  if (https) {
    let org = 'this site';
    try { org = String(location.origin || 'this site'); } catch (e) {}
    return base + ' THREE possible causes: (1) the bridge window is not running — start it with SETUP_AND_RUN.bat and wait for "listening on ws://127.0.0.1:8787"; (2) the browser is asking for LOCAL NETWORK permission — look for an "Allow … local network" bubble near the address bar, click Allow, then retry; or (3) the bridge IS running but this HTTPS page is blocked from opening a local ws:// connection — test http://127.0.0.1:8787 in a tab (it should say "AURUM bridge is UP"), then click the padlock → Site settings → Insecure content → Allow, reload, and retry. GUARANTEED ALTERNATIVE (local mode): with the bridge window running, open http://127.0.0.1:8788/app — the full workspace AND the trading socket served by the bridge itself on that one port (the URL fields auto-point there), nothing for the browser to block.'
      + ' DIAGNOSE: look at the bridge window right now — if NO "client connected" line appeared when you clicked Connect, the browser never delivered the connection (the bridge is NOT crashing): click any "Allow local network" bubble, pause VPN/proxy/antivirus web-shield, allow Insecure content for this site, and retry. If a "client connected" line DID appear and you still see this, the bridge refused THIS page\'s origin — add ' + org + ' to the AURUM_BRIDGE_ALLOWED_ORIGINS line in SETUP_AND_RUN.bat (keep aurum-staging.up.railway.app in the list), close the bridge window, run the bat again, and retry.';
  }
  return base + (/no answer|timeout/i.test(String(how))
    ? ' DIAGNOSE: look at the bridge window right now — if NO "client connected" line appeared, the browser never reached the bridge (the bridge is NOT crashing). Fix: open http://127.0.0.1:8788/app in Chrome or Edge (do not double-click app.html, do not use the installed https app), click any "Allow local network" bubble near the address bar, and pause VPN/proxy/antivirus web-shield while testing. If a "client connected" line DID appear, re-extract the latest FREDRICK_EXNESS_BRIDGE.zip.'
    : ' Start the bridge process next to MetaTrader 5 first (SETUP_AND_RUN.bat).');
}

/** Health preflight (audit Task 3.1): classifies unreachable vs running. */
function healthOnce(url, token) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { resolve({ ok: false, state: 'unreachable', message: unreachableMsg(url, e.message || 'invalid URL') }); return; }
    const done = (r) => { clearTimeout(t); try { ws.close(); } catch (e) {} resolve(r); };
    const t = setTimeout(() => done({ ok: false, state: 'unreachable', message: unreachableMsg(url, 'no answer in 4s') }), 4000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ id: 'h1', type: 'ping' })); } catch (e) {} };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id === 'h1') {
        if (m.type === 'error') done({ ok: false, state: 'protocol', message: 'Bridge reachable but answered the health ping with an error: ' + (m.message || 'unknown') });
        else done({ ok: true, state: 'running', message: 'Bridge running at ' + url + '.' });
      }
    };
    ws.onclose = () => { clearTimeout(t); resolve({ ok: false, state: 'unreachable', message: unreachableMsg(url, 'connection closed before a reply') }); };
    ws.onerror = () => {};
  });
}
/** Health preflight with a localhost/127.0.0.1 twin retry: some proxy/AV
    setups route one of the two names around the loopback. Returns the URL
    that actually answered so connect uses the same one. */
export function healthBridge(url, token) {
  url = normalizeBridgeUrl(url);
  const cands = [url];
  try {
    const u = new URL(url);
    if (u.hostname === '127.0.0.1') cands.push(url.replace('127.0.0.1', 'localhost'));
    else if (u.hostname === 'localhost') cands.push(url.replace('localhost', '127.0.0.1'));
  } catch (e) {}
  return (async () => {
    let last = null;
    for (const cand of cands) {
      const r = await healthOnce(cand, token);
      if (r.ok) return Object.assign(r, { url: cand });
      last = r;
    }
    if (await httpHealthProbe(url)) {
      return { ok: true, state: 'running', transport: 'http', url,
        message: 'Bridge answering over plain HTTP at ' + httpUrlFrom(url) + ' — the websocket upgrade is being intercepted (VPN/proxy/antivirus web-shield). Commands will ride HTTP automatically.' };
    }
    return Object.assign(last || { ok: false, state: 'unreachable', message: 'Bridge not reachable.' }, { url });
  })();
}

function setStatus(s, detail) {
  st = s;
  statusCbs.forEach((cb) => { try { cb(s, Object.assign({ account }, detail ? { detail } : {})); } catch (e) { /* noop */ } });
}

/** Live ticks from the bridge (index CFDs have no Deriv feed): symbols are the
 * app's base names ('US30'); the bridge resolves broker variants itself. */
export function quoteBridge(symbols) {
  return frame({ type: 'quote', symbols });
}
/** Discover the broker's exact index symbol names (US30Cash, US30M, …). */
export function searchBridge(query) {
  return frame({ type: 'search', query });
}

export function bridgeStatus() { return { status: st, account }; }
export function onBridgeStatus(cb) { statusCbs.add(cb); cb(st, { account }); return () => statusCbs.delete(cb); }

/* ---- 20j: plain-HTTP command transport ----
   A VPN/proxy/antivirus can intercept browser websocket upgrades while plain
   HTTP to the same port works fine (the page itself loaded, after all).
   When that happens the same commands ride POST /bridge instead. */
let httpBase = null;
let httpSid = null;
function httpUrlFrom(wsUrl) { return String(wsUrl || '').replace(/^ws/i, 'http').replace(/\/$/, ''); }
function newSid() { return 's' + Math.random().toString(36).slice(2, 12); }
function httpFrame(msg) {
  const id = 'r' + reqSeq++;
  return (async () => {
    const ctl = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? { signal: AbortSignal.timeout(8000) } : {};
    const r = await fetch(httpBase + '/bridge', Object.assign({
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-aurum-session': httpSid },
      body: JSON.stringify(Object.assign({ id, _sid: httpSid }, msg))
    }, ctl));
    const m = await r.json();
    if (m && m.type === 'error') throw new Error(m.message || 'bridge error');
    return m;
  })();
}
function httpHealthProbe(url) {
  return (async () => {
    try {
      const ctl = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? { signal: AbortSignal.timeout(4000) } : {};
      const r = await fetch(httpUrlFrom(url) + '/bridge', Object.assign({
        method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'hp', _sid: 'probe', type: 'ping' })
      }, ctl));
      const m = await r.json();
      return !!(m && m.type === 'pong');
    } catch (e) { return false; }
  })();
}
function frame(msg) {
  return new Promise((resolve, reject) => {
    if (!sock || sock.readyState !== 1) { if (httpBase) { httpFrame(msg).then(resolve, reject); return; } reject(new Error('bridge not connected')); return; }
    const id = 'r' + reqSeq++;
    pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error('bridge timeout')); }, 8000) });
    sock.send(JSON.stringify(Object.assign({ id }, msg)));
  });
}

/**
 * Connect + log in to the bridge.
 * @param {string} url e.g. ws://127.0.0.1:8787
 * @param {{login:string,password:string,server:string}} creds
 */
export function connectBridge(url, creds) {
  url = normalizeBridgeUrl(url);
  return new Promise((resolve, reject) => {
    disconnectBridge('switching');
    if (typeof WebSocket === 'undefined') { setStatus('error', 'no WebSocket support'); reject(new Error('no WebSocket support')); return; }
    try { assertBridgeSafety(url, creds && creds.token); } catch (e) { setStatus('error', e.message); reject(e); return; }
    setStatus('connecting');
    let usedHttp = false;
    let t = null;
    const fail = (msg) => {
      try { if (sock) sock.close(); } catch (e) { /* noop */ }
      sock = null;
      if (!usedHttp) { /* 20j: one transparent retry over plain HTTP */
        usedHttp = true;
        httpBase = httpUrlFrom(url); httpSid = newSid();
        setStatus('connecting');
        loginSeq();
        return;
      }
      httpBase = null; httpSid = null;
      setStatus('error', msg);
      reject(new Error(msg));
    };
    const loginSeq = () => {
      const start = creds && creds.token
        ? frame({ type: 'auth', token: creds.token })
        : Promise.resolve({ type: 'auth_skipped' });
      start
        .then((ar) => {
          if (ar && ar.type === 'error') throw new Error('Bridge token rejected — the secret must match the bridge configuration.');
          return frame({ type: 'login', login: creds.login, password: creds.password, server: creds.server || '', token: creds.token || '' });
        })
        .then((res) => {
          if (t) clearTimeout(t);
          if (res && res.type === 'logged') {
            account = { balance: res.balance, equity: res.equity, margin_free: res.margin_free, currency: res.currency, login: maskAccountId(res.account || creds.login), server: res.server || creds.server || '', terminal: res.terminal || '', leverage: res.leverage || null };
            setStatus('connected');
            resolve(account);
          } else {
            const m = (res && res.message) || '';
            if (/terminal|terminal_info|not logged|connect\(\)/i.test(m)) fail('Bridge running, but MT5 is not logged in — open MetaTrader 5 and sign in to your account. (' + m + ')');
            else if (/login|password|auth/i.test(m)) fail('Bridge running, MT5 login failed: ' + m);
            else fail('Bridge running, login refused: ' + (m || 'unknown reason'));
          }
        })
        .catch((e) => { if (t) clearTimeout(t); fail(String(e.message || e)); });
    };
    if (creds && creds.transport === 'http') { /* health already proved HTTP works */
      httpBase = httpUrlFrom(url); httpSid = newSid(); usedHttp = true;
      loginSeq();
      return;
    }
    try {
      sock = new WebSocket(url);
    } catch (e) {
      httpBase = httpUrlFrom(url); httpSid = newSid(); usedHttp = true;
      loginSeq();
      return;
    }
    t = setTimeout(() => fail('Bridge timeout — is the bridge process running next to MT5 on ' + url + '?'), 6000);

    sock.onopen = () => { loginSeq(); };
    sock.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.type === 'error') p.reject(new Error(m.message || 'bridge error'));
        else p.resolve(m);
        return;
      }
      if (m && m.type === 'error') setStatus('error', m.message);
      if (m && m.type === 'logged') { /* unsolicited status */ }
    };
    sock.onclose = () => {
      clearTimeout(t);
      pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('bridge closed')); });
      pending.clear();
      sock = null;
      account = null;
      if (st !== 'error') setStatus('not_running');
    };
    sock.onerror = () => { /* onclose follows */ };
  });
}

export function disconnectBridge(reason) {
  pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error(reason || 'disconnected')); });
  pending.clear();
  httpBase = null; httpSid = null;
  if (sock) { try { sock.close(); } catch (e) { /* noop */ } }
  sock = null;
  account = null;
  setStatus('not_running');
}

export function placeBridgeOrder(o) {
  if (!MT5_EXECUTION_ENABLED) return Promise.reject(new Error('Exness MT5 order execution is disabled in this local verification build. No order was sent; separate approval is required before execution can be enabled.'));
  /* NB: no duplicate `type` key here — the request type is 'order' and
     the execution mode rides in `exec` (a duplicate key would silently
     overwrite the request type in a JS object literal). */
  return frame({ type: 'order', symbol: o.symbol, side: o.side, volume: o.volume, sl: o.sl || 0, tp: o.tp || 0, max_open_trades: o.maxOpenTrades, exec: 'market' });
}
export function closeBridgeOrder(ticket) {
  if (!MT5_EXECUTION_ENABLED) return Promise.reject(new Error('Exness MT5 close execution is disabled in this local verification build. No close was sent; separate approval is required before execution can be enabled.'));
  return frame({ type: 'close', ticket });
}
export function bridgePositions() { return frame({ type: 'positions' }); }
export function bridgeAccount() { return frame({ type: 'account' }); }
export function bridgeSymbols() { return frame({ type: 'symbols' }); }
export function bridgeHistory(symbol, timeframe, count = 120) { return frame({ type: 'history', symbol, timeframe, count }); }

/* ================================================================
 * 20h — connection doctor: the in-app step-by-step walkthrough.
 * Runs the SAME sequence a human would, one link at a time, and
 * reports which link is broken with its exact fix. No guessing.
 * ================================================================ */
export async function diagnoseBridge(url, token, creds) {
  url = normalizeBridgeUrl(url);
  const steps = [];
  const add = (name, ok, detail) => { steps.push({ name, ok: ok === true ? true : ok === false ? false : null, detail }); };
  let pageHttps = false;
  try { pageHttps = location.protocol === 'https:'; } catch (e) {}
  const loopback = isLoopback(url);
  add('Environment', !(pageHttps && loopback),
    pageHttps && loopback
      ? 'This page is HTTPS but the bridge is on this PC — browsers block that combination by design. Fix: run the app from http://127.0.0.1:8788/app (the desktop icon). Nothing else is broken.'
      : 'page ' + (typeof location !== 'undefined' ? location.origin : '?') + ' \u2192 bridge ' + url);
  const httpBase = url.replace(/^ws/i, 'http').replace(/\/$/, '');
  try {
    const ctl = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? { signal: AbortSignal.timeout(3000) } : {};
    const r = await fetch(httpBase + '/up', Object.assign({ method: 'GET', cache: 'no-store' }, ctl));
    const txt = await r.text();
    add('Bridge HTTP reachable', r.ok, r.ok ? String(txt).split('\n')[0] : 'HTTP ' + r.status);
  } catch (e) {
    add('Bridge HTTP reachable', false, String(e.message || e) + ' \u2014 if this page is HTTPS that is the browser blocking local traffic; if the page is local, the black bridge window is not running.');
  }
  const probe = (msg, waitMs) => new Promise((resolve) => {
    let ws; try { ws = new WebSocket(url); } catch (e) { resolve({ ok: false, message: String(e.message || e) }); return; }
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ ok: false, message: 'no answer in 4s' }); }, waitMs);
    ws.onopen = () => { try { ws.send(JSON.stringify(msg)); } catch (e) {} };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || m.id !== msg.id) return;
      clearTimeout(t); try { ws.close(); } catch (e) {}
      resolve(m.type === 'error' ? { ok: false, message: m.message } : { ok: true, message: m.type, m });
    };
    ws.onclose = () => { clearTimeout(t); resolve({ ok: false, message: 'connection closed before a reply \u2014 the bridge window log says why (incoming ws upgrade / rejecting origin)' }); };
    ws.onerror = () => {};
  });
  const r3 = await probe({ id: 'd3', type: 'ping' }, 4000);
  add('Trading socket', r3.ok, r3.ok
    ? 'socket answered \u00b7 bridge ' + (r3.m && r3.m.bridge ? r3.m.bridge : 'version unknown \u2014 re-extract the latest FREDRICK_EXNESS_BRIDGE.zip')
    : r3.message);
  let httpOk = false;
  try {
    const ctl2 = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? { signal: AbortSignal.timeout(4000) } : {};
    const r = await fetch(httpUrlFrom(url) + '/bridge', Object.assign({
      method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'd3b', _sid: 'probe', type: 'ping' })
    }, ctl2));
    const m = await r.json();
    httpOk = !!(m && m.type === 'pong');
    add('Bridge commands over HTTP', httpOk, httpOk
      ? 'HTTP transport works \u2014 if the socket step failed, a VPN/proxy/antivirus is intercepting websockets; commands ride HTTP automatically'
      : 'unexpected reply: ' + String(JSON.stringify(m)).slice(0, 80));
  } catch (e) {
    add('Bridge commands over HTTP', false, String(e.message || e) + ' \u2014 nothing answered on the bridge port; the black window must be running');
  }
  if (r3.ok || httpOk) {
    if (token) {
      const r4 = await probe({ id: 'd4', type: 'auth', token }, 6000);
      add('Bridge token', r4.ok, r4.ok ? 'token accepted' : (r4.message || 'rejected') + ' \u2014 copy the local secret from bridge_token.txt');
      if (!r4.ok) { add('MT5 login', null, 'blocked until the token is accepted'); return steps; }
    } else {
      add('Bridge token', null, 'not filled \u2014 read it from the local bridge_token.txt file');
    }
    if (creds && creds.login && creds.password) {
      const r5 = await probe({ id: 'd5', type: 'login', login: creds.login, password: creds.password, server: creds.server || '', token: token || '' }, 8000);
      add('MT5 login', r5.ok, r5.ok
        ? ('logged in \u00b7 ' + (r5.m && r5.m.balance != null ? ('balance ' + r5.m.balance + ' ' + (r5.m.currency || '')) : 'account ready'))
        : ((r5.message || 'rejected') + ' \u2014 enter the exact Exness server from the Personal Area; read-only/investor password is sufficient'));
    } else {
      add('MT5 login', null, 'fill account, MT5 password, and exact server first, then run the test again');
    }
  } else {
    add('Bridge token', null, 'blocked until the trading socket answers');
    add('MT5 login', null, 'blocked until the trading socket answers');
  }
  return steps;
}
