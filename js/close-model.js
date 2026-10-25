// close-model.js — the predicted closing price: where a selection's price is
// heading by kickoff, and the edge of taking today's price against the fair
// close it predicts. No DOM, so it can be exercised under Node; fitted in the
// calibration Worker (calibrate-worker.js) with the rest.
//
// Results are a slow judge: at typical odds, telling a 3% edge from none takes
// thousands of bets. The closing price is a fast one (the market at its
// sharpest, and a market-only fit at the close predicts results better than
// any blend with the model), and every priced selection has one, not only the
// bets that showed value. So this learns from prices, not results:
//
//   move  = logit(1 / close median) - logit(1 / median now)
//         ~ terms in the model's disagreement with the price now (d), the best
//           bookie's premium over the median (gap) and the hours left
//   fair  = the market-only fit's chance at the predicted closing price
//           (calibrate.js, every selection at the close: the margin out)
//   edge  = fair × price taken - 1
//
// Two moments per settled selection carry a known time before kickoff: when it
// was first priced (open_hrs) and when it first showed value (first_hrs), each
// paired with its close. Both sides of a two-way market go in at half weight,
// as calibrate.js. Each market is pulled toward its sport and each sport toward
// all markets (empirical Bayes, n0 by the walk-forward's squared error on the
// moments the model liked), with cluster-robust intervals by game.
import { logit, sigmoid, overrounds, marketChance, leafKey, fitHierarchy, fitFor, observations, edgeAt,
         solve, inv, mat, mul, add, quad, dot, groupBy } from './calibrate.js';

export const MOVE_TERMS = 6;
export const MOVE_N0_SPORT = [30, 300, 3000];
export const MOVE_N0_LEAF = [100, 1000, 10000];
export const DEFAULT_MOVE_N0 = { sport: 300, leaf: 1000 };
const MAX_MOVE = 1.5;          // a logit move past this is a different market (a line moved, a player out)
const Z90 = 1.645;

// [1, lh, d, d·lh, gap, gap·lh], lh = log(1 + hours left): how much of a
// disagreement the market closes, and how much of the best bookie's premium
// it takes back, both shrinking as kickoff nears
export const moveFeatures = (d, gap, hrs) => {
  const lh = Math.log1p(Math.max(0, hrs));
  return [1, lh, d, d * lh, gap, gap * lh];
};

// A selection's state at a moment -> the move features' inputs: d against the
// median with the margin out (overround: its market's 1 / price total, where
// known), gap = log(best bookie / median)
export function stateOf({ back, taken = back, prob, overround = null, hrs }) {
  if (!(back > 1) || !(prob > 0 && prob < 1) || hrs == null || !(hrs >= 0)) return null;
  const d = logit(prob) - logit(marketChance(back, overround));
  return { d, gap: Math.log((taken > 1 ? taken : back) / back), hrs, back, taken: taken > 1 ? taken : back };
}

// Settled rows (decoded, with open_hrs / first_hrs) -> move points: { key,
// sport, game, date, stage, x, y, w, d, row }. Only selections priced more
// than once and still in their market at the end (a real close).
export function movePoints(rows) {
  const oOpen = overrounds(rows, 'open'), oClose = overrounds(rows, 'close');
  const out = [];
  for (const r of rows) {
    if (!(r.n_checks > 1) || !(r.close_back > 1) || r.gone) continue;
    const half = (oClose.get(r) && !(r.market_kind === 'match_odds' && r.three_way)) ? 0.5 : 1;
    for (const stage of ['open', 'first']) {
      const hrs = r[`${stage}_hrs`];
      if (stage === 'first' && (hrs == null || Math.abs(hrs - r.open_hrs) < 0.05)) continue;
      const s = stateOf({ back: r[`${stage}_back`], taken: r[`${stage}_book_back`], prob: r[`${stage}_prob`],
                          overround: stage === 'open' ? oOpen.get(r) : oClose.get(r), hrs });
      if (!s) continue;
      const y = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, logit(1 / r.close_back) - logit(1 / s.back)));
      out.push({ key: leafKey(r), sport: r.sport, game: `${r.sport}:${r.game_id}`, date: r.kickoff, stage,
                 x: moveFeatures(s.d, s.gap, hrs), y, w: half, d: s.d, row: r });
    }
  }
  return out;
}

// Ridge least squares with a prior centred on mu: minimise
//   sum w (y - x·b)^2 + (b - mu)' L (b - mu)
// -> { beta, XtX (the data's information), A, n, games, s2 (residual variance) }
function wls(pts, mu, L) {
  const k = mu.length;
  const XtX = mat(() => 0, k), Xty = Array(k).fill(0);
  for (const p of pts) for (let i = 0; i < k; i++) {
    Xty[i] += p.w * p.x[i] * p.y;
    for (let j = 0; j < k; j++) XtX[i][j] += p.w * p.x[i] * p.x[j];
  }
  const A = add(XtX, L);
  const rhs = Xty.map((v, i) => v + L[i].reduce((s, l, j) => s + l * mu[j], 0));
  const beta = solve(A, rhs) || [...mu];
  let rss = 0, wsum = 0;
  for (const p of pts) { rss += p.w * (p.y - dot(p.x, beta)) ** 2; wsum += p.w; }
  return { beta, XtX, A, n: pts.length, games: new Set(pts.map(p => p.game)).size, s2: wsum ? rss / wsum : 0 };
}

// Cluster-robust covariance by game, the parent's own uncertainty added
function sandwichLS(fit, pts, L, Vmu) {
  const Ainv = inv(fit.A);
  if (!Ainv) return null;
  const k = fit.beta.length, byGame = new Map();
  for (const p of pts) {
    const e = p.y - dot(p.x, fit.beta), u = byGame.get(p.game) || Array(k).fill(0);
    for (let i = 0; i < k; i++) u[i] += p.w * e * p.x[i];
    byGame.set(p.game, u);
  }
  let B = mat(() => 0, k);
  for (const u of byGame.values()) B = add(B, mat((i, j) => u[i] * u[j], k));
  if (Vmu) B = add(B, mul(mul(L, Vmu), L));
  return mul(mul(Ainv, B), Ainv);
}

// The move model at every level (all -> sport -> market), each pulled toward
// the one above with a prior worth n0 of its bets. -> { root, sports, leaves, n0 }
export function fitMoves(pts, n0 = DEFAULT_MOVE_N0) {
  const k = MOVE_TERMS;
  const weak = mat((i, j) => (i === j ? 1e-3 * Math.max(pts.length, 1) : 0), k);
  const root = wls(pts, Array(k).fill(0), weak);
  root.V = sandwichLS(root, pts, weak, null);
  const child = (sub, parent, n) => {
    const L = mat((i, j) => parent.XtX[i][j] * n / Math.max(parent.n, 1), k);
    const f = wls(sub, parent.beta, L);
    f.V = sandwichLS(f, sub, L, parent.V);
    f.own = f.n / (f.n + n);
    return f;
  };
  const sports = {}, leaves = {};
  for (const [s, sub] of groupBy(pts, p => p.sport)) sports[s] = child(sub, root, n0.sport);
  for (const [key, sub] of groupBy(pts, p => p.key)) leaves[key] = child(sub, sports[key.split('|')[0]], n0.leaf);
  return { root, sports, leaves, n0 };
}

// The market-only fit at the close, for the fair closing chance
export const fitFairClose = (rows, n0 = { sport: 30, leaf: 1000, market: 1000 }) =>
  fitHierarchy(observations(rows, { atClose: true }), { n0, cols: [0, 1] });

// A selection's predicted close and the edge of taking its price now:
// { move, lo, hi (the move's 90% range), closeBack (the median predicted),
// fair, fairLo (at the move's low end: the close going least our way), edge,
// edgeLo } or null. key: its market (calibrate.js leafKey); state: stateOf();
// overround for the close's margin (the current one, the best guess).
export function predictClose(moves, fair, key, state, { overround = null, commission = 0 } = {}) {
  if (!moves || !fair || !state) return null;
  const f = fitFor(moves, key), x = moveFeatures(state.d, state.gap, state.hrs);
  const move = dot(x, f.beta), se = f.V ? Math.sqrt(Math.max(0, quad(x, f.V))) : 0;
  const ff = fitFor(fair, key);
  const at = mv => {
    const closeBack = 1 / sigmoid(logit(1 / state.back) + mv);
    return { closeBack, p: sigmoid(ff.beta[0] + ff.beta[1] * logit(marketChance(closeBack, overround))) };
  };
  const mid = at(move), low = at(move - Z90 * se);
  return { move, lo: move - Z90 * se, hi: move + Z90 * se, closeBack: mid.closeBack, fair: mid.p, fairLo: low.p,
           edge: edgeAt(mid.p, state.taken, commission), edgeLo: edgeAt(low.p, state.taken, commission) };
}

// --- walk forward ----------------------------------------------------------------

// For each kickoff day after the burn-in, the move model fitted on the days
// before it: { days, fits: {day: moves}, oos: [{ p, pred }] }. rows (the
// settled rows): also the fair-close fit of the days before, fair: {day: fit}.
export function walkMoves(pts, { n0 = DEFAULT_MOVE_N0, minDays = 7, minPts = 500, rows = null, fairN0 } = {}) {
  const days = [...new Set(pts.map(p => p.date))].sort();
  const fits = {}, fair = {}, oos = [];
  for (let i = 0; i < days.length; i++) {
    const train = pts.filter(p => p.date < days[i]);
    if (i < minDays || train.length < minPts) continue;
    const m = fitMoves(train, n0);
    fits[days[i]] = m;
    if (rows) fair[days[i]] = fitFairClose(rows.filter(r => r.kickoff < days[i]), fairN0);
    for (const p of pts) if (p.date === days[i]) oos.push({ p, pred: dot(p.x, fitFor(m, p.key).beta) });
  }
  return { days: Object.keys(fits), fits, fair, oos };
}

// The { sport, leaf } n0 with the lowest out-of-sample squared error on the
// moments the model liked (d > 0: the ones a bet could come from)
export function chooseMoveN0(pts, opts = {}) {
  const scores = MOVE_N0_SPORT.flatMap(sport => MOVE_N0_LEAF.map(leaf => {
    const n0 = { sport, leaf };
    const oos = walkMoves(pts, { ...opts, n0 }).oos.filter(x => x.p.d > 0);
    return { n0, n: oos.length, mse: oos.reduce((s, x) => s + x.p.w * (x.p.y - x.pred) ** 2, 0) / Math.max(1, oos.reduce((s, x) => s + x.p.w, 0)) };
  }));
  const usable = scores.filter(s => s.n);
  return { n0: usable.length ? usable.reduce((a, b) => (b.mse < a.mse ? b : a)).n0 : DEFAULT_MOVE_N0, scores };
}

// Out of sample, per market and all told: the held-out days' moments (first
// priced, and first showing value) judged by the predicted-close edge from the
// fits of the days before. For each rule, n, the return betting 1 unit at the
// best bookie's price then (results: slow, noisy), and the closing-line value
// it actually got (fair close at the real closing price × price taken - 1:
// fast) beside the one predicted. Rules: close (predicted-close edge > 0),
// closeLo (its low end > 0), model (the model's median edge > 0). The fair
// close is the days-before fit's too (wf.fair, from walkMoves with rows).
// -> { all: {stage: {rule: {...}}}, byKey: {key: {stage: {rule}}}, move: {r2, n} }
export function closeReturns(rows, wf) {
  const oOpen = overrounds(rows, 'open'), oClose = overrounds(rows, 'close');
  const blank = () => ({ n: 0, units: 0, clv: 0, pred: 0 });
  const tally = () => ({ open: { close: blank(), closeLo: blank(), model: blank() },
                         first: { close: blank(), closeLo: blank(), model: blank() } });
  const all = tally(), byKey = {};
  for (const r of rows) {
    const moves = wf.fits[r.kickoff], fair = wf.fair[r.kickoff];
    if (!moves || !fair || !(r.n_checks > 1) || !(r.close_back > 1) || r.gone || r.win_frac == null) continue;
    const key = leafKey(r), ff = fitFor(fair, key);
    const fairClose = sigmoid(ff.beta[0] + ff.beta[1] * logit(marketChance(r.close_back, oClose.get(r))));
    for (const stage of ['open', 'first']) {
      const hrs = r[`${stage}_hrs`];
      if (stage === 'first' && hrs == null) continue;
      const ovr = stage === 'open' ? oOpen.get(r) : oClose.get(r);
      const s = stateOf({ back: r[`${stage}_back`], taken: r[`${stage}_book_back`], prob: r[`${stage}_prob`], overround: ovr, hrs });
      if (!s) continue;
      const pc = predictClose(moves, fair, key, s, { overround: ovr });
      const u = r.win_frac * (s.taken - 1) - (1 - r.win_frac - r.push_frac);
      const clv = s.taken * fairClose - 1;
      const t = byKey[key] || (byKey[key] = tally());
      const put = rule => { for (const tt of [all, t]) { const x = tt[stage][rule]; x.n += 1; x.units += u; x.clv += clv; x.pred += pc.edge; } };
      if ((r[`${stage}_edge`] ?? -1) > 0) put('model');
      if (pc.edge > 0) put('close');
      if (pc.edgeLo > 0) put('closeLo');
    }
  }
  const fin = t => { for (const st of Object.values(t)) for (const x of Object.values(st)) if (x.n) { x.roi = x.units / x.n; x.clv /= x.n; x.pred /= x.n; } return t; };
  fin(all);
  for (const t of Object.values(byKey)) fin(t);
  // How much of the held-out moves the model explains (against none: 0)
  const m = wf.oos.reduce((s, x) => s + x.p.w * x.p.y, 0) / Math.max(1e-9, wf.oos.reduce((s, x) => s + x.p.w, 0));
  let sse = 0, sst = 0;
  for (const x of wf.oos) { sse += x.p.w * (x.p.y - x.pred) ** 2; sst += x.p.w * (x.p.y - m) ** 2; }
  return { all, byKey, move: { r2: sst ? 1 - sse / sst : null, n: wf.oos.length } };
}
