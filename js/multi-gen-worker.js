// multi-gen-worker.js — the Multi Generator's searches (multi-gen.js) off the
// Best Bets page's main thread (best-bets-multi.js starts one per Generate).
//   { id, type: 'regular', legs, n, k, minTotal, top, locked, rate }
//   { id, type: 'sgm', sport, game: { bins, playerData }, legs (each with
//     leg: sgm-legs.js legOf's, and p: its chance, or null for the model's),
//     n, k, minTotal, top, locked, rate }
// -> { id, results (each result's legs by id), complete, nodes, groups,
//      reason } (sgm: also marginals, { id: the model's chance }); while a
//      Same Game Multi search scores its shortlist, { id, progress: 0..1 }.
import { searchIndependent, searchSgm } from './multi-gen.js';
import { gameState, jointProb } from './sgm-legs.js';

const slim = out => ({ ...out, results: out.results.map(r => ({ ...r, legs: r.legs.map(l => l.id) })) });

function sgm(id, { sport, game, legs, ...opts }) {
  const gs = gameState(sport, game);
  // Each leg's own chance from the engine: the joint's marginal, and its
  // chance too unless the page sent the calibrated one
  const marginals = {};
  const priced = [];
  for (const l of legs) {
    const pm = jointProb(sport, gs, [l.leg]);
    if (!(pm > 0 && pm < 1)) continue;
    marginals[l.id] = pm;
    priced.push({ ...l, pModel: pm, p: l.p ?? pm });
  }
  let last = 0;
  const out = searchSgm(priced, {
    ...opts,
    jointOf: ls => jointProb(sport, gs, ls.map(l => l.leg)) ?? 0,
    onProgress: f => { if (f - last >= 0.05) { last = f; self.postMessage({ id, progress: f }); } },
  });
  return { ...slim(out), marginals };
}

self.onmessage = e => {
  const { id, type, legs, ...opts } = e.data;
  try {
    if (type === 'regular') self.postMessage({ id, ...slim(searchIndependent(legs, opts)) });
    else if (type === 'sgm') self.postMessage({ id, ...sgm(id, { legs, ...opts }) });
    else throw new Error(`unknown search ${type}`);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
