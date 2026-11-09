/* ================================================================
 * AURUM — Deriv proxy client (browser side).
 * The browser talks ONLY to our own /api/deriv endpoints.
 * The API token never reaches this process: no headers, no query,
 * no sessionStorage — the proxy injects it server-side.
 * ================================================================ */

export async function derivHealth() {
  try {
    const r = await fetch('/api/deriv/health');
    return await r.json();
  } catch {
    return { state: 'offline' };
  }
}

export async function derivCandles(symbol, granularity = 300, count = 300) {
  const r = await fetch(`/api/deriv/candles?symbol=${encodeURIComponent(symbol)}&granularity=${granularity}&count=${count}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || j.error || 'candles failed');
  return j;
}

/** Step 1 of the confirm flow: get a QUOTE (nothing is bought). */
export async function derivProposal({ symbol, side, amount, duration = 5, duration_unit = 'm' }) {
  const r = await fetch('/api/deriv/proposal', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol, side, amount, duration, duration_unit })
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.message || j.error || 'proposal failed'), { code: j.error, hint: j.hint });
  return j;
}

/** Step 2: user pressed "Confirm trade" — now the buy happens. */
export async function derivConfirm(ticket) {
  const r = await fetch('/api/deriv/confirm', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket })
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.message || j.error || 'confirm failed'), { code: j.error });
  return j;
}

export async function derivClose(contractId) {
  const r = await fetch('/api/deriv/close', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contract_id: contractId })
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.message || j.error || 'close failed'), { code: j.error });
  return j;
}

/* ---------------- live tick feed over the WS relay ---------------- */
let _ws = null;
const _subs = new Set();
const _subscribed = new Set(); // symbols with an active ticks subscription

export function tickFeed(symbol, onTick) {
  const listener = (t) => {
    if (t && t.error && !t.symbol) return;              // subscription errors
    if (t && t.symbol && t.symbol !== symbol) return;   // other feeds
    try { onTick(t); } catch { /* noop */ }
  };
  _subs.add(listener);

  const ensureWs = () => {
    if (_ws && _ws.readyState <= 1) return _ws;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try { _ws = new WebSocket(`${proto}://${location.host}/api/deriv`); }
    catch { _ws = null; onTick({ error: 'ws_blocked' }); return null; }
    _ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.msg_type === 'tick' && m.tick) _subs.forEach((c) => c(m.tick));
      else if (m.error && m.req_id != null) _subs.forEach((c) => c({ error: m.error.code || m.error.message }));
    };
    _ws.onclose = () => { _ws = null; _subscribed.clear(); };
    return _ws;
  };

  const send = () => {
    const w = ensureWs();
    if (!w) return;
    const doSub = () => {
      if (!_subscribed.has(symbol)) {
        _subscribed.add(symbol);
        w.send(JSON.stringify({ ticks: derivCode(symbol), subscribe: 1, req_id: Date.now() % 1e9 }));
      }
    };
    if (w.readyState === 1) doSub();
    else { const prev = w.onopen; w.onopen = (e) => { try { prev && prev.call(w, e); } catch { /* noop */ } doSub(); }; }
  };
  send();

  return () => {
    _subs.delete(listener);
    if (_subs.size === 0 && _ws && _ws.readyState === 1) {
      _ws.send(JSON.stringify({ forget_all: 'ticks' }));
      _subscribed.clear();
    }
  };
}

/* internal -> Deriv code (small client copy; server is authoritative) */
const DERIV_CODE = {
  'EUR/USD': 'frxEURUSD', 'GBP/USD': 'frxGBPUSD', 'USD/JPY': 'frxUSDJPY',
  'AUD/USD': 'frxAUDUSD', 'USD/CHF': 'frxUSDCHF', 'USD/CAD': 'frxUSDCAD',
  'NZD/USD': 'frxNZDUSD', 'EUR/JPY': 'frxEURJPY', 'GBP/JPY': 'frxGBPJPY',
  'EUR/GBP': 'frxEURGBP', 'XAU/USD': 'frxXAUUSD', 'XAG/USD': 'frxXAGUSD',
  'BTC/USD': 'cryBTCUSD', 'ETH/USD': 'cryETHUSD', 'VOL 25': 'R_25',
  'VOL 75': 'R_75', 'VOL 100': 'R_100', 'BOOM 1000': 'BOOM1000',
  'CRASH 1000': 'CRASH1000', 'STEP': 'stpRNG'
};
function derivCode(sym) {
  const k = String(sym).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const [name, code] of Object.entries(DERIV_CODE)) {
    if (name.replace(/[^A-Z0-9]/g, '').toUpperCase() === k) return code;
  }
  return sym;
}
