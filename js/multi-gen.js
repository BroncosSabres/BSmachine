// multi-gen.js — the Best Bets page's Multi Generator maths. No DOM, so it
// runs in multi-gen-worker.js and under Node.
//
// An insurance multi: n legs; it pays the multi's price when all n win, and
// the stake back (a bonus bet, often capped) when at least k win but not all.
// Multis are ranked by the chance of losing the stake outright - fewer than
// k legs win, so neither the multi nor the insurance pays: P(W < k), W the
// number of legs that win - lowest first, among those whose total price
// reaches the minimum asked.
//
// A leg here is { id, group, price, p, sig }: group, at most one leg each
// (the game, for a regular multi; a Same Game Multi's market family); price,
// the chosen bookie's; p, the chance it wins (the model's or the calibrated
// one); sig, the bet whatever its line (an alternate line is the same bet):
// multis that differ only in a leg's line are listed once.
// Regular multis' legs are independent, so W is exactly Poisson-binomial.
// Same Game Multis are scored from the joint chances of their legs
// (exactInsurance), from the Multi Builders' engines (sgm-legs.js).

// The chance that exactly j of the legs win, j = 0..n, legs independent
export function hitDist(ps) {
  let d = new Float64Array([1]);
  for (const p of ps) d = extend(d, p);
  return d;
}

function extend(dist, p) {
  const d = new Float64Array(dist.length + 1);
  for (let j = 0; j < dist.length; j++) {
    d[j] += dist[j] * (1 - p);
    d[j + 1] += dist[j] * p;
  }
  return d;
}

// A hit distribution's insurance chances. pAll: every leg wins (the multi
// pays); pIns: at least k but not all (the stake back); pLose: neither;
// cond: pIns / (1 - pAll), the chance the insurance pays when the multi loses
export function insuranceOf(dist, k) {
  const n = dist.length - 1;
  const pAll = dist[n];
  let pIns = 0;
  for (let j = Math.max(0, k); j < n; j++) pIns += dist[j];
  return chances(pAll, pIns);
}

function chances(pAll, pIns) {
  pAll = Math.min(1, Math.max(0, pAll));
  pIns = Math.min(1 - pAll, Math.max(0, pIns));
  return { pAll, pIns, pLose: Math.max(0, 1 - pAll - pIns), cond: pAll < 1 ? pIns / (1 - pAll) : 0 };
}

// What the refund is worth per unit staked: the stake back up to the cap, a
// bonus bet counted at its value (bonusPct of face: (1 + edge) x (1 - 1 /
// odds) where it is bet, so over 100 for a bettor with an edge at long odds),
// cash in full. { stake, cap, refund: 'bonus' | 'cash', bonusPct } as typed.
export function refundRate({ stake, cap, refund = 'bonus', bonusPct = 75 } = {}) {
  const s = +stake > 0 ? +stake : 1;
  const back = +cap > 0 ? Math.min(s, +cap) : s;
  const worth = refund === 'cash' ? 1 : Math.max(0, +bonusPct || 0) / 100;
  return back / s * worth;
}

// Expected return per unit staked: the multi's price when all win, the
// refund's worth when the insurance pays
export const evOf = (price, m, rate) => price * m.pAll + rate * m.pIns - 1;

// What the searches look for: the least chance of losing the stake, ties to
// the higher EV
const better = (a, b) => a.pLose - b.pLose || b.ev - a.ev;

// The orders the page can show results in (Sort by): 'lose', the chance of
// losing the stake, lowest first (the searches' order), or 'ev', highest
// first. Ties go to the other.
export const RANKS = ['lose', 'ev'];
export const comparer = by => (by === 'ev' ? (a, b) => b.ev - a.ev || a.pLose - b.pLose : better);

// Per group, only the legs no other leg of it beats on both chance and price:
// swapping one for a leg with a higher chance and price never raises the
// chance of losing the stake (at least k winning gets likelier with every
// leg's chance) or lowers the total price. Legs sorted by chance, highest first.
export function paretoGroups(legs) {
  const by = new Map();
  for (const l of legs) {
    if (!by.has(l.group)) by.set(l.group, []);
    by.get(l.group).push(l);
  }
  const out = [];
  for (const [group, xs] of by) {
    xs.sort((a, b) => b.price - a.price || b.p - a.p);
    const kept = [];
    let top = -1;
    for (const l of xs) if (l.p > top) { kept.push(l); top = l.p; }
    kept.sort((a, b) => b.p - a.p);
    out.push({ group, legs: kept, maxP: kept[0].p, maxLog: Math.log(Math.max(...kept.map(l => l.price))) });
  }
  return out;
}

// The best `top` multis of n independent legs, at most one per group, the
// locked legs in every one, the total price at least minTotal. Exact
// branch and bound over the groups: a branch is cut when even the highest
// prices left can't reach minTotal, or when even the highest chances left
// can't beat the top-th best so far (the chance of losing the stake falls
// with every leg's chance, so that is a bound). budget caps the nodes
// visited: complete is false when it ran out (the best found so far). rate:
// refundRate, for the EV.
// -> { results: [{ legs, price, pAll, pIns, pLose, cond, ev }], complete, nodes, groups }
export function searchIndependent(legs, { n, k, minTotal = 1, top = 10, locked = [], rate = 0, budget = 2e6 } = {}) {
  const none = reason => ({ results: [], complete: true, nodes: 0, groups: 0, reason });
  const lockSet = new Set(locked);
  const lockedLegs = legs.filter(l => lockSet.has(l.id));
  const lockGroups = new Set(lockedLegs.map(l => l.group));
  if (lockGroups.size < lockedLegs.length) return none('locked-group');
  if (lockedLegs.length > n) return none('locked-count');
  const ok = l => l.p > 0 && l.p < 1 && l.price > 1;
  if (!lockedLegs.every(ok)) return none('locked-leg');
  const free = legs.filter(l => !lockSet.has(l.id) && !lockGroups.has(l.group) && ok(l));
  const groups = paretoGroups(free).sort((a, b) => b.maxP - a.maxP);
  const G = groups.length, r0 = n - lockedLegs.length;
  if (G < r0) return { ...none('few-groups'), groups: G };

  // For the groups from g on: the sums of the r highest log prices, the r
  // highest chances (one each), r = 0..r0, and every leg by log price,
  // highest first, with the highest chance at that log price or more (atLeast)
  const sufLog = [], sufP = [], sufLegs = [];
  for (let g = 0; g <= G; g++) {
    const rest = groups.slice(g);
    const logs = rest.map(x => x.maxLog).sort((a, b) => b - a).slice(0, r0);
    sufLog[g] = logs.reduce((acc, x) => (acc.push(acc.at(-1) + x), acc), [0]);
    sufP[g] = rest.map(x => x.maxP).sort((a, b) => b - a).slice(0, r0);
    const byLog = rest.flatMap(x => x.legs).map(l => [Math.log(l.price), l.p]).sort((a, b) => b[0] - a[0]);
    let run = 0;
    sufLegs[g] = { lp: byLog.map(x => x[0]), atLeast: byLog.map(x => (run = Math.max(run, x[1]))), maxLog: byLog[0]?.[0] ?? 0 };
  }
  // The highest chance among the legs from group g on priced at log price t or more
  const capAt = (g, t) => {
    const { lp, atLeast } = sufLegs[g];
    let lo = 0, hi = lp.length;   // the legs with lp >= t are [0, lo)
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lp[mid] >= t) lo = mid + 1; else hi = mid; }
    return lo ? atLeast[lo - 1] : 0;
  };
  const need = Math.log(minTotal) - 1e-9;
  const best = [];
  let nodes = 0, complete = true;
  // The top-th best's chance of losing the stake: a branch must beat it
  const toBeat = () => (best.length < top ? Infinity : best[best.length - 1].pLose);
  // The chance of losing the stake falls with every leg's chance, so the
  // highest chances the last r legs could have bound it from below: the r
  // highest of the groups left, and, to make up the price still needed (L),
  // legs priced high enough - the j-th dearest of them at log price
  // (L - (j-1) maxLog) / (r - j + 1) or more. The tighter of the two.
  const bound = (dist, g, r, logP) => {
    let d = dist;
    for (let i = 0; i < r; i++) d = extend(d, sufP[g][i]);
    const byChance = insuranceOf(d, k).pLose;
    const L = need - logP;
    if (!(L > 0)) return byChance;
    d = dist;
    for (let j = 1; j <= r; j++) d = extend(d, capAt(g, (L - (j - 1) * sufLegs[g].maxLog) / (r - j + 1)));
    return Math.max(byChance, insuranceOf(d, k).pLose);
  };
  // Multis that differ only in a leg's line (the same bets, by sig) count
  // once, at their best: the list is of different multis. A cut branch still
  // can't change it - it can't beat the top-th best, nor so any one listed.
  const keep = (chosen, dist, logP) => {
    const m = insuranceOf(dist, k);
    const price = Math.exp(logP);
    const legsNow = [...lockedLegs, ...chosen];
    const res = { legs: legsNow, sig: legsNow.map(l => l.sig ?? l.id).sort().join('\n'), price, ...m, ev: evOf(price, m, rate) };
    const twin = best.findIndex(b => b.sig === res.sig);
    if (twin >= 0) {
      if (better(res, best[twin]) >= 0) return;
      best.splice(twin, 1);
    }
    let i = best.length;
    while (i > 0 && better(res, best[i - 1]) < 0) i--;
    if (i >= top) return;
    best.splice(i, 0, res);
    if (best.length > top) best.pop();
  };
  const chosen = [];
  const dfs = (g, r, dist, logP) => {
    if (++nodes > budget) { complete = false; return; }
    if (r === 0) { if (logP >= need) keep(chosen, dist, logP); return; }
    if (G - g < r || logP + sufLog[g][r] < need) return;
    if (bound(dist, g, r, logP) >= toBeat()) return;
    for (const l of groups[g].legs) {
      const lp = Math.log(l.price);
      if (logP + lp + sufLog[g + 1][Math.min(r - 1, sufLog[g + 1].length - 1)] < need) continue;
      chosen.push(l);
      dfs(g + 1, r - 1, extend(dist, l.p), logP + lp);
      chosen.pop();
      if (!complete) return;
    }
    dfs(g + 1, r, dist, logP);   // nothing from this group
  };
  dfs(0, r0, hitDist(lockedLegs.map(l => l.p)), lockedLegs.reduce((s, l) => s + Math.log(l.price), 0));
  return { results: best, complete, nodes, groups: G };
}

// --- Same Game Multis -----------------------------------------------------------

const popcount = x => { let c = 0; for (; x; x &= x - 1) c++; return c; };
export const binom = (n, r) => { let c = 1; for (let i = 1; i <= r; i++) c = c * (n - r + i) / i; return c; };

// Insurance chances from joint chances: joint(mask) is the chance every leg
// in the subset `mask` (bit i: leg i) wins. By inclusion-exclusion over the
// subsets' sums S_m (S_m: over the subsets of m legs),
//   P(W >= k) = sum over m >= k of (-1)^(m-k) C(m-1, k-1) S_m,
// so only subsets of k legs or more are needed.
export function exactInsurance(n, k, joint) {
  const S = new Float64Array(n + 1);
  for (let mask = 1; mask < 1 << n; mask++) {
    const m = popcount(mask);
    if (m >= k) S[m] += joint(mask);
  }
  let atLeast = 0;
  for (let m = Math.max(1, k); m <= n; m++) atLeast += ((m - k) % 2 ? -1 : 1) * binom(m - 1, k - 1) * S[m];
  return chances(S[n], atLeast - S[n]);
}

// A subset's joint chance at other chances for its legs: the model's joint
// times each leg's chance over its model chance, so the model's correlation
// (joint / product of chances) is kept and each leg's own chance matches.
// Capped at the subset's least likely leg.
export function rescaledJoint(jointModel, pModel, p) {
  return mask => {
    let f = 1, cap = 1;
    for (let i = 0; i < p.length; i++) {
      if (!(mask & (1 << i))) continue;
      f *= pModel[i] > 0 ? p[i] / pModel[i] : 0;
      cap = Math.min(cap, p[i]);
    }
    return Math.min(cap, jointModel(mask) * f);
  };
}

// The bookie's Same Game Multi price as the model's correlation would make
// it: the product of the leg prices over the lift (the model's chance all win
// over the product of its leg chances). Positively correlated legs pay less
// than the product, negatively correlated ones more.
export const sgmPrice = (product, pAllModel, pModels) => {
  const indep = pModels.reduce((a, p) => a * p, 1);
  return pAllModel > 0 && indep > 0 ? product * indep / pAllModel : null;
};

// The best `top` Same Game Multis. Stage 1: searchIndependent on the legs'
// own chances, one leg per market family (group), the total price allowed to
// fall short of minTotal by `slack` (correlation can lift the bookie's price
// above the product), keeping the best `shortlist`. Stage 2: each scored from
// joint chances (jointOf(legs) -> the model's chance they all win, memoised
// here by leg ids), priced as the model's correlation makes it (sgmPrice),
// cut to minTotal and ranked again. Legs also carry pModel, the model's own
// chance (the joint's marginal). onProgress(fraction) as stage 2 goes.
export function searchSgm(legs, { n, k, minTotal = 1, top = 10, locked = [], rate = 0, shortlist = 300, slack = 1.5,
                                  budget = 2e6, jointOf, onProgress } = {}) {
  const first = searchIndependent(legs, { n, k, minTotal: minTotal / slack, top: shortlist, locked, rate, budget });
  const memo = new Map();
  const joint = ls => {
    const key = ls.map(l => l.id).sort().join('\n');
    if (!memo.has(key)) memo.set(key, jointOf(ls));
    return memo.get(key);
  };
  const out = [];
  first.results.forEach((c, at) => {
    const ls = c.legs;
    const pModel = ls.map(l => l.pModel ?? l.p), p = ls.map(l => l.p);
    const jm = mask => joint(ls.filter((_, i) => mask & (1 << i)));
    const pAllModel = jm((1 << ls.length) - 1);
    const price = sgmPrice(c.price, pAllModel, pModel);
    if (onProgress && at % 10 === 0) onProgress(at / first.results.length);
    if (price == null || price < minTotal - 1e-9) return;
    const m = exactInsurance(ls.length, k, rescaledJoint(jm, pModel, p));
    out.push({ legs: ls, price, product: c.price, fair: 1 / pAllModel, lift: pAllModel / pModel.reduce((a, x) => a * x, 1),
               ...m, ev: evOf(price, m, rate) });
  });
  out.sort(better);
  return { results: out.slice(0, top), complete: first.complete, nodes: first.nodes, groups: first.groups,
           scored: first.results.length, joints: memo.size, reason: first.reason };
}
