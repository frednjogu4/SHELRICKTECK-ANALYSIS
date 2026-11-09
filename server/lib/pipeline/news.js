/* NEWS role (master §5) — pure, testable. Classifies provider items by the
   configured validity window; separates source facts from interpretation.
   INVARIANT: news alone NEVER authorizes a trade — `authorizes` is always false.
   Missing/unparseable timestamps are 'freshness unknown', never 'fresh'. */

export function newsContext({ items, now = Date.now(), validityMin = 25 } = {}) {
  const fresh = [], stale = [], unknown = [];
  for (const it of Array.isArray(items) ? items : []) {
    const t = Number(it && it.t);
    if (!Number.isFinite(t) || t <= 0) { unknown.push(it); continue; }
    const ageMin = Math.max(0, (now - t) / 60000);
    const rec = Object.assign({}, it, { ageMin: Math.round(ageMin * 10) / 10, freshness: ageMin <= validityMin ? 'fresh' : 'stale' });
    (ageMin <= validityMin ? fresh : stale).push(rec);
  }
  const loaded = Array.isArray(items);
  let restriction = 'NONE';
  if (loaded && stale.length && !fresh.length) restriction = 'STALE_STAND_DOWN'; // stale headlines are not actionable
  return {
    role: 'NEWS',
    ts: new Date(now).toISOString(),
    state: loaded ? 'DONE' : 'UNAVAILABLE',   /* dependency state — missing feed is not a pass */
    validityMin,
    fresh, stale, unknown,
    factsFields: ['title', 'link', 'source', 'published'],   /* provider facts */
    interpretationFields: ['bias'],                          /* computed interpretation, not a fact */
    restriction,                                              /* NONE | STALE_STAND_DOWN */
    authorizes: false,                                        /* INVARIANT: never true */
    note: loaded
      ? 'News context only. Sentiment/interpretation never authorizes a trade; stale items (' + stale.length + ') stand down.'
      : 'News feed unavailable — role cannot complete (missing data never counts as passed).',
  };
}
