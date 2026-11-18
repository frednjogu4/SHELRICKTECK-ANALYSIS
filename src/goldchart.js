const finite = value => Number.isFinite(Number(value));

/** Render verified Gold OHLC history as a responsive, read-only 5-minute candlestick chart. */
export function renderGoldCandlestickChart(candles, { price = null, digits = 2, limit = 72 } = {}) {
  const rows = (Array.isArray(candles) ? candles : []).filter(c => {
    if (!c || ![c.time, c.open, c.high, c.low, c.close].every(finite)) return false;
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
    return Number(c.time) > 0 && l > 0 && h >= Math.max(o, cl) && l <= Math.min(o, cl);
  }).slice(-Math.max(2, Math.min(200, Math.trunc(Number(limit) || 72))));
  if (rows.length < 2) return '';

  const W = 960, H = 300, left = 12, right = 76, top = 12, bottom = 30;
  const plotW = W - left - right, plotH = H - top - bottom;
  let min = Math.min(...rows.map(c => Number(c.low))), max = Math.max(...rows.map(c => Number(c.high)));
  const live = Number(price);
  if (finite(price) && live > 0) { min = Math.min(min, live); max = Math.max(max, live); }
  const pad = (max - min || Math.abs(max) * 0.0001 || 1) * 0.06;
  min -= pad; max += pad;
  const span = max - min || 1;
  const xAt = i => left + (i + 0.5) * plotW / rows.length;
  const yAt = value => top + (max - value) / span * plotH;
  const places = Number.isInteger(Number(digits)) && Number(digits) >= 0 && Number(digits) <= 8 ? Number(digits) : 2;
  const priceText = value => Number(value).toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
  const slot = plotW / rows.length, bodyW = Math.max(2, Math.min(10, slot * 0.62));
  const pieces = [];

  for (let i = 0; i <= 4; i++) {
    const value = max - span * i / 4, y = yAt(value);
    pieces.push(`<line x1="${left}" y1="${y.toFixed(2)}" x2="${(W - right + 2).toFixed(2)}" y2="${y.toFixed(2)}" stroke="currentColor" opacity=".13"/>`);
    pieces.push(`<text x="${W - right + 8}" y="${(y + 4).toFixed(2)}" fill="currentColor" opacity=".72" font-size="11">${priceText(value)}</text>`);
  }

  rows.forEach((c, i) => {
    const x = xAt(i), open = Number(c.open), close = Number(c.close), high = Number(c.high), low = Number(c.low);
    const color = close >= open ? 'var(--green)' : 'var(--red)';
    const bodyTop = Math.min(yAt(open), yAt(close)), bodyHeight = Math.max(1, Math.abs(yAt(open) - yAt(close)));
    pieces.push(`<line x1="${x.toFixed(2)}" y1="${yAt(high).toFixed(2)}" x2="${x.toFixed(2)}" y2="${yAt(low).toFixed(2)}" stroke="${color}" stroke-width="1.3"/>`);
    pieces.push(`<rect x="${(x - bodyW / 2).toFixed(2)}" y="${bodyTop.toFixed(2)}" width="${bodyW.toFixed(2)}" height="${bodyHeight.toFixed(2)}" fill="${color}" rx=".5"><title>${new Date(Number(c.time) < 1e12 ? Number(c.time) * 1000 : Number(c.time)).toLocaleString()} · O ${priceText(open)} · H ${priceText(high)} · L ${priceText(low)} · C ${priceText(close)}</title></rect>`);
  });

  for (let i = 0; i <= 4; i++) {
    const index = Math.min(rows.length - 1, Math.round(i * (rows.length - 1) / 4));
    const t = Number(rows[index].time), ms = t < 1e12 ? t * 1000 : t;
    pieces.push(`<text x="${xAt(index).toFixed(2)}" y="${H - 8}" text-anchor="middle" fill="currentColor" opacity=".65" font-size="10">${new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>`);
  }

  if (finite(price) && live > 0 && live >= min && live <= max) {
    const y = yAt(live);
    pieces.push(`<line x1="${left}" y1="${y.toFixed(2)}" x2="${W - right + 2}" y2="${y.toFixed(2)}" stroke="var(--accent)" stroke-width="1.2" stroke-dasharray="5 4"/>`);
    pieces.push(`<text x="${W - right + 8}" y="${(y - 5).toFixed(2)}" fill="var(--accent)" font-size="10">LIVE ${priceText(live)}</text>`);
  }

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gold XAU/USD 5-minute candlestick price chart, ${rows.length} verified candles" style="display:block;width:100%;height:auto;min-height:190px;color:var(--text-2)"><title>Gold / USD · 5-minute candles · chart only, not a signal</title>${pieces.join('')}</svg>`;
}
