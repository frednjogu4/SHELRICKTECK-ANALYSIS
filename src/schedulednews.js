/*
 * Upcoming scheduled-news alert selection and wording.
 * Calendar events identify timing and potentially exposed markets, not direction.
 */
import { marketsForCurrency, eatClock, eatStamp, STAND_ASIDE } from './newsimpact.js';

const CURRENCY_ALIASES = Object.freeze({
  US: 'USD', USA: 'USD', 'UNITED STATES': 'USD', 'U.S.': 'USD',
  UK: 'GBP', GB: 'GBP', 'UNITED KINGDOM': 'GBP',
  EU: 'EUR', 'EURO AREA': 'EUR', EUROZONE: 'EUR', JPN: 'JPY', JAPAN: 'JPY',
  AU: 'AUD', AUSTRALIA: 'AUD', CA: 'CAD', CANADA: 'CAD',
  NZ: 'NZD', 'NEW ZEALAND': 'NZD', CH: 'CHF', SWITZERLAND: 'CHF'
});

export function scheduledNewsCurrency(event) {
  const raw = String(event && event.country || '').trim().toUpperCase();
  return CURRENCY_ALIASES[raw] || (/^(USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD)$/.test(raw) ? raw : '');
}

/** Build only due-soon, supported-currency alerts, leaving previously alerted milestones out. */
export function buildScheduledNewsAlerts(entries, now = Date.now(), seenKeys = []) {
  const seen = seenKeys instanceof Set ? seenKeys : new Set(seenKeys);
  const alerts = [];
  for (const event of entries || []) {
    if (!event || !['High', 'Medium'].includes(event.impact)) continue;
    const time = Number(event.t), minutes = (time - now) / 60000;
    if (!Number.isFinite(time) || time <= now) continue;
    const currency = scheduledNewsCurrency(event);
    if (!currency) continue;
    const markets = marketsForCurrency(currency);
    if (!markets.length) continue;
    const milestones = event.impact === 'High' ? [15, 5] : [5];
    for (const milestone of milestones) {
      if (minutes > milestone || minutes <= milestone - 1.2) continue;
      const key = [event.day || '', event.time_utc || time, event.country, event.event, event.impact, milestone].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const marketList = markets.slice(0, 5).join(', ') + (markets.length > 5 ? ` + ${markets.length - 5} more` : '');
      const stand = event.impact === 'High'
        ? `Avoid opening a new trade ${STAND_ASIDE.beforeMin} min before through ${STAND_ASIDE.afterMin} min after (${eatClock(time - STAND_ASIDE.beforeMin * 60000)}–${eatClock(time + STAND_ASIDE.afterMin * 60000)} EAT). `
        : '';
      const body = `${event.impact}-impact ${currency} event in about ${milestone} min: ${event.event || 'scheduled release'} · ${eatStamp(time, now)} (${event.time_utc || 'time'} UTC). Markets priced in ${currency}: ${marketList}. ${stand}The event itself does not tell you BUY or SELL; it may move these markets either way. Any market direction shown separately must come from a fresh price-based reading, not from this release.`;
      alerts.push({ key, milestone, currency, markets, title: `Upcoming ${event.impact.toLowerCase()} news · ${currency}`, body });
    }
  }
  return alerts;
}
