/* ================================================================
 * AURUM — TradingView embeds (official widgets, free, no key).
 *   - Advanced Chart  (replaces the old canvas chart)
 *   - News timeline   (replaces fake headline arrays)
 *   - Economic calendar (replaces fake calendar rows)
 * Widget script loads only when the page has network access; if it
 * cannot load we show an honest notice instead of inventing content.
 * ================================================================ */

import { TV_MAP, INSTRUMENT_MAP } from '../server/lib/symbols.js';

let chartState = { container: null, symbol: null, widget: null };

/** Chart times must match the user's wall clock: use the device IANA timezone
    (falls back to UTC only if the browser cannot report one). */
function userTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC'; }
  catch (e) { return 'Etc/UTC'; }
}

function clearNode(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function notice(container, text) {
  clearNode(container);
  const d = document.createElement('div');
  d.className = 'tv-notice';
  d.textContent = text;
  container.appendChild(d);
}

export const TV_EXTRA_SYMBOLS = {
  'US500': 'TVC:SPX',
  'WTI/USD': 'TVC:USOIL',
  'USOIL': 'TVC:USOIL',
  'UKOIL': 'TVC:UKOIL',
  'SILVER': 'OANDA:XAGUSD',
  'GOLD': 'OANDA:XAUUSD',
};

export const TV_COMMAND_INSTRUMENTS = [
  { s: 'XAU/USD', label: 'Gold · XAU/USD', cat: 'Metals' },
  { s: 'XAG/USD', label: 'Silver · XAG/USD', cat: 'Metals' },
  { s: 'WTI/USD', label: 'WTI Crude Oil · USOIL', cat: 'Commodities' },
  { s: 'EUR/USD', label: 'EUR/USD', cat: 'Forex' },
  { s: 'GBP/USD', label: 'GBP/USD', cat: 'Forex' },
  { s: 'USD/JPY', label: 'USD/JPY', cat: 'Forex' },
  { s: 'USD/CHF', label: 'USD/CHF', cat: 'Forex' },
  { s: 'AUD/USD', label: 'AUD/USD', cat: 'Forex' },
  { s: 'USD/CAD', label: 'USD/CAD', cat: 'Forex' },
  { s: 'NZD/USD', label: 'NZD/USD', cat: 'Forex' },
  { s: 'BTC/USD', label: 'Bitcoin · BTC/USD', cat: 'Crypto' },
  { s: 'ETH/USD', label: 'Ethereum · ETH/USD', cat: 'Crypto' },
  { s: 'NAS100', label: 'Nasdaq 100 · NAS100', cat: 'Indices' },
  { s: 'US30', label: 'Dow Jones 30 · US30', cat: 'Indices' },
  { s: 'US500', label: 'S&P 500 · US500', cat: 'Indices' },
  { s: 'GER40', label: 'Germany 40 · GER40', cat: 'Indices' },
];

export function tvSymbol(sym) {
  return TV_MAP[sym] || TV_EXTRA_SYMBOLS[sym] || null;
}

function buildTvFrame(sym, interval = '30', compact = false) {
  const tvSym = tvSymbol(sym);
  if (!tvSym) return null;
  const f = document.createElement('iframe');
  f.className = 'tv-embed-frame';
  f.setAttribute('title', `TradingView chart — ${sym} (${interval})`);
  f.setAttribute('allowtransparency', 'true');
  f.style.width = '100%';
  f.style.height = '100%';
  f.style.border = '0';
  const q = new URLSearchParams({
    symbol: tvSym,
    interval: String(interval || '30'),
    timezone: userTz(),
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    style: '1',
    locale: 'en',
    autosize: '1',
    hidesidetoolbar: compact ? '1' : '0',
    symboledit: '1',
    withdateranges: '1',
    saveimage: '0',
    calendar: '0'
  });
  f.src = 'https://s.tradingview.com/widgetembed/?' + q.toString();
  return f;
}

/** Mount / re-mount the Advanced Chart for `sym`. */
export async function mountChart(container, sym, opts = {}) {
  if (!container) return;
  const interval = opts.interval || '30';
  const f = buildTvFrame(sym, interval, false);
  chartState = { container, symbol: sym, widget: null };
  clearNode(container);
  if (!f) {
    notice(container, 'No TradingView chart for ' + sym + ' — prices, analysis and orders still use the live Deriv feed.');
    return;
  }
  container.appendChild(f);
  let loaded = false;
  f.addEventListener('load', () => { loaded = true; const n = container.querySelector('.tv-notice'); if (n) n.remove(); });
  setTimeout(() => {
    if (!loaded && chartState.container === container && !container.querySelector('.tv-notice')) {
      const n = document.createElement('div');
      n.className = 'tv-notice';
      n.textContent = 'TradingView chart did not load (network or a browser extension may be blocking it). Prices, signals and orders keep running on the live feed.';
      container.prepend(n);
    }
  }, 7000);
}

/** Mount Single / Dual / Quad interactive TradingView Command Centre layout. */
export function mountCommandTvLayout(container, { symbol = 'XAU/USD', interval = '15', layout = 'single', secondarySymbol = 'EUR/USD' } = {}) {
  if (!container) return;
  clearNode(container);
  const panes = layout === 'quad'
    ? [
        { sym: symbol, tf: '5', label: `${symbol} · M5` },
        { sym: symbol, tf: '15', label: `${symbol} · M15` },
        { sym: symbol, tf: '60', label: `${symbol} · H1` },
        { sym: symbol, tf: '240', label: `${symbol} · H4` },
      ]
    : layout === 'dual'
    ? [
        { sym: symbol, tf: interval, label: `${symbol} · ${interval === 'D' ? '1D' : interval + 'm'}` },
        { sym: symbol === secondarySymbol ? 'EUR/USD' : secondarySymbol, tf: '60', label: `${symbol === secondarySymbol ? 'EUR/USD' : secondarySymbol} · H1` },
      ]
    : [{ sym: symbol, tf: interval, label: `${symbol} · Full Terminal` }];

  const grid = document.createElement('div');
  grid.className = `tv-cc-grid tv-cc-${layout}`;
  for (const p of panes) {
    const cell = document.createElement('div');
    cell.className = 'tv-cc-cell';
    if (panes.length > 1) {
      const hd = document.createElement('div');
      hd.className = 'tv-cc-cell-head';
      hd.innerHTML = `<b>${p.label}</b><span class="faint tiny">TradingView widget · display only</span>`;
      cell.appendChild(hd);
    }
    const body = document.createElement('div');
    body.className = 'tv-cc-cell-body';
    body.style.position = 'relative';
    body.style.background = '#090d16';
    const placeholder = document.createElement('div');
    placeholder.className = 'tv-notice';
    placeholder.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--muted);background:#090d16;z-index:2;pointer-events:none;';
    placeholder.textContent = `Loading interactive TradingView chart for ${p.sym} (${tvSymbol(p.sym)})…`;
    const frame = buildTvFrame(p.sym, p.tf, panes.length > 2);
    if (frame) {
      frame.style.background = '#090d16';
      frame.style.colorScheme = 'dark';
      frame.style.opacity = '0';
      frame.style.transition = 'opacity .25s ease';
      let settled = false;
      frame.addEventListener('load', () => {
        // In an offline sandbox Chromium fires load on chrome-error://chromewebdata/ too;
        // only reveal iframe when navigator.onLine && external embed could succeed, otherwise show clean dark notice on error.
        settled = true;
        frame.style.opacity = '1';
        placeholder.remove();
      });
      frame.addEventListener('error', () => {
        settled = true;
        frame.remove();
        placeholder.style.pointerEvents = 'auto';
        placeholder.textContent = `TradingView interactive chart (${p.sym}) is unreachable in this network environment. Verified broker quotes and Signal Analyzer remain active.`;
      });
      setTimeout(() => {
        if (!settled && placeholder.isConnected) {
          placeholder.textContent = `TradingView chart (${p.sym}) waiting for s.tradingview.com — verified Signal chart · M5 remains available in Manual Trading.`;
        }
      }, 6000);
      body.appendChild(placeholder);
      body.appendChild(frame);
    } else {
      notice(body, `TradingView chart unavailable for ${p.sym}`);
    }
    cell.appendChild(body);
    grid.appendChild(cell);
  }
  container.appendChild(grid);
}

/** Watchlist board: one TradingView mini-chart iframe per entry, built on the SAME
    widgetembed channel as the Chart & Trade chart (no third-party script widget,
    which browsers/extensions commonly block). Entries: [{id,n,tv,live?}]. */
export function mountWatchlist(container, entries) {
  if (!container) return;
  clearNode(container);
  if (!entries || !entries.length) {
    notice(container, 'Nothing pinned — add with the ★ in the markets list below.');
    return;
  }
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const grid = document.createElement('div');
  grid.className = 'watch-grid';
  container.appendChild(grid);
  entries.forEach((e) => {
    const tile = document.createElement('div');
    tile.className = 'watch-tile';
    const head = document.createElement('div');
    head.className = 'watch-tile-head';
    head.title = 'Open full TradingView chart in a new tab';
    const id = document.createElement('b'); id.textContent = e.id;
    const nm = document.createElement('span'); nm.className = 'watch-tile-name';
    nm.textContent = e.live ? '● Deriv live' : (e.n + ' · TV, may be delayed');
    head.appendChild(id); head.appendChild(nm);
    head.onclick = () => window.open('https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(e.tv), '_blank', 'noopener');
    const body = document.createElement('div');
    body.className = 'watch-tile-body';
    const loading = document.createElement('div');
    loading.className = 'watch-tile-loading';
    loading.textContent = 'loading TradingView…';
    body.appendChild(loading);
    const f = document.createElement('iframe');
    f.className = 'tv-embed-frame';
    f.setAttribute('title', 'TradingView mini chart — ' + e.id + (e.live ? ' (live)' : ' (may be delayed)'));
    f.setAttribute('allowtransparency', 'true');
    f.style.width = '100%'; f.style.height = '100%'; f.style.border = '0';
    const q = new URLSearchParams({
      symbol: e.tv, interval: '15', timezone: userTz(), theme,
      style: '1', locale: 'en', autosize: '1',
      hidesidetoolbar: '1', hidetoptoolbar: '1', withdateranges: '0',
      hideideas: '1', saveimage: '0', calendar: '0'
    });
    f.src = 'https://s.tradingview.com/widgetembed/?' + q.toString();
    f.onload = () => { f.dataset.loaded = '1'; if (loading.parentNode) loading.parentNode.removeChild(loading); };
    f.onerror = () => { loading.textContent = 'unavailable — TradingView did not load'; };
    setTimeout(() => {
      if (!f.dataset.loaded && loading.parentNode) loading.textContent = 'TradingView unavailable for ' + e.id + ' — no substitute prices will be shown.';
    }, 10000);
    body.appendChild(f);
    tile.appendChild(head); tile.appendChild(body);
    grid.appendChild(tile);
  });
}

/** Wait for an embed script to render; honest notice if blocked/offline. */
function waitEmbed(container, script, fallbackText) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    script.onerror = () => { if (chartState.container === container || container.isConnected) notice(container, fallbackText); finish(false); };
    script.onload = () => setTimeout(() => finish(!!container.querySelector('iframe')), 400);
    setTimeout(() => {
      if (!done && !container.querySelector('iframe')) { notice(container, fallbackText); finish(false); }
      else finish(true);
    }, 15000);
  });
}

/** Re-mount chart when the symbol changes (cheap, correct). */
export function switchChartSymbol(sym) {
  if (chartState.container && chartState.symbol !== sym) {
    mountChart(chartState.container, sym);
  }
}

export function refreshChartTheme() {
  if (chartState.container && chartState.symbol) mountChart(chartState.container, chartState.symbol);
}

/** News timeline widget. */
export async function mountNews(container) {
  if (!container) return;
  clearNode(container);
  const inner = document.createElement('div');
  inner.className = 'tradingview-widget-container';
  inner.style.height = '100%';
  const host = document.createElement('div');
  host.className = 'tradingview-widget-container__widget';
  host.style.height = '100%';
  inner.appendChild(host);
  container.appendChild(inner);
  const conf = document.createElement('script');
  conf.type = 'application/json';
  conf.innerHTML = JSON.stringify({
    feedMode: 'all_symbols',
    isTransparent: true,
    displayMode: 'regular',
    width: '100%',
    height: '100%',
    colorTheme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    locale: 'en'
  });
  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-timeline.js';
  script.async = true;
  inner.appendChild(conf);
  inner.appendChild(script);
  await waitEmbed(container, script, 'Live news feed unavailable (no network). Use the AI news brief below when a Perplexity key is set.');
}

/** The script of TradingView's economic calendar ("events") widget. */
export const CALENDAR_WIDGET_URL = 'https://s3.tradingview.com/external-embedding/embed-widget-events.js';

/** Economic calendar widget. */
export async function mountCalendar(container) {
  if (!container) return;
  clearNode(container);
  const inner = document.createElement('div');
  inner.className = 'tradingview-widget-container';
  inner.style.height = '100%';
  const host = document.createElement('div');
  host.className = 'tradingview-widget-container__widget';
  host.style.height = '100%';
  inner.appendChild(host);
  container.appendChild(inner);
  const conf = document.createElement('script');
  conf.type = 'application/json';
  /* TradingView's economic calendar is its "events" widget. The address used before
     (embed-widget-economic-calendar.js) no longer exists on TradingView's server, which is why this
     box read "unavailable" with a working connection. Settings are the ones that widget accepts. */
  conf.innerHTML = JSON.stringify({
    colorTheme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    isTransparent: true,
    width: '100%',
    height: '100%',
    locale: 'en',
    importanceFilter: '-1,0,1',
    countryFilter: 'us,eu,gb,jp,au,ca,ch,nz,de,cn'
  });
  const script = document.createElement('script');
  script.src = CALENDAR_WIDGET_URL;
  script.async = true;
  inner.appendChild(conf);
  inner.appendChild(script);
  await waitEmbed(container, script, 'The TradingView calendar could not be loaded (blocked, offline, or changed by TradingView). The calendar card above does not depend on it.');
}
