/* ================================================================
 * AURUM — AI key vault (browser localStorage).
 * Keys are entered in Settings, stay on this device, and ride along
 * API calls as x-ai-* headers. Server env keys also work (header then
 * simply omitted). Never logged, never exported.
 * ================================================================ */

const KEY = 'aurum_aikeys';

export function getKeys() {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return { claude: v.claude || '', openai: v.openai || '', perplexity: v.perplexity || '' };
  } catch (e) {
    return { claude: '', openai: '', perplexity: '' };
  }
}

export function setKeys(keys) {
  const clean = {
    claude: String(keys.claude || '').trim(),
    openai: String(keys.openai || '').trim(),
    perplexity: String(keys.perplexity || '').trim()
  };
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch (e) { /* private mode */ }
  return clean;
}

export function clearKeys() { try { localStorage.removeItem(KEY); } catch (e) { /* noop */ } }

export function hasAnyKey() {
  const k = getKeys();
  return Boolean(k.claude || k.openai || k.perplexity);
}

/** Headers for fetch() — only include keys that exist. */
export function keyHeaders() {
  const k = getKeys();
  const h = {};
  if (k.claude) h['x-ai-claude'] = k.claude;
  if (k.openai) h['x-ai-openai'] = k.openai;
  if (k.perplexity) h['x-ai-perplexity'] = k.perplexity;
  return h;
}
