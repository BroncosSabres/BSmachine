// best-bets-optimise.js — the Filters modal's "Most profitable" button: each
// market's edge range set to the one its settled bets have made the most
// money in, or the market switched off where no range has made money. No
// DOM, so it can be exercised under Node.
//
// The bets are the analysis page's (/api/best_bets/analysis, decoded by
// safe-stake.js decodeRows) at the average price while they showed value
// (the 'avg' stage: what betting at a random moment while a bet was listed
// got), taken at the price basis chosen, inside the odds range, one bet per
// market, positive edges only - the bets the Best Bets page would have shown.
// Edges are cut where the analysis page cuts them (roi-stats.js edgeCuts:
// bands joined until each holds enough bets, so few and wide while the sample
// is small), and the range is the run of neighbouring bands with the most
// units won. It is fitted to the past, so it flatters what comes next.
import { toBet } from './safe-stake.js';
import { profit, dropEmptyMarkets, onePerMarket, edgeCuts } from './roi-stats.js';
import { oddsRangeOf, inRange, ruleFor, edgeField } from './best-bets-filters.js';

export const OPT_STAGE = 'avg';
// A market with fewer settled bets than this is left as it is, and a range
// needs this many in it
export const OPT_MIN_BETS = 10;

// Settled rows -> the bets the optimiser reads, at the prefs' basis and odds
// range. edgeOf(row): the edge that judges (the calibrated one, with Filters
// judging by it), else the model's at the stage.
export function optimiseBets(rows, prefs, edgeOf = null) {
  const at = rows.filter(r => r[`${OPT_STAGE}_back`] != null).map(r => toBet(r, OPT_STAGE, prefs.basis));
  if (edgeOf) for (const b of at) b.edge = edgeOf(b.row);
  const odds = oddsRangeOf(prefs);
  return onePerMarket(dropEmptyMarkets(at.filter(b => b.edge != null)).kept).filter(b => b.edge > 0 && inRange(b.back, odds));
}

// The run of neighbouring edge bands with the most units won (ties: more
// bets), holding at least minBets. -> { lo, hi, n, units, roi } (hi Infinity:
// no top), or null when none has made money.
export function bestEdgeRange(bets, { minBets = OPT_MIN_BETS } = {}) {
  const cuts = [...edgeCuts(bets), Infinity];
  const bands = cuts.slice(0, -1).map((lo, i) => {
    const inside = bets.filter(b => b.edge >= lo && b.edge < cuts[i + 1]);
    return { lo, hi: cuts[i + 1], n: inside.length, units: inside.reduce((a, b) => a + profit(b), 0) };
  });
  let best = null;
  for (let i = 0; i < bands.length; i++) {
    let n = 0, units = 0;
    for (let j = i; j < bands.length; j++) {
      n += bands[j].n; units += bands[j].units;
      if (n < minBets || units <= 0) continue;
      if (!best || units > best.units + 1e-9 || (Math.abs(units - best.units) <= 1e-9 && n > best.n)) {
        best = { lo: bands[i].lo, hi: bands[j].hi, n, units, roi: units / n };
      }
    }
  }
  return best;
}

// An edge as the modal's inputs take it: percent, '' for no limit
const typedPct = x => (isFinite(x) && x > 0 ? String(+(x * 100).toFixed(1)) : '');

// { key: { status: 'on' | 'off' | 'thin', n, units, roi, edge: [min, max] (on only) } }
// for each market key ('sport|kind'):
//   on    a range has made money: switch on at it
//   off   it has enough settled bets and no range made money
//   thin  under OPT_MIN_BETS settled bets: left as it is
export function optimiseMarkets(rows, prefs, keys, edgeOf = null) {
  const bets = optimiseBets(rows, prefs, edgeOf);
  const out = {};
  for (const key of keys) {
    const mine = bets.filter(b => b.group === key);
    const units = mine.reduce((a, b) => a + profit(b), 0);
    const all = { n: mine.length, units, roi: mine.length ? units / mine.length : null };
    if (mine.length < OPT_MIN_BETS) { out[key] = { status: 'thin', ...all }; continue; }
    const best = bestEdgeRange(mine);
    out[key] = best ? { status: 'on', n: best.n, units: best.units, roi: best.roi, edge: [typedPct(best.lo), typedPct(best.hi)] }
      : { status: 'off', ...all };
  }
  return out;
}

// Settings with the report's markets applied: 'on' switched on at its range
// (of the edge that judges), 'off' switched off (its range kept), 'thin'
// untouched
export function applyOptimised(prefs, report) {
  const markets = { ...prefs.markets };
  const field = edgeField(prefs);
  for (const [key, r] of Object.entries(report)) {
    if (r.status === 'on') markets[key] = { ...ruleFor(prefs, key), on: true, [field]: [...r.edge] };
    else if (r.status === 'off') markets[key] = { ...ruleFor(prefs, key), on: false };
  }
  return { ...prefs, markets };
}
