// best-bets-shared.js — labels and formatters shared by the Best Bets page
// (best-bets.js), its analysis page (best-bets-analysis.js) and the Multi
// Builders' best-bets panel (match-best-bets.js).

export const SPORT_LABELS = { nrl: 'NRL', nrlw: 'NRLW', nfl: 'NFL', nhl: 'NHL' };
export const SPORT_COLORS = { nrl: '#fbbf24', nrlw: '#e879f9', nfl: '#60a5fa', nhl: '#818cf8' };
export const KIND_LABELS = { match_odds: 'Match odds', handicap: 'Handicap', total: 'Total',
                             anytime_scorer: 'Anytime scorer', multi_scorer: '2+ scorer',
                             pass_yds: 'Passing yards', pass_tds: 'Passing TDs', rec_yds: 'Receiving yards',
                             rush_yds: 'Rushing yards', assists: 'Assists', points: 'Points' };
// Over / under player markets (bookmakers only): side over / under, line the
// bookies' point, the player in player_id.
export const PROP_KINDS = ['pass_yds', 'pass_tds', 'rec_yds', 'rush_yds', 'assists', 'points'];
export const isProp = r => PROP_KINDS.includes(r.market_kind);

// The Best Bets page's settings from before the filter modal (best-bets-prefs.js reads them once).
export const PREFS_KEY = 'bsm_best_bets_prefs';

// The stake settings both pages share (see safe-stake.js): { risk, detail,
// balance }. Kept in this browser only; the balance never leaves it.
const STAKE_KEY = 'bsm_best_bets_stake';
export function loadStakePrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(STAKE_KEY) || '{}') || {}; } catch { /* storage unavailable */ }
  return { risk: p.risk || 'medium', detail: p.detail || 'coarse', balance: p.balance > 0 ? +p.balance : null };
}
export function saveStakePrefs(prefs) {
  try { localStorage.setItem(STAKE_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}
export const money = x => x == null ? '–' : `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export const odds = o => o == null ? '–' : o.toFixed(o >= 10 ? 1 : 2);
export const pct = (x, dp = 1) => x == null || !isFinite(x) ? '–' : `${(x * 100).toFixed(dp)}%`;
export const signedPct = (x, dp = 1) => x == null || !isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(dp)}%`;
// A count of wins: whole unless half-wins (quarter-point lines) make it fractional.
export const wonCount = w => Number.isInteger(w) ? w.toLocaleString() : w.toFixed(1);
export const signCls = x => x == null || !isFinite(x) || x === 0 ? 'text-gray-400' : x > 0 ? 'text-green-400' : 'text-red-400';

// NHL head-to-head comes two ways: the moneyline (overtime and shootout
// count) and the 60-minute market with a draw. The moneyline is the default.
export const isNhlThreeWay = r => r.sport === 'nhl' && r.market_kind === 'match_odds'
  && (r.three_way ?? /3 way|60 min/i.test(r.market_name));

// Edge bands for the Best Bets page's track record. A fixed set of narrow
// bands leaves most with a handful of bets, whose ROI is mostly noise, and
// lumps every big edge into one. So the bands start narrow (EDGE_STEPS) and
// neighbours are joined until each holds at least `minBets` settled bets: few
// wide bands while the sample is small, more and finer ones as it grows.
// Bands never straddle either end of `[lo, hi]` (the page's Edge filter, hi
// Infinity for no top), so the ones outside it can be dimmed. Ends typed
// between steps become cuts of their own. picks: settled picks with result;
// edgeOf: the edge a pick is banded by (default the one it was flagged at).
// -> [{ lo, hi, label, picks }] in edge order.
export const EDGE_STEPS = [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.5, Infinity];

export function edgeBands(picks, [minEdge, maxEdge] = [0, Infinity], minBets = 10, edgeOf = p => p.flagged_edge) {
  const live = p => p.result !== 'void';
  const steps = [...new Set([...EDGE_STEPS, minEdge, maxEdge].filter(x => x >= 0))].sort((a, b) => a - b);
  const fine = steps.slice(0, -1).map((lo, i) => {
    const hi = steps[i + 1];
    const inBand = picks.filter(p => edgeOf(p) >= lo && edgeOf(p) < hi);
    return { lo, hi, picks: inBand, n: inBand.filter(live).length };
  });
  const join = (a, b) => ({ lo: a.lo, hi: b.hi, picks: a.picks.concat(b.picks), n: a.n + b.n });
  const bands = [];
  for (const group of [fine.filter(b => b.hi <= minEdge), fine.filter(b => b.lo >= minEdge && b.hi <= maxEdge), fine.filter(b => b.lo >= maxEdge)]) {
    const start = bands.length;
    let open = null;
    for (const b of group) {
      open = open ? join(open, b) : b;
      if (open.n >= minBets) { bands.push(open); open = null; }
    }
    // What is left over at the top is too few to stand alone: it joins the band below
    if (open && bands.length > start) bands.push(join(bands.pop(), open));
    else if (open) bands.push(open);
  }
  const pc = x => +(x * 100).toFixed(1);   // a typed end can fall between whole percents
  return bands.map(({ lo, hi, picks }) => ({ lo, hi, picks, label: isFinite(hi) ? `${pc(lo)}–${pc(hi)}%` : `${pc(lo)}%+` }));
}

// Bookmaker rows: where the best price was and what it was. Empty for Betfair
// rows (and older checks). median: given when the row's own odds are already
// the best price (the Best Bets page's Best bookie basis), to name the bookie
// and show the median alongside; otherwise the row's odds are the median and
// this is the price to actually take.
export function bestBookHtml(r, median = null) {
  if (!r.best_book || r.best_book_back == null) return '';
  const title = `Highest price found: ${odds(r.best_book_back)} at ${r.best_book}`
    + (r.best_book_edge == null ? '' : ` (${signedPct(r.best_book_edge)} edge at that price)`)
    + (median == null ? '' : `; median across the bookies ${odds(median)}`);
  return median == null
    ? `<div class="text-[11px] text-gray-400" title="${esc(title)}">Best <span class="font-semibold tabular-nums text-amber-400">${odds(r.best_book_back)}</span> at <span class="font-semibold text-gray-200">${esc(r.best_book)}</span></div>`
    : `<div class="text-[11px] text-gray-400" title="${esc(title)}">At <span class="font-semibold text-gray-200">${esc(r.best_book)}</span> · avg <span class="tabular-nums">${odds(median)}</span></div>`;
}

// Outlier prices (migration 036): one bookie far above the consensus of the
// others (the median of the rest; books on one price feed count once). gap =
// best / consensus - 1. /api/best_bets rows carry `outlier` from a 10% gap
// with its edge class (the model's edge above 0 at the median price, only
// at the outlier price, or neither: migration 041) and whether it counts
// under the fitted thresholds; the page judges it by the viewer's own
// outlier settings (best-bets-filters.js outlierPasses) and an outlier is
// listed whatever its edge. Picks carry outlier_* once their gap reached
// 10%, and their window (out_window) on Live.
// A gap worth a chip on a bet that isn't an outlier (best_bets_data.DISC_SHOW)
export const DISC_SHOW = 0.25;
const CLASS_TEXT = {
  value: "The model's edge is above 0 at the median price too.",
  made: 'The model has an edge only at this price, not at the median.',
  none: 'The model has no edge, even at this price.',
};
const CLASS_NOUN = { value: 'a median edge', made: 'an edge only at the outlier price', none: 'no edge' };

// The chip: a button that shows the details when tapped (tap-tips.js).
// o: {disc, cons, best, book, nBooks, cls, method, record, market, at, view}.
// view: how the viewer's Filters judge it - { lit (an outlier under them),
// mode ('paid' | 'custom' | 'off', or 'all-off': Filters' Outliers off),
// cut (the gap its class needs; null: none counts), byClass (the fitted
// thresholds are per edge class) }. at: a pick's, when its gap first reached
// 10%.
function outlierChipHtml(o) {
  const gap = signedPct(o.disc, 0);
  const v = o.view || {};
  const lines = [`${o.book || 'One bookie'} ${odds(o.best)} vs ${odds(o.cons)}`
    + (o.nBooks ? `, the median of the other ${o.nBooks - 1} bookie${o.nBooks === 2 ? '' : 's'}` : ' (the others)')
    + ` — ${gap}${o.at ? ` (first a 10%+ gap ${o.at})` : ''}.`];
  if (o.cls) lines.push(CLASS_TEXT[o.cls]);
  const kind = o.cls && (v.byClass || v.mode === 'custom') ? ` with ${CLASS_NOUN[o.cls]}` : '';
  const from = cut => `${signedPct(cut, 0)}`;
  if (v.lit) {
    lines.push(v.mode === 'custom' ? `Outlier: your Filters count ${o.market} outliers${kind} from a ${from(v.cut)} gap.`
      : `Outlier: ${o.market} outliers${kind} count from a ${from(v.cut)} gap, where their settled bets have made the most profit.`);
  } else if (v.mode === 'all-off') lines.push('Not listed as an outlier: Outliers are off in your Filters.');
  else if (v.mode === 'off') lines.push(`Not listed as an outlier: your Filters have ${o.market} outliers off.`);
  else if (v.cut != null) lines.push(`Not an outlier: ${o.market} outliers${kind} need a ${from(v.cut)} gap${v.mode === 'custom' ? ' in your Filters' : ''}.`);
  else lines.push(`Not an outlier: ${o.market} outliers${kind} ${o.method === 'unprofitable' ? 'have lost at every gap'
    : o.method === 'thin' ? 'are still too few to judge' : v.mode === 'custom' ? 'are off in your Filters' : "haven't paid"}.`);
  const rec = o.record;
  if (rec && rec.n) lines.push(`Settled ${o.market} outliers${kind} at a gap of ${signedPct(rec.cut, 0)}+: ${rec.n}, ${wonCount(rec.wins)} won, ${signedPct(rec.roi, 0)} ROI at the outlier price.`);
  const cls = v.lit
    ? 'border-amber-500/50 text-amber-300 bg-amber-900/30'
    : 'border-gray-600 text-gray-300 bg-gray-800/60';
  return `<button type="button" class="ml-1 inline-flex items-center gap-0.5 rounded border px-1 py-px text-[10px] font-semibold leading-tight whitespace-nowrap align-middle ${cls}"
    data-tip="${esc(lines.join('\n'))}" aria-label="${esc(lines.join(' '))}">${v.lit ? '⚡ Outlier' : 'Gap'} ${gap}</button>`;
}

const marketText = r => `${SPORT_LABELS[r.sport] || r.sport} ${(KIND_LABELS[r.market_kind] || r.market_kind).toLowerCase()}`;

// An /api/best_bets row's chip: '' unless it is an outlier under the
// viewer's Filters or its gap is at least DISC_SHOW. view: as outlierChipHtml
// takes it (default: the fitted thresholds' verdict).
export function outlierHtml(r, view = null) {
  const o = r.outlier;
  if (!o) return '';
  const v = view || { lit: !!o.is_outlier, mode: 'paid', cut: o.threshold, byClass: !!o.classes };
  if (!v.lit && o.disc < DISC_SHOW - 1e-9) return '';
  return outlierChipHtml({ disc: o.disc, cons: o.cons, best: r.best_book_back, book: o.book, nBooks: o.n_books,
                           cls: o.edge_class, method: o.method, record: o.record, market: marketText(r), view: v });
}

// A pick's chip (Live rows): '' unless it was an outlier under the viewer's
// Filters, or its gap reached DISC_SHOW. view: as outlierChipHtml takes it,
// with cls (the edge class it showed in) and disc / best / cons where its
// window says (default: its first 10%+ gap, lit while outlier_on).
export function pickOutlierHtml(p, view = null) {
  if (!p.outlier_at) return '';
  const v = view || { lit: p.outlier_on !== false, mode: 'paid', cut: null };
  const disc = v.disc ?? p.outlier_disc;
  if (!v.lit && !(disc >= DISC_SHOW - 1e-9)) return '';
  const at = new Date(p.outlier_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return outlierChipHtml({ disc, cons: v.cons ?? p.outlier_cons_back, best: v.best ?? p.outlier_book_back,
                           book: v.book ?? p.outlier_book, cls: v.cls ?? null, at, market: marketText(p), view: v });
}

export const isOutlierRow = r => !!r.outlier?.is_outlier;

// Betfair names the line in most runner names ("Roosters -4.5"); Asian-handicap
// style runners and bookmaker rows are just the team / Over / Under, so add it.
// A number inside a word ("49ers", "76ers") is part of the name, not a line.
const NAMES_LINE = /(^|[^\w.])[+-]?\d+(\.\d+)?(?![\w.])/;
export function selectionText(r) {
  let name = r.selection_name;
  if (isProp(r) && r.line != null) return `${name} ${r.side === 'under' ? 'Under' : 'Over'} ${r.line}`;
  if (r.line != null && (r.market_kind === 'handicap' || r.market_kind === 'total') && !NAMES_LINE.test(name)) {
    name += ` ${r.market_kind === 'handicap' && r.line > 0 ? '+' : ''}${r.line}`;
  }
  return name;
}
