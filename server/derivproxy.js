/* ================================================================
 * AURUM — /api/deriv proxy (HTTP routes + WebSocket relay).
 *
 * Spec compliance:
 *   - The browser talks ONLY to this proxy. The token lives in the
 *     server process (env) and is injected by lib/derivconn.js.
 *   - GET  /api/deriv/health     connection status (never the token)
 *   - GET  /api/deriv/candles    normalized candles, validated input
 *   - POST /api/deriv/proposal   step 1: fetch a quote (trading gated)
 *   - POST /api/deriv/confirm    step 2: user confirmed -> buy
 *   - POST /api/deriv/close      sell an open contract
 *   - WS   /api/deriv            transparent relay: client messages are
 *     forwarded verbatim EXCEPT authorize (rejected: server-side only);
 *     ping answered locally every client ping; responses/stream ticks
 *     forwarded back with req_id intact; subscriptions forgotten on
 *     disconnect (forget per stream id).
 * Server-side risk limits: trading OFF by default, max stake, max
 * open trades, daily loss limit — enforced before any proposal/buy.
 * ================================================================ */

import express from 'express';
import { WebSocketServer } from 'ws';
import { log, friendlyDerivError } from './lib/log.js';
import { rateLimit, parseGranularity, parseIntInRange, parseAmount, DURATION_UNITS } from './lib/limits.js';
import { DERIV_CODE_MAP, resolveSymbolInput } from './lib/symbols.js';
import { derivRequest } from './lib/derivfeed.js';

const TICKET_TTL_MS = 30000;
const MAX_TICKETS = 50;

export function createDerivRouter({ conn, config }) {
  const r = express.Router();
  const rl = rateLimit({ max: config?.derivRatePerMin ?? 60, name: 'deriv' });
  r.use(rl);

  /* in-memory trade ledger (process lifetime — see setup guide) */
  const ledger = {
    day: new Date().toISOString().slice(0, 10),
    openContracts: new Set(),
    dailyPnl: 0,
    peakLossHit: false
  };
  const rollDay = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (ledger.day !== today) { ledger.day = today; ledger.dailyPnl = 0; ledger.peakLossHit = false; }
  };
  const tickets = new Map(); // ticket -> {proposal_id, ask_price, payload, exp}
  const pruneTickets = () => {
    const now = Date.now();
    for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
    if (tickets.size > MAX_TICKETS) tickets.clear();
  };

  const gates = (req, res) => {
    const h = conn ? conn.health() : { state: 'not_configured', missing: ['DERIV_APP_ID', 'DERIV_API_TOKEN'] };
    if (!conn || h.state === 'not_configured') {
      res.status(503).json({ error: 'not_configured', missing: h.missing || [], hint: 'Set DERIV_APP_ID and DERIV_API_TOKEN in .env.local (see .env.example).' });
      return false;
    }
    if (!h.tradingEnabled) {
      res.status(403).json({ error: 'trading_disabled', hint: 'Set DERIV_TRADING_ENABLED=true to allow proposals/buys.' });
      return false;
    }
    if (!h.authorized) {
      res.status(503).json({ error: 'not_authorized', state: h.state, hint: 'Proxy has not completed {authorize} yet — check health.' });
      return false;
    }
    return true;
  };

  /* ---------------- health ---------------- */
  r.get('/health', (req, res) => {
    const h = conn ? conn.health() : { state: 'not_configured', missing: ['DERIV_APP_ID', 'DERIV_API_TOKEN'] };
    res.json(Object.assign({ ok: h.state !== 'error' }, h));
  });

  /* ---------------- market data (normalized) ---------------- */
  r.get('/candles', async (req, res) => {
    const symbol = resolveSymbolInput(req.query.symbol);
    if (!symbol) return res.status(400).json({ error: 'invalid_symbol', hint: 'Allowed: ' + Object.keys(DERIV_CODE_MAP).join(', ') });
    const granularity = parseGranularity(req.query.granularity);
    if (!granularity) return res.status(400).json({ error: 'invalid_granularity', allowed: [60, 180, 300, 900, 1800, 3600, 14400, 86400] });
    const count = parseIntInRange(req.query.count, 1, 1000, 500);
    const code = DERIV_CODE_MAP[symbol];
    try {
      if (conn && conn.health().state === 'authorized') {
        const rows = await conn.fetchCandles(code, granularity, count);
        return res.json({ symbol, source: 'deriv-auth', granularity, count: rows.length, candles: rows });
      }
    } catch (e) { log.warn('deriv.proxy', { event: 'auth_candles_failed', message: String(e.message).slice(0, 120) }); }
    /* public fallback: same data, no token — never fake */
    try {
      const rows = await derivRequest({ ticks_history: code, count, end: 'latest', style: 'candles', granularity }, 12000);
      const candles = (rows || []).map((c) => ({ time: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +(c.volume || 0) }));
      res.json({ symbol, source: 'deriv-public', granularity, count: candles.length, candles });
    } catch (e) {
      res.status(502).json({ error: 'deriv_unavailable', detail: String(e.message || e).slice(0, 140) });
    }
  });

  /* ---------------- trading: proposal -> confirm -> buy ---------------- */
  r.post('/proposal', async (req, res) => {
    rollDay();
    if (!gates(req, res)) return;
    const symbol = resolveSymbolInput(req.body?.symbol);
    if (!symbol) return res.status(400).json({ error: 'invalid_symbol' });
    const amount = parseAmount(req.body?.amount);
    const side = String(req.body?.side || '').toUpperCase();
    const duration = parseIntInRange(req.body?.duration, 1, 1440, 5);
    const duration_unit = DURATION_UNITS.includes(req.body?.duration_unit) ? req.body.duration_unit : 'm';
    if (!amount) return res.status(400).json({ error: 'invalid_amount' });
    if (side !== 'BUY' && side !== 'SELL') return res.status(400).json({ error: 'invalid_side', allowed: ['BUY', 'SELL'] });

    const h = conn.health();
    const L = h.limits || {};
    if (amount > (L.maxStakeUsd ?? 50)) {
      return res.status(400).json({ error: 'stake_limit', message: `Stake ${amount} exceeds max ${L.maxStakeUsd} USD per trade.` });
    }
    if (ledger.openContracts.size >= (L.maxOpenTrades ?? 5)) {
      return res.status(400).json({ error: 'max_open_trades', message: `Max ${L.maxOpenTrades} open trades — close one first.` });
    }
    if (ledger.dailyPnl <= -(L.dailyLossLimitUsd ?? 25)) {
      return res.status(403).json({ error: 'daily_loss_limit', message: `Daily loss limit ${L.dailyLossLimitUsd} USD reached — trading resumes tomorrow.`, dailyPnl: Math.round(ledger.dailyPnl * 100) / 100 });
    }

    try {
      const msg = await conn.request({
        proposal: 1, amount, basis: 'stake',
        contract_type: side === 'SELL' ? 'PUT' : 'CALL',
        currency: 'USD', duration, duration_unit,
        symbol: DERIV_CODE_MAP[symbol]
      });
      const p = msg.proposal;
      pruneTickets();
      const ticket = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      tickets.set(ticket, { proposal_id: p.id, ask_price: p.ask_price, payload: { symbol, side, amount, duration, duration_unit }, exp: Date.now() + TICKET_TTL_MS });
      /* step 1: return the QUOTE — nothing is bought until /confirm */
      res.json({
        ticket, expires_at: Date.now() + TICKET_TTL_MS,
        quote: {
          symbol, side, stake: amount, duration, duration_unit,
          proposal_id: p.id, ask_price: p.ask_price, payout: p.payout,
          display_price: p.display_value || String(p.ask_price),
          currency: p.currency || 'USD'
        },
        environment: h.environment, demo: h.environment === 'demo',
        requires_confirm: true
      });
    } catch (e) {
      res.status(400).json({ error: 'proposal_failed', message: e.message });
    }
  });

  r.post('/confirm', async (req, res) => {
    rollDay();
    if (!gates(req, res)) return;
    pruneTickets();
    const ticket = String(req.body?.ticket || '');
    const t = tickets.get(ticket);
    if (!t) return res.status(400).json({ error: 'ticket_expired', message: 'Quote expired or unknown — request a new proposal.' });
    tickets.delete(ticket);
    try {
      const msg = await conn.request({ buy: t.proposal_id, price: t.ask_price });
      const b = msg.buy;
      ledger.openContracts.add(String(b.contract_id));
      const h = conn.health();
      log.info('deriv.proxy', { event: 'buy', contract_id: b.contract_id, symbol: t.payload.symbol, side: t.payload.side, stake: t.payload.amount, environment: h.environment });
      res.json({
        ok: true,
        order: {
          contract_id: b.contract_id, symbol: t.payload.symbol, side: t.payload.side,
          stake: b.buy_price, payout: b.payout, duration: t.payload.duration,
          duration_unit: t.payload.duration_unit, bought_at: Date.now()
        },
        environment: h.environment, demo: h.environment === 'demo'
      });
    } catch (e) {
      res.status(400).json({ error: 'buy_failed', message: e.message });
    }
  });

  r.post('/close', async (req, res) => {
    if (!gates(req, res)) return;
    const contractId = Number(req.body?.contract_id);
    if (!contractId) return res.status(400).json({ error: 'contract_id_required' });
    const known = ledger.openContracts.has(String(contractId));
    try {
      const msg = await conn.request({ sell: contractId });
      ledger.openContracts.delete(String(contractId));
      res.json({ ok: true, result: { contract_id: contractId, sold_for: msg.sell?.price, sold_at: Date.now(), tracked: known } });
    } catch (e) {
      res.status(400).json({ error: 'close_failed', message: e.message });
    }
  });

  return r;
}

/* ================================================================
 * WS relay at /api/deriv — transparent, token-less, forget-safe.
 * ================================================================ */
export function attachDerivWs(httpServer, conn) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* noop */ }
    if (pathname !== '/api/deriv') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
  });

  const relay = (msg) => {
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      const st = client[kState];
      if (!st) continue;
      /* forward responses this socket asked for, plus any streaming ticks
         it subscribed to; server-internal traffic stays internal */
      if (msg.req_id != null && st.reqIds.has(msg.req_id)) {
        if (msg.subscription?.id) st.streams.add(msg.subscription.id);
        client.send(JSON.stringify(msg));
      } else if (msg.subscription && st.streams.has(msg.subscription.id)) {
        client.send(JSON.stringify(msg));
      }
    }
  };
  const kState = Symbol('derivWsState');
  if (conn && typeof conn.on === 'function') conn.on('message', relay);

  wss.on('connection', (client) => {
    const st = { reqIds: new Set(), streams: new Set() };
    client[kState] = st;
    log.info('deriv.ws', { event: 'client_open', clients: wss.clients.size });

    client.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch {
        client.send(JSON.stringify({ error: { code: 'BadJSON', message: 'Invalid JSON frame' } }));
        return;
      }
      /* security: token never comes from the browser */
      if (msg.authorize !== undefined) {
        client.send(JSON.stringify({
          req_id: msg.req_id ?? null,
          error: { code: 'ClientAuthorizeForbidden', message: 'Token is server-side only — the proxy has already authorized this connection.' }
        }));
        return;
      }
      if (msg.ping !== undefined) {
        client.send(JSON.stringify({ msg_type: 'ping', echo_req: { ping: 1 }, req_id: msg.req_id ?? null, ping: 'pong' }));
        return;
      }
      if (msg.type === 'aurum_health') {
        client.send(JSON.stringify({ type: 'aurum_health', health: conn ? conn.health() : { state: 'not_configured' } }));
        return;
      }
      if (!conn || !conn.wsOpen) {
        client.send(JSON.stringify({ req_id: msg.req_id ?? null, error: { code: 'ProxyNotReady', message: 'Deriv connection not ready — see /api/deriv/health' } }));
        return;
      }
      if (msg.req_id != null) st.reqIds.add(String(msg.req_id));
      conn._send(msg); // verbatim passthrough (request_id preserved)
    });

    client.on('close', () => {
      /* unsubscribe: forget every stream this view opened */
      for (const id of st.streams) conn && conn.forget(id);
      st.streams.clear(); st.reqIds.clear();
      log.info('deriv.ws', { event: 'client_close', forgotten: st.streams.size });
    });
    client.on('error', () => { /* noop */ });
  });

  return wss;
}
