// best-bets-history.js — what a bet's price history says about when the page
// listed it under the viewer's filters: the "No longer value" section and the
// Live tab's "listed" test. No DOM, so it can be exercised under Node.
//
// A history point (/api/best_bets rows and dropped, /api/best_bets/live picks):
//   [unix seconds, median price, best bookie's price (null: Betfair),
//    median edge, flags, that bookie ("A, B" on ties; null: Betfair; absent
//    from older backends)]
// flags: HIST_OUTLIER - an outlier price under today's thresholds;
//        HIST_UNLISTED - a check the page never lists (Betfair's closing runs).
// A point holds from its check until the next one, the last until the end
// given (now, or kickoff). Runs at the same price and edge are cut to their
// first and last point by the backend, which this reads the same way.
import { passesBet } from './best-bets-filters.js';

export const HIST_OUTLIER = 1;
export const HIST_UNLISTED = 2;

// Whether the page listed the bet at this check under these settings: its
// market switched on, the edge that market needs (at the median), the odds
// range (median price), or an outlier price where outliers are listed.
// edgeOf(point): the edge that judges, where it isn't the model's (the
// calibrated one, with Filters judging by it).
export function pointPasses(prefs, key, p, edgeOf = null) {
  if (!Array.isArray(p) || p.length < 5 || p[1] == null || (p[4] & HIST_UNLISTED)) return false;
  return passesBet(prefs, key, edgeOf ? edgeOf(p) : p[3], p[1], !!(p[4] & HIST_OUTLIER));
}

// Over points (oldest first) and pass(point): { ever, secs, firstAt,
// lastPoint, lastEnd } - whether any check listed it, for how long in all
// (seconds), when it first was, the last listed point and when that listing
// ended (the next check, or `end`, unix seconds).
export function listedInfo(points, pass, end) {
  let secs = 0, firstAt = null, lastPoint = null, lastEnd = null;
  const list = Array.isArray(points) ? points : [];
  list.forEach((p, i) => {
    if (!pass(p)) return;
    const next = i + 1 < list.length ? list[i + 1][0] : end;
    const until = Math.max(p[0], Math.min(next ?? p[0], end ?? Infinity));
    secs += until - p[0];
    if (firstAt == null) firstAt = p[0];
    lastPoint = p;
    lastEnd = until;
  });
  return { ever: !!lastPoint, secs, firstAt, lastPoint, lastEnd };
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
