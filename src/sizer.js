/* Position sizer + trade planner (master prompt §11) — pure, testable, no I/O.

   Contract: planPosition(Input) -> Plan
     status: 'OK' | 'BLOCKED' | 'INCOMPLETE'
     INCOMPLETE = required inputs are missing (never assume values)
     BLOCKED    = an input is invalid or the broker minimum makes the plan impossible
   Money is the app's order currency (USD). If the account currency differs and
   no conversion rate is supplied, the plan is INCOMPLETE — a rate is never
   invented. Tiers (SMALL/MEDIUM/FULL) can only ever shrink the computed size. */

const FORMULA_CFD = 'lots = (equity × risk%) ÷ (|entry − SL| × contractSize × conversionRate), rounded DOWN to the broker step; risk budget = equity × risk%; expected loss = lots × |entry − SL| × contractSize × conversionRate.';

function roundToStep(x, step) {
  if (!(step > 0)) return x;
  const n = Math.floor((x + 1e-9) / step) * step;
  return Number(n.toFixed(8));
}

/**
 * @param {object} i
 *   venue        'cfd' | 'fixed'
 *   CFD: equity, equityCurrency, orderCurrency='USD', conversionRate (equity->order ccy, user-supplied),
 *        riskPct, entry, sl, tp1?, tp2?, side 'BUY'|'SELL',
 *        contractSize, volumeMin, volumeStep, leverage?, feeNote?, maxNotional?
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
  const entry = Number(i?.entry), sl = Number(i?.sl);
  const cs = Number(i?.contractSize), vmin = Number(i?.volumeMin), vstep = Number(i?.volumeStep);
  const side = String(i?.side || 'BUY').toUpperCase();
  const orderCcy = String(i?.orderCurrency || 'USD');
  const equityCcy = String(i?.equityCurrency || orderCcy);
  let conv = Number(i?.conversionRate);

  /* missing required inputs -> INCOMPLETE (never assume) */
  const missing = [];
  if (!Number.isFinite(equity) || equity <= 0) missing.push('account equity');
  if (!Number.isFinite(riskPct) || riskPct <= 0) missing.push('risk %');
  if (!Number.isFinite(entry)) missing.push('entry price');
  if (!Number.isFinite(sl)) missing.push('stop-loss');
  if (!Number.isFinite(cs) || cs <= 0) missing.push('contract size');
  if (!Number.isFinite(vmin) || vmin <= 0) missing.push('broker minimum volume');
  if (!Number.isFinite(vstep) || vstep <= 0) missing.push('broker volume step');
  if (equityCcy !== orderCcy) {
    if (!Number.isFinite(conv) || conv <= 0) missing.push('conversion rate ' + equityCcy + '→' + orderCcy + ' (user-supplied — never assumed)');
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
  const stopDist = Math.abs(entry - sl);
  if (stopDist <= 0) return { status: 'BLOCKED', reason: 'Stop-loss must differ from the entry price.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy };
  if (side === 'BUY' && sl >= entry) return { status: 'BLOCKED', reason: 'Invalid stop: for a BUY the stop-loss must sit below the entry.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy };
  if (side === 'SELL' && sl <= entry) return { status: 'BLOCKED', reason: 'Invalid stop: for a SELL the stop-loss must sit above the entry.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy };

  const riskBudget = equity * riskPct / 100;                       // order ccy after conversion
  const riskBudgetAcct = equityCcy === orderCcy ? riskBudget : equity * riskPct / 100;
  const lossPerLot = stopDist * cs * conv;                         // order ccy
  const lotsRaw = riskBudget / lossPerLot;
  const lots = roundToStep(lotsRaw, vstep);

  const minNotional = vmin * cs * entry * conv;
  const minRiskAtMinLot = vmin * lossPerLot;
  if (lotsRaw < vmin) {
    return {
      status: 'BLOCKED',
      reason: 'Below the broker minimum: the smallest accepted size is ' + vmin + ' lots — at this stop that risks ' + orderCcy + ' ' + minRiskAtMinLot.toFixed(2) + ' (notional ≈ ' + orderCcy + ' ' + minNotional.toFixed(2) + '), far above the ' + orderCcy + ' ' + riskBudget.toFixed(2) + ' risk budget. Widen the risk %, use a tighter stop on a larger size, or pick a smaller instrument.',
      formula: FORMULA_CFD, lots: 0, lotsRaw, notional: minNotional, currency: orderCcy,
      riskBudget, riskBudgetAccount: riskBudgetAcct, expectedLoss: minRiskAtMinLot,
      minNotional, rr: null, marginEstimate: null, tiers: null, inputs, warnings,
    };
  }
  if (lots <= 0) {
    return { status: 'BLOCKED', reason: 'Rounded size is zero — the broker step (' + vstep + ') does not fit this budget.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy, riskBudget };
  }
  if (Number.isFinite(i?.maxNotional)) {
    const notionalCheck = lots * cs * entry * conv;
    if (notionalCheck > Number(i.maxNotional)) {
      return { status: 'BLOCKED', reason: 'Exposure ' + orderCcy + ' ' + notionalCheck.toFixed(2) + ' exceeds the maximum allowed notional ' + orderCcy + ' ' + Number(i.maxNotional).toFixed(2) + '.', formula: FORMULA_CFD, inputs, warnings, currency: orderCcy, riskBudget };
    }
  }

  const notional = lots * cs * entry * conv;
  const expectedLoss = lots * lossPerLot;
  const tp1 = Number(i?.tp1);
  const rr = Number.isFinite(tp1) ? Math.abs(tp1 - entry) / stopDist : null;
  const leverage = Number(i?.leverage);
  const marginEstimate = Number.isFinite(leverage) && leverage > 0 ? notional / leverage : null;
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
    riskBudget, riskBudgetAccount: riskBudgetAcct, expectedLoss, minNotional,
    rr, marginEstimate, leverage: Number.isFinite(leverage) ? leverage : null,
    tiers: { SMALL: mk(0.25), MEDIUM: mk(0.5), FULL: lots },
    inputs, warnings,
  };
}
