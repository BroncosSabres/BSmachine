// best-bets-prefs.js — keeps the Best Bets filter settings (see
// best-bets-filters.js) and draws the Filters modal. Used by the Best Bets
// page and its analysis page (the price basis).
//
// The settings live in this browser (applied at once) and, signed in, in the
// account's profile (profiles.best_bets_prefs), so they follow the account:
// the profile's copy wins when the page loads; a profile with none takes this
// browser's. The bank balance is not part of them: it stays in the browser.
import { supabase, getSession } from './supabase-client.js';
import { SPORT_LABELS, SPORT_COLORS, PREFS_KEY, esc } from './best-bets-shared.js';
import { MARKETS, BASES, normalizePrefs, migrateOldPrefs, defaultPrefs, defaultRule, ruleFor,
         marketLabel } from './best-bets-filters.js';

const KEY = 'bsm_best_bets_filters';
const SAVE_DELAY_MS = 800;

export function localPrefs() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return normalizePrefs(JSON.parse(saved));
    const old = localStorage.getItem(PREFS_KEY);   // from before the modal
    if (old) return migrateOldPrefs(JSON.parse(old));
  } catch { /* storage unavailable or bad JSON */ }
  return defaultPrefs();
}

function storeLocal(prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}

async function pushProfile(prefs) {
  const session = await getSession();
  if (!session) return;
  await supabase.from('profiles').update({ best_bets_prefs: prefs }).eq('id', session.user.id);
}

// The account's settings: resolves to them when the profile has different
// ones from this browser (stored here too), else null. A profile with none
// is given this browser's.
export async function syncPrefs(local) {
  const session = await getSession();
  if (!session) return null;
  const { data, error } = await supabase.from('profiles').select('best_bets_prefs')
    .eq('id', session.user.id).maybeSingle();
  if (error || !data) return null;   // e.g. the column isn't there yet: this browser only
  if (!data.best_bets_prefs) {
    await pushProfile(local);
    return null;
  }
  const remote = normalizePrefs(data.best_bets_prefs);
  if (JSON.stringify(remote) === JSON.stringify(local)) return null;
  storeLocal(remote);
  return remote;
}

let saveTimer = 0;
// To this browser now, to the profile shortly after (one write for a burst of changes)
export function savePrefs(prefs) {
  storeLocal(prefs);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => pushProfile(prefs).catch(() => {}), SAVE_DELAY_MS);
}

// --- the Filters modal ----------------------------------------------------------

let overlay = null;
let state = null;   // { prefs, keys, counts, onChange, opener }

const inputCls = 'w-14 bg-gray-900 border border-gray-600 rounded px-1.5 py-1 text-sm text-white tabular-nums';

function rowHtml(key) {
  const rule = ruleFor(state.prefs, key);
  const n = state.counts?.[key];
  return `
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 border-t border-gray-700/60 first:border-t-0 ${rule.on ? '' : 'opacity-60'}" data-key="${esc(key)}">
      <label class="flex items-center gap-2 flex-1 min-w-[10rem] cursor-pointer">
        <input type="checkbox" data-on class="accent-amber-400 shrink-0" ${rule.on ? 'checked' : ''}>
        <span class="text-sm text-gray-100 truncate">${esc(marketLabel(key))}</span>
        <span data-count class="text-[11px] tabular-nums text-gray-500 shrink-0">${n ? `${n} now` : ''}</span>
      </label>
      <span class="ml-auto flex items-center gap-1 text-xs text-gray-400 shrink-0" role="group" aria-label="${esc(marketLabel(key))} edge range">
        <input data-edge="0" type="number" min="0" step="any" inputmode="decimal" placeholder="any" value="${esc(rule.edge[0])}"
               aria-label="Lowest edge, percent" class="${inputCls}">
        <span aria-hidden="true">–</span>
        <input data-edge="1" type="number" min="0" step="any" inputmode="decimal" placeholder="any" value="${esc(rule.edge[1])}"
               aria-label="Highest edge, percent" class="${inputCls}">%
        <button type="button" data-copy title="Use this edge range for every market"
                class="ml-1 px-1.5 py-1 rounded border border-gray-700 text-[11px] text-gray-400 hover:text-gray-100 hover:border-gray-500">All</button>
      </span>
    </div>`;
}

function bodyHtml() {
  const { prefs, keys } = state;
  const sports = [...new Set(keys.map(k => k.split('|')[0]))];
  const basis = Object.entries(BASES).map(([b, label]) => `
    <button type="button" data-basis="${b}" aria-pressed="${prefs.basis === b}"
            class="px-3 py-1.5 rounded-md text-sm transition-all ${prefs.basis === b
              ? 'bg-amber-400 text-gray-900 font-bold' : 'text-gray-400 font-semibold hover:text-gray-200'}">${label}</button>`).join('');
  return `
    <div class="mb-4">
      <div class="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">Price</div>
      <div class="inline-flex items-center bg-gray-900 border border-gray-700 rounded-lg p-0.5 gap-0.5">${basis}</div>
      <p class="mt-1.5 text-[11px] text-gray-500 leading-snug">${prefs.basis === 'book'
        ? 'Edges, odds, stakes and the track record at the best price any one bookie offers (the Betfair Exchange\'s own for its markets).'
        : 'Edges, odds, stakes and the track record at the median price across the bookies.'}</p>
    </div>
    ${sports.map(s => `
      <section class="mb-3">
        <div class="flex items-center justify-between gap-2 mb-1">
          <h3 class="text-xs font-bold tracking-wide" style="color:${SPORT_COLORS[s] || '#8892a4'}">${SPORT_LABELS[s] || esc(s)}</h3>
          <span class="flex items-center gap-2 text-[11px]">
            <button type="button" data-all-on="${s}" class="text-gray-400 hover:text-gray-100">All on</button>
            <span class="text-gray-700" aria-hidden="true">·</span>
            <button type="button" data-all-off="${s}" class="text-gray-400 hover:text-gray-100">All off</button>
          </span>
        </div>
        <div class="rounded-lg border border-gray-700 bg-gray-900/40 px-3">${keys.filter(k => k.startsWith(`${s}|`)).map(rowHtml).join('')}</div>
      </section>`).join('')}`;
}

function paint() {
  overlay.querySelector('[data-body]').innerHTML = bodyHtml();
}

function change(mutate, repaint = true) {
  const prefs = structuredClone(state.prefs);
  mutate(prefs);
  state.prefs = prefs;
  state.counts = state.onChange(prefs) || state.counts;
  if (repaint) paint();
  else for (const el of overlay.querySelectorAll('[data-key]')) {
    const n = state.counts?.[el.dataset.key];
    el.querySelector('[data-count]').textContent = n ? `${n} now` : '';
  }
}

function setRule(prefs, key, patch) {
  prefs.markets[key] = { ...ruleFor(prefs, key), ...patch };
}

function build() {
  overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 hidden items-end sm:items-center justify-center bg-black/60 sm:p-4';
  overlay.style.zIndex = '1200';   // above the site header (1100)
  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="bb-filters-title"
         class="bg-gray-800 border border-gray-700 w-full sm:max-w-xl max-h-[88vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl">
      <div class="flex items-start justify-between gap-3 p-4 pb-2">
        <div>
          <h2 id="bb-filters-title" class="text-lg font-bold text-gray-100">Filters</h2>
          <p class="text-xs text-gray-500">The markets to show and the edge each needs. Saved to your account.</p>
        </div>
        <button type="button" data-close aria-label="Close" class="text-gray-400 hover:text-gray-100 text-xl leading-none px-1">✕</button>
      </div>
      <div data-body class="overflow-y-auto px-4 pb-2"></div>
      <div class="flex items-center justify-between gap-3 p-4 pt-3 border-t border-gray-700">
        <button type="button" data-reset class="text-xs text-gray-400 hover:text-gray-100">Reset to defaults</button>
        <button type="button" data-close class="px-4 py-1.5 rounded-md bg-amber-400 text-gray-900 text-sm font-bold">Done</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-close]')) return closeFilters();
    const b = e.target.closest('button');
    if (!b) return;
    const key = b.closest('[data-key]')?.dataset.key;
    if (b.dataset.basis) change(p => { p.basis = b.dataset.basis; });
    else if (b.dataset.allOn || b.dataset.allOff) {
      const s = b.dataset.allOn || b.dataset.allOff;
      change(p => state.keys.filter(k => k.startsWith(`${s}|`)).forEach(k => setRule(p, k, { on: !!b.dataset.allOn })));
    } else if (b.hasAttribute('data-copy') && key) {
      const edge = [...ruleFor(state.prefs, key).edge];
      change(p => state.keys.forEach(k => setRule(p, k, { edge: [...edge] })));
    } else if (b.hasAttribute('data-reset')) {
      change(p => { p.markets = Object.fromEntries(state.keys.map(k => [k, defaultRule(k)])); p.basis = 'book'; });
    }
  });
  overlay.addEventListener('change', e => {
    const key = e.target.closest('[data-key]')?.dataset.key;
    if (!key) return;
    if (e.target.hasAttribute('data-on')) {
      e.target.closest('[data-key]').classList.toggle('opacity-60', !e.target.checked);
      change(p => setRule(p, key, { on: e.target.checked }), false);
    } else if (e.target.dataset.edge != null) {
      const i = +e.target.dataset.edge;
      change(p => { const edge = [...ruleFor(p, key).edge]; edge[i] = e.target.value.trim(); setRule(p, key, { edge }); }, false);
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) closeFilters();
  });
}

// keys: the markets to list (sport|kind). counts: { key: bets on show now }.
// onChange(prefs) is called on every change, and returns fresh counts.
export function openFilters({ prefs, keys, counts, onChange, opener }) {
  if (!overlay) build();
  state = { prefs: structuredClone(prefs), keys, counts, onChange, opener };
  paint();
  overlay.classList.remove('hidden');
  overlay.classList.add('flex');
  document.body.style.overflow = 'hidden';
  overlay.querySelector('[data-close]').focus();
}

export function closeFilters() {
  if (!overlay || overlay.classList.contains('hidden')) return;
  overlay.classList.add('hidden');
  overlay.classList.remove('flex');
  document.body.style.overflow = '';
  state?.opener?.focus();
}

// The markets the modal lists: every known one of these sports, then any
// other the data has
export function filterKeys(sports, extra = []) {
  const known = MARKETS.filter(m => sports.includes(m.sport)).map(m => m.key);
  return [...known, ...[...new Set(extra)].filter(k => !known.includes(k) && sports.includes(k.split('|')[0]))];
}
