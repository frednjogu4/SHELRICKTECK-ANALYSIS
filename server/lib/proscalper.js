/* Pro Scalper: deterministic, analysis-only technical assessment. */
import { ema, rsi, macd, atr, bollingerBands, findLevels } from './indicators.js';
import { adx } from './indicators.ext.js';

export const PROSCALPER_VERSION = '1.0.0';
const MIN_BARS = 220;
const FRAME_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const finite = Number.isFinite;

export function parabolicSar(candles, step = 0.02, maxStep = 0.2) {
  if (!Array.isArray(candles) || candles.length < 3 || !(step > 0 && maxStep >= step)) return null;
  let up = candles[1].close >= candles[0].close;
  let af = step;
  let ep = up ? Math.max(candles[0].high, candles[1].high) : Math.min(candles[0].low, candles[1].low);
  let sar = up ? Math.min(candles[0].low, candles[1].low) : Math.max(candles[0].high, candles[1].high);
  for (let i = 2; i < candles.length; i++) {
    sar += af * (ep - sar);
    if (up) {
      sar = Math.min(sar, candles[i - 1].low, candles[i - 2].low);
      if (candles[i].low < sar) { up = false; sar = ep; ep = candles[i].low; af = step; }
      else if (candles[i].high > ep) { ep = candles[i].high; af = Math.min(maxStep, af + step); }
    } else {
      sar = Math.max(sar, candles[i - 1].high, candles[i - 2].high);
      if (candles[i].high > sar) { up = true; sar = ep; ep = candles[i].high; af = step; }
      else if (candles[i].low < ep) { ep = candles[i].low; af = Math.min(maxStep, af + step); }
    }
  }
  return finite(sar) ? sar : null;
}

function validateCandles(candles, timeframe, now) {
  const issues = [];
  if (!Array.isArray(candles) || candles.length < MIN_BARS) return [`Need at least ${MIN_BARS} closed candles for EMA 200; received ${Array.isArray(candles) ? candles.length : 0}.`];
  let prior = -Infinity;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || ![c.time,c.open,c.high,c.low,c.close].every(v => finite(Number(v))) || Number(c.time) <= prior || Number(c.low) <= 0 || Number(c.high) < Number(c.low) || Number(c.open) < Number(c.low) || Number(c.open) > Number(c.high) || Number(c.close) < Number(c.low) || Number(c.close) > Number(c.high)) {
      issues.push(`Invalid or contradictory OHLC data at candle ${i + 1}.`); return issues;
    }
    if (c.volume == null || !finite(Number(c.volume)) || Number(c.volume) < 0) { issues.push(`Volume data missing or invalid at candle ${i + 1}.`); return issues; }
    prior = Number(c.time);
  }
  const frameMs = FRAME_MS[timeframe];
  if (!frameMs) return ['Unsupported timeframe.'];
  const latestMs = Number(candles.at(-1).time) < 1e12 ? Number(candles.at(-1).time) * 1000 : Number(candles.at(-1).time);
  const age = now - (latestMs + frameMs);
  if (age < 0) issues.push('Latest candle is still forming; closed-candle confirmation is required.');
  else if (age > frameMs * 3) issues.push('Candle data is stale or timestamp is in the future.');
  return issues;
}

export function deriveProScalperTimeframe(candles, timeframe, now = Date.now()) {
  const issues = validateCandles(candles, timeframe, now);
  if (issues.length) return { signal: 'WAIT', valid: false, reason: issues.join(' ') };
  const rows = candles.map(c => ({...c, high:Number(c.high), low:Number(c.low), close:Number(c.close), volume:Number(c.volume)}));
  const closes = rows.map(c=>c.close), last=rows.at(-1), e=ema(closes,200), m=macd(closes), r=rsi(closes), a=adx(rows), sar=parabolicSar(rows);
  if (![e,m?.histogram,r,a?.plusDI,a?.minusDI,sar].every(finite)) return {signal:'WAIT',valid:false,reason:'Required confirmation indicator unavailable.'};
  const score=(last.close>e?1:-1)+(last.close>sar?1:-1)+(m.histogram>0?1:-1)+(a.plusDI>a.minusDI?1:-1)+(r>=52&&r<=70?1:r<=48&&r>=30?-1:0);
  return {signal:score>=4?'BUY':score<=-4?'SELL':'WAIT',valid:true,score};
}

function candleForecast(features) {
  // Evidence-weighted heuristic only; not a calibrated probability of profit.
  const score = Math.max(-5, Math.min(5, features.score));
  const strength = 1 / (1 + Math.exp(-score * 0.42));
  const directionalMass = 0.28 + 0.42 * Math.abs(strength - 0.5) * 2;
  const up = score >= 0 ? directionalMass * (0.5 + (strength - 0.5) * 0.55) : directionalMass * (0.5 - (0.5 - strength) * 0.55);
  const down = directionalMass - up;
  const flat = 1 - directionalMass;
  const total = up + down + flat;
  return { up: up / total, down: down / total, sideways: flat / total, method: 'indicator-confluence heuristic; not statistically calibrated' };
}

export function analyzeProScalper({ symbol, timeframe = '1m', candles, confirmations = {}, now = Date.now() }) {
  const rejects = validateCandles(candles, timeframe, now);
  if (rejects.length) return { version: PROSCALPER_VERSION, symbol, timeframe, signal: 'WAIT', confidence: 0, rejectionReasons: rejects, forecast: null, dataFreshness: 'unverified', execution: 'disabled' };
  const rows = candles.map(c => ({...c, time: Number(c.time), open:Number(c.open), high:Number(c.high), low:Number(c.low), close:Number(c.close), volume:Number(c.volume)}));
  const closes = rows.map(c => c.close), last = rows.at(-1), e200 = ema(closes, 200), m = macd(closes), r = rsi(closes), a = adx(rows), volatility = atr(rows), bb = bollingerBands(closes), sar = parabolicSar(rows), levels = findLevels(rows, 50);
  const rejects2 = [];
  if (![e200,m?.histogram,r,a?.adx,a?.plusDI,a?.minusDI,volatility,bb?.upper,sar].every(finite)) rejects2.push('Required indicator could not be calculated.');
  const volSlice = rows.slice(-21,-1).map(c => c.volume);
  if (!volSlice.length || !finite(last.volume)) rejects2.push('Volume evidence is unavailable.');
  const avgVol = volSlice.reduce((s,v)=>s+v,0) / Math.max(1,volSlice.length);
  if (!(avgVol > 0)) rejects2.push('Volume baseline is zero or unavailable.');
  const volumeRatio = avgVol > 0 ? last.volume / avgVol : null;
  const up = last.close > e200, psarUp = last.close > sar, macdUp = m.histogram > 0, dmiUp = a.plusDI > a.minusDI;
  let score = (up?1:-1) + (psarUp?1:-1) + (macdUp?1:-1) + (dmiUp?1:-1) + (r >= 52 && r <= 70?1:r <= 48 && r >= 30?-1:0) + (volumeRatio >= 1.05 ? (last.close >= last.open?1:-1) : 0);
  const validConf = Object.entries(confirmations).filter(([tf,x]) => FRAME_MS[tf] && x?.valid === true && ['BUY','SELL','WAIT'].includes(x.signal) && x.signal !== 'WAIT');
  const directions = new Set(validConf.map(([,x])=>x.signal));
  if (directions.size > 1) rejects2.push('Higher-timeframe confirmations contradict one another.');
  const main = score >= 4 ? 'BUY' : score <= -4 ? 'SELL' : 'WAIT';
  if (main !== 'WAIT' && validConf.length < 2) rejects2.push('Two valid higher-timeframe confirmations are required.');
  if (main !== 'WAIT' && validConf.some(([,x])=>x.signal !== main)) rejects2.push('Higher-timeframe evidence does not confirm the setup.');
  const signal = rejects2.length ? 'WAIT' : main;
  const dir = signal === 'BUY' ? 1 : signal === 'SELL' ? -1 : 0;
  const levelsNear = dir === 1 ? levels.support[0] : levels.resistance[0];
  const invalidation = dir ? (dir > 0 ? Math.min(last.close - volatility, levelsNear ?? last.close - volatility) : Math.max(last.close + volatility, levelsNear ?? last.close + volatility)) : null;
  const agreement = [up === (dir > 0), psarUp === (dir > 0), macdUp === (dir > 0), dmiUp === (dir > 0)].filter(Boolean).length;
  const confidence = signal === 'WAIT' ? 0 : Math.round(Math.min(85, 45 + agreement * 7 + (a.adx >= 25 ? 5 : 0) + (volumeRatio >= 1.2 ? 4 : 0)));
  const age = Math.max(0, now - (last.time < 1e12 ? last.time * 1000 : last.time));
  return { version:PROSCALPER_VERSION, symbol, timeframe, signal, confidence, execution:'disabled', entryReference: signal === 'WAIT' ? null : last.close, invalidation, support:levels.support, resistance:levels.resistance,
    indicators:{ema200:e200, parabolicSar:sar, macd:m, rsi:r, adx:a, atr:volatility, bollinger:bb, volume:{last:last.volume, average:avgVol, ratio:volumeRatio}},
    evidence:{trend:up?'above EMA 200':'below EMA 200', score, timeframeSignals:Object.fromEntries(Object.entries(confirmations).map(([k,v])=>[k,v?.signal||'unavailable']))},
    forecast:rejects2.length ? null : candleForecast({score}), dataFreshness:{status:'fresh', ageMs:age, lastCandleTime:last.time}, rejectionReasons:rejects2 };
}

/** Analysis-only walk-forward replay, no broker/data access. */
export function backtestProScalper({ candles, higherCandles = {}, timeframe='1m', symbol='TEST', now=Date.now() }) {
  if (!Array.isArray(candles) || candles.length < MIN_BARS + 30) throw new Error(`Need at least ${MIN_BARS + 30} candles.`);
  const trades=[];
  for (let i=MIN_BARS; i < candles.length - 1; i++) {
    const sample=candles.slice(0,i+1); const stamp=Number(sample.at(-1).time); const ms=(stamp<1e12?stamp*1000:stamp) + FRAME_MS[timeframe];
    const confirmations={};
    for (const [tf,series] of Object.entries(higherCandles)) {
      const frame=FRAME_MS[tf];
      if (!frame || !Array.isArray(series)) continue;
      const eligible=series.filter(c => ((Number(c.time)<1e12?Number(c.time)*1000:Number(c.time))+frame) <= ms);
      confirmations[tf]=deriveProScalperTimeframe(eligible,tf,ms);
    }
    const result=analyzeProScalper({symbol,timeframe,candles:sample,confirmations,now:ms + 1});
    if (result.signal==='WAIT') continue;
    const next=candles[i+1], dir=result.signal==='BUY'?1:-1;
    trades.push({side:result.signal, entry:Number(candles[i].close), nextClose:Number(next.close), outcome:Math.sign((Number(next.close)-Number(candles[i].close))*dir), time:candles[i].time});
  }
  const wins=trades.filter(t=>t.outcome>0).length, losses=trades.filter(t=>t.outcome<0).length, unchanged=trades.length-wins-losses;
  return {symbol,timeframe,signals:trades.length,wins,losses,unchanged,winRate:trades.length?wins/trades.length:null,trades,execution:'disabled', disclaimer:'Historical replay is not a prediction of future results.'};
}
