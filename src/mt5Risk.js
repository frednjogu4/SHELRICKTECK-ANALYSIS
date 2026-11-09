/* Exness open-trade reconciliation.
   The cloud server's in-memory counter cannot observe MT5 phone/desktop positions.
   This helper allows replacing ONLY a failed open_trades check with a fresh,
   local MT5 position snapshot. Every other failed/unknown mandatory check stays blocked. */
export function isOnlyOpenTradesGateFailure(gate) {
  if (gate?.error !== 'risk_blocked' || !Array.isArray(gate.checks)) return false;
  const mandatory = gate.checks.filter((c) => c && c.mandatory !== false);
  const failed = mandatory.filter((c) => c.status !== 'PASSED');
  return failed.length === 1 && failed[0].name === 'open_trades' && failed[0].status === 'FAILED';
}

export function openTradesLimitFromGate(gate) {
  if (!isOnlyOpenTradesGateFailure(gate)) return null;
  const check = gate.checks.find((c) => c?.name === 'open_trades');
  const match = String(check?.evidence || '').match(/(?:^|\s)max=(\d+)(?:\s|$)/);
  const limit = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

export function verifyBrokerOpenTradeCount(gate, positions) {
  if (!isOnlyOpenTradesGateFailure(gate)) {
    return { ok: false, reason: 'The server risk gate has another failed or unknown check; the Exness order remains blocked.' };
  }
  const limit = openTradesLimitFromGate(gate);
  if (!limit) return { ok: false, reason: 'Could not verify the configured open-trades limit; the Exness order remains blocked.' };
  if (!Array.isArray(positions)) {
    return { ok: false, reason: 'MT5 did not provide a verified open-positions list; the Exness order remains blocked.' };
  }
  const count = positions.length;
  if (count >= limit) {
    return { ok: false, count, limit, reason: 'MT5 currently reports ' + count + '/' + limit + ' open positions. The existing limit blocks this order; no order was sent.' };
  }
  return { ok: true, count, limit };
}
