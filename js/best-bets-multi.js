// best-bets-multi.js — the Best Bets page's Multi Generator tab (best-bets.js
// shows it). Insurance multis built from every selection one bookie prices
// (/api/best_bets/pool: each at its latest check, every bookie's price):
// n legs, the stake back when at least k win but not all. The multis are
// searched in a Worker (multi-gen-worker.js, multi-gen.js) for the least
// chance of losing the stake outright (fewer than k legs win: neither the
// multi nor the insurance pays), among those whose total price reaches the
// minimum asked, and shown by that or by EV (Sort by). Chances are the model's, or the calibrated
// ones when Filters judges by them (and the calibration is in). A regular
// multi takes at most one leg a game, over the games starting up to a day
// chosen (all of them, all but some, or only some: Games); a Same Game
// Multi's legs are one game's. With "My Best Bets filters" (on by default) the
// legs are only bets the Upcoming list's filters pass. Settings are kept in
// this browser (bsm_bb_multi); locked and excluded legs for the visit only.
import { esc, odds, pct, signedPct, signCls, selectionText, bookLabel, sportTag, kickoffText, SPORT_LABELS } from './best-bets-shared.js';
import { MARKETS, marketOf, marketLabel } from './best-bets-filters.js';
import { KNOWN_BOOKS } from './best-bets-books.js';
import { calibrateBet, commissionOf } from './calibrate-client.js';
import { edgeAt } from './calibrate.js';
import { refundRate, evOf, RANKS, comparer } from './multi-gen.js';
import { gameState, legOf, SGM_SPORTS } from './sgm-legs.js';
import { apiUrl } from './api-config.js';

const $ = id => document.getElementById(id);
const KEY = 'bsm_bb_multi';
export const POOL_MS = 120_000;   // the pool again when older (the backend caches a minute)
const TOP = 10;
const MAX_LEGS = { regular: 10, sgm: 6 };
const DAYS_AHEAD = 8;              // the pool's games: the next 8 days
const KINDS = { regular: 'Regular multi', sgm: 'Same Game Multi' };
const rankOf = x => (RANKS.includes(x) ? x : null);

// --- settings ---------------------------------------------------------------------

const DEFAULTS = { kind: 'regular', book: '', n: '3', k: '2', minLeg: '1.20', maxLeg: '', minTotal: '3', until: 0,
                   sportsOff: [], marketsOff: [], valueOnly: false, myFilters: true, gamesOff: [], gamesOnly: null, game: '',
                   stake: '50', cap: '50', refund: 'bonus', bonusPct: '75', sort: 'lose' };

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* storage unavailable */ }
  const str = k => (typeof s[k] === 'string' ? s[k] : DEFAULTS[k]);
  const list = k => (Array.isArray(s[k]) ? s[k].filter(x => typeof x === 'string') : []);
  return { type: 'insurance', kind: s.kind === 'sgm' ? 'sgm' : 'regular', book: str('book'), n: str('n'), k: str('k'),
           minLeg: str('minLeg'), maxLeg: str('maxLeg'), minTotal: str('minTotal'),
           until: Number.isInteger(s.until) && s.until >= 0 && s.until < DAYS_AHEAD ? s.until : 0,
           sportsOff: list('sportsOff'), marketsOff: list('marketsOff'), valueOnly: !!s.valueOnly, myFilters: s.myFilters !== false,
           gamesOff: list('gamesOff'), gamesOnly: Array.isArray(s.gamesOnly) ? list('gamesOnly') : null, game: str('game'),
           stake: str('stake'), cap: str('cap'), refund: s.refund === 'cash' ? 'cash' : 'bonus', bonusPct: str('bonusPct'),
           sort: rankOf(s.sort) || DEFAULTS.sort };
}

let settings = loadSettings();
const saveSettings = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ } };

// --- the pool ---------------------------------------------------------------------

let pool = null;          // /api/best_bets/pool
let poolFailed = false;
let poolLoadedAt = 0;
let poolLoading = null;
let ctx = null;           // best-bets.js's: { api, calib, judge, prefs }
let bound = false;

export const poolStale = () => Date.now() - poolLoadedAt > POOL_MS;

export function loadPool(api) {
  if (!poolLoading) {
    poolLoading = api('best_bets/pool').then(data => {
      if (!data) return;   // signed out / restricted: the gate card is up
      pool = data;
      poolFailed = false;
      poolLoadedAt = Date.now();
    }).catch(() => { poolFailed = true; }).finally(() => {
      poolLoading = null;
      if (ctx && !$('multi-view').classList.contains('hidden')) renderMulti(ctx);
    });
  }
  return poolLoading;
}

const legId = r => `${r.market_id}|${r.selection_id}|${r.line ?? ''}`;
// The bet whatever its line: a main line and its alternates, an NHL total
// either way the bookie settles it, a prop at any line
const legSig = r => `${r.market_id.replace(':alternate_', ':').replace(/:(reg|ot)$/, '')}|${r.selection_id}`;
const gameKey = r => `${r.sport}:${r.game_id}`;
const upcoming = () => (pool?.rows || []).filter(r => Date.parse(r.kickoff) > Date.now());
const priceAt = (r, book) => r.books?.find(([b]) => b === book)?.[1] ?? null;
const num = (x, fallback = null) => { const v = parseFloat(x); return Number.isFinite(v) ? v : fallback; };

// The end of the local day `offset` days from today
function dayEnd(offset) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset + 1).getTime();
}
function dayOffset(iso) {
  const d = new Date(iso), t = new Date();
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
}
function dayName(offset) {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  const t = new Date();
  const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + offset);
  return offset < 7 ? d.toLocaleDateString(undefined, { weekday: 'long' })
    : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

const bookOf = () => settings.book || ctx?.prefs?.use?.[0] || ctx?.prefs?.books?.[0] || 'SportsBet';
const judgeCal = () => ctx?.judge === 'cal' && !!ctx?.calib;

// Games: every one but those left out (gamesOff), or only those chosen
// (gamesOnly, after None): a game that comes into the window later is in
// the first way, out the second
const gameOn = key => (settings.gamesOnly ? settings.gamesOnly.includes(key) : !settings.gamesOff.includes(key));

// A regular multi's games: the window's, of the sports ticked
function windowRows() {
  const end = dayEnd(settings.until);
  return upcoming().filter(r => Date.parse(r.kickoff) < end && !settings.sportsOff.includes(r.sport));
}

// The rows in scope before the bookie and the leg filters: the window's
// games chosen (regular) or the game picked (SGM), the markets ticked
function scoped() {
  const s = settings;
  if (s.kind === 'sgm') return upcoming().filter(r => gameKey(r) === s.game && !s.marketsOff.includes(marketOf(r)));
  return windowRows().filter(r => gameOn(gameKey(r)) && !s.marketsOff.includes(marketOf(r)));
}

// A leg's chance: the calibrated one when Filters judges by it (calibrate-
// client.js), else the model's. valueEdge: the edge at the median price
// across the bookies, what says a bet has value
function chanceOf(r, price) {
  if (judgeCal()) {
    const c = calibrateBet(ctx.calib, r, { modelProb: r.model_prob, median: r.back, taken: price });
    if (c) return { p: c.p, basis: 'cal', valueEdge: c.edge };
  }
  return { p: r.model_prob, basis: 'model', valueEdge: r.edge };
}

// --- a Same Game Multi's game -------------------------------------------------------
// Its score bins and player data, as the Multi Builder loads them (public
// endpoints, cached by the backend), and its engine state (sgm-legs.js) to
// tell which rows are legs. GAME_MS: loaded again when older.
const GAME_MS = 600_000;
const gameData = new Map();   // gameKey -> { data: { bins, playerData }, gs, at } | { loading } | { failed, at }

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function loadGame(key) {
  const have = gameData.get(key);
  if (have?.loading || (have && Date.now() - have.at < GAME_MS)) return have.loading || Promise.resolve();
  const [sport, gid] = key.split(':');
  const loading = Promise.all([fetchJson(apiUrl(sport, `game_sgm_bins_range/${gid}?with_dists=1`)),
                               fetchJson(apiUrl(sport, `game_player_data/${gid}`))])
    .then(([bins, playerData]) => {
      const data = { bins: bins.bins || [], playerData };
      gameData.set(key, { data, gs: gameState(sport, data), at: Date.now() });
    })
    .catch(() => gameData.set(key, { failed: true, at: Date.now() }))
    .finally(() => { if (ctx && !$('multi-view').classList.contains('hidden')) renderPoolNote(); });
  gameData.set(key, { loading });
  return loading;
}

// The game chosen, once in: { data, gs } or null
const sgmGame = () => (gameData.get(settings.game)?.gs ? gameData.get(settings.game) : null);

// The candidate legs at the bookie: { id, group, sig, price, p, pModel, basis,
// edge, row }, and a Same Game Multi's also leg (sgm-legs.js legOf's): group
// its family. pModel: the pool's model chance (a Same Game Multi's from its
// engine once priced: the same, bar the NFL moneyline's ties)
function candidates() {
  const s = settings, book = bookOf();
  const lo = num(s.minLeg, 1), hi = num(s.maxLeg);
  const sgm = s.kind === 'sgm' ? sgmGame() : null;
  if (s.kind === 'sgm' && !sgm) return [];
  const passed = s.myFilters && ctx?.filtered ? ctx.filtered() : null;   // the Upcoming list's filters
  const sport = s.game.split(':')[0];
  const out = [];
  for (const r of scoped()) {
    const price = priceAt(r, book);
    if (!(price > 1) || price < lo - 1e-9 || (hi != null && price > hi + 1e-9)) continue;
    if (!(r.model_prob > 0 && r.model_prob < 1)) continue;
    const id = legId(r);
    if (excluded.has(id) || (passed && !passed.has(id))) continue;
    const leg = sgm ? legOf(sport, sgm.gs, r) : null;
    if (sgm && !leg) continue;
    const c = chanceOf(r, price);
    if (s.valueOnly && !(c.valueEdge > 0)) continue;
    out.push({ id, group: leg ? leg.family : gameKey(r), sig: legSig(r), price, p: c.p, pModel: r.model_prob, basis: c.basis,
               edge: edgeAt(c.p, price, commissionOf(r)), row: r, leg });
  }
  return out;
}

// --- locked / excluded legs ----------------------------------------------------------

const locked = new Map();     // id -> pool row
const excluded = new Map();   // id -> pool row

// --- the search -----------------------------------------------------------------------

let worker = null;
let runSeq = 0;
let run = null;       // { id, settings, legs: Map id -> leg, book, basis, rate, started }
let results = null;   // { ...worker answer, settings, book, basis, legs resolved, at } | { error }

function stopWorker() {
  if (worker) worker.terminate();
  worker = null;
}

function validate(s) {
  const n = num(s.n), k = num(s.k), max = MAX_LEGS[s.kind];
  if (!Number.isInteger(n) || n < 2 || n > max) return `Legs: a whole number from 2 to ${max}${s.kind === 'sgm' ? ' for a Same Game Multi' : ''}.`;
  if (!Number.isInteger(k) || k < 1 || k >= n) return `Insurance: at least 1 and fewer than the ${n} legs must win.`;
  if (s.minLeg !== '' && !(num(s.minLeg) >= 1)) return 'Min leg: a price of 1 or more, or blank.';
  if (s.maxLeg !== '' && !(num(s.maxLeg) >= Math.max(1, num(s.minLeg, 1)))) return 'Max leg: at least the min leg price, or blank.';
  if (s.minTotal !== '' && !(num(s.minTotal) >= 1)) return 'Min total: a price of 1 or more, or blank.';
  if (s.kind === 'sgm' && !s.game) return 'Pick a game for the Same Game Multi.';
  return null;
}

async function generate() {
  readForm();
  const problem = validate(settings);
  if (problem) { results = { error: problem }; renderResults(); return; }
  if (!pool || poolStale()) {
    run = { pending: true };
    renderResults();
    await loadPool(ctx.api);
    if (!pool) { run = null; results = { error: 'Could not load the prices. Try again in a moment.' }; renderResults(); return; }
  }
  const sgm = settings.kind === 'sgm';
  if (sgm) {
    if (!sgmGame()) {
      run = { pending: true };
      renderResults();
      await loadGame(settings.game);
      if (!sgmGame()) { run = null; results = { error: "Could not load this game's model. Try again in a moment." }; renderResults(); return; }
    }
    if (!SGM_SPORTS.includes(settings.game.split(':')[0])) {
      run = null; results = { error: 'Same Game Multis are for NFL and NHL games.' }; renderResults(); return;
    }
  }
  const legs = candidates();
  const byId = new Map(legs.map(l => [l.id, l]));
  const s = { ...settings }, n = num(s.n), k = num(s.k);
  const lockIds = [...locked.keys()].filter(id => byId.has(id));
  const missing = [...locked.values()].filter(r => !byId.has(legId(r)));
  stopWorker();
  try {
    worker = new Worker(new URL('./multi-gen-worker.js', import.meta.url), { type: 'module' });
  } catch {
    results = { error: "This browser can't run the search (no Web Workers)." };
    renderResults();
    return;
  }
  const id = ++runSeq;
  const rate = refundRate({ stake: s.stake, cap: s.cap, refund: s.refund, bonusPct: s.bonusPct });
  run = { id, settings: s, legs: byId, book: bookOf(), basis: judgeCal() ? 'cal' : 'model', rate, missing, started: Date.now(),
          nLegs: legs.length, nGroups: new Set(legs.map(l => l.group)).size, progress: null };
  worker.onmessage = e => {
    if (e.data.id !== run?.id) return;
    if (e.data.progress != null) { run.progress = e.data.progress; renderResults(); return; }
    finish(e.data);
  };
  worker.onerror = () => { if (run?.id === id) finish({ error: 'The search failed. Try again.' }); };
  const job = { id, n, k, minTotal: num(s.minTotal, 1), top: TOP, locked: lockIds, rate };
  if (sgm) {
    // The engine's own chances unless judging by the calibrated ones: the
    // worker prices each leg and the multis from the game's bins
    worker.postMessage({ ...job, type: 'sgm', sport: s.game.split(':')[0], game: sgmGame().data,
                         legs: legs.map(l => ({ id: l.id, group: l.group, sig: l.sig, price: l.price,
                                                p: l.basis === 'cal' ? l.p : null, leg: l.leg })) });
  } else {
    worker.postMessage({ ...job, type: 'regular', legs: legs.map(({ id: lid, group, sig, price, p }) => ({ id: lid, group, sig, price, p })) });
  }
  renderResults();
}

function finish(data) {
  stopWorker();
  const r = run;
  run = null;
  if (data.error) { results = { error: data.error }; renderResults(); return; }
  // A Same Game Multi's legs at the engine's chances (the model's: the
  // calibrated ones stay as they were)
  const legOfId = lid => {
    const l = r.legs.get(lid), pm = data.marginals?.[lid];
    if (pm == null) return l;
    const p = l.basis === 'cal' ? l.p : pm;
    return { ...l, pModel: pm, p, edge: edgeAt(p, l.price, commissionOf(l.row)) };
  };
  results = { ...data, settings: r.settings, book: r.book, basis: r.basis, rate: r.rate, missing: r.missing, at: Date.now(),
              nLegs: r.nLegs, nGroups: r.nGroups, secs: (Date.now() - r.started) / 1000,
              results: data.results.map(x => ({ ...x, legs: x.legs.map(legOfId), quote: '' })).sort(comparer(settings.sort)) };
  renderResults();
}

// --- rendering --------------------------------------------------------------------------

function agoText(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return !isFinite(mins) ? '' : mins < 60 ? `${mins}m ago` : mins < 2880 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
}

function renderKind() {
  $('mg-kind').innerHTML = Object.entries(KINDS).map(([key, label]) => `
    <button type="button" data-kind="${key}" aria-pressed="${key === settings.kind}"
            class="px-3 py-1 rounded-md text-sm transition-all ${key === settings.kind
              ? 'bg-amber-400 text-gray-900 font-bold' : 'text-gray-400 font-semibold hover:text-gray-200'}">${label}</button>`).join('');
  const sgm = settings.kind === 'sgm';
  $('mg-until-wrap').classList.toggle('hidden', sgm);
  $('mg-sports').classList.toggle('hidden', sgm);
  $('mg-game-wrap').classList.toggle('hidden', !sgm);
  $('mg-n').max = MAX_LEGS[settings.kind];
}

function renderOptions() {
  const rows = upcoming();
  // The bookie: every one the feed knows, with how many selections it prices in scope
  const inScope = scoped();
  const counts = {};
  for (const r of inScope) for (const [b] of r.books || []) counts[b] = (counts[b] || 0) + 1;
  const books = [...new Set([...KNOWN_BOOKS, ...rows.flatMap(r => (r.books || []).map(([b]) => b)), bookOf()])]
    .sort((a, b) => bookLabel(a).localeCompare(bookLabel(b), undefined, { sensitivity: 'base' }));
  $('mg-book').innerHTML = books.map(b => `<option value="${esc(b)}"${b === bookOf() ? ' selected' : ''}>${esc(bookLabel(b))}${
    pool ? ` (${(counts[b] || 0).toLocaleString()})` : ''}</option>`).join('');
  // The days with games, and the one chosen
  const days = [...new Set(rows.map(r => dayOffset(r.kickoff)).filter(d => d >= 0 && d < DAYS_AHEAD)), settings.until].sort((a, b) => a - b);
  $('mg-until').innerHTML = [...new Set(days)].map(d => `<option value="${d}"${d === settings.until ? ' selected' : ''}>${esc(dayName(d))}</option>`).join('');
  // Sports
  const sports = Object.keys(SPORT_LABELS).filter(s => rows.some(r => r.sport === s));
  $('mg-sports').innerHTML = sports.length > 1 ? sports.map(s => `
    <label class="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" data-sport="${s}" class="accent-amber-400"${
      settings.sportsOff.includes(s) ? '' : ' checked'}> ${SPORT_LABELS[s]}</label>`).join('') : '';
  // Games, for a Same Game Multi
  const games = [...new Map(rows.map(r => [gameKey(r), r])).values()].sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  // The game chosen, else the first (once the prices are in: until then there are none)
  if (pool && settings.kind === 'sgm' && !games.some(g => gameKey(g) === settings.game)) settings.game = games[0] ? gameKey(games[0]) : '';
  $('mg-game').innerHTML = games.length ? games.map(g => `<option value="${esc(gameKey(g))}"${gameKey(g) === settings.game ? ' selected' : ''}>${
    esc(`${SPORT_LABELS[g.sport] || g.sport} · ${g.home_team} v ${g.away_team} · ${kickoffText(g.kickoff)}`)}</option>`).join('')
    : '<option value="">No games priced</option>';
  // Markets: every one of the sports on offer, then any other the pool has
  const keys = [...new Set([...MARKETS.filter(m => sports.includes(m.sport)).map(m => m.key), ...rows.map(marketOf)])];
  $('mg-markets').innerHTML = sports.map(sp => {
    const mine = keys.filter(k => k.startsWith(`${sp}|`));
    return mine.length ? `<div class="space-y-1"><div class="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">${SPORT_LABELS[sp]}</div>${
      mine.map(k => `<label class="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" data-market="${esc(k)}" class="accent-amber-400"${
        settings.marketsOff.includes(k) ? '' : ' checked'}> ${esc(marketLabel(k))}</label>`).join('')}</div>` : '';
  }).join('');
  const on = keys.filter(k => !settings.marketsOff.includes(k)).length;
  $('mg-markets-summary').textContent = on === keys.length ? '· all' : `· ${on} of ${keys.length}`;
  renderGames();
}

function fillForm() {
  const s = settings;
  $('mg-n').value = s.n;
  $('mg-k').value = s.k;
  $('mg-min-leg').value = s.minLeg;
  $('mg-max-leg').value = s.maxLeg;
  $('mg-min-total').value = s.minTotal;
  $('mg-value').checked = s.valueOnly;
  $('mg-filters').checked = s.myFilters;
  $('mg-stake').value = s.stake;
  $('mg-cap').value = s.cap;
  $('mg-refund').value = s.refund;
  $('mg-bonus').value = s.bonusPct;
}

// The form into the settings, then saved
function readForm() {
  const v = id => $(id).value.trim();
  settings = { ...settings, n: v('mg-n'), k: v('mg-k'), minLeg: v('mg-min-leg'), maxLeg: v('mg-max-leg'), minTotal: v('mg-min-total'),
               valueOnly: $('mg-value').checked, myFilters: $('mg-filters').checked, stake: v('mg-stake'), cap: v('mg-cap'),
               refund: $('mg-refund').value === 'cash' ? 'cash' : 'bonus', bonusPct: v('mg-bonus'),
               book: $('mg-book').value || settings.book, until: +$('mg-until').value || 0,
               game: settings.kind === 'sgm' ? $('mg-game').value || settings.game : settings.game };
  saveSettings();
}

// Games (regular multis): the window's games of the sports ticked, ticked
// when in. Keys of games no longer priced are dropped.
function renderGames() {
  $('mg-games-wrap').classList.toggle('hidden', settings.kind === 'sgm');
  if (pool) {
    const live = new Set(upcoming().map(gameKey));
    settings.gamesOff = settings.gamesOff.filter(k => live.has(k));
    if (settings.gamesOnly) settings.gamesOnly = settings.gamesOnly.filter(k => live.has(k));
  }
  const games = [...new Map(windowRows().map(r => [gameKey(r), r])).values()].sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  $('mg-games').innerHTML = games.length ? games.map(g => `<label class="flex items-center gap-1.5 cursor-pointer min-w-0">
      <input type="checkbox" data-game="${esc(gameKey(g))}" class="accent-amber-400"${gameOn(gameKey(g)) ? ' checked' : ''}>
      <span class="truncate">${sportTag(g.sport)} ${esc(g.home_team)} v ${esc(g.away_team)} <span class="text-[11px] text-gray-500">${esc(kickoffText(g.kickoff))}</span></span></label>`).join('')
    : `<span class="text-xs text-gray-500">${pool ? 'No games in this window.' : 'Loading…'}</span>`;
  const on = games.filter(g => gameOn(gameKey(g))).length;
  $('mg-games-summary').textContent = !games.length ? '' : on === games.length ? '· all' : on ? `· ${on} of ${games.length}` : '· none';
}

// How many legs the settings leave, under the Generate button
function renderPoolNote() {
  $('mg-bonus-wrap').classList.toggle('hidden', settings.refund === 'cash');
  const note = $('mg-pool-note');
  if (!pool) { note.textContent = poolFailed ? 'Could not load the prices.' : 'Loading prices…'; return; }
  if (settings.kind === 'sgm' && settings.game && !sgmGame()) {
    const g = gameData.get(settings.game);
    if (g?.failed && Date.now() - g.at < 30_000) { note.textContent = "Could not load this game's model."; return; }
    loadGame(settings.game);
    note.textContent = "Loading this game's model…";
    return;
  }
  const legs = candidates();
  const groups = new Set(legs.map(l => l.group)).size;
  const basis = `${settings.myFilters ? 'your filters · ' : ''}${judgeCal() ? 'calibrated chances' : 'model chances'}`;
  note.textContent = settings.kind === 'sgm'
    ? `${legs.length.toLocaleString()} legs at ${bookLabel(bookOf())} in this game · ${basis}`
    : `${legs.length.toLocaleString()} legs at ${bookLabel(bookOf())} in ${groups} game${groups === 1 ? '' : 's'} · ${basis}`;
  note.title = judgeCal() ? 'The calibrated chances (Filters → Judge by): the model blended with the market by how far its settled bets have earned it'
    : "The model's chances. Filters → Judge by → Calibrated edge uses the calibrated chances instead.";
}

function renderLocks() {
  const chip = (r, kind) => `<span class="inline-flex items-center gap-1 rounded-full border ${kind === 'lock'
    ? 'border-amber-400/60 text-amber-200' : 'border-gray-600 text-gray-400 line-through decoration-gray-500'} px-2 py-0.5 text-[11px]">${
    kind === 'lock' ? '🔒 ' : ''}${esc(selectionText(r))}<button type="button" data-${kind === 'lock' ? 'unlock' : 'unexcl'}="${esc(legId(r))}"
      class="no-underline text-gray-400 hover:text-white" title="${kind === 'lock' ? 'Unlock' : 'Allow again'}" aria-label="${kind === 'lock' ? 'Unlock' : 'Allow again'}">×</button></span>`;
  const items = [...[...locked.values()].map(r => chip(r, 'lock')), ...[...excluded.values()].map(r => chip(r, 'excl'))];
  $('mg-locks').innerHTML = items.length ? `<div class="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">${
    locked.size ? 'In every multi:' : ''} ${items.join(' ')}
    <button type="button" data-clear-locks class="ml-1 text-blue-400 hover:underline">Clear</button></div>` : '';
}

function tile(label, value, title, strong = false) {
  return `<div class="rounded-lg border ${strong ? 'border-amber-400 bg-amber-400/5' : 'border-gray-700'} px-2.5 py-1.5" title="${esc(title)}">
    <div class="text-[10px] uppercase tracking-wider ${strong ? 'text-amber-300' : 'text-gray-500'} font-semibold">${label}</div>
    <div class="text-base font-bold tabular-nums ${strong ? 'text-amber-300' : 'text-gray-100'}">${value}</div></div>`;
}

function legRow(l, out) {
  const r = l.row, isLocked = locked.has(l.id);
  const chanceTitle = l.basis === 'cal' ? `Calibrated chance; the model's is ${pct(l.pModel)}` : "The model's chance";
  return `<div class="flex items-start gap-3 py-2 border-t border-gray-700/60">
    <div class="min-w-0 flex-1">
      <div class="font-semibold text-gray-100 leading-snug">${esc(selectionText(r))}
        <span class="text-[11px] font-normal text-gray-500">${esc(marketLabel(marketOf(r)))}</span></div>
      ${out.settings.kind === 'sgm' ? '' : `<div class="text-[11px] text-gray-500 leading-snug">${sportTag(r.sport)} · ${esc(r.home_team)} v ${esc(r.away_team)} · ${esc(kickoffText(r.kickoff))}</div>`}
    </div>
    <div class="text-right tabular-nums shrink-0" title="${esc(`${bookLabel(out.book)}'s price when last checked (${agoText(r.checked_at)}); the average across the bookies ${odds(r.back)}. Check it at the bookie before you bet.`)}">
      <div class="font-semibold text-amber-400">${odds(l.price)}</div>
      <div class="text-[11px] text-gray-500">avg ${odds(r.back)} · ${agoText(r.checked_at)}</div>
    </div>
    <div class="text-right tabular-nums w-16 shrink-0" title="${esc(`${chanceTitle}. Below: the expected return per unit on this leg alone at ${bookLabel(out.book)}'s price.`)}">
      <div class="text-gray-100">${pct(l.p)}</div>
      <div class="text-[11px] ${signCls(l.edge)}">${signedPct(l.edge)}</div>
    </div>
    <div class="flex gap-1 shrink-0">
      <button type="button" data-lock="${esc(l.id)}" aria-pressed="${isLocked}" title="${isLocked ? 'Unlock this leg' : 'Keep this leg in every multi, then generate again'}"
              class="w-7 h-7 rounded border ${isLocked ? 'border-amber-400 bg-amber-400/10' : 'border-gray-700 hover:border-gray-500'} text-xs">🔒</button>
      <button type="button" data-excl="${esc(l.id)}" title="Leave this leg out, then generate again"
              class="w-7 h-7 rounded border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white text-xs">✕</button>
    </div>
  </div>`;
}

// A Same Game Multi's price: the bookie's leg prices with the model's
// correlation applied (what the min total reads), the plain product, the
// model's own fair price; and the bookie's real quote, typed, for its EV
function sgmPriceHtml(res, i, out) {
  const corr = res.lift > 1 ? 'positively' : 'negatively';
  return `<div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
    <span title="${esc(`The product of ${bookLabel(out.book)}'s leg prices, ${odds(res.product)}, over the model's correlation: the chance all win is ${res.lift.toFixed(2)}× what the legs alone make it (${corr} correlated). The bookie prices a Same Game Multi for correlation too, so this is the price to compare with its quote.`)}">
      Leg product <span class="tabular-nums text-gray-200">${odds(res.product)}</span> · correlation <span class="tabular-nums text-gray-200">×${res.lift.toFixed(2)}</span>
      → est. <span class="tabular-nums font-semibold text-amber-400">${odds(res.price)}</span></span>
    <span title="The model's fair price for all legs winning: 1 over its chance">fair <span class="tabular-nums text-gray-200">${odds(res.fair)}</span></span>
    <label class="flex items-center gap-1.5" title="${esc(`Type ${bookLabel(out.book)}'s Same Game Multi price for these legs: the EV at it, and how it compares with the estimate`)}">Bookie's SGM $
      <input type="number" min="1" step="any" inputmode="decimal" data-quote="${i}" value="${esc(res.quote)}" placeholder="quote"
             class="w-16 bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-xs text-white tabular-nums"></label>
    <span id="mg-quote-${i}">${quoteHtml(res, out)}</span>
  </div>`;
}

function quoteHtml(res, out) {
  const q = num(res.quote);
  if (!(q > 1)) return '';
  const ev = evOf(q, res, out.rate);
  return `EV <span class="font-semibold tabular-nums ${signCls(ev)}">${signedPct(ev)}</span>
    <span class="text-gray-500">(${signedPct(q / res.price - 1)} vs the estimate)</span>`;
}

function card(res, i, out) {
  const s = out.settings, n = +s.n, k = +s.k, sgm = s.kind === 'sgm', sortBy = settings.sort;
  const refund = s.refund === 'cash' ? 'cash' : `a bonus bet worth ${num(s.bonusPct, 0)}%`;
  return `<div class="rounded-xl border border-gray-700 bg-gray-800/40 p-3">
    <div class="flex items-baseline justify-between gap-3 flex-wrap">
      <div class="text-sm text-gray-300"><span class="font-bold text-gray-100">#${i + 1}</span> ·
        ${sgm ? '<span class="text-gray-500">est.</span> ' : ''}<span class="font-bold tabular-nums text-amber-400 text-base">${odds(res.price)}</span> at ${esc(bookLabel(out.book))} ·
        ${n} legs, insurance if ${k}+ win${sgm ? ` · ${sportTag(res.legs[0].row.sport)} ${esc(res.legs[0].row.home_team)} v ${esc(res.legs[0].row.away_team)}` : ''}</div>
      <button type="button" data-copy="${i}" class="text-xs text-blue-400 hover:underline">Copy legs</button>
    </div>
    <div class="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2">
      ${tile('All win', pct(res.pAll), `The chance every leg wins: the multi pays ${odds(res.price)}`)}
      ${tile('Insurance pays', pct(res.pIns), `The chance at least ${k} but not all ${n} legs win: the stake back`)}
      ${tile('Lose', pct(res.pLose), `${sortBy === 'lose' ? 'What they are sorted by: the' : 'The'} chance fewer than ${k} legs win: the stake lost, no refund. All win, Insurance pays and Lose add up to 100%.`, sortBy === 'lose')}
      ${tile('Insurance when it loses', pct(res.cond), `Of the times the multi doesn't win, how often the insurance pays: Insurance pays ÷ (Insurance pays + Lose), ${pct(res.pIns)} of ${pct(res.pIns + res.pLose)}`)}
      ${tile('EV', `<span class="${signCls(res.ev)}">${signedPct(res.ev)}</span>`, `${sortBy === 'ev' ? 'What they are sorted by. ' : ''}Expected return per unit staked: ${odds(res.price)} times the chance all win, plus the refund (${refund}${
        num(s.cap) > 0 && num(s.cap) < num(s.stake, Infinity) ? `, up to $${num(s.cap)} of the $${num(s.stake)} stake` : ''}) times the chance the insurance pays, less the stake${
        sgm ? ". At the estimated price: type the bookie's quote below for the EV at it" : ''}`, sortBy === 'ev')}
    </div>${sgm ? sgmPriceHtml(res, i, out) : ''}
    <div class="mt-2">${res.legs.map(l => legRow(l, out)).join('')}</div>
  </div>`;
}

function renderResults() {
  const box = $('mg-results');
  renderLocks();
  if (run) {
    const what = run.progress != null ? `Pricing the best multis with the game's model… ${Math.round(run.progress * 100)}%`
      : `Searching${run.nLegs ? ` ${run.nLegs.toLocaleString()} legs` : ''}…`;
    box.innerHTML = `<p class="text-sm text-gray-400">${what}</p>`
      + Array.from({ length: 3 }, () => '<span class="bsm-skeleton h-24 w-full block rounded-xl"></span>').join('');
    $('mg-go').disabled = true;
    return;
  }
  $('mg-go').disabled = false;
  if (!results) {
    box.innerHTML = '<p class="text-sm text-gray-500">Set up the multi and press Generate.</p>';
    return;
  }
  if (results.error) {
    box.innerHTML = `<p class="text-sm text-amber-300">${esc(results.error)}</p>`;
    return;
  }
  const out = results, s = out.settings;
  const warn = out.missing?.length ? `<p class="text-xs text-amber-300">Locked but not available under these settings: ${
    out.missing.map(r => esc(selectionText(r))).join(', ')}.</p>` : '';
  const sgm = s.kind === 'sgm';
  const scope = sgm ? 'this game' : `${out.nGroups} game${out.nGroups === 1 ? '' : 's'}`;
  const sortSel = `<label class="flex items-center gap-1.5 text-xs text-gray-400" title="The order the multis found are shown in">Sort by
    <select data-sort class="bg-gray-800 border border-gray-600 rounded px-1.5 py-1 text-xs text-white">${
      RANKS.map(x => `<option value="${x}"${x === settings.sort ? ' selected' : ''}>${x === 'ev' ? 'EV' : 'Lose chance'}</option>`).join('')}</select></label>`;
  const head = `<div class="flex items-start justify-between gap-3 flex-wrap"><p class="text-xs text-gray-500 min-w-0 flex-1">${
    out.results.length ? `The best ${out.results.length}` : 'No'} multi${out.results.length === 1 ? '' : 's'} from
    ${out.nLegs.toLocaleString()} legs at ${esc(bookLabel(out.book))} in ${scope}, ${out.basis === 'cal' ? 'calibrated' : 'model'} chances${
    sgm && out.scored ? ` · the best ${out.scored} assuming independent legs, priced again with the game's model` : ''}${
    out.complete ? '' : ' · the search was cut short: the best found'} · ${new Date(out.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</p>${
    out.results.length > 1 ? sortSel : ''}</div>`;
  if (!out.results.length) {
    const why = out.reason === 'few-groups' ? (sgm
      ? `Only ${out.groups} market${out.groups === 1 ? '' : 's'} or player${out.groups === 1 ? '' : 's'} with legs left in this game (one leg each): fewer than the ${s.n} legs asked for. Allow more markets or lower the min leg price.`
      : `Only ${out.groups} game${out.groups === 1 ? '' : 's'} with legs left: fewer than the ${s.n} legs asked for. Allow more games or markets, or lower the min leg price.`)
      : out.reason === 'locked-group' ? (sgm ? 'Two locked legs are on the same market or player: a Same Game Multi here takes one leg of each.'
        : 'Two locked legs are from the same game: a regular multi takes one leg a game.')
      : out.reason === 'locked-count' ? 'More legs are locked than the multi has.'
      : `No ${sgm ? 'Same Game Multi' : 'multi'} of ${s.n} legs reaches ${odds(num(s.minTotal, 1))}${sgm ? ' at the estimated price' : ''} at these settings. Lower the min total, raise the max leg price or allow more markets.`;
    box.innerHTML = head + warn + `<p class="text-sm text-gray-400">${esc(why)}</p>`;
    return;
  }
  box.innerHTML = head + warn + out.results.map((r, i) => card(r, i, out)).join('');
}

function legsText(res, out) {
  const s = out.settings;
  return [`${KINDS[s.kind]} at ${bookLabel(out.book)}: ${s.n} legs, insurance if ${s.k}+ win · ${odds(res.price)}`,
          ...res.legs.map((l, i) => `${i + 1}. ${selectionText(l.row)} (${marketLabel(marketOf(l.row))}) @ ${odds(l.price)} · ${l.row.home_team} v ${l.row.away_team}, ${kickoffText(l.row.kickoff)}`)].join('\n');
}

function renderNotes() {
  if (!pool && !poolFailed) $('status').textContent = 'Loading prices…';
  else if (poolFailed && !pool) $('status').textContent = 'Could not load the prices. Trying again shortly.';
  else $('status').textContent = '';
  $('method-note').textContent = 'Insurance multis from every selection the bookie prices, at its price when last checked (each leg shows how long ago: '
    + 'check the price at the bookie before you bet). The best by the least chance of losing the stake outright - fewer than the number chosen '
    + 'win, so neither the multi nor the insurance pays - among the multis whose total price reaches the minimum; Sort by shows them by that or by EV. '
    + 'With My Best Bets filters on, legs are only bets the Upcoming list shows under your Filters. '
    + 'A regular multi takes at most one leg a game (of the games ticked), and its legs are '
    + "independent. Chances are the model's, or the calibrated ones when Filters judges by the calibrated edge. EV: the price times the chance "
    + "all win, plus the refund's worth times the chance the insurance pays, less the stake. Players are assumed to play: a leg voided at the "
    + "bookie changes the multi. A Same Game Multi takes one leg per market or player, and its legs are priced together with the game's model "
    + "(the Multi Builder's): its price is the bookie's leg prices with the model's correlation between them applied, as a bookie prices "
    + "one - type the bookie's real quote on a multi for the EV at it. It has the legs the Multi Builder has: no 60-minute result or totals, "
    + 'whole or quarter lines.';
}

// --- events ------------------------------------------------------------------------------

function regenerate() { if (results && !results.error) generate(); }

function bind() {
  bound = true;
  fillForm();
  $('mg-form').addEventListener('submit', e => { e.preventDefault(); generate(); });
  $('mg-form').addEventListener('input', () => { readForm(); renderPoolNote(); });
  $('mg-form').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.sport) {
      settings.sportsOff = t.checked ? settings.sportsOff.filter(x => x !== t.dataset.sport) : [...settings.sportsOff, t.dataset.sport];
    } else if (t.dataset.market) {
      settings.marketsOff = t.checked ? settings.marketsOff.filter(x => x !== t.dataset.market) : [...settings.marketsOff, t.dataset.market];
    } else if (t.dataset.game) {
      const key = t.dataset.game;
      if (settings.gamesOnly) settings.gamesOnly = t.checked ? [...settings.gamesOnly, key] : settings.gamesOnly.filter(x => x !== key);
      else settings.gamesOff = t.checked ? settings.gamesOff.filter(x => x !== key) : [...settings.gamesOff, key];
    }
    readForm();
    if (t.id === 'mg-game') { locked.clear(); excluded.clear(); results = null; renderResults(); }
    renderOptions();
    renderPoolNote();
  });
  $('mg-games-wrap').addEventListener('click', e => {
    const b = e.target.closest('[data-games]');
    if (!b) return;
    settings.gamesOff = [];
    settings.gamesOnly = b.dataset.games === 'none' ? [] : null;
    saveSettings();
    renderGames();
    renderPoolNote();
  });
  $('mg-kind').addEventListener('click', e => {
    const b = e.target.closest('[data-kind]');
    if (!b || b.dataset.kind === settings.kind) return;
    settings.kind = b.dataset.kind;
    if (num(settings.n) > MAX_LEGS[settings.kind]) { settings.n = String(MAX_LEGS[settings.kind]); $('mg-n').value = settings.n; }
    locked.clear();
    excluded.clear();
    results = null;
    saveSettings();
    renderKind();
    renderOptions();
    renderPoolNote();
    renderResults();
  });
  $('mg-results').addEventListener('change', e => {
    const sel = e.target.closest('[data-sort]');
    if (!sel || !results?.results) return;
    settings.sort = rankOf(sel.value) || 'lose';
    saveSettings();
    results.results.sort(comparer(settings.sort));
    renderResults();
  });
  $('mg-results').addEventListener('input', e => {
    const q = e.target.closest('[data-quote]');
    const res = q && results?.results?.[q.dataset.quote];
    if (!res) return;
    res.quote = q.value.trim();
    $(`mg-quote-${q.dataset.quote}`).innerHTML = quoteHtml(res, results);
  });
  $('mg-results').addEventListener('click', async e => {
    const lock = e.target.closest('[data-lock]'), excl = e.target.closest('[data-excl]'), copy = e.target.closest('[data-copy]');
    const find = id => results?.results?.flatMap(r => r.legs).find(l => l.id === id)?.row;
    if (lock) {
      const id = lock.dataset.lock;
      if (locked.has(id)) locked.delete(id); else { const r = find(id); if (r) locked.set(id, r); }
      regenerate();
    } else if (excl) {
      const id = excl.dataset.excl, r = find(id);
      locked.delete(id);
      if (r) excluded.set(id, r);
      renderPoolNote();
      regenerate();
    } else if (copy && results?.results?.[copy.dataset.copy]) {
      try {
        await navigator.clipboard.writeText(legsText(results.results[copy.dataset.copy], results));
        copy.textContent = 'Copied';
      } catch { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = 'Copy legs'; }, 1500);
    }
  });
  $('mg-locks').addEventListener('click', e => {
    const un = e.target.closest('[data-unlock]'), ux = e.target.closest('[data-unexcl]');
    if (un) locked.delete(un.dataset.unlock);
    else if (ux) excluded.delete(ux.dataset.unexcl);
    else if (e.target.closest('[data-clear-locks]')) { locked.clear(); excluded.clear(); }
    else return;
    renderPoolNote();
    renderLocks();
    regenerate();
  });
}

// The tab, drawn: c = { api, calib, judge, prefs } from best-bets.js
export function renderMulti(c) {
  ctx = c;
  if (!bound) bind();
  if (!pool && !poolLoading && !poolFailed) loadPool(c.api);
  renderKind();
  renderOptions();
  renderPoolNote();
  renderResults();
  renderNotes();
}
