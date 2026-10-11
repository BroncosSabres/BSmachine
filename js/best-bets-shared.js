// best-bets-shared.js — labels and formatters shared by the Best Bets page
// (best-bets.js), its analysis page (best-bets-analysis.js) and the Multi
// Builders' best-bets panel (match-best-bets.js).

export const SPORT_LABELS = { nrl: 'NRL', nrlw: 'NRLW', nfl: 'NFL', nhl: 'NHL' };
export const SPORT_COLORS = { nrl: '#fbbf24', nrlw: '#e879f9', nfl: '#60a5fa', nhl: '#818cf8' };
export const KIND_LABELS = { match_odds: 'Match odds', handicap: 'Handicap', total: 'Total',
                             anytime_scorer: 'Anytime scorer', multi_scorer: '2+ scorer' };

// Sort / My Teams / NHL 3-way choices on the Best Bets page, remembered between visits.
export const PREFS_KEY = 'bsm_best_bets_prefs';

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

// Betfair names the line in most runner names ("Roosters -4.5"); Asian-handicap
// style runners are just the team / Over / Under, so add it.
export function selectionText(r) {
  let name = r.selection_name;
  if (r.line != null && (r.market_kind === 'handicap' || r.market_kind === 'total') && !/\d/.test(name)) {
    name += ` ${r.market_kind === 'handicap' && r.line > 0 ? '+' : ''}${r.line}`;
  }
  return name;
}
