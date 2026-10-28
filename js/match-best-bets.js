// match-best-bets.js — the Best Bets panel at the top of each Multi Builder.
//
// For accounts with Best Bets access it lists the selected game's
// positive-edge selections and outlier prices (/api/best_bets?sport=&game_id=), best edge first,
// in the markets switched on in the Best Bets page's Filters and at the price
// chosen there (the best bookie's or the average; best-bets-prefs.js), with the
// best price at the bookies its My bookies uses where that differs.
// Everyone else gets nothing: the panel stays hidden and no bets are asked for.
//
// The builders are three separate scripts (the NRL one a classic script, so it
// can't import this), so they talk to the panel through the window:
//   'bsm:match-selected'   { sport, gameId } when a game is chosen (also left
//                          on window.bsmSelectedMatch, in case the builder got
//                          there before this module loaded)
//   'bsm:builder-updated'  the builder's legs or player data changed
//   window.bsmBuilder      { canAdd(row), has(row), toggle(row) }: whether the
//                          builder has a leg for a best bet, whether it is on
//                          the betslip, and adding / removing it
import { BACKEND } from './api-config.js';
import { getSession, hasBestBetsAccess } from './supabase-client.js';
import { esc, odds, pct, signedPct, signCls, selectionText, bestBookHtml, outlierHtml, usedPrice, usedWarnHtml } from './best-bets-shared.js';
import { installTapTips } from './tap-tips.js';
import { marketOf, ruleFor, outlierPasses, outRuleOf } from './best-bets-filters.js';
import { localPrefs } from './best-bets-prefs.js';

const panel = document.getElementById('match-best-bets');
installTapTips(panel);   // the outlier chip's details, on a tap
const TOP = 5;             // rows before "Show all"
const CACHE_MS = 60000;    // as long as the backend keeps its own copy

let rows = [];
let showAll = false;
let seq = 0;               // drops the answer for a game since navigated away from
let outView = r => ({ lit: !!r.outlier?.is_outlier, mode: 'paid', cut: r.outlier?.threshold });   // how Filters judge an outlier, for its chip
const cache = new Map();   // 'sport:gameId' -> { rows, ts }

// A row at the price chosen on the Best Bets page: the best bookie's where
// the bookies name one, else its own (the median; Betfair's for its markets).
// Its edge stays the median's, as on the Best Bets page.
function at(r, basis) {
  const book = basis === 'book' && r.best_book_back != null && r.best_book_edge != null;
  return { ...r, shownBack: book ? r.best_book_back : r.back, shownEdge: r.edge, median: r.back, atBook: book };
}

async function fetchRows(sport, gameId, token) {
  const key = `${sport}:${gameId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.rows;
  const res = await fetch(`${BACKEND}/best_bets?sport=${encodeURIComponent(sport)}&game_id=${encodeURIComponent(gameId)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const found = (await res.json()).rows || [];
  cache.set(key, { rows: found, ts: Date.now() });
  return found;
}

async function load(sel) {
  const mine = ++seq;
  rows = [];
  showAll = false;
  render();
  if (!sel?.gameId) return;
  let found = [];
  try {
    const session = await getSession();
    if (!session || !await hasBestBetsAccess(session)) return;
    found = await fetchRows(sel.sport, sel.gameId, session.access_token);
  } catch { /* no panel */ }
  if (mine !== seq) return;
  const prefs = localPrefs();
  // Alternate lines and totals win and lose with the standard one, so only
  // the bookies' standard line is listed (as on the Best Bets page). An
  // outlier price is listed whatever its edge, as its market's ⚡ rule in
  // Filters says, its market switched on or not (Filters → Outliers: only
  // outliers alone; off: an outlier only with an edge, like any bet).
  const only = prefs.outliers === 'only';
  const isOut = r => !!r.outlier && outlierPasses(prefs, marketOf(r),
    { gap: r.outlier.disc, cls: r.outlier.edge_class, paid: r.outlier.is_outlier });
  // Judged at every bookie's prices; mine: the best at the bookies the viewer
  // uses (My bookies) where the best of all isn't at one of them
  rows = found.filter(r => !r.alternate).map(r => ({ ...at(r, prefs.basis), isOut: isOut(r), mine: usedPrice(r, prefs.use) }))
    .filter(r => r.isOut || (!only && ruleFor(prefs, marketOf(r)).on && r.shownEdge > 0)).sort((a, b) => b.shownEdge - a.shownEdge);
  outView = r => {
    const key = marketOf(r), out = outRuleOf(prefs, key), cls = r.outlier.edge_class;
    const mode = prefs.outliers === 'off' ? 'all-off' : out.mode;
    return { lit: r.isOut, mode, byClass: !!r.outlier.classes,
             cut: mode === 'custom' ? (out.gaps[cls] ? +out.gaps[cls] : null) : r.outlier.threshold };
  };
  render();
}

function addCell(r, i) {
  const builder = window.bsmBuilder;
  if (!builder?.canAdd(r)) return '<td class="pl-2 py-1.5 w-20"></td>';
  const on = builder.has(r);
  return `<td class="pl-2 py-1.5 w-20 text-right">
    <button type="button" data-leg="${i}" aria-pressed="${on}" title="${on ? 'Remove this leg from the multi' : 'Add this as a leg of the multi'}"
            class="px-2 py-1 rounded border text-xs font-semibold whitespace-nowrap transition-colors ${on
              ? 'border-green-500 text-green-400' : 'border-gray-600 text-gray-300 hover:border-gray-400 hover:text-white'}">${on ? '✓ Added' : '+ Add'}</button>
  </td>`;
}

function render() {
  if (!panel) return;
  panel.classList.toggle('hidden', !rows.length);
  if (!rows.length) { panel.innerHTML = ''; return; }
  const shown = showAll ? rows : rows.slice(0, TOP);
  panel.innerHTML = `
    <div class="bg-gray-800 border border-gray-700 rounded-xl p-3 md:p-4">
      <div class="flex items-center justify-between gap-3 mb-2">
        <span class="text-xs font-semibold text-amber-400 uppercase tracking-widest">Best Bets <span class="text-gray-500 normal-case tracking-normal font-medium">for this game</span></span>
        <a href="/pages/best_bets.html" class="text-xs text-blue-400 hover:underline font-medium shrink-0">All best bets →</a>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-[10px] text-gray-500 uppercase tracking-wider">
              <th class="pr-2 py-1 text-left font-semibold">Selection</th>
              <th class="px-2 py-1 text-right font-semibold" title="Bookie odds at the last check">Odds</th>
              <th class="hidden sm:table-cell px-2 py-1 text-right font-semibold" title="Model probability">Model</th>
              <th class="hidden sm:table-cell px-2 py-1 text-right font-semibold" title="Model fair odds">Fair</th>
              <th class="px-2 py-1 text-right font-semibold" title="Expected return per unit staked at the average (median) price across the bookies, after commission">Avg edge</th>
              <th class="hidden sm:table-cell px-2 py-1 text-right font-semibold" title="Expected return per unit staked at the best price any one bookie offers">Best edge</th>
              <th class="pl-2 py-1"><span class="sr-only">Add to multi</span></th>
            </tr>
          </thead>
          <tbody>${shown.map((r, i) => `
            <tr class="border-t border-gray-700/60">
              <td class="pr-2 py-1.5">
                <span class="font-semibold text-gray-100">${esc(selectionText(r))}</span>
                <span class="block text-[11px] text-gray-500">${esc(r.market_name)}</span>
                ${bestBookHtml(r, r.atBook ? r.median : null)}
                ${r.mine?.price != null ? `<div class="text-[11px] text-gray-400">Yours <span class="font-semibold tabular-nums ${r.mine.ok ? 'text-amber-400' : 'text-gray-500'}">${odds(r.mine.price)}</span> at <span class="font-semibold text-gray-200">${esc(r.mine.book)}</span> · <span class="${signCls(r.mine.edge)}">${signedPct(r.mine.edge)}</span></div>` : ''}
                ${usedWarnHtml(r, r.mine)}
                ${r.outlier && outlierHtml(r, outView(r)) ? `<div class="mt-0.5">${outlierHtml(r, outView(r))}</div>` : ''}
              </td>
              <td class="px-2 py-1.5 text-right tabular-nums font-bold text-amber-400">${odds(r.shownBack)}</td>
              <td class="hidden sm:table-cell px-2 py-1.5 text-right tabular-nums text-gray-300">${pct(r.model_prob)}</td>
              <td class="hidden sm:table-cell px-2 py-1.5 text-right tabular-nums text-gray-300">${odds(r.fair_odds)}</td>
              <td class="px-2 py-1.5 text-right tabular-nums font-bold ${signCls(r.shownEdge)}">${signedPct(r.shownEdge)}</td>
              <td class="hidden sm:table-cell px-2 py-1.5 text-right tabular-nums font-bold ${signCls(r.best_book_edge ?? r.edge)}">${signedPct(r.best_book_edge ?? r.edge)}</td>
              ${addCell(r, i)}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between gap-3 mt-2">
        <span class="text-[11px] text-gray-600 leading-snug">Bookie odds are from the last check and will have moved. A leg you add is priced by the model.</span>
        ${rows.length > TOP ? `<button type="button" data-show-all class="text-xs text-blue-400 hover:underline font-medium shrink-0">${showAll ? 'Show fewer' : `Show all ${rows.length}`}</button>` : ''}
      </div>
    </div>`;
}

panel?.addEventListener('click', e => {
  if (e.target.closest('[data-show-all]')) { showAll = !showAll; render(); return; }
  const leg = e.target.closest('[data-leg]');
  const r = leg && (showAll ? rows : rows.slice(0, TOP))[leg.dataset.leg];
  if (r) { window.bsmBuilder?.toggle(r); render(); }
});

window.addEventListener('bsm:match-selected', e => load(e.detail));
window.addEventListener('bsm:builder-updated', () => { if (rows.length) render(); });
if (window.bsmSelectedMatch) load(window.bsmSelectedMatch);
