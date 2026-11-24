/* ================================================================
 * src/provenance.js — honest data-source attribution (pure ESM).
 * One registry for every provider the terminal actually uses, so no
 * panel can label TradingView's display widget as an analysis feed
 * or present a market SESSION as a data source.
 * ================================================================ */

export const PROVIDERS = {
  deriv: { id: 'deriv', label: 'Deriv public feed', role: 'Live ticks and closed candles (analysis input)' },
  exness: { id: 'exness', label: 'Exness MT5 local bridge', role: 'Gold quotes and candles when the PC bridge is connected' },
  yahoo: { id: 'yahoo', label: 'Yahoo market scan', role: 'Index prices on the market scan' },
  tvWidget: { id: 'tv_widget', label: 'TradingView widget', role: 'Chart DISPLAY only — never used for internal calculations' },
  investing: { id: 'investing', label: 'Investing.com RSS', role: 'News feed and economic calendar headlines' },
  markethours: { id: 'markethours', label: 'Local market-session clock', role: 'Time classification only — not a data provider' }
};

/** Market session classification (UTC). A session is a TIME label, never a source. */
export function sessionNow(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const day = d.getUTCDay();
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 5 && h >= 22 || day === 6 || day === 0 && h < 22) return { label: 'Weekend', window: 'forex closed Sun 22:00 – Fri 22:00 UTC' };
  if (h >= 12 && h < 16) return { label: 'London / New York overlap', window: '12:00–16:00 UTC' };
  if (h >= 7 && h < 12) return { label: 'London session', window: '07:00–16:00 UTC (overlaps Asian until 09:00)' };
  if (h >= 16 && h < 21) return { label: 'New York session', window: '12:00–21:00 UTC' };
  if (h >= 21 || h < 7) return { label: 'Asian session', window: '23:00–07:00 UTC' };
  return { label: 'All sessions', window: '24/7 synthetic coverage' };
}

/** Command Centre provenance line — actual providers, honestly separated. */
export function mccProvenance(nowMs = Date.now()) {
  const s = sessionNow(nowMs);
  return [
    'PRICES: Deriv public ticks (live) · index tiles: Yahoo via TradingView display',
    'ANALYSIS: Deriv/Exness completed M1/M5/H1 candles (server/lib/analyzer.js)',
    'CHART DISPLAY: TradingView widget — display only, not an analysis input',
    `NEWS/CALENDAR: Investing.com RSS · headlines: TradingView widget`,
    `MARKET SESSION: ${s.label} (${s.window}) — time classification, not a data source`
  ].join('  |  ');
}

const AGE_STALE_MS = 15 * 60 * 1000;

/** Structured provenance rows for the Gold monitor. UNKNOWN when unverifiable. */
export function goldProvenanceRows({ source = null, lastUpdateMs = 0, chartSource = null, analysisSource = null, nowMs = Date.now() } = {}) {
  const ageMs = lastUpdateMs > 0 ? Math.max(0, nowMs - lastUpdateMs) : null;
  const status = ageMs == null ? 'UNKNOWN' : ageMs <= AGE_STALE_MS ? 'CONNECTED' : ageMs <= 60 * 60 * 1000 ? 'DEGRADED' : 'UNAVAILABLE';
  const ts = lastUpdateMs > 0 ? new Date(lastUpdateMs).toLocaleString() : 'UNKNOWN';
  const age = ageMs == null ? 'UNKNOWN' : ageMs < 1000 ? '<1s' : ageMs < 60000 ? Math.round(ageMs / 1000) + 's' : Math.round(ageMs / 60000) + 'm';
  return [
    { k: 'DATA SOURCE', v: source || 'UNKNOWN' },
    { k: 'SOURCE STATUS', v: status },
    { k: 'LAST UPDATE', v: ts },
    { k: 'DATA AGE', v: age },
    { k: 'ANALYSIS SOURCE', v: analysisSource || 'completed M1/M5/H1 candles (shared analyzer pipeline)' },
    { k: 'CHART DISPLAY', v: chartSource ? `${chartSource} · TradingView widget is display-only` : 'TradingView widget (display only — not used for calculations)' }
  ];
}
