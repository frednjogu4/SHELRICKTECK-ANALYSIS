const finite = value => value != null && value !== '' && Number.isFinite(Number(value));
const price = value => Number(value).toLocaleString('en-US', { maximumSignificantDigits: 8 });
const validRows = frame => (Array.isArray(frame && frame.candles) ? frame.candles : []).map(c => ({
  time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close)
})).filter(c => Number.isFinite(c.time) && [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.low > 0 && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close));

function mapSeries(series, xAt, yAt) {
  return (Array.isArray(series) ? series : []).filter(p => p && finite(p.time) && finite(p.value)).map(p => ({ x: xAt(Number(p.time)), y: yAt(Number(p.value)), value: Number(p.value), time: Number(p.time) }));
}
function pivots(rows, side) {
  const out = [];
  for (let i = 2; i < rows.length - 2; i++) {
    const value = rows[i][side];
    const slice = rows.slice(i - 2, i + 3);
    if (side === 'high' ? value >= Math.max(...slice.map(c => c.high)) : value <= Math.min(...slice.map(c => c.low))) out.push({ time: rows[i].time, value });
  }
  return out.slice(-12);
}
function patternAt(rows, i) {
  const c = rows[i], previous = rows[i - 1];
  if (!c) return '';
  const body = Math.max(Math.abs(c.close - c.open), Number.EPSILON);
  const upper = c.high - Math.max(c.open, c.close), lower = Math.min(c.open, c.close) - c.low;
  if (upper >= body * 2 && lower <= body) return 'Pin bar';
  if (lower >= body * 2 && upper <= body) return 'Pin bar';
  if (previous && ((c.close > c.open && previous.close < previous.open && c.open <= previous.close && c.close >= previous.open) ||
      (c.close < c.open && previous.close > previous.open && c.open >= previous.close && c.close <= previous.open))) return 'Engulfing';
  return '';
}
function impulseZones(rows) {
  const sample = rows.slice(-30), bodySizes = sample.map(c => Math.abs(c.close - c.open)).filter(value => value > 0).sort((a, b) => a - b);
  const typicalBody = bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)] : 0;
  const candidates = [];
  for (let i = rows.length - 4; i >= Math.max(0, rows.length - 24); i--) {
    const base = rows[i], a = rows[i + 1], b = rows[i + 2], c = rows[i + 3];
    if (!base || !a || !b || !c) continue;
    const move = c.close - base.close, direction = Math.sign(move);
    const aligned = direction > 0 ? a.close > a.open && b.close > b.open && c.close > c.open : a.close < a.open && b.close < b.open && c.close < c.open;
    if (!aligned || Math.abs(move) < Math.max(typicalBody * 4, (base.high - base.low) * 1.5)) continue;
    candidates.push(direction > 0
      ? { side: 'demand', low: base.low, high: Math.max(base.open, base.close), originTime: base.time, basis: 'three-candle bullish displacement heuristic' }
      : { side: 'supply', low: Math.min(base.open, base.close), high: base.high, originTime: base.time, basis: 'three-candle bearish displacement heuristic' });
  }
  return candidates.slice(0, 2);
}
function drawPath(ctx, points, color, width = 1.5, dash = []) {
  if (points.length < 2) return;
  ctx.save(); ctx.beginPath(); ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = width;
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke(); ctx.restore();
}
function drawPriceLine(ctx, yAt, low, high, value, color, label, dash = [5, 4]) {
  if (!finite(value)) return;
  const y = yAt(Number(value));
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(low, y); ctx.lineTo(high, y); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = '10px system-ui'; ctx.textAlign = 'right'; ctx.fillText(`${label} ${price(value)}`, high - 2, Math.max(10, y - 3)); ctx.restore();
}

/** Draws only provider candle data and explicit or mechanically detected chart annotations. */
export function renderAnnotatedCandlestickChart(canvas, frame, { symbol = '', timeframe = '', showTradeMarkers = false } = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return { drawn: false, reason: 'Canvas unavailable.' };
  if (frame && frame.chart_data) frame = frame.chart_data[timeframe] || frame.chart_data.requested_context || frame;
  frame = frame || {};
  const rows = validRows(frame);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { drawn: false, reason: 'Canvas context unavailable.' };
  const width = Math.max(320, Math.round(canvas.clientWidth || 640)), height = Number(canvas.dataset.height) || 250;
  const dpr = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
  canvas.width = width * dpr; canvas.height = height * dpr; canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#10151f'; ctx.fillRect(0, 0, width, height);
  const left = 66, right = 14, top = 14, bottom = 27, plotW = width - left - right, plotH = height - top - bottom;
  if (!rows.length || plotW <= 0 || plotH <= 0) {
    ctx.fillStyle = '#98a3b6'; ctx.font = '12px system-ui'; ctx.fillText('No verified candle series for this timeframe.', 12, 24);
    return { drawn: false, reason: 'No verified candles.' };
  }
  const overlay = frame.overlays || { signal: frame.direction || frame.signal, entry: frame.entry, sl: frame.sl, tp: frame.tp1 ?? frame.tp, tp1: frame.tp1, tp2: frame.tp2 };
  const sr = frame.support_resistance || { support: frame.support || [], resistance: frame.resistance || [] };
  const zones = frame.support_resistance_zones || {};
  const suppliedSupplyDemand = frame.supply_demand_zones || frame.order_blocks || null;
  const supplyDemandHeuristic = !suppliedSupplyDemand || (!Array.isArray(suppliedSupplyDemand.supply) && !Array.isArray(suppliedSupplyDemand.demand));
  const detectedZones = supplyDemandHeuristic ? impulseZones(rows) : [];
  const supplyDemand = supplyDemandHeuristic ? { supply: detectedZones.filter(zone => zone.side === 'supply'), demand: detectedZones.filter(zone => zone.side === 'demand') } : suppliedSupplyDemand;
  const levelNumber = item => finite(item) ? Number(item) : finite(item && (item.price ?? item.level)) ? Number(item.price ?? item.level) : null;
  const vals = rows.flatMap(c => [c.high, c.low]);
  for (const series of [frame.ema9, frame.ema21]) for (const p of Array.isArray(series) ? series : []) if (finite(p && p.value)) vals.push(Number(p.value));
  for (const side of ['support', 'resistance']) {
    for (const level of Array.isArray(sr[side]) ? sr[side] : []) {
      const value = levelNumber(level); if (value != null) vals.push(value);
      for (const bound of [level && level.low, level && level.high]) if (finite(bound)) vals.push(Number(bound));
    }
    for (const zone of Array.isArray(zones[side]) ? zones[side] : []) for (const level of [zone && zone.low, zone && zone.high]) if (finite(level)) vals.push(Number(level));
  }
  // Keep entry out of the analyst chart by default; the Chart & Trade signal view opts in explicitly.
  for (const level of [overlay.sl, overlay.tp, overlay.tp1, overlay.tp2, ...(showTradeMarkers ? [overlay.entry] : [])]) if (finite(level)) vals.push(Number(level));
  for (const side of ['supply', 'demand']) for (const zone of Array.isArray(supplyDemand[side]) ? supplyDemand[side] : []) for (const level of [zone && zone.low, zone && zone.high]) if (finite(level)) vals.push(Number(level));
  for (const pathPoint of Array.isArray(frame.predicted_path) ? frame.predicted_path : []) if (finite(pathPoint && pathPoint.price)) vals.push(Number(pathPoint.price));
  for (const key of ['highs', 'lows']) for (const segment of (frame.trendlines && frame.trendlines[key]) || []) for (const point of [segment && segment.from, segment && segment.to]) if (finite(point && (point.value ?? point.price))) vals.push(Number(point.value ?? point.price));
  for (const point of Array.isArray(frame.trendline_points) ? frame.trendline_points.flat(Infinity) : []) if (finite(point && (point.value ?? point.price))) vals.push(Number(point.value ?? point.price));
  const min0 = Math.min(...vals), max0 = Math.max(...vals), pad = Math.max((max0 - min0) * 0.08, Math.abs(max0) * 0.00001, 1e-8);
  const min = min0 - pad, max = max0 + pad, yAt = value => top + (max - value) / (max - min || 1) * plotH;
  const pathTimes = (Array.isArray(frame.predicted_path) ? frame.predicted_path : []).filter(p => finite(p && p.time) && finite(p && p.price)).map(p => Number(p.time));
  const hasPath = pathTimes.length >= 2, candlePlotW = plotW * (hasPath ? 0.78 : 1);
  const candleW = Math.max(2, Math.min(11, candlePlotW / rows.length * 0.62)), xAtIndex = i => left + ((i + 0.5) / rows.length) * candlePlotW;
  const times = rows.map(c => c.time), xAtTime = t => {
    if (hasPath && t > times.at(-1)) {
      const lastX = xAtIndex(rows.length - 1), futureEnd = Math.max(...pathTimes), futureWidth = plotW - candlePlotW;
      return lastX + Math.min(1, (t - times.at(-1)) / Math.max(1, futureEnd - times.at(-1))) * futureWidth;
    }
    let i = times.findIndex(value => value >= t);
    if (i < 0) i = rows.length - 1;
    if (i > 0 && Math.abs(times[i - 1] - t) < Math.abs(times[i] - t)) i--;
    return xAtIndex(i);
  };
  // Light price grid and scale.
  ctx.save(); ctx.font = '10px system-ui'; ctx.textAlign = 'right'; ctx.fillStyle = '#98a3b6'; ctx.strokeStyle = 'rgba(152,163,182,.16)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = top + plotH * i / 4, value = max - (max - min) * i / 4;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke(); ctx.fillText(price(value), left - 7, y + 3);
  }
  ctx.restore();
  // Support/resistance shaded zones and levels.
  for (const [side, color] of [['support', 'rgba(46,204,143,.14)'], ['resistance', 'rgba(240,97,109,.14)']]) {
    for (const zone of Array.isArray(zones[side]) ? zones[side] : []) {
      if (!finite(zone && zone.low) || !finite(zone && zone.high)) continue;
      const y1 = yAt(Math.max(Number(zone.low), Number(zone.high))), y2 = yAt(Math.min(Number(zone.low), Number(zone.high)));
      ctx.fillStyle = color; ctx.fillRect(left, y1, plotW, Math.max(2, y2 - y1));
      ctx.fillStyle = side === 'support' ? '#2ecc8f' : '#f0616d'; ctx.font = '9px system-ui'; ctx.textAlign = 'left'; ctx.fillText(side.toUpperCase(), left + 3, y1 + 10);
    }
    for (const level of Array.isArray(sr[side]) ? sr[side] : []) {
      const levelColor = side === 'support' ? '#2ecc8f' : '#f0616d';
      if (finite(level && level.low) && finite(level && level.high)) {
        const y1 = yAt(Math.max(Number(level.low), Number(level.high))), y2 = yAt(Math.min(Number(level.low), Number(level.high)));
        ctx.fillStyle = color; ctx.fillRect(left, y1, plotW, Math.max(2, y2 - y1));
      }
      const value = levelNumber(level);
      if (value != null) drawPriceLine(ctx, yAt, left, width - right, value, levelColor, side === 'support' ? 'S' : 'R', [3, 4]);
    }
  }
  // EMA overlays.
  drawPath(ctx, mapSeries(frame.ema9, xAtTime, yAt), '#e0b45c', 1.4);
  drawPath(ctx, mapSeries(frame.ema21, xAtTime, yAt), '#5b9cf8', 1.4);
  // Supplied swing trendlines.
  for (const [key, color] of [['highs', '#f0616d'], ['lows', '#2ecc8f']]) {
    for (const segment of (frame.trendlines && frame.trendlines[key]) || []) {
      const a = segment && segment.from, b = segment && segment.to;
      const av = a && (a.value ?? a.price), bv = b && (b.value ?? b.price);
      if (a && b && finite(a.time) && finite(av) && finite(b.time) && finite(bv)) drawPath(ctx, [{ x: xAtTime(a.time), y: yAt(av) }, { x: xAtTime(b.time), y: yAt(bv) }], color, 1.2, [6, 3]);
    }
  }
  const explicitTrendlines = Array.isArray(frame.trendline_points) ? frame.trendline_points : [];
  const lineGroups = explicitTrendlines.length && Array.isArray(explicitTrendlines[0]) ? explicitTrendlines : [explicitTrendlines];
  for (const points of lineGroups) {
    const mapped = points.filter(point => point && finite(point.time) && finite(point.value ?? point.price)).map(point => ({ x: xAtTime(Number(point.time)), y: yAt(Number(point.value ?? point.price)) }));
    drawPath(ctx, mapped, '#f2b64f', 1.5, [6, 3]);
  }
  // Optional explicit supply/demand zones; they are never synthesized or called institutional without provider evidence.
  for (const [key, color] of [['demand', 'rgba(46,204,143,.20)'], ['supply', 'rgba(240,97,109,.20)']]) {
    for (const zone of Array.isArray(supplyDemand[key]) ? supplyDemand[key] : []) {
      if (!finite(zone && zone.low) || !finite(zone && zone.high)) continue;
      const y1 = yAt(Math.max(Number(zone.low), Number(zone.high))), y2 = yAt(Math.min(Number(zone.low), Number(zone.high)));
      ctx.fillStyle = color; ctx.fillRect(left, y1, plotW, Math.max(2, y2 - y1));
      ctx.fillStyle = key === 'demand' ? '#2ecc8f' : '#f0616d'; ctx.font = '9px system-ui'; ctx.textAlign = 'left'; ctx.fillText(`${key.toUpperCase()} candidate`, left + 4, y1 + 10);
    }
  }
  // Real OHLC bars.
  rows.forEach((c, i) => {
    const x = xAtIndex(i), color = c.close >= c.open ? '#2ecc8f' : '#f0616d';
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yAt(c.high)); ctx.lineTo(x, yAt(c.low)); ctx.stroke();
    const bodyTop = yAt(Math.max(c.open, c.close)), bodyBottom = yAt(Math.min(c.open, c.close));
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, Math.max(1, bodyBottom - bodyTop));
  });
  // The Chart & Trade signal view opts into direction/entry markers. Forex Analyst charts keep those markers off.
  const direction = overlay.signal, target = overlay.tp1 ?? overlay.tp;
  const validatedTrade = (direction === 'BUY' || direction === 'SELL') && finite(overlay.entry) && finite(overlay.sl) && finite(target);
  if (validatedTrade && showTradeMarkers) {
    drawPriceLine(ctx, yAt, left, width - right, overlay.entry, direction === 'BUY' ? '#2ecc8f' : '#f0616d', `${direction} entry`, []);
    const x = xAtIndex(rows.length - 1), y = yAt(Number(overlay.entry));
    ctx.fillStyle = direction === 'BUY' ? '#2ecc8f' : '#f0616d'; ctx.beginPath();
    if (direction === 'BUY') { ctx.moveTo(x, y - 11); ctx.lineTo(x - 7, y + 2); ctx.lineTo(x + 7, y + 2); }
    else { ctx.moveTo(x, y + 11); ctx.lineTo(x - 7, y - 2); ctx.lineTo(x + 7, y - 2); }
    ctx.closePath(); ctx.fill();
  }
  if (validatedTrade) {
    drawPriceLine(ctx, yAt, left, width - right, overlay.sl, '#f0616d', 'SL', [6, 4]);
    drawPriceLine(ctx, yAt, left, width - right, target, '#2ecc8f', 'TP1', [6, 4]);
    drawPriceLine(ctx, yAt, left, width - right, overlay.tp2, '#2ecc8f', 'TP2', [2, 4]);
  }
  // Highlight recognizable candle patterns based on this series' OHLC only.
  const patternLabels = [];
  for (let i = Math.max(1, rows.length - 12); i < rows.length; i++) {
    const label = patternAt(rows, i); if (!label) continue;
    patternLabels.push(`${label} ${price(rows[i].close)}`);
    const x = xAtIndex(i), y = yAt(rows[i].high) - 7;
    ctx.strokeStyle = '#f2b64f'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
  }
  // Mark last confirmed close beyond a prior local swing as BOS; equal pivots are only possible liquidity references.
  const highPivots = pivots(rows, 'high'), lowPivots = pivots(rows, 'low'), last = rows.at(-1), prev = rows.at(-2);
  const lastHigh = highPivots.filter(p => p.time < last.time).at(-1), lastLow = lowPivots.filter(p => p.time < last.time).at(-1);
  if (lastHigh && prev.close <= lastHigh.value && last.close > lastHigh.value) drawPriceLine(ctx, yAt, left, width - right, lastHigh.value, '#f2b64f', 'BOS ↑', [2, 3]);
  if (lastLow && prev.close >= lastLow.value && last.close < lastLow.value) drawPriceLine(ctx, yAt, left, width - right, lastLow.value, '#f2b64f', 'BOS ↓', [2, 3]);
  const avgRange = rows.slice(-14).reduce((sum, c) => sum + c.high - c.low, 0) / Math.max(1, Math.min(14, rows.length));
  const tolerance = Math.max(avgRange * 0.12, Math.abs(last.close) * 1e-7);
  for (const [side, list, color] of [['equal highs', highPivots, '#a78bfa'], ['equal lows', lowPivots, '#a78bfa']]) {
    const pair = list.slice(0, -1).flatMap((a, i) => list.slice(i + 1).map(b => ({ a, b }))).find(p => Math.abs(p.a.value - p.b.value) <= tolerance);
    if (pair) {
      const level = (pair.a.value + pair.b.value) / 2;
      drawPriceLine(ctx, yAt, left, width - right, level, color, side, [2, 3]);
    }
  }
  // Render a forecast curve only when explicit future price coordinates exist; never invent projected prices.
  const path = Array.isArray(frame.predicted_path) ? frame.predicted_path.filter(p => finite(p && p.time) && finite(p && p.price)) : [];
  if (path.length >= 2) {
    const points = path.map(p => ({ x: xAtTime(Number(p.time)), y: yAt(Number(p.price)) }));
    ctx.save(); ctx.strokeStyle = '#f2b64f'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]); ctx.beginPath();
    points.forEach((p, i) => { if (!i) ctx.moveTo(p.x, p.y); else ctx.quadraticCurveTo(points[i - 1].x, points[i - 1].y, p.x, p.y); }); ctx.stroke(); ctx.restore();
  }
  // Axis labels and legend.
  ctx.fillStyle = '#98a3b6'; ctx.font = '9px system-ui'; ctx.textAlign = 'left'; ctx.fillText(new Date(rows[0].time * 1000).toLocaleTimeString(), left, height - 7);
  ctx.textAlign = 'right'; ctx.fillText(new Date(last.time * 1000).toLocaleTimeString(), width - right, height - 7);
  ctx.textAlign = 'left'; ctx.fillStyle = '#e0b45c'; ctx.fillText(`${symbol} ${timeframe} · ${rows.length} closed candles`, left + 2, 11);
  const notes = [];
  if (!(frame.support_resistance_zones && ((frame.support_resistance_zones.support || []).length || (frame.support_resistance_zones.resistance || []).length))) notes.push('No supplied S/R zones');
  if (supplyDemandHeuristic && detectedZones.length) notes.push('Supply/demand zones are OHLC impulse heuristics, not evidence of institutional orders');
  else if (!supplyDemand || (!Array.isArray(supplyDemand.supply) && !Array.isArray(supplyDemand.demand))) notes.push('No supplied supply/demand zones');
  if (path.length < 2) notes.push('No priced forecast path');
  if (!validatedTrade) notes.push('No complete validated entry / SL / TP; SL/TP markers withheld');
  return { drawn: true, candles: rows.length, patterns: patternLabels, notes, levels: { entry: validatedTrade ? overlay.entry : null, sl: validatedTrade ? overlay.sl : null, tp1: validatedTrade ? target : null, tp2: validatedTrade && finite(overlay.tp2) ? overlay.tp2 : null } };
}
