/* ================================================================
 * AURUM — WhatsApp Cloud API sender (server-side).
 * Credentials live ONLY in server env vars: WA_PHONE_NUMBER_ID,
 * WA_TOKEN, WA_TO (destination, digits). WA_AUTO_SHARE=true enables
 * the automatic news-signal feed. The token is never logged and
 * never returned by any endpoint (status shows masked target only).
 * Without these vars the app honestly reports "not configured" and
 * the client falls back to one-tap wa.me deep links.
 * ================================================================ */

let lastSentAt = [];
let autoSeen = new Set(); /* de-dupe for the automatic feed (per process) */

export function waStatus() {
  const configured = Boolean(process.env.WA_PHONE_NUMBER_ID && process.env.WA_TOKEN && process.env.WA_TO);
  const to = String(process.env.WA_TO || '');
  return {
    configured,
    auto: configured && String(process.env.WA_AUTO_SHARE || '').toLowerCase() === 'true',
    to_masked: to ? '•••' + to.slice(-3) : '',
    hint: configured ? '' : 'Set WA_PHONE_NUMBER_ID, WA_TOKEN and WA_TO on the server (Meta WhatsApp Cloud API), then WA_AUTO_SHARE=true for automatic sharing.',
  };
}

export function waRateOk() {
  const now = Date.now();
  lastSentAt = lastSentAt.filter((t) => now - t < 60000);
  if (lastSentAt.length >= 10) return false;
  lastSentAt.push(now);
  return true;
}

/** Send a text message. Throws with a clean message on failure. */
export async function waSend(text) {
  const id = process.env.WA_PHONE_NUMBER_ID, token = process.env.WA_TOKEN, to = process.env.WA_TO;
  if (!id || !token || !to) throw new Error('WhatsApp is not configured on the server');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(id) + '/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body: String(text).slice(0, 1200) } })
    });
    if (!r.ok) {
      let code = 'http ' + r.status;
      try { const j = await r.json(); code = (j.error && (j.error.message || j.error.type)) || code; } catch (e) {}
      throw new Error('WhatsApp API: ' + String(code).slice(0, 120));
    }
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Automatic feed: push NEW directional headlines. Returns count sent. */
export async function waAutoFeed(fetchItems, send) {
  const st = waStatus();
  if (!st.auto) return 0;
  const items = (await fetchItems()).filter((it) => it.bias && it.bias.dir && it.bias.pair);
  let n = 0;
  for (const it of items) {
    if (autoSeen.has(it.link)) continue;
    autoSeen.add(it.link);
    if (autoSeen.size > 500) autoSeen = new Set([...autoSeen].slice(-200));
    try {
      if (!waRateOk()) break;
      await send('🚨 ' + (it.bias.pair) + ' ' + it.bias.dir + ' (heuristic news read)\n' + it.title + '\n' + it.link + '\nHeuristic — not AI, not advice.');
      n++;
    } catch (e) { /* skip and continue */ }
  }
  return n;
}
