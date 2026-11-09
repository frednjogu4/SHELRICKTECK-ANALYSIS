/* Current-tab MT5 convenience identity. Deliberately limited to account
   login and exact server; callers must never pass a password or bridge token. */
export const MT5_IDENTITY_KEY = 'aurum_mt5_account_server';

export function readMt5Identity(storage = globalThis.sessionStorage) {
  try {
    const value = JSON.parse(storage.getItem(MT5_IDENTITY_KEY) || '{}');
    return {
      login: typeof value.login === 'string' ? value.login : '',
      server: typeof value.server === 'string' ? value.server : '',
    };
  } catch (_error) {
    return { login: '', server: '' };
  }
}

export function saveMt5Identity(login, server, storage = globalThis.sessionStorage) {
  try {
    const value = { login: String(login || '').trim(), server: String(server || '').trim() };
    if (!value.login && !value.server) storage.removeItem(MT5_IDENTITY_KEY);
    else storage.setItem(MT5_IDENTITY_KEY, JSON.stringify(value));
  } catch (_error) {
    /* Storage can be unavailable in private/browsing-restricted contexts. */
  }
}

export function forgetMt5Identity(storage = globalThis.sessionStorage) {
  try { storage.removeItem(MT5_IDENTITY_KEY); } catch (_error) { /* best effort */ }
}
