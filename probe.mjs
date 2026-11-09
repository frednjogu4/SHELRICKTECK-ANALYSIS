import WebSocket from 'ws';
const candidates = [
  'wss://ws.derivws.com/websockets/v3?app_id=1089',
  'wss://api.derivws.com/websockets/v3?app_id=1089',
  'wss://ws.binaryws.com/websockets/v3?app_id=1089',
  'wss://ws.deriv.com/websockets/v3?app_id=1089',
];
const tryOnce = (url) => new Promise((res) => {
  const to = setTimeout(() => { try { ws.terminate(); } catch {} res('TIMEOUT'); }, 8000);
  const ws = new WebSocket(url);
  ws.on('unexpected-response', (_r, r) => { clearTimeout(to); res('HTTP ' + r.statusCode); });
  ws.on('error', (e) => { clearTimeout(to); res('ERR ' + String(e.message).slice(0, 60)); });
  ws.on('open', () => ws.send(JSON.stringify({ authorize: 'a1-fakeToken12345' })));
  ws.on('message', (raw) => {
    clearTimeout(to);
    try { const m = JSON.parse(raw); res(m.error ? ('OK-ish → ' + m.error.code + ': ' + String(m.error.message).slice(0, 50)) : ('OK → ' + m.msg_type)); }
    catch { res('BADJSON'); }
    try { ws.close(); } catch {}
  });
});
for (const u of candidates) {
  const r = await tryOnce(u);
  console.log(r.padEnd(60), u);
}
