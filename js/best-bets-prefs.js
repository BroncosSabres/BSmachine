// best-bets-prefs.js — keeps the Best Bets filter settings (see
// best-bets-filters.js) and draws the Filters modal. Used by the Best Bets
// page and its analysis page (the price basis, and the filters themselves
// when "My filters" is ticked there). The modal's "Most profitable" button
// sets every market from its settled bets (best-bets-optimise.js); with
// "Keep on Most profitable" ticked (prefs.autoOpt, the default until a market
// is changed by hand) the pages re-run it whenever what it reads comes in
// (autoOptimise). Each market also has its outlier rule (⚡ Outliers: where
// they've paid, custom gaps per edge class, or off), which neither touches.
//
// The settings live in this browser (applied at once) and, signed in, in the
// account's profile (profiles.best_bets_prefs), so they follow the account:
// the profile's copy wins when the page loads; a profile with none takes this
// browser's. The bank balance is not part of them: it stays in the browser.
import { supabase, getSession } from './supabase-client.js';
import { SPORT_LABELS, SPORT_COLORS, PREFS_KEY, esc, signedPct } from './best-bets-shared.js';
import { MARKETS, BASES, OUTLIER_MODES, normalizePrefs, migrateOldPrefs, defaultPrefs, defaultRule, ruleFor,
         marketLabel, edgeText, typedRange, oddsText, oddsRangeOf, edgeField, JUDGES, OUT_CLASSES, OUT_CLASS_LABELS,
         OUT_CLASS_SHORT, OUT_CUTS, OUT_MODES, outCutKey, outRuleOf, fittedCut } from './best-bets-filters.js';
import { applyOptimised, OPT_MIN_BETS } from './best-bets-optimise.js';

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
  // Settings from before a version change go back migrated, once
  if ((+data.best_bets_prefs.v || 1) < remote.v) pushProfile(remote).catch(() => {});
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
let state = null;   // { prefs, keys, counts, countLabel, onChange, optimise, opener, report, fits }

const inputCls = 'w-14 bg-gray-900 border border-gray-600 rounded px-1.5 py-1 text-sm text-white tabular-nums';

// "+25%"
const gapText = cut => `+${Math.round(cut * 100)}%`;
const OUT_MODE_LABELS = { paid: "Where they've paid", custom: 'Custom', off: 'Off' };

// A market's ⚡ Outliers line: its rule, and what it lets through per edge
// class - the fitted gap ("Where they've paid") or the ones chosen
function outLineHtml(key) {
  const out = outRuleOf(state.prefs, key);
  const fits = state.fits;
  const sel = (attrs, opts, value, label) => `<select ${attrs} aria-label="${esc(label)}"
      class="bg-gray-900 border border-gray-600 rounded px-1 py-0.5 text-[11px] text-gray-100">${opts.map(([v, t]) =>
      `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  let detail;
  if (out.mode === 'custom') {
    detail = OUT_CLASSES.map(cls => `<span class="inline-flex items-center gap-1" title="${esc(OUT_CLASS_LABELS[cls])}">${esc(OUT_CLASS_SHORT[cls])}
      ${sel(`data-out-gap="${cls}"`, [['', 'off'], ...OUT_CUTS.map(c => [outCutKey(c), `${gapText(c)}+`])], out.gaps[cls],
            `${marketLabel(key)}: gap for outliers with ${OUT_CLASS_SHORT[cls]}`)}</span>`).join('');
  } else if (out.mode === 'paid') {
    const m = fits?.markets?.[key];
    detail = !fits ? '<span class="text-gray-500">loading what has paid…</span>'
      : OUT_CLASSES.map(cls => {
        const t = fittedCut(fits, key, cls, null);
        const why = fits.byClass ? (m?.classes?.[cls]?.method === 'unprofitable' ? 'lost at every gap' : 'too few to judge') : 'none have paid';
        return `<span class="${t == null ? 'text-gray-500' : 'text-amber-300/90'}" title="${esc(OUT_CLASS_LABELS[cls])}: ${t == null ? `off - ${why}` : `from a ${gapText(t)} gap`}">${esc(OUT_CLASS_SHORT[cls])} ${t == null ? 'off' : `${gapText(t)}+`}</span>`;
      }).join('<span class="text-gray-700" aria-hidden="true">·</span>');
  } else detail = '<span class="text-gray-500">no outliers from this market</span>';
  return `<div class="basis-full flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[11px] text-gray-400">
      <span class="text-amber-300/80" aria-hidden="true">⚡</span>${sel('data-out-mode', OUT_MODES.map(m => [m, OUT_MODE_LABELS[m]]), out.mode,
        `${marketLabel(key)} outliers`)}${detail}</div>`;
}

function rowHtml(key) {
  const rule = ruleFor(state.prefs, key);
  const edge = rule[edgeField(state.prefs)] || ['', ''];
  const n = state.counts?.[key];
  const dim = rule.on ? '' : 'opacity-60';
  return `
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 border-t border-gray-700/60 first:border-t-0" data-key="${esc(key)}">
      <label data-dim class="flex items-center gap-2 flex-1 min-w-[10rem] cursor-pointer ${dim}">
        <input type="checkbox" data-on class="accent-amber-400 shrink-0" ${rule.on ? 'checked' : ''}>
        <span class="text-sm text-gray-100 truncate">${esc(marketLabel(key))}</span>
        <span data-count class="text-[11px] tabular-nums text-gray-500 shrink-0">${countText(n)}</span>
      </label>
      <span data-dim class="ml-auto flex items-center gap-1 text-xs text-gray-400 shrink-0 ${dim}" role="group" aria-label="${esc(marketLabel(key))} edge range">
        <input data-edge="0" type="number" step="any" inputmode="decimal" placeholder="any" value="${esc(edge[0])}"
               aria-label="Lowest edge, percent" class="${inputCls}">
        <span aria-hidden="true">–</span>
        <input data-edge="1" type="number" step="any" inputmode="decimal" placeholder="any" value="${esc(edge[1])}"
               aria-label="Highest edge, percent" class="${inputCls}">%
        <button type="button" data-copy title="Use this edge range for every market"
                class="ml-1 px-1.5 py-1 rounded border border-gray-700 text-[11px] text-gray-400 hover:text-gray-100 hover:border-gray-500">All</button>
      </span>
      ${reportLine(state.report?.[key])}
      ${outLineHtml(key)}
    </div>`;
}

// A count, or { n, out }: the bets and the outlier bets the market's ⚡ rule adds
const countText = c => {
  const n = c && typeof c === 'object' ? c.n : c, out = c && typeof c === 'object' ? c.out : 0;
  return n || out ? `${n || 0} ${state.countLabel || 'now'}${out ? ` (+${out} outlier${out === 1 ? '' : 's'})` : ''}` : '';
};
const units = x => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}u`;
const bets = n => `${n} bet${n === 1 ? '' : 's'}`;

// Under a row, once "Most profitable" has run: what its settled bets did
function reportLine(r) {
  if (!r) return '';
  const text = r.status === 'on'
    ? `<span class="text-green-400/90">Most profitable: edge ${esc(edgeText(typedRange(r.edge, 0.01)))}</span> · ${units(r.units)} on ${bets(r.n)} (${signedPct(r.roi)})`
    : r.status === 'off'
      ? `<span class="text-red-400/90">No edge range has made money</span> · ${units(r.units)} on ${bets(r.n)} with value`
      : `${r.n ? `${bets(r.n)} settled` : 'No settled bets'}: under ${OPT_MIN_BETS}, so left as it was`;
  return `<div class="basis-full text-[11px] text-gray-500 pl-6 -mt-0.5">${text}</div>`;
}

// What "Most profitable" read, and what it did
function reportSummary() {
  const r = Object.values(state.report || {});
  if (!r.length) return '';
  const k = st => r.filter(x => x.status === st).length;
  const odds = oddsText(oddsRangeOf(state.prefs));
  return `<p class="mb-3 rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-[11px] text-gray-400 leading-snug">
    Set from settled bets at the average ${state.prefs.basis === 'book' ? 'best bookie' : 'median'} price while they showed value${odds ? `, ${esc(odds)}` : ''}, one bet per market:
    <span class="text-gray-200">${k('on')} on</span> at the edge range that made the most units,
    <span class="text-gray-200">${k('off')} off</span> where none made money, ${k('thin')} left as ${k('thin') === 1 ? 'it was' : 'they were'} (under ${OPT_MIN_BETS} settled bets).
    It is fitted to past results, so expect less from it. Change anything below as you like.</p>`;
}

function bodyHtml() {
  const { prefs, keys } = state;
  const sports = [...new Set(keys.map(k => k.split('|')[0]))];
  const basis = Object.entries(BASES).map(([b, label]) => `
    <button type="button" data-basis="${b}" aria-pressed="${prefs.basis === b}"
            class="px-3 py-1.5 rounded-md text-sm transition-all ${prefs.basis === b
              ? 'bg-amber-400 text-gray-900 font-bold' : 'text-gray-400 font-semibold hover:text-gray-200'}">${label}</button>`).join('');
  return `${reportSummary()}
    <label class="mb-4 flex items-start gap-2 rounded-lg border ${prefs.autoOpt ? 'border-amber-400/50 bg-amber-400/5' : 'border-gray-700'} px-3 py-2 cursor-pointer">
      <input type="checkbox" data-auto class="accent-amber-400 mt-0.5 shrink-0" ${prefs.autoOpt ? 'checked' : ''}>
      <span>
        <span class="block text-sm text-gray-100 font-semibold">Keep on Most profitable</span>
        <span class="block text-[11px] text-gray-500 leading-snug">Every market is set from its settled bets as "Most profitable" does, and set again as new results come in, so the filters follow the data. Changing a market below by hand turns this off.</span>
      </span>
    </label>
    <div class="mb-4">
      <div class="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">Price</div>
      <div class="inline-flex items-center bg-gray-900 border border-gray-700 rounded-lg p-0.5 gap-0.5">${basis}</div>
      <p class="mt-1.5 text-[11px] text-gray-500 leading-snug">${prefs.basis === 'book'
        ? 'Bets taken at the best price any one bookie offers (the Betfair Exchange\'s own for its markets): odds, stakes and the track record\'s returns use it.'
        : 'Bets taken at the median price across the bookies.'} A bet needs an edge at the median price either way, and the edge ranges below are always at the median.</p>
    </div>
    <div class="mb-4">
      <div class="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">Judge by</div>
      <div class="inline-flex items-center bg-gray-900 border border-gray-700 rounded-lg p-0.5 gap-0.5">${[['model', 'Model edge'], ['cal', 'Calibrated edge'], ['close', 'Predicted close']].map(([v, label]) => `
        <button type="button" data-judge="${v}" aria-pressed="${prefs.judge === v}"
                class="px-3 py-1.5 rounded-md text-sm transition-all ${prefs.judge === v
                  ? 'bg-amber-400 text-gray-900 font-bold' : 'text-gray-400 font-semibold hover:text-gray-200'}">${label}</button>`).join('')}</div>
      <p class="mt-1.5 text-[11px] text-gray-500 leading-snug">${prefs.judge === 'close'
        ? "Predicted close: where each bet's price is heading by kickoff, from how far prices have moved toward (or away from) the model in its market with that long to go, with the bookies' margin taken out. The edge is the price you take against that fair closing price, so a bet worth having now is one the market is expected to shorten past it. It learns from every priced selection's closing price, which settles far faster than results; the analysis page's Model vs market shows how its predictions have done out of sample. Stakes are Kelly on its low end."
        : prefs.judge === 'cal'
        ? "Calibrated: the model's chance blended with the bookies' (their margin taken out) by how far each market's settled bets have trusted the model - the analysis page's Model vs market. It is judged at the price you take (the best bookie's, with Price on Best bookie), not the median: the edge ranges below are of it there, and stakes are Kelly on its low end."
        : "The model's own edge. Calibrated blends it with the bookies' chance by how far each market's settled bets have trusted the model; Predicted close judges the price against where the market is expected to close (the analysis page's Model vs market says how each has done out of sample)."
      } Each has its own edge ranges.</p>
    </div>
    <div class="mb-4">
      <div class="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">Outliers</div>
      <div class="inline-flex items-center bg-gray-900 border border-gray-700 rounded-lg p-0.5 gap-0.5">${[['off', 'Off'], ['any', 'On'], ['only', 'Outliers only']].map(([v, label]) => `
        <button type="button" data-outliers="${v}" aria-pressed="${prefs.outliers === v}"
                class="px-3 py-1.5 rounded-md text-sm transition-all ${prefs.outliers === v
                  ? 'bg-amber-400 text-gray-900 font-bold' : 'text-gray-400 font-semibold hover:text-gray-200'}">${label}</button>`).join('')}</div>
      <p class="mt-1.5 text-[11px] text-gray-500 leading-snug">⚡ An outlier is one bookie well above the median of the others. Whether it pays depends on the model's edge as much as the gap, so each market judges three kinds apart: a median edge above 0, an edge only at the outlier price, and no edge. Each market's ⚡ line below says which count: <span class="text-gray-300">Where they've paid</span> (the default) takes each kind from the gap at which its settled outlier bets have made the most profit, and none where they've lost or are still too few to judge; <span class="text-gray-300">Custom</span> takes the gaps you choose; <span class="text-gray-300">Off</span> none. ${
        prefs.outliers === 'off' ? 'Off: an outlier price is listed only when it has an edge, like any other bet.'
        : prefs.outliers === 'only' ? 'Outliers only: nothing else is listed. They need only the odds range, not the market switched on or its edge.'
        : "On: outliers are listed whatever their edge, as each market's ⚡ line says, within the odds range; a market's outliers don't need the market switched on."
      } The same goes for the Live tab and the track record's ⚡ line, and the analysis page under My filters.</p>
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
    el.querySelector('[data-count]').textContent = countText(state.counts?.[el.dataset.key]);
  }
}

function setRule(prefs, key, patch) {
  prefs.markets[key] = { ...ruleFor(prefs, key), ...patch };
}

// A market changed by hand: no longer kept on "Most profitable"
function setRuleByHand(prefs, key, patch) {
  setRule(prefs, key, patch);
  prefs.autoOpt = false;
  const box = overlay.querySelector('[data-auto]');
  if (box) box.checked = false;
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
          <p class="text-xs text-gray-500">The markets to show and the edge (at the median price) each needs. Saved to your account.</p>
        </div>
        <button type="button" data-close aria-label="Close" class="text-gray-400 hover:text-gray-100 text-xl leading-none px-1">✕</button>
      </div>
      <div data-body class="overflow-y-auto px-4 pb-2"></div>
      <div class="flex items-center justify-between gap-3 p-4 pt-3 border-t border-gray-700">
        <button type="button" data-reset class="text-xs text-gray-400 hover:text-gray-100">Reset to defaults</button>
        <span class="flex items-center gap-2">
          <button type="button" data-optimise title="${OPT_TITLE}"
                  class="px-3 py-1.5 rounded-md border border-amber-400/60 text-amber-300 text-sm font-semibold hover:bg-amber-400/10 disabled:opacity-40 disabled:cursor-wait">Most profitable</button>
          <button type="button" data-close class="px-4 py-1.5 rounded-md bg-amber-400 text-gray-900 text-sm font-bold">Done</button>
        </span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-close]')) return closeFilters();
    const b = e.target.closest('button');
    if (!b) return;
    const key = b.closest('[data-key]')?.dataset.key;
    if (b.dataset.judge) {
      state.report = null;   // fitted to the other edge
      change(p => { p.judge = JUDGES.includes(b.dataset.judge) ? b.dataset.judge : 'model'; });
      if (state.prefs.autoOpt) optimise();
    } else if (b.dataset.outliers) {
      change(p => { p.outliers = OUTLIER_MODES.includes(b.dataset.outliers) ? b.dataset.outliers : 'any'; });
    } else if (b.dataset.basis) {
      state.report = null;   // read at the other price
      change(p => { p.basis = b.dataset.basis; });
      if (state.prefs.autoOpt) optimise();
    } else if (b.hasAttribute('data-optimise')) optimise();
    else if (b.dataset.allOn || b.dataset.allOff) {
      const s = b.dataset.allOn || b.dataset.allOff;
      change(p => state.keys.filter(k => k.startsWith(`${s}|`)).forEach(k => setRuleByHand(p, k, { on: !!b.dataset.allOn })));
    } else if (b.hasAttribute('data-copy') && key) {
      const field = edgeField(state.prefs);
      const edge = [...(ruleFor(state.prefs, key)[field] || ['', ''])];
      change(p => state.keys.forEach(k => setRuleByHand(p, k, { [field]: [...edge] })));
    } else if (b.hasAttribute('data-reset')) {
      // The defaults are kept on "Most profitable", as new settings are
      state.report = null;
      change(p => { p.markets = Object.fromEntries(state.keys.map(k => [k, defaultRule(k)])); p.basis = 'book'; p.outliers = 'any'; p.judge = 'model'; p.autoOpt = true; });   // outliers back to "Where they've paid"
      optimise();
    }
  });
  overlay.addEventListener('change', e => {
    if (e.target.hasAttribute('data-auto')) {
      const on = e.target.checked;
      change(p => { p.autoOpt = on; });
      if (on) optimise();
      return;
    }
    const key = e.target.closest('[data-key]')?.dataset.key;
    if (!key) return;
    if (e.target.hasAttribute('data-out-mode')) {
      // Outlier rules aren't edge ranges: "Keep on Most profitable" stays on.
      // Custom starts from what has paid.
      const mode = e.target.value;
      change(p => {
        const out = outRuleOf(p, key);
        if (mode === 'custom' && OUT_CLASSES.every(c => out.gaps[c] === '')) {
          for (const c of OUT_CLASSES) {
            const t = fittedCut(state.fits, key, c, null);
            out.gaps[c] = t == null ? '' : outCutKey(t);
          }
        }
        setRule(p, key, { out: { ...out, mode } });
      });
    } else if (e.target.dataset.outGap) {
      const cls = e.target.dataset.outGap, gap = e.target.value;
      change(p => { const out = outRuleOf(p, key); setRule(p, key, { out: { ...out, gaps: { ...out.gaps, [cls]: gap } } }); }, false);
    } else if (e.target.hasAttribute('data-on')) {
      for (const el of e.target.closest('[data-key]').querySelectorAll('[data-dim]')) el.classList.toggle('opacity-60', !e.target.checked);
      change(p => setRuleByHand(p, key, { on: e.target.checked }), false);
    } else if (e.target.dataset.edge != null) {
      const i = +e.target.dataset.edge;
      change(p => {
        const field = edgeField(p);
        const edge = [...(ruleFor(p, key)[field] || ['', ''])];
        edge[i] = e.target.value.trim();
        setRuleByHand(p, key, { [field]: edge });
      }, false);
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) closeFilters();
  });
}

const OPT_TITLE = 'Switch each market on at the edge range its settled bets have made the most money in, and off where '
  + 'no range has made money. Markets with too few settled bets are left as they are. Change anything afterwards as you like.';

// "Most profitable": every market from its settled bets, the rest as they
// are. Nothing until what it reads is in (the button says so meanwhile).
function optimise() {
  const report = state.optimise?.ready?.(state.prefs) && state.optimise(state.prefs);
  if (!report) return;
  state.report = report;
  change(p => Object.assign(p, applyOptimised(p, report)));
}

// The button waits for the settled bets (and the calibration, judging by
// it), which the page may still be loading
function syncOptimise() {
  const b = overlay.querySelector('[data-optimise]');
  const ready = !!state.optimise?.ready?.(state.prefs);
  b.disabled = !ready;
  b.classList.toggle('hidden', !state.optimise);
  b.title = ready ? OPT_TITLE : `Loading the settled bets first. ${OPT_TITLE}`;
}

const modalOpen = () => !!(overlay && state && !overlay.classList.contains('hidden'));

// keys: the markets to list (sport|kind). counts: { key: bets }, shown as
// "n now" (or "n <countLabel>"). onChange(prefs) is called on every change,
// and returns fresh counts. optimise(prefs) -> best-bets-optimise.js
// optimiseMarkets' report, with optimise.ready(prefs) saying whether what it
// reads (the settled bets, the calibration for its judge) is in; leave it out
// for no "Most profitable" button. Kept on "Most profitable", the modal opens
// with what it read. fits: the fitted outlier thresholds (best-bets-filters.js
// outlierFits; null while loading), for what "Where they've paid" lets through.
export function openFilters({ prefs, keys, counts, countLabel, onChange, optimise: opt, opener, fits = null }) {
  if (!overlay) build();
  state = { prefs: structuredClone(prefs), keys, counts, countLabel, onChange, optimise: opt, opener, report: null, fits };
  if (state.prefs.autoOpt && opt?.ready?.(state.prefs)) {
    state.report = opt(state.prefs) || null;
    const next = state.report && applyOptimised(state.prefs, state.report);
    if (next && JSON.stringify(next) !== JSON.stringify(state.prefs)) {
      state.prefs = next;
      state.counts = onChange(next) || counts;
    }
  }
  paint();
  syncOptimise();
  overlay.classList.remove('hidden');
  overlay.classList.add('flex');
  document.body.style.overflow = 'hidden';
  overlay.querySelector('[data-close]').focus();
}

// The page's settled bets (or calibration) have arrived: "Most profitable"
// can run, and the outlier lines can say what has paid (fits)
export function filtersDataReady(fits = undefined) {
  if (!modalOpen()) return;
  if (fits !== undefined && fits !== state.fits) {
    state.fits = fits;
    paint();
  }
  syncOptimise();
}

// Kept on "Most profitable" (prefs.autoOpt): the settings re-fitted to what
// the page has now, saved, and the open modal shown them. -> the new settings
// when that changed them, else null (not kept on it, what it reads not in
// yet, or nothing moved). optimise as openFilters takes it.
export function autoOptimise(prefs, optimise) {
  if (!prefs.autoOpt || !optimise?.ready?.(prefs)) return null;
  const report = optimise(prefs);
  if (!report) return null;
  const next = applyOptimised(prefs, report);
  if (modalOpen()) {
    state.prefs = structuredClone(next);
    state.report = report;
    paint();
    syncOptimise();
  }
  if (JSON.stringify(next) === JSON.stringify(prefs)) return null;
  savePrefs(next);
  return next;
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
