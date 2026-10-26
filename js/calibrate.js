// calibrate.js — how far to trust the model against the bookies' price in each
// market, and the calibrated chance and edge that gives every bet. No DOM, so
// it can be exercised under Node, and runs in a Worker for the analysis page's
// heavier parts (calibrate-worker.js).
//
// Per market (sport · kind · bookies or Betfair) the result is fitted with a
// logistic blend of the two chances:
//     logit P(win) = a + c·lm + b·d + e·d·|d|     lm = logit(market chance)
//                                                 d  = logit(model chance) - lm
// a and c are the market's terms (its margin and favourite-longshot lean); b
// and e the model's. The share of the model's disagreement with the market
// worth keeping is b + e·|d|: 0 says it is noise, 1 that it is worth its full
// size. e lets that share change with the size of the disagreement - a model
// 40% over the price is mostly its own error in some markets, where 5% over is
// not - which one share for every edge (b alone) could not show: it fitted the
// big edges by shrinking every bet's.
//
// A market's own bets are often few, so each level borrows from the one above
// (all markets -> sport -> market): it is fitted with a prior centred on its
// parent's fit (empirical Bayes), so a thin market sits near its sport's fit
// and moves off it as its own bets come in. The model's terms are pooled by
// n0.sport and n0.leaf (worth that many of the parent's bets); the market's
// terms by n0.market at both levels, since markets' margins differ (a scorer's
// raw price keeps the bookies' margin, a line's has it taken out): pooled as
// hard as the model's, every NFL market had the scorers' intercept, about 8
// points off every even-money edge. n0 is chosen by the walk-forward's log
// loss on the bets that showed value, the ones the calibrated edge judges.
//
// The market chance is the bookies' price with their margin taken out: a
// market's sides (safe-stake.js marketKey) priced at the same stage are
// divided by their total of 1 / price; a scorer, or a side priced alone,
// keeps 1 / price (the intercept takes the margin up). A selection that showed
// value is fitted at its average while it did (the 'avg' stage: the model's
// chance and the price it would have been taken at); the rest at the close
// (open where a selection was priced once). Both sides of a two-way market go
// in at half weight each: the pair counts once, and an intercept fitted on the
// home / over side alone was applied with the same sign to away / under bets.
//
// Intervals are cluster-robust by game (bets in one game win and lose
// together). The walk-forward test fits on the days before each day and
// scores that day: out-of-sample log loss against a market-only fit, and the
// return of betting the calibrated edge (and other rules) at the average price
// while each bet showed value.
import { kindKey, marketKey, sourceKey, toBet } from './safe-stake.js';
import { hasRealClose, lineMoved } from './best-bets-filters.js';
import { onePerMarket } from './roi-stats.js';

export const N0_SPORT_GRID = [30, 100, 300];         // the model's terms, sport level
export const N0_GRID = [1000, 3000, 10000];           // the model's terms, market level (no higher: a
                                                      // market clear of its sport, NFL receiving yards, was
                                                      // held to it on a log loss 0.0005 a bet better)
export const N0_MARKET_GRID = [300, 1000, 3000];      // the market's terms, both levels
export const DEFAULT_N0 = { sport: 30, leaf: 3000, market: 1000 };
// n0 as given (a number for every level, or { sport, leaf, market }) ->
// { sport, leaf, market }
export const n0Levels = n0 => (typeof n0 === 'number' ? { sport: n0, leaf: n0, market: n0 }
  : { sport: n0.sport, leaf: n0.leaf, market: n0.market ?? n0.leaf });
export const NTERMS = 4;      // [1, lm, d, d·|d|]
const MARKET_TERMS = 2;       // the first two: a, c
export const features = (lm, d) => [1, lm, d, d * Math.abs(d)];
export const MIN_JUDGE_BETS = 150;   // as roi-stats.js FIT_MIN_BETS / FIT_MIN_GAMES
export const MIN_JUDGE_GAMES = 20;
const Z90 = 1.645;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const logit = p => { const q = clamp(p, 1e-4, 1 - 1e-4); return Math.log(q / (1 - q)); };
export const sigmoid = z => 1 / (1 + Math.exp(-z));

// --- small matrix algebra ------------------------------------------------------

export function solve(A, b) {
  const k = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let j = c; j <= k; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row, i) => row[k] / row[i]);
}
export function inv(A) {
  const cols = A.map((_, j) => solve(A, A.map((_, i) => (i === j ? 1 : 0))));
  if (cols.some(c => !c)) return null;
  return A.map((_, i) => A.map((_, j) => cols[j][i]));
}
export const mat = (f, k = NTERMS) => Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => f(i, j)));
export const mul = (A, B) => mat((i, j) => A[i].reduce((s, a, t) => s + a * B[t][j], 0), A.length);
export const add = (A, B) => mat((i, j) => A[i][j] + B[i][j], A.length);
export const quad = (x, V) => x.reduce((s, xi, i) => s + xi * V[i].reduce((t, v, j) => t + v * x[j], 0), 0);
export const dot = (x, beta) => x.reduce((s, v, i) => s + v * beta[i], 0);

// --- observations -------------------------------------------------------------

// The stage a selection is fitted at: the close, or the open where it was
// priced once (no closing price apart from the opening one)
const stageOf = (r, stage) => (stage === 'close' && !(r.n_checks > 1) ? 'open' : stage);
const sidesOf = r => (r.market_kind === 'match_odds' && r.three_way ? 3 : 2);

// {row -> overround} at a stage: the market's sides' 1 / price summed, for
// rows whose every side was priced there (and, at the close, still in the
// market at the end: a row that left it closed earlier than its sides). A
// main line the market moved off left with its other side, both last priced
// at one check, so that pair's closes still make a margin.
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
    if (backs.some(b => !(b > 1)) || g.some(r => r.gone && !lineMoved(r))) continue;
    const sum = backs.reduce((s, b) => s + 1 / b, 0);
    for (const r of g) out.set(r, sum);
  }
  return out;
}

// The market's chance of a selection at a price: margin out where the
// overround is known, else 1 / price
export const marketChance = (back, overround) => (overround ? 1 / back / overround : 1 / back);

// The closing median price a settled row is judged against, and the margin
// to take out of it: { back, ovr } (ovr: overrounds(rows, 'close')). Where a
// main line moved, the close at the row's own line (lc_back, at the closing
// line's margin); else its own close, if it was priced again and still in
// its market at the end. Null when there is no real close.
export function realClose(r, ovr) {
  if (lineMoved(r)) return r.lc_back > 1 ? { back: r.lc_back, ovr: r.lc_ovr } : null;
  if (!hasRealClose(r) || !(r.close_back > 1) || r.gone) return null;
  return { back: r.close_back, ovr: ovr.get(r) };
}

export const leafKey = r => `${r.sport}|${kindKey(r)}|${r.source ? sourceKey(r) : (String(r.market_id || '').startsWith('oddsapi:') ? 'book' : 'betfair')}`;

// Settled rows (safe-stake.js decodeRows) -> observations: one per decided
// selection, at its average while it showed value (value: true) or else at
// the close, the margin out by the close's overround. Both sides of a two-way
// market whose overround is known at half weight (the pair is one result,
// mirrored), every side of a 3-way at full. { key, sport, game, date, x:
// features(lm, d), d, y, w, value, row }. atClose: every selection at the
// close (the market-only fit of a fair closing price, close-model.js).
export function observations(rows, { atClose = false } = {}) {
  const ovr = overrounds(rows, 'close');
  const out = [];
  for (const r of rows) {
    if (r.win_frac == null || r.push_frac >= 1) continue;
    const value = !atClose && r.avg_back > 1 && r.avg_prob > 0 && r.avg_prob < 1;
    const st = value ? 'avg' : stageOf(r, 'close');
    const back = r[`${st}_back`], prob = r[`${st}_prob`];
    if (!(back > 1) || !(prob > 0 && prob < 1)) continue;
    const o = ovr.get(r);
    const lm = logit(marketChance(back, o)), d = logit(prob) - lm;
    out.push({ key: leafKey(r), sport: r.sport, game: `${r.sport}:${r.game_id}`, date: r.kickoff,
               x: features(lm, d), d, y: r.win_frac / (1 - r.push_frac),
               w: (o && sidesOf(r) === 2 ? 0.5 : 1) * (1 - r.push_frac), value, row: r });
  }
  return out;
}

// --- fitting --------------------------------------------------------------------

// Penalised logistic regression by Newton steps: maximise
//   sum w [y log p + (1-y) log(1-p)] - 1/2 (beta - mu)' L (beta - mu)
// -> { beta, H: the likelihood's information at beta, A: H + L, n, games }.
// cols: which terms are in (market-only: [0, 1]); the rest stay at mu.
function irls(obs, mu, L, cols, iters = 30) {
  const k = mu.length;
  const out = i => !cols.includes(i);
  let beta = [...mu];
  let H = mat(() => 0, k);
  for (let it = 0; it < iters; it++) {
    const g = Array(k).fill(0);
    H = mat(() => 0, k);
    for (const o of obs) {
      const p = sigmoid(dot(o.x, beta));
      const v = Math.max(p * (1 - p), 1e-9) * o.w;
      for (let i = 0; i < k; i++) {
        g[i] += o.w * (o.y - p) * o.x[i];
        for (let j = 0; j < k; j++) H[i][j] += v * o.x[i] * o.x[j];
      }
    }
    const A = add(H, L);
    for (let i = 0; i < k; i++) g[i] -= L[i].reduce((s, l, j) => s + l * (beta[j] - mu[j]), 0);
    // A term left out: its row pinned so its step is 0 (left in, a prior with
    // nothing on it made A singular, and the fit never left its parent's)
    for (let i = 0; i < k; i++) if (out(i)) { g[i] = 0; for (let j = 0; j < k; j++) A[i][j] = A[j][i] = (i === j ? 1 : 0); }
    const step = solve(A, g);
    if (!step) break;
    beta = beta.map((b, i) => b + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  const A = add(H, L);
  for (let i = 0; i < k; i++) if (out(i)) for (let j = 0; j < k; j++) A[i][j] = A[j][i] = (i === j ? 1 : 0);
  return { beta, H, A, n: obs.length, games: new Set(obs.map(o => o.game)).size, dRef: refD(obs) };
}

// The disagreement a fit's weight is quoted at: the mean d of its bets that
// showed value (the model over the price), else of all its bets with d > 0
function refD(obs) {
  const pos = obs.filter(o => o.value && o.d > 0);
  const use = pos.length ? pos : obs.filter(o => o.d > 0);
  return use.length ? use.reduce((s, o) => s + o.d, 0) / use.length : 0;
}

// Cluster-robust covariance of a penalised fit: A^-1 (B + L Vmu L) A^-1, B the
// games' score sums squared; Vmu the parent's covariance (the prior's centre
// is itself an estimate)
function sandwich(fit, obs, L, Vmu, cols) {
  const Ainv = inv(fit.A);
  if (!Ainv) return null;
  const k = fit.beta.length;
  const byGame = new Map();
  for (const o of obs) {
    const p = sigmoid(dot(o.x, fit.beta));
    const u = byGame.get(o.game) || Array(k).fill(0);
    for (let i = 0; i < k; i++) if (cols.includes(i)) u[i] += o.w * (o.y - p) * o.x[i];
    byGame.set(o.game, u);
  }
  let B = mat(() => 0, k);
  for (const u of byGame.values()) B = add(B, mat((i, j) => u[i] * u[j], k));
  if (Vmu) B = add(B, mul(mul(L, Vmu), L));
  const V = mul(mul(Ainv, B), Ainv);
  for (let i = 0; i < k; i++) if (!cols.includes(i)) for (let j = 0; j < k; j++) V[i][j] = V[j][i] = 0;
  return V;
}

// Fits every level: all markets, each sport, each market, each pulled toward
// the level above: the model's terms with a prior worth n0.sport / n0.leaf of
// that level's bets, the market's terms n0.market.
// -> { root, sports: {sport: fit}, leaves: {key: fit}, n0: { sport, leaf,
// market }, cols }, each fit { beta, V, n, games, own: the share of its own
// bets in its model terms, dRef }.
export function fitHierarchy(obs, { n0 = DEFAULT_N0, cols = [0, 1, 2, 3] } = {}) {
  const levels = n0Levels(n0);
  const weak = mat((i, j) => (i === j ? 1e-3 * Math.max(obs.length, 1) : 0));
  const root = irls(obs, [0, 1, 0, 0], weak, cols);
  root.V = sandwich(root, obs, weak, null, cols);
  root.own = 1;
  const child = (sub, parent, k) => {
    const sq = Array.from({ length: NTERMS }, (_, i) => Math.sqrt(i < MARKET_TERMS ? levels.market : k));
    const L = mat((i, j) => parent.H[i][j] * sq[i] * sq[j] / Math.max(parent.n, 1));
    const f = irls(sub, parent.beta, L, cols);
    f.V = sandwich(f, sub, L, parent.V, cols);
    f.own = f.n / (f.n + k);
    return f;
  };
  const sports = {}, leaves = {};
  for (const [s, sub] of groupBy(obs, o => o.sport)) sports[s] = child(sub, root, levels.sport);
  for (const [k, sub] of groupBy(obs, o => o.key)) leaves[k] = child(sub, sports[k.split('|')[0]], levels.leaf);
  return { root, sports, leaves, n0: levels, cols };
}

export function groupBy(xs, f) {
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

// The model's weight at a disagreement d (default: the fit's typical value
// bet's): the share of it worth keeping, b + e·|d|, with a 90% range; and the
// market's, c - that (as roi-stats.js fitBlend's bMarket)
export function weights(fit, d = fit.dRef ?? 0) {
  const [, c, b, e] = fit.beta;
  const ad = Math.abs(d), w = b + e * ad;
  const g = [0, 0, 1, ad];
  const se = fit.V ? Math.sqrt(Math.max(0, quad(g, fit.V))) : null;
  return { bModel: w, bMarket: c - w, lo: se == null ? null : w - Z90 * se, hi: se == null ? null : w + Z90 * se, d };
}

// Calibrated chance of a selection: { p, lo, hi } (90%) from the model's
// chance and the market's (margin out where it can be), and w: the share of
// the model's disagreement kept at this bet's
export function calProb(fit, pModel, pMarket) {
  const lm = logit(pMarket), d = logit(pModel) - lm;
  const x = features(lm, d);
  const z = dot(x, fit.beta);
  const se = fit.V ? Math.sqrt(Math.max(0, quad(x, fit.V))) : 0;
  return { p: sigmoid(z), lo: sigmoid(z - Z90 * se), hi: sigmoid(z + Z90 * se), w: fit.beta[2] + fit.beta[3] * Math.abs(d) };
}

// Expected return per unit at odds, after commission on winnings
export const edgeAt = (p, odds, commission = 0) => p * (odds - 1) * (1 - commission) - (1 - p);

// --- walk forward -----------------------------------------------------------------

const logLoss = (o, p) => -o.w * (o.y * Math.log(clamp(p, 1e-9, 1)) + (1 - o.y) * Math.log(clamp(1 - p, 1e-9, 1)));
const predict = (fit, x, cols) => sigmoid(cols.reduce((s, i) => s + fit.beta[i] * x[i], 0));

// For each kickoff day after the burn-in (minDays days, minRows bets), fits
// on the days before it and scores it: { days, oos: [{ o, pBlend, pMarket,
// fit }] } - the blend's and a market-only fit's out-of-sample chances
// (withMarket false: the blend's only)
export function walkForward(obs, { n0 = DEFAULT_N0, minDays = 7, minRows = 500, withMarket = true } = {}) {
  const days = [...new Set(obs.map(o => o.date))].sort();
  const oos = [];
  const fits = {};                       // day -> the blend fitted on the days before it
  for (let i = 0; i < days.length; i++) {
    const train = obs.filter(o => o.date < days[i]);
    if (i < minDays || train.length < minRows) continue;
    const blend = fitHierarchy(train, { n0 });
    const market = withMarket ? fitHierarchy(train, { n0, cols: [0, 1] }) : null;
    fits[days[i]] = blend;
    for (const o of obs) {
      if (o.date !== days[i]) continue;
      oos.push({ o, pBlend: predict(fitFor(blend, o.key), o.x, [0, 1, 2, 3]),
                 pMarket: market ? predict(fitFor(market, o.key), o.x, [0, 1]) : null });
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
// close by its margin). A main line whose line moved: against the close at its
// own line (lc_back, the closing line's margin lc_ovr). -> {key: {n, mean}}
export function clvByKey(rows, basis = 'book') {
  const ovr = overrounds(rows, 'close');
  const out = {};
  for (const r of rows) {
    const close = realClose(r, ovr);
    if (r.avg_back == null || !close) continue;
    const taken = (basis === 'book' ? r.avg_book_back : null) ?? r.avg_back;
    const fair = marketChance(close.back, close.ovr);
    const t = out[leafKey(r)] || (out[leafKey(r)] = { n: 0, sum: 0 });
    t.n += 1;
    t.sum += taken * fair - 1;
  }
  for (const t of Object.values(out)) t.mean = t.sum / t.n;
  return out;
}

// The { sport, leaf, market } n0 with the lowest walk-forward log loss on the
// held-out bets that showed value: the bets the calibrated edge is for. Scored
// on every selection, the pick suited the many the model dislikes, and the
// fit's edges on the bets it liked came out well short of what they returned.
export function chooseN0(obs, opts = {}) {
  const scores = N0_SPORT_GRID.flatMap(sport => N0_GRID.flatMap(leaf => N0_MARKET_GRID.map(market => {
    const n0 = { sport, leaf, market };
    const oos = walkForward(obs, { ...opts, n0, withMarket: false }).oos.filter(x => x.o.value);
    return { n0, n: oos.length, loss: oos.reduce((s, x) => s + logLoss(x.o, x.pBlend), 0) };
  })));
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
