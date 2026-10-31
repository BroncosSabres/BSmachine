// multi-system.js — the Multi Generator's system multis. No DOM, so it runs in
// multi-gen-worker.js and under Node.
//
// A system multi of N legs: a bet on every combination of k of them for each
// size k chosen (doubles, trebles, ..., the N-fold), one stake per combo at
// each size, as a bookie's betslip takes them. The stakes are Kelly's: the
// share of the bank on each combo of each size that grows the bank fastest
// (the expected log of the bank after), over every way the legs can finish
// (2^N, legs independent: one a game), at the cautious chances the Stake
// column stakes on. The page takes a fraction of them (the Risk level's), or
// spreads a set amount in the same proportions.
//
// With every size from singles up, Kelly's stakes are those of betting the
// legs one after another at Kelly (a combo of the legs S staked
// prod(f_i, i in S) x prod(1 - f_j, j not in S)), and the growth is the legs'
// own growths added up. That is how legs are shortlisted (searchSystem).
//
// A leg here is { id, group, sig, price, p, pStake }: p, its chance (the
// judge's, for EV and the chances shown); pStake, the cautious chance the
// stakes are worked out on.
import { binom } from './multi-gen.js';
import { elemSym } from './multi-combos.js';

export const MAX_SYSTEM_LEGS = 10;

// A bet's growth at full Kelly: the expected log of the bank after it
export const legGrowth = (p, o) => (p > 0 && p < 1 && p * o > 1 ? p * Math.log(p * o) + (1 - p) * Math.log((1 - p) * o / (o - 1)) : 0);

// Every way the legs can finish (w, bit i: leg i won): its chance, how many
// won, and per size in ks what a unit on each combo of that size pays back in
// all (e_k of the winners' prices)
export function outcomes(prices, ps, ks) {
  const n = prices.length, W = 1 << n, K = Math.max(1, ...ks);
  const prob = new Float64Array(W), wins = new Uint8Array(W), pay = ks.map(() => new Float64Array(W));
  for (let w = 0; w < W; w++) {
    let pr = 1;
    const won = [];
    for (let i = 0; i < n; i++) {
      if (w & (1 << i)) { pr *= ps[i]; won.push(prices[i]); } else pr *= 1 - ps[i];
    }
    prob[w] = pr;
    wins[w] = won.length;
    const e = elemSym(won, K);
    ks.forEach((k, j) => { pay[j][w] = e[k]; });
  }
  return { prob, wins, pay };
}

// Solve A x = b (A small, symmetric positive definite in use), or null
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (!(Math.abs(M[piv][c]) > 1e-300)) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Kelly's stake per combo at each size in ks, as shares of the bank, for legs
// at `prices` winning with chances `ps` (independent): the s >= 0 maximising
// E[log(1 + sum_k s_k (pay_k - C(n, k)))]. Concave, so a projected Newton
// ascent with a step halved until the growth rises (every bank after stays
// above 0) finds it. -> { s, growth, counts }
export function kellyLevels(prices, ps, ks) {
  const n = prices.length, d = ks.length;
  const { prob, pay } = outcomes(prices, ps, ks);
  const counts = ks.map(k => Math.round(binom(n, k)));
  const W = prob.length;
  const a = ks.map((_, j) => pay[j].map(x => x - counts[j]));   // per unit on each combo of the size
  const bank = s => {
    const v = new Float64Array(W).fill(1);
    for (let j = 0; j < d; j++) if (s[j]) for (let w = 0; w < W; w++) v[w] += s[j] * a[j][w];
    return v;
  };
  const growthOf = v => {
    let g = 0;
    for (let w = 0; w < W; w++) {
      if (!prob[w]) continue;
      if (!(v[w] > 0)) return -Infinity;
      g += prob[w] * Math.log(v[w]);
    }
    return g;
  };
  let s = new Float64Array(d), v = bank(s), g = 0;
  for (let it = 0; it < 200; it++) {
    const grad = new Float64Array(d), H = Array.from({ length: d }, () => new Float64Array(d));
    for (let w = 0; w < W; w++) {
      if (!prob[w]) continue;
      const q = prob[w] / v[w], q2 = q / v[w];
      for (let j = 0; j < d; j++) {
        const aj = a[j][w];
        grad[j] += q * aj;
        for (let l = 0; l <= j; l++) H[j][l] -= q2 * aj * a[l][w];
      }
    }
    const free = [];
    for (let j = 0; j < d; j++) if (s[j] > 1e-15 || grad[j] > 1e-12) free.push(j);
    if (!free.length) break;
    const negH = free.map(j => free.map(l => -(j >= l ? H[j][l] : H[l][j]) + (j === l ? 1e-12 : 0)));
    const newton = solve(negH, free.map(j => grad[j]));
    let moved = false;
    for (const dir of [newton, free.map(j => grad[j])]) {
      if (!dir) continue;
      for (let t = 1, tries = 0; tries < 60; tries++, t /= 2) {
        const s2 = Float64Array.from(s);
        free.forEach((j, i) => { s2[j] = Math.max(0, s[j] + t * dir[i]); });
        const v2 = bank(s2), g2 = growthOf(v2);
        if (g2 > g) {
          const step = Math.max(...s2.map((x, j) => Math.abs(x - s[j])));
          const gain = g2 - g;
          s = s2; v = v2; g = g2;
          moved = step > 1e-13 && gain > 1e-16;
          break;
        }
      }
      if (moved) break;
    }
    if (!moved) break;
  }
  return { s: [...s], growth: g, counts };
}

// What stakes s per combo (one per size in ks) do, at chances ps: per $1
// staked in all, the expected profit (ev), the chance of a profit, of nothing
// back at all, and the 10th / 50th / 90th percentiles of the profit; and per
// size its expected return per $1 (ev) and the chance any of its combos wins.
export function systemStats(prices, ps, ks, s) {
  const n = prices.length;
  const { prob, wins, pay } = outcomes(prices, ps, ks);
  const counts = ks.map(k => Math.round(binom(n, k)));
  const total = ks.reduce((t, _, j) => t + s[j] * counts[j], 0);
  const xs = prices.map((o, i) => o * ps[i]);
  const ex = elemSym(xs, Math.max(1, ...ks));
  const levels = ks.map((k, j) => {
    let pReturn = 0;
    for (let w = 0; w < prob.length; w++) if (wins[w] >= k) pReturn += prob[w];
    return { k, count: counts[j], s: s[j], ev: ex[k] / counts[j] - 1, pReturn };
  });
  if (!(total > 0)) return { total: 0, levels, ev: null, pProfit: 0, pNothing: 1, p10: null, median: null, p90: null };
  const W = prob.length, profit = new Float64Array(W);
  let ev = 0, pProfit = 0, pNothing = 0;
  for (let w = 0; w < W; w++) {
    let back = 0;
    for (let j = 0; j < ks.length; j++) back += s[j] * pay[j][w];
    profit[w] = (back - total) / total;
    ev += prob[w] * profit[w];
    if (profit[w] > 1e-12) pProfit += prob[w];
    if (back <= 1e-15) pNothing += prob[w];
  }
  const order = Array.from({ length: W }, (_, w) => w).sort((a, b) => profit[a] - profit[b]);
  const at = q => {
    let run = 0;
    for (const w of order) { run += prob[w]; if (run >= q - 1e-12) return profit[w]; }
    return profit[order[W - 1]];
  };
  return { total, levels, ev, pProfit, pNothing, p10: at(0.1), median: at(0.5), p90: at(0.9) };
}

// The best `top` system multis of n legs, one per group, the locked legs in
// every one, over the sizes ks. Sets are shortlisted by their legs' growths
// added up (exact branch and bound: the best `shortlist` by that, sets that
// differ only in a leg's line once), then each is staked by kellyLevels at the
// cautious chances and ranked by the growth that makes.
// -> { results: [{ legs, s, growth, stats }], groups, reason }
export function searchSystem(legs, { n, ks, top = 10, locked = [], shortlist = 30 } = {}) {
  const none = reason => ({ results: [], groups: 0, reason });
  const ok = l => l.p > 0 && l.p < 1 && l.price > 1;
  const lockSet = new Set(locked);
  const lockedLegs = legs.filter(l => lockSet.has(l.id));
  const lockGroups = new Set(lockedLegs.map(l => l.group));
  if (lockGroups.size < lockedLegs.length) return none('locked-group');
  if (lockedLegs.length > n) return none('locked-count');
  if (!lockedLegs.every(ok)) return none('locked-leg');
  const growthOf = l => legGrowth(l.pStake ?? 0, l.price);
  const byGroup = new Map();
  for (const l of legs) {
    if (lockSet.has(l.id) || lockGroups.has(l.group) || !ok(l)) continue;
    const g = growthOf(l);
    if (!(g > 0)) continue;
    if (!byGroup.has(l.group)) byGroup.set(l.group, []);
    byGroup.get(l.group).push({ l, g });
  }
  const groups = [...byGroup.values()].map(xs => xs.sort((a, b) => b.g - a.g)).sort((a, b) => b[0].g - a[0].g);
  const G = groups.length, r0 = n - lockedLegs.length;
  if (G < r0) return { ...none('few-groups'), groups: G };
  const best = [];
  const keep = (chosen, score) => {
    const ls = [...lockedLegs, ...chosen];
    const sig = ls.map(l => l.sig ?? l.id).sort().join('\n');
    const twin = best.findIndex(b => b.sig === sig);
    if (twin >= 0) {
      if (score <= best[twin].score) return;
      best.splice(twin, 1);
    }
    let i = best.length;
    while (i > 0 && score > best[i - 1].score) i--;
    if (i >= shortlist) return;
    best.splice(i, 0, { legs: ls, sig, score });
    if (best.length > shortlist) best.pop();
  };
  const chosen = [];
  // The most r legs from group g on can add: the groups are best first
  const sufR = (g, r) => groups.slice(g, g + r).reduce((t, xs) => t + xs[0].g, 0);
  const dfs = (g, r, score) => {
    if (r === 0) { keep(chosen, score); return; }
    if (G - g < r) return;
    if (best.length >= shortlist && score + sufR(g, r) <= best[best.length - 1].score) return;
    for (const { l, g: lg } of groups[g]) {
      chosen.push(l);
      dfs(g + 1, r - 1, score + lg);
      chosen.pop();
    }
    dfs(g + 1, r, score);
  };
  dfs(0, r0, lockedLegs.reduce((t, l) => t + growthOf(l), 0));
  const results = best.map(({ legs: ls }) => {
    const prices = ls.map(l => l.price);
    const k = kellyLevels(prices, ls.map(l => Math.min(0.999999, Math.max(1e-6, l.pStake ?? 1 / l.price))), ks);
    return { legs: ls, s: k.s, growth: k.growth, stats: systemStats(prices, ls.map(l => l.p), ks, k.s) };
  });
  results.sort((a, b) => b.growth - a.growth || (b.stats.ev ?? -Infinity) - (a.stats.ev ?? -Infinity));
  return { results: results.slice(0, top), groups: G, shortlisted: best.length };
}

// The orders the page can show system multis in: 'growth' (Kelly's, the
// search's order) or 'ev', highest first
export const SYSTEM_RANKS = ['growth', 'ev'];
export const systemComparer = by => (by === 'ev'
  ? (a, b) => (b.stats.ev ?? -Infinity) - (a.stats.ev ?? -Infinity) || b.growth - a.growth
  : (a, b) => b.growth - a.growth || (b.stats.ev ?? -Infinity) - (a.stats.ev ?? -Infinity));

// What bookies call each size
export const sizeName = (k, n) => (k === 1 ? 'Singles' : k === 2 ? 'Doubles' : k === 3 ? 'Trebles' : k === n ? `${k}-fold` : `${k}-folds`);
