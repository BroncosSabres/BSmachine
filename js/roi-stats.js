// roi-stats.js — the statistics behind the Best Bets analysis page. No DOM and
// no imports, so it can be exercised under Node.
//
// A bet is { game, edge, prob, back, commission, win, push, clv }:
//   game        key of the game it belongs to (bets in one game are correlated)
//   edge        the model's expected return per unit at `back` (model-implied RoI)
//   prob        the model's probability of the selection winning
//   back        the bookie odds
//   win / push  fraction of the stake that won / was returned
//   clv         back / closing odds - 1, or null when there is no closing price

export const profit = b => b.win * (b.back - 1) * (1 - b.commission) - (1 - b.win - b.push);

const mean = xs => xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logit = p => { const q = clamp(p, 1e-4, 1 - 1e-4); return Math.log(q / (1 - q)); };
const sigmoid = z => 1 / (1 + Math.exp(-z));

// Seeded, so the intervals don't jitter between renders of the same data.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 90% interval for the mean of value(b), resampling whole games: both sides of
// a line, or a handicap and its moneyline, win and lose together, so
// resampling bets one at a time would make the interval too narrow.
// null with fewer than `minGames` games.
export function gameBootstrap(bets, value, { reps = 400, seed = 7, minGames = 5 } = {}) {
  const games = new Map();
  for (const b of bets) {
    const v = value(b);
    if (v == null) continue;
    const g = games.get(b.game) || [0, 0];
    g[0] += v; g[1] += 1;
    games.set(b.game, g);
  }
  const list = [...games.values()];
  if (list.length < minGames) return null;
  const rand = rng(seed + list.length);
  const means = new Float64Array(reps);
  for (let r = 0; r < reps; r++) {
    let sum = 0, n = 0;
    for (let i = 0; i < list.length; i++) {
      const g = list[(rand() * list.length) | 0];
      sum += g[0]; n += g[1];
    }
    means[r] = sum / n;
  }
  means.sort();
  return [means[Math.floor(reps * 0.05)], means[Math.ceil(reps * 0.95) - 1]];
}

// Everything the page shows about one group of bets.
export function summarise(bets, opts) {
  const withClv = bets.filter(b => b.clv != null);
  return {
    n: bets.length,
    wins: bets.reduce((a, b) => a + b.win, 0),      // a half-win counts as half
    games: new Set(bets.map(b => b.game)).size,
    edge: mean(bets.map(b => b.edge)),              // model-implied RoI
    roi: mean(bets.map(profit)),                    // actual RoI
    roiCI: gameBootstrap(bets, profit, opts),
    clv: mean(withClv.map(b => b.clv)),
    clvN: withClv.length,
  };
}

// Bins by model edge. mode 'width': fixed-width bins (`width`, e.g. 0.02)
// aligned on zero, with everything beyond +/- `cap` gathered into one bin each
// side. mode 'count': `count` bins with the same number of bets in each.
// -> [{ lo, hi, bets }] in edge order, empty bins left out.
export function binByEdge(bets, { mode = 'width', width = 0.02, cap = 0.3, count = 10 } = {}) {
  if (!bets.length) return [];
  if (mode === 'count') {
    const sorted = [...bets].sort((a, b) => a.edge - b.edge);
    const k = Math.max(1, Math.min(count, sorted.length));
    const bins = [];
    for (let i = 0; i < k; i++) {
      const part = sorted.slice(Math.round(i * sorted.length / k), Math.round((i + 1) * sorted.length / k));
      if (part.length) bins.push({ lo: part[0].edge, hi: part[part.length - 1].edge, bets: part });
    }
    return bins;
  }
  const byIdx = new Map();
  const maxIdx = Math.round(cap / width);
  for (const b of bets) {
    const idx = clamp(Math.floor(b.edge / width + 1e-9), -maxIdx - 1, maxIdx);
    if (!byIdx.has(idx)) byIdx.set(idx, []);
    byIdx.get(idx).push(b);
  }
  return [...byIdx.keys()].sort((a, b) => a - b).map(idx => ({
    lo: idx < -maxIdx ? -Infinity : idx * width,
    hi: idx >= maxIdx ? Infinity : (idx + 1) * width,
    bets: byIdx.get(idx),
  }));
}

// Bins by model probability, up to `count` equal-count bins of 25 or more, for the calibration chart.
// -> [{ prob, implied, actual, actualCI, n, wins }]: mean model probability, mean
// chance the bookie odds imply (1 / odds, margin included), and how often the
// selection actually won (pushes left out).
export function calibration(bets, { count = 10, ...opts } = {}) {
  const decided = bets.filter(b => b.push < 1);
  const sorted = [...decided].sort((a, b) => a.prob - b.prob);
  const k = Math.max(1, Math.min(count, Math.floor(sorted.length / 25) || 1));
  const won = b => b.win / (1 - b.push);
  const out = [];
  for (let i = 0; i < k; i++) {
    const part = sorted.slice(Math.round(i * sorted.length / k), Math.round((i + 1) * sorted.length / k));
    if (!part.length) continue;
    out.push({ n: part.length, wins: part.reduce((a, b) => a + b.win, 0), prob: mean(part.map(b => b.prob)), implied: mean(part.map(b => 1 / b.back)),
               actual: mean(part.map(won)), actualCI: gameBootstrap(part, won, opts) });
  }
  return out;
}

// --- model vs market --------------------------------------------------------
// Logistic regression of the result on the model's probability and the
// bookie's:   logit P(win) = a + bModel * logit(model) + bMarket * logit(1 / odds)
// bModel near 1 with bMarket near 0 says the model's price is the truth and
// the market adds nothing; the reverse says the market already knows what the
// model does, and a model "edge" is mostly model error. `weight` is the
// model's share of the two. A light ridge penalty keeps small or collinear
// samples from running off (the two probabilities are strongly correlated).
export const FIT_MIN_BETS = 150;
export const FIT_MIN_GAMES = 20;

export function fitBlend(bets, { ridge = 1e-3, iters = 40 } = {}) {
  const rows = bets.filter(b => b.push < 1).map(b => ({
    x: [1, logit(b.prob), logit(1 / b.back)], y: b.win / (1 - b.push), w: 1 - b.push }));
  const games = new Set(bets.map(b => b.game)).size;
  if (rows.length < FIT_MIN_BETS || games < FIT_MIN_GAMES) return null;
  let beta = [0, 0.5, 0.5], H = null;
  for (let it = 0; it < iters; it++) {
    const g = [0, 0, 0];
    H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const { x, y, w } of rows) {
      const p = sigmoid(beta[0] * x[0] + beta[1] * x[1] + beta[2] * x[2]);
      const v = Math.max(p * (1 - p), 1e-6) * w;
      for (let i = 0; i < 3; i++) {
        g[i] += w * (y - p) * x[i];
        for (let j = 0; j < 3; j++) H[i][j] += v * x[i] * x[j];
      }
    }
    for (let i = 1; i < 3; i++) { g[i] -= ridge * rows.length * beta[i]; H[i][i] += ridge * rows.length; }
    const step = solve3(H, g);
    if (!step) return null;
    beta = beta.map((b, i) => b + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const [a, bModel, bMarket] = beta;
  const total = bModel + bMarket;
  const fit = {
    a, bModel, bMarket, n: rows.length, games,
    weight: total > 0 ? clamp(bModel / total, 0, 1) : null,
    weightCI: null,
    prob: b => sigmoid(a + bModel * logit(b.prob) + bMarket * logit(1 / b.back)),
  };
  // 90% range for the weight, from the fit's own covariance (delta method).
  // It treats bets as independent, so it is if anything a little narrow.
  const cM = solve3(H, [0, 1, 0]), cK = solve3(H, [0, 0, 1]);
  if (fit.weight != null && cM && cK) {
    const dM = bMarket / total ** 2, dK = -bModel / total ** 2;
    const se = Math.sqrt(Math.max(0, dM * dM * cM[1] + 2 * dM * dK * cM[2] + dK * dK * cK[2]));
    fit.weightCI = [clamp(bModel / total - 1.645 * se, 0, 1), clamp(bModel / total + 1.645 * se, 0, 1)];
  }
  // Expected return per unit at the bookie odds under the fitted probability
  fit.expected = b => { const p = fit.prob(b); return p * (b.back - 1) * (1 - b.commission) - (1 - p); };
  return fit;
}

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

// The lowest minimum edge (from `thresholds`) at which betting everything at
// or above it has returned a profit we can tell from zero: at least `minBets`
// bets and the whole 90% interval above zero. null when there isn't one yet.
export function profitableFrom(bets, { thresholds = [0, 0.02, 0.05, 0.1, 0.15, 0.2], minBets = 50, ...opts } = {}) {
  for (const t of thresholds) {
    const above = bets.filter(b => b.edge >= t);
    if (above.length < minBets) break;
    const ci = gameBootstrap(above, profit, opts);
    if (ci && ci[0] > 0) return { ...summarise(above, opts), minEdge: t };
  }
  return null;
}
