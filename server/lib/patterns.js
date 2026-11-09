/* ================================================================
 * AURUM — chart pattern recognition engine (pure, real candles only).
 *
 * Detects 12 classical structures from swing pivots + ATR-scaled
 * geometry. No simulated data: callers pass NORMALIZED real candles
 * (from lib/derivfeed or an injected stub). Every detection carries:
 *   direction (bullish|bearish|neutral)  action (BUY|SELL|HOLD)
 *   confidence (40-92, match quality)    entry/stop/target prices
 *   status  (formed = confirmed breakout | forming = still inside)
 *   lines   (geometry in window coords for chart overlay)
 *
 * Also exports PATTERN_META (education copy) and studyPatterns()
 * (walk-forward success-rate study over historical candles).
 * ================================================================ */

/* ---------------- metadata / education ---------------- */
export const PATTERN_META = {
  inv_hs:      { name: 'Inverse Head & Shoulders', dir: 'bullish',  action: 'BUY',
    how: 'Three troughs where the middle (head) is the deepest and the two shoulders are similar. The neckline connects the highs between them.',
    why: 'Sellers lose control after the final push lower; a close above the neckline signals a reversal up.',
    trade: 'Buy on the neckline breakout; stop below the right shoulder; first target = neckline + (head − neckline).' },
  hs:          { name: 'Head & Shoulders', dir: 'bearish', action: 'SELL',
    how: 'Three peaks: a tall middle head flanked by two similar shoulders; the neckline joins the two intervening lows.',
    why: 'The second push to a high fails above the first — buyers are exhausted; a close under the neckline confirms distribution.',
    trade: 'Sell on the neckline break; stop above the right shoulder; target = neckline − (head − neckline).' },
  bull_flag:   { name: 'Bullish Flag', dir: 'bullish', action: 'BUY',
    how: 'A sharp impulse up (pole) followed by a shallow, slightly down-sloping consolidation channel of 5+ bars.',
    why: 'Profit-taking pauses the move without breaking structure — a continuation pause in an uptrend.',
    trade: 'Buy the break above the flag high; stop under the flag low; target = breakout + pole height.' },
  bear_flag:   { name: 'Bearish Flag', dir: 'bearish', action: 'SELL',
    how: 'A sharp impulse down (pole) followed by a shallow, slightly up-sloping consolidation channel.',
    why: 'Short covering pauses the decline; failure back into the downtrend confirms continuation.',
    trade: 'Sell the break below the flag low; stop above the flag high; target = breakout − pole height.' },
  asc_tri:     { name: 'Ascending Triangle', dir: 'bullish', action: 'BUY',
    how: 'A flat resistance line touched 2+ times with progressively higher lows pressing into it.',
    why: 'Each dip is bought at a higher price — demand absorbing supply at a fixed level; breaks upward.',
    trade: 'Buy above resistance; stop under the latest higher low; target = resistance + triangle height.' },
  desc_tri:    { name: 'Descending Triangle', dir: 'bearish', action: 'SELL',
    how: 'A flat support line touched 2+ times with progressively lower highs pressing into it.',
    why: 'Each bounce is sold at a lower price — supply overwhelming a fixed bid; breaks downward.',
    trade: 'Sell below support; stop above the latest lower high; target = support − triangle height.' },
  fall_wedge:  { name: 'Falling Wedge', dir: 'bullish', action: 'BUY',
    how: 'Both highs and lows fall, but the range converges — downward momentum decays.',
    why: 'Sellers push lower with less force each time; a break of the upper trendline starts the reversal.',
    trade: 'Buy the break of the upper trendline; stop below the last low; target = wedge start height.' },
  rise_wedge:  { name: 'Rising Wedge', dir: 'bearish', action: 'SELL',
    how: 'Both highs and lows rise, but the range converges — upward momentum decays.',
    why: 'Buyers push higher with less force each time; a break of the lower trendline starts the reversal.',
    trade: 'Sell the break of the lower trendline; stop above the last high; target = wedge start height.' },
  symm_up:     { name: 'Symmetrical Triangle (Upside)', dir: 'bullish', action: 'BUY',
    how: 'Converging lower highs and higher lows that resolves with a close above the upper trendline.',
    why: 'Coiling volatility releases in the direction of the break — here, upward.',
    trade: 'Buy the upside break; stop under the lower trendline; target = triangle height added to the break.' },
  symm_down:   { name: 'Symmetrical Triangle (Downside)', dir: 'bearish', action: 'SELL',
    how: 'Converging lower highs and higher lows that resolves with a close below the lower trendline.',
    why: 'Coiling volatility releases downward when demand gives way.',
    trade: 'Sell the downside break; stop above the upper trendline; target = triangle height projected down.' },
  double_bot:  { name: 'Double Bottom', dir: 'bullish', action: 'BUY',
    how: 'Two lows at nearly the same level separated by an intervening rebound (the neckline).',
    why: 'The market tested a floor twice and refused it — a close above the neckline confirms the reversal.',
    trade: 'Buy the neckline break; stop under the lower low; target = neckline + (neckline − low).' },
  double_top:  { name: 'Double Top', dir: 'bearish', action: 'SELL',
    how: 'Two highs at nearly the same level separated by an intervening dip (the neckline).',
    why: 'The market tested a ceiling twice and refused it — a close below the neckline confirms reversal.',
    trade: 'Sell the neckline break; stop above the higher high; target = neckline − (high − neckline).' },
};
export const PATTERN_KEYS = Object.keys(PATTERN_META);

/* ---------------- math helpers ---------------- */
const last = (a) => a[a.length - 1];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function atrOf(candles, len = 14) {
  const n = candles.length;
  if (n < 2) return 0;
  const s = candles.slice(Math.max(1, n - len));
  let sum = 0;
  for (let i = 1; i < s.length; i++) {
    const tr = Math.max(
      s[i].high - s[i].low,
      Math.abs(s[i].high - s[i - 1].close),
      Math.abs(s[i].low - s[i - 1].close)
    );
    sum += tr;
  }
  return sum / Math.max(1, s.length - 1) || (candles[n - 1].high - candles[n - 1].low) || 0;
}

/** confirmed swing points (k bars either side), strictly alternating */
export function pivotsOf(c, k = 3) {
  const out = [];
  for (let i = k; i < c.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      /* ties do not disqualify — otherwise equal extremes cancel out */
      if (c[j].high > c[i].high) isH = false;
      if (c[j].low < c[i].low) isL = false;
    }
    if (isH) { if (out.length === 0 || out[out.length - 1].kind !== 'H') out.push({ i, kind: 'H', p: c[i].high }); }
    else if (isL) { if (out.length === 0 || out[out.length - 1].kind !== 'L') out.push({ i, kind: 'L', p: c[i].low }); }
  }
  return out;
}

const conf = (q) => Math.round(clamp(40 + q * 52, 40, 92));

function mkDetection(key, q, status, o = {}) {
  const meta = PATTERN_META[key];
  const direction = o.direction || meta.dir;
  const action = status === 'forming' ? 'HOLD' : (o.action || meta.action);
  return {
    key, pattern: meta.name, direction, action,
    confidence: conf(q), status,
    entry: o.entry ?? null, stop: o.stop ?? null, target: o.target ?? null,
    ageBars: o.ageBars ?? null, detail: o.detail || '',
    lines: o.lines || []
  };
}

const line = (i1, p1, i2, p2, style = 'solid') => ({ i1, p1, i2, p2, style });
/** two-point line value at index x */
const at = (x, i1, p1, i2, p2) => (i2 === i1 ? p1 : p1 + ((p2 - p1) * (x - i1)) / (i2 - i1));

/* ================================================================
 * DETECTORS — each receives the window and returns detection|null
 * ================================================================ */

function detDouble(c, P, A, wantLow) {
  const n = c.length;
  const lows = P.filter((s) => s.kind === 'L');
  const highs = P.filter((s) => s.kind === 'H');
  const pts = wantLow ? lows : highs;
  for (let a = pts.length - 1; a >= 1; a--) {
    const p1 = pts[a - 1], p2 = pts[a];
    const sep = p2.i - p1.i;
    if (sep < 6 || sep > Math.min(45, n - 6)) continue;
    if (p1.i < 8) continue;
    const diff = Math.abs(p1.p - p2.p);
    if (diff > 0.6 * A || diff > Math.abs(p1.p) * 0.01) continue;
    /* neckline pivot between the two extremes */
    const neckP = (wantLow ? highs : lows).filter((h) => h.i > p1.i && h.i < p2.i);
    if (!neckP.length) continue;
    const neck = wantLow ? Math.max(...neckP.map((h) => h.p)) : Math.min(...neckP.map((h) => h.p));
    const close = last(c).close;
    const q = clamp(1 - diff / (0.6 * A || 1), 0, 1) * clamp(sep / 12, 0.5, 1);
    const age = n - 1 - p2.i;
    const extreme = wantLow ? Math.min(p1.p, p2.p) : Math.max(p1.p, p2.p);
    const formed = wantLow ? close > neck : close < neck;
    const dist = Math.abs(neck - extreme) || A;
    const lines = [line(p1.i, neck, p2.i + 4, neck, 'dashed')];
    return mkDetection(wantLow ? 'double_bot' : 'double_top', q * (formed ? 1 : 0.75), formed ? 'formed' : 'forming', {
      entry: formed ? close : neck,
      stop: wantLow ? extreme - 0.4 * A : extreme + 0.4 * A,
      target: wantLow ? neck + dist : neck - dist,
      ageBars: age, detail: 'two ' + (wantLow ? 'lows' : 'highs') + ' within ' + diff.toFixed(5) + ', neckline ' + neck.toFixed(5),
      lines
    });
  }
  return null;
}

function detHeadShoulders(c, P, A, inverse) {
  const n = c.length;
  const kinds = inverse ? ['L', 'H', 'L', 'H', 'L'] : ['H', 'L', 'H', 'L', 'H'];
  /* search alternating sequence ending within window */
  for (let s = P.length - 1; s >= kinds.length - 1; s--) {
    const seq = [];
    let ok = true;
    for (let t = 0; t < kinds.length; t++) {
      const pt = P[s - (kinds.length - 1 - t)];
      if (!pt || pt.kind !== kinds[t]) { ok = false; break; }
      seq.push(pt);
    }
    if (!ok) continue;
    const [e1, n1, head, n2, e2] = seq; // extremes: shoulders+head; n1,n2 = neckline points
    if (inverse) {
      /* head = deepest trough; shoulders similar */
      if (!(head.p < e1.p && head.p < e2.p)) continue;
      if (Math.abs(e1.p - e2.p) > 0.7 * A) continue;
      if (e1.i < 5) continue;
      const neck = (n1.p + n2.p) / 2;
      const close = last(c).close;
      const formed = close > neck;
      const q = clamp(1 - Math.abs(e1.p - e2.p) / (0.7 * A || 1), 0, 1) * 0.85 + (formed ? 0.15 : 0);
      const dist = Math.abs(head.p - neck) || A;
      return mkDetection('inv_hs', q, formed ? 'formed' : 'forming', {
        entry: formed ? close : neck,
        stop: Math.max(e1.p, e2.p) - 0.4 * A,
        target: neck + dist,
        ageBars: n - 1 - e2.i,
        detail: 'shoulders ' + Math.abs(e1.p - e2.p).toFixed(5) + ', head ' + head.p.toFixed(5),
        lines: [line(n1.i, neck, e2.i + 4, neck, 'dashed'),
          line(e1.i, e1.p, head.i, head.p), line(head.i, head.p, e2.i, e2.p)]
      });
    }
    if (!(head.p > e1.p && head.p > e2.p)) continue;
    if (Math.abs(e1.p - e2.p) > 0.7 * A) continue;
    if (e1.i < 5) continue;
    const neck = (n1.p + n2.p) / 2;
    const close = last(c).close;
    const formed = close < neck;
    const q = clamp(1 - Math.abs(e1.p - e2.p) / (0.7 * A || 1), 0, 1) * 0.85 + (formed ? 0.15 : 0);
    const dist = Math.abs(head.p - neck) || A;
    return mkDetection('hs', q, formed ? 'formed' : 'forming', {
      entry: formed ? close : neck,
      stop: Math.max(e1.p, e2.p) + 0.4 * A,
      target: neck - dist,
      ageBars: n - 1 - e2.i,
      detail: 'shoulders ' + Math.abs(e1.p - e2.p).toFixed(5) + ', head ' + head.p.toFixed(5),
      lines: [line(n1.i, neck, e2.i + 4, neck, 'dashed'),
        line(e1.i, e1.p, head.i, head.p), line(head.i, head.p, e2.i, e2.p)]
    });
  }
  return null;
}

function detFlag(c, P, A, bullish) {
  if (bullish) return detFlagCore(c, A);
  /* bearish flag = bullish logic on price-mirrored candles, then un-mirror */
  const mc = c.map((x) => ({ time: x.time, open: -x.open, high: -x.low, low: -x.high, close: -x.close, volume: x.volume }));
  const d = detFlagCore(mc, A);
  if (!d) return null;
  d.key = 'bear_flag';
  d.pattern = PATTERN_META.bear_flag.name;
  d.direction = 'bearish';
  d.action = d.status === 'formed' ? 'SELL' : 'HOLD';
  if (d.entry != null) d.entry = -d.entry;
  if (d.stop != null) d.stop = -d.stop;
  if (d.target != null) d.target = -d.target;
  d.lines = d.lines.map((l) => ({ i1: l.i1, p1: -l.p1, i2: l.i2, p2: -l.p2, style: l.style }));
  return d;
}
function detFlagCore(c, A) {
  const n = c.length;
  if (n < 20) return null;
  let topI = -1;
  for (let i = n - 4; i >= Math.max(4, n - 30); i--) {
    let isH = true;
    for (let j = i - 3; j <= i + 3; j++) if (j !== i && c[j].high > c[i].high) { isH = false; break; }
    if (isH) { topI = i; break; }
  }
  if (topI < 0) return null;
  const topP = c[topI].high;
  let botI = Math.max(0, topI - 16);
  for (let i = botI; i < topI; i++) if (c[i].low < c[botI].low) botI = i;
  const poleH = topP - c[botI].low;
  if (!(poleH >= 2.2 * A)) return null;
  if (!(topP > c[botI].close)) return null;   /* core is always bullish-shaped */
  const consStart = topI + 1;
  let endIdx = n;
  for (let i = consStart; i < n; i++) {
    if (c[i].high > topP + 0.1 * A) { endIdx = i; break; }
  }
  const cons = c.slice(consStart, Math.max(consStart, endIdx));
  const m = cons.length;
  if (m < 4 || m > 30) return null;
  const cHigh = Math.max(...cons.map((x) => x.high));
  const cLow = Math.min(...cons.map((x) => x.low));
  const range = cHigh - cLow;
  if (range > 0.62 * poleH) return null;
  const retr = (topP - cLow) / poleH;
  if (retr > 0.62 || retr < 0.05) return null;
  const close = last(c).close;
  const formed = endIdx < n && close > cHigh;
  const stillValid = close > c[botI].low;
  if (!formed && !stillValid) return null;
  const q = clamp(range > 0 ? (1 - range / (0.62 * poleH)) * 0.6 + 0.4 * clamp(m / 8, 0, 1) : 0.5, 0, 1);
  const stop = cLow - 0.3 * A;
  const entry = formed ? close : cHigh;
  const target = entry + poleH * 0.9;
  return mkDetection('bull_flag', q, formed ? 'formed' : 'forming', {
    entry, stop, target,
    ageBars: formed ? 0 : n - 1 - topI,
    detail: 'pole ' + poleH.toFixed(5) + ' · consolidation ' + m + ' bars · retrace ' + (retr * 100).toFixed(0) + '%',
    lines: [line(consStart, cHigh, n - 1, cHigh),
      line(consStart, cLow, n - 1, cLow),
      line(botI, c[botI].low, topI, topP, 'dashed')]
  });
}

/** longest trailing run monotonic in dir (-1 falling, +1 rising), tolerating
 *  one newest pivot that broke formation (the breakout bar) */
function trailingRun(list, dir, minLen = 3) {
  const ok = (arr) => {
    for (let i = 1; i < arr.length; i++) {
      if (dir < 0 && !(arr[i].p < arr[i - 1].p)) return false;
      if (dir > 0 && !(arr[i].p > arr[i - 1].p)) return false;
    }
    return arr.length >= minLen;
  };
  if (list.length && ok(list)) return list;
  if (list.length >= minLen + 1 && ok(list.slice(0, -1))) return list.slice(0, -1);
  return null;
}

/** most recent cluster of pivots within tol (flat side of a triangle) */
function flatCluster(list, tol) {
  if (list.length < 2) return null;
  const recent = list.slice(-5);
  for (let start = 0; start <= recent.length - 2; start++) {
    const grp = recent.slice(start);
    const ps = grp.map((x) => x.p);
    if (Math.max(...ps) - Math.min(...ps) <= tol) return grp;
  }
  return null;
}

function detTriangle(c, P, A, ascending) {
  const n = c.length;
  const Hs = P.filter((s) => s.kind === 'H').slice(-6);
  const Ls = P.filter((s) => s.kind === 'L').slice(-6);
  if (Hs.length < 2 || Ls.length < 2) return null;
  const flatTol = Math.max(0.6 * A, 0.004 * Math.abs(c[n - 1].close));
  if (ascending) {
    const touches = flatCluster(Hs, flatTol);
    if (!touches || touches.length < 2) return null;
    const resMean = touches.reduce((s, v) => s + v.p, 0) / touches.length;
    const resSpread = Math.max(...touches.map((h) => h.p)) - Math.min(...touches.map((h) => h.p));
    if (resSpread > flatTol) return null;
    const dips = [];
    for (let t = 0; t < touches.length - 1; t++) {
      const a = touches[t].i, b = touches[t + 1].i;
      if (b - a < 3) continue;
      let mi = a;
      for (let i = a + 1; i < b; i++) if (c[i].low < c[mi].low) mi = i;
      dips.push({ i: mi, p: c[mi].low });
    }
    if (dips.length < 2) return null;
    const rising = dips.every((d, j) => j === 0 || d.p > dips[j - 1].p + 0.05 * A);
    if (!rising) return null;
    const level = resMean;
    const minLow = Math.min(...dips.map((d) => d.p));
    const height = Math.abs(level - minLow) || A;
    const close = last(c).close;
    const formed = close > level + 0.05 * A;
    const near = close > level - 0.7 * A;
    if (!formed && !near) return null;
    const q = clamp(1 - resSpread / (flatTol || 1), 0, 1) * 0.7
      + clamp(dips.length / 3, 0, 1) * 0.2 + (formed ? 0.1 : 0);
    return mkDetection('asc_tri', q, formed ? 'formed' : 'forming', {
      entry: close,
      stop: minLow - 0.3 * A,
      target: level + height,
      ageBars: n - 1 - Math.max(last(touches).i, last(dips).i),
      detail: 'flat resistance ' + level.toFixed(5) + ' · ' + dips.length + ' rising lows · height ' + height.toFixed(5),
      lines: [line(touches[0].i, level, n - 1, level),
        line(dips[0].i, dips[0].p, n - 1, last(dips).p)]
    });
  }
  const touches = flatCluster(Ls, flatTol);
  if (!touches || touches.length < 2) return null;
  const supMean = touches.reduce((s, v) => s + v.p, 0) / touches.length;
  const supSpread = Math.max(...touches.map((l) => l.p)) - Math.min(...touches.map((l) => l.p));
  if (supSpread > flatTol) return null;
  const peaks = [];
  for (let t = 0; t < touches.length - 1; t++) {
    const a = touches[t].i, b = touches[t + 1].i;
    if (b - a < 3) continue;
    let mi = a;
    for (let i = a + 1; i < b; i++) if (c[i].high > c[mi].high) mi = i;
    peaks.push({ i: mi, p: c[mi].high });
  }
  if (peaks.length < 2) return null;
  const falling = peaks.every((d, j) => j === 0 || d.p < peaks[j - 1].p - 0.05 * A);
  if (!falling) return null;
  const level = supMean;
  const maxHigh = Math.max(...peaks.map((d) => d.p));
  const height = Math.abs(maxHigh - level) || A;
  const close = last(c).close;
  const formed = close < level - 0.05 * A;
  const near = close < level + 0.7 * A;
  if (!formed && !near) return null;
  const q = clamp(1 - supSpread / (flatTol || 1), 0, 1) * 0.7
    + clamp(peaks.length / 3, 0, 1) * 0.2 + (formed ? 0.1 : 0);
  return mkDetection('desc_tri', q, formed ? 'formed' : 'forming', {
    entry: close,
    stop: maxHigh + 0.3 * A,
    target: level - height,
    ageBars: n - 1 - Math.max(last(touches).i, last(peaks).i),
    detail: 'flat support ' + level.toFixed(5) + ' · ' + peaks.length + ' falling highs · height ' + height.toFixed(5),
    lines: [line(touches[0].i, level, n - 1, level),
      line(peaks[0].i, peaks[0].p, n - 1, last(peaks).p)]
  });
}

function detSymm(c, P, A, opts = {}) {
  const n = c.length;
  const Hs = trailingRun(P.filter((s) => s.kind === 'H').slice(-5), -1);
  const Ls = trailingRun(P.filter((s) => s.kind === 'L').slice(-5), 1);
  if (!Hs || !Ls) return null;
  const hA = Hs[0], hB = Hs[Hs.length - 1];
  const lA = Ls[0], lB = Ls[Ls.length - 1];
  const distAt = (x) => at(x, hA.i, hA.p, hB.i, hB.p) - at(x, lA.i, lA.p, lB.i, lB.p);
  const x0 = Math.min(hA.i, lA.i);
  const xEnd = Math.min(hB.i, lB.i);   /* lines may cross after the break — measure before */
  const spanStart = distAt(x0);
  const spanEnd = distAt(xEnd);
  if (!(spanStart > 0) || spanEnd <= 0 || spanEnd >= 0.85 * spanStart) return null;
  const upper = at(n - 1, hA.i, hA.p, hB.i, hB.p);
  const lower = at(n - 1, lA.i, lA.p, lB.i, lB.p);
  const close = last(c).close;
  const height = spanStart;
  const q = clamp(1 - spanEnd / spanStart, 0, 1) * 0.7 + 0.3;
  const common = {
    stop: close > (upper + lower) / 2 ? lower - 0.3 * A : upper + 0.3 * A,
    ageBars: n - 1 - Math.max(hB.i, lB.i),
    detail: 'coil ' + (spanEnd / spanStart * 100).toFixed(0) + '% of start range',
    lines: [line(hA.i, hA.p, n - 1, upper),
            line(lA.i, lA.p, n - 1, lower)]
  };
  if (close > upper + 0.05 * A && opts.up !== false) {
    return mkDetection('symm_up', q, 'formed', Object.assign({}, common, {
      entry: close, target: close + height * 0.7, action: 'BUY'
    }));
  }
  if (close < lower - 0.05 * A && opts.down !== false) {
    return mkDetection('symm_down', q, 'formed', Object.assign({}, common, {
      entry: close, target: close - height * 0.7, action: 'SELL'
    }));
  }
  if (opts.forming === false) return null;
  return mkDetection('symm_up', q * 0.7, 'forming', Object.assign({}, common, {
    direction: 'neutral', action: 'HOLD', entry: close, target: null,
    detail: 'symmetrical triangle coiling · wait for the break (' + common.detail + ')'
  }));
}

function detWedge(c, P, A, rising) {
  const n = c.length;
  const dir = rising ? 1 : -1;
  const Hs = trailingRun(P.filter((s) => s.kind === 'H').slice(-5), dir);
  const Ls = trailingRun(P.filter((s) => s.kind === 'L').slice(-5), dir);
  if (!Hs || !Ls) return null;
  const hA = Hs[0], hB = Hs[Hs.length - 1];
  const lA = Ls[0], lB = Ls[Ls.length - 1];
  const distAt = (x) => at(x, hA.i, hA.p, hB.i, hB.p) - at(x, lA.i, lA.p, lB.i, lB.p);
  const x0 = Math.min(hA.i, lA.i);
  const xEnd = Math.min(hB.i, lB.i);   /* measure before the lines cross */
  const spanStart = distAt(x0);
  const spanEnd = distAt(xEnd);
  if (!(spanStart > 0) || spanEnd <= 0 || spanEnd >= 0.85 * spanStart) return null;
  const upper = at(n - 1, hA.i, hA.p, hB.i, hB.p);
  const lower = at(n - 1, lA.i, lA.p, lB.i, lB.p);
  const close = last(c).close;
  const formed = rising ? close < lower - 0.05 * A : close > upper + 0.05 * A;
  const near = rising ? close > lower - 1.2 * A : close < upper + 1.2 * A;
  if (!formed && !near) return null;
  const q = clamp(1 - spanEnd / spanStart, 0, 1) * 0.75 + 0.15 + (formed ? 0.1 : 0);
  const key = rising ? 'rise_wedge' : 'fall_wedge';
  const target = rising ? close - spanStart * 0.8 : close + spanStart * 0.8;
  return mkDetection(key, q, formed ? 'formed' : 'forming', {
    entry: formed ? close : (rising ? lower : upper),
    stop: rising ? Math.max(...Hs.map((h) => h.p)) + 0.3 * A : Math.min(...Ls.map((l) => l.p)) - 0.3 * A,
    target,
    ageBars: n - 1 - Math.max(hB.i, lB.i),
    detail: 'range contracting to ' + (spanEnd / spanStart * 100).toFixed(0) + '% of start',
    lines: [line(hA.i, hA.p, n - 1, upper),
            line(lA.i, lA.p, n - 1, lower)]
  });
}

/* ================================================================
 * public: detect over one window of candles
 * ================================================================ */
export function detectPatterns(candles, opts = {}) {
  if (!Array.isArray(candles) || candles.length < 30) return [];
  const minQ = opts.minQuality ?? 0;
  const keys = opts.keys && opts.keys.length ? opts.keys : null;
  const A = atrOf(candles) || (candles[0].high - candles[0].low) || 1e-9;
  const P = pivotsOf(candles, opts.pivotK ?? 3);
  const out = [];
  const want = (k) => !keys || keys.includes(k);
  const push = (fn) => {
    try { const d = fn(); if (d && d.confidence >= 40) out.push(d); } catch (e) { if (process.env.PAT_DEBUG) console.error('DET_FAIL', e && e.message, e && e.stack && e.stack.split('\n')[1]); }
  };

  if (want('double_bot')) push(() => detDouble(candles, P, A, true));
  if (want('double_top')) push(() => detDouble(candles, P, A, false));
  if (want('inv_hs')) push(() => detHeadShoulders(candles, P, A, true));
  if (want('hs')) push(() => detHeadShoulders(candles, P, A, false));
  if (want('bull_flag')) push(() => detFlag(candles, P, A, true));
  if (want('bear_flag')) push(() => detFlag(candles, P, A, false));
  if (want('asc_tri')) push(() => detTriangle(candles, P, A, true));
  if (want('desc_tri')) push(() => detTriangle(candles, P, A, false));
  if (want('symm_up') || want('symm_down')) push(() => detSymm(candles, P, A));
  if (want('fall_wedge')) push(() => detWedge(candles, P, A, false));
  if (want('rise_wedge')) push(() => detWedge(candles, P, A, true));

  const seen = new Set();
  return out
    .filter((d) => (seen.has(d.key) ? false : (seen.add(d.key), true)))
    .filter((d) => (d.confidence - 40) / 52 >= minQ)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, opts.max ?? 6);
}

/* ================================================================
 * walk-forward success-rate study over REAL historical candles
 * outcome per fresh 'formed' signal: target -> win, stop -> loss,
 * timeout -> win/loss by mark-to-market; reported honestly with n.
 * ================================================================ */
export function studyPatterns(candles, opts = {}) {
  const n = candles.length;
  const hold = opts.holdBars ?? 48;
  const from = Math.max(40, opts.from ?? 60);
  const keys = opts.keys && opts.keys.length ? opts.keys : null;
  const per = new Map(PATTERN_KEYS.map((k) => [k, { key: k, pattern: PATTERN_META[k].name, n: 0, wins: 0, losses: 0, avgR: 0, sumR: 0, bars: 0, barsSum: 0 }]));
  const trades = [];
  const cooldown = new Map();   // key -> index until which repeat signals are suppressed

  for (let i = from; i < n; i++) {
    const win = candles.slice(Math.max(0, i - 89), i + 1);
    let dets;
    try { dets = detectPatterns(win, { keys, max: 4 }); } catch { continue; }
    for (const d of dets) {
      if (d.status !== 'formed' || d.action === 'HOLD') continue;
      if (d.ageBars == null || d.ageBars > 3) continue;
      if (cooldown.has(d.key) && i < cooldown.get(d.key)) continue;
      if (d.entry == null || d.stop == null || d.target == null) continue;
      const dir = d.action === 'BUY' ? 1 : -1;
      const entry = candles[i].close;
      const risk = Math.abs(entry - d.stop);
      if (!(risk > 0)) continue;
      /* forward simulation — stop evaluated first (conservative) */
      let exit = null, result = null, barsUsed = hold;
      for (let j = i + 1; j <= Math.min(i + hold, n - 1); j++) {
        const bar = candles[j];
        const hitSL = dir > 0 ? bar.low <= d.stop : bar.high >= d.stop;
        const hitTP = dir > 0 ? bar.high >= d.target : bar.low <= d.target;
        if (hitSL) { exit = d.stop; result = 'stop'; barsUsed = j - i; break; }
        if (hitTP) { exit = d.target; result = 'target'; barsUsed = j - i; break; }
      }
      if (exit == null) {
        const endIdx = Math.min(i + hold, n - 1);
        exit = candles[endIdx].close;
        result = 'timeout';
        barsUsed = endIdx - i;
      }
      const r = ((exit - entry) / risk) * dir;
      cooldown.set(d.key, i + barsUsed);   /* no overlapping entries for same pattern */
      const bucket = per.get(d.key);
      if (bucket) {
        bucket.n++;
        if (result === 'target') bucket.wins++;
        else if (result === 'stop') bucket.losses++;
        else if (r > 0) bucket.wins++; else bucket.losses++;
        bucket.sumR += Math.round(r * 100) / 100;
        bucket.barsSum += barsUsed;
      }
      if (trades.length < 60) {
        trades.push({ pattern: d.key, key: d.key, i, exitI: i + barsUsed, name: d.pattern, at: candles[i].time, action: d.action, entry: Math.round(entry * 1e5) / 1e5, exit: Math.round(exit * 1e5) / 1e5, result, r: Math.round(r * 100) / 100, bars: barsUsed, confidence: d.confidence });
      }
    }
  }

  const patterns = [...per.values()]
    .filter((b) => b.n > 0)
    .map((b) => ({
      key: b.key, pattern: b.pattern, n: b.n, wins: b.wins, losses: b.losses,
      winRate: b.n ? Math.round((b.wins / b.n) * 1000) / 10 : 0,
      avgR: b.n ? Math.round((b.sumR / b.n) * 100) / 100 : 0,
      avgBars: b.n ? Math.round(b.barsSum / b.n) : 0
    }))
    .sort((a, b) => b.n - a.n);

  const totalN = patterns.reduce((s, p) => s + p.n, 0);
  return {
    window: n, holdBars: hold, signals: totalN,
    note: totalN < 15
      ? 'Small sample (' + totalN + ' signals) — treat these rates as indicative, not statistical proof.'
      : 'Walk-forward on ' + n + ' real candles: every historical signal was followed bar-by-bar (stop first, then target, ' + hold + '-bar timeout).',
    patterns, trades
  };
}
