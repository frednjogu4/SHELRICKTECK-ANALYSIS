import test from 'node:test';
import assert from 'node:assert/strict';
import { planPosition } from '../../src/sizer.js';

const cfd = {
  venue: 'cfd', equity: 10000, equityCurrency: 'USD', orderCurrency: 'USD',
  riskPct: 2, entry: 46000, sl: 45900, tp1: 46200, side: 'BUY',
  contractSize: 1, volumeMin: 0.1, volumeStep: 0.01, volumeMax: 100, leverage: 100,
};

test('sizer: full CFD plan computes lots (rounded DOWN to step), loss <= budget, formula shown', () => {
  const p = planPosition(cfd);
  assert.equal(p.status, 'OK');
  assert.equal(p.riskBudget, 200);                    // 10000 * 2%
  assert.ok(p.lots > 0 && p.lots <= p.lotsRaw);       // floored to step
  assert.ok(Math.abs(p.lots - 2.0) < 1e-6);           // $200 budget / $100 risk-per-lot = 2.0 lots
  assert.ok(p.expectedLoss <= p.riskBudget + 1e-6);
  assert.match(p.formula, /rounded DOWN to the broker step/);
  assert.ok(p.warnings.some(w => /slippage/i.test(w)));
  assert.equal(p.tiers.FULL, p.lots);
  assert.ok(p.tiers.MEDIUM < p.tiers.FULL);
});

test('sizer: broker maximum volume caps the rounded size and rejects missing maximum specs', () => {
  const capped = planPosition({ ...cfd, volumeMax: 0.5 });
  assert.equal(capped.status, 'OK');
  assert.equal(capped.lots, 0.5);
  assert.ok(capped.expectedLoss <= capped.riskBudget);
  assert.equal(planPosition({ ...cfd, volumeMax: undefined }).status, 'INCOMPLETE');
  assert.equal(planPosition({ ...cfd, volumeMax: 0.05 }).status, 'BLOCKED');
});

test('sizer: cross-currency WITHOUT a conversion rate is INCOMPLETE — never assumed', () => {
  const p = planPosition({ ...cfd, equityCurrency: 'KES' });
  assert.equal(p.status, 'INCOMPLETE');
  assert.match(p.reason, /conversion rate KES/);
  assert.match(p.reason, /never assumed/);
  assert.equal(p.lots, null);
});

test('sizer: cross-currency WITH a user-supplied rate works', () => {
  // conversionRate is ACCOUNT currency per 1 ORDER currency unit (here: 129 KES per 1 USD).
  // 1,290,000 KES equity → 25,800 KES budget → 200 USD → 2 lots at $100 risk/lot.
  const p = planPosition({ ...cfd, equity: 1290000, equityCurrency: 'KES', conversionRate: 129 });
  assert.equal(p.status, 'OK');
  assert.ok(p.riskBudget > 0);
  assert.ok(Math.abs(p.riskBudget - 200) < 1e-6);   // budget expressed in order currency (USD)
  assert.ok(Math.abs(p.riskBudgetAccount - 25800) < 1e-6); // account currency (KES)
});

test('sizer: missing stop or wrong-side stop is BLOCKED; missing entry is INCOMPLETE', () => {
  assert.equal(planPosition({ ...cfd, sl: undefined }).status, 'INCOMPLETE');
  assert.equal(planPosition({ ...cfd, sl: 46000 }).status, 'BLOCKED');            // equal
  assert.equal(planPosition({ ...cfd, side: 'BUY', sl: 46100 }).status, 'BLOCKED'); // above entry
  assert.equal(planPosition({ ...cfd, side: 'SELL', sl: 45900 }).status, 'BLOCKED');
});

test('sizer: below broker minimum -> BLOCKED with the honest min-lot numbers (US30 $1 case)', () => {
  const p = planPosition({ ...cfd, riskPct: 0.01, sl: 45999 }); // budget $1, stop $1 -> 1 lot? no: loss/lot=1 -> lotsRaw=1... use tiny budget
  const q = planPosition({ ...cfd, equity: 100, riskPct: 1, entry: 46000, sl: 45900 }); // budget $1, loss/lot $100 -> lotsRaw 0.01 < min 0.1
  assert.equal(q.status, 'BLOCKED');
  assert.match(q.reason, /Below the broker minimum/);
  assert.equal(q.volumeMin, undefined); // echo stays in inputs
  assert.ok(q.minNotional > 4000);      // 0.1 * 1 * 46000 = $4600 exposure story
  assert.match(q.reason, /risk budget/);
});

test('sizer: tiers never exceed the cap; a tier below the broker minimum is null', () => {
  const p = planPosition({ ...cfd, equity: 500, riskPct: 2 }); // budget $10 -> lotsRaw 0.1 = exactly min
  assert.equal(p.status, 'OK');
  assert.equal(p.tiers.FULL, p.lots);
  assert.equal(p.tiers.SMALL, null);   // 0.25 * 0.1 = 0.025 < min
  assert.equal(p.tiers.MEDIUM, null);  // 0.5 * 0.1 = 0.05  < min
});

test('sizer: fixed-risk venue — stake is the maximum loss, no lots', () => {
  const p = planPosition({ venue: 'fixed', stake: 5, currency: 'USD', equity: 1000, riskPct: 2 });
  assert.equal(p.status, 'OK');
  assert.equal(p.expectedLoss, 5);
  assert.equal(p.lots, null);
  assert.match(p.reason, /maximum loss = stake/);
  assert.ok(p.warnings.some(w => /not guaranteed/i.test(w)));
});

test('sizer: leverage unknown -> margin null + warning; costs never assumed', () => {
  const p = planPosition({ ...cfd, leverage: undefined });
  assert.equal(p.status, 'OK');
  assert.equal(p.marginEstimate, null);
  assert.ok(p.warnings.some(w => /margin not estimated/i.test(w)));
  assert.ok(p.warnings.some(w => /not included/i.test(w)));
});
