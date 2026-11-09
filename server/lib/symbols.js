/* ================================================================
 * AURUM — instrument universe (single source of truth, browser-safe)
 * ONLY instruments with a verified/live path:
 *   - Deriv public feed  -> live prices + candles (no key)
 *   - TradingView widget  -> charting (no key)
 * No fake base prices anywhere: `d` = display decimals only.
 * ================================================================ */

/* ---------------- early-exit (resale) families ----------------
   Deriv decides resale per contract ("Sell early … only when a fair market
   price can be established" — Deriv glossary). Evidence basis:
   - 'rarely'  : forex binaries — live-tested 15m AND daily contracts refused
                 resale (InvalidToSell) for their whole life.
   - 'usually' : synthetics — 15m contracts resale-tested as allowed.
   - 'unknown' : metals/crypto binaries — NOT yet live-tested; honest until then.
   GUIDANCE ONLY, never a promise: the truth arrives per contract from
   proposal_open_contract.can_sell (polled live every 5s while open). */
export const INSTRUMENTS = [
  // ——— Forex (Deriv frx*) ———
  { s: 'EUR/USD', n: 'Euro · US Dollar',  c: 'forex',       d: 5, deriv: 'frxEURUSD', tv: 'FX:EURUSD', resale: 'rarely' },
  { s: 'GBP/USD', n: 'Pound · US Dollar', c: 'forex',       d: 5, deriv: 'frxGBPUSD', tv: 'FX:GBPUSD', resale: 'rarely' },
  { s: 'USD/JPY', n: 'US Dollar · Yen',   c: 'forex',       d: 3, deriv: 'frxUSDJPY', tv: 'FX:USDJPY', resale: 'rarely' },
  { s: 'AUD/USD', n: 'Aussie · US Dollar',c: 'forex',       d: 5, deriv: 'frxAUDUSD', tv: 'FX:AUDUSD', resale: 'rarely' },
  { s: 'USD/CHF', n: 'US Dollar · Franc', c: 'forex',       d: 5, deriv: 'frxUSDCHF', tv: 'FX:USDCHF', resale: 'rarely' },
  { s: 'USD/CAD', n: 'US Dollar · Loonie',c: 'forex',       d: 5, deriv: 'frxUSDCAD', tv: 'FX:USDCAD', resale: 'rarely' },
  { s: 'NZD/USD', n: 'Kiwi · US Dollar',  c: 'forex',       d: 5, deriv: 'frxNZDUSD', tv: 'FX:NZDUSD', resale: 'rarely' },
  { s: 'EUR/JPY', n: 'Euro · Yen',        c: 'forex',       d: 3, deriv: 'frxEURJPY', tv: 'FX:EURJPY', resale: 'rarely' },
  { s: 'GBP/JPY', n: 'Pound · Yen',       c: 'forex',       d: 3, deriv: 'frxGBPJPY', tv: 'FX:GBPJPY', resale: 'rarely' },
  { s: 'EUR/GBP', n: 'Euro · Pound',      c: 'forex',       d: 5, deriv: 'frxEURGBP', tv: 'FX:EURGBP', resale: 'rarely' },
  // ——— Metals ———
  { s: 'XAU/USD', n: 'Gold spot',         c: 'commodities', d: 2, deriv: 'frxXAUUSD', tv: 'OANDA:XAUUSD', resale: 'unknown' },
  { s: 'XAG/USD', n: 'Silver spot',       c: 'commodities', d: 3, deriv: 'frxXAGUSD', tv: 'OANDA:XAGUSD', resale: 'unknown' },
  // ——— Crypto (Deriv live prices; TV chart via Coinbase) ———
  { s: 'BTC/USD', n: 'Bitcoin',           c: 'crypto',      d: 2, deriv: 'cryBTCUSD', tv: 'COINBASE:BTCUSD', resale: 'unknown' },
  { s: 'ETH/USD', n: 'Ethereum',          c: 'crypto',      d: 2, deriv: 'cryETHUSD', tv: 'COINBASE:ETHUSD', resale: 'unknown' },
  // ——— Stock index CFDs (Exness bridge ONLY — never Deriv-orderable; Deriv's
  //     options API rejects them, probe-verified). `mt5` is the base name the
  //     bridge resolves against the broker's real variants (US30Cash, US30M…).
  //     Charts via TradingView; live quotes from the local MT5 bridge. ———
  { s: 'US30',    n: 'Dow Jones 30 CFD',     c: 'indices', d: 1, tv: 'TVC:DJI', resale: 'unknown' },
  { s: 'NAS100',  n: 'Nasdaq 100 CFD',       c: 'indices', d: 1, tv: 'TVC:NDX', resale: 'unknown' },
  { s: 'SPX500',  n: 'S&P 500 CFD',          c: 'indices', d: 2, tv: 'TVC:SPX', resale: 'unknown' },
  { s: 'US100',   n: 'US Tech 100 CFD',      c: 'indices', d: 1, tv: 'TVC:NDX', resale: 'unknown' },
  { s: 'GER40',   n: 'Germany 40 CFD (DAX)', c: 'indices', d: 1, tv: 'XETR:DAX', resale: 'unknown' },
  { s: 'UK100',   n: 'UK 100 CFD (FTSE)',    c: 'indices', d: 1, tv: 'TVC:UKX', resale: 'unknown' },
  // ——— Deriv volatility / synthetic indices ———
  { s: 'VOL 25',     n: 'Volatility 25 Index',   c: 'synthetics', d: 2, deriv: 'R_25',     tv: 'DERIV:VOLATILITY_25_INDEX', resale: 'usually' },
  { s: 'VOL 75',     n: 'Volatility 75 Index',   c: 'synthetics', d: 2, deriv: 'R_75',     tv: 'DERIV:VOLATILITY_75_INDEX', resale: 'usually' },
  { s: 'VOL 100',    n: 'Volatility 100 Index',  c: 'synthetics', d: 2, deriv: 'R_100',    tv: 'DERIV:VOLATILITY_100_INDEX', resale: 'usually' },
  { s: 'BOOM 1000',  n: 'Boom 1000 Index',       c: 'synthetics', d: 2, deriv: 'BOOM1000', tv: 'DERIV:BOOM_1000_INDEX', resale: 'usually' },
  { s: 'CRASH 1000', n: 'Crash 1000 Index',      c: 'synthetics', d: 2, deriv: 'CRASH1000',tv: 'DERIV:CRASH_1000_INDEX', resale: 'usually' },
  { s: 'STEP',       n: 'Step Index',            c: 'synthetics', d: 2, deriv: 'stpRNG',   tv: 'DERIV:STEP_INDEX', resale: 'usually' }
];

export const INSTRUMENT_MAP = Object.fromEntries(INSTRUMENTS.map((i) => [i.s, i]));

/* ---------------- owner watchlist (2026-10-14 screenshot) ----------------
   Stock indices are NOT on Deriv's options API (probe-verified:
   US30/NAS100/SPX500/US100 -> InvalidSymbol; NDX/DJI recognized, 0 public ticks),
   so these entries quote via TradingView (may be delayed) — never Deriv-labelled. */
export const WATCHLIST_DEFAULTS = [
  { id: 'NAS100', n: 'NASDAQ 100 Index', tv: 'TVC:NDX' },
  { id: 'NASDAQ', n: 'US Tech 100 Cash', tv: 'TVC:NDX' },
  { id: 'US30',   n: 'Dow Jones Industrial Average', tv: 'TVC:DJI' },
  { id: 'SPX500', n: 'S&P 500 Index', tv: 'TVC:SPX' },
  { id: 'US100',  n: 'US100 · Nasdaq-100 CFD', tv: 'TVC:NDX' }
];
export const DERIV_CODE_MAP = Object.fromEntries(INSTRUMENTS.map((i) => [i.s, i.deriv]));
export const TV_MAP = Object.fromEntries(INSTRUMENTS.map((i) => [i.s, i.tv]));

/* ---------------- input aliases (spec: EURUSD, XAUUSD, ...) --------------- */
/** Uppercase, strip spaces/slashes/dots: 'EURUSD' | 'EUR/USD' | 'eur usd' -> internal symbol or null */
const ALIAS = {};
for (const i of INSTRUMENTS) {
  ALIAS[i.s.toUpperCase()] = i.s;
  ALIAS[i.s.replace(/[^A-Z0-9]/gi, '').toUpperCase()] = i.s;
}
export function resolveSymbolInput(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const [k, v] of Object.entries(ALIAS)) {
    if (k.replace(/[^A-Z0-9]/g, '').toUpperCase() === key) return v;
  }
  return null;
}
