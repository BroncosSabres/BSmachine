// calibrate-client.js — the calibration for a page: from this browser's cache
// when the settled data hasn't changed since (the analysis endpoint's
// version), else fitted in a Worker (calibrate-worker.js). Both Best Bets
// pages share it.
import { fitFor, calProb, marketChance, edgeAt, leafKey } from './calibrate.js';
import { stateOf, predictClose } from './close-model.js';

const CACHE_KEY = 'bsm_bb_calib_v8';   // v8: alternates far from their main line kept out of the fits (v7: moved main lines judged at the close at their own line)

function cached(version, basis) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    return c && c.version === version && c.basis === basis ? c : null;
  } catch { return null; }
}

// -> Promise of the worker's result ({ hierarchy, markets, all, ... }), or
// null when it can't be had (no Worker, or it failed)
export function loadCalibration(rows, { version, basis = 'book', prefs = null } = {}) {
  const hit = version && cached(version, basis);
  if (hit) return Promise.resolve(hit);
  if (typeof Worker === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    let worker;
    try {
      worker = new Worker(new URL('./calibrate-worker.js', import.meta.url), { type: 'module' });
    } catch { resolve(null); return; }
    worker.onmessage = e => {
      worker.terminate();
      const res = e.data;
      if (res.error) { console.warn('calibration failed:', res.error); resolve(null); return; }
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(res)); } catch { /* full or unavailable */ }
      resolve(res);
    };
    worker.onerror = () => { worker.terminate(); resolve(null); };
    // Only what the fit reads: the rows decoded, without their back-references
    worker.postMessage({ rows: rows.map(({ row, ...r }) => r), basis, prefs, version });
  });
}

// A bet's commission: its own, else worked back from its edge (the model's
// edge is after commission at the median price): Betfair's, 0 for bookies
export function commissionOf(r) {
  if (r.commission != null) return r.commission;
  const p = r.model_prob, back = r.median ?? r.back;
  if (!(p > 0) || !(back > 1) || r.edge == null) return 0;
  const c = 1 - (r.edge + 1 - p) / (p * (back - 1));
  return Math.min(0.2, Math.max(0, c));
}

// The calibrated chance and edges of an upcoming bet (or a live pick at its
// close): from its model chance and its median price with the margin out
// (mkt_sum, the overround of its sides at its check, where every side was
// priced). { p, lo, hi, edge / edgeLo: at the median (its 90% low end),
// bookEdge / bookEdgeLo: at the price taken - what judges it: the bet is
// taken at the best bookie's price - weight } or null.
export function calibrateBet(cal, r, { modelProb = r.model_prob, median = r.median ?? r.back, taken = r.back } = {}) {
  if (!cal || !(modelProb > 0 && modelProb < 1) || !(median > 1)) return null;
  const fit = fitFor(cal.hierarchy, leafKey(r));
  const c = calProb(fit, modelProb, marketChance(median, r.mkt_sum));
  const com = commissionOf(r);
  return { ...c, edge: edgeAt(c.p, median, com), edgeLo: edgeAt(c.lo, median, com),
           bookEdge: edgeAt(c.p, taken, com), bookEdgeLo: edgeAt(c.lo, taken, com), fit };
}

// The calibrated edge at one check of a bet's price history ([t, median,
// book, edge, flags]), at the price it would have been taken at then (book:
// the best bookie's, where recorded; else the median): its model chance
// worked back from the edge then, the margin out by its current overround
export function calEdgeAtPoint(cal, r, p, book = true) {
  if (!cal || !(p[1] > 1) || p[3] == null) return null;
  const com = commissionOf(r);
  const model = (p[3] + 1) / ((p[1] - 1) * (1 - com) + 1);
  const taken = (book && p[2] > 1 ? p[2] : null) ?? p[1];
  const c = calibrateBet(cal, r, { modelProb: model, median: p[1], taken });
  return c && c.bookEdge;
}

// --- predicted close (close-model.js) ---------------------------------------------

const msOf = t => (typeof t === 'number' ? t * 1000 : Date.parse(t));

// An upcoming bet's predicted close and the edge of taking its price now
// against the fair close predicted (close-model.js predictClose: { edge,
// edgeLo, fair, closeBack, move, ... }), or null: no close model (the
// analysis endpoint not yet sending open_hrs), or kickoff passed. at: when
// the price was seen (the check's time; seconds or ISO).
export function closeBet(cal, r, { modelProb = r.model_prob, median = r.median ?? r.back, taken = r.back, at = r.checked_at } = {}) {
  const cm = cal && cal.close;
  if (!cm || !(median > 1)) return null;
  const hrs = (Date.parse(r.kickoff) - msOf(at ?? Date.now() / 1000)) / 3.6e6;
  const state = stateOf({ back: median, taken, prob: modelProb, overround: r.mkt_sum, hrs });
  return predictClose(cm.moves, cm.fair, leafKey(r), state, { overround: r.mkt_sum, commission: commissionOf(r) });
}

// The predicted-close edge at one check of a bet's price history ([t, median,
// book, edge, flags]), as calEdgeAtPoint
export function closeEdgeAtPoint(cal, r, p, book = true) {
  if (!cal || !cal.close || !(p[1] > 1) || p[3] == null) return null;
  const com = commissionOf(r);
  const model = (p[3] + 1) / ((p[1] - 1) * (1 - com) + 1);
  const taken = (book && p[2] > 1 ? p[2] : null) ?? p[1];
  const c = closeBet(cal, r, { modelProb: model, median: p[1], taken, at: p[0] });
  return c && c.edge;
}
