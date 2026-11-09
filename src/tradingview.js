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

export function tvSymbol(sym) {
  return TV_MAP[sym] || null;
}

/** Mount / re-mount the Advanced Chart for `sym`.
 *  Direct widgetembed IFRAME — the previous script-embed scanned the DOM for
 *  its JSON config on every execution; when a re-mount raced the loader, a
 *  config-less instance won and rendered the DEFAULT symbol (AAPL), which is
 *  the "wrong market" bug. An iframe carries its symbol in the URL and can
 *  never fall back. Endpoint verified live (HTTP 200, s.tradingview.com —
 *  already allowed by our CSP frame-src). */
export async function mountChart(container, sym) {
  if (!container) return;
  const tvSym = tvSymbol(sym);
  chartState = { container, symbol: sym, widget: null };
  clearNode(container);
  if (!tvSym) {
    notice(container, 'No TradingView chart for ' + sym + ' — prices, analysis and orders still use the live Deriv feed.');
    return;
  }
  const f = document.createElement('iframe');
  f.className = 'tv-embed-frame';
  f.setAttribute('title', 'TradingView chart — ' + sym);
  f.setAttribute('allowtransparency', 'true');
  f.style.width = '100%';
  f.style.height = '100%';
  f.style.border = '0';
  const q = new URLSearchParams({
    symbol: tvSym,
    interval: '30',
    timezone: userTz(),
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    style: '1',
    locale: 'en',
    autosize: '1',
    hidesidetoolbar: '0',
    symboledit: '1',
    saveimage: '0',
    calendar: '0'
  });
  f.src = 'https://s.tradingview.com/widgetembed/?' + q.toString();
  container.appendChild(f);
  /* Honest fallback: if the embed cannot load (network/extension blocking),
     say so instead of leaving a blank box — and remove the note if it loads late. */
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
  conf.innerHTML = JSON.stringify({
    colorTheme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    isTransparent: true,
    displayMode: 'block',
    width: '100%',
    height: '100%',
    locale: 'en',
    country: 'all'
  });
  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-economic-calendar.js';
  script.async = true;
  inner.appendChild(conf);
  inner.appendChild(script);
  await waitEmbed(container, script, 'Live calendar unavailable (no network).');
}
