// match-best-bets.js — the Best Bets panel at the top of each Multi Builder.
//
// For accounts with Best Bets access it lists the selected game's
// positive-edge selections (/api/best_bets?sport=&game_id=), best edge first.
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
import { PREFS_KEY, esc, odds, pct, signedPct, isNhlThreeWay, selectionText } from './best-bets-shared.js';

const panel = document.getElementById('match-best-bets');
const TOP = 5;             // rows before "Show all"
const CACHE_MS = 60000;    // as long as the backend keeps its own copy

let rows = [];
let showAll = false;
let seq = 0;               // drops the answer for a game since navigated away from
const cache = new Map();   // 'sport:gameId' -> { rows, ts }

// The Best Bets page's NHL 3-way choice applies here too.
function wantsThreeWay() {
  try { return !!JSON.parse(localStorage.getItem(PREFS_KEY) || '{}').threeWay; } catch { return false; }
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
  const threeWay = wantsThreeWay();
  rows = found.filter(r => threeWay || !isNhlThreeWay(r)).sort((a, b) => b.edge - a.edge);
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
              <th class="px-2 py-1 text-right font-semibold" title="Expected return per unit staked, after commission">Edge</th>
              <th class="pl-2 py-1"><span class="sr-only">Add to multi</span></th>
            </tr>
          </thead>
          <tbody>${shown.map((r, i) => `
            <tr class="border-t border-gray-700/60">
              <td class="pr-2 py-1.5">
                <span class="font-semibold text-gray-100">${esc(selectionText(r))}</span>
                <span class="block text-[11px] text-gray-500">${esc(r.market_name)}</span>
              </td>
              <td class="px-2 py-1.5 text-right tabular-nums font-bold text-amber-400">${odds(r.back)}</td>
              <td class="hidden sm:table-cell px-2 py-1.5 text-right tabular-nums text-gray-300">${pct(r.model_prob)}</td>
              <td class="hidden sm:table-cell px-2 py-1.5 text-right tabular-nums text-gray-300">${odds(r.fair_odds)}</td>
              <td class="px-2 py-1.5 text-right tabular-nums font-bold text-green-400">${signedPct(r.edge)}</td>
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
