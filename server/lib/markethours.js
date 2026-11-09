/* ================================================================
 * AURUM — market session hours (browser-safe, pure, no fetching).
 * Typical session guidance only; never a broker-confirmed schedule.
 * Forex/commodities status is the typical Deriv calendar in UTC.
 * Indices require a fresh Exness MT5 tick + terminal trade mode.
 * ================================================================ */

export const MARKET_HOURS_NOTE =
  'Status is typical Deriv calendar guidance (UTC) for forex & commodities: Sun 22:00 \u2192 Fri 22:00 ' +
  'with a 21:00\u201322:00 daily break; crypto & synthetics are generally 24/7. ' +
  'Index status is UNKNOWN until a fresh Exness MT5 quote confirms the terminal trade mode. ' +
  'Typical active windows are approximate Nairobi time (EAT), shift with daylight saving, and are not a trading edge; ' +
  'check the broker schedule, live quote, spread and instrument conditions.';

/**
 * Session status for one instrument. For indices the caller may replace UNKNOWN
 * only when a fresh broker tick and a known terminal trade mode are available.
 * @param {{c:string}} inst instrument (category field `c`)
 * @param {number} [nowMs]
 * @returns {{status:'open'|'break'|'closed'|null, label:string, detail:string, open:boolean}}
 */
export function marketStatus(inst, nowMs = Date.now()) {
  const cat = inst && inst.c;
  if (cat === 'synthetics' || cat === 'crypto') {
    return { status: 'open', label: 'OPEN', detail: '24/7 market availability; activity varies', open: true };
  }
  if (cat === 'forex' || cat === 'commodities') {
    const d = new Date(nowMs);
    const day = d.getUTCDay(); /* 0=Sun .. 6=Sat */
    const h = d.getUTCHours() + d.getUTCMinutes() / 60;
    const weekend = (day === 5 && h >= 22) || day === 6 || (day === 0 && h < 22);
    if (weekend) return { status: 'closed', label: 'CLOSED', detail: 'typical Deriv weekend calendar · reopens Sun 22:00 UTC', open: false };
    const brk = h >= 21 && h < 22 && day >= 1 && day <= 5;
    if (brk) return { status: 'break', label: 'BREAK', detail: 'typical Deriv daily maintenance 21:00–22:00 UTC', open: false };
    const detail = day === 5 ? 'typical Deriv hours · weekend close today 22:00 UTC' : 'typical Deriv hours · daily break 21:00–22:00 UTC · Fri close 22:00 UTC';
    return { status: 'open', label: 'OPEN', detail, open: true };
  }
  if (cat === 'indices' || cat === 'stockindices') {
    return { status: null, label: 'UNKNOWN', detail: 'Exness index session not verified · connect the local MT5 bridge for a fresh quote and terminal trade mode', open: false };
  }
  return { status: null, label: 'UNKNOWN', detail: 'schedule unknown · verify with broker', open: false };
}

/** Typical higher-activity windows, not guaranteed optimum/profit or broker hours. */
export function typicalActiveWindow(inst) {
  const s = String(inst && (inst.s || inst.symbol) || '').toUpperCase();
  const c = String(inst && inst.c || '').toLowerCase();
  if (c === 'crypto') return '24/7 availability · no universal best session; activity varies';
  if (c === 'synthetics') return '24/7 synthetic feed · no exchange session or universal best time';
  if (c === 'indices' || c === 'stockindices') {
    if (/^(US30|US500|SPX500|NAS100|USTEC|US100|DJI|NDX)/.test(s)) return 'US cash-session open/early hours · roughly 16:30–17:30 EAT (DST-dependent); verify Exness hours';
    if (/^(GER40|DE40|DAX)/.test(s)) return 'European cash-session open · roughly 10:00 EAT (DST-dependent); verify Exness hours';
    if (/^(UK100|FTSE)/.test(s)) return 'London cash-session open · roughly 10:00–11:00 EAT (DST-dependent); verify Exness hours';
    return 'Exchange-specific active hours · verify the Exness schedule and current quote';
  }
  if (c === 'forex') {
    const parts = s.replace(/[^A-Z]/g, '');
    const has = (ccy) => parts.includes(ccy);
    if (has('USD') && (has('EUR') || has('GBP') || has('CHF'))) return 'London–New York overlap · roughly 16:00–20:00 EAT; shifts about an hour with DST';
    if (has('JPY') || has('AUD') || has('NZD')) return 'Asia/Tokyo activity · roughly 03:00–09:00 EAT; varies by pair and DST';
    if (has('EUR') || has('GBP') || has('CHF')) return 'London session · roughly 10:00–19:00 EAT; varies with UK DST';
    if (has('USD') || has('CAD')) return 'New York session · roughly 16:30–23:00 EAT; varies by product and DST';
    return 'London–New York overlap · roughly 16:00–20:00 EAT; approximate, DST-dependent';
  }
  if (c === 'commodities') return 'Often most active during overlapping London/US hours · roughly 16:00–20:00 EAT; product hours vary';
  return 'No verified session guidance for this instrument';
}
