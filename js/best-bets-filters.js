// best-bets-filters.js — the Best Bets filter settings and the price a bet is
// judged at. No DOM, so it can be exercised under Node; best-bets-prefs.js
// keeps the settings (browser + the account's profile) and draws the modal.
//
// Settings: { v, basis, odds, markets, sort, myTeams, liveStage, liveSort, liveFinal }
//   basis     'book': bets are taken at the best single bookmaker's price
//             (Betfair rows: the exchange's), 'avg': at the median across the
//             bookmakers. Either way a bet's edge - what says it has value, and
//             what the edge filters and bands read - is the edge at the median:
//             one generous bookmaker can't make a bet worth having.
//   odds      [min, max] as typed, '' for no limit: one range for every market
//   markets   { 'sport|kind': { on, edge: [min, max], calEdge: [min, max],
//             closeEdge: [min, max] } }, edges typed in percent: edge for the
//             model's edge, calEdge for the calibrated edge (calibrate.js),
//             closeEdge for the predicted-close edge (close-model.js),
//             whichever judge says
//   judge     'model' | 'cal' | 'close': which edge says a bet has value - the
//             model's own (the default, at the median price), the calibrated
//             one (the model's chance blended with the market's by how far
//             each market's settled bets have trusted it), or the
//             predicted-close one (the price taken against the fair closing
//             price predicted), both at the price taken
//   liveStage 'avg' | 'open' | 'best' | 'close': which of a live bet's prices
//             it is judged at. 'avg' (the default): the time-weighted average
//             while its median edge was positive, what betting it at a random
//             moment while it showed value would have got
//   sort      'best' | 'edge' | 'time': the upcoming list's order - the edge
//             at the best bookie's price (the default), at the median price,
//             start time
//   liveSort  'best' | 'edge' | 'time' | 'result' | 'ev' | 'chance': the Live
//             list's order - the edge at kickoff at the best bookie's price
//             (the default), at the median price, start time, where the bet
//             stands (won first, lost last), the live EV or the chance from here
//   liveFinal 'any' | 'hide' | 'only': Live bets whose game has finished but
//             which haven't settled yet - shown, hidden, or nothing else
//   outliers  'any' | 'only' | 'off': outlier prices (one bookie well above
//             the median of the others) are listed whatever their edge, in the
//             odds range, as each market's own rule (markets[key].out) says
//             ('any': "On"); 'only' lists nothing else; 'off' lists them only
//             when they have an edge too, like any bet
//   markets[key].out  { mode: 'paid' | 'custom' | 'off', gaps: { value, made,
//             none } }: which of the market's outliers count. 'paid' (the
//             default): where they've paid - each edge class's fitted
//             threshold (betfair-api outliers.py: the gap its settled outlier
//             bets have made the most profit at, none where they haven't paid or
//             are too few to judge); 'custom': the gap chosen for each class
//             (a key of OUT_CUTS, '' for none); 'off': none. A market's
//             outliers don't need its edge switch on
//   autoOpt   true: every market is kept on "Most profitable" (best-bets-
//             optimise.js), re-fitted whenever the settled bets or the
//             calibration come in, and after a change of price or judge.
//             On for new settings; changing a market's own rule turns it off
//   v         6: 2 moved the Live stage to 'avg' once; 3 dropped the old $10
//             odds cap (saved as ['', '10'], the old default) once; 4 turned
//             autoOpt on once for settings whose markets were never changed;
//             5 moved the edge sorts to the best bookie's; 6 gave every market
//             its outlier rule ('paid')
import { SPORT_LABELS, KIND_LABELS } from './best-bets-shared.js';

// kind as safe-stake.js kindKey: the NHL 60-minute (3-way) result apart from the moneyline
export const MARKETS = [
  ['nfl', 'match_odds', 'Head to head'], ['nfl', 'handicap', 'Line'], ['nfl', 'total', 'Total points'],
  ['nfl', 'anytime_scorer', 'Anytime TD'], ['nfl', 'multi_scorer', '2+ TDs'], ['nfl', 'pass_yds', 'Passing yards'],
  ['nfl', 'pass_tds', 'Passing TDs'], ['nfl', 'rec_yds', 'Receiving yards'], ['nfl', 'rush_yds', 'Rushing yards'],
  ['nhl', 'match_odds', 'Moneyline'], ['nhl', 'match_odds:3', '60-minute result (3-way)'], ['nhl', 'handicap', 'Puck line'],
  ['nhl', 'total', 'Total goals'], ['nhl', 'anytime_scorer', 'Anytime goal scorer'], ['nhl', 'assists', 'Assists'],
  ['nhl', 'points', 'Points'],
  ...['nrl', 'nrlw'].flatMap(s => [[s, 'match_odds', 'Head to head'], [s, 'handicap', 'Line'], [s, 'total', 'Total points'],
                                   [s, 'anytime_scorer', 'Anytime try scorer']]),
].map(([sport, kind, label]) => ({ key: `${sport}|${kind}`, sport, kind, label }));

export const BASES = { book: 'Best bookie', avg: 'Average bookie' };
export const LIVE_STAGES = ['avg', 'open', 'best', 'close'];
export const LIVE_STAGE_LABELS = { avg: 'average with value', open: 'opening', best: 'best', close: 'closing' };
const PREFS_VERSION = 6;
const DEFAULT_EDGE = ['10', ''];
const DEFAULT_CAL_EDGE = ['0', ''];   // any calibrated edge: it has the doubt in it already
const DEFAULT_ODDS = ['', ''];
export const OUTLIER_MODES = ['any', 'only', 'off'];
export const SORTS = ['best', 'edge', 'time'];
export const LIVE_SORTS = ['best', 'edge', 'time', 'result', 'ev', 'chance'];
export const LIVE_FINALS = ['any', 'hide', 'only'];
// Off unless switched on: the moneyline is the NHL head-to-head shown by default
const OFF_BY_DEFAULT = new Set(['nhl|match_odds:3']);

const isThreeWay = r => r.market_kind === 'match_odds' && !!(r.three_way ?? /3 way|60 min/i.test(r.market_name || ''));
export const marketOf = r => `${r.sport}|${r.market_kind}${isThreeWay(r) ? ':3' : ''}`;

export function marketLabel(key) {
  const m = MARKETS.find(x => x.key === key);
  if (m) return m.label;
  const kind = key.split('|')[1] || key;
  return kind === 'match_odds:3' ? 'Match odds (3-way)' : KIND_LABELS[kind] || kind;
}
export const marketTitle = key => `${SPORT_LABELS[key.split('|')[0]] || key.split('|')[0]} · ${marketLabel(key)}`;

export const defaultRule = key => ({ on: !OFF_BY_DEFAULT.has(key), edge: [...DEFAULT_EDGE], calEdge: [...DEFAULT_CAL_EDGE],
                                     closeEdge: [...DEFAULT_CAL_EDGE], out: defaultOut() });
export const JUDGES = ['model', 'cal', 'close'];

// A typed limit: a number (as typed) or '' for none
const typed = x => { const s = String(x ?? '').trim(); return s !== '' && Number.isFinite(+s) ? s : ''; };
const pair = (p, fallback) => Array.isArray(p) && p.length === 2 ? [typed(p[0]), typed(p[1])] : [...fallback];

export function defaultPrefs() {
  return { v: PREFS_VERSION, basis: 'book', odds: [...DEFAULT_ODDS], markets: {}, sort: 'best', myTeams: false, liveStage: 'avg',
           liveSort: 'best', liveFinal: 'any', outliers: 'any', judge: 'model', autoOpt: true, books: [], use: null };
}

// My bookies, as the bookies' prices name them ("PointsBet (AU)"). books:
// the favourites, whose prices every bet shows beside the best one. use: the
// bookies the viewer bets at - each bet shows and is staked at the best of
// theirs, judged all the same at every bookie's prices (best-bets-shared.js
// usedPrice) - or null for every bookie, the default until changed
// (bookies new to the feed are then used too).
const MAX_BOOKS = 30;
const bookList = b => (Array.isArray(b)
  ? [...new Set(b.filter(x => typeof x === 'string' && x.trim() && x.length <= 60))].slice(0, MAX_BOOKS) : []);

// Whether any market's rule has been changed from its default
const customised = markets => Object.entries(markets)
  .some(([key, rule]) => JSON.stringify(rule) !== JSON.stringify(defaultRule(key)));

// Anything (saved JSON, a profile column) -> valid settings
export function normalizePrefs(p) {
  const d = defaultPrefs();
  if (!p || typeof p !== 'object') return d;
  const markets = {};
  for (const [key, rule] of Object.entries(p.markets && typeof p.markets === 'object' ? p.markets : {})) {
    if (!/^[a-z]+\|[a-z_]+(:3)?$/.test(key) || !rule || typeof rule !== 'object') continue;
    markets[key] = { on: rule.on !== false, edge: pair(rule.edge, DEFAULT_EDGE), calEdge: pair(rule.calEdge, DEFAULT_CAL_EDGE),
                     closeEdge: pair(rule.closeEdge, DEFAULT_CAL_EDGE), out: normalizeOut(rule.out) };
  }
  const v = +p.v || 1;
  const odds = pair(p.odds, DEFAULT_ODDS);
  return {
    v: PREFS_VERSION,
    basis: p.basis === 'avg' ? 'avg' : 'book',
    // The old default cap ($10) goes once; a range typed since stays
    odds: v < 3 && odds[0] === '' && odds[1] === '10' ? ['', ''] : odds,
    markets,
    // Edge (at the median) was the only edge order before v5: it moves to
    // the best bookie's, the default since, once
    sort: v < 5 && p.sort === 'edge' ? 'best' : SORTS.includes(p.sort) ? p.sort : 'best',
    myTeams: !!p.myTeams,
    liveStage: v >= 2 && LIVE_STAGES.includes(p.liveStage) ? p.liveStage : 'avg',
    liveSort: v < 5 && p.liveSort === 'edge' ? 'best' : LIVE_SORTS.includes(p.liveSort) ? p.liveSort : 'best',
    liveFinal: LIVE_FINALS.includes(p.liveFinal) ? p.liveFinal : 'any',
    outliers: OUTLIER_MODES.includes(p.outliers) ? p.outliers : 'any',
    judge: JUDGES.includes(p.judge) ? p.judge : 'model',
    // Settings from before it: on where the markets were never set by hand
    autoOpt: v < 4 ? !customised(markets) : p.autoOpt !== false,
    books: bookList(p.books),
    use: Array.isArray(p.use) ? bookList(p.use) : null,
  };
}

// The settings the page kept before the filter modal ({ sort, myTeams,
// threeWay, basis: Live odds at, ranges: { 'edge-min': '10', ... } }): their
// edge range becomes every market's, their odds range the odds range.
export function migrateOldPrefs(old) {
  const p = defaultPrefs();
  if (!old || typeof old !== 'object') return p;
  const r = old.ranges || {};
  const has = id => typeof r[id] === 'string';
  const edge = has('edge-min') || has('edge-max') ? [typed(r['edge-min']), typed(r['edge-max'])] : [...DEFAULT_EDGE];
  if (has('odds-min') || has('odds-max')) p.odds = [typed(r['odds-min']), typed(r['odds-max'])];
  p.autoOpt = !(has('edge-min') || has('edge-max'));
  for (const m of MARKETS) p.markets[m.key] = { on: m.key === 'nhl|match_odds:3' ? !!old.threeWay : true, edge: [...edge] };
  p.sort = old.sort === 'time' ? 'time' : 'best';
  p.myTeams = !!old.myTeams;
  return p;
}

export const ruleFor = (prefs, key) => prefs.markets[key] || defaultRule(key);

// [lo, hi] from two typed ends, both included; a blank end open (0 / Infinity).
// Ends typed the wrong way round are read as the range between them.
export function typedRange([a, b], scale = 1) {
  const read = (x, blank) => { const v = parseFloat(x); return Number.isFinite(v) ? v * scale : blank; };
  const lo = read(a, 0), hi = read(b, Infinity);
  return lo <= hi ? [lo, hi] : [hi, lo];
}
// The edge range a market needs, of the edge that judges (prefs.judge)
export const edgeField = prefs => ({ cal: 'calEdge', close: 'closeEdge' }[prefs.judge] || 'edge');
export const edgeRangeOf = (prefs, key) =>
  typedRange(ruleFor(prefs, key)[edgeField(prefs)] ?? (prefs.judge === 'model' ? DEFAULT_EDGE : DEFAULT_CAL_EDGE), 0.01);
// What the judging edge is called
export const judgeLabel = prefs => ({ cal: 'calibrated edge', close: 'predicted-close edge' }[prefs.judge] || 'edge');
export const oddsRangeOf = prefs => typedRange(prefs.odds);
export const oddsTyped = prefs => { const [lo, hi] = oddsRangeOf(prefs); return lo > 0 || isFinite(hi); };
// A hair of slack so 10% typed still takes an edge stored as 0.09999...
export const inRange = (x, [lo, hi]) => x != null && x >= lo - 1e-9 && x <= hi + 1e-9;

// Whether a bet passes its market's switch and edge range, the odds range,
// and has value at all. edge: at the median; back: the price taken.
export function passesMarket(prefs, key, edge, back) {
  return passesEdge(prefs, key, edge) && inRange(back, oddsRangeOf(prefs));
}
// The same leaving the odds out (where the odds are looked at separately)
export function passesEdge(prefs, key, edge) {
  return ruleFor(prefs, key).on && edge != null && edge > 0 && inRange(edge, edgeRangeOf(prefs, key));
}

// An outlier price passes on the odds range alone: neither its edge nor its
// market's edge switch decides it (outliers 'off': it passes on its edge like
// any bet). outlier: whether it is one under these settings (outlierPasses,
// windowKeys); back: at the median.
export function passesBet(prefs, key, edge, back, outlier) {
  const out = prefs.outliers !== 'off' && !!outlier;
  if (prefs.outliers === 'only' && !out) return false;
  return passesMarket(prefs, key, edge, back) || (out && inRange(back, oddsRangeOf(prefs)));
}

// --- outliers ---------------------------------------------------------------
// One bookie well above the median of the others (betfair-api outliers.py):
// gap = the best price / the other books' median - 1. A check's edge class:
// the model's edge at the median price above 0 ('value'), above 0 only at
// the outlier price ('made'), neither ('none'). Each market and class has its
// own fitted threshold (the gap its settled outliers made the most profit at),
// none where they haven't paid or are too few to judge.
export const OUT_CLASSES = ['value', 'made', 'none'];
export const OUT_CLASS_LABELS = { value: 'Median edge > 0', made: 'Edge only at outlier price', none: 'No edge' };
export const OUT_CLASS_SHORT = { value: 'median edge', made: 'outlier price only', none: 'no edge' };
// The gaps a threshold can be (outliers.CUTS): each selection keeps its prices
// at each, so only these can be judged
export const OUT_CUTS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.75, 1.00, 1.50, 2.00, 3.00];
export const outCutKey = cut => (+cut).toFixed(2);
export const OUT_MODES = ['paid', 'custom', 'off'];
// A market's threshold before migration 041 while too few to judge (outliers.DEFAULT_CUT)
export const OUT_DEFAULT_CUT = 0.25;
const OUT_BANDS = [[2.5, '<2.5'], [5, '2.5-5'], [10, '5-10'], [Infinity, '10+']];   // outliers.BANDS
export const outBandOf = cons => OUT_BANDS.find(([top]) => cons < top)[1];

export const edgeClass = (edge, bookEdge) => (edge > 0 ? 'value' : bookEdge > 0 ? 'made' : 'none');
export function defaultOut() { return { mode: 'paid', gaps: { value: '', made: '', none: '' } }; }
function normalizeOut(o) {
  const out = defaultOut();
  if (!o || typeof o !== 'object') return out;
  out.mode = OUT_MODES.includes(o.mode) ? o.mode : 'paid';
  for (const cls of OUT_CLASSES) {
    const g = o.gaps?.[cls];
    out.gaps[cls] = g != null && g !== '' && OUT_CUTS.some(c => outCutKey(c) === outCutKey(g)) ? outCutKey(g) : '';
  }
  return out;
}
export const outRuleOf = (prefs, key) => normalizeOut(ruleFor(prefs, key).out);

// The fitted thresholds (/api/best_bets/analysis outliers: outlier_thresholds
// rows) -> { byClass, markets: { 'sport|kind': { all, bands: { band: row },
// classes: { class: row } } } }. byClass: the per-class rows are in
// (migration 041); before them a market's threshold is one for every class.
export function outlierFits(rows) {
  const markets = {};
  let byClass = false;
  for (const o of rows || []) {
    const m = (markets[`${o.sport}|${o.kind}`] ||= { all: null, bands: {}, classes: {} });
    const cls = o.edge_class || 'any';
    if (cls !== 'any') { m.classes[cls] = o; byClass = true; } else if (o.band === 'all') m.all = o; else m.bands[o.band] = o;
  }
  return { byClass, markets };
}

// The gap a class needs to count "where they've paid", at a consensus price
// (its band's floor, for 'made' and 'none'); null: it doesn't. Before the
// class rows: the market's (its band's first), +25% with nothing settled.
export function fittedCut(fits, key, cls, cons) {
  const m = fits?.markets?.[key];
  if (fits?.byClass) {
    const t = m?.classes?.[cls]?.threshold;
    if (t == null) return null;
    const floor = cls !== 'value' && cons != null ? m.bands[outBandOf(cons)]?.floor : null;
    return floor != null && floor > t + 1e-9 ? floor : t;
  }
  if (!m) return OUT_DEFAULT_CUT;
  const band = cons != null ? m.bands[outBandOf(cons)]?.threshold : null;
  return band ?? (m.all ? m.all.threshold : OUT_DEFAULT_CUT);
}

// The gap each class needs under these settings in one market: { class: cut
// or null }. fits: outlierFits (for 'paid'); cons: the consensus band it is in.
export function outCutsFor(prefs, key, fits, cons = null) {
  const out = outRuleOf(prefs, key);
  const off = prefs.outliers === 'off' || out.mode === 'off';
  return Object.fromEntries(OUT_CLASSES.map(cls => [cls, off ? null
    : out.mode === 'custom' ? (out.gaps[cls] === '' ? null : +out.gaps[cls]) : fittedCut(fits, key, cls, cons)]));
}

// Whether a price is an outlier under these settings: o = { gap, cls, paid }
// - its gap and edge class, and whether the backend counted it one under the
// fitted thresholds (paid: "Where they've paid", the default).
export function outlierPasses(prefs, key, o) {
  if (!o || prefs.outliers === 'off') return false;
  const out = outRuleOf(prefs, key);
  if (out.mode === 'off') return false;
  if (out.mode === 'paid') return !!o.paid;
  const g = out.gaps[o.cls];
  return g !== '' && o.gap != null && o.gap >= +g - 1e-9;
}

// A selection's outlier window (/api/best_bets/analysis disc_window, /live
// out_window: best_bets_data.compact_window): { 'class:cut': [first price,
// its median edge, its book, its median, the other books' median then,
// average price while there, average median edge, average edge at the best
// price, seconds, first there (unix s)] }. The keys at which it showed as an
// outlier under these settings: each class at the gap it needs ('paid': at
// the floor of the consensus band it was first there in, as the backend).
export function windowKeys(prefs, key, win, fits) {
  if (!win || prefs.outliers === 'off') return [];
  const out = outRuleOf(prefs, key);
  if (out.mode === 'off') return [];
  const keys = [];
  for (const cls of OUT_CLASSES) {
    if (out.mode === 'custom') {
      const k = out.gaps[cls] === '' ? null : `${cls}:${out.gaps[cls]}`;
      if (k && win[k]) keys.push(k);
      continue;
    }
    const t = fittedCut(fits, key, cls, null);
    const e = t == null ? null : win[`${cls}:${outCutKey(t)}`];
    if (!e) continue;
    const cut = fittedCut(fits, key, cls, e[4]);
    if (cut != null && win[`${cls}:${outCutKey(cut)}`]) keys.push(`${cls}:${outCutKey(cut)}`);
  }
  return keys;
}

// A bet on the window's keys, at the average best price over the time it
// showed there (the first price where no time was recorded): { taken,
// first, firstAt, secs, edge, bookEdge (both averaged too), median, cons,
// book, firstEdge (of the first check), cls (the first's class) }, or null.
export function windowTake(win, keys) {
  const es = keys.map(k => [k, win?.[k]]).filter(([, e]) => e && e[0] != null);
  if (!es.length) return null;
  const [k0, f] = es.reduce((a, b) => ((b[1][9] ?? Infinity) < (a[1][9] ?? Infinity) ? b : a));
  const secs = es.reduce((a, [, e]) => a + (e[8] || 0), 0);
  const avg = i => es.reduce((a, [, e]) => a + (e[i] ?? 0) * (e[8] || 0), 0) / secs;
  return { taken: secs > 0 ? avg(5) : f[0], first: f[0], firstAt: f[9] ?? null, secs,
           edge: secs > 0 ? avg(6) : f[1], bookEdge: secs > 0 ? avg(7) : f[7], median: f[3], cons: f[4], book: f[2],
           firstEdge: f[1], cls: k0.split(':')[0] };
}

// A tracked row at one stage ('open', 'flagged', 'best', 'close') on the
// basis chosen: { back: the price taken, edge: the edge at the median (the
// value signal, whatever the basis), bookEdge: the edge at the price taken,
// fallback }. Rows store the median as {stage}_back / {stage}_edge and the
// best bookmaker's as {stage}_book_back / {stage}_book_edge. A row with no
// best-bookmaker price recorded is taken at the median, with fallback set.
// An edge missing at the best price is the median's scaled to it (exact bar
// the chance of a push).
export function priceAt(r, stage, basis) {
  const back = r[`${stage}_back`], edge = r[`${stage}_edge`];
  const book = basis === 'book' ? r[`${stage}_book_back`] : null;
  if (book == null) return { back, edge, bookEdge: edge, fallback: basis === 'book' && back != null };
  const bookEdge = r[`${stage}_book_edge`] ?? (edge != null && back > 0 ? (1 + edge) * book / back - 1 : null);
  return { back: book, edge, bookEdge, fallback: false };
}

// Main lines (spreads, totals, NFL yards) move the line, not the price: a
// moved line is a new selection, and the bet's own stops at its last price.
// The backend's lc_src says how the closing price AT THE BET'S LINE was found
// (best_bets_data.line_closes): 'held' (the line didn't move: its own close
// stands), 'alt' (the alternate market there), 'model' / 'approx' (the
// closing line's price shifted back by the model's chances at the two
// lines), 'none' (moved, nothing to price it by). lc_back / lc_book_back are
// that price at the median / best bookie, lc_ovr the closing line's margin.
export const LINE_MOVED = ['alt', 'model', 'approx'];
export const lineMoved = r => LINE_MOVED.includes(r.lc_src);

// The closing price closing-line value is measured against, at the basis:
// { back, ovr (the margin to take out, where known), moved }. Where the line
// moved, the price at the bet's line at the close; else its own last price.
// (The 'close' stage of priceAt stays the last price at the bet's own line:
// a price that could have been taken.)
export function closeAt(r, basis) {
  if (lineMoved(r)) return { back: (basis === 'book' ? r.lc_book_back : null) ?? r.lc_back, ovr: r.lc_ovr, moved: true };
  return { back: priceAt(r, 'close', basis).back, ovr: null, moved: false };
}

// Whether a row has a closing price to judge by: priced again at its line
// after the stage (n_checks > 1) or its line moved and the price at it is
// known - not one whose line moved with nothing to price it by
export const hasRealClose = r => lineMoved(r) || (r.n_checks > 1 && r.lc_src !== 'none');

// "10–30%", "10%+", "up to 30%", "any edge"
export function edgeText([lo, hi]) {
  const w = x => `${+(x * 100).toFixed(1)}%`;
  return isFinite(hi) ? (lo > 0 ? `${+(lo * 100).toFixed(1)}–${w(hi)}` : `up to ${w(hi)}`) : lo > 0 ? `${w(lo)}+` : 'any edge';
}
// "odds $5–$15", "odds $5+", "odds up to $10"; null for any price
export function oddsText([lo, hi]) {
  const d = x => `$${+x.toFixed(2)}`;
  return isFinite(hi) ? (lo > 1 ? `odds ${d(lo)}–${d(hi)}` : `odds up to ${d(hi)}`) : lo > 1 ? `odds ${d(lo)}+` : null;
}

// For the Filters button: "9 of 16 markets · edge 10%+" (or "edges vary",
// "any calibrated edge", "calibrated edge 2%+")
export function prefsSummary(prefs, keys) {
  const on = keys.filter(k => ruleFor(prefs, k).on);
  const edges = new Set(on.map(k => edgeText(edgeRangeOf(prefs, k))));
  const label = judgeLabel(prefs);
  const text = edges.size === 1 ? [...edges][0] : null;
  const edge = !on.length ? '' : text == null ? ` · ${label}s vary` : text === 'any edge' ? ` · any ${label}` : ` · ${label} ${text}`;
  const own = keys.some(k => outRuleOf(prefs, k).mode !== 'paid');
  return `${on.length === keys.length ? 'All' : `${on.length} of ${keys.length}`} markets${edge}`
    + (prefs.outliers === 'only' ? ' · outliers only' : prefs.outliers === 'off' ? ' · outliers off' : own ? ' · outliers set by market' : '')
    + (prefs.autoOpt ? ' · most profitable' : '');
}

// The edge range spanning every market on among `keys`: where the track
// record's bands are cut
export function spanRange(prefs, keys) {
  const ranges = keys.filter(k => ruleFor(prefs, k).on).map(k => edgeRangeOf(prefs, k));
  if (!ranges.length) return [0, Infinity];
  return [Math.min(...ranges.map(r => r[0])), Math.max(...ranges.map(r => r[1]))];
}
