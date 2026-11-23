import test from 'node:test';
import assert from 'node:assert/strict';
import { planPosition } from '../src/sizer.js';

/* Independent hand-calculated examples (Phase 5 matrix).
   Every expected value below was computed on paper from the formula:
     budgetAcct  = equity × risk% / 100
     budget      = budgetAcct ÷ conversionRate          (order currency)
     buffered    = budget ÷ riskBuffer
     lossPerLot  = |entry − SL| × contractSize          (order currency / lot)
     lotsRaw     = buffered ÷ lossPerLot                -> floored to volume step
     notional    = lots × contractSize × entry
     expected    = lots × lossPerLot                    (must be ≤ buffered)
     marginAcct  = (notional ÷ conversionRate) ÷ leverage */

const near = (got, want, tol = 1e-9) => assert.ok(Math.abs(got - want) <= tol, `expected ${want}, got ${got}`);

test('gold: broker minimum at a $31.50 stop is BLOCKED with the exact numbers (their reported case)', () => {
  const p = planPosition({
    venue: 'cfd', equity: 71.67, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 0.5, riskBuffer: 1.25, side: 'BUY', entry: 3684.79, sl: 3653.29, tp1: 3700,
    contractSize: 100, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 200, leverage: 400,
    maxNotional: 716.7,
  });
  assert.equal(p.status, 'BLOCKED');
  assert.match(p.reason, /Below the broker minimum/);
  assert.match(p.reason, /31\.50/);            // min-lot stop risk
  assert.match(p.reason, /3684\.79/);          // min-lot notional
  assert.match(p.reason, /0\.36/);             // risk budget 71.67 × 0.5%
  assert.match(p.reason, /×1\.25/);            // bridge buffer stated
  assert.match(p.reason, /0\.29/);             // buffered allowance 0.35835/1.25
  near(p.minNotional, 3684.79);
  near(p.expectedLoss, 31.50);
  near(p.riskBudget, 71.67 * 0.5 / 100);
  near(p.riskBudgetBuffered, 71.67 * 0.5 / 100 / 1.25);
  assert.equal(p.lots, 0);
});

test('forex: budget-sized EURUSD plan under the bridge buffer (independent numbers)', () => {
  // budget 10000×0.5% = 50 USD → buffered 40; stop 0.0008 × 100000 = 80/lot → 0.5 lots
  const p = planPosition({
    venue: 'cfd', equity: 10000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 0.5, riskBuffer: 1.25, side: 'BUY', entry: 1.1, sl: 1.0992, tp1: 1.1016,
    contractSize: 100000, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 100, leverage: 400,
  });
  assert.equal(p.status, 'OK');
  near(p.lots, 0.5);
  near(p.expectedLoss, 40);
  near(p.notional, 55000);
  near(p.marginEstimate, 55000 / 400);
  near(p.rr, 2);
  near(p.riskBudgetBuffered, 40);
  assert.ok(p.expectedLoss <= p.riskBudgetBuffered + 1e-9);
  assert.deepEqual(p.tiers, { SMALL: 0.12, MEDIUM: 0.25, FULL: 0.5 });
});

test('silver: 5000-oz contract, 0.4 stop, 1% risk — floor and clamps', () => {
  // budget 5000×1% = 50; stop 0.4 × 5000 = 2000/lot → 0.025 → floor 0.02
  const p = planPosition({
    venue: 'cfd', equity: 5000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 1, side: 'BUY', entry: 30.5, sl: 30.1, tp1: 31.3,
    contractSize: 5000, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 50, leverage: 200,
  });
  assert.equal(p.status, 'OK');
  near(p.lots, 0.02);
  near(p.expectedLoss, 40);
  near(p.notional, 3050);
  near(p.marginEstimate, 3050 / 200);
  assert.ok(p.expectedLoss <= p.riskBudget + 1e-9);
});

test('oil: 1000-barrel contract sizes to the step', () => {
  // budget 20000×0.5% = 100; stop 0.5 × 1000 = 500/lot → 0.2 lots
  const p = planPosition({
    venue: 'cfd', equity: 20000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 0.5, side: 'SELL', entry: 72.5, sl: 73.0, tp1: 71.5,
    contractSize: 1000, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 100, leverage: 100,
  });
  assert.equal(p.status, 'OK');
  near(p.lots, 0.2);
  near(p.expectedLoss, 100);
  near(p.notional, 14500);           // 0.2 × 1000 bbl × 72.5
  near(p.marginEstimate, 14500 / 100);
});

test('index: 10-multiplier CFD under the bridge buffer', () => {
  // budget 100000×0.5% = 500 → buffered 400; stop 10 × 10 = 100/lot → 4 lots
  const p = planPosition({
    venue: 'cfd', equity: 100000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 0.5, riskBuffer: 1.25, side: 'BUY', entry: 7350, sl: 7340, tp1: 7380,
    contractSize: 10, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 500, leverage: 200,
  });
  assert.equal(p.status, 'OK');
  near(p.lots, 4);
  near(p.expectedLoss, 400);
  near(p.notional, 294000);
  near(p.marginEstimate, 294000 / 200);
});

test('crypto: contract-size-1 instrument with a wide stop', () => {
  // budget 50000×2% = 1000; stop 500 × 1 = 500/lot → 2 lots
  const p = planPosition({
    venue: 'cfd', equity: 50000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 2, side: 'BUY', entry: 91500, sl: 91000, tp1: 92500,
    contractSize: 1, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 100, leverage: 5,
  });
  assert.equal(p.status, 'OK');
  near(p.lots, 2);
  near(p.expectedLoss, 1000);
  near(p.notional, 183000);
  near(p.marginEstimate, 183000 / 5);
  assert.ok(p.expectedLoss <= p.riskBudget + 1e-9);
});

test('account currency: EUR account trading USD forex — units never mixed', () => {
  // budget 10000 EUR × 0.5% = 50 EUR; conv 0.92 EUR per 1 USD → 54.347826 USD
  // stop 0.0008 × 100000 = 80/lot → 0.67934… → floor 0.67 lots
  const p = planPosition({
    venue: 'cfd', equity: 10000, equityCurrency: 'EUR', orderCurrency: 'USD', conversionRate: 0.92,
    riskPct: 0.5, side: 'BUY', entry: 1.1, sl: 1.0992, tp1: 1.104,
    contractSize: 100000, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 100, leverage: 400,
  });
  assert.equal(p.status, 'OK');
  near(p.riskBudgetAccount, 50);
  near(p.riskBudget, 50 / 0.92);
  near(p.lots, 0.67);
  near(p.notional, 0.67 * 100000 * 1.1);          // order currency (USD)
  near(p.expectedLoss, 0.67 * 80);                // order currency (USD)
  near(p.marginEstimate, (0.67 * 100000 * 1.1) / 0.92 / 400);  // account currency (EUR)
  assert.ok(p.expectedLoss <= p.riskBudget + 1e-9);
});

test('account currency: missing conversion rate is INCOMPLETE — never assumed', () => {
  const p = planPosition({
    venue: 'cfd', equity: 10000, equityCurrency: 'JPY', orderCurrency: 'USD',
    riskPct: 0.5, side: 'BUY', entry: 1.1, sl: 1.0992,
    contractSize: 100000, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 100,
  });
  assert.equal(p.status, 'INCOMPLETE');
  assert.match(p.reason, /conversion rate JPY→USD/);
  assert.match(p.reason, /No values are assumed/);
});

test('leverage levels scale margin only — never risk or notional', () => {
  const mk = (leverage) => planPosition({
    venue: 'cfd', equity: 20000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 0.5, side: 'BUY', entry: 72.5, sl: 72.0, tp1: 73.5,
    contractSize: 1000, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 100, leverage,
  });
  const a = mk(100), b = mk(400);
  assert.equal(a.status, 'OK');
  assert.equal(b.status, 'OK');
  near(a.notional, b.notional);
  near(a.expectedLoss, b.expectedLoss);
  near(a.marginEstimate, b.notional / 100);
  near(b.marginEstimate, b.notional / 400);
  near(a.marginEstimate / b.marginEstimate, 4);
});

test('minimum-volume boundary: exactly affordable plans at the floor; one cent below blocks', () => {
  // lossPerLot = 80 (stop 80 × cs 100? — use stop 8, cs 1000): floor risk = 0.01 × 8000 = 80
  const mk = (riskPct) => planPosition({
    venue: 'cfd', equity: 20000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct, riskBuffer: 1.25, side: 'BUY', entry: 8000, sl: 7992, tp1: 8040,
    contractSize: 1000, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 200, leverage: 400,
  });
  const atFloor = mk(0.5);   // budget 100 → buffered 80 = exactly the min-lot risk
  assert.equal(atFloor.status, 'OK');
  near(atFloor.lots, 0.01);
  near(atFloor.expectedLoss, 80);
  const below = mk(0.4999);  // budget 99.98 → buffered 79.984 < 80
  assert.equal(below.status, 'BLOCKED');
  assert.match(below.reason, /Below the broker minimum/);
});

test('volume-step boundary: 0.019 lots rounds DOWN to 0.01 — never up', () => {
  // budget 38000×0.5% = 190 → buffered 152 ÷ 8000/lot = 0.019
  const p = planPosition({
    venue: 'cfd', equity: 38000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 0.5, riskBuffer: 1.25, side: 'BUY', entry: 8000, sl: 7992, tp1: 8040,
    contractSize: 1000, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 200, leverage: 400,
  });
  assert.equal(p.status, 'OK');
  near(p.lots, 0.01);
  assert.ok(p.lots * 8000 <= p.riskBudgetBuffered + 1e-9);
});

test('broker maximum volume clamps the plan', () => {
  // budget 800000×0.5% = 4000 → buffered 3200 ÷ 100/lot = 32 lots, but vmax = 10
  const p = planPosition({
    venue: 'cfd', equity: 800000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 0.5, riskBuffer: 1.25, side: 'BUY', entry: 7350, sl: 7340, tp1: 7400,
    contractSize: 10, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 10, leverage: 200,
  });
  assert.equal(p.status, 'OK');
  near(p.lots, 10);
});

test('exposure cap: broker minimum lot exempt, non-floor size above the cap blocks', () => {
  const base = {
    venue: 'cfd', equity: 20000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 0.5, riskBuffer: 1.25, side: 'BUY', entry: 8000, sl: 7992, tp1: 8040,
    contractSize: 1000, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 200, leverage: 400,
    maxNotional: 500,
  };
  const floor = planPosition(base);                    // 0.01 lots × 1000 × 8000 = 80 000 notional (the floor)
  assert.equal(floor.status, 'OK');                    // floor exempt from the 500 cap
  near(floor.lots, 0.01);
  const above = planPosition({ ...base, riskPct: 1.6 }); // budget 320 → buffered 256 → 0.032 → 0.03 lots > floor
  assert.equal(above.status, 'BLOCKED');
  assert.match(above.reason, /exceeds the maximum allowed notional/);
  assert.match(above.reason, /broker minimum lot exempt/);
});

test('missing broker metadata blocks with the exact missing fields — never substituted', () => {
  const base = {
    venue: 'cfd', equity: 10000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 0.5, side: 'BUY', entry: 1.1, sl: 1.0992,
    volumeMin: 0.01, volumeStep: 0.01, volumeMax: 100,
  };
  const noContract = planPosition({ ...base, contractSize: null });
  assert.equal(noContract.status, 'INCOMPLETE');
  assert.match(noContract.reason, /missing: contract size/);
  const noSpecs = planPosition({ ...base, contractSize: 100000, volumeMin: null, volumeStep: null, volumeMax: null });
  assert.equal(noSpecs.status, 'INCOMPLETE');
  assert.match(noSpecs.reason, /broker minimum volume/);
  assert.match(noSpecs.reason, /broker volume step/);
  assert.match(noSpecs.reason, /broker maximum volume/);
  const noQuote = planPosition({ ...base, contractSize: 100000, entry: null });
  assert.equal(noQuote.status, 'INCOMPLETE');
  assert.match(noQuote.reason, /missing: entry price/);
});

test('stop-distance changes: a tighter stop sizes up within budget, never beyond it', () => {
  const mk = (sl) => planPosition({
    venue: 'cfd', equity: 10000, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 0.5, side: 'BUY', entry: 2600, sl, tp1: 2620,
    contractSize: 100, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 100, leverage: 400,
  });
  const tight = mk(2595);   // stop 5 → 500/lot → 0.1 lots (budget 50)
  const wide = mk(2590);    // stop 10 → 1000/lot → 0.05 lots
  assert.equal(tight.status, 'OK');
  assert.equal(wide.status, 'OK');
  near(tight.lots, 0.1);
  near(wide.lots, 0.05);
  assert.ok(tight.lots > wide.lots);
  assert.ok(tight.expectedLoss <= tight.riskBudget + 1e-9);
  assert.ok(wide.expectedLoss <= wide.riskBudget + 1e-9);
});

test('no calculation silently increases a position beyond the permitted risk (float grid)', () => {
  const equities = [71.67, 1000, 9999.99, 25000.5];
  const stops = [0.0007, 0.0013, 0.42, 5.5, 31.5];
  const contracts = [1, 10, 100, 1000, 100000];
  const buffers = [1, 1.25];
  let checked = 0;
  for (const equity of equities) for (const stop of stops) for (const cs of contracts) for (const riskBuffer of buffers) {
    const p = planPosition({
      venue: 'cfd', equity, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
      riskPct: 0.5, riskBuffer, side: 'BUY', entry: 100, sl: 100 - stop, tp1: 100 + stop * 1.5,
      contractSize: cs, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 1000, leverage: 400,
    });
    if (p.status !== 'OK') continue;
    const budget = equity * 0.5 / 100 / riskBuffer;
    assert.ok(p.lots <= p.lotsRaw + 1e-12, `lots ${p.lots} exceeded raw ${p.lotsRaw}`);
    assert.ok(p.expectedLoss <= budget + 1e-9, `loss ${p.expectedLoss} exceeded buffered budget ${budget} (equity ${equity}, stop ${stop}, cs ${cs}, buffer ${riskBuffer})`);
    checked++;
  }
  assert.ok(checked > 100, `expected a broad grid, checked ${checked}`);
});

test('float noise at a step boundary never rounds a size above the budget', () => {
  const mk = (equity) => planPosition({
    venue: 'cfd', equity, equityCurrency: 'USD', orderCurrency: 'USD', conversionRate: 1,
    riskPct: 1, side: 'BUY', entry: 100, sl: 99, tp1: 102,
    contractSize: 1, volumeMin: 0.01, volumeStep: 0.01, volumeMax: 1000, leverage: 100,
  });
  for (const equity of [29.999999999999996, 30, 30.000000000000004, 0.30000000000000004]) {
    const p = mk(equity);
    if (p.status !== 'OK') continue;
    assert.ok(p.expectedLoss <= p.riskBudgetBuffered + 1e-9, `equity ${equity}: ${p.expectedLoss} > ${p.riskBudgetBuffered}`);
  }
});

test('fixed-risk (Deriv) venue: maximum loss is exactly the stake', () => {
  const p = planPosition({ venue: 'fixed', stake: 10, currency: 'USD', equity: 1000, riskPct: 1 });
  assert.equal(p.status, 'OK');
  assert.equal(p.notional, 10);
  assert.equal(p.expectedLoss, 10);
  assert.equal(planPosition({ venue: 'fixed', stake: NaN, currency: 'USD' }).status, 'BLOCKED');
});
