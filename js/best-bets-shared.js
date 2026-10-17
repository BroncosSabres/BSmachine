// best-bets-shared.js — labels and formatters shared by the Best Bets page
// (best-bets.js), its analysis page (best-bets-analysis.js) and the Multi
// Builders' best-bets panel (match-best-bets.js).

export const SPORT_LABELS = { nrl: 'NRL', nrlw: 'NRLW', nfl: 'NFL', nhl: 'NHL' };
export const SPORT_COLORS = { nrl: '#fbbf24', nrlw: '#e879f9', nfl: '#60a5fa', nhl: '#818cf8' };
export const KIND_LABELS = { match_odds: 'Match odds', handicap: 'Handicap', total: 'Total',
                             anytime_scorer: 'Anytime scorer', multi_scorer: '2+ scorer' };

// Sort / My Teams / NHL 3-way choices on the Best Bets page, remembered between visits.
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
// between steps become cuts of their own. picks: settled picks with
// flagged_edge and result. -> [{ lo, hi, label, picks }] in edge order.
export const EDGE_STEPS = [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.5, Infinity];

export function edgeBands(picks, [minEdge, maxEdge] = [0, Infinity], minBets = 10) {
  const live = p => p.result !== 'void';
  const steps = [...new Set([...EDGE_STEPS, minEdge, maxEdge].filter(x => x >= 0))].sort((a, b) => a - b);
  const fine = steps.slice(0, -1).map((lo, i) => {
    const hi = steps[i + 1];
    const inBand = picks.filter(p => p.flagged_edge >= lo && p.flagged_edge < hi);
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

// Bookmaker scorer rows: where the best price was and what it was. The row's
// own odds / edge are at the median price across the bookmakers, so this is
// the one to actually take. Empty for Betfair rows (and older checks).
export function bestBookHtml(r) {
  if (!r.best_book || r.best_book_back == null) return '';
  const title = `Highest price found: ${odds(r.best_book_back)} at ${r.best_book}`
    + (r.best_book_edge == null ? '' : ` (${signedPct(r.best_book_edge)} edge at that price)`);
  return `<div class="text-[11px] text-gray-400" title="${esc(title)}">Best <span class="font-semibold tabular-nums text-amber-400">${odds(r.best_book_back)}</span> at <span class="font-semibold text-gray-200">${esc(r.best_book)}</span></div>`;
}

// Betfair names the line in most runner names ("Roosters -4.5"); Asian-handicap
// style runners are just the team / Over / Under, so add it.
export function selectionText(r) {
  let name = r.selection_name;
  if (r.line != null && (r.market_kind === 'handicap' || r.market_kind === 'total') && !/\d/.test(name)) {
    name += ` ${r.market_kind === 'handicap' && r.line > 0 ? '+' : ''}${r.line}`;
  }
  return name;
}
