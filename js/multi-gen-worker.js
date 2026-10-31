// multi-gen-worker.js — the Multi Generator's searches (multi-gen.js,
// multi-combos.js, multi-system.js) off the Best Bets page's main thread
// (best-bets-multi.js starts them per Generate).
//   { id, type: 'regular', legs, n, k, minTotal, top, locked, rate }
//   { id, type: 'sgm', sport, game: { bins, playerData }, legs (each with
//     leg: sgm-legs.js legOf's, and p: its chance, or null for the model's),
//     n, k, minTotal, top, locked, rate }
//   { id, type: 'combos', legs, n, K, L, U, top, locked, budget, priced, slack }
//     one size of bonus bet combos; priced false (same-game legs allowed):
//     only the sets, for 'combos-sgm' once the games' models are in
//   { id, type: 'combos-sgm', legs (each with sport and row: the pool row's
//     fields legOf reads), jobs: [{ K, sets (each its leg ids) }], games:
//     { gameKey: { bins, playerData } }, L, U, top } -> { perK, marginals }
//   { id, type: 'system', legs (each with pStake), n, ks, top, locked }
// -> { id, results (each result's legs by id), ... } (sgm: also marginals,
//      { id: the model's chance }); while a Same Game Multi search scores its
//      shortlist, { id, progress: 0..1 }.
import { searchIndependent, searchSgm } from './multi-gen.js';
import { searchCombos, independentCombos, comboStats, priceSets } from './multi-combos.js';
import { searchSystem } from './multi-system.js';
import { gameState, jointProb, legOf } from './sgm-legs.js';

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

// One size of bonus bet combos: the best sets with their combos and what they
// return, or (priced false) only the sets - the best in the window and the
// best in it widened by `slack` (the model's correlation can move a combo
// with legs of one game into it), each on half the budget
function combos({ legs, K, priced = true, slack = 0, ...opts }) {
  if (!priced) {
    const half = { ...opts, budget: (opts.budget ?? 2e6) / 2 };
    const a = searchCombos(legs, { K, ...half });
    const b = slack > 0 ? searchCombos(legs, { K, ...half, L: opts.L - slack, U: opts.U + slack }) : null;
    const seen = new Set(a.results.map(r => r.sig));
    const results = [...a.results, ...(b?.results || []).filter(r => !seen.has(r.sig))];
    return slim({ ...a, results, complete: a.complete && (!b || b.complete), nodes: a.nodes + (b?.nodes || 0) });
  }
  const out = searchCombos(legs, { K, ...opts });
  return slim({ ...out, results: out.results.map(r => {
    const cs = independentCombos(r.legs, K);
    return { ...r, combos: cs, stats: comboStats(r.legs, cs) };
  }) });
}

// Bonus bet combos whose legs may share a game: each game's legs priced
// together from its model (its marginal for each leg, the joint for each
// subset), the sets kept whose every combo is then in the window. jobs: one
// per size, { K, sets }; the games' states and joints shared by all.
function combosSgm({ legs, jobs, games, L, U, top }) {
  const states = new Map(Object.entries(games).map(([key, data]) => [key, gameState(key.split(':')[0], data)]));
  const byId = new Map();
  for (const l of legs) {
    const gs = states.get(l.game);
    const leg = gs ? legOf(l.sport, gs, l.row) : null;
    const pm = leg ? jointProb(l.sport, gs, [leg]) : null;
    byId.set(l.id, { ...l, leg, pModel: pm > 0 && pm < 1 ? pm : null });
  }
  // A game's legs together (memoised by their ids): null when the model
  // can't price one of them
  const memo = new Map();
  const jointOf = ls => {
    if (ls.some(l => !l.leg || l.pModel == null)) return null;
    const key = ls.map(l => l.id).sort().join('\n');
    if (!memo.has(key)) memo.set(key, jointProb(ls[0].sport, states.get(ls[0].game), ls.map(l => l.leg)));
    return memo.get(key);
  };
  const perK = jobs.map(({ K, sets }) => {
    const { sets: kept, dropped } = priceSets(sets.map(ids => ({ legs: ids.map(i => byId.get(i)) })), { K, L, U, jointOf });
    const results = kept.slice(0, top).map(s => ({ legs: s.legs, ev: s.ev, combos: s.combos, stats: comboStats(s.legs, s.combos, s.parts) }));
    return { K, ...slim({ results }), dropped, scored: sets.length };
  });
  const marginals = Object.fromEntries([...byId.values()].filter(l => l.pModel != null).map(l => [l.id, l.pModel]));
  return { perK, marginals };
}

self.onmessage = e => {
  const { id, type, legs, ...opts } = e.data;
  try {
    if (type === 'regular') self.postMessage({ id, ...slim(searchIndependent(legs, opts)) });
    else if (type === 'sgm') self.postMessage({ id, ...sgm(id, { legs, ...opts }) });
    else if (type === 'combos') self.postMessage({ id, ...combos({ legs, ...opts }) });
    else if (type === 'combos-sgm') self.postMessage({ id, ...combosSgm({ legs, ...opts }) });
    else if (type === 'system') self.postMessage({ id, ...slim(searchSystem(legs, opts)) });
    else throw new Error(`unknown search ${type}`);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
