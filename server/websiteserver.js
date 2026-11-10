/* ================================================================
 * AURUM — production WEBSITE server.
 * Serves the built single-file site from dist/ and proxies /api to
 * the Express API. This is exactly what a host would run:
 *
 *   npm run build      -> dist/index.html  (the whole website)
 *   npm run api        -> API on :4100
 *   npm run website    -> website on :5173 (this file)
 *
 * No framework, no deps — Node stdlib only. Binds 0.0.0.0 for the
 * sandbox preview; for a real deployment run behind HTTPS.
 * ================================================================ */

import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize, sep } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, '..', 'dist');
const PORT = Number(process.env.WEBSITE_PORT || 5173);
const API = { host: '127.0.0.1', port: Number(process.env.PORT || 4100) };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

async function fileResponse(path) {
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    const body = await readFile(path);
    return { status: 200, headers: { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'content-length': body.length }, body };
  } catch {
    return null;
  }
}

function proxyApi(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const upstream = new URL(req.url, `http://${API.host}:${API.port}`);
    const headers = { ...req.headers, host: `${API.host}:${API.port}` };
    delete headers['content-length'];
    if (body.length) headers['content-length'] = body.length;
    fetch(upstream, { method: req.method, headers, body: body.length ? body : undefined })
      .then(async (r) => {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
        res.end(buf);
      })
      .catch(() => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'api_unreachable', detail: `API not running on :${API.port} (npm run api)` }));
      });
  });
}

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/api/health' || url.startsWith('/api/')) return proxyApi(req, res);

  /* static site: single file for everything else */
  let p = normalize(join(DIST, url));
  /* Containment: the path must be dist/ itself or inside it. A bare prefix
     test also accepted sibling folders such as dist-backup/ or dist.old/. */
  if (p !== DIST && !p.startsWith(DIST + sep)) { res.writeHead(403); return res.end('forbidden'); }
  let out = await fileResponse(p);
  if (!out && !extname(p)) out = await fileResponse(join(DIST, 'index.html')); // SPA fallback
  if (!out) {
    out = await fileResponse(join(DIST, 'index.html'));
    if (out) out = { ...out, headers: { ...out.headers } };
  }
  if (!out) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('dist/ not found — run: npm run build');
  }
  res.writeHead(out.status, out.headers);
  res.end(out.body);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[aurum-website] serving dist/ on http://0.0.0.0:${PORT} (proxy /api -> :${API.port})`);
});
