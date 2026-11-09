import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContractsFor, clampDuration, durToSec, normalizeAccounts, rangesSummary } from '../lib/derivpat.js';

/* ================================================================
 * Duration handling for Deriv PAT quotes (regression: EUR/USD 5m
 * → ContractBuyValidationError "Trading is not offered for this duration").
 * parseContractsFor handles BOTH documented contracts_for shapes:
 *   A) available[] items with min/max_contract_duration strings ("15m","1d")
 *   B) available_contracts[] items with open_in[{duration_unit,min,max}]
 * Entries whose unit can't be determined confidently are ignored.
 * ================================================================ */

test('durToSec: known units and junk', () => {
  assert.equal(durToSec(5, 'm'), 300);
  assert.equal(durToSec(1, 'd'), 86400);
  assert.equal(durToSec(2, 'h'), 7200);
  assert.equal(durToSec(1, 'x'), null);
});

test('parseContractsFor: shape A (min/max_contract_duration with embedded unit)', () => {
  const r = parseContractsFor({ contracts_for: { available: [
    { contract_type: 'CALL', min_contract_duration: '15m', max_contract_duration: '365d' },
    { contract_type: 'PUT', min_contract_duration: '15m', max_contract_duration: '365d' }
  ] } });
  assert.ok(r);
  assert.deepEqual(r.CALL.m, { min: 15, max: 365 * 60 * 24 });
  assert.deepEqual(r.PUT.m, { min: 15, max: 365 * 60 * 24 });
});

test('parseContractsFor: shape B (open_in arrays)', () => {
  const r = parseContractsFor({ contracts_for: { available_contracts: [
    { contract_type: 'CALL', open_in: [{ duration_unit: 'm', min: 5, max: 60 }, { duration_unit: 'h', min: 1, max: 24 }] }
  ] } });
  assert.ok(r);
  assert.deepEqual(r.CALL.m, { min: 5, max: 60 });
  assert.deepEqual(r.CALL.h, { min: 1, max: 24 });
});

test('parseContractsFor: ambiguous bare numbers are ignored (no guessing)', () => {
  const r = parseContractsFor({ contracts_for: { available: [
    { contract_type: 'CALL', min_contract_duration: '15', max_contract_duration: '365' }
  ] } });
  assert.equal(r, null);
});

test('parseContractsFor: junk → null', () => {
  assert.equal(parseContractsFor(null), null);
  assert.equal(parseContractsFor({}), null);
  assert.equal(parseContractsFor({ contracts_for: {} }), null);
});

test('clampDuration: in-range passes through untouched', () => {
  const r = clampDuration({ CALL: { m: { min: 15, max: 43200 } } }, 30, 'm');
  assert.deepEqual(r, { duration: 30, unit: 'm', clamped: false });
});

test('clampDuration: 5m on a 15m-min symbol clamps UP (the EUR/USD bug)', () => {
  const r = clampDuration({ CALL: { m: { min: 15, max: 43200 } } }, 5, 'm');
  assert.equal(r.duration, 15);
  assert.equal(r.unit, 'm');
  assert.equal(r.clamped, true);
});

test('clampDuration: above max clamps DOWN', () => {
  const r = clampDuration({ CALL: { m: { min: 15, max: 60 } } }, 240, 'm');
  assert.equal(r.duration, 60);
  assert.equal(r.clamped, true);
});

test('clampDuration: requested unit not offered → converts into a containing range', () => {
  const r = clampDuration({ CALL: { h: { min: 1, max: 24 } } }, 30, 'm'); /* 30m want → 1h range contains 1800s? no → clamp to min 1h */
  assert.equal(r.unit, 'h');
  assert.equal(r.duration, 1);
  assert.equal(r.clamped, true);
});

test('clampDuration: no ranges → pass-through (never blocks quoting)', () => {
  assert.deepEqual(clampDuration(null, 5, 'm'), { duration: 5, unit: 'm', clamped: false });
  assert.deepEqual(clampDuration({}, 7, 'm'), { duration: 7, unit: 'm', clamped: false });
});

test('normalizeAccounts: keeps demo AND real (regression: demo-only filter)', () => {
  const n = normalizeAccounts([
    { account_id: 'VRT-1', account_type: 'demo', currency: 'USD', balance: '10000.00', status: 'active' },
    { account_id: 'RLC-2', account_type: 'real', currency: 'USD', balance: 152.5, status: 'active' },
    { account_id: '', account_type: 'real' } /* dropped: no id */
  ]);
  assert.equal(n.length, 2);
  assert.equal(n[0].account_type, 'demo');
  assert.equal(n[1].balance, 152.5);
});


test('parseContractsFor: tick-only lineup (BOOM/CRASH style) survives parsing', () => {
  const r = parseContractsFor({ contracts_for: { available_contracts: [
    { contract_type: 'CALL', open_in: [{ duration_unit: 't', min: 5, max: 10 }] }
  ] } });
  assert.ok(r && r.CALL && r.CALL.t);
  assert.deepEqual(r.CALL.t, { min: 5, max: 10 });
});

test('clampDuration: falls back to the minimum ticks when nothing time-based matches', () => {
  const r = { CALL: { t: { min: 5, max: 10 } }, PUT: { t: { min: 5, max: 10 } } };
  const c = clampDuration(r, 15, 'm');
  assert.equal(c.unit, 't');
  assert.equal(c.duration, 5);
  assert.equal(c.clamped, true);
});

test('clampDuration: requested ticks clamp inside the tick range', () => {
  const r = { CALL: { t: { min: 5, max: 10 } }, PUT: { t: { min: 5, max: 10 } } };
  const c = clampDuration(r, 99, 't');
  assert.equal(c.unit, 't');
  assert.equal(c.duration, 10);
});

test('rangesSummary: renders tick + time ranges readably', () => {
  assert.equal(rangesSummary({ CALL: { t: { min: 5, max: 10 } } }), '5\u201310 ticks');
  assert.equal(rangesSummary({ CALL: { m: { min: 15, max: 30 }, d: { min: 1, max: 5 } } }), '15\u201330m, 1\u20135d');
  assert.equal(rangesSummary(null), null);
});
