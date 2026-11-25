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

/**
 * Structured Data Source Selector state separating:
 *   - selectedProvider (what the operator requested),
 *   - activeProvider   (what actually supplied candles/quotes, never calling
 *                       fallback/cached/delayed/demo feeds "live broker feed"),
 *   - fallbackProvider (explicit fallback explanation when fallback occurred, else 'None'),
 *   - session          (UTC market session clock — never labelled as a feed),
 *   - instrument       (canonical + broker symbol if mapped),
 *   - timeframe        (candle timeframes evaluated),
 *   - freshness        (LIVE / STALE / CACHED / DELAYED / UNAVAILABLE + age).
 */
export function describeDataSourceSelection({
  selectedMode = 'auto',
  mt5Connected = false,
  mt5AccountMode = null,
  actualDataSource = null,
  instrument = 'XAU/USD',
  timeframe = 'Completed M1 / M5 / H1 candles',
  lastUpdateMs = 0,
  cached = false,
  delayed = false,
  nowMs = Date.now()
} = {}) {
  const mode = ['auto', 'deriv', 'mt5'].includes(selectedMode) ? selectedMode : 'auto';
  const selectedLabel = mode === 'mt5'
    ? 'Exness MT5 local bridge'
    : mode === 'deriv'
      ? 'Deriv public candles'
      : 'Auto (prefer Exness MT5 broker, fallback to Deriv public)';

  const rawActual = String(actualDataSource || '').trim();
  const usingMt5 = rawActual
    ? /^Exness MT5/i.test(rawActual)
    : (mode === 'mt5' ? mt5Connected : (mode === 'auto' && mt5Connected));

  let activeProvider;
  let fallbackProvider = 'None (primary selection active)';

  if (usingMt5) {
    const acctTag = mt5AccountMode === 'demo'
      ? 'Demo account bridge'
      : mt5AccountMode === 'real'
        ? 'Live broker bridge (analysis only)'
        : 'Local MT5 bridge';
    activeProvider = rawActual || `Exness MT5 (${acctTag})`;
  } else if (mode === 'mt5' && !mt5Connected) {
    activeProvider = 'Unavailable (Exness MT5 not connected)';
    fallbackProvider = 'Disabled — explicit Exness MT5 mode never switches silently to public candles';
  } else {
    activeProvider = rawActual || 'Deriv public feed (public market candles — not a broker account feed)';
    if (mode === 'auto' && !mt5Connected) {
      fallbackProvider = 'Deriv public candles (fallback active because Exness MT5 local bridge is disconnected)';
    }
  }

  if (delayed && !/delayed/i.test(activeProvider)) {
    activeProvider += ' [delayed]';
  } else if (cached && !/cached/i.test(activeProvider)) {
    activeProvider += ' [cached]';
  }

  const sess = sessionNow(nowMs);
  const ageMs = lastUpdateMs > 0 ? Math.max(0, nowMs - lastUpdateMs) : null;
  let freshness;
  if (ageMs == null) {
    freshness = 'UNAVAILABLE (awaiting verified candles)';
  } else if (delayed) {
    freshness = `DELAYED (${Math.round(ageMs / 60000)}m old)`;
  } else if (cached) {
    freshness = `CACHED (${Math.round(ageMs / 1000)}s old)`;
  } else if (ageMs <= 2 * 60 * 1000) {
    freshness = `LIVE (${ageMs < 1000 ? '<1s' : Math.round(ageMs / 1000) + 's'} old)`;
  } else if (ageMs <= AGE_STALE_MS) {
    freshness = `RECENT (${Math.round(ageMs / 60000)}m old)`;
  } else {
    freshness = `STALE (${Math.round(ageMs / 60000)}m old)`;
  }

  return {
    selectedProvider: selectedLabel,
    activeProvider,
    fallbackProvider,
    fallbackActive: mode === 'auto' && !mt5Connected,
    session: `${sess.label} (${sess.window})`,
    instrument: String(instrument || 'XAU/USD'),
    timeframe: String(timeframe || 'Completed M1 / M5 / H1 candles'),
    freshness
  };
}

