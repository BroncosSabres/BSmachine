// best-bets-filters.js — the Best Bets filter settings and the price a bet is
// judged at. No DOM, so it can be exercised under Node; best-bets-prefs.js
// keeps the settings (browser + the account's profile) and draws the modal.
//
// Settings: { v, basis, odds, markets, sort, myTeams, liveStage }
//   basis     'book': bets are taken at the best single bookmaker's price
//             (Betfair rows: the exchange's), 'avg': at the median across the
//             bookmakers. Either way a bet's edge - what says it has value, and
//             what the edge filters and bands read - is the edge at the median:
//             one generous bookmaker can't make a bet worth having.
//   odds      [min, max] as typed, '' for no limit: one range for every market
//   markets   { 'sport|kind': { on, edge: [min, max] } }, edge typed in percent
//   liveStage 'open' | 'best' | 'close': which of a live bet's prices it is judged at
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
export const LIVE_STAGES = ['open', 'best', 'close'];
const DEFAULT_EDGE = ['10', ''];
const DEFAULT_ODDS = ['', '10'];
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

export const defaultRule = key => ({ on: !OFF_BY_DEFAULT.has(key), edge: [...DEFAULT_EDGE] });

// A typed limit: a number (as typed) or '' for none
const typed = x => { const s = String(x ?? '').trim(); return s !== '' && Number.isFinite(+s) ? s : ''; };
const pair = (p, fallback) => Array.isArray(p) && p.length === 2 ? [typed(p[0]), typed(p[1])] : [...fallback];

export function defaultPrefs() {
  return { v: 1, basis: 'book', odds: [...DEFAULT_ODDS], markets: {}, sort: 'edge', myTeams: false, liveStage: 'best' };
}

// Anything (saved JSON, a profile column) -> valid settings
export function normalizePrefs(p) {
  const d = defaultPrefs();
  if (!p || typeof p !== 'object') return d;
  const markets = {};
  for (const [key, rule] of Object.entries(p.markets && typeof p.markets === 'object' ? p.markets : {})) {
    if (!/^[a-z]+\|[a-z_]+(:3)?$/.test(key) || !rule || typeof rule !== 'object') continue;
    markets[key] = { on: rule.on !== false, edge: pair(rule.edge, DEFAULT_EDGE) };
  }
  return {
    v: 1,
    basis: p.basis === 'avg' ? 'avg' : 'book',
    odds: pair(p.odds, DEFAULT_ODDS),
    markets,
    sort: p.sort === 'time' ? 'time' : 'edge',
    myTeams: !!p.myTeams,
    liveStage: LIVE_STAGES.includes(p.liveStage) ? p.liveStage : 'best',
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
  for (const m of MARKETS) p.markets[m.key] = { on: m.key === 'nhl|match_odds:3' ? !!old.threeWay : true, edge: [...edge] };
  p.sort = old.sort === 'time' ? 'time' : 'edge';
  p.myTeams = !!old.myTeams;
  if (LIVE_STAGES.includes(old.basis)) p.liveStage = old.basis;
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
export const edgeRangeOf = (prefs, key) => typedRange(ruleFor(prefs, key).edge, 0.01);
export const oddsRangeOf = prefs => typedRange(prefs.odds);
export const oddsTyped = prefs => { const [lo, hi] = oddsRangeOf(prefs); return lo > 0 || isFinite(hi); };
// A hair of slack so 10% typed still takes an edge stored as 0.09999...
export const inRange = (x, [lo, hi]) => x != null && x >= lo - 1e-9 && x <= hi + 1e-9;

// Whether a bet passes its market's switch and edge range, the odds range,
// and has value at all. edge: at the median; back: the price taken.
export function passesMarket(prefs, key, edge, back) {
  const rule = ruleFor(prefs, key);
  return rule.on && edge != null && edge > 0 && inRange(edge, edgeRangeOf(prefs, key)) && inRange(back, oddsRangeOf(prefs));
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

// For the Filters button: "9 of 16 markets · edge 10%+" (or "edges vary")
export function prefsSummary(prefs, keys) {
  const on = keys.filter(k => ruleFor(prefs, k).on);
  const edges = new Set(on.map(k => edgeText(edgeRangeOf(prefs, k))));
  const edge = !on.length ? '' : edges.size === 1 ? ` · edge ${[...edges][0]}` : ' · edges vary';
  return `${on.length === keys.length ? 'All' : `${on.length} of ${keys.length}`} markets${edge}`;
}

// The edge range spanning every market on among `keys`: where the track
// record's bands are cut
export function spanRange(prefs, keys) {
  const ranges = keys.filter(k => ruleFor(prefs, k).on).map(k => edgeRangeOf(prefs, k));
  if (!ranges.length) return [0, Infinity];
  return [Math.min(...ranges.map(r => r[0])), Math.max(...ranges.map(r => r[1]))];
}
