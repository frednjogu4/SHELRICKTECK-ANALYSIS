/* Position sizer + trade planner (master prompt §11) — pure, testable, no I/O.

   Contract: planPosition(Input) -> Plan
     status: 'OK' | 'BLOCKED' | 'INCOMPLETE'
     INCOMPLETE = required inputs are missing (never assume values)
     BLOCKED    = an input is invalid or the broker minimum makes the plan impossible

   UNITS (explicit, never mixed):
     - 'order currency'  = the instrument's profit currency (this app: USD).
                            notional, expectedLoss, minNotional, minRiskAtMinLot,
                            riskBudget, riskBudgetBuffered are ORDER currency.
     - 'account currency' = the broker account's currency (equityCurrency).
                            riskBudgetAccount and marginEstimate are ACCOUNT currency.
     - conversionRate      = how many ACCOUNT-currency units equal 1 ORDER-currency
                            unit (e.g. 129 JPY per 1 USD). Supplied by the user —
                            never fetched, never assumed; 1 when both are the same.

   riskBuffer (default 1) = spread/slippage buffer the execution bridge applies to
     stop loss before its per-order risk cap (Exness bridge: 1.25, i.e. raw loss
     must leave 25% headroom). The UI sizes from the BUFFERED budget so an
     UI-eligible size is bridge-eligible too.

   Tiers (SMALL/MEDIUM/FULL) can only ever shrink the computed size. Volumes are
   rounded DOWN to the broker step — a position is never sized above the budget. */

const FORMULA_CFD = 'lots = ((equity × risk% ÷ conversion) ÷ buffer) ÷ (|entry − SL| × contractSize), rounded DOWN to the broker step; risk budget = equity × risk% (account currency), shown in order currency after conversion; buffered budget = risk budget ÷ spread/slippage buffer (1.25 on the Exness bridge); expected loss = lots × |entry − SL| × contractSize.';

function roundToStep(x, step) {
  if (!(step > 0)) return x;
  /* Strict floor: IEEE noise may size one step SMALLER, never larger — a position
     never exceeds the permitted risk. */
  const n = Math.floor(x / step) * step;
  return Number(n.toFixed(8));
}

/**
 * @param {object} i
 *   venue        'cfd' | 'fixed'
 *   CFD: equity, equityCurrency, orderCurrency='USD', conversionRate (ACCOUNT per ORDER, user-supplied),
 *        riskPct, entry, sl, tp1?, tp2?, side 'BUY'|'SELL',
 *        contractSize, volumeMin, volumeStep, volumeMax, leverage?, feeNote?,
 *        maxNotional? (ACCOUNT currency; broker minimum lot exempt, matching the bridge),
 *        riskBuffer? (default 1; Exness bridge passes 1.25)
 *   fixed: stake, currency, payout?
 */
export function planPosition(i) {
  const warnings = [];
  const inputs = Object.assign({}, i);

  if (i?.venue === 'fixed') {
    const stake = Number(i.stake);
    if (!Number.isFinite(stake) || stake <= 0) return { status: 'BLOCKED', reason: 'Stake must be a positive number.', inputs, warnings };
    const eq = Number(i.equity), rp = Number(i.riskPct);
    const budget = Number.isFinite(eq) && Number.isFinite(rp) ? eq * rp / 100 : null;
    warnings.push('Fixed-risk contract: the maximum loss is exactly the stake. Stop-loss levels are monitored, not guaranteed.');
    return {
      status: 'OK', reason: 'Stake-risked contract: maximum loss = stake.',
      formula: 'max loss = stake (fixed-risk contract). Risk budget = equity × risk%.',
      lots: null, lotsRaw: null, notional: stake, currency: i.currency || 'USD',
      riskBudget: budget, expectedLoss: stake, rr: null, marginEstimate: null,
      tiers: null, inputs, warnings,
    };
  }

  const equity = Number(i?.equity), riskPct = Number(i?.riskPct);
  /* null/undefined prices are MISSING inputs — never coerced to 0 (0 would pass
     isFinite and mislabel a stale quote as an invalid stop or silent size). */
  const entry = i?.entry == null ? NaN : Number(i?.entry);
  const sl = i?.sl == null ? NaN : Number(i?.sl);
  const cs = Number(i?.contractSize), vmin = Number(i?.volumeMin), vstep = Number(i?.volumeStep), vmax = Number(i?.volumeMax);
  const side = String(i?.side || 'BUY').toUpperCase();
  const orderCcy = String(i?.orderCurrency || 'USD');
  const equityCcy = String(i?.equityCurrency || orderCcy);
  let conv = Number(i?.conversionRate);
  const riskBufferRaw = Number(i?.riskBuffer);
  const riskBuffer = Number.isFinite(riskBufferRaw) && riskBufferRaw >= 1 ? riskBufferRaw : 1;

  /* missing required inputs -> INCOMPLETE (never assume) */
  const missing = [];
  if (!Number.isFinite(equity) || equity <= 0) missing.push('account equity');
  if (!Number.isFinite(riskPct) || riskPct <= 0) missing.push('risk %');
  if (!Number.isFinite(entry)) missing.push('entry price');
  if (!Number.isFinite(sl)) missing.push('stop-loss');
  if (!Number.isFinite(cs) || cs <= 0) missing.push('contract size');
  if (!Number.isFinite(vmin) || vmin <= 0) missing.push('broker minimum volume');
  if (!Number.isFinite(vstep) || vstep <= 0) missing.push('broker volume step');
  if (!Number.isFinite(vmax) || vmax <= 0) missing.push('broker maximum volume');
  if (equityCcy !== orderCcy) {
    if (!Number.isFinite(conv) || conv <= 0) missing.push('conversion rate ' + equityCcy + '→USD (you supply — never fetched, never assumed)');
    } else { conv = 1; }
  if (missing.length) {
    return {
      status: 'INCOMPLETE', reason: 'Calculation incomplete — missing: ' + missing.join(', ') + '. No values are assumed.',
      formula: FORMULA_CFD, lots: null, lotsRaw: null, notional: null, currency: orderCcy,
      riskBudget: Number.isFinite(equity) && Number.isFinite(riskPct) ? equity * riskPct / 100 : null,
      expectedLoss: null, rr: null, marginEstimate: null, tiers: null, inputs, warnings,
    };
  }

  /* invalid stops -> BLOCKED */
  /* Normalize user/broker floats to 12 significant digits first: IEEE noise from
     |entry − sl| must not flip a step boundary (the floor itself never rounds up). */
  const stopDist = Number(Math.abs(entry - sl).toPrecision(12));
  if (stopDist <= 0) return { status: 'BLOCKED', reason: 'Stop-loss must differ from the entry price.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy };
  if (side === 'BUY' && sl >= entry) return { status: 'BLOCKED', reason: 'Invalid stop: for a BUY the stop-loss must sit below the entry.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy };
  if (side === 'SELL' && sl <= entry) return { status: 'BLOCKED', reason: 'Invalid stop: for a SELL the stop-loss must sit above the entry.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy };

  /* Budget chain in explicit units:
     riskBudgetAccount (ACCOUNT ccy) -> riskBudget (ORDER ccy) -> riskBudgetBuffered
     (ORDER ccy, what the bridge's buffered risk cap actually enforces). */
  const riskBudgetAccount = equity * riskPct / 100;
  const riskBudget = riskBudgetAccount / conv;
  const riskBudgetBuffered = riskBudget / riskBuffer;
  const lossPerLot = stopDist * cs;                                    // ORDER ccy per lot
  const lotsRaw = Number((riskBudgetBuffered / lossPerLot).toPrecision(12));
  if (vmax < vmin) return { status: 'BLOCKED', reason: 'Broker maximum volume is below its minimum volume.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy };
  const brokerMaxLots = roundToStep(vmax, vstep);
  if (brokerMaxLots < vmin) return { status: 'BLOCKED', reason: 'Broker maximum volume cannot reach the broker minimum after applying its volume step.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy };

  const minNotional = vmin * cs * entry;                               // ORDER ccy
  const minRiskAtMinLot = vmin * lossPerLot;                           // ORDER ccy (raw, unbuffered)
  if (lotsRaw < vmin) {
    const bufferNote = riskBuffer > 1
      ? ' (the bridge buffers stop risk ×' + riskBuffer + ' — at most ' + riskBudgetBuffered.toFixed(2) + ' raw loss is acceptable)'
      : '';
    return {
      status: 'BLOCKED',
      reason: 'Below the broker minimum: the smallest accepted size is ' + vmin + ' lots — at this stop that risks ' + orderCcy + ' ' + minRiskAtMinLot.toFixed(2) + ' (notional ≈ ' + orderCcy + ' ' + minNotional.toFixed(2) + '), far above the ' + orderCcy + ' ' + riskBudget.toFixed(2) + ' risk budget' + bufferNote + '. Widen the risk %, use a tighter stop on a larger size, or pick a smaller instrument.',
      formula: FORMULA_CFD, lots: 0, lotsRaw, notional: minNotional, currency: orderCcy,
      riskBudget, riskBudgetAccount, riskBudgetBuffered, expectedLoss: minRiskAtMinLot,
      minNotional, rr: null, marginEstimate: null, tiers: null, inputs, warnings,
    };
  }

  /* Round DOWN to the broker step (never above the buffered budget), clamp to the
     broker range, then re-verify the invariant — IEEE noise may only step DOWN. */
  let lots = Math.max(vmin, Math.min(roundToStep(lotsRaw, vstep), brokerMaxLots));
  if (lots * lossPerLot > riskBudgetBuffered * (1 + 1e-12)) {
    lots = Math.max(0, roundToStep(lots - vstep, vstep));
  }
  if (!(lots >= vmin)) {
    return { status: 'BLOCKED', reason: 'Rounded size is below the broker minimum — the volume step (' + vstep + ') cannot represent a size that fits this budget.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy, riskBudget, riskBudgetBuffered };
  }

  if (Number.isFinite(i?.maxNotional)) {
    /* maxNotional is ACCOUNT currency. The broker minimum lot is exempt (matches
       the bridge): the floor cannot be reduced below and still fits the risk cap. */
    const notionalAcct = lots * cs * entry * conv;
    const floorAcct = minNotional * conv;
    if (notionalAcct > Number(i.maxNotional) && notionalAcct > floorAcct * (1 + 1e-9)) {
      return { status: 'BLOCKED', reason: 'Exposure ' + equityCcy + ' ' + notionalAcct.toFixed(2) + ' exceeds the maximum allowed notional ' + equityCcy + ' ' + Number(i.maxNotional).toFixed(2) + ' (broker minimum lot exempt).', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy, riskBudget, riskBudgetBuffered };
    }
  }

  const notional = lots * cs * entry;                                  // ORDER ccy
  const expectedLoss = lots * lossPerLot;                              // ORDER ccy, raw at SL
  const tp1 = i?.tp1 == null ? NaN : Number(i?.tp1);
  const rr = Number.isFinite(tp1) ? Math.abs(tp1 - entry) / stopDist : null;
  const leverage = Number(i?.leverage);
  const marginEstimate = Number.isFinite(leverage) && leverage > 0 ? (notional / conv) / leverage : null;  // ACCOUNT ccy
  if (marginEstimate == null) warnings.push('Leverage unknown — margin not estimated (never assumed).');
  warnings.push('A stop-loss does not guarantee the exact exit price — gaps and slippage can widen the loss beyond the estimate.');
  if (i?.feeNote) warnings.push('Costs: ' + String(i.feeNote)); else warnings.push('Fees/spread not included — no cost data supplied (not assumed).');

  const mk = (frac) => {
    const t = roundToStep(lotsRaw * frac, vstep);
    return t >= vmin ? t : null;
  };
  return {
    status: 'OK', reason: 'Size fits the risk budget and the broker minimum.',
    formula: FORMULA_CFD, lots, lotsRaw, notional, currency: orderCcy,
    riskBudget, riskBudgetAccount, riskBudgetBuffered, expectedLoss, minNotional,
    rr, marginEstimate, leverage: Number.isFinite(leverage) ? leverage : null,
    tiers: { SMALL: mk(0.25), MEDIUM: mk(0.5), FULL: lots },
    inputs, warnings,
  };
}
