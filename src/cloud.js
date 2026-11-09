/* ================================================================
 * AURUM — Supabase Cloud Sync (browser REST client, no SDK).
 * The publishable/anon key is browser-safe; never use service_role or
 * sb_secret here. Rows are always scoped to the signed-in Supabase user
 * and protected again by RLS. Passwords are sent only to Supabase Auth
 * and are never stored. The short-lived auth session is tab-session-only.
 * ================================================================ */

const LS_URL = 'aurum.supabase.url';
const LS_KEY = 'aurum.supabase.key';
const SS_SESSION = 'aurum.supabase.session';
const HISTORY_TABLES = ['analysis_history', 'pattern_events', 'alerts', 'signals'];

export function cloudConfig() {
  try {
    const url = (localStorage.getItem(LS_URL) || '').replace(/\/+$/, '');
    const key = localStorage.getItem(LS_KEY) || '';
    return (url.startsWith('https://') && key) ? { url, key } : null;
  } catch { return null; }
}

function readSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SS_SESSION) || 'null');
    return s && typeof s.access_token === 'string' ? s : null;
  } catch { return null; }
}

function writeSession(data) {
  const session = data && data.session ? data.session : data;
  if (!session || typeof session.access_token !== 'string') return null;
  const old = readSession();
  const user = session.user || (data && data.user) || (old && old.user) || null;
  const expiresIn = Number(session.expires_in) || 3600;
  const expiresAt = Number(session.expires_at) || Math.floor(Date.now() / 1000) + expiresIn;
  const saved = {
    access_token: session.access_token,
    refresh_token: session.refresh_token || (old && old.refresh_token) || '',
    expires_at: expiresAt,
    user: user && { id: user.id, email: user.email || '' }
  };
  try { sessionStorage.setItem(SS_SESSION, JSON.stringify(saved)); } catch { return null; }
  return saved;
}

export function cloudAuthStatus() {
  const s = readSession();
  if (!s || !s.user || !s.user.id) return { signedIn: false, email: '' };
  return { signedIn: true, email: s.user.email || '' };
}

export function cloudSaveConfig(url, key) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/rest\/v1$/i, '');
  const k = String(key || '').trim();
  if (!u.startsWith('https://') || !k) throw new Error('Enter the https:// Project URL and publishable/anon key.');
  if (/service_role|sb_secret_/i.test(k)) throw new Error('That is a SECRET key. Use the publishable/anon key only.');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(u)) throw new Error('Enter the base Project URL only, e.g. https://your-project.supabase.co.');
  try {
    const previous = cloudConfig();
    localStorage.setItem(LS_URL, u);
    localStorage.setItem(LS_KEY, k);
    if (previous && (previous.url !== u || previous.key !== k)) cloudClearSession();
  } catch { throw new Error('Browser storage unavailable.'); }
  return cloudConfig();
}

export function cloudClearSession() {
  try { sessionStorage.removeItem(SS_SESSION); } catch {}
}

export function cloudClearConfig() {
  try { localStorage.removeItem(LS_URL); localStorage.removeItem(LS_KEY); } catch {}
  cloudClearSession();
}

function keyHeaders(cfg, extra = {}) {
  return Object.assign({
    apikey: cfg.key,
    'Content-Type': 'application/json'
  }, extra);
}

function userHeaders(cfg, session, extra = {}) {
  return Object.assign({
    apikey: cfg.key,
    Authorization: 'Bearer ' + session.access_token,
    'Content-Type': 'application/json'
  }, extra);
}

async function parseResponse(r) {
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const msg = String(data.message || data.msg || data.error_description || data.error || ('http ' + r.status));
    const err = new Error(msg.slice(0, 240));
    err.status = r.status;
    err.code = data.code || '';
    throw err;
  }
  return data;
}

async function authRequest(path, body, cfg = cloudConfig()) {
  if (!cfg) throw new Error('Add the Supabase Project URL and publishable/anon key first.');
  const r = await fetch(cfg.url + '/auth/v1/' + path, {
    method: 'POST',
    headers: keyHeaders(cfg),
    body: JSON.stringify(body || {})
  });
  return parseResponse(r);
}

export async function cloudSignUp(email, password) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const pass = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Enter a valid email address.');
  if (pass.length < 8) throw new Error('Use a password with at least 8 characters.');
  const data = await authRequest('signup', { email: cleanEmail, password: pass });
  const session = writeSession(data);
  return { ok: true, signedIn: !!session, confirmationRequired: !session, email: cleanEmail };
}

export async function cloudSignIn(email, password) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const pass = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || !pass) throw new Error('Enter your account email and password.');
  const data = await authRequest('token?grant_type=password', { email: cleanEmail, password: pass });
  const session = writeSession(data);
  if (!session || !session.user || !session.user.id) throw new Error('Sign-in returned no user session. Check email confirmation settings and try again.');
  return { ok: true, email: session.user.email || cleanEmail };
}

async function validSession() {
  const cfg = cloudConfig();
  let session = readSession();
  if (!cfg) return { ok: false, error: 'not_configured' };
  if (!session || !session.user || !session.user.id) return { ok: false, error: 'not_signed_in' };
  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at > now + 45) return { ok: true, cfg, session };
  if (!session.refresh_token) {
    cloudClearSession();
    return { ok: false, error: 'session_expired' };
  }
  try {
    const refreshed = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token }, cfg);
    session = writeSession(refreshed);
    if (!session || !session.user || !session.user.id) throw new Error('No user session returned.');
    return { ok: true, cfg, session };
  } catch {
    cloudClearSession();
    return { ok: false, error: 'session_expired' };
  }
}

export async function cloudSignOut() {
  const cfg = cloudConfig();
  const session = readSession();
  try {
    if (cfg && session) {
      await fetch(cfg.url + '/auth/v1/logout', {
        method: 'POST', headers: userHeaders(cfg, session)
      });
    }
  } catch {}
  cloudClearSession();
  return { ok: true };
}

export async function cloudVerifyTables(tables = HISTORY_TABLES) {
  const auth = await validSession();
  if (!auth.ok) return { ok: false, reason: auth.error };
  const checks = await Promise.all(tables.map(async (table) => {
    try {
      const r = await fetch(auth.cfg.url + '/rest/v1/' + table + '?select=*&limit=1', {
        headers: userHeaders(auth.cfg, auth.session)
      });
      let body = {};
      try { body = await r.json(); } catch {}
      return r.ok ? { table, ok: true } : { table, ok: false, status: r.status, code: body.code || '' };
    } catch { return { table, ok: false, code: 'unreachable' }; }
  }));
  const failed = checks.filter((x) => !x.ok);
  if (!failed.length) return { ok: true, checks };
  if (failed.some((x) => x.status === 401 || x.status === 403)) return { ok: false, reason: 'auth_denied', checks };
  if (failed.some((x) => x.code === 'PGRST205' || x.status === 404)) return { ok: false, reason: 'missing_tables', checks };
  return { ok: false, reason: 'read_failed', checks };
}

async function authenticatedHeaders(extra = {}) {
  const auth = await validSession();
  if (!auth.ok) return auth;
  return { ok: true, cfg: auth.cfg, session: auth.session, headers: userHeaders(auth.cfg, auth.session, extra) };
}

/** Append a row. Browser-provided user_id is overwritten from the signed-in session. */
export async function cloudInsert(table, row) {
  const auth = await authenticatedHeaders({ Prefer: 'return=minimal' });
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!/^[a-z_]+$/.test(table)) return { ok: false, error: 'bad_table' };
  try {
    const safeRow = Object.assign({}, row, { user_id: auth.session.user.id });
    const r = await fetch(auth.cfg.url + '/rest/v1/' + table, {
      method: 'POST', headers: auth.headers, body: JSON.stringify(safeRow)
    });
    if (!r.ok) {
      let msg = 'http ' + r.status;
      try { const j = await r.json(); msg = j.message || j.code || msg; } catch {}
      return { ok: false, error: String(msg).slice(0, 200) };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
}

/** Read only the signed-in user's rows; RLS is still the security boundary. */
export async function cloudList(table, limit = 20, filters = '') {
  const auth = await authenticatedHeaders();
  if (!auth.ok || !/^[a-z_]+$/.test(table)) return null;
  try {
    const qs = 'select=*&limit=' + Math.min(100, Math.max(1, limit | 0)) + (filters ? '&' + filters : '');
    const r = await fetch(auth.cfg.url + '/rest/v1/' + table + '?' + qs, { headers: auth.headers });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Convenience writers used by the app (all non-blocking to the UI). */
export const saveAnalysis = (kind, symbol, timeframe, payload) =>
  cloudInsert('analysis_history', { kind, symbol, timeframe, payload });

export const savePatternEvent = (d, symbol, timeframe, price) =>
  cloudInsert('pattern_events', {
    symbol, timeframe,
    pattern_key: d.key || d.pattern || 'unknown', direction: d.direction, action: d.action,
    confidence: d.confidence, status: d.status,
    price: price != null ? price : null,
    payload: { detail: d.detail, entry: d.entry, stop: d.stop, target: d.target }
  });

export const saveAlert = (channel, title, body) =>
  cloudInsert('alerts', { channel, title, body });

/** Full structured analysis row; stored as history, not an active/executable ticket. */
export const saveSignal = (d) => {
  const allowed = new Set(['1m', '5m', '15m', '1h', '4h', '1d', 'MTF']);
  const rawTf = String(d.timeframe || 'MTF');
  const tf = allowed.has(rawTf) ? rawTf : (allowed.has(rawTf.toLowerCase()) ? rawTf.toLowerCase() : 'MTF');
  return cloudInsert('signals', {
    symbol: d.symbol,
    timeframe: tf,
    signal: ['BUY', 'SELL', 'WAIT'].includes(d.signal) ? d.signal : 'WAIT',
    confidence: Math.max(0, Math.min(100, Number(d.confidence) | 0)),
    entry_price: d.entry != null ? d.entry : null,
    stop_loss: d.stop_loss != null ? d.stop_loss : null,
    take_profit_1: d.tp1 != null ? d.tp1 : null,
    take_profit_2: d.tp2 != null ? d.tp2 : null,
    risk_reward_ratio: d.rrr != null ? d.rrr : null,
    sentiment_score: d.sentiment_score != null ? d.sentiment_score : null,
    engine: d.engine || d.model || 'technical',
    rationale: d.rationale || '',
    technical_summary: d.technical_summary || '',
    key_levels: d.key_levels || {},
    risks: d.risks || [],
    active: false
  });
};
