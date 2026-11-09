/* AURUM API entrypoint:  npm run api   (default http://0.0.0.0:4100) */

import { fileURLToPath, pathToFileURL } from 'url';
import { createServer } from 'http';
import { join, dirname } from 'path';
import express from 'express';
import { existsSync } from 'fs';
import { createStore } from './lib/store.js';
import { createApp, configFromEnv } from './app.js';
import { createDerivConn } from './lib/derivconn.js';
import { attachDerivWs } from './derivproxy.js';
import { waAutoFeed } from './lib/wa.js';
import { parseRss, biasFor, RSS_SOURCES } from './lib/news.js';
import { log } from './lib/log.js';

import { waSend as waSendSafe } from './lib/wa.js';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const config = configFromEnv();
  const store = createStore(join(dirname(fileURLToPath(import.meta.url)), 'data', 'store.json'));

  /* server-side Deriv session: token from env only (fail-fast state,
     never crashes the platform — public data/analysis stay keyless) */
  const derivConn = createDerivConn(process.env);
  /* WhatsApp automatic news-signal feed (server-side, every 15 min, only when
     WA_AUTO_SHARE=true and credentials are set — otherwise this is a no-op). */
  setInterval(() => {
    waAutoFeed(async () => {
      const items = [];
      for (const src of RSS_SOURCES) {
        if (items.length >= 12) break;
        try {
          const r = await fetch(src.url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; aurum-news)' } });
          if (!r.ok) continue;
          for (const it of parseRss(await r.text())) {
            if (items.length >= 12) break;
            items.push({ title: it.title, link: it.link, source: src.name, published: it.published, bias: biasFor(it.title) });
          }
        } catch (e) { /* next source */ }
      }
      return items;
    }, waSendSafe).catch(() => {});
  }, 15 * 60 * 1000).unref();

  const app = createApp({ store, config, derivConn });

  /* single-port production hosting: serve the built PWA from the API
     process (Render/Railway/etc). /api and the Deriv WS stay as-is. */
  const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (existsSync(distDir)) {
    app.use(express.static(distDir, {
      setHeaders(res, filePath) {
        /* the single-file PWA ships fresh UI with every deploy — never let
           a browser keep serving a stale app shell after an update */
        if (String(filePath).endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      }
    }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(distDir, 'index.html'));
    });
    console.log('[aurum-api] serving dist/ (UI + API on one port)');
  } else {
    console.log('[aurum-api] dist/ not built — API only (run `npm run build` for the UI)');
  }

  /* keep the process alive on stray async errors — a crash restarts the
     container, which wipes in-memory PAT sessions and logs every user out */
  process.on('unhandledRejection', (r) => { console.log('[aurum-api] unhandledRejection:', String((r && r.stack) || r).slice(0, 300)); });
  process.on('uncaughtException', (e) => { console.log('[aurum-api] uncaughtException:', String((e && e.stack) || e).slice(0, 300)); });

  const httpServer = createServer(app);
  attachDerivWs(httpServer, derivConn);
  derivConn.start();

  const listenHost = process.env.HOST || '0.0.0.0';
  httpServer.listen(config.port, listenHost, () => {
    const eng = [config.apiKey && 'claude', config.openaiKey && 'chatgpt', config.perplexityKey && 'perplexity'].filter(Boolean);
    console.log(`[aurum-api] listening on http://${listenHost}:${config.port}`);
    console.log(`[aurum-api] feed=deriv-public engines=${eng.length ? eng.join('+') : 'none (technical mode)'} budget=$${config.dailyBudgetUsd}/day`);
    const h = derivConn.health();
    if (h.state === 'not_configured') {
      log.warn('deriv.conn', { event: 'not_configured', missing: h.missing, hint: 'trading endpoints return 503 until set (see .env.example)' });
    } else {
      console.log(`[aurum-api] deriv=${h.environment} trading=${h.tradingEnabled ? 'ON' : 'OFF(default)'} endpoint=${h.endpoint}`);
    }
  });
}
