/**
 * Shelricktech Command Centre — additive overview enhancement.
 *
 * Mirrors existing, rendered application state only. It does not fetch prices,
 * calculate signals, create orders, or bypass any broker/risk controls.
 */
const STYLE_ID = 'shelrick-command-centre-style';
const ROOT_ID = 'shelrick-command-centre';

const css = `
/* Keep legacy overview DOM as a data source for existing renderers, but show only the unified Command Centre. */
#view-overview > :not(#shelrick-command-centre){display:none!important}
#${ROOT_ID}{margin:0 0 18px;display:grid;gap:14px;color:var(--text)}
#${ROOT_ID} .cc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
#${ROOT_ID} .cc-eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:800;color:var(--brand)}
#${ROOT_ID} .cc-title{font-size:22px;letter-spacing:-.035em;margin:4px 0}
#${ROOT_ID} .cc-sub{font-size:12.5px;color:var(--text-3);line-height:1.55}
#${ROOT_ID} .cc-statuses{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
#${ROOT_ID} .cc-status{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border);border-radius:99px;padding:6px 10px;background:var(--surface);font-size:11px;color:var(--text-2)}
#${ROOT_ID} .cc-dot{width:7px;height:7px;border-radius:50%;background:var(--text-3);flex:none}
#${ROOT_ID} .cc-dot.good{background:var(--green)} #${ROOT_ID} .cc-dot.warn{background:var(--amber)} #${ROOT_ID} .cc-dot.bad{background:var(--red)}
#${ROOT_ID} .cc-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
#${ROOT_ID} .cc-kpi{min-width:0;padding:13px 15px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
#${ROOT_ID} .cc-kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--text-3);font-weight:750}
#${ROOT_ID} .cc-kpi-value{font-size:21px;font-weight:750;letter-spacing:-.025em;margin-top:7px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
#${ROOT_ID} .cc-kpi-note{font-size:11px;color:var(--text-3);margin-top:4px}
#${ROOT_ID} .cc-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:14px}
#${ROOT_ID} .cc-card{min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}
#${ROOT_ID} .cc-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}
#${ROOT_ID} .cc-card h3{font-size:13px;margin:0}
#${ROOT_ID} .cc-card .cc-hint{font-size:11px;color:var(--text-3);margin-top:3px}
#${ROOT_ID} .cc-preview{min-width:0}
#${ROOT_ID} .cc-preview:empty:before{content:'Waiting for the existing workspace reading…';display:block;color:var(--text-3);font-size:12px;padding:12px 0}
#${ROOT_ID} .cc-preview .mover,#${ROOT_ID} .cc-preview .mini-signal{max-width:100%}
#${ROOT_ID} .cc-preview .mini-signal{margin-bottom:7px}
#${ROOT_ID} .cc-preview .mover{padding:7px 0}
#${ROOT_ID} .cc-actions{display:flex;gap:7px;flex-wrap:wrap}
#${ROOT_ID} .cc-foot{font-size:10.5px;color:var(--text-3);line-height:1.5}
#${ROOT_ID} .cc-market-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
#${ROOT_ID} .cc-tag{border:1px solid var(--border);background:var(--surface-2);color:var(--text-2);border-radius:7px;padding:5px 8px;font-size:10.5px}
@media(max-width:900px){#${ROOT_ID} .cc-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}#${ROOT_ID} .cc-grid{grid-template-columns:1fr}}
@media(max-width:520px){#${ROOT_ID} .cc-kpi{padding:11px}#${ROOT_ID} .cc-kpi-value{font-size:18px}#${ROOT_ID} .cc-title{font-size:19px}}
`;

const sourceMap = [
  ['Portfolio value', 'kpiValue', 'kpiValueDelta'],
  ['Open P&L', 'kpiPl', 'kpiPlCount'],
  ['Free margin', 'kpiMargin', 'kpiMarginSub'],
  ['Win rate', 'kpiWin', 'kpiWinSub']
];

function getText(doc, id, fallback = '—') {
  const el = doc.getElementById(id);
  const value = el?.textContent?.trim();
  return value || fallback;
}

function safeCloneChildren(doc, sourceId) {
  const source = doc.getElementById(sourceId);
  if (!source) return [];
  return Array.from(source.children).slice(0, 4).map((node) => {
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.('[id]').forEach((el) => el.removeAttribute('id'));
    clone.removeAttribute?.('id');
    clone.querySelectorAll?.('script,iframe,form,input,select,textarea').forEach((el) => el.remove());
    return clone;
  });
}

function statusKind(label) {
  const value = String(label || '').toLowerCase();
  if (/error|failed|unavailable|stale|disconnected|not connected|offline/.test(value)) return 'bad';
  if (/connecting|pending|unknown/.test(value) || !value) return 'warn';
  if (/live|connected|ready|healthy|ok/.test(value)) return 'good';
  return 'warn';
}

function makeStatus(doc, label, value) {
  const item = doc.createElement('span');
  item.className = 'cc-status';
  const dot = doc.createElement('i');
  dot.className = 'cc-dot ' + statusKind(value);
  const text = doc.createElement('span');
  text.textContent = label + ': ' + value;
  item.append(dot, text);
  return item;
}

export function initCommandCentre(doc = document) {
  const overview = doc.getElementById('view-overview');
  const kpiAnchor = doc.getElementById('ovKpis');
  if (!overview || !kpiAnchor) return false;
  if (doc.getElementById(ROOT_ID)) return true;

  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    doc.head.appendChild(style);
  }

  const root = doc.createElement('section');
  root.id = ROOT_ID;
  root.setAttribute('aria-label', 'Shelricktech Command Centre');
  root.innerHTML = `
    <div class="cc-head">
      <div>
        <div class="cc-eyebrow">Shelricktech Investment · Trading Workspace</div>
        <h2 class="cc-title">Market Command Centre</h2>
        <p class="cc-sub">A unified view of your existing market feeds, portfolio readings and validated signal summaries.</p>
      </div>
      <div class="cc-statuses" id="ccStatuses" aria-live="polite"></div>
    </div>
    <div class="cc-kpis" id="ccKpis"></div>
    <div class="cc-grid">
      <section class="cc-card">
        <div class="cc-card-head"><div><h3>Market pulse</h3><div class="cc-hint">Top movers from the existing live workspace</div></div><button class="btn ghost sm" type="button" data-goto="markets">All markets ↗</button></div>
        <div class="cc-preview" id="ccMovers"></div>
      </section>
      <section class="cc-card">
        <div class="cc-card-head"><div><h3>Signal intelligence</h3><div class="cc-hint">Existing scan results only · no new signal is generated here</div></div><button class="btn ghost sm" type="button" data-goto="signals">Signal analyser ↗</button></div>
        <div class="cc-preview" id="ccSignals"></div>
      </section>
      <section class="cc-card">
        <div class="cc-card-head"><div><h3>Open exposure</h3><div class="cc-hint">Current portfolio panel snapshot</div></div><button class="btn ghost sm" type="button" data-goto="portfolio">Portfolio ↗</button></div>
        <div class="cc-preview" id="ccPositions"></div>
      </section>
      <section class="cc-card">
        <div class="cc-card-head"><div><h3>Analysis workspace</h3><div class="cc-hint">Open existing specialist tools</div></div></div>
        <div class="cc-actions">
          <button class="btn sm" type="button" data-goto="trade">Advanced chart</button>
          <button class="btn sm" type="button" data-goto="state">Market state</button>
          <button class="btn sm" type="button" data-goto="proscalper">Pro Scalper</button>
          <button class="btn sm" type="button" data-goto="gold">Gold / USD</button>
          <button class="btn sm" type="button" data-goto="news">News & calendar</button>
          <button class="btn sm" type="button" data-goto="automation">Automation</button>
        </div>
        <div class="cc-market-tags" aria-label="Supported market categories">
          <span class="cc-tag">Forex</span><span class="cc-tag">Indices</span><span class="cc-tag">Gold & metals</span><span class="cc-tag">Energy</span><span class="cc-tag">Crypto</span><span class="cc-tag">Stocks / ETFs where connected</span>
        </div>
      </section>
    </div>
    <div class="cc-foot">This panel mirrors existing application outputs. It does not claim every category is currently connected, does not invent prices, and cannot place or approve trades. Feed availability and instrument support remain provider-dependent.</div>
  `;

  overview.insertBefore(root, kpiAnchor);

  const render = () => {
    if (!doc.getElementById(ROOT_ID)) return;
    const kpis = doc.getElementById('ccKpis');
    if (kpis) {
      kpis.replaceChildren();
      for (const [label, valueId, noteId] of sourceMap) {
        const card = doc.createElement('div');
        card.className = 'cc-kpi';
        const name = doc.createElement('div');
        name.className = 'cc-kpi-label';
        name.textContent = label;
        const value = doc.createElement('div');
        value.className = 'cc-kpi-value';
        value.textContent = getText(doc, valueId);
        const note = doc.createElement('div');
        note.className = 'cc-kpi-note';
        note.textContent = getText(doc, noteId, '');
        card.append(name, value, note);
        kpis.appendChild(card);
      }
    }

    const statuses = doc.getElementById('ccStatuses');
    if (statuses) {
      statuses.replaceChildren(
        makeStatus(doc, 'Market feed', getText(doc, 'feedText', 'Status unknown')),
        makeStatus(doc, 'Deriv', getText(doc, 'derivPill', 'Status unknown')),
        makeStatus(doc, 'MT5 bridge', getText(doc, 'mt5Status', 'Not connected'))
      );
    }

    for (const [targetId, sourceId] of [['ccMovers', 'ovMovers'], ['ccSignals', 'ovSignals'], ['ccPositions', 'ovPositions']]) {
      const target = doc.getElementById(targetId);
      if (!target) continue;
      target.replaceChildren(...safeCloneChildren(doc, sourceId));
    }
  };

  render();

  const observer = typeof MutationObserver === 'function'
    ? new MutationObserver(() => render())
    : null;
  if (observer) {
    for (const id of ['kpiValue', 'kpiPl', 'kpiMargin', 'kpiWin', 'ovMovers', 'ovSignals', 'ovPositions', 'feedText', 'derivPill', 'mt5Status']) {
      const el = doc.getElementById(id);
      if (el) observer.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
    }
  }
  return true;
}
