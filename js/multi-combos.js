// multi-combos.js — the Multi Generator's bonus bet combos. No DOM, so it
// runs in multi-gen-worker.js and under Node.
//
// A bonus balance split into equal bets, one on each combination of K of N
// legs: C(N, K) bets. A bonus bet pays its winnings only (its price less 1 a
// unit), not its stake back. A set of N legs is kept only when every combo's
// price is in the window asked (a target, give or take a share), and sets are
// ranked by the expected cash per unit of bonus: the mean over the combos of
// P(the combo wins) x (its price - 1).
//
// A leg here is { id, group, game, solo, sig, price, p }: group, at most one
// leg each (the game; with same-game legs allowed, the game's market family);
// game, its game (default: group) - legs of one game in a combo are a Same
// Game Multi there; solo, a leg no other leg of its game may join (one the
// game's model can't price with others); sig, as multi-gen.js's.
// Legs of different games are independent. A combo's legs from one game are
// priced from the game's model (priceSets), as Same Game Multis are.
import { binom, sgmPrice, rescaledJoint } from './multi-gen.js';

export const MAX_COMBO_LEGS = 15;
export const MAX_COMBOS = 200;
export const COMBO_SIZES = [2, 3, 4, 5, 6];
const PREPASS_BUCKETS = 10;   // a group's legs in searchCombos' first pass, at most

// e_k(xs), k = 0..K: the sum over every k of the xs of their product
export function elemSym(xs, K) {
  const e = new Float64Array(K + 1);
  e[0] = 1;
  for (const x of xs) for (let k = K; k >= 1; k--) e[k] += e[k - 1] * x;
  return e;
}
const push = (e, x) => {
  const d = Float64Array.from(e);
  for (let k = d.length - 1; k >= 1; k--) d[k] += d[k - 1] * x;
  return d;
};
const popcount = x => { let c = 0; for (; x; x &= x - 1) c++; return c; };

// The legs (more than K) whose C(N, K) combos come closest to M bets, by
// ratio (for about 10 bets, 15 is nearer than 5), ties to the fewer bets:
// { n, count }, or null when none fits the caps
export function nearestN(M, K) {
  let best = null;
  const off = count => Math.abs(Math.log(count / M));
  for (let n = K + 1; n <= MAX_COMBO_LEGS; n++) {
    const count = Math.round(binom(n, K));
    if (count > MAX_COMBOS) break;
    if (!best || off(count) < off(best.count) - 1e-12) best = { n, count };
    if (count >= M) break;
  }
  return best;
}

// The combo prices allowed: target / (1 + tol) to target x (1 + tol), and their logs
export function oddsWindow(target, tol) {
  const f = 1 + Math.max(0, tol);
  return { lo: target / f, hi: target * f, L: Math.log(target / f), U: Math.log(target * f) };
}

// Every K of legs 0..n-1, as bit masks (bit i: leg i)
export function comboMasks(n, K) {
  const out = [];
  const rec = (start, left, mask) => {
    if (!left) { out.push(mask); return; }
    for (let i = start; i <= n - left; i++) rec(i + 1, left - 1, mask | (1 << i));
  };
  rec(0, K, 0);
  return out;
}

// A group's legs by log price, with sparse tables of the highest x and the
// lowest chance over every run of them, so a price range's take O(log n)
function rangeIndex(ls) {
  const by = [...ls].sort((a, b) => a.lp - b.lp);
  const mx = [by.map(l => l.x)], mn = [by.map(l => l.p)];
  for (let j = 1; 1 << j <= by.length; j++) {
    const px = mx[j - 1], pp = mn[j - 1], h = 1 << (j - 1), len = by.length - (1 << j) + 1;
    mx.push(Array.from({ length: len }, (_, i) => Math.max(px[i], px[i + h])));
    mn.push(Array.from({ length: len }, (_, i) => Math.min(pp[i], pp[i + h])));
  }
  return { lp: by.map(l => l.lp), mx, mn };
}
// [the highest x, the lowest chance] of the legs priced in [lo, hi], or null
function rangeQuery({ lp, mx, mn }, lo, hi) {
  const first = t => { let a = 0, b = lp.length; while (a < b) { const m = (a + b) >> 1; if (lp[m] < t) a = m + 1; else b = m; } return a; };
  const i = first(lo);
  let j = i, b = lp.length;   // j: the first priced over hi
  while (j < b) { const m = (j + b) >> 1; if (lp[m] <= hi) j = m + 1; else b = m; }
  if (j <= i) return null;
  const k = 31 - Math.clz32(j - i), e = j - (1 << k);
  return [Math.max(mx[k][i], mx[k][e]), Math.min(mn[k][i], mn[k][e])];
}

// v into list (kept highest first when dir is 1, lowest first when -1), at most cap long
function topIn(list, v, cap, dir) {
  if (list.length >= cap && (v - list[list.length - 1]) * dir <= 0) return;
  let i = list.length;
  while (i > 0 && (v - list[i - 1]) * dir > 0) i--;
  list.splice(i, 0, v);
  if (list.length > cap) list.pop();
}

// The best `top` sets of n legs for K-leg combos, by the expected cash per
// unit of bonus with the legs independent, every combo's log price in
// [L, U], at most one leg per group (and none beside a solo leg of its game),
// the locked legs in every one. Exact branch and bound over the groups, best
// first: a leg is tried only if every combo it would be in can still be in the
// window (the legs chosen bound the rest), and a branch is cut when even the
// best legs left that keep the window open can't beat the top-th best so far.
// Sets that differ only in a leg's line (sig) count once. budget caps the
// nodes visited: complete is false when it ran out (the best found so far).
// -> { results: [{ legs, ev, sig }], complete, nodes, groups, reason }
export function searchCombos(legs, { n, K, L, U, top = 10, locked = [], budget = 2e6, gap = 0, prepass = true } = {}) {
  const none = reason => ({ results: [], complete: true, nodes: 0, groups: 0, reason });
  if (!(K >= 1 && n >= K)) return none('size');
  const ok = l => l.p > 0 && l.p < 1 && l.price > 1;
  const lockSet = new Set(locked);
  const lockedLegs = legs.filter(l => lockSet.has(l.id));
  const lockGroups = new Set(lockedLegs.map(l => l.group));
  if (lockGroups.size < lockedLegs.length) return none('locked-group');
  if (lockedLegs.length > n) return none('locked-count');
  if (!lockedLegs.every(ok)) return none('locked-leg');
  const prep = l => ({ ...l, game: l.game ?? l.group, lp: Math.log(l.price), x: l.p * l.price });
  const pool = legs.filter(ok).map(prep);
  if (!pool.length) return none('few-groups');
  const minLp = Math.min(...pool.map(l => l.lp)), maxLp = Math.max(...pool.map(l => l.lp));
  const C = binom(n, K);
  const scale = 1 - Math.exp(-U);   // a combo pays at most its price less 1: x_c (1 - 1 / price)

  // The log prices a leg can have, given those chosen (S, ascending): every
  // combo it will be in has K - 1 others, at least the chosen ones' smallest
  // (or, while too few are chosen, the cheapest leg there is) and at most
  // their largest - so the K largest stay under U and the K smallest over L
  // With n >= 2K - 1 legs, the K dearest are each at least L / K (the K-th
  // cheapest is, and they are dearer) and the K cheapest at most U / K: the
  // others in a leg's dearest and cheapest combos are that far in, at least.
  const padLo = n >= 2 * K - 1 ? Math.max(minLp, L / K) : minLp;
  const padHi = n >= 2 * K - 1 ? Math.min(maxLp, U / K) : maxLp;
  const range = S => {
    const m = S.length, j = Math.min(m, K - 1), pad = K - 1 - j;
    let small = 0, large = 0;
    for (let i = 0; i < j; i++) { small += S[i]; large += S[m - 1 - i]; }
    return [L - small - pad * padHi - 1e-9, U - large - pad * padLo + 1e-9];
  };
  const insert = (S, t) => { const out = [...S]; let i = out.length; while (i > 0 && out[i - 1] > t) i--; out.splice(i, 0, t); return out; };
  const gameCount = new Map(), soloGames = new Set();
  const free = l => !soloGames.has(l.game) && !(l.solo && gameCount.get(l.game));
  const add = l => { gameCount.set(l.game, (gameCount.get(l.game) || 0) + 1); if (l.solo) soloGames.add(l.game); };
  const remove = l => { gameCount.set(l.game, gameCount.get(l.game) - 1); if (l.solo) soloGames.delete(l.game); };

  // The locked legs first: they must fit the window together
  let S = [], eX = elemSym([], K), eP = elemSym([], K);
  for (const l of lockedLegs.map(prep)) {
    const [lo, hi] = range(S);
    if (l.lp < lo || l.lp > hi || !free(l)) return none('locked-window');
    add(l);
    S = insert(S, l.lp);
    eX = push(eX, l.x);
    eP = push(eP, l.p);
  }
  const [lo0, hi0] = range([]);
  const byGroup = new Map();
  for (const l of pool) {
    if (lockSet.has(l.id) || lockGroups.has(l.group) || l.lp < lo0 || l.lp > hi0) continue;
    if (!byGroup.has(l.group)) byGroup.set(l.group, []);
    byGroup.get(l.group).push(l);
  }
  // Groups by their best leg priced near the window's K-th root (where most
  // of a set's legs are), so the search meets good sets early; legs best first
  const w = (U - L) / K, near = ls => Math.max(0, ...ls.filter(l => l.lp * K >= L - K * w && l.lp * K <= U + K * w).map(l => l.x));
  const groups = [...byGroup.values()].map(ls => ls.sort((a, b) => b.x - a.x))
    .map(ls => [near(ls), ls]).sort((a, b) => b[0] - a[0] || b[1][0].x - a[1][0].x).map(([, ls]) => ls);
  const ranges = groups.map(rangeIndex);
  const G = groups.length, r0 = n - lockedLegs.length;
  if (G < r0) return { ...none('few-groups'), groups: G };
  // The r0 highest x of the groups from g on, one each
  const sufX = [];
  for (let g = 0; g <= G; g++) sufX[g] = groups.slice(g).map(ls => ls[0].x).sort((a, b) => b - a).slice(0, r0);

  const best = [];
  let nodes = 0, complete = true;
  const toBeat = () => (best.length < top ? -Infinity : best[best.length - 1].ev * (1 + gap));
  // The most the r legs left could make. The cash is sum(x_c) - sum(p_c)
  // over the combos, and both sums rise with every leg's x and p: so at most
  // the r highest x left (one a group), then - unless that already falls
  // short - the r highest x left at a price the window allows less the r
  // lowest chances there. And as a combo pays its price less 1, at most the
  // sum of x_c times 1 - 1 / the window's top.
  // In a set in the window at most K - 1 legs are dearer than U / K (the K
  // dearest add up to U at most, so the K-th dearest is at most U / K) and at
  // most K - 1 cheaper than L / K: so of the legs left, only that many less
  // those chosen already can come from either side of the band between.
  const bandLo = L / K, bandHi = U / K;
  const bound = (g, r, S, eXc, ePc) => {
    if (sufX[g].length < r) return -Infinity;
    let e = eXc;
    for (let i = 0; i < r; i++) e = push(e, sufX[g][i]);
    const quick = scale * e[K] / C;
    if (quick <= toBeat()) return quick;
    const [lo, hi] = range(S);
    let qa = K - 1, qb = K - 1;
    for (const t of S) { if (t > bandHi + 1e-9) qa--; else if (t < bandLo - 1e-9) qb--; }
    if (qa < 0 || qb < 0) return -Infinity;
    // The r highest x (and lowest chances) in the band, and the qa / qb
    // highest (lowest) either side, kept as they come
    const xs = [], ps = [], aX = [], aP = [], bX = [], bP = [];
    let any = 0;
    for (let h = g; h < G; h++) {
      const ix = ranges[h];
      const mid = rangeQuery(ix, Math.max(lo, bandLo - 1e-9), Math.min(hi, bandHi + 1e-9));
      const above = qa > 0 && rangeQuery(ix, Math.max(lo, bandHi - 1e-9), hi);
      const below = qb > 0 && rangeQuery(ix, lo, Math.min(hi, bandLo + 1e-9));
      if (mid) { topIn(xs, mid[0], r, 1); topIn(ps, mid[1], r, -1); }
      if (above) { topIn(aX, above[0], qa, 1); topIn(aP, above[1], qa, -1); }
      if (below) { topIn(bX, below[0], qb, 1); topIn(bP, below[1], qb, -1); }
      if (mid || above || below) any++;
    }
    if (any < r) return -Infinity;
    for (const v of aX) topIn(xs, v, r, 1);
    for (const v of bX) topIn(xs, v, r, 1);
    for (const v of aP) topIn(ps, v, r, -1);
    for (const v of bP) topIn(ps, v, r, -1);
    if (xs.length < r) return -Infinity;
    let ex = eXc, ep = ePc;
    for (let i = 0; i < r; i++) { ex = push(ex, xs[i]); ep = push(ep, ps[i]); }
    return Math.min(scale * ex[K], ex[K] - ep[K]) / C;
  };
  const keep = (chosen, eXf, ePf) => {
    const legsNow = [...lockedLegs, ...chosen].map(({ lp, x, ...l }) => l);
    const res = { legs: legsNow, ev: (eXf[K] - ePf[K]) / C, sig: legsNow.map(l => l.sig ?? l.id).sort().join('\n') };
    const twin = best.findIndex(b => b.sig === res.sig);
    if (twin >= 0) {
      if (res.ev <= best[twin].ev) return;
      best.splice(twin, 1);
    }
    let i = best.length;
    while (i > 0 && res.ev > best[i - 1].ev) i--;
    if (i >= top) return;
    best.splice(i, 0, res);
    if (best.length > top) best.pop();
  };
  // A start, so the search cuts from the first: the same search over each
  // group's best leg in each of PREPASS_BUCKETS price bands across the prices
  // a leg can have, on a quarter of the budget
  if (prepass) {
    const bucket = l => Math.min(PREPASS_BUCKETS - 1, Math.floor((l.lp - lo0) / (hi0 - lo0 + 1e-12) * PREPASS_BUCKETS));
    const few = groups.flatMap(ls => [...new Map([...ls].reverse().map(l => [bucket(l), l])).values()]);
    if (few.length < groups.flat().length) {
      const first = searchCombos([...lockedLegs, ...few], { n, K, L, U, top, locked, budget: budget / 4, prepass: false });
      nodes += first.nodes;
      for (const res of first.results) {
        let ex = eX, ep = eP;
        const set = res.legs.filter(l => !lockSet.has(l.id)).map(prep);
        for (const l of set) { ex = push(ex, l.x); ep = push(ep, l.p); }
        keep(set, ex, ep);
      }
    }
  }

  const chosen = [];
  const dfs = (g, r, eXc, ePc, Sc) => {
    if (++nodes > budget) { complete = false; return; }
    if (r === 0) {
      let small = 0, large = 0;
      for (let i = 0; i < K; i++) { small += Sc[i]; large += Sc[Sc.length - 1 - i]; }
      if (small >= L - 1e-9 && large <= U + 1e-9) keep(chosen, eXc, ePc);
      return;
    }
    if (G - g < r) return;
    if (bound(g, r, Sc, eXc, ePc) <= toBeat()) return;
    const [lo, hi] = range(Sc);
    for (const l of groups[g]) {
      if (l.lp < lo || l.lp > hi || !free(l)) continue;
      add(l);
      chosen.push(l);
      dfs(g + 1, r - 1, push(eXc, l.x), push(ePc, l.p), insert(Sc, l.lp));
      chosen.pop();
      remove(l);
      if (!complete) return;
    }
    dfs(g + 1, r, eXc, ePc, Sc);   // nothing from this group
  };
  dfs(0, r0, eX, eP, S);
  return { results: best, complete, nodes, groups: G };
}

// --- a set's combos and what they return ------------------------------------------

// The chances of each way a game's legs can finish from the chances that
// subsets of them all win: J(mask) (bit j: the j-th leg; J(0) = 1) ->
// table[mask], the chance exactly those win (inclusion-exclusion)
export function patternTable(m, J) {
  const f = new Float64Array(1 << m);
  for (let t = 0; t < 1 << m; t++) f[t] = t ? J(t) : 1;
  for (let j = 0; j < m; j++) {
    for (let t = 0; t < 1 << m; t++) if (!(t & (1 << j))) f[t] -= f[t | (1 << j)];
  }
  for (let t = 0; t < f.length; t++) f[t] = Math.max(0, f[t]);
  return f;
}

// A set of independent legs' combos: { mask, price, p, sgm: false }
export function independentCombos(legs, K) {
  return comboMasks(legs.length, K).map(mask => {
    let price = 1, p = 1;
    legs.forEach((l, i) => { if (mask & (1 << i)) { price *= l.price; p *= l.p; } });
    return { mask, price, p, sgm: false };
  });
}

// Sets whose combos may hold legs of one game, priced from the game's model:
// jointOf(legs of one game) -> the model's chance they all win, or null when
// it can't price them. Each leg carries pModel (the model's own chance, the
// joint's marginal) and p (its chance, the model's or the calibrated one: the
// joint is rescaled to it keeping the model's correlation). A combo's legs of
// one game are priced as the bookie's Same Game Multi would be at the model's
// correlation (sgmPrice). A set is kept only if every combo's log price is in
// [L, U] and every same-game part is priced.
// -> { sets: [{ legs, ev, combos, parts }], dropped: { window, unpriced } }
export function priceSets(sets, { K, L, U, jointOf }) {
  const memo = new Map();
  const joint = ls => {
    const key = ls.map(l => l.id).sort().join('\n');
    if (!memo.has(key)) memo.set(key, jointOf(ls));
    return memo.get(key);
  };
  const out = [], dropped = { window: 0, unpriced: 0 };
  for (const set of sets) {
    const legs = set.legs;
    const byGame = new Map();
    legs.forEach((l, i) => {
      const g = l.game ?? l.group;
      if (!byGame.has(g)) byGame.set(g, []);
      byGame.get(g).push(i);
    });
    // A game with 2+ legs: its legs' joint chances, the model's (jm) and at
    // the legs' own chances (jp), by subset of its legs (bit j: idx[j])
    const parts = [];
    let unpriced = false;
    for (const idx of byGame.values()) {
      if (idx.length < 2) continue;
      const ls = idx.map(i => legs[i]);
      const pModel = ls.map(l => l.pModel ?? l.p), p = ls.map(l => l.p);
      const jmMemo = new Map();
      const jm = mask => {
        if (!jmMemo.has(mask)) {
          const sub = ls.filter((_, j) => mask & (1 << j));
          jmMemo.set(mask, sub.length === 1 ? pModel[ls.indexOf(sub[0])] : joint(sub));
        }
        return jmMemo.get(mask);
      };
      for (let t = 1; t < 1 << idx.length; t++) if (!(jm(t) > 0)) { unpriced = true; break; }
      if (unpriced) break;
      const jp = rescaledJoint(jm, pModel, p);
      parts.push({ idx, jm, jp, pModel, table: patternTable(idx.length, jp) });
    }
    if (unpriced) { dropped.unpriced++; continue; }
    const inPart = new Set(parts.flatMap(pt => pt.idx));
    const combos = [];
    let inWindow = true;
    for (const mask of comboMasks(legs.length, K)) {
      let price = 1, p = 1, sgm = false;
      legs.forEach((l, i) => { if (mask & (1 << i) && !inPart.has(i)) { price *= l.price; p *= l.p; } });
      for (const pt of parts) {
        let sub = 0, product = 1;
        pt.idx.forEach((i, j) => { if (mask & (1 << i)) { sub |= 1 << j; product *= legs[i].price; } });
        if (!sub) continue;
        if (popcount(sub) === 1) { price *= product; p *= pt.jp(sub); continue; }
        const pm = pt.pModel.filter((_, j) => sub & (1 << j));
        price *= sgmPrice(product, pt.jm(sub), pm);
        p *= pt.jp(sub);
        sgm = true;
      }
      const lp = Math.log(price);
      if (!(lp >= L - 1e-9 && lp <= U + 1e-9)) { inWindow = false; break; }
      combos.push({ mask, price, p, sgm });
    }
    if (!inWindow) { dropped.window++; continue; }
    const ev = combos.reduce((s, c) => s + c.p * (c.price - 1), 0) / combos.length;
    out.push({ ...set, legs, ev, combos, parts: parts.map(({ idx, table }) => ({ idx, table })) });
  }
  out.sort((a, b) => b.ev - a.ev);
  return { sets: out, dropped };
}

// What a set's combos return, per unit of bonus (each of the C combos staked
// 1 / C), over every way its legs can finish: legs independent but for each
// part's (priceSets': { idx, table }). The expected cash (ev), the chance of
// none winning (pNothing), the 10th / 50th / 90th percentiles of the cash, and
// the cheapest and dearest combo.
export function comboStats(legs, combos, parts = []) {
  const n = legs.length, W = 1 << n, C = combos.length;
  const inPart = new Set(parts.flatMap(pt => pt.idx));
  const indep = legs.map((_, i) => i).filter(i => !inPart.has(i));
  const K = popcount(combos[0]?.mask || 0);
  const fast = !parts.length && combos.every(c => !c.sgm);
  const prices = legs.map(l => l.price);
  const prob = new Float64Array(W), cash = new Float64Array(W);
  for (let w = 0; w < W; w++) {
    let pr = 1;
    for (const i of indep) pr *= w & (1 << i) ? legs[i].p : 1 - legs[i].p;
    for (const pt of parts) {
      let sub = 0;
      pt.idx.forEach((i, j) => { if (w & (1 << i)) sub |= 1 << j; });
      pr *= pt.table[sub];
    }
    prob[w] = pr;
    let c = 0;
    if (fast) {
      const won = prices.filter((_, i) => w & (1 << i));
      if (won.length >= K) c = elemSym(won, K)[K] - binom(won.length, K);
    } else {
      for (const cb of combos) if ((cb.mask & w) === cb.mask) c += cb.price - 1;
    }
    cash[w] = c / C;
  }
  let ev = 0, pNothing = 0, total = 0;
  for (let w = 0; w < W; w++) {
    total += prob[w];
    ev += prob[w] * cash[w];
    if (cash[w] <= 1e-12) pNothing += prob[w];
  }
  const order = Array.from({ length: W }, (_, w) => w).sort((a, b) => cash[a] - cash[b]);
  const at = q => {
    let run = 0;
    for (const w of order) { run += prob[w] / total; if (run >= q - 1e-12) return cash[w]; }
    return cash[order[W - 1]];
  };
  const ps = combos.map(c => c.price);
  return { ev: ev / total, pNothing: pNothing / total, p10: at(0.1), median: at(0.5), p90: at(0.9),
           lo: Math.min(...ps), hi: Math.max(...ps), total };
}

// The orders the page can show combos in: 'ev', the expected cash, highest
// first (the search's order), or 'nothing', the chance none wins, lowest first
export const COMBO_RANKS = ['ev', 'nothing'];
export const comboComparer = by => (by === 'nothing'
  ? (a, b) => a.stats.pNothing - b.stats.pNothing || b.stats.ev - a.stats.ev
  : (a, b) => b.stats.ev - a.stats.ev || a.stats.pNothing - b.stats.pNothing);
