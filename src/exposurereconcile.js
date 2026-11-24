/**
 * Open-position reconciliation — compares the connected MT5 terminal's
 * read-only position snapshot with the analytical reading on screen.
 *
 * Pure model + a small DOM renderer. It never fetches, never places or
 * modifies orders, and never invents values: everything shown comes from the
 * snapshot the local bridge already reported (or an explicit UNAVAILABLE
 * state when no snapshot exists).
 *
 * Why it exists: a signal on Gold and two manual UKOIL sells in MT5 can be on
 * screen at the same time in different apps. This panel puts the terminal's
 * positions beside the reading so a different-instrument or against-the-reading
 * exposure is visible before anything else is.
 */

/* Broker variants and app names for the same instrument (Exness suffixes such
 * as the trailing "m" are handled by prefix matching in sameInstrument). */
const ALIASES = { US500: 'SPX500', SPX500: 'US500', USTEC: 'NAS100', NAS100: 'USTEC' };

/** Uppercase, alphanumeric only: 'XAU/USD' -> 'XAUUSD', 'UKOILm' -> 'UKOILM'. */
export function canonSymbol(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** All known spellings of one canonical name: broker suffix "M" and app aliases. */
function variants(ca) {
  const out = new Set([ca]);
  if (ca.length > 4 && ca.endsWith('M')) out.add(ca.slice(0, -1));
  for (const v of [...out]) {
    const alias = ALIASES[v];
    if (alias) out.add(alias);
  }
  return out;
}

/**
 * True when two names denote the same instrument: any shared spelling after
 * removing a broker suffix ("XAUUSD" vs "XAUUSDm"), an alias match
 * ("SPX500" vs "US500m"), or a plain prefix variant of at least 4 characters.
 */
export function sameInstrument(a, b) {
  const ca = canonSymbol(a);
  const cb = canonSymbol(b);
  if (!ca || !cb) return false;
  const va = variants(ca);
  for (const v of variants(cb)) if (va.has(v)) return true;
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  return short.length >= 4 && long.startsWith(short);
}

const finiteOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const timeHMS = (ms) => {
  try {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) {
    return '';
  }
};

/**
 * Build the reconciliation model.
 *
 * @param {object} input
 * @param {{symbol?:string, signal?:string}|null} input.reading      the reading on screen (symbol only is fine)
 * @param {{type?:string, account?:object}|null} input.broker         state.broker
 * @param {Array|null} input.positions                                state.mt5LivePositions
 * @param {number} input.snapshotAt                                   state.mt5LastSnapshotAt
 * @param {boolean} input.snapshotFailed                              state.mt5SnapshotFailed
 * @returns model with mode, reason, account, positions[].relation, counts, severity, headline, notes
 */
export function buildExposureReconcile({ reading = null, broker = null, positions = null, snapshotAt = 0, snapshotFailed = false } = {}) {
  const readingSymbol = reading && reading.symbol ? String(reading.symbol) : null;
  const readingSignal = reading && (reading.signal === 'BUY' || reading.signal === 'SELL') ? reading.signal : null;
  const base = {
    mode: 'unavailable',
    reason: 'no_mt5_bridge',
    account: null,
    positions: [],
    counts: { total: 0, mismatch: 0, conflict: 0, aligned: 0, same: 0 },
    severity: 'none',
    headline: '',
    notes: [],
    readingSymbol,
    readingSignal,
    snapshotAt: Number(snapshotAt) || 0,
    snapshotFailed: !!snapshotFailed
  };

  const isMt5 = !!broker && broker.type === 'mt5';
  if (!isMt5) {
    base.headline = 'Open positions cannot be compared with this reading — the Exness/MT5 bridge is not connected.';
    return base;
  }

  const acct = (broker && broker.account) || {};
  const currency = acct.currency || '';
  const balance = finiteOrNull(acct.balance);
  const equity = finiteOrNull(acct.equity);
  const freeMargin = finiteOrNull(acct.margin_free);
  if (balance != null || equity != null || freeMargin != null) {
    base.account = { balance, equity, freeMargin, currency };
  }

  if (!Array.isArray(positions)) {
    base.reason = snapshotFailed ? 'snapshot_failed' : 'no_snapshot';
    base.headline = snapshotFailed
      ? 'Latest MT5 refresh failed — open positions cannot be verified right now, so they cannot be compared with this reading.'
      : 'Connected, but no live MT5 positions snapshot yet — open positions cannot be compared with this reading.';
    base.notes.push('Use Refresh MT5 on the Portfolio page or wait for the automatic snapshot.');
    return base;
  }

  base.mode = 'mt5';
  base.reason = null;
  const rows = positions.map((p) => {
    const symbol = String((p && p.symbol) || '—');
    const side = String((p && p.side) || '—');
    let relation = 'unknown';
    if (readingSymbol && sameInstrument(symbol, readingSymbol)) {
      if (readingSignal && (side === 'BUY' || side === 'SELL')) {
        relation = side === readingSignal ? 'aligned' : 'conflict';
      } else {
        relation = 'same';
      }
    } else if (readingSymbol) {
      relation = 'mismatch';
    }
    return {
      ticket: p && p.ticket != null ? String(p.ticket) : '',
      symbol,
      side,
      volume: finiteOrNull(p && p.volume),
      price: finiteOrNull(p && p.price),
      profit: finiteOrNull(p && p.profit),
      relation
    };
  });
  base.positions = rows;
  base.counts = rows.reduce(
    (acc, r) => {
      acc.total += 1;
      if (r.relation === 'mismatch') acc.mismatch += 1;
      else if (r.relation === 'conflict') acc.conflict += 1;
      else if (r.relation === 'aligned') acc.aligned += 1;
      else if (r.relation === 'same') acc.same += 1;
      return acc;
    },
    { total: 0, mismatch: 0, conflict: 0, aligned: 0, same: 0 }
  );

  const c = base.counts;
  const symbolsOf = (rel) => [...new Set(rows.filter((r) => r.relation === rel).map((r) => r.symbol))].join(', ');
  if (c.mismatch > 0) {
    base.severity = 'alert';
    base.headline =
      c.mismatch + ' open MT5 position' + (c.mismatch === 1 ? '' : 's') + ' in ' + symbolsOf('mismatch') +
      (readingSymbol ? ' — a different instrument than this ' + readingSymbol + ' reading.' : ' — outside this reading.');
  } else if (c.conflict > 0) {
    base.severity = 'warn';
    base.headline =
      'An open ' + rows.find((r) => r.relation === 'conflict').side + ' position on ' + symbolsOf('conflict') +
      ' is against this ' + (readingSignal || '') + ' reading.';
  } else if (c.aligned > 0) {
    base.severity = 'info';
    base.headline = 'An open position already follows this ' + (readingSignal || '') + ' reading on ' + symbolsOf('aligned') + '.';
  } else if (c.same > 0) {
    base.severity = 'info';
    base.headline = 'An open position exists on ' + symbolsOf('same') + ' — this reading has no BUY/SELL direction to compare.';
  } else {
    base.headline = 'MT5 reports no open positions' + (readingSymbol ? ' for comparison with this ' + readingSymbol + ' reading.' : '.');
  }

  const refreshed = base.snapshotAt ? ' · refreshed ' + timeHMS(base.snapshotAt) : '';
  base.notes.push('Read-only snapshot from the connected terminal' + refreshed + ' · positions opened outside this app are included.');
  if (base.snapshotFailed) base.notes.push('The latest automatic refresh failed; figures come from the last confirmed snapshot.');
  return base;
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const money = (value, currency, signed) => {
  if (value == null) return '—';
  const sign = signed && value > 0 ? '+' : '';
  const code = currency ? ' ' + currency : '';
  return sign + value.toFixed(2) + code;
};

const RELATION_BADGE = {
  mismatch: ['OTHER INSTRUMENT', 'sell'],
  conflict: ['AGAINST READING', 'neutral'],
  aligned: ['WITH READING', 'buy'],
  same: ['SAME INSTRUMENT', 'gray'],
  unknown: ['—', 'gray']
};

const SEVERITY_BADGE = {
  alert: ['MISMATCH', 'sell'],
  warn: ['AGAINST READING', 'neutral'],
  info: ['IN SYNC', 'buy'],
  none: ['NO POSITIONS', 'gray']
};

/** Fill `el` with the model. Safe against HTML in any field. */
export function renderExposureReconcile(el, model) {
  if (!el) return false;
  const badge = model.mode === 'mt5' ? SEVERITY_BADGE[model.severity] || SEVERITY_BADGE.none : ['UNAVAILABLE', 'gray'];
  let html = '<div class="row between wrap" style="gap:8px"><span class="faint tiny">OPEN POSITIONS vs THIS READING</span>' +
    '<span class="badge ' + badge[1] + '">' + badge[0] + '</span></div>';

  if (model.account) {
    const a = model.account;
    const chip = (label, value) =>
      '<span class="tiny"><span class="faint">' + label + '</span> <b class="mono">' + money(value, a.currency, false) + '</b></span>';
    html += '<div class="row wrap" style="gap:14px;margin-top:8px" aria-label="MT5 account snapshot">' +
      chip('Balance', a.balance) + chip('Equity', a.equity) + chip('Free margin', a.freeMargin) + '</div>';
  }

  const headColor = model.severity === 'alert' ? 'style="color:var(--red)"'
    : model.severity === 'warn' ? 'style="color:var(--amber)"' : 'class="muted small"';
  html += '<p ' + headColor + ' style="margin:8px 0 0;line-height:1.5">' + escapeHtml(model.headline) + '</p>';

  if (model.positions.length) {
    html += '<div style="margin-top:8px;display:grid;gap:6px">' + model.positions.map((p) => {
      const rel = RELATION_BADGE[p.relation] || RELATION_BADGE.unknown;
      const plClass = p.profit == null ? 'faint' : p.profit >= 0 ? 'up' : 'down';
      return '<div class="row between wrap" style="gap:8px;border-top:1px solid var(--border-soft);padding-top:6px">' +
        '<span class="tiny"><b>' + escapeHtml(p.symbol) + '</b> · ' + escapeHtml(p.side) +
        (p.volume != null ? ' · ' + p.volume.toFixed(2) + ' lots' : '') +
        (p.price != null ? ' · open ' + p.price : '') +
        (p.profit != null ? ' · floating <b class="mono ' + plClass + '">' + money(p.profit, (model.account && model.account.currency) || '', true) + '</b>' : '') +
        '</span>' +
        '<span class="badge ' + rel[1] + '" title="' + (p.relation === 'mismatch' ? 'Open in a different instrument than the reading on screen' :
          p.relation === 'conflict' ? 'Open position faces the direction of the reading on screen' :
          p.relation === 'aligned' ? 'Open position faces the same direction as the reading on screen' :
          'Same instrument as the reading on screen') + '">' + rel[0] + '</span></div>';
    }).join('') + '</div>';
  }

  if (model.notes.length) {
    html += '<div class="tiny faint" style="margin-top:8px;line-height:1.5">' + model.notes.map(escapeHtml).join('<br>') + '</div>';
  }
  el.innerHTML = html;
  return true;
}
