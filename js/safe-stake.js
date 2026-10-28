// safe-stake.js — how much of the bank to put on a bet, from how the bets
// like it have done. Shared by the Best Bets page (a stake on each current
// bet) and its analysis page (the edge × odds grid). No DOM, so it can be
// exercised under Node.
//
// With flat stakes the chance of being behind after many bets doesn't depend
// on the stake: the stake sets how deep the dips on the way get. So "safe"
// covers two risks apart:
//   1. the edge is smaller than it looks. The stake is sized off the low end
//      of the bin's return, and only once that low end is above zero. The low
//      end is the more cautious of two: resampling whole games (bets in one
//      game win and lose together) and an exact count of winners against
//      what break-even odds expect (right for long odds, where a handful of
//      winners decides it and resampling them misleads).
//   2. a bad run on the way. A fraction k of the Kelly stake on that edge.
//      At k, the chance of ever falling to x of the bank is about
//      x^(2/k - 1), so k = 2 / (1 + ln(ruin) / ln(1 - drawdown)).
// Above some edge (or odds) bins can turn to losing again: the model's
// biggest edges are often its own error. Where that loss is clear of luck,
// bets past that point are outliers and get no stake.
import { SPORT_LABELS, KIND_LABELS, isProp } from './best-bets-shared.js';
import { profit, gameBootstrap, RULE_MIN_BETS, RULE_MIN_GAMES } from './roi-stats.js';
import { priceAt, closeAt, hasRealClose, lineMoved } from './best-bets-filters.js';

// --- rows from /api/best_bets/analysis -----------------------------------------

export const kindKey = r => r.market_kind + (r.market_kind === 'match_odds' && r.three_way ? ':3' : '');
export const kindLabel = k => k === 'match_odds:3' ? 'Match odds (3-way)' : KIND_LABELS[k] || k;
export const groupLabel = g => { const [s, k] = g.split('|'); return `${SPORT_LABELS[s] || s} · ${kindLabel(k)}`; };

// Bookmaker rows come from The Odds API ('oddsapi', 'oddsapi-lines'); the rest are Betfair's.
export const sourceKey = r => r.source.startsWith('oddsapi') ? 'book' : 'betfair';

// A market at one line, whichever side: away +3.5 is the same line as home -3.5.
// Scorers are priced one side only, so they have none. A player prop is one
// player's line, Over and Under (market_id ends in the side).
export const isScorer = r => r.market_kind.endsWith('scorer');
export const marketKey = r => r.market_id == null || isScorer(r) ? null
  : isProp(r) ? (r.player_id == null ? null : `${r.market_id.replace(/:(over|under)$/, '')}|${r.player_id}|${r.line ?? ''}`)
  : `${r.market_id}|${r.market_kind === 'handicap' && r.side === 'away' ? -r.line : r.line ?? ''}`;
// What is being decided: one head-to-head, line and total a game, one bet a
// scorer, one a player's stat (every line and side of it). Null when the data
// doesn't say (an older backend), so nothing is merged.
export const propKey = r => r.market_id == null ? null
  : isProp(r) ? (r.player_id == null ? null : `${r.sport}:${r.game_id}|${kindKey(r)}|${r.player_id}`)
  : !isScorer(r) ? `${r.sport}:${r.game_id}|${kindKey(r)}`
  : r.player_id == null ? null : `${r.sport}:${r.game_id}|${kindKey(r)}|${r.player_id}|${r.line ?? ''}`;

// The columnar response -> one object per row, with its kind and group.
export function decodeRows(data) {
  const cols = data.columns;
  return data.rows.map(row => {
    const r = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    r.kind = kindKey(r);
    r.group = `${r.sport}|${r.kind}`;
    return r;
  });
}

// A decoded row as a bet (see roi-stats.js), at the odds when first priced
// ('open'), the closing odds ('close'), or while its median edge was positive
// ('first', 'avg' time-weighted, 'peak'), taken at the best single bookmaker's
// price (basis 'book'; Betfair rows at the exchange's) or the median across
// them ('avg'). The bet is chosen at the median either way: its edge and back
// (what the odds range, odds bands and stake pools read, and the bookie's
// implied chance) are the median's, so the same bets fall in the same places
// under both and only the returns differ. taken: the price it is taken at,
// which profit() pays out at. A row with no best-bookmaker price recorded is
// taken at the median, marked fallback. A selection priced once has no CLV;
// CLV is from the stage's price to the close (from the open, at the close).
// A main line whose line moved is judged against the closing price at its
// own line (closeAt): moved, linePts (how far the line moved its way),
// closeLine, lineSrc; clvPrice is against its own last price, as it was
// judged before line moves were followed.
export function toBet(r, stage = 'open', basis = 'book') {
  const at = priceAt(r, stage, basis);
  const from = priceAt(r, stage === 'close' ? 'open' : stage, basis).back;
  return {
    game: `${r.sport}:${r.game_id}`, sport: r.sport, kind: r.kind, group: r.group,
    edge: at.edge, prob: r[`${stage}_prob`], back: r[`${stage}_back`], taken: at.back, commission: r.commission,
    fallback: at.fallback,
    win: r.win_frac, push: r.push_frac,
    team: r.team, opponent: r.opponent, date: r.kickoff, source: sourceKey(r),
    clv: hasRealClose(r) ? from / closeAt(r, basis).back - 1 : null,
    clvPrice: r.n_checks > 1 ? from / priceAt(r, 'close', basis).back - 1 : null,
    moved: lineMoved(r), linePts: r.line_pts ?? null, closeLine: r.close_line ?? null, lineSrc: r.lc_src ?? null,
    market: marketKey(r), prop: propKey(r), checks: r.n_checks,
    row: r,   // for naming the bet when a group of bets is listed
  };
}

// Outlier prices (migration 036; betfair-api outliers.py): the gaps between
// the best price and the median of the other bookies that a threshold can be,
// and each selection's first price at each (disc_ladder: {cut: [best price,
// median edge, book, median, the other books' median]}; the last missing from
// an older backend).
export const OUTLIER_CUTS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.75, 1.00, 1.50, 2.00, 3.00];
export const cutKey = cut => cut.toFixed(2);

// A decoded row as a bet on its outlier price: taken at the best bookie's
// price the first time its gap reached `cut`, or null if it never did. edge
// and back are the median's then, as toBet's; bookEdge is the model's
// expected return at the price taken. gap: the price taken over the other
// books' median, less 1 (null when not sent).
export function outlierBet(r, cut) {
  const e = r.disc_ladder?.[cutKey(cut)];
  if (!e || e[0] == null) return null;
  const [taken, edge, book, back, cons = null] = e;
  const prob = edge != null && back ? (1 + edge) / back : null;
  return {
    game: `${r.sport}:${r.game_id}`, sport: r.sport, kind: r.kind, group: r.group,
    edge, prob, back: back ?? taken, taken, book, bookEdge: prob == null ? null : prob * taken - 1,
    gap: cons ? taken / cons - 1 : null,
    commission: r.commission, fallback: false, win: r.win_frac, push: r.push_frac,
    team: r.team, opponent: r.opponent, date: r.kickoff, source: sourceKey(r), clv: null,
    market: marketKey(r), prop: propKey(r), checks: r.n_checks, row: r,
  };
}

// --- settings -------------------------------------------------------------------

// conf: how sure the low end of a bin's return is (one-sided). ruin / drawdown:
// the chance, at most, of ever falling by `drawdown` of the bank if the edge
// is only that low end.
export const RISK_LEVELS = {
  low:    { label: 'Low',    conf: 0.99, ruin: 0.01, drawdown: 0.25,
            text: '99% sure of the edge; under 1% chance of ever losing a quarter of the bank' },
  medium: { label: 'Medium', conf: 0.95, ruin: 0.01, drawdown: 0.5,
            text: '95% sure of the edge; under 1% chance of ever losing half the bank' },
  high:   { label: 'High',   conf: 0.80, ruin: 0.05, drawdown: 0.5,
            text: '80% sure of the edge; under 5% chance of ever losing half the bank' },
};
export const kellyFraction = risk => 2 / (1 + Math.log(risk.ruin) / Math.log(1 - risk.drawdown));

// Bins: edge bands by bookie-odds bands, set in advance rather than fitted to
// results. Finer ones are for looking closer as results come in: each cell
// then needs longer to prove anything, and more cells means more that look
// good by luck.
// Every level reaches past 30%: big edges are where model error shows, so
// they get rows of their own rather than one lump.
const twoPoint = Array.from({ length: 16 }, (_, i) => Math.round(i * 2) / 100);
export const BIN_DETAIL = {
  coarse: { label: 'Coarse', edge: [0, 0.05, 0.1, 0.2, 0.3, 0.5, Infinity], odds: [1, 2, 3, 5, 10, Infinity] },
  medium: { label: 'Medium', edge: [0, 0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, Infinity], odds: [1, 1.5, 2, 2.5, 3, 4, 5, 7, 10, Infinity] },
  fine:   { label: 'Fine', edge: [...twoPoint, 0.35, 0.4, 0.45, 0.5, 0.6, 0.75, 1, 1.5, Infinity], odds: [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50, Infinity] },
};

// Index of the band [cuts[i], cuts[i + 1]) holding x, or -1.
export function bandIndex(cuts, x) {
  if (!(x >= cuts[0])) return -1;
  for (let i = cuts.length - 2; i >= 0; i--) if (x >= cuts[i]) return i;
  return -1;
}
const whole = x => `${Math.round(x * 100)}`;
const price = x => `$${+x.toFixed(2)}`;
export const edgeBandLabel = (cuts, i) => isFinite(cuts[i + 1]) ? `edge ${whole(cuts[i])}–${whole(cuts[i + 1])}%` : `edge ${whole(cuts[i])}%+`;
export const oddsBandLabel = (cuts, i) => isFinite(cuts[i + 1]) ? `${price(cuts[i])}–${price(cuts[i + 1])}` : `${price(cuts[i])}+`;

// --- one bin --------------------------------------------------------------------

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// --- the range of a bin's return ----------------------------------------------------
// Each bet's break-even chance is q = 1 / (1 + profit on a win). If the bets
// truly win θ times as often as that, every one returns θ - 1. The wins are
// then a sum of independent coin flips with chances θ·q, so how many there
// were bounds θ exactly however few there are: one winner from 30 bets at $15
// (two expected at break-even) is no evidence of a loss.

// P(wins <= k) for chances ps: exact while the spread is small (rare events),
// normal with a continuity correction once it is wide.
function winsAtMost(ps, k) {
  if (k < 0) return 0;
  const mu = ps.reduce((a, p) => a + p, 0), v = ps.reduce((a, p) => a + p * (1 - p), 0);
  if (v > 40) return 0.5 * erfc(-(k + 0.5 - mu) / Math.sqrt(v) / Math.SQRT2);
  const dist = new Float64Array(k + 2);   // [0..k] exactly that many, k + 1: more than k
  dist[0] = 1;
  for (const p of ps) {
    dist[k + 1] += dist[k] * p;
    for (let j = k; j >= 1; j--) dist[j] = dist[j] * (1 - p) + dist[j - 1] * p;
    dist[0] *= 1 - p;
  }
  let sum = 0;
  for (let j = 0; j <= k; j++) sum += dist[j];
  return sum;
}

function erfc(x) {   // Numerical Recipes erfcc, |error| < 1.2e-7
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const r = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851526 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

// -> [low, high] of the return at the one-sided level `lowPct`, or null with
// no decided bets.
export function exactBounds(bets, lowPct) {
  const taken = b => b.taken ?? b.back;
  const decided = bets.filter(b => b.push < 1 && taken(b) > 1);
  if (!decided.length) return null;
  const qs = decided.map(b => 1 / (1 + (taken(b) - 1) * (1 - (b.commission || 0))));
  const wins = Math.round(decided.reduce((a, b) => a + b.win, 0));
  const top = 0.999 / Math.min(...qs);
  const at = th => qs.map(q => Math.min(0.999, th * q));
  // The θ where f, which rises with θ, reaches `target`
  const solve = (f, target) => {
    let lo = 0, hi = top;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (f(mid) < target) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };
  // low: the θ at which this many wins or more is a lowPct chance; high: this many or fewer
  const low = wins === 0 ? 0 : solve(th => 1 - winsAtMost(at(th), wins - 1), lowPct);
  const high = winsAtMost(at(top), wins) > lowPct ? top : solve(th => 1 - winsAtMost(at(th), wins), 1 - lowPct);
  return [low - 1, high - 1];
}

// The more cautious of resampling games and the exact count, at each end.
// Under five games there is nothing to resample, so the count alone.
export function returnRange(bets, lowPct) {
  const boot = gameBootstrap(bets, profit, { lowPct, reps: lowPct < 0.05 ? 2000 : 400 });
  const exact = exactBounds(bets, lowPct);
  if (!boot || !exact) return boot || exact;
  return [Math.min(boot[0], exact[0]), Math.max(boot[1], exact[1])];
}

// What a bin's bets have done, and the verdict at the risk level:
//   'thin'    too few bets or games to call (RULE_MIN_BETS / RULE_MIN_GAMES)
//   'ahead'   proven profitable: the low end is above zero
//   'behind'  proven losing: the high end is below zero
//   'open'    the range spans zero: unproven either way
// `callThin` calls a thin bin all the same (and `thin` says it is): with few
// games the range runs narrow, so a call on it is a lot less sure than it reads.
export function binStats(bets, risk, { callThin = false } = {}) {
  const n = bets.length, games = new Set(bets.map(b => b.game)).size;
  const roi = n ? bets.reduce((a, b) => a + profit(b), 0) / n : null;
  const thin = n < RULE_MIN_BETS || games < RULE_MIN_GAMES;
  const ci = thin && !callThin ? null : returnRange(bets, 1 - risk.conf);
  return {
    bets, n, games, roi, thin,
    low: ci ? ci[0] : null, high: ci ? ci[1] : null,
    verdict: !ci ? 'thin' : ci[0] > 0 ? 'ahead' : ci[1] < 0 ? 'behind' : 'open',
    odds: median(bets.map(b => b.taken ?? b.back)), commission: median(bets.map(b => b.commission || 0)),
  };
}

// --- where value stops ------------------------------------------------------------
// A ceiling is where bets turn to losing again and the loss is clear of luck:
//   - every band from it up with CEILING_MIN_BETS over CEILING_MIN_GAMES has
//     lost (bands with fewer are read with the rest, not on their own)
//   - all the bets from it up, taken together, have lost even at the high end
//     of their CEILING_CONF range. The exact count of winners keeps a few
//     long-odds bets that haven't landed yet from reading as a loss.
//   - a band below it made a profit: value, then losses again
export const CEILING_MIN_BETS = 20;
export const CEILING_MIN_GAMES = 10;
export const CEILING_CONF = 0.9;
export const ceilingCounts = s => s.n >= CEILING_MIN_BETS && s.games >= CEILING_MIN_GAMES;

// Bands in ascending order -> the index of the lowest band that is a
// ceiling, or null.
export function ceilingOf(bands) {
  let top = bands.length;   // the bands from here up that count have all lost
  for (let i = bands.length - 1; i >= 0; i--) {
    if (!ceilingCounts(bands[i])) continue;
    if (bands[i].roi < 0) top = i;
    else break;
  }
  for (let i = top; i < bands.length; i++) {
    if (!ceilingCounts(bands[i])) continue;   // a ceiling starts at a band that lost
    const above = bands.slice(i).flatMap(s => s.bets);
    if (new Set(above.map(b => b.game)).size < CEILING_MIN_GAMES) break;
    const range = returnRange(above, 1 - CEILING_CONF);
    if (range && range[1] < 0) return bands.slice(0, i).some(s => ceilingCounts(s) && s.roi > 0) ? i : null;
  }
  return null;
}

// --- a grid of bins -----------------------------------------------------------------

// Bets (edge 0 and over) cut by edge band and odds band.
//   cells[i][j]  edge band i, odds band j
//   rows[i]      edge band i, any odds
//   cols[j]      any edge, odds band j
//   ceil         { edge, odds }: band index where the losses start, or null
export function binGrid(bets, risk, detail) {
  const E = detail.edge, O = detail.odds;
  const parts = E.slice(0, -1).map(() => O.slice(0, -1).map(() => []));
  for (const b of bets) {
    const i = bandIndex(E, b.edge), j = bandIndex(O, b.back);
    if (i >= 0 && j >= 0) parts[i][j].push(b);
  }
  const rows = parts.map(row => binStats(row.flat(), risk));
  const cols = O.slice(0, -1).map((_, j) => binStats(parts.flatMap(row => row[j]), risk));
  return {
    edge: E, odds: O, rows, cols,
    cells: parts.map(row => row.map(bs => binStats(bs, risk))),
    ceil: { edge: ceilingOf(rows), odds: ceilingOf(cols) },
  };
}

// --- the stake ------------------------------------------------------------------------

const Z99 = 2.326;   // one-sided 99%

// Fractional Kelly on `edge` (return per unit) at `back` odds:
// { frac, kelly, k, edge, betsToSure }, or null when there is no edge.
// betsToSure: bets at this edge until a profit is 99% sure.
export function kellyStake(edge, back, commission, risk) {
  const b = (back - 1) * (1 - (commission || 0));   // profit per unit on a win
  if (!(edge > 0) || !(b > 0)) return null;
  const k = kellyFraction(risk);
  const p = Math.min(0.999, (1 + edge) / (b + 1));
  const sd = (b + 1) * Math.sqrt(p * (1 - p));
  return { frac: k * edge / b, kelly: edge / b, k, edge, betsToSure: Math.ceil((Z99 * sd / edge) ** 2) };
}

// Everything a stake is worked out from, over settled bets (edge 0 and over):
// the bets themselves, by market, for each bet's own pool, and a grid per
// market and one for all markets for the outlier ceilings.
export function stakeModel(bets, riskKey, detailKey) {
  const risk = RISK_LEVELS[riskKey] || RISK_LEVELS.medium;
  const detail = BIN_DETAIL[detailKey] || BIN_DETAIL.coarse;
  const pos = bets.filter(b => b.edge >= 0);
  const groups = new Map();
  for (const b of pos) {
    if (!groups.has(b.group)) groups.set(b.group, []);
    groups.get(b.group).push(b);
  }
  return {
    risk, detail, k: kellyFraction(risk), bets: pos, byGroup: groups, pools: new Map(),
    all: binGrid(pos, risk, detail),
    grids: new Map([...groups].map(([g, bs]) => [g, binGrid(bs, risk, detail)])),
  };
}

// Each bet is judged on settled bets like it, made from its own edge and odds
// so nobody picks the bin after seeing results:
//   edge  0% up to its own, rounded up to a whole percent. Only bets the model
//         rated no better: if bigger edges do return more, the pool understates
//         this bet, so a profit proven on it is a floor.
//   odds  half its own up to the next step above (POOL_ODDS_STEPS), so a long
//         price is judged on long-ish prices, not mostly on favourites.
export const POOL_ODDS_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50, Infinity];

export function poolFor(bet) {
  return {
    edgeHi: Math.ceil(bet.edge * 100 - 1e-9) / 100,
    oddsLo: Math.max(1, bet.back / 2),
    oddsHi: POOL_ODDS_STEPS.find(s => s > bet.back),
  };
}
const poolLabel = p => `edge up to ${Math.round(p.edgeHi * 100)}% · ${price(p.oddsLo)}–${isFinite(p.oddsHi) ? price(p.oddsHi) : 'any'}`;

// One pool's stats, kept on the model: bets on the page share most pools.
function poolStats(model, scope, p) {
  const key = `${scope}|${p.edgeHi}|${p.oddsLo}|${p.oddsHi}`;
  if (!model.pools.has(key)) {
    const from = scope === 'all' ? model.bets : model.byGroup.get(scope) || [];
    const inPool = from.filter(b => b.edge < p.edgeHi + 1e-9 && b.back >= p.oddsLo && b.back < p.oddsHi);
    model.pools.set(key, binStats(inPool, model.risk, { callThin: true }));
  }
  return model.pools.get(key);
}

// The stake for one bet { group, edge, back, commission } (balance: the bank
// in dollars, or null). Its pool is tried in its own market, then in all
// markets, moving on only while the market's is unproven (its range spans
// zero). A proven loser stops it. Outliers (past a ceiling) get nothing. A pool
// is called however few bets it has; `thin` flags a stake that rests on fewer
// than RULE_MIN_BETS over RULE_MIN_GAMES.
// -> { frac, dollars, reason, used, path, warning, thin, outlier, kelly }
//   reason   null (a stake), 'negative', 'outlier', 'behind' or 'unproven'
//   path     [{ label, scope, stats }] each pool tried, in order
//   warning  the stake is from all markets though this market's own bets
//            have lost so far (unproven)
export function stakeFor(bet, model, balance = null) {
  const { detail } = model;
  const E = detail.edge, O = detail.odds;
  const ei = bandIndex(E, bet.edge), oi = bandIndex(O, bet.back);
  const none = (reason, extra = {}) => ({ frac: 0, dollars: balance ? 0 : null, reason, used: null, path: [], warning: false, thin: false, outlier: null, kelly: null, ...extra });
  if (ei < 0 || oi < 0) return none('negative');

  const own = model.grids.get(bet.group), all = model.all;
  const market = groupLabel(bet.group);

  const outlier = outlierOf(ei, oi, own, all, market);
  if (outlier) return none('outlier', { outlier });

  const p = poolFor(bet), pl = poolLabel(p);
  const tries = [
    { scope: 'market', label: `${market} · ${pl}`, stats: poolStats(model, bet.group, p) },
    { scope: 'all', label: `All markets · ${pl}`, stats: poolStats(model, 'all', p) },
  ];
  const path = [];
  let used = null;
  for (const t of tries) {
    path.push(t);
    if (t.stats.verdict === 'behind') return none('behind', { path, used: t });
    if (t.stats.verdict === 'ahead') { used = t; break; }
  }
  if (!used) return none('unproven', { path });

  const warning = used.scope === 'all' && path.some(t => t.scope === 'market' && t.stats.n && t.stats.roi < 0);
  const kelly = kellyStake(Math.min(used.stats.low, bet.edge), bet.taken ?? bet.back, bet.commission, model.risk);
  const frac = kelly ? kelly.frac : 0;
  return { frac, dollars: balance ? balance * frac : null, reason: kelly ? null : 'unproven', used, path, warning, thin: used.stats.thin, outlier: null, kelly };
}

// Past a ceiling on edge or odds. The market's own ceiling decides where it
// has one; where it has none, the all-markets ceiling does, unless the
// market's own band there has enough bets and made a profit.
function outlierOf(ei, oi, own, all, market) {
  for (const [dim, idx] of [['edge', ei], ['odds', oi]]) {
    const cuts = dim === 'edge' ? all.edge : all.odds;
    const label = i => dim === 'edge' ? edgeBandLabel(cuts, i) : `odds ${oddsBandLabel(cuts, i)}`;
    const mine = own?.ceil[dim];
    if (mine != null) {
      if (idx >= mine) return { dim, scope: market, from: cuts[mine], label: `${market}: bets from ${label(mine)} up have lost, clear of luck` };
      continue;
    }
    const band = own && (dim === 'edge' ? own.rows[idx] : own.cols[idx]);
    if (band && ceilingCounts(band) && band.roi >= 0) continue;
    const theirs = all.ceil[dim];
    if (theirs != null && idx >= theirs) return { dim, scope: 'All markets', from: cuts[theirs], label: `All markets: bets from ${label(theirs)} up have lost, clear of luck` };
  }
  return null;
}

// The stake for one row of /api/best_bets. Its edge is after any commission,
// so the commission comes back out of the row itself.
export function liveBet(r) {
  const p = r.model_prob, b = r.back - 1;
  const c = r.source === 'betfair' && p > 0 && b > 0 ? 1 - (r.edge + 1 - p) / (p * b) : 0;
  // Chosen at the median (r.median, where the page takes the best bookie's price), taken at r.back
  return { group: `${r.sport}|${kindKey(r)}`, edge: r.edge, back: r.median ?? r.back, taken: r.back,
           commission: Math.min(0.2, Math.max(0, c)) };
}
