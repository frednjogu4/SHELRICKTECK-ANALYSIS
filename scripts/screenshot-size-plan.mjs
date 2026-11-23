#!/usr/bin/env node
/* Screenshot harness for the Position sizer risk panel (diagnostic report).
 *
 * Usage:
 *   npx vite --host 127.0.0.1 --port 5199 &        # serve the app unminified
 *   npm install --no-save puppeteer-core @sparticuz/chromium
 *   node scripts/screenshot-size-plan.mjs [baseUrl] [outDir]
 *
 * It instruments /src/main.js IN TRANSIT (response interception only — the file
 * on disk is never modified) to expose the module-scoped state and renderer,
 * injects the reported broker snapshot (MT5 demo account, XAUUSD), and captures
 * the panel at desktop and mobile viewports. No broker connection is made. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const base = process.argv[2] || 'http://127.0.0.1:5199';
const outDir = process.argv[3] || 'docs/screenshots';

const SHOT_STATE = {
  broker: {
    type: 'mt5',
    account: {
      equity: 71.67, balance: 71.67, margin_free: 71.67,
      currency: 'USD', leverage: 400, environment: 'demo', trade_mode: 0,
    },
  },
  spec: {
    sym: 'XAU/USD', volumeMin: 0.01, volumeStep: 0.01, volumeMax: 200,
    contractSize: 100, currencyBase: 'XAU', currencyProfit: 'USD',
    ask: 3684.79, bid: 3684.03, brokerSymbol: 'XAUUSDm',
    point: 0.01, tickSize: 0.01, tickValue: 1, stopsLevel: 0, digits: 2,
    category: 'metals', specSource: 'local MT5 terminal',
  },
  chartSym: 'XAU/USD',
  side: 'BUY',
  amount: 100, sl: 3653.29, tp: 3700,
};

async function main() {
  await mkdir(outDir, { recursive: true });
  const executablePath = await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--no-sandbox'],
    executablePath,
    headless: 'shell',
    defaultViewport: { width: 1440, height: 1100, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    /* The app registers a service worker; SW-served requests bypass page-level
       interception, which would drop the instrumentation hook on reloads. */
    await page.setBypassServiceWorker(true);
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      let pathname = '';
      try { pathname = new URL(req.url()).pathname; } catch (_e) { /* ignore */ }
      if (pathname.endsWith('/src/main.js')) {
        try {
          const res = await fetch(req.url());
          let body = await res.text();
          const hook = 'window.__aurumAppStarted=true;';
          if (body.includes(hook)) {
            body = body.replace(hook,
              hook + 'window.__shot={state,renderSizePlan};');
          }
          await req.respond({ status: 200, headers: { 'content-type': 'text/javascript' }, body });
          return;
        } catch (_e) { /* fall through */ }
      }
      req.continue();
    });

    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    const setupPanel = async () => {
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        ready = await page.evaluate(() => !!(window.__aurumAppStarted && window.__shot)).catch(() => false);
        if (!ready) await new Promise((r) => setTimeout(r, 500));
      }
      if (!ready) {
        const diag = await page.evaluate(() => ({
          href: location.href, started: window.__aurumAppStarted, shot: !!window.__shot,
          ready: document.readyState, view: document.body.dataset.view,
        })).catch((e) => String(e));
        throw new Error('setup timeout: ' + JSON.stringify(diag));
      }
      const authVisible = await page.evaluate(() => {
        const a = document.getElementById('authScreen');
        return !!a && !a.classList.contains('hidden');
      });
      if (authVisible) await page.$eval('#guestBtn', (el) => el.click());
      await new Promise((r) => setTimeout(r, 400));
      await page.$eval('[data-view="trade"]', (el) => el.click());
      await new Promise((r) => setTimeout(r, 300));
      await page.evaluate((S) => {
        const { state } = window.__shot;
        state.broker = S.broker;
        state.cfdSpec = Object.assign({}, S.spec, { at: Date.now(), quoteAt: Date.now() });
        state.chart = { sym: S.chartSym };
        state.side = S.side;
        const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); } };
        set('orderAmount', S.amount);
        set('orderSL', S.sl);
        set('orderTP', S.tp);
        window.__shot.renderSizePlan();
      }, SHOT_STATE);
      await new Promise((r) => setTimeout(r, 300));
    };

    await setupPanel();

    /* Hide fixed/sticky chrome that would overlay the element capture. */
    const hideOverlays = () => page.evaluate(() => {
      const card = document.getElementById('sizePlan');
      if (!card) return;
      const c = card.getBoundingClientRect();
      document.querySelectorAll('body *').forEach((el) => {
        if (el === card || card.contains(el)) return;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
        const r = el.getBoundingClientRect();
        if (r.width > 80 && r.height > 20 && r.bottom > c.top && r.top < c.bottom) el.style.visibility = 'hidden';
      });
    });

    const card = await page.$('#sizePlan');
    if (!card) throw new Error('#sizePlan panel not found');
    await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await new Promise((r) => setTimeout(r, 200));
    await hideOverlays();
    const desktop = join(outDir, 'size-plan-desktop.png');
    await card.screenshot({ path: desktop });

    // Mobile viewport (390×844, iPhone-class) — panel must stay readable.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await new Promise((r) => setTimeout(r, 500));
    await setupPanel();
    const mobileCard = await page.$('#sizePlan');
    if (!mobileCard) throw new Error('#sizePlan not found (mobile)');
    await mobileCard.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await new Promise((r) => setTimeout(r, 200));
    await hideOverlays();
    const mobile = join(outDir, 'size-plan-mobile.png');
    await mobileCard.screenshot({ path: mobile });
    const cardForText = mobileCard;

    // Sanity: the panel must show the BLOCKED explanation with the real numbers.
    const text = await cardForText.evaluate((el) => el.innerText);
    const required = ['Below the broker minimum', '3,684.79', '31.50', '0.36', 'Account type (MT5-verified)', 'Broker specification source', 'Exposure limit', 'Estimated margin at minimum size'];
    const missing = required.filter((s) => !text.includes(s));
    await writeFile(join(outDir, 'size-plan-panel.txt'), text, 'utf8');
    if (missing.length) throw new Error('panel missing expected content: ' + missing.join(', '));
    console.log('OK', desktop, mobile);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
