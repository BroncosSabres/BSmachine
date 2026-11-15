// calibrate-fit.js — the calibration's fitted parts as they are sent on:
// shared by calibrate-worker.js (fitted in the browser) and
// tools/build-model.mjs (fitted on the VM for the Best Bets page), so both
// give the very same thing.
import { movePoints, chooseMoveN0, fitMoves, fitFairClose, walkMoves, closeReturns } from './close-model.js';

export const slim = f => ({ beta: f.beta, V: f.V, n: f.n, games: f.games, own: f.own, dRef: f.dRef });
export const slimTree = h => ({ root: slim(h.root), n0: h.n0,
                                sports: Object.fromEntries(Object.entries(h.sports).map(([k, f]) => [k, slim(f)])),
                                leaves: Object.fromEntries(Object.entries(h.leaves).map(([k, f]) => [k, slim(f)])) });

// The predicted-close model (close-model.js), once the analysis endpoint
// sends when each selection was first priced (open_hrs); else null
export function closeModel(rows, n0Market) {
  if (!rows.some(r => r.open_hrs != null)) return null;
  const pts = movePoints(rows);
  if (pts.length < 500) return null;
  const fairN0 = { sport: 30, leaf: 1000, market: n0Market };
  const pick = chooseMoveN0(pts);
  const wf = walkMoves(pts, { n0: pick.n0, rows, fairN0 });
  return { n0: pick.n0, points: pts.length, days: wf.days, moves: slimTree(fitMoves(pts, pick.n0)),
           fair: slimTree(fitFairClose(rows, fairN0)), eval: closeReturns(rows, wf) };
}
