// calibrate.js — how far to trust the model against the bookies' price in each
// market, and the calibrated chance and edge that gives every bet. No DOM, so
// it can be exercised under Node, and runs in a Worker for the analysis page's
// heavier parts (calibrate-worker.js).
//
// Per market (sport · kind · bookies or Betfair) the result is fitted with a
// logistic blend of the two chances:
//     logit P(win) = a + c·lm + b·d      lm = logit(market chance)
//                                        d  = logit(model chance) - lm
// the same model as roi-stats.js fitBlend (its bModel = b, bMarket = c - b),
// written so its two terms aren't nearly the same number. b is the model's
// weight: 0 says its disagreements with the market are noise, 1 that they are
// worth their full size, in between that they are worth b of it.
//
// A market's own bets are often few, so each level borrows from the one above
// (all markets -> sport -> market): it is fitted with a prior centred on its
// parent's fit and worth n0 of the parent's bets (empirical Bayes), so a thin
// market sits near its sport's fit and moves off it as its own bets come in.
// The sport and market levels each have their own n0 ({ sport, leaf }),
// chosen by the walk-forward: sports differ far more than markets within one
// (the model earns weight in NHL and not in NFL), and one n0 for both made the
// sports one average of the two when the markets wanted heavy pooling.
//
// The market chance is the bookies' price with their margin taken out: a
// market's sides (safe-stake.js marketKey) priced at the same stage are
// divided by their total of 1 / price; a scorer, or a side priced alone,
// keeps 1 / price (the intercept takes the margin up). Fitted at the close
// (open where a selection was priced once): every selection has one, both
// sides at once, and it is the market at its sharpest, so the model's weight
// there is if anything an understatement earlier on.
//
// Intervals are cluster-robust by game (bets in one game win and lose
// together). The walk-forward test fits on the days before each day and
// scores that day: out-of-sample log loss against a market-only fit, and the
// return of betting the calibrated edge (and other rules) at the average price
// while each bet showed value.
import { kindKey, marketKey, sourceKey, toBet } from './safe-stake.js';
import { onePerMarket } from './roi-stats.js';

export const N0_GRID = [30, 100, 300, 1000, 3000, 10000, 30000];       // the market level's
export const N0_SPORT_GRID = [30, 300, 3000, 30000];                     // the sport level's
export const DEFAULT_N0 = 300;
// n0 as given (a number for both levels, or { sport, leaf }) -> { sport, leaf }
export const n0Levels = n0 => (typeof n0 === 'number' ? { sport: n0, leaf: n0 } : { sport: n0.sport, leaf: n0.leaf });
export const MIN_JUDGE_BETS = 150;   // as roi-stats.js FIT_MIN_BETS / FIT_MIN_GAMES
export const MIN_JUDGE_GAMES = 20;
const Z90 = 1.645;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const logit = p => { const q = clamp(p, 1e-4, 1 - 1e-4); return Math.log(q / (1 - q)); };
export const sigmoid = z => 1 / (1 + Math.exp(-z));

// --- 3x3 algebra -------------------------------------------------------------

function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[3] / row[i]);
}
function inv3(A) {
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(e => solve3(A, e));
  if (cols.some(c => !c)) return null;
  return [0, 1, 2].map(i => [0, 1, 2].map(j => cols[j][i]));
}
const mat = (f) => [0, 1, 2].map(i => [0, 1, 2].map(j => f(i, j)));
const mul = (A, B) => mat((i, j) => A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]);
const add = (A, B) => mat((i, j) => A[i][j] + B[i][j]);
const scale = (A, k) => mat((i, j) => A[i][j] * k);
const quad = (x, V) => x.reduce((s, xi, i) => s + xi * (V[i][0] * x[0] + V[i][1] * x[1] + V[i][2] * x[2]), 0);

// --- observations -------------------------------------------------------------

// The stage a selection is fitted at: the close, or the open where it was
// priced once (no closing price apart from the opening one)
const stageOf = (r, stage) => (stage === 'close' && !(r.n_checks > 1) ? 'open' : stage);
const sidesOf = r => (r.market_kind === 'match_odds' && r.three_way ? 3 : 2);
const SIDE_ORDER = ['home', 'over', 'away', 'under', 'draw'];

// {row -> overround} at a stage: the market's sides' 1 / price summed, for
// rows whose every side was priced there (and, at the close, still in the
// market at the end: a row that left it closed earlier than its sides)
export function overrounds(rows, stage = 'close') {
  const groups = new Map();
  for (const r of rows) {
    const k = marketKey(r);
    if (k == null) continue;
    const key = `${r.sport}:${r.game_id}|${k}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = new Map();
  for (const g of groups.values()) {
    if (g.length !== sidesOf(g[0])) continue;
    const backs = g.map(r => r[`${stageOf(r, stage)}_back`]);
    if (backs.some(b => !(b > 1)) || g.some(r => r.gone)) continue;
    const sum = backs.reduce((s, b) => s + 1 / b, 0);
    for (const r of g) out.set(r, sum);
  }
  return out;
}

// The market's chance of a selection at a price: margin out where the
// overround is known, else 1 / price
export const marketChance = (back, overround) => (overround ? 1 / back / overround : 1 / back);

export const leafKey = r => `${r.sport}|${kindKey(r)}|${r.source ? sourceKey(r) : (String(r.market_id || '').startsWith('oddsapi:') ? 'book' : 'betfair')}`;

// Settled rows (safe-stake.js decodeRows) -> observations at the close: one
// per decided bet, one side per two-way market (the other side is the same
// result mirrored, so it adds nothing but a doubled count), every side of a
// 3-way. { key, sport, game, date, x: [1, lm, d], y, w, row }.
export function observations(rows, stage = 'close') {
  const ovr = overrounds(rows, stage);
  const seenPair = new Set();
  const out = [];
  const ordered = [...rows].sort((a, b) => SIDE_ORDER.indexOf(a.side) - SIDE_ORDER.indexOf(b.side));
  for (const r of ordered) {
    if (r.win_frac == null || r.push_frac >= 1) continue;
    const st = stageOf(r, stage);
    const back = r[`${st}_back`], prob = r[`${st}_prob`];
    if (!(back > 1) || !(prob > 0 && prob < 1)) continue;
    const o = ovr.get(r);
    if (o && sidesOf(r) === 2) {
      const pair = `${r.sport}:${r.game_id}|${marketKey(r)}`;
      if (seenPair.has(pair)) continue;
      seenPair.add(pair);
    }
    const lm = logit(marketChance(back, o));
    out.push({ key: leafKey(r), sport: r.sport, game: `${r.sport}:${r.game_id}`, date: r.kickoff,
               x: [1, lm, logit(prob) - lm], y: r.win_frac / (1 - r.push_frac), w: 1 - r.push_frac, row: r });
  }
  return out;
}

// --- fitting --------------------------------------------------------------------

// Penalised logistic regression by Newton steps: maximise
//   sum w [y log p + (1-y) log(1-p)] - 1/2 (beta - mu)' L (beta - mu)
// -> { beta, H: the likelihood's information at beta, A: H + L, n, games }.
// cols: which of the three terms are in (market-only: [0, 1]).
function irls(obs, mu, L, cols = [0, 1, 2], iters = 30) {
  let beta = [...mu];
  let H = mat(() => 0);
  const pick = x => x.map((v, i) => (cols.includes(i) ? v : 0));
  for (let it = 0; it < iters; it++) {
    const g = [0, 0, 0];
    H = mat(() => 0);
    for (const o of obs) {
      const x = pick(o.x);
      const p = sigmoid(beta[0] * x[0] + beta[1] * x[1] + beta[2] * x[2]);
      const v = Math.max(p * (1 - p), 1e-9) * o.w;
      for (let i = 0; i < 3; i++) {
        g[i] += o.w * (o.y - p) * x[i];
        for (let j = 0; j < 3; j++) H[i][j] += v * x[i] * x[j];
      }
    }
    const A = add(H, L);
    for (let i = 0; i < 3; i++) g[i] -= L[i].reduce((s, l, j) => s + l * (beta[j] - mu[j]), 0);
    const step = solve3(A, g);
    if (!step) break;
    beta = beta.map((b, i) => b + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return { beta, H, A: add(H, L), n: obs.length, games: new Set(obs.map(o => o.game)).size };
}

// Cluster-robust covariance of a penalised fit: A^-1 (B + L Vmu L) A^-1, B the
// games' score sums squared; Vmu the parent's covariance (the prior's centre
// is itself an estimate)
function sandwich(fit, obs, L, Vmu, cols = [0, 1, 2]) {
  const Ainv = inv3(fit.A);
  if (!Ainv) return null;
  const pick = x => x.map((v, i) => (cols.includes(i) ? v : 0));
  const byGame = new Map();
  for (const o of obs) {
    const x = pick(o.x);
    const p = sigmoid(fit.beta[0] * x[0] + fit.beta[1] * x[1] + fit.beta[2] * x[2]);
    const u = byGame.get(o.game) || [0, 0, 0];
    for (let i = 0; i < 3; i++) u[i] += o.w * (o.y - p) * x[i];
    byGame.set(o.game, u);
  }
  let B = mat(() => 0);
  for (const u of byGame.values()) B = add(B, mat((i, j) => u[i] * u[j]));
  if (Vmu) B = add(B, mul(mul(L, Vmu), L));
  return mul(mul(Ainv, B), Ainv);
}

// Fits every level: all markets, each sport, each market, each pulled toward
// the level above with a prior worth n0 of that level's bets (n0: one number
// for both levels, or { sport, leaf }).
// -> { root, sports: {sport: fit}, leaves: {key: fit}, n0: { sport, leaf },
// cols }, each fit { beta, V, n, games, own: the share of its own bets in it }.
export function fitHierarchy(obs, { n0 = DEFAULT_N0, cols = [0, 1, 2] } = {}) {
  const levels = n0Levels(n0);
  const weak = mat((i, j) => (i === j ? 1e-3 * Math.max(obs.length, 1) : 0));
  const root = irls(obs, [0, 1, 0], weak, cols);
  root.V = sandwich(root, obs, weak, null, cols);
  root.own = 1;
  const child = (sub, parent, k) => {
    const L = scale(parent.H, k / Math.max(parent.n, 1));
    const f = irls(sub, parent.beta, L, cols);
    f.V = sandwich(f, sub, L, parent.V, cols);
    f.own = f.n / (f.n + k);
    return f;
  };
  const sports = {}, leaves = {};
  const bySport = groupBy(obs, o => o.sport);
  for (const [s, sub] of bySport) sports[s] = child(sub, root, levels.sport);
  for (const [k, sub] of groupBy(obs, o => o.key)) leaves[k] = child(sub, sports[k.split('|')[0]], levels.leaf);
  return { root, sports, leaves, n0: levels, cols };
}

function groupBy(xs, f) {
  const m = new Map();
  for (const x of xs) {
    const k = f(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// The fit a bet is judged by: its market's, else its sport's, else all
export const fitFor = (h, key) => h.leaves[key] || h.sports[key.split('|')[0]] || h.root;

// The model's weight b (and the market's, c - b) with a 90% range
export function weights(fit) {
  const [, c, b] = fit.beta;
  const se = fit.V ? Math.sqrt(Math.max(0, fit.V[2][2])) : null;
  return { bModel: b, bMarket: c - b, lo: se == null ? null : b - Z90 * se, hi: se == null ? null : b + Z90 * se };
}

// Calibrated chance of a selection: { p, lo, hi } (90%) from the model's
// chance and the market's (margin out where it can be)
export function calProb(fit, pModel, pMarket) {
  const lm = logit(pMarket);
  const x = [1, lm, logit(pModel) - lm];
  const z = fit.beta[0] + fit.beta[1] * x[1] + fit.beta[2] * x[2];
  const se = fit.V ? Math.sqrt(Math.max(0, quad(x, fit.V))) : 0;
  return { p: sigmoid(z), lo: sigmoid(z - Z90 * se), hi: sigmoid(z + Z90 * se) };
}

// Expected return per unit at odds, after commission on winnings
export const edgeAt = (p, odds, commission = 0) => p * (odds - 1) * (1 - commission) - (1 - p);

// --- walk forward -----------------------------------------------------------------

const logLoss = (o, p) => -o.w * (o.y * Math.log(clamp(p, 1e-9, 1)) + (1 - o.y) * Math.log(clamp(1 - p, 1e-9, 1)));
const predict = (fit, x, cols) => sigmoid(cols.reduce((s, i) => s + fit.beta[i] * x[i], 0));

// For each kickoff day after the burn-in (minDays days, minRows bets), fits
// on the days before it and scores it: { days, oos: [{ o, pBlend, pMarket,
// fit }] } - the blend's and a market-only fit's out-of-sample chances
export function walkForward(obs, { n0 = DEFAULT_N0, minDays = 7, minRows = 500 } = {}) {
  const days = [...new Set(obs.map(o => o.date))].sort();
  const oos = [];
  const fits = {};                       // day -> the blend fitted on the days before it
  for (let i = 0; i < days.length; i++) {
    const train = obs.filter(o => o.date < days[i]);
    if (i < minDays || train.length < minRows) continue;
    const blend = fitHierarchy(train, { n0 });
    const market = fitHierarchy(train, { n0, cols: [0, 1] });
    fits[days[i]] = blend;
    for (const o of obs) {
      if (o.date !== days[i]) continue;
      oos.push({ o, pBlend: predict(fitFor(blend, o.key), o.x, [0, 1, 2]),
                 pMarket: predict(fitFor(market, o.key), o.x, [0, 1]) });
    }
  }
  return { days: Object.keys(fits), oos, fits };
}

// --- the calibrated edge at a stage --------------------------------------------------

// A settled selection at the average price while it showed value (the 'avg'
// stage, as the Best Bets page takes it): the calibrated chance from its
// average model chance and median price, the margin taken out by the close's
// overround. The bet is taken at the best bookie's (basis 'book') or the
// median: taken, and judged there: edge, edgeLo (its 90% low end).
// edgeMedian: at the median, for reference.
export function calAtAvg(r, fit, overround, basis = 'book') {
  if (r.avg_back == null || !(r.avg_prob > 0 && r.avg_prob < 1)) return null;
  const taken = (basis === 'book' ? r.avg_book_back : null) ?? r.avg_back;
  const c = calProb(fit, r.avg_prob, marketChance(r.avg_back, overround));
  const com = r.commission || 0;
  return { ...c, taken, edge: edgeAt(c.p, taken, com), edgeLo: edgeAt(c.lo, taken, com),
           edgeMedian: edgeAt(c.p, r.avg_back, com) };
}

const profitAt = (r, odds) => r.win_frac * (odds - 1) * (1 - (r.commission || 0)) - (1 - r.win_frac - r.push_frac);

// Out of sample, per market and all told: what each rule returned betting the
// held-out days' bets that showed value, one bet per market as the analysis
// page counts them (roi-stats.js onePerMarket: a game's main line and the
// side the model likes, a scorer once), 1 unit each at the average price
// while they showed value (basis: the best bookie's or the median), each
// judged by the blend fitted on the days before. Rules: cal (calibrated edge
// at the price taken > 0), calLo (its 90% low end > 0), model (the model's own
// edge > 0: every bet that showed value), mine (passes(row): the viewer's
// filters, if given). -> { all: {rule: {n, units, roi}}, byKey: {key: ...} }
export function ruleReturns(rows, fits, { basis = 'book', passes = null } = {}) {
  const ovr = overrounds(rows, 'close');
  const tally = () => ({ cal: { n: 0, units: 0 }, calLo: { n: 0, units: 0 }, model: { n: 0, units: 0 },
                         ...(passes ? { mine: { n: 0, units: 0 } } : {}) });
  const all = tally(), byKey = {};
  const put = (t, rule, u) => { t[rule].n += 1; t[rule].units += u; };
  const bets = onePerMarket(rows.filter(r => fits[r.kickoff] && r.avg_back != null && r.win_frac != null)
    .map(r => toBet(r, 'avg', basis)));
  for (const b of bets) {
    const r = b.row;
    const key = leafKey(r);
    const at = calAtAvg(r, fitFor(fits[r.kickoff], key), ovr.get(r), basis);
    if (!at) continue;
    const u = profitAt(r, at.taken);
    const t = byKey[key] || (byKey[key] = tally());
    for (const tt of [all, t]) {
      put(tt, 'model', u);
      if (at.edge > 0) put(tt, 'cal', u);
      if (at.edgeLo > 0) put(tt, 'calLo', u);
      if (passes && passes(r)) put(tt, 'mine', u);
    }
  }
  const roi = t => { for (const k of Object.keys(t)) t[k].roi = t[k].n ? t[k].units / t[k].n : null; return t; };
  roi(all);
  for (const t of Object.values(byKey)) roi(t);
  return { all, byKey };
}

// Closing-line value per market of the bets that showed value: the average
// price taken while they did against the close with the margin out (where both
// sides were priced; else against the raw closing price, which flatters the
// close by its margin). -> {key: {n, mean}}
export function clvByKey(rows, basis = 'book') {
  const ovr = overrounds(rows, 'close');
  const out = {};
  for (const r of rows) {
    if (r.avg_back == null || !(r.n_checks > 1) || !(r.close_back > 1) || r.gone) continue;
    const taken = (basis === 'book' ? r.avg_book_back : null) ?? r.avg_back;
    const fair = marketChance(r.close_back, ovr.get(r));
    const t = out[leafKey(r)] || (out[leafKey(r)] = { n: 0, sum: 0 });
    t.n += 1;
    t.sum += taken * fair - 1;
  }
  for (const t of Object.values(out)) t.mean = t.sum / t.n;
  return out;
}

// The n0 with the lowest out-of-sample log loss (the blend's), with each one's
// The { sport, leaf } n0 pair with the lowest walk-forward log loss
export function chooseN0(obs, opts = {}) {
  const scores = N0_SPORT_GRID.flatMap(sport => N0_GRID.map(leaf => {
    const n0 = { sport, leaf };
    const { oos } = walkForward(obs, { ...opts, n0 });
    return { n0, n: oos.length, loss: oos.reduce((s, x) => s + logLoss(x.o, x.pBlend), 0) };
  }));
  const usable = scores.filter(s => s.n);
  const best = usable.length ? usable.reduce((a, b) => (b.loss < a.loss ? b : a)) : { n0: n0Levels(DEFAULT_N0) };
  return { n0: best.n0, scores };
}

// Seeded, so a range doesn't move between renders of the same data
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The difference in log loss per bet (blend - market-only; below 0: the model
// adds information) with a 90% range resampling games
export function lossGap(items, reps = 400, seed = 11) {
  if (!items.length) return null;
  const byGame = new Map();
  for (const x of items) {
    const g = byGame.get(x.o.game) || [0, 0];
    g[0] += logLoss(x.o, x.pBlend) - logLoss(x.o, x.pMarket);
    g[1] += x.o.w;
    byGame.set(x.o.game, g);
  }
  const list = [...byGame.values()];
  const total = list.reduce((s, g) => s + g[0], 0) / list.reduce((s, g) => s + g[1], 0);
  if (list.length < 5) return { gap: total, lo: null, hi: null, games: list.length };
  const rand = rng(seed + list.length);
  const means = [];
  for (let r = 0; r < reps; r++) {
    let s = 0, n = 0;
    for (let i = 0; i < list.length; i++) { const g = list[(rand() * list.length) | 0]; s += g[0]; n += g[1]; }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { gap: total, lo: means[Math.floor(reps * 0.05)], hi: means[Math.ceil(reps * 0.95) - 1], games: list.length };
}

// A market's verdict: 'adds' (the model's weight is clear of 0 and it beats a
// market-only fit out of sample), 'hurts' (weight clear below 0, or worse out
// of sample beyond luck), 'none' (no evidence either way), 'thin' (too few)
export function verdict(fit, gap) {
  if (fit.n < MIN_JUDGE_BETS || fit.games < MIN_JUDGE_GAMES) return 'thin';
  const w = weights(fit);
  if ((w.hi != null && w.hi < 0) || (gap && gap.lo != null && gap.lo > 0)) return 'hurts';
  if (w.lo != null && w.lo > 0 && gap && gap.gap < 0) return 'adds';
  return 'none';
}
