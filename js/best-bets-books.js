// best-bets-books.js — the My bookies modal on the Best Bets page, two
// ticks per bookie (best-bets-filters.js keeps both with the filters, so
// they are saved to the account when signed in):
//   Use (prefs.use)         the bookies the viewer bets at: where the best
//                           price isn't at one of them, each bet shows the
//                           best of theirs, is staked at it, and is flagged
//                           where none of theirs has an edge (best-bets-
//                           shared.js usedPrice). Bets are still judged at
//                           every bookie's prices. null - every bookie,
//                           bookies new to the feed too - until changed.
//   Favourite (prefs.books) whose prices every bet shows beside the best one
//                           (bookPricesHtml); the bet's details star them.
import { esc, bookLabel, STAR } from './best-bets-shared.js';

// The Australian bookies The Odds API prices (as it names them), so any can
// be picked before the bets on show have a price from it
export const KNOWN_BOOKS = ['Bet Right', 'Betr', 'Dabble AU', 'Ladbrokes', 'Neds', 'Picklebet (AU)', 'PlayUp',
                           'PointsBet (AU)', 'SportsBet', 'TAB', 'TABtouch', 'Unibet'];

// { bookie: { n: bets it prices, best: bets it has the best price on (ties
// count for each) } } over rows carrying books
export function bookStats(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.books?.length) continue;
    const top = r.books[0][1];
    for (const [b, p] of r.books) {
      const s = out[b] || (out[b] = { n: 0, best: 0 });
      s.n++;
      if (p === top) s.best++;
    }
  }
  return out;
}

let overlay = null;
let state = null;   // { names, use: Set | null (all), favs: Set, stats, nBets, onChange, opener }

const byLabel = (a, b) => bookLabel(a).localeCompare(bookLabel(b), undefined, { sensitivity: 'base' });
const COL = 'w-16 shrink-0 flex justify-center';

function bodyHtml() {
  const { names, use, favs, stats, nBets } = state;
  const used = b => use == null || use.has(b);
  const link = (attr, text, label) => `<button type="button" ${attr} aria-label="${esc(label)}" class="text-gray-400 hover:text-gray-100">${text}</button>`;
  return `
    <p class="mb-3 text-[11px] text-gray-500 leading-snug">
      Every bet is judged at every bookie's prices: the median across all of them says whether it has value, whoever you bet with.
      <span class="text-gray-300 font-semibold">Use:</span> the bookies you bet at. Where the best price isn't at one of them, each
      bet shows the best of yours and the edge there, its stake is at that price, and ⚠ marks a bet none of yours has at an edge.
      All are used until you change them.
      <span class="text-gray-300 font-semibold">Favourite</span> ${STAR}: their prices show beside the best one on every bet.
      Opening a bet lists every bookie.</p>
    ${use?.size === 0 ? '<p class="mb-2 text-[11px] text-amber-300">Tick the bookies you use: with none, every bet is flagged.</p>' : ''}
    <div class="flex items-end gap-1 px-3 pb-1 text-[11px] text-gray-500">
      <span class="flex-1">Bookie</span>
      <span class="${COL} flex-col items-center text-center"><span class="text-gray-300 font-semibold">Use</span>
        <span class="flex gap-1">${link('data-use-all', 'all', 'Use every bookie')}·${link('data-use-none', 'none', 'Use no bookie')}</span></span>
      <span class="${COL} flex-col items-center text-center"><span class="text-gray-300 font-semibold">Favourite</span>
        <span class="flex gap-1">${link('data-fav-all', 'all', 'Favourite every bookie')}·${link('data-fav-none', 'none', 'No favourites')}</span></span>
      <span class="w-16 shrink-0 text-right" title="Of the ${nBets} bet${nBets === 1 ? '' : 's'} listed now with every bookie used: how many each prices, and on how many it has the best price (ties count for each)">priced · best</span>
    </div>
    <div class="rounded-lg border border-gray-700 bg-gray-900/40 px-3">${names.map(b => {
      const s = stats[b];
      return `
      <div class="flex items-center gap-1 py-1.5 border-t border-gray-700/60 first:border-t-0">
        <span class="text-sm flex-1 min-w-0 truncate ${used(b) ? 'text-gray-100' : 'text-gray-500'}">${esc(bookLabel(b))}</span>
        <label class="${COL} py-1 cursor-pointer"><input type="checkbox" data-use="${esc(b)}" class="accent-amber-400"
          aria-label="Use ${esc(bookLabel(b))}" ${used(b) ? 'checked' : ''}></label>
        <label class="${COL} py-1 cursor-pointer"><input type="checkbox" data-fav="${esc(b)}" class="accent-amber-400"
          aria-label="Favourite ${esc(bookLabel(b))}" ${favs.has(b) ? 'checked' : ''}></label>
        <span class="w-16 shrink-0 text-right text-[11px] tabular-nums text-gray-500">${
          s ? `${s.n} · <span class="${s.best ? 'text-amber-400/90' : ''}">${s.best}</span>` : '–'}</span>
      </div>`;
    }).join('')}</div>`;
}

function paint() {
  overlay.querySelector('[data-body]').innerHTML = bodyHtml();
}

// Saved in the order the modal lists them, so the lists don't depend on the clicks
function change(patch) {
  Object.assign(state, patch);
  state.onChange({ books: [...state.favs].sort(byLabel), use: state.use == null ? null : [...state.use].sort(byLabel) });
}

function build() {
  overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 hidden items-end sm:items-center justify-center bg-black/60 sm:p-4';
  overlay.style.zIndex = '1200';   // above the site header (1100)
  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="bb-books-title"
         class="bg-gray-800 border border-gray-700 w-full sm:max-w-lg max-h-[88vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl">
      <div class="flex items-start justify-between gap-3 p-4 pb-2">
        <div>
          <h2 id="bb-books-title" class="text-lg font-bold text-gray-100">My bookies</h2>
          <p class="text-xs text-gray-500">The bookies you bet at, and the ones to always show. Saved to your account.</p>
        </div>
        <button type="button" data-close aria-label="Close" class="text-gray-400 hover:text-gray-100 text-xl leading-none px-1">✕</button>
      </div>
      <div data-body class="overflow-y-auto px-4 pb-2"></div>
      <div class="flex justify-end p-4 pt-3 border-t border-gray-700">
        <button type="button" data-close class="px-4 py-1.5 rounded-md bg-amber-400 text-gray-900 text-sm font-bold">Done</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-close]')) return closeBooks();
    const b = e.target.closest('button');
    if (!b) return;
    // "all" for Use is every bookie, new ones too, as until changed
    if (b.hasAttribute('data-use-all')) change({ use: null });
    else if (b.hasAttribute('data-use-none')) change({ use: new Set() });
    else if (b.hasAttribute('data-fav-all')) change({ favs: new Set(state.names) });
    else if (b.hasAttribute('data-fav-none')) change({ favs: new Set() });
    else return;
    paint();
  });
  overlay.addEventListener('change', e => {
    const { use: u, fav } = e.target.dataset;
    if (u != null) {
      // The first change from "every bookie" ticks every one listed here
      const use = new Set(state.use ?? state.names);
      if (e.target.checked) use.add(u); else use.delete(u);
      const warn = (state.use?.size === 0) !== (use.size === 0);   // the warning with none comes or goes
      change({ use });
      if (warn) paint();
      else {
        const name = e.target.closest('div').firstElementChild;
        name.classList.toggle('text-gray-100', e.target.checked);
        name.classList.toggle('text-gray-500', !e.target.checked);
      }
    } else if (fav != null) {
      const favs = new Set(state.favs);
      if (e.target.checked) favs.add(fav); else favs.delete(fav);
      change({ favs });
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) closeBooks();
  });
}

// favs: prefs.books; use: prefs.use (null: every bookie). rows: the bets
// listed now with every bookie used (for each bookie's counts).
// onChange({ books, use }) on every change, with both lists.
export function openBooks({ favs, use, rows = [], onChange, opener }) {
  if (!overlay) build();
  const priced = rows.filter(r => r.books?.length);
  const stats = bookStats(priced);
  const names = [...new Set([...KNOWN_BOOKS, ...Object.keys(stats), ...favs, ...(use || [])])].sort(byLabel);
  state = { names, use: use == null ? null : new Set(use), favs: new Set(favs), stats, nBets: priced.length, onChange, opener };
  paint();
  overlay.classList.remove('hidden');
  overlay.classList.add('flex');
  document.body.style.overflow = 'hidden';
  overlay.querySelector('[data-close]').focus();
}

export function closeBooks() {
  if (!overlay || overlay.classList.contains('hidden')) return;
  overlay.classList.add('hidden');
  overlay.classList.remove('flex');
  document.body.style.overflow = '';
  state?.opener?.focus();
}
