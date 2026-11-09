/* ================================================================
 * AURUM — notifications engine (browser Notification + in-app toast).
 * Used for: connection changes, news briefs, trade open/close,
 * SL / TP1 / TP2 crossings with guidance.
 * ================================================================ */

let toastFn = null;
export function initNotifications(toastImpl) { toastFn = toastImpl; }

export function notifState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

/** Ask for permission (must follow a user gesture). */
export async function enableNotifications() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch (e) {
    return 'denied';
  }
}

/**
 * Notify the user: always an in-app toast; additionally a system
 * notification when permission is granted.
 */
export function notify(title, body, opts = {}) {
  const { tag = 'aurum', kind = '' } = opts;
  if (toastFn) toastFn(title, body, kind);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification('AURUM · ' + title, { body: body || '', tag });
      n.onclick = () => { try { window.focus(); } catch (e) { /* noop */ } n.close(); };
    } catch (e) { /* toast already shown */ }
  }
}

/** Level-guidance phrasing used by the SL/TP watcher. */
export const LEVEL_GUIDE = {
  sl: (sym, side, px) => `${sym}: stop-loss ${px} hit (${side}) — position closed. Review the setup before re-entering.`,
  tp1: (sym, side, px) => `${sym}: TP1 ${px} reached. Guidance: move stop-loss to entry, bank part if you scale out.`,
  tp2: (sym, side, px) => `${sym}: TP2 ${px} reached. Guidance: trail the remainder or close — target ${'achieved'}.`,
  partial: (sym, side, px) => `${sym}: price ${px} — approaching a level. Watch ${side === 'BUY' ? 'support' : 'resistance'}.`
};
