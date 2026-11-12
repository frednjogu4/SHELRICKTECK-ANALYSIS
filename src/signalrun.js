/* ================================================================
 * Live confidence: how a BUY/SELL reading stands against the market now.
 *
 * A reading carries a score (see server/lib/localdecision.js) and three
 * levels: entry, stop and target 1. The score is fixed at the moment of the
 * analysis. This module follows the reading afterwards:
 *
 *   - a "run" starts when a market is first read as BUY or SELL and keeps the
 *     entry, stop and target of that first reading while later analyses repeat
 *     the same direction;
 *   - the live score is the latest reading's score, minus up to AGAINST_POINTS
 *     as the price moves from the entry toward the stop, plus up to
 *     WITH_POINTS as it moves toward target 1;
 *   - when the price reaches the stop or target 1 the run is over, and the
 *     next analysis that still says BUY or SELL starts a new one.
 *
 * What it is not: a chance of profit. It is the same agreement score, marked
 * up or down by a measured distance. Nothing here predicts the next move.
 *
 * Pure functions and one small in-memory tracker: no DOM, no network, no clock
 * other than the one passed in.
 * ================================================================ */

/** Points taken off the score by the time the price has reached the stop. */
export const AGAINST_POINTS = 30;
/** Points added to the score by the time the price has reached target 1. */
export const WITH_POINTS = 15;
/** The score scale used everywhere else in the app. */
export const SCORE_MIN = 5;
export const SCORE_MAX = 93;

const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF']);

const clampScore = (value) => Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(Number(value) || 0)));
const sideOf = (signal) => (signal === 'BUY' ? 1 : signal === 'SELL' ? -1 : 0);

/**
 * The unit a person reads a move in: pips for currency pairs (0.0001, or 0.01
 * when the yen is quoted), dollars for anything else quoted in dollars (gold,
 * silver, bitcoin), points for the rest. Gold is given in dollars on purpose:
 * brokers disagree on what one "pip" of gold is.
 */
export function moveUnit(symbol) {
  const match = /^([A-Z]{3})\/([A-Z]{3})$/.exec(String(symbol || '').toUpperCase().trim());
  if (match && CURRENCIES.has(match[1]) && CURRENCIES.has(match[2])) return { kind: 'pips', size: match[2] === 'JPY' ? 0.01 : 0.0001 };
  if (match && match[2] === 'USD') return { kind: 'usd', size: 1 };
  return { kind: 'points', size: 1 };
}

/** A price distance in that unit: "6.3 pips", "$2.79", "12.50 points". Always positive. */
export function formatMove(symbol, distance) {
  const unit = moveUnit(symbol);
  const amount = Math.abs(Number(distance) || 0) / unit.size;
  if (unit.kind === 'pips') return amount.toFixed(1) + ' pips';
  if (unit.kind === 'usd') return '$' + amount.toFixed(2);
  return amount.toFixed(2) + ' points';
}

/** True when the three levels sit on the right sides of the entry for this direction. */
function levelsOf(run) {
  const dir = sideOf(run && run.signal);
  const entry = Number(run && run.entry), stop = Number(run && run.stop_loss), tp1 = Number(run && run.tp1);
  const risk = (entry - stop) * dir, reward = (tp1 - entry) * dir;
  const ok = dir !== 0 && entry > 0 && stop > 0 && tp1 > 0 && risk > 0 && reward > 0;
  return { ok, dir, entry, risk, reward };
}

/**
 * The score of a reading at a given live price.
 *
 * @param {{signal:string, entry:number, stop_loss:number, tp1:number, base:number}} run
 * @param {number} price  live price; anything that is not a positive number means "no live price"
 * @returns {{ok:boolean, base:number, confidence:number, state:string, move:number, share:number}}
 *   state  'with' | 'against' | 'flat' | 'stop' | 'target' | 'none'
 *   move   signed price distance from the entry; positive is in the reading's direction
 *   share  how much of the way to target 1 ('with') or to the stop ('against') has been covered, 0..1
 */
export function liveConfidence(run, price) {
  const base = clampScore(run && run.base);
  const levels = levelsOf(run);
  const px = Number(price);
  if (!levels.ok || !(px > 0) || !Number.isFinite(px)) return { ok: false, base, confidence: base, state: 'none', move: 0, share: 0 };
  const move = (px - levels.entry) * levels.dir;
  if (move <= -levels.risk) return { ok: true, base, confidence: clampScore(base - AGAINST_POINTS), state: 'stop', move, share: 1 };
  if (move >= levels.reward) return { ok: true, base, confidence: clampScore(base + WITH_POINTS), state: 'target', move, share: 1 };
  if (move < 0) {
    const share = -move / levels.risk;
    return { ok: true, base, confidence: clampScore(base - AGAINST_POINTS * share), state: 'against', move, share };
  }
  if (move > 0) {
    const share = move / levels.reward;
    return { ok: true, base, confidence: clampScore(base + WITH_POINTS * share), state: 'with', move, share };
  }
  return { ok: true, base, confidence: base, state: 'flat', move: 0, share: 0 };
}

/**
 * Follows readings market by market.
 *
 *   observe(reading)         tell the tracker what the latest analysis said
 *   read(key, price, feed)   the live score for a market at a price, or null when it has no run
 *   forget(key)              drop a market's run
 *
 * `key` defaults to the reading's symbol; a caller that reads the same market
 * from a second source keeps a tracker of its own.
 *
 * Feeds. Two venues do not quote the same price, so a reading's levels are only
 * compared with prices of the venue its candles came from. `feedOf(reading)`
 * names that venue, and `read()` names the venue of the price it is given. When
 * the two differ the price is set aside: the run answers with the newest price
 * of its own venue instead, which is the one that came with its latest analysis
 * (`sampledAt` in the answer says when). Such a run moves at each analysis, not
 * at each tick. A reading of the same direction from another venue starts a new
 * run, with its own levels.
 */
export function createSignalTracker({ now = () => Date.now(), feedOf = () => '' } = {}) {
  const runs = new Map();

  function view(run, live, sampledAt = 0) {
    return { ...live, symbol: run.symbol, signal: run.signal, entry: run.entry, stop_loss: run.stop_loss, tp1: run.tp1, startedAt: run.startedAt, endedAt: run.endedAt, feed: run.feed, sampledAt };
  }

  function end(run, live) {
    run.ended = live.state;
    run.endedAt = now();
    run.endMove = live.move;
  }

  return {
    observe(reading, key) {
      const id = key || (reading && reading.symbol);
      if (!id) return null;
      const run = {
        symbol: String((reading && reading.symbol) || id),
        signal: reading && reading.signal,
        entry: Number(reading && reading.entry),
        stop_loss: Number(reading && reading.stop_loss),
        tp1: Number(reading && reading.tp1),
        base: clampScore(reading && reading.confidence),
        feed: String((reading && feedOf(reading)) || ''),
        startedAt: now(), endedAt: 0, ended: '', endMove: 0, sample: 0, sampleAt: 0
      };
      /* WAIT, an error, or a reading without levels (the daily index readings): nothing to follow. */
      if (!reading || reading.error || !levelsOf(run).ok) { runs.delete(id); return null; }
      /* The price that came with the analysis, from the venue its candles came from. */
      run.sample = Number(reading.price) > 0 ? Number(reading.price) : run.entry;
      run.sampleAt = run.startedAt;
      const current = runs.get(id);
      if (current && !current.ended && current.signal === run.signal && current.feed === run.feed) {
        /* That price is one more sample: a stop or target crossed between two looks ends the run too. */
        const live = liveConfidence(current, run.sample);
        if (live.state !== 'stop' && live.state !== 'target') {
          current.base = run.base; current.sample = run.sample; current.sampleAt = run.sampleAt;
          return current;
        }
      }
      runs.set(id, run);
      return run;
    },

    read(key, price, feed = '') {
      const run = runs.get(key);
      if (!run) return null;
      const own = String(feed || '') === run.feed;
      const sampledAt = own ? 0 : run.sampleAt;
      if (run.ended) {
        const confidence = clampScore(run.base + (run.ended === 'stop' ? -AGAINST_POINTS : WITH_POINTS));
        return view(run, { ok: true, base: run.base, confidence, state: run.ended, move: run.endMove, share: 1 }, sampledAt);
      }
      const live = liveConfidence(run, own ? price : run.sample);
      if (live.state === 'stop' || live.state === 'target') end(run, live);
      return view(run, live, sampledAt);
    },

    forget(key) { runs.delete(key); },
    get size() { return runs.size; }
  };
}

/**
 * The sentence shown beside a live score.
 *
 * @param {object} live   what tracker.read() returned
 * @param {{time?:(ms:number)=>string, price?:(value:number)=>string, short?:boolean, sampled?:(at:string, live:object)=>string}} [format]
 *   sampled  the closing words when the score was measured at the price of the latest analysis
 *            rather than at a live price (see "Feeds" above)
 */
export function describeLive(live, { time = (ms) => new Date(ms).toISOString().slice(11, 16), price = (value) => String(value), short = false, sampled = (at) => 'price of the ' + at + ' analysis' } = {}) {
  if (!live) return '';
  const sentence = describeMove(live, { time, price, short });
  return !short && sentence && live.sampledAt ? sentence + ' \u00b7 ' + sampled(time(live.sampledAt), live) : sentence;
}

function describeMove(live, { time, price, short }) {
  const moved = formatMove(live.symbol, live.move);
  if (short) {
    if (live.state === 'with') return moved + ' with';
    if (live.state === 'against') return moved + ' against';
    if (live.state === 'stop') return 'stop reached';
    if (live.state === 'target') return 'target 1 reached';
    if (live.state === 'flat') return 'no move yet';
    return '';
  }
  const first = 'first read at ' + price(live.entry) + ', ' + time(live.startedAt);
  const asRead = live.confidence !== live.base ? ' \u00b7 score as read ' + live.base + '%' : '';
  const percent = Math.round(live.share * 100) + '%';
  if (live.state === 'with') return moved + ' with this ' + live.signal + ' \u00b7 ' + percent + ' of the way to target 1 \u00b7 ' + first + asRead;
  if (live.state === 'against') return moved + ' against this ' + live.signal + ' \u00b7 ' + percent + ' of the way to the stop \u00b7 ' + first + asRead;
  if (live.state === 'stop') return 'Stop level reached at ' + time(live.endedAt) + ' \u00b7 this ' + live.signal + ' reading (' + first + ') is over' + asRead;
  if (live.state === 'target') return 'Target 1 reached at ' + time(live.endedAt) + ' \u00b7 this ' + live.signal + ' reading (' + first + ') has run its course' + asRead;
  if (live.state === 'flat') return 'No move yet \u00b7 ' + first;
  return 'No live price right now \u00b7 ' + first;
}
