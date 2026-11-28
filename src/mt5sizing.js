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


/** Verify a read-only quote response using bridge UTC when available, not the phone/browser clock.
 * Add the entire measured round trip conservatively; never refresh the tick's timestamp locally.
 */
export function inspectMt5Quote(result, { symbol, nowMs = Date.now(), roundTripMs = 0 } = {}) {
  const fail = (code, reason, retryable = false) => ({ ok: false, code, reason: reason + ' No order sent.', retryable });
  const quotes = result?.quotes;
  const quote = Array.isArray(quotes) && quotes.length === 1 ? quotes[0] : null;
  if (!quote) {
    const unresolved = result?.unresolved?.[0];
    if (unresolved?.resolved) return fail('NO_TICK', `${unresolved.resolved}: MT5 has no current tick. Open this symbol in Market Watch and wait for bid/ask prices.`, true);
    if (unresolved?.message) return fail('SYMBOL_UNAVAILABLE', String(unresolved.message));
    return fail('NO_QUOTE', `${symbol || 'MT5'}: no quote returned. Check MT5 connection and enable the exact broker symbol in Market Watch.`, true);
  }
  const clean = s => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (quote.requested_symbol && symbol && clean(quote.requested_symbol) !== clean(symbol)) {
    return fail('SYMBOL_MISMATCH', 'MT5 quote response does not match the requested market. Refresh the bridge.');
  }
  const bid = Number(quote.bid), ask = Number(quote.ask);
  if (![bid, ask].every(n => Number.isFinite(n) && n > 0) || ask < bid) {
    return fail('INVALID_PRICES', `${quote.symbol || symbol}: live MT5 bid/ask prices are unavailable or invalid. Wait for Market Watch prices to resume.`, true);
  }
  const epochMs = value => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : NaN;
  };
  const tickMs = epochMs(Number(quote.time_msc) > 0 ? quote.time_msc : quote.time);
  if (!Number.isFinite(tickMs)) return fail('NO_TICK_TIME', `${quote.symbol || symbol}: MT5 returned no valid tick timestamp. Reconnect MT5/bridge and wait for a live tick.`);
  // Older bridges already supplied spec_at from the bridge clock. Never substitute spec_at FOR tick time.
  const reference = result?.server_time_ms ?? quote.spec_at ?? nowMs;
  const referenceMs = epochMs(reference);
  if (!Number.isFinite(referenceMs) || !Number.isFinite(roundTripMs) || roundTripMs < 0) {
    return fail('INVALID_CLOCK', 'Quote timing could not be verified. Synchronize the MT5 PC clock and reconnect the bridge.');
  }
  const ageMs = referenceMs - tickMs;
  if (ageMs < -5000) return fail('FUTURE_TICK', `${quote.symbol || symbol}: tick time is ahead of the MT5 bridge clock. Synchronize Windows date/time on the MT5 PC and reconnect.`);
  if (ageMs + roundTripMs > 60000) {
    return fail('STALE_QUOTE', `${quote.symbol || symbol}: last MT5 tick is ${Math.max(0, Math.floor((ageMs + roundTripMs) / 1000))}s old (60s limit). Market may be closed or the feed paused. Check MT5 connection/Market Watch and retry when live prices resume.`);
  }
  return { ok: true, quote: { ...quote, time: tickMs / 1000 }, ageMs: ageMs + roundTripMs };
}
