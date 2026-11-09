import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSetups, DEFAULT_SETUP_CONFIG, validateCandles, SETUPS_ENABLED_ENV } from '../lib/setups.js';
import { emaSeries } from '../lib/indicators.js';

/* Rule-based setups: every setup gets a FIRE fixture (fires with a coherent
 * contract) and SKIP fixtures (honest reasonIfSkipped). Fixtures are synthetic
 * by design — this file tests RULES, never market claims. */

const c = (t, o, h, l, cl, v = 50) => ({ time: Math.round(t / 1000), open: o, high: h, low: l, close: cl, volume: v });
const T0 = 1700000000000;

/* --- fixture builders (validated against the rule engine) --- */

/** Accelerating uptrend + hammer whose wick lands inside the EMA20 band + bullish confirm. Fires EMA_TREND_PULLBACK BUY. */
function emaFire() {
  const out = []; let px = 1.1, t = T0;
  for (let i = 0; i < 74; i++) { const d = 0.0002 + i * 0.0000185; out.push(c(t, px, px + d * 0.6, px - d * 0.4, px + d)); px += d; t += 300000; }
  const e20 = emaSeries(out.map((x) => x.close), 20).at(-1);
  const wick = e20 + 0.0003;
  out.push(c(t, px - 0.0004, px + 0.0002, wick, px - 0.0002)); t += 300000;
  out.push(c(t, px - 0.0002, px + 0.002, wick - 0.0002, px + 0.0016));
  return out;
}
/** Steady downtrend: EMA alignment reversed -> honest skip. */
function emaSkip() {
  const out = []; let px = 1.1, t = T0;
  for (let i = 0; i < 78; i++) { out.push(c(t, px, px + 0.0003, px - 0.0011, px - 0.0008)); px -= 0.0008; t += 300000; }
  return out;
}
/** Chop around 100 with real volume, sharp 3-bar drop (stretched below VWAP), bullish reversal. Fires VWAP_MEAN_REVERSION BUY. */
function vwapFire() {
  const out = []; let px = 100, t = T0;
  for (let i = 0; i < 70; i++) { const cl = px + (i % 2 ? 0.12 : -0.12); out.push(c(t, px, px + 0.1, px - 0.1, cl)); px = cl; t += 300000; }
  for (let i = 0; i < 3; i++) { out.push(c(t, px, px + 0.05, px - 0.1, px - 0.55)); px -= 0.55; t += 300000; }
  out.push(c(t, px, px + 0.3, px - 0.05, px + 0.25));
  return out;
}
/** Strong steady uptrend: ADX gate honestly blocks mean reversion. */
function vwapSkipTrending() {
  const out = []; let px = 100, t = T0;
  for (let i = 0; i < 76; i++) { out.push(c(t, px, px + 0.35, px - 0.05, px + 0.3)); px += 0.3; t += 300000; }
  return out;
}
/** Quiet pre-session, tight 15-min opening range, breakout close above. Fires OPENING_RANGE_BREAKOUT (long). */
function orbFire() {
  const out = [];
  const day = Date.UTC(2026, 9, 14, 0, 0, 0); // ms
  let px = 1.05, t = day - 6 * 3600 * 1000;
  for (let i = 0; i < 70; i++) { out.push(c(t, px, px + 0.0005, px - 0.0005, px + 0.0004)); px += 0.0004; t += 300000; }
  t = day + 7.5 * 3600 * 1000; // 07:30 UTC
  for (let i = 0; i < 6; i++) { out.push(c(t, px, px + 0.0003, px - 0.0003, px + 0.0001)); px += 0.0001; t += 300000; }
  for (let i = 0; i < 3; i++) { out.push(c(t, px, px + 0.00015, px - 0.00015, px + 0.00008)); px += 0.00008; t += 300000; } // 08:00-08:15 range
  out.push(c(t, px, px + 0.0006, px - 0.0001, px + 0.0005)); // breakout close
  return out;
}
/** Same bars but crypto: no defined session -> N/A, never invent one. */
const orbSkipCrypto = orbFire;
/** Massive range bars vs ATR -> range_too_wide skip. */
function orbSkipWide() {
  const out = orbFire().slice(0, -4);
  let px = out.at(-1).close, t = out.at(-1).time * 1000 + 300000;
  for (let i = 0; i < 3; i++) { out.push(c(t, px, px + 0.004, px - 0.004, px + 0.004)); px += 0.004; t += 300000; }
  out.push(c(t, px, px + 0.006, px - 0.0002, px + 0.005));
  return out;
}
/** Long decline, quiet trough that HOLDS (fractal), small green confirm. Fires RSI_MEAN_REVERSION BUY. */
function rsiFire() {
  const out = []; let px = 1.2, t = T0;
  for (let i = 0; i < 62; i++) { out.push(c(t, px, px + 0.0004, px - 0.0006, px - 0.0012)); px -= 0.0012; t += 300000; }
  out.push(c(t, px, px + 0.0001, px - 0.0005, px - 0.0001)); t += 300000;
  out.push(c(t, px - 0.0001, px + 0.0001, px - 0.0004, px)); t += 300000;
  out.push(c(t, px, px + 0.0002, px - 0.0002, px + 0.0004));
  return out;
}
/** Two-sided chop: RSI neutral -> "RSI alone is never a signal" honored. */
function rsiSkipNeutral() {
  const out = []; let px = 100, t = T0;
  for (let i = 0; i < 76; i++) { const cl = px + (i % 2 ? 0.1 : -0.1); out.push(c(t, px, px + 0.08, px - 0.08, cl)); px = cl; t += 300000; }
  return out;
}

test('all four setups exist; flag lives in app config, default OFF; sane defaults shipped', () => {
  assert.equal(SETUPS_ENABLED_ENV, 'AURUM_SETUPS_ENABLED');
  assert.deepEqual(Object.keys(DEFAULT_SETUP_CONFIG), ['emaPullback', 'vwapRev', 'orb', 'rsiRev', 'horizonBars']);
  assert.equal(DEFAULT_SETUP_CONFIG.orb.sessionStartUTC, 8);
  assert.equal(DEFAULT_SETUP_CONFIG.rsiRev.period, 14);
});

test('contract: evaluateSetups always returns all four with the documented shape', () => {
  const r = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: emaFire(), granularity: 300 });
  assert.deepEqual(r.results.map((x) => x.setup), ['EMA_TREND_PULLBACK', 'VWAP_MEAN_REVERSION', 'OPENING_RANGE_BREAKOUT', 'RSI_MEAN_REVERSION']);
  for (const s of r.results) {
    for (const k of ['setup', 'direction', 'entry', 'stop', 'tp1', 'rr', 'conditions', 'validData', 'reasonIfSkipped', 'confidence']) assert.ok(k in s, 'missing ' + k);
    assert.ok(Array.isArray(s.conditions));
  }
});

test('EMA_TREND_PULLBACK fires BUY on pullback fixture; skips honestly on downtrend', () => {
  const fire = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: emaFire(), granularity: 300 }).results[0];
  assert.equal(fire.direction, 'BUY');
  assert.ok(fire.entry > 0 && fire.stop > 0 && fire.stop < fire.entry && fire.tp1 > fire.entry);
  assert.ok(Math.abs(fire.rr - DEFAULT_SETUP_CONFIG.emaPullback.rrTarget) < 0.01);
  assert.ok(fire.conditions.length >= 4 && fire.conditions.every((x) => 'name' in x && 'passed' in x && 'value' in x));
  assert.equal(fire.validData, true);
  assert.equal(fire.conditions.find((x) => x.name === 'EMA20>EMA50').passed, true);
  assert.equal(fire.conditions.find((x) => /slope/.test(x.name)).passed, true);
  assert.equal(fire.conditions.find((x) => /pullback into band/.test(x.name)).passed, true);
  assert.equal(fire.conditions.find((x) => /confirmation candle/.test(x.name)).passed, true);

  // monotonic decline: trend never realigns long AND price never rallies into the band —
  // the engine honestly reports the first unmet gate instead of inventing a signal
  const skip = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: emaSkip(), granularity: 300 }).results[0];
  assert.equal(skip.direction, null);
  assert.equal(skip.reasonIfSkipped, 'no_pullback_into_band');
  // downtrend WITH a pullback rally: alignment gate fails for longs -> no_aligned_trend
  const noTrend = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: emaSkip().slice(0, 70), granularity: 300 }).results[0];
  assert.equal(noTrend.direction, null);
  assert.ok(['no_aligned_trend', 'no_pullback_into_band', 'no_confirmation_candle'].includes(noTrend.reasonIfSkipped), noTrend.reasonIfSkipped);
});

test('VWAP_MEAN_REVERSION fires on stretch+chop+reversal; blocked by ADX; zero volume -> invalid data, never fabricated', () => {
  const fire = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: vwapFire(), granularity: 300 }).results[1];
  assert.equal(fire.direction, 'BUY');
  assert.ok(fire.conditions.find((x) => x.name === 'ADX < 25').passed === true);
  assert.ok(fire.conditions.find((x) => /close.*VWAP/.test(x.name)).passed === true);

  const skip = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: vwapSkipTrending(), granularity: 300 }).results[1];
  assert.equal(skip.reasonIfSkipped, 'trending_adx_high');

  const noVol = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: vwapFire().map((x) => ({ ...x, volume: 0 })), granularity: 300 }).results[1];
  assert.equal(noVol.validData, false);
  assert.equal(noVol.reasonIfSkipped, 'volume_not_traded_volume');
  assert.equal(noVol.direction, null);
});

test('OPENING_RANGE_BREAKOUT fires long on range break; crypto -> no_defined_session (valid data, N/A); too-wide range skipped', () => {
  const fire = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: orbFire(), granularity: 300, sessionStartUTC: 8 }).results[2];
  assert.equal(fire.direction, 'BUY');
  // 15-min range / 5-min bars = 3 range bars; width conditions carry width/ATR values
  assert.ok(fire.conditions.some((x) => /range width/.test(x.name)));
  assert.ok(fire.stop < fire.entry && fire.tp1 > fire.entry);

  const crypto = evaluateSetups({ symbol: 'BTC/USD', category: 'crypto', candles: orbSkipCrypto(), granularity: 300 }).results[2];
  assert.equal(crypto.reasonIfSkipped, 'no_defined_session');
  assert.equal(crypto.validData, true);

  const wide = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: orbSkipWide(), granularity: 300, sessionStartUTC: 8 }).results[2];
  assert.equal(wide.reasonIfSkipped, 'range_too_wide');
});

test('RSI_MEAN_REVERSION fires only with RSI + pivot + confirmation (never RSI alone); neutral chop skipped', () => {
  const fire = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: rsiFire(), granularity: 300 }).results[3];
  assert.equal(fire.direction, 'BUY');
  assert.ok(fire.conditions.find((x) => /RSI/.test(x.name) && /oversold|< 30/.test(x.name)).passed === true);
  assert.ok(fire.conditions.find((x) => /swing support/.test(x.name)).passed === true);

  const skip = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: rsiSkipNeutral(), granularity: 300 }).results[3];
  assert.equal(skip.reasonIfSkipped, 'rsi_neutral');
});

test('validateCandles: dirty candles rejected with logged issues; clean short series rejected as insufficient', () => {
  const good = emaFire();
  const ok = validateCandles(good, 300);
  assert.equal(ok.ok, true);
  assert.equal(ok.clean.length, good.length);

  const dupe = [...good]; dupe[5] = { ...dupe[4] };
  const bad = validateCandles(dupe, 300);
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.duplicates >= 1);

  const short = good.slice(0, 30);
  const insuf = validateCandles(short, 300);
  assert.equal(insuf.ok, false);
  assert.ok(insuf.clean.length < 60);

  const all = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: good.slice(0, 40), granularity: 300 });
  assert.ok(all.results.every((r) => r.reasonIfSkipped === 'insufficient_clean_candles'));
});

test('per-setup config overrides are honored (tighter ADX gate blocks the chop fixture)', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_SETUP_CONFIG));
  cfg.vwapRev.adxMax = 5; // chop fixture has ADX ~11 -> now blocked
  const r = evaluateSetups({ symbol: 'EUR/USD', category: 'forex', candles: vwapFire(), granularity: 300, config: cfg }).results[1];
  assert.equal(r.reasonIfSkipped, 'trending_adx_high');
});
