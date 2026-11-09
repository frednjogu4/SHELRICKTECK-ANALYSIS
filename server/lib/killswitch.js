/* Kill switch (master prompt §16): one control that halts ALL order flow
   instantly. State is in-memory (survives within the process) seeded from
   env AURUM_KILL_SWITCH=1. Safety asymmetry: DISABLING trading is always
   allowed; RE-ENABLING requires the AURUM_DIAG_KEY when one is configured. */

let enabled = String(process.env.AURUM_KILL_SWITCH || '') === '1';

export function isTradingKilled() { return enabled; }

/** @returns {{ok:boolean, enabled:boolean, detail?:string}} */
export function setTradingKilled(on, diagKey) {
  if (on) {
    enabled = true;
    return { ok: true, enabled: true };
  }
  const need = String(process.env.AURUM_DIAG_KEY || '');
  if (need && String(diagKey || '') !== need) {
    return { ok: false, enabled, detail: 'Re-enabling trading requires the diagnostics key (AURUM_DIAG_KEY). Disabling is always allowed.' };
  }
  enabled = false;
  return { ok: true, enabled: false };
}

/** Express middleware: 503 kill_switch on any order-moving route. */
export function requireTrading(req, res, next) {
  if (enabled) {
    return res.status(503).json({
      error: 'kill_switch',
      detail: 'Trading is disabled by the kill switch — the owner must re-enable it in Settings (security) before any order can pass.',
    });
  }
  next();
}
