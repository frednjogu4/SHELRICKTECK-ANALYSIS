const WINDOWS = Object.freeze([
  { key: '1m', label: '1m', seconds: 60 },
  { key: '5m', label: '5m', seconds: 300 },
  { key: '30m', label: '30m', seconds: 1800 },
  { key: '1h', label: '1h', seconds: 3600 },
  { key: '2h', label: '2h', seconds: 7200 },
  { key: '3h', label: '3h', seconds: 10800 },
  { key: '4h', label: '4h', seconds: 14400 }
]);
const DISPLAY_WINDOWS = [...WINDOWS].reverse();
const WEIGHTS = Object.freeze({
  '5m': Object.freeze({ '1m': 4, '5m': 3, '30m': 2, '1h': 1, '2h': 1, '3h': 1, '4h': 1 }),
  '10m': Object.freeze({ '1m': 1, '5m': 1, '30m': 2, '1h': 2, '2h': 2, '3h': 3, '4h': 3 })
});

function epochMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : 0;
}
function directionOf(value) { return value > 0 ? 'UP' : value < 0 ? 'DOWN' : 'FLAT'; }
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function biasFor(changePct, typicalMovePct) {
  if (!Number.isFinite(changePct) || changePct === 0) return { direction: 'FLAT', score: 0, strength: 'Neutral' };
  const strongAt = Math.max(typicalMovePct * 0.8, 1e-8);
  const strong = Math.abs(changePct) >= strongAt;
  const score = Math.sign(changePct) * (strong ? 2 : 1);
  return { direction: score > 0 ? 'UP' : 'DOWN', score, strength: strong ? (score > 0 ? 'Bullish' : 'Bearish') : (score > 0 ? 'Weak Bullish' : 'Weak Bearish') };
}
function forecastFor(observations, horizon) {
  const weights = WEIGHTS[horizon], totalWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (!observations.every(item => item.available)) return { direction: 'UNAVAILABLE', score: null, aligned: 0, of: WINDOWS.length, alignmentPct: null, horizon };
  let weighted = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const item = observations.find(period => period.key === key);
    if (!item) return { direction: 'UNAVAILABLE', score: null, aligned: 0, of: WINDOWS.length, alignmentPct: null, horizon };
    weighted += item.biasScore * weight;
  }
  // Keep both horizons on the prompt's -14..+14 summed-score scale.
  const score = Math.round((weighted / totalWeight) * WINDOWS.length);
  const candidate = score >= 3 ? 'UP' : score <= -3 ? 'DOWN' : 'NEUTRAL';
  const aligned = candidate === 'NEUTRAL' ? 0 : observations.filter(item => item.direction === candidate).length;
  const direction = aligned >= 5 ? candidate : 'NEUTRAL';
  return { direction, score, aligned, of: WINDOWS.length, alignmentPct: Math.round((aligned / WINDOWS.length) * 100), horizon };
}
function observedLevels(rows, currentClose) {
  const recent = rows.slice(-240), supports = [], resistances = [];
  for (let i = 2; i < recent.length - 2; i++) {
    const bar = recent[i], around = recent.slice(i - 2, i + 3);
    if (bar.low <= Math.min(...around.map(item => item.low)) && bar.low < currentClose) supports.push(bar.low);
    if (bar.high >= Math.max(...around.map(item => item.high)) && bar.high > currentClose) resistances.push(bar.high);
  }
  const support = supports.length ? Math.max(...supports) : null;
  const resistance = resistances.length ? Math.min(...resistances) : null;
  return { support, resistance, invalidationUp: support, invalidationDown: resistance, method: 'Nearest five-candle swing in the available recent M1 history; not a guaranteed level.' };
}

/**
 * Analyze only finished, time-ordered provider candles. Scores are descriptive
 * historical momentum alignment, not calibrated probabilities or promises.
 */
export function analyzeShortOutlook(candles, { granularity = 60, now = Date.now(), maxAgeSeconds = 180 } = {}) {
  const width = Number(granularity), nowMs = Number(now);
  if (!Number.isInteger(width) || width <= 0 || !Number.isFinite(nowMs) || nowMs <= 0) {
    return { status: 'unavailable', reason: 'Invalid candle interval or analysis time.', observations: [], forecasts: {} };
  }
  const rows = [];
  let prior = 0;
  for (const candle of Array.isArray(candles) ? candles : []) {
    const time = epochMs(candle && (candle.epoch ?? candle.time));
    const open = Number(candle && candle.open), high = Number(candle && candle.high);
    const low = Number(candle && candle.low), close = Number(candle && candle.close);
    if (!time || ![open, high, low, close].every(Number.isFinite) || Math.min(open, high, low, close) <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue;
    if (prior && time <= prior) return { status: 'unavailable', reason: 'Candle times are duplicated or out of order.', observations: [], forecasts: {} };
    prior = time;
    const closeAt = time + width * 1000;
    if (closeAt <= nowMs) rows.push({ time, closeAt, open, high, low, close });
  }
  if (!rows.length) return { status: 'unavailable', reason: 'No completed candles were returned.', observations: [], forecasts: {} };

  const latest = rows[rows.length - 1], ageMs = nowMs - latest.closeAt;
  const fresh = ageMs >= -1000 && ageMs <= maxAgeSeconds * 1000;
  const recentMoves = [];
  for (let i = Math.max(1, rows.length - 60); i < rows.length; i++) recentMoves.push(Math.abs((rows[i].close / rows[i - 1].close - 1) * 100));
  const oneMinuteNoise = median(recentMoves);
  const observations = WINDOWS.map(window => {
    const targetClose = latest.closeAt - window.seconds * 1000;
    let anchor = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].closeAt <= targetClose) { anchor = rows[i]; break; }
    }
    if (!anchor) return { ...window, available: false, direction: 'UNAVAILABLE', changePct: null, biasScore: 0, strength: 'Unavailable', reason: 'Insufficient verified history.' };
    const elapsed = latest.closeAt - anchor.closeAt;
    if (Math.abs(elapsed - window.seconds * 1000) > width * 1500) {
      return { ...window, available: false, direction: 'UNAVAILABLE', changePct: null, biasScore: 0, strength: 'Unavailable', reason: 'A complete candle window is unavailable.' };
    }
    const changePct = (latest.close / anchor.close - 1) * 100;
    const typicalMovePct = oneMinuteNoise * Math.sqrt(window.seconds / 60);
    const bias = biasFor(changePct, typicalMovePct);
    return { ...window, available: true, direction: bias.direction, changePct, biasScore: bias.score, strength: bias.strength, anchorCloseAt: anchor.closeAt,
      reason: `${bias.strength}; measured return ${changePct > 0 ? '+' : ''}${changePct.toFixed(3)}% over ${window.label}.` };
  });
  const complete = observations.every(item => item.available), totalScore = complete ? observations.reduce((sum, item) => sum + item.biasScore, 0) : null;
  const bullish = observations.filter(item => item.available && item.biasScore > 0).length, bearish = observations.filter(item => item.available && item.biasScore < 0).length;
  const neutral = observations.filter(item => item.available && item.biasScore === 0).length, unavailable = observations.filter(item => !item.available).length;
  const forecastsReady = complete && fresh;
  const levels = observedLevels(rows, latest.close);
  const forecasts = forecastsReady ? { '5m': forecastFor(observations, '5m'), '10m': forecastFor(observations, '10m') } : {
    '5m': { direction: 'UNAVAILABLE', score: null, aligned: 0, of: WINDOWS.length, alignmentPct: null, horizon: '5m' },
    '10m': { direction: 'UNAVAILABLE', score: null, aligned: 0, of: WINDOWS.length, alignmentPct: null, horizon: '10m' }
  };
  return {
    status: !fresh ? 'stale' : complete ? 'ready' : 'incomplete',
    reason: !fresh ? 'The newest completed one-minute candle is stale; historical performance is shown without a current outlook.' : complete ? '' : 'All seven complete lookback windows are required before a direction is summarized.',
    granularity: width, latestCloseAt: latest.closeAt, ageSeconds: Math.max(0, Math.round(ageMs / 1000)), currentClose: latest.close,
    observations, totalScore, consensus: { bullish, bearish, neutral, unavailable, required: 5 }, levels,
    confluence: [
      `${bullish} UP, ${bearish} DOWN, ${neutral} neutral, ${unavailable} unavailable of seven timeframe windows.`,
      `1m and 5m ${observations[0].direction === observations[1].direction ? 'agree' : 'conflict'} (${observations[0].direction} / ${observations[1].direction}).`,
      `30m and 1h ${observations[2].direction === observations[3].direction ? 'agree' : 'conflict'} (${observations[2].direction} / ${observations[3].direction}).`
    ],
    forecasts
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function directionClass(direction) {
  return direction === 'UP' ? 'up' : direction === 'DOWN' ? 'down' : direction === 'NEUTRAL' ? 'neutral' : 'faint';
}
function signedPct(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return (n > 0 ? '+' : '') + n.toFixed(3) + '%';
}
function formatPrice(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return 'unavailable in history';
  return Number(value).toLocaleString('en-US', { maximumSignificantDigits: 8 });
}
function biasLabel(score) {
  return score === 2 ? 'Bullish +2' : score === 1 ? 'Weak bullish +1' : score === -1 ? 'Weak bearish −1' : score === -2 ? 'Bearish −2' : 'Neutral 0';
}

/** Render evidence and scenario outlook without turning it into a trade signal. */
export function renderShortOutlook(result, { symbol = '', source = '', compact = false, loading = false } = {}) {
  const name = escapeHtml(symbol || 'Market');
  if (loading) return `<div class="short-outlook"><span class="faint">${name} outlook · reading verified closed candles…</span></div>`;
  if (!result || !['ready', 'incomplete', 'stale'].includes(result.status)) {
    const reason = escapeHtml(result && result.reason || 'Verified intraday history is unavailable.');
    return `<div class="short-outlook"><b>${name} · short-horizon outlook unavailable</b><div class="tiny faint">${reason} No substitute prices are used.</div></div>`;
  }
  const forecasts = result.forecasts || {};
  const forecast = horizon => {
    const item = forecasts[horizon] || {}, direction = item.direction || 'UNAVAILABLE';
    const alignment = item.alignmentPct == null ? 'alignment unavailable' : `${item.alignmentPct}% timeframe alignment (${item.aligned}/7; not a probability)`;
    return `<div class="short-outlook-result"><span class="faint">Next ${horizon}</span> <b class="${directionClass(direction)}">${escapeHtml(direction === 'UP' ? 'UPWARD' : direction === 'DOWN' ? 'DOWNWARD' : direction)}</b><span class="tiny faint">${alignment} · weighted score ${item.score == null ? '—' : item.score}</span></div>`;
  };
  const performance = result.observations.map(item => {
    const cls = item.available ? directionClass(item.direction) : 'faint';
    return `<span class="short-outlook-period"><b>${escapeHtml(item.label)}</b> <span class="${cls}">${escapeHtml(item.available ? signedPct(item.changePct) : 'unavailable')}</span></span>`;
  }).join('');
  const table = DISPLAY_WINDOWS.map(item => {
    const row = result.observations.find(observation => observation.key === item.key) || {};
    const score = row.available ? biasLabel(row.biasScore) : 'Unavailable';
    return `<div class="short-outlook-bias"><b>${escapeHtml(item.label.toUpperCase())}</b><span>${escapeHtml(score)}</span><span class="faint">${escapeHtml(row.reason || 'No verified complete window.')}</span></div>`;
  }).join('');
  const miniTable = DISPLAY_WINDOWS.map(item => {
    const row = result.observations.find(observation => observation.key === item.key) || {};
    return `<span><b>${escapeHtml(item.label.toUpperCase())}</b> ${row.available ? escapeHtml(biasLabel(row.biasScore)) : '—'}</span>`;
  }).join('');
  const levels = result.levels || {};
  const levelLine = `Observed support: ${formatPrice(levels.support)} · resistance: ${formatPrice(levels.resistance)} · invalidation reference: UP ${formatPrice(levels.invalidationUp)} / DOWN ${formatPrice(levels.invalidationDown)}.`;
  const detail = compact ? `<div class="short-outlook-mini-biases">${miniTable}</div><div class="tiny faint">Total score ${result.totalScore ?? '—'} · ${escapeHtml(levelLine)}</div><div class="tiny faint">Evidence: ${(result.confluence || []).map(escapeHtml).join(' · ')}</div>` : `<details class="short-outlook-details"><summary>Seven-timeframe bias table, levels &amp; evidence</summary><div class="short-outlook-biases">${table}</div><div class="tiny faint">Total timeframe score: ${result.totalScore ?? '—'} (range −14 to +14) · ${escapeHtml(levels.method || '')}</div><div class="tiny faint">${escapeHtml(levelLine)}</div><ul class="tiny faint">${(result.confluence || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul><div class="short-outlook-method">Bullish/bearish means historical directional bias only. The system does not verify EMA alignment, volume confirmation, divergence, or a trade setup here.</div></details>`;
  const statusNote = result.reason ? `<div class="tiny faint">${escapeHtml(result.reason)}</div>` : '';
  const asOf = result.latestCloseAt ? ` · last closed M1 candle ${new Date(result.latestCloseAt).toLocaleTimeString()}` : '';
  const sourceText = source ? `Source: ${escapeHtml(source)}` : 'Source verified candle history';
  return `<div class="short-outlook"><div class="short-outlook-head"><b>${name} · directional outlook (next 5m / 10m)</b><span class="tiny faint">${sourceText}${escapeHtml(asOf)}</span></div><div class="short-outlook-results">${forecast('5m')}${forecast('10m')}</div><div class="short-outlook-periods">Historical return: ${performance}</div>${detail}${statusNote}<div class="tiny faint">Scenario only—not a guaranteed prediction, confirmed BUY/SELL signal, or order. Alignment is not confidence or probability of profit.</div></div>`;
}
