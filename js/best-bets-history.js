// best-bets-history.js — what a bet's price history says about when the page
// listed it under the viewer's filters: the "No longer value" section and the
// Live tab's "listed" test. No DOM, so it can be exercised under Node.
//
// A history point (/api/best_bets rows and dropped, /api/best_bets/live picks):
//   [unix seconds, median price, best bookie's price (null: Betfair),
//    median edge, flags, that bookie ("A, B" on ties; null: Betfair; absent
//    from older backends), the other bookies' median where the best price was
//    10% or more above it (null otherwise; absent from older backends)]
// flags: HIST_OUTLIER - an outlier price under today's fitted thresholds
//        (Filters' "Where they've paid");
//        HIST_UNLISTED - a check the page never lists (Betfair's closing runs).
// A point holds from its check until the next one, the last until the end
// given (now, or kickoff). Runs at the same price and edge are cut to their
// first and last point by the backend, which this reads the same way.
import { passesBet, outlierPasses, edgeClass } from './best-bets-filters.js';

export const HIST_OUTLIER = 1;
export const HIST_UNLISTED = 2;

// Whether a check was an outlier price under the viewer's outlier settings:
// its gap and edge class (the edge at the best price is the median's scaled
// to it), or, where the market's rule is "Where they've paid", the backend's
// flag. A point without the other bookies' median has no gap to judge.
export function pointOutlier(prefs, key, p) {
  const cons = p[6], gap = cons > 1 && p[2] != null ? p[2] / cons - 1 : null;
  const bookEdge = p[3] != null && p[1] > 0 && p[2] != null ? (1 + p[3]) * p[2] / p[1] - 1 : p[3];
  return outlierPasses(prefs, key, { gap, cls: edgeClass(p[3], bookEdge), paid: !!(p[4] & HIST_OUTLIER) });
}

// Whether the page listed the bet at this check under these settings: its
// market switched on, the edge that market needs (at the median), the odds
// range (median price), or an outlier price where outliers are listed.
// edgeOf(point): the edge that judges, where it isn't the model's (the
// calibrated one, with Filters judging by it).
export function pointPasses(prefs, key, p, edgeOf = null) {
  if (!Array.isArray(p) || p.length < 5 || p[1] == null || (p[4] & HIST_UNLISTED)) return false;
  return passesBet(prefs, key, edgeOf ? edgeOf(p) : p[3], p[1], pointOutlier(prefs, key, p));
}

// --- held listing -------------------------------------------------------------
// A bet the list showed stays listed while it can still be had at a price it
// was listed at: once listed, a price that rises (its median edge past the
// band's top, the odds past the odds range, an outlier gap closed by the
// other bookies catching up) keeps it. It drops when the price taken (the
// best bookie's; the median on Betfair) falls below the lowest price it was
// listed at, or when a model update means that price no longer passes.

// A price's return per unit staked, after commission, plus the stake
const decOf = (x, com) => (x - 1) * (1 - com) + 1;
// The model's chance a point was priced at (exact bar the chance of a push,
// as calibrate-client.js calEdgeAtPoint reads it), or null
export const impliedProb = (p, com = 0) =>
  Array.isArray(p) && p[1] > 1 && p[3] != null ? (1 + p[3]) / decOf(p[1], com) : null;
// Point q as the model with chance `prob` would have priced it (its median
// edge redone at that chance)
export function rejudgeAt(q, prob, com = 0) {
  if (prob == null || !(q[1] > 1)) return q;
  const out = q.slice();
  out[3] = prob * decOf(q[1], com) - 1;
  return out;
}
// The price a point's bet is taken at: the best bookie's, else the median
export const takenAt = p => p[2] ?? p[1];
// A point's model edge at a price (its best price by default), at its own
// model or the chance given
export function edgeAtPoint(p, com = 0, price = takenAt(p), prob = impliedProb(p, com)) {
  return prob == null || price == null ? p[3] : prob * decOf(price, com) - 1;
}
// How far the model's chance can move before a point's listing is judged
// again (relative): edges are stored to 4 places, and a push moves the chance
// read off a point a little with the price
const SAME_MODEL = 1e-3;

// Over points (oldest first) and pass(point) (the list's test at that check):
// per point { listed, held, floor, floorPoint }. listed: the list showed it
// there - it passed, or it was held: not passing, but taken at or above the
// floor. floor: the lowest price taken at the checks it passed at that still
// pass at this check's model (null: none); floorPoint: that check's point.
export function heldWalk(points, pass, com = 0) {
  const list = Array.isArray(points) ? points : [];
  const listing = [];   // [point, its model's chance] where it passed
  let prob = null, floor = null;
  const lower = q => { if (!floor || takenAt(q) < takenAt(floor)) floor = q; };
  return list.map(p => {
    if (!Array.isArray(p) || p.length < 5 || p[1] == null) return { listed: false, held: false, floor: null, floorPoint: null };
    const ok = pass(p);
    const pr = impliedProb(p, com);
    if (pr != null && (prob == null || Math.abs(pr - prob) > SAME_MODEL * prob)) {
      // The model has moved: each price it was listed at, judged again
      prob = pr;
      floor = null;
      for (const [q, qp] of listing) {
        if (Math.abs(qp - prob) <= SAME_MODEL * prob || pass(rejudgeAt(q, prob, com))) lower(q);
      }
    }
    if (ok) { listing.push([p, pr ?? prob]); lower(p); }
    const held = !ok && !(p[4] & HIST_UNLISTED) && floor != null && takenAt(p) >= takenAt(floor) - 1e-9;
    return { listed: ok || held, held, floor: floor && takenAt(floor), floorPoint: floor };
  });
}

// A bet now, from its history and its latest check as a point (nowPoint):
// { held (listed only by being held), passes (at that check), floor,
// floorPoint, floorThen / floorThenPoint (the lowest price taken at any
// check it passed at, at the model of the time: a model update shows as
// floor > floorThen or floor null), ever (it passed at some check before) }
export function heldNow(points, nowPoint, pass, com = 0) {
  const list = [...(Array.isArray(points) ? points : []), nowPoint];
  const walk = heldWalk(list, pass, com);
  const last = walk[walk.length - 1];
  let floorThenPoint = null;
  list.forEach((p, i) => {
    if (i === list.length - 1 || !Array.isArray(p) || p.length < 5 || p[1] == null || !pass(p)) return;
    if (!floorThenPoint || takenAt(p) < takenAt(floorThenPoint)) floorThenPoint = p;
  });
  return { held: last.held, passes: last.listed && !last.held, floor: last.floor, floorPoint: last.floorPoint,
           floorThen: floorThenPoint && takenAt(floorThenPoint), floorThenPoint, ever: !!floorThenPoint };
}

// Over points (oldest first) and pass(point): { ever, secs, firstAt,
// lastPoint, lastEnd } - whether any check listed it, for how long in all
// (seconds), when it first was, the last listed point and when that listing
// ended (the next check, or `end`, unix seconds). com (a number): listings
// held (heldWalk) count too, at that commission.
export function listedInfo(points, pass, end, com = null) {
  let secs = 0, firstAt = null, lastPoint = null, lastEnd = null;
  const list = Array.isArray(points) ? points : [];
  const walk = com == null ? null : heldWalk(list, pass, com);
  list.forEach((p, i) => {
    if (walk ? !walk[i].listed : !pass(p)) return;
    const next = i + 1 < list.length ? list[i + 1][0] : end;
    const until = Math.max(p[0], Math.min(next ?? p[0], end ?? Infinity));
    secs += until - p[0];
    if (firstAt == null) firstAt = p[0];
    lastPoint = p;
    lastEnd = until;
  });
  return { ever: !!lastPoint, secs, firstAt, lastPoint, lastEnd };
}

// Over points (oldest first, the latest check last) and pass(point): when
// the listing the last point is in began (unix seconds; held listings count,
// heldWalk at commission com), or null where the last point isn't listed.
// A bet listed, dropped and listed again dates from the latest listing.
export function listedSince(points, pass, com = 0) {
  const list = Array.isArray(points) ? points : [];
  const walk = heldWalk(list, pass, com);
  let i = walk.length - 1;
  if (i < 0 || !walk[i].listed) return null;
  while (i > 0 && walk[i - 1].listed) i--;
  return list[i][0];
}

// The bookies that had the best price at the checks pass(point) picks, each
// with the highest price it was best at and how long it was the best in all
// (seconds; a check holds until the next one, the last until `end`):
// [{ book, price, secs }], the highest price first. A tie counts for each of
// its bookies; a point naming none (Betfair, older backends) for none.
export function bestBooksOf(points, pass, end) {
  const list = Array.isArray(points) ? points : [];
  const by = new Map();
  list.forEach((p, i) => {
    if (!Array.isArray(p) || typeof p[5] !== 'string' || p[2] == null || !pass(p)) return;
    const next = i + 1 < list.length ? list[i + 1][0] : end;
    const secs = Math.max(p[0], Math.min(next ?? p[0], end ?? Infinity)) - p[0];
    for (const book of p[5].split(', ')) {
      if (!by.has(book)) by.set(book, { book, price: 0, secs: 0 });
      const b = by.get(book);
      b.price = Math.max(b.price, p[2]);
      b.secs += secs;
    }
  });
  return [...by.values()].sort((a, b) => b.price - a.price || b.secs - a.secs);
}

// Whether the backend sent a history this module can read (older backends
// sent [t, median, book] points, or none)
export const hasHistory = points => Array.isArray(points) && points.some(p => Array.isArray(p) && p.length >= 5);

// A main line's line over time ([[unix seconds, line], ...]: line_history on
// /api/best_bets rows and dropped, sent once the line has moved), or null.
// Bookies move these lines and keep the price near 1.90, and the price
// history is one line's, so this is where the market went.
export function lineSeriesOf(r) {
  const h = r.line_history;
  return Array.isArray(h) && h.length > 1 && new Set(h.map(p => p[1])).size > 1 ? h : null;
}

// How far a move of the line to `to` is a bet's way: an over's line going
// up, an under's or a handicap's (either side's own) going down - the bet
// holds more than the market then gives (the backend's line_pts)
export const linePointsFor = (side, line, to) => (side === 'over' ? to - line : line - to);

// "2h 40m", "35 min", "under a minute"
export function spanText(secs) {
  if (secs < 60) return 'under a minute';
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return h < 48 ? `${h}h${r ? ` ${r}m` : ''}` : `${Math.round(h / 24)} days`;
}
