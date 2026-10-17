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
// `lowPct` moves the ends: 0.01 gives the 1st and 99th percentiles (ask for
// more `reps` to place them). null with fewer than `minGames` games.
export function gameBootstrap(bets, value, { reps = 400, seed = 7, minGames = 5, lowPct = 0.05 } = {}) {
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
  return [means[Math.floor(reps * lowPct)], means[Math.ceil(reps * (1 - lowPct)) - 1]];
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
// aligned on zero, up to `cap` above zero and down to `floor` below it.
// Everything under `floor` is one bin; over `cap` the bins widen along
// EDGE_LADDER, so the tail is never lumped into one. mode 'count': `count`
// bins with the same number of bets in each.
// -> [{ lo, hi, bets }] in edge order, empty bins left out.
export function binByEdge(bets, { mode = 'width', width = 0.02, cap = 1, floor = -0.3, count = 10 } = {}) {
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
  // Cut points: the floor, steps of `width` up to the cap, then the ladder
  const minIdx = Math.round(floor / width), maxIdx = Math.round(cap / width);
  const cuts = [-Infinity];
  for (let i = minIdx; i <= maxIdx; i++) cuts.push(Math.round(i * width * 1e6) / 1e6);
  cuts.push(...EDGE_LADDER.filter(e => e > maxIdx * width + 1e-9), Infinity);
  const parts = cuts.slice(0, -1).map(() => []);
  for (const b of bets) {
    let i = cuts.length - 2;
    while (i > 0 && b.edge < cuts[i] - 1e-9) i--;
    parts[i].push(b);
  }
  return parts.map((p, i) => ({ lo: cuts[i], hi: cuts[i + 1], bets: p })).filter(b => b.bets.length);
}

// Winners against what each price expected, over every bet that wasn't a full
// push: { n, wins, model, bookie }. `bookie` sums 1 / odds, so it carries the
// margin and sits a little above a fair count. A count, not a return, so it
// settles down on far fewer bets than RoI does.
export function expectedWins(bets) {
  const decided = bets.filter(b => b.push < 1);
  return {
    n: decided.length,
    wins: decided.reduce((a, b) => a + b.win, 0),
    model: decided.reduce((a, b) => a + b.prob, 0),
    bookie: decided.reduce((a, b) => a + 1 / b.back, 0),
  };
}

// Bins for the calibration chart, up to `count` equal-count bins of 25 or
// more, by model probability or (by: 'implied') by the bookie's implied chance.
// -> [{ prob, implied, actual, actualCI, n, wins }]: mean model probability, mean
// chance the bookie odds imply (1 / odds, margin included), and how often the
// selection actually won (pushes left out).
export function calibration(bets, { count = 10, by = 'prob', ...opts } = {}) {
  const decided = bets.filter(b => b.push < 1);
  const key = by === 'implied' ? b => 1 / b.back : b => b.prob;
  const sorted = [...decided].sort((a, b) => key(a) - key(b));
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

// --- by team ----------------------------------------------------------------
// One record per team per game, from bets that also carry { sport, team,
// opponent, date, kind, source }: how many of the team's listed players the
// model and the bookie each expected to score and how many did, and the team's
// head-to-head price. Where a game's scorers were priced from two sources, the
// one with more players listed is used, so nobody is counted twice.
// -> [{ key, sport, team, opponent, game, date, n, model, bookie, actual, h2h }]
//    h2h: { model, bookie, won } or null; n = 0 when no scorers were priced.
export function teamGames(bets) {
  const games = new Map();
  const at = b => {
    const id = `${b.game}|${b.team}`;
    if (!games.has(id)) games.set(id, { key: `${b.sport}|${b.team}`, sport: b.sport, team: b.team, opponent: b.opponent,
                                       game: b.game, date: b.date, bySource: new Map(), h2h: null });
    return games.get(id);
  };
  for (const b of bets) {
    if (!b.team || b.push >= 1) continue;
    if (b.kind === 'anytime_scorer') {
      const g = at(b), s = g.bySource.get(b.source) || { n: 0, model: 0, bookie: 0, actual: 0 };
      s.n += 1; s.model += b.prob; s.bookie += 1 / b.back; s.actual += b.win;
      g.bySource.set(b.source, s);
    } else if (b.kind === 'match_odds') {
      const g = at(b);
      if (!g.h2h || b.source === 'book') g.h2h = { model: b.prob, bookie: 1 / b.back, won: b.win / (1 - b.push) };
    }
  }
  return [...games.values()].map(({ bySource, ...g }) => {
    const best = [...bySource.values()].sort((a, b) => b.n - a.n)[0] || { n: 0, model: 0, bookie: 0, actual: 0 };
    return { ...g, ...best };
  }).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// The bookie's count carries a margin and the model sits at its own level
// against it, so a team is compared with what is usual in its sport:
//   lean    = (model / bookie) over the sport's own model / bookie, less 1
//   outcome = (actual / bookie) over the sport's own actual / bookie, less 1
// If the model's view of a team is right, outcome follows lean one for one;
// if the bookie's is, outcome ignores it. Rows are team-games or sums of them.
export function sportLevels(rows) {
  const levels = new Map();
  for (const g of rows) {
    if (!g.n) continue;
    const l = levels.get(g.sport) || { model: 0, bookie: 0, actual: 0 };
    l.model += g.model; l.bookie += g.bookie; l.actual += g.actual;
    levels.set(g.sport, l);
  }
  return levels;
}

export function leanOf(row, levels) {
  const l = levels.get(row.sport);
  if (!row.n || !l || !(l.model > 0) || !(row.bookie > 0)) return { lean: null, outcome: null };
  return { lean: (row.model / row.bookie) / (l.model / l.bookie) - 1,
           outcome: l.actual > 0 ? (row.actual / row.bookie) / (l.actual / l.bookie) - 1 : null };
}

// Line through points { x: lean, y: outcome, w: weight, game }, weighted, with
// a 90% range for the slope from resampling whole games (the two teams in a
// game share its scoring). slope 1: the model's lean is the truth; 0: the
// bookie's price is. null with fewer than LEAN_MIN_POINTS points.
export const LEAN_MIN_POINTS = 12;

export function leanFit(points, { reps = 400, seed = 11 } = {}) {
  const line = pts => {
    let w = 0, x = 0, y = 0;
    for (const p of pts) { w += p.w; x += p.w * p.x; y += p.w * p.y; }
    if (!(w > 0)) return null;
    x /= w; y /= w;
    let sxx = 0, sxy = 0;
    for (const p of pts) { sxx += p.w * (p.x - x) ** 2; sxy += p.w * (p.x - x) * (p.y - y); }
    return sxx > 1e-9 ? { slope: sxy / sxx, intercept: y - sxy / sxx * x } : null;
  };
  const fit = points.length >= LEAN_MIN_POINTS ? line(points) : null;
  if (!fit) return null;
  const byGame = new Map();
  for (const p of points) byGame.set(p.game, [...(byGame.get(p.game) || []), p]);
  const games = [...byGame.values()], rand = rng(seed + games.length), slopes = [];
  for (let r = 0; r < reps; r++) {
    const sample = [];
    for (let i = 0; i < games.length; i++) sample.push(...games[(rand() * games.length) | 0]);
    const f = line(sample);
    if (f) slopes.push(f.slope);
  }
  slopes.sort((a, b) => a - b);
  return { ...fit, n: points.length, games: games.length,
           slopeCI: slopes.length >= reps / 2 ? [slopes[Math.floor(slopes.length * 0.05)], slopes[Math.ceil(slopes.length * 0.95) - 1]] : null };
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

// --- what counts as a bet ---------------------------------------------------
// For these a bet also carries { market, prop, source, checks }:
//   market   the market at one line, shared by its sides; null for scorers
//   prop     what is being decided: a game's head-to-head, line or total, or
//            one player's scorer bet; null when it can't be told
//   source   'book' / 'betfair'
//   checks   how many checks priced it

// A market nobody is making: the back prices on offer add up to well over
// 100% (both sides of a line at $1.03). The model "beats" a price like that
// every time, so the whole market is left out. One with a single side priced
// can't be judged and is kept. -> { kept, dropped }
export const MAX_BOOK = 1.15;

export function dropEmptyMarkets(bets, { maxBook = MAX_BOOK } = {}) {
  const books = new Map();
  for (const b of bets) {
    if (b.market == null) continue;
    const m = books.get(b.market) || { n: 0, sum: 0 };
    m.n += 1; m.sum += 1 / b.back;
    books.set(b.market, m);
  }
  const empty = b => { const m = b.market != null && books.get(b.market); return !!m && m.n > 1 && m.sum > maxBook; };
  const kept = bets.filter(b => !empty(b));
  return { kept, dropped: bets.length - kept.length };
}

// One bet per decision. The two sides of a market are one result seen twice,
// a game's alternate lines are near enough the same bet again, and a price
// from both Betfair and the bookmakers is the same bet twice. For each `prop`
// this keeps one market (the bookmakers' before Betfair's, their standard
// line before an alternate one, then the line priced over the most checks:
// the main one) and, of its sides, the one the model likes best. Bets with no
// `prop` are all kept.
export function onePerMarket(bets) {
  const props = new Map();
  bets.forEach((b, i) => {
    if (b.prop == null) return;
    const markets = props.get(b.prop) || new Map();
    const key = b.market ?? `source:${b.source}`;
    const m = markets.get(key) || { book: b.source === 'book', standard: !/:alternate_/.test(key), checks: 0, first: i, best: i };
    m.checks = Math.max(m.checks, b.checks ?? 1);
    if (b.edge > bets[m.best].edge) m.best = i;
    markets.set(key, m);
    props.set(b.prop, markets);
  });
  const keep = new Set();
  for (const markets of props.values()) {
    const [main] = [...markets.values()].sort((a, b) =>
      b.book - a.book || b.standard - a.standard || b.checks - a.checks || a.first - b.first);
    keep.add(main.best);
  }
  return bets.filter((b, i) => b.prop == null || keep.has(i));
}

// --- betting rules ----------------------------------------------------------
// A rule is a range of model edge, { edgeLo, edgeHi }: the low end included,
// the high end not. The odds it applies to are whatever the bets passed in
// were narrowed to.
// A rule is only called once it has this much behind it. The range comes from
// resampling games, and from a couple of dozen games it runs too narrow: one
// hot round then reads as a profit clear of zero.
export const RULE_MIN_BETS = 30;
export const RULE_MIN_GAMES = 30;

export const inRule = (b, r) => b.edge >= r.edgeLo && b.edge < r.edgeHi;

// Edge cuts fitted to the bets, the way the Best Bets page fits its edge
// bands: bands start as narrow as the ladder and neighbours are joined until
// each holds enough bets, so the cuts are few and wide while the sample is
// small, and reach further up and get finer as it grows. Enough is a share of
// the positive-edge bets (about `maxRows` bands at most), never under
// `minBets`. A top band left short joins the one below. -> ascending, from 0.
export const EDGE_LADDER = [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2, 3];

export function edgeCuts(bets, { ladder = EDGE_LADDER, maxRows = 12, minBets = 5 } = {}) {
  const edges = bets.filter(b => b.edge >= 0).map(b => b.edge);
  const need = Math.max(minBets, Math.ceil(edges.length / maxRows));
  const cuts = [0];
  let open = 0;
  for (let i = 1; i < ladder.length; i++) {
    open += edges.filter(e => e >= ladder[i - 1] && e < ladder[i]).length;
    if (open >= need) { cuts.push(ladder[i]); open = 0; }
  }
  const top = cuts[cuts.length - 1];
  if (cuts.length > 1 && edges.filter(e => e >= top).length < need) cuts.pop();
  return cuts;
}

// The rules a set of cuts makes.
//   'rule'  edge at least a cut: how a bettor sets a rule. They overlap.
//   'band'  edge between one cut and the next, and everything under the
//           first: where inside a rule the return comes from. They don't.
export function ruleRanges(cuts, mode = 'rule') {
  if (mode !== 'band') return cuts.map(lo => ({ edgeLo: lo, edgeHi: Infinity }));
  const e = [-Infinity, ...cuts, Infinity];
  return e.slice(0, -1).map((lo, i) => ({ edgeLo: lo, edgeHi: e[i + 1] }));
}

// What a set of bets has done under a rule: as summarise(), plus the units
// won, the return with its best game taken out (a rule living off one game
// falls over here) and a verdict:
//   'thin'             too few bets or games to say anything
//   'ahead' / 'behind' the whole 90% range is one side of zero
//   'open'             the range spans zero
// The range is skipped for a thin rule unless `thinRange` asks for it.
export function ruleStats(bets, { minBets = RULE_MIN_BETS, minGames = RULE_MIN_GAMES, thinRange = false, ...opts } = {}) {
  const games = new Map();
  let units = 0;
  for (const b of bets) {
    const p = profit(b), g = games.get(b.game) || [0, 0];
    units += p; g[0] += p; g[1] += 1;
    games.set(b.game, g);
  }
  let best = null;
  for (const g of games.values()) if (!best || g[0] > best[0]) best = g;
  const thin = bets.length < minBets || games.size < minGames;
  const roiCI = thin && !thinRange ? null : gameBootstrap(bets, profit, opts);
  const withClv = bets.filter(b => b.clv != null);
  return {
    n: bets.length, games: games.size, units,
    wins: bets.reduce((a, b) => a + b.win, 0),
    edge: mean(bets.map(b => b.edge)),
    roi: bets.length ? units / bets.length : null,
    roiCI,
    restRoi: games.size > 1 ? (units - best[0]) / (bets.length - best[1]) : null,
    clv: mean(withClv.map(b => b.clv)), clvN: withClv.length,
    verdict: thin || !roiCI ? 'thin' : roiCI[0] > 0 ? 'ahead' : roiCI[1] < 0 ? 'behind' : 'open',
  };
}

// One row per rule, at cuts fitted to these bets unless `cuts` are given.
// -> [{ rule, bets, ...ruleStats }]
export function ruleRows(bets, { mode = 'rule', cuts = edgeCuts(bets), ...opts } = {}) {
  return ruleRanges(cuts, mode).map(rule => {
    const inside = bets.filter(b => inRule(b, rule));
    return { rule, bets: inside, ...ruleStats(inside, opts) };
  });
}

// The rule (edge at least a cut) with the best-supported return: the highest
// low end of the 90% range among those that aren't thin. -> its row plus
// { tried }, or null when every rule is thin. It is the best of `tried`
// rules, so its return flatters it.
export function bestRule(bets, opts) {
  let best = null, tried = 0;
  for (const row of ruleRows(bets, opts)) {
    if (row.verdict === 'thin') continue;
    tried += 1;
    if (!best || row.roiCI[0] > best.roiCI[0]) best = row;
  }
  return best && { ...best, tried };
}
