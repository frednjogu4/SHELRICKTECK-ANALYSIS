/** Read-only broker-spec preflight. Never increases size or assumes leverage/margin. */
export function checkMt5OrderSize({ quote, side, usdSize, lotSize = null }) {
  if (!['BUY', 'SELL'].includes(side)) return { ok: false, reason: 'No executable BUY or SELL direction. No order sent.' };
  const price = Number(side === 'BUY' ? quote?.ask : quote?.bid);
  const contract = Number(quote?.contract_size), minLots = Number(quote?.volume_min);
  const step = Number(quote?.volume_step), maxLots = Number(quote?.volume_max);
  if (![price, contract, minLots, step].every(n => Number.isFinite(n) && n > 0)) {
    return { ok: false, reason: 'Live MT5 contract size / minimum lot / volume step unavailable. No order sent; refresh the broker specifications.' };
  }
  const minNotional = minLots * contract * price;
  const explicitLots = lotSize != null;
  const requestedLots = explicitLots ? Number(lotSize) : Number(usdSize) / (contract * price);
  if (!Number.isFinite(requestedLots) || requestedLots <= 0) return { ok: false, reason: 'Invalid MT5 order size. No order sent.' };
  if (requestedLots + 1e-12 < minLots) {
    return { ok: false, minLots, minNotional,
      reason: `${quote.symbol || 'MT5'}: requested ${explicitLots ? requestedLots + ' lots' : '$' + Number(usdSize).toFixed(2) + ' notional'} is below ${minLots} lots (about $${minNotional.toFixed(2)} notional). This is exposure, not required margin or the profit target. Size was not increased. Review the broker minimum lots or choose another market.` };
  }
  if (Number.isFinite(maxLots) && maxLots > 0 && requestedLots > maxLots + 1e-12) return { ok: false, reason: `Requested size exceeds the broker maximum (${maxLots} lots). No order sent.` };
  const lots = Math.floor((requestedLots + 1e-12) / step) * step;
  if (lots + 1e-12 < minLots) return { ok: false, reason: 'Order size rounds below the broker minimum lot. No order sent.' };
  return { ok: true, minLots, minNotional, lots, notional: lots * contract * price };
}

