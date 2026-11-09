/* ================================================================
 * AURUM — structured JSON logger with secret redaction.
 * Every line: {ts, level, scope, ...fields}. NEVER logs tokens:
 * anything matching pat_/sk-/pplx-/Bearer is redacted before output.
 * ================================================================ */

const SECRET_RE = /\b(pat_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|pplx-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+)/g;

export function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.replace(SECRET_RE, '[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|password|secret|api_?key/i.test(k) && typeof v === 'string' && v ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

function emit(level, scope, fields) {
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), level, scope }, redact(fields || {})));
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (scope, fields) => emit('info', scope, fields),
  warn: (scope, fields) => emit('warn', scope, fields),
  error: (scope, fields) => emit('error', scope, fields)
};

/* user-friendly messages for Deriv error codes — never leak internals */
const FRIENDLY = {
  InvalidSymbol: 'That symbol is not available on Deriv.',
  AuthorizationFailed: 'Deriv rejected the API token — check DERIV_API_TOKEN.',
  InvalidToken: 'Deriv rejected the API token — check DERIV_API_TOKEN.',
  RateLimit: 'Deriv rate limit hit — try again in a moment.',
  amount_lim: 'Stake exceeds your Deriv account limit.',
  InvalidStake: 'Stake not allowed for this contract.',
  insufficient: 'Insufficient balance in the Deriv account.',
  market_is_closed: 'That market is closed right now.',
  buyspot_err: 'Deriv could not fill the order.',
  proposal_expired: 'The price quote expired — request a new one.',
  '{"code":"WS"}': 'Deriv WebSocket error — reconnecting.'
};
export function friendlyDerivError(code, message) {
  if (code && FRIENDLY[code]) return FRIENDLY[code];
  if (message && FRIENDLY[message]) return FRIENDLY[message];
  if (code && /rate/i.test(String(code))) return FRIENDLY.RateLimit;
  return 'Deriv request failed' + (code ? ` (${code})` : '') + '.';
}
