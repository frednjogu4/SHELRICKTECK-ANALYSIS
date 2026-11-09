import test from 'node:test';
import assert from 'node:assert/strict';
import { newsContext } from '../lib/pipeline/news.js';
import { technicalEvidence } from '../lib/pipeline/charts.js';
import { scoutScreen, SCORE_LABEL } from '../lib/pipeline/scout.js';
import { evaluateStrategy } from '../lib/pipeline/strategy.js';
import { runPipeline, WORKFLOW_ORDER } from '../lib/pipeline/index.js';

/* real-time-relative fixtures: freshestCandleAge() measures against the actual
   clock, so candle times must be relative to Date.now() or tests rot as time
   passes (fixed timestamps silently drift out of the freshness window). */
const now = Date.now();
const tSec = Math.floor(now / 1000);
const det = {
  symbol: 'US30', ok: true, mtfSignal: 'BUY_CONFIRMED',
  analyses: {
    m1: { trend: 'UP', signal: 'BUY', biasScore: 2.5, indicators: { rsi: 61, atr: 12 }, candles: [{ time: tSec - 30 }] },
    m5: { trend: 'UP', signal: 'BUY', biasScore: 3.1, indicators: { rsi: 58, atr: 20 }, candles: [{ time: tSec - 90 }] },
    h1: { trend: 'UP', signal: 'BUY', biasScore: 1.8, indicators: { rsi: 55, atr: 40 }, candles: [{ time: tSec - 120 }] },
  },
};
const dec = { signal: 'BUY', bias: 'bullish', confidence: 74, entry: 46000, stop_loss: 45900, tp1: 46200, votes: '1m BUY · 5m BUY · 1h BUY' };
const riskInput = { stake: 5, limits: { maxStakeUsd: 5, maxOpenTrades: 10, dailyLossLimitUsd: 20 }, opens: 0, dayPnl: 0, marketHours: true, venue: 'mt5' };

test('NEWS: fresh vs stale classification on the validity window; unknown timestamps never count fresh', () => {
  const n = newsContext({ items: [
    { title: 'a', t: now - 5 * 60000, bias: 'bull' },
    { title: 'b', t: now - 40 * 60000, bias: 'bear' },
    { title: 'c', t: null, bias: 'x' },
  ], now, validityMin: 25 });
  assert.equal(n.fresh.length, 1);
  assert.equal(n.stale.length, 1);
  assert.equal(n.unknown.length, 1);
  assert.equal(n.restriction, 'NONE');
  assert.deepEqual(n.factsFields.includes('title'), true);
  assert.deepEqual(n.interpretationFields, ['bias']);
});

test('NEWS INVARIANT: authorizes is ALWAYS false — even with fresh bullish items; stale-only => STALE_STAND_DOWN; no feed => UNAVAILABLE', () => {
  const fresh = newsContext({ items: [{ title: 'a', t: now - 60000, bias: 'bull' }, { title: 'b', t: now - 120000, bias: 'bull' }], now });
  assert.equal(fresh.authorizes, false);
  const staleOnly = newsContext({ items: [{ title: 'x', t: now - 90 * 60000 }], now });
  assert.equal(staleOnly.restriction, 'STALE_STAND_DOWN');
  assert.equal(staleOnly.authorizes, false);
  const none = newsContext({ items: null, now });
  assert.equal(none.state, 'UNAVAILABLE');
  assert.equal(none.authorizes, false);
});

test('SCOUT: score carries the quality-score label — never a probability of profit', () => {
  const s = scoutScreen({ symbol: 'US30', det, dec, now });
  assert.equal(s.score, 74);
  assert.equal(s.scoreLabel, SCORE_LABEL);
  assert.match(SCORE_LABEL, /NOT a probability of profit/);
  assert.ok(s.factors.length >= 6);
});

test('STRATEGY: full pass yields a setup with explicit conditions; each failure mode kills it', () => {
  const charts = technicalEvidence({ det, now });
  const ok = evaluateStrategy({ scout: scoutScreen({ det, dec, now }), evidence: charts, rule: { entry: 46000, sl: 45900, tp: 46200 }, now });
  assert.equal(ok.setup, true);
  assert.equal(ok.direction, 'BUY');
  assert.equal(ok.conditions.length, 6);
  const lowScore = evaluateStrategy({ scout: scoutScreen({ det, dec: { ...dec, confidence: 65 }, now }), evidence: charts, rule: { entry: 46000, sl: 45900, tp: 46200 }, now });
  assert.equal(lowScore.setup, false);
  const badRr = evaluateStrategy({ scout: scoutScreen({ det, dec, now }), evidence: charts, rule: { entry: 46000, sl: 45900, tp: 46050 }, now });
  assert.equal(badRr.setup, false);
  const wait = evaluateStrategy({ scout: scoutScreen({ det, dec: { ...dec, signal: 'WAIT' }, now }), evidence: charts, rule: { entry: 46000, sl: 45900, tp: 46200 }, now });
  assert.equal(wait.setup, false);
});

test('PIPELINE: workflow order is SCOUT→NEWS→CHARTS→STRATEGY→RISK→BOSS and never executes', () => {
  const p = runPipeline({ symbol: 'US30', det, dec, newsItems: [{ title: 'n', t: now - 60000 }], riskInput, now });
  assert.deepEqual(p.workflow.map(w => w.role), WORKFLOW_ORDER);
  assert.equal(p.executes, false);
  assert.equal(p.boss.verdict, 'READY FOR MANUAL REVIEW'); /* human decides */
  assert.match(p.boss.reason, /human decides/);
});

test('PIPELINE: missing risk state -> RISK UNKNOWN/BLOCKED and BOSS never says ready (missing data never passes)', () => {
  const p = runPipeline({ symbol: 'US30', det, dec, newsItems: null, riskInput: null, now });
  assert.equal(p.risk.verdict, 'BLOCKED');
  assert.notEqual(p.boss.verdict, 'READY FOR MANUAL REVIEW');
  assert.ok(['REJECTED', 'WAIT'].includes(p.boss.verdict));
  assert.equal(p.news.state, 'UNAVAILABLE');
});

test('PIPELINE: kill switch blocks everything; stale charts force WAIT even when rules pass', () => {
  const killed = runPipeline({ symbol: 'US30', det, dec, newsItems: [], riskInput: { ...riskInput, killSwitch: true }, now });
  assert.equal(killed.boss.verdict, 'REJECTED');
  const staleDet = { ...det, analyses: { m1: { ...det.analyses.m1, candles: [{ time: tSec - 20000 }] }, m5: { ...det.analyses.m5, candles: [{ time: tSec - 20000 }] }, h1: { ...det.analyses.h1, candles: [{ time: tSec - 20000 }] } } }; /* ~5.5h old > 3h5m freshness limit */
  const stale = runPipeline({ symbol: 'US30', det: staleDet, dec, newsItems: [], riskInput, now });
  assert.equal(stale.strategy.setup, false);
  assert.equal(stale.boss.verdict, 'WAIT');
});
