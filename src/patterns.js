/* ================================================================
 * AURUM — chart pattern UI module (client).
 * Talks to /api/patterns/* (server does detection on real candles).
 * Draws candlesticks + pattern geometry as inline SVG (no external
 * chart lib) and builds the educational playbook from PATTERN_META.
 * ================================================================ */
import { PATTERN_META, PATTERN_KEYS, detectPatterns, studyPatterns } from '../server/lib/patterns.js';
import { INSTRUMENTS } from '../server/lib/symbols.js';
import { DERIV_PUBLIC_URL } from './marketdata.js';

export { PATTERN_META, PATTERN_KEYS };

/* ------------------------------------------------------------------
 * Browser candle fetch (Deriv PUBLIC feed — no token, one-shot WS).
 * Used when the /api backend is not available (e.g. static-only PWA
 * hosting): detection then runs locally with the exact same engine.
 * ---------------------------------------------------------------- */
export function browserCandles(symbol, granularity = 300, count = 120, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const I = INSTRUMENTS.find((x) => x.s === symbol) || INSTRUMENTS.find((x) => x.s.toUpperCase() === String(symbol).toUpperCase());
    if (!I || !I.deriv) { reject(Object.assign(new Error('unknown symbol ' + symbol), { code: 'invalid_symbol' })); return; }
    let ws;
    try { ws = new WebSocket(DERIV_PUBLIC_URL); } catch (e) { reject(new Error('websocket unavailable')); return; }
    const done = (fn, arg) => { try { ws.close(); } catch {} fn(arg); };
    const timer = setTimeout(() => done(reject, Object.assign(new Error('candle fetch timed out'), { code: 'feed_timeout' })), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({
      ticks_history: I.deriv, count, end: 'latest', style: 'candles', granularity, req_id: 1
    }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.error) { clearTimeout(timer); done(reject, Object.assign(new Error(m.error.message || 'feed error'), { code: 'feed_error' })); return; }
      if (!Array.isArray(m.candles) || !m.candles.length) return;
      clearTimeout(timer);
      done(resolve, m.candles.map((c) => ({
        time: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: 0
      })));
    };
    ws.onerror = () => { clearTimeout(timer); done(reject, Object.assign(new Error('feed unreachable'), { code: 'feed_error' })); };
  });
}

async function localAnalyze(symbol, granularity, bars) {
  const all = await browserCandles(symbol, granularity, Math.max(bars, 100));
  if (!all || all.length < 30) throw Object.assign(new Error('insufficient history'), { code: 'insufficient_history' });
  const win = all.slice(-bars);
  return { symbol, granularity, bars: win.length, patterns: detectPatterns(win), candles: win, source: 'deriv-public (browser)', ts: Date.now() };
}

async function localStudy(symbol, granularity, bars, holdBars) {
  const candles = await browserCandles(symbol, granularity, bars);
  if (!candles || candles.length < 80) throw Object.assign(new Error('insufficient history'), { code: 'insufficient_history' });
  const study = studyPatterns(candles, { holdBars });
  return Object.assign({ symbol, granularity, source: 'deriv-public (browser)', ts: Date.now(), meta: PATTERN_META }, study);
}

export async function patternAnalyze(symbol, granularity = 300, bars = 120) {
  try {
    const r = await fetch('/api/patterns/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol, granularity, bars })
    });
    if (r.status === 404) throw Object.assign(new Error('api missing'), { code: 'api_missing' });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.detail || j.error || 'pattern scan failed'), { code: j.error });
    return j;
  } catch (e) {
    /* no backend (static hosting) or backend down → run the same engine locally */
    if (e && (e.code === 'invalid_symbol')) throw e;
    return localAnalyze(symbol, granularity, bars);
  }
}

export async function patternStudy(symbol, granularity = 300, bars = 600) {
  try {
    const r = await fetch('/api/patterns/study', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol, granularity, bars })
    });
    if (r.status === 404) throw Object.assign(new Error('api missing'), { code: 'api_missing' });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.detail || j.error || 'pattern study failed'), { code: j.error });
    return j;
  } catch (e) {
    if (e && (e.code === 'invalid_symbol')) throw e;
    return localStudy(symbol, granularity, bars, 48);
  }
}

const esc = (x) => String(x).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/* ---------------- SVG candlestick chart with pattern overlay ---------------- */
export function renderPatternChart(container, candles, det) {
  if (!container) return;
  if (!candles || candles.length < 5) { container.innerHTML = '<p class="hint">No candles to draw.</p>'; return; }
  const W = 780, H = 280, PAD = { t: 14, r: 74, b: 16, l: 10 };
  const n = candles.length;
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
  if (det) {
    for (const v of [det.entry, det.stop, det.target]) {
      if (v == null || !Number.isFinite(v)) continue;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    for (const l of det.lines || []) {
      for (const v of [l.p1, l.p2]) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  const span = (hi - lo) || 1;
  lo -= span * 0.05; hi += span * 0.05;
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const step = plotW / n;
  const bw = Math.max(1.5, step * 0.62);
  const x = (i) => PAD.l + i * step + step / 2;
  const y = (p) => PAD.t + ((hi - p) / (hi - lo)) * plotH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;background:var(--surface-2);border:1px solid var(--border);border-radius:10px" role="img" aria-label="Pattern chart">`;
  /* candles */
  candles.forEach((c, i) => {
    const up = c.close >= c.open;
    const col = up ? 'var(--green,#22c55e)' : 'var(--red,#ef4444)';
    const xo = x(i);
    svg += `<line x1="${xo.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${xo.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const yo = y(c.open), yc = y(c.close);
    const top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
    svg += `<rect x="${(xo - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}" opacity="0.9" rx="0.5"/>`;
  });
  /* pattern geometry */
  if (det) {
    (det.lines || []).forEach((l) => {
      const col = det.direction === 'bearish' ? '#ef4444' : det.direction === 'bullish' ? '#22c55e' : '#94a3b8';
      svg += `<line x1="${x(l.i1).toFixed(1)}" y1="${y(l.p1).toFixed(1)}" x2="${x(l.i2).toFixed(1)}" y2="${y(l.p2).toFixed(1)}" stroke="${col}" stroke-width="2" ${l.style === 'dashed' ? 'stroke-dasharray="5 4"' : ''} stroke-linecap="round"/>`;
    });
    const levels = [
      { v: det.entry, c: '#38bdf8', t: 'entry' },
      { v: det.stop, c: '#ef4444', t: 'stop' },
      { v: det.target, c: '#22c55e', t: 'target' }
    ].filter((l) => l.v != null && Number.isFinite(l.v));
    levels.forEach((l) => {
      svg += `<line x1="${PAD.l}" y1="${y(l.v).toFixed(1)}" x2="${(W - PAD.r).toFixed(1)}" y2="${y(l.v).toFixed(1)}" stroke="${l.c}" stroke-width="1" stroke-dasharray="3 5" opacity="0.85"/>`;
      svg += `<text x="${W - PAD.r + 6}" y="${(y(l.v) + 4).toFixed(1)}" fill="${l.c}" font-size="11" font-family="monospace">${l.t} ${l.v}</text>`;
    });
    svg += `<text x="${PAD.l + 8}" y="${PAD.t + 16}" fill="var(--text,#e5e7eb)" font-size="13" font-weight="700">${esc(det.pattern)} · ${esc(det.direction.toUpperCase())} · ${det.confidence}%</text>`;
    svg += `<text x="${PAD.l + 8}" y="${PAD.t + 33}" fill="var(--text-2,#9ca3af)" font-size="11">${esc(det.status)} · suggested action: ${esc(det.action)}</text>`;
  }
  svg += '</svg>';
  container.innerHTML = svg;
}

/* ---------------- educational playbook ---------------- */
export function playbookHTML() {
  return PATTERN_KEYS.map((k) => {
    const m = PATTERN_META[k];
    const dirCls = m.dir === 'bullish' ? 'buy' : m.dir === 'bearish' ? 'sell' : 'neutral';
    return `<details class="pb-item" data-pattern="${k}">
      <summary><span class="badge ${dirCls}">${esc(m.action)}</span><b>${esc(m.name)}</b><span class="faint tiny"> ${esc(m.dir)}</span></summary>
      <div class="pb-body">
        <p><span class="k">What it looks like</span>${esc(m.how)}</p>
        <p><span class="k">Why it works</span>${esc(m.why)}</p>
        <p><span class="k">How traders use it</span>${esc(m.trade)}</p>
      </div>
    </details>`;
  }).join('');
}

/* ---------------- performance bars (success-rate visuals) ---------------- */
export function performanceHTML(study) {
  const rows = study.patterns || [];
  if (!rows.length) return '<div class="empty"><b>No signals in this window</b>Try another timeframe or a longer history — patterns are selective by design.</div>';
  const bars = rows.map((p) => {
    const cls = p.winRate >= 55 ? 'up' : p.winRate >= 40 ? '' : 'down';
    return `<div class="perf-row">
      <span class="perf-name">${esc(p.pattern)}</span>
      <span class="perf-track"><i class="${cls}" style="width:${Math.max(2, p.winRate)}%"></i></span>
      <b class="perf-val ${cls}">${p.winRate}%</b>
      <span class="tiny faint">n=${p.n} · avg ${p.avgR >= 0 ? '+' : ''}${p.avgR}R · ${p.avgBars} bars</span>
    </div>`;
  }).join('');
  return `<div class="perf-list">${bars}</div>
    <p class="hint" style="margin-top:8px">${esc(study.note)}</p>`;
}
