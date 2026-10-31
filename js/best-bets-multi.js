// best-bets-multi.js — the Best Bets page's Multi Generator tab (best-bets.js
// shows it). Multis built from every selection one bookie prices
// (/api/best_bets/pool: each at its latest check, every bookie's price), of
// three types:
// - Insurance: n legs, the stake back when at least k win but not all,
//   searched (multi-gen.js) for the least chance of losing the stake outright
//   among those whose total price reaches the minimum asked, and shown by that
//   or by EV (Sort by). A regular multi or a Same Game Multi.
// - Bonus bet combos: a bonus split evenly over every combination of K of N
//   legs, each combo's price in a window around a target; for each K (2 to 6,
//   or one), the N whose combinations come closest to the bets asked for, and
//   the legs that make the most expected cash (multi-combos.js). Legs of one
//   game in a combo, when allowed, are priced from the game's model.
// - System multi: every combination of N legs at each size from the smallest
//   asked, staked per size by Kelly on the page's bank and Risk level, at the
//   cautious chances the Stake column stakes on (multi-system.js), or a set
//   amount spread in the same proportions.
// The searches run in Workers (multi-gen-worker.js). Chances are the
// model's, or the calibrated ones when Filters judges by them (and the
// calibration is in). Legs come from the games starting up to a day chosen
// (all of them, all but some, or only some: Games), at most one a game but
// for Same Game Multis and same-game combos. With "My Best Bets filters" (on
// by default) the legs are only bets the Upcoming list's filters pass.
// Settings are kept in this browser (bsm_bb_multi); locked and excluded legs
// for the visit only.
import { esc, odds, pct, signedPct, signCls, selectionText, bookLabel, sportTag, kickoffText, SPORT_LABELS, money } from './best-bets-shared.js';
import { MARKETS, marketOf, marketLabel } from './best-bets-filters.js';
import { KNOWN_BOOKS } from './best-bets-books.js';
import { calibrateBet, commissionOf } from './calibrate-client.js';
import { edgeAt } from './calibrate.js';
import { refundRate, evOf, RANKS, comparer } from './multi-gen.js';
import { nearestN, oddsWindow, COMBO_SIZES, MAX_COMBOS, COMBO_RANKS, comboComparer } from './multi-combos.js';
import { MAX_SYSTEM_LEGS, SYSTEM_RANKS, systemComparer, legGrowth } from './multi-system.js';
import { RISK_LEVELS, kellyFraction } from './safe-stake.js';
import { gameState, legOf, familyOf, SGM_SPORTS } from './sgm-legs.js';
import { tile, legRow, combosSummaryHtml, combosCardHtml, combosText, systemCardHtml, systemText } from './best-bets-multi-views.js';
import { apiUrl } from './api-config.js';

const $ = id => document.getElementById(id);
const KEY = 'bsm_bb_multi';
export const POOL_MS = 120_000;   // the pool again when older (the backend caches a minute)
const TOP = 10;
const SHORTLIST = 30;              // same-game combos: sets per size priced with the games' models
const SLACK = 1.5;                 // ... found in the window and in it this much wider (the model's correlation moves the price)
const MAX_LEGS = { regular: 10, sgm: 6 };
const DAYS_AHEAD = 8;              // the pool's games: the next 8 days
const TYPES = { insurance: 'Insurance', combos: 'Bonus bet combos', system: 'System multi' };
const KINDS = { regular: 'Regular multi', sgm: 'Same Game Multi' };
const RANK_LABELS = { lose: 'Lose chance', ev: 'EV', nothing: 'Nothing back', growth: 'Kelly growth' };
const rankOf = x => (RANKS.includes(x) ? x : null);

// --- settings ---------------------------------------------------------------------

const DEFAULTS = { type: 'insurance', kind: 'regular', book: '', n: '3', k: '2', minLeg: '1.20', maxLeg: '', minTotal: '3', until: 0,
                   sportsOff: [], marketsOff: [], valueOnly: false, myFilters: true, gamesOff: [], gamesOnly: null, game: '',
                   stake: '50', cap: '50', refund: 'bonus', bonusPct: '75', sort: 'lose',
                   bonusTotal: '50', bets: '10', per: 'any', target: '5', tol: '25', sameGame: false, comboSort: 'ev',
                   sysN: '4', sysMin: '2', spend: '', sysSort: 'growth' };

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* storage unavailable */ }
  const str = k => (typeof s[k] === 'string' ? s[k] : DEFAULTS[k]);
  const list = k => (Array.isArray(s[k]) ? s[k].filter(x => typeof x === 'string') : []);
  return { type: TYPES[s.type] ? s.type : 'insurance', kind: s.kind === 'sgm' ? 'sgm' : 'regular', book: str('book'), n: str('n'), k: str('k'),
           minLeg: str('minLeg'), maxLeg: str('maxLeg'), minTotal: str('minTotal'),
           until: Number.isInteger(s.until) && s.until >= 0 && s.until < DAYS_AHEAD ? s.until : 0,
           sportsOff: list('sportsOff'), marketsOff: list('marketsOff'), valueOnly: !!s.valueOnly, myFilters: s.myFilters !== false,
           gamesOff: list('gamesOff'), gamesOnly: Array.isArray(s.gamesOnly) ? list('gamesOnly') : null, game: str('game'),
           stake: str('stake'), cap: str('cap'), refund: s.refund === 'cash' ? 'cash' : 'bonus', bonusPct: str('bonusPct'),
           sort: rankOf(s.sort) || DEFAULTS.sort,
           bonusTotal: str('bonusTotal'), bets: str('bets'), per: ['any', ...COMBO_SIZES.map(String)].includes(s.per) ? s.per : DEFAULTS.per,
           target: str('target'), tol: str('tol'), sameGame: !!s.sameGame, comboSort: COMBO_RANKS.includes(s.comboSort) ? s.comboSort : DEFAULTS.comboSort,
           sysN: str('sysN'), sysMin: str('sysMin'), spend: str('spend'), sysSort: SYSTEM_RANKS.includes(s.sysSort) ? s.sysSort : DEFAULTS.sysSort };
}

let settings = loadSettings();
const saveSettings = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ } };

// The type chosen (best-bets.js shows the bank and Risk level for system multis)
export const multiType = () => settings.type;
// An insurance Same Game Multi: one game's legs; every other multi spans games
const sgmKind = () => settings.type === 'insurance' && settings.kind === 'sgm';

// --- the pool ---------------------------------------------------------------------

let pool = null;          // /api/best_bets/pool
let poolFailed = false;
let poolLoadedAt = 0;
let poolLoading = null;
let ctx = null;           // best-bets.js's: { api, calib, judge, prefs, filtered, stake, stakeReady, stakeChance, refresh }
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

// The games in the window, of the sports ticked (every type but an insurance Same Game Multi)
function windowRows() {
  const end = dayEnd(settings.until);
  return upcoming().filter(r => Date.parse(r.kickoff) < end && !settings.sportsOff.includes(r.sport));
}

// The rows in scope before the bookie and the leg filters: the window's
// games chosen, or the game picked (an insurance Same Game Multi), the
// markets ticked
function scoped() {
  const s = settings;
  if (sgmKind()) return upcoming().filter(r => gameKey(r) === s.game && !s.marketsOff.includes(marketOf(r)));
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

// --- an insurance Same Game Multi's game, and same-game combos' ---------------------
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

// The candidate legs at the bookie: { id, group, game, solo, sig, price, p,
// pModel, pStake, basis, edge, row, leg }. group: what a multi takes one leg
// of - the game; an insurance Same Game Multi's market family (leg: sgm-legs.js
// legOf's); with same-game combos the game's family (familyOf), or the leg
// alone (solo: no other leg of its game beside it) where the model can't price
// it with others. pModel: the pool's model chance (a Same Game Multi's from its
// engine once priced: the same, bar the NFL moneyline's ties). pStake (system
// multis): the cautious chance the Stake column stakes on, or null.
function candidates() {
  const s = settings, book = bookOf();
  const lo = num(s.minLeg, 1), hi = num(s.maxLeg);
  const sgm = sgmKind() ? sgmGame() : null;
  if (sgmKind() && !sgm) return [];
  const sameGame = s.type === 'combos' && s.sameGame;
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
    const game = gameKey(r), fam = sameGame ? familyOf(r.sport, r) : null;
    out.push({ id, group: leg ? leg.family : sameGame ? `${game}|${fam ?? `solo:${id}`}` : game, game, solo: sameGame && !fam,
               sig: legSig(r), price, p: c.p, pModel: r.model_prob, basis: c.basis, edge: edgeAt(c.p, price, commissionOf(r)),
               pStake: s.type === 'system' ? ctx?.stakeChance?.(r, price) ?? null : null, row: r, leg });
  }
  return out;
}

// --- locked / excluded legs ----------------------------------------------------------

const locked = new Map();     // id -> pool row
const excluded = new Map();   // id -> pool row

// --- the search -----------------------------------------------------------------------

let workers = [];
let runSeq = 0;
let run = null;       // { id, type, settings, legs: Map id -> leg, book, basis, started, nLegs, nGroups, ... }
let results = null;   // { type, ...worker answer, settings, book, basis, legs resolved, at } | { error }
let comboK = null;    // bonus bet combos: only this many legs per combo shown (null: all)

function stopWorker() {
  for (const w of workers) w.terminate();
  workers = [];
}

// One job in a Worker of its own: its answer, or an Error. onProgress(0..1)
// while it reports progress.
function runJob(job, onProgress) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(new URL('./multi-gen-worker.js', import.meta.url), { type: 'module' });
    } catch {
      reject(new Error("This browser can't run the search (no Web Workers)."));
      return;
    }
    workers.push(w);
    const done = () => { w.terminate(); workers = workers.filter(x => x !== w); };
    w.onmessage = e => {
      if (e.data.progress != null) { onProgress?.(e.data.progress); return; }
      done();
      if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data);
    };
    w.onerror = () => { done(); reject(new Error('The search failed. Try again.')); };
    w.postMessage(job);
  });
}

function validate(s) {
  if (s.minLeg !== '' && !(num(s.minLeg) >= 1)) return 'Min leg: a price of 1 or more, or blank.';
  if (s.maxLeg !== '' && !(num(s.maxLeg) >= Math.max(1, num(s.minLeg, 1)))) return 'Max leg: at least the min leg price, or blank.';
  if (s.type === 'combos') {
    const bets = num(s.bets);
    if (!(num(s.bonusTotal) > 0)) return 'Bonus: an amount over 0.';
    if (!Number.isInteger(bets) || bets < 1 || bets > MAX_COMBOS) return `Bets: a whole number from 1 to ${MAX_COMBOS}.`;
    if (!(num(s.target) > 1)) return 'Combo odds: a price over 1.';
    if (!(num(s.tol) >= 0)) return 'Combo odds ±: a percentage, 0 or more.';
    return null;
  }
  if (s.type === 'system') {
    const n = num(s.sysN), lo = num(s.sysMin);
    if (!Number.isInteger(n) || n < 2 || n > MAX_SYSTEM_LEGS) return `Legs: a whole number from 2 to ${MAX_SYSTEM_LEGS}.`;
    if (!Number.isInteger(lo) || lo < 1 || lo > n) return `Sizes from: a whole number from 1 to the ${n} legs.`;
    if (s.spend !== '' && !(num(s.spend) > 0)) return 'Spend: an amount over 0, or blank for Kelly on your bank.';
    return null;
  }
  const n = num(s.n), k = num(s.k), max = MAX_LEGS[s.kind];
  if (!Number.isInteger(n) || n < 2 || n > max) return `Legs: a whole number from 2 to ${max}${s.kind === 'sgm' ? ' for a Same Game Multi' : ''}.`;
  if (!Number.isInteger(k) || k < 1 || k >= n) return `Insurance: at least 1 and fewer than the ${n} legs must win.`;
  if (s.minTotal !== '' && !(num(s.minTotal) >= 1)) return 'Min total: a price of 1 or more, or blank.';
  if (s.kind === 'sgm' && !s.game) return 'Pick a game for the Same Game Multi.';
  return null;
}

const fail = message => { run = null; results = { error: message }; renderResults(); };

async function generate() {
  readForm();
  const problem = validate(settings);
  if (problem) { results = { error: problem }; renderResults(); return; }
  stopWorker();
  if (!pool || poolStale()) {
    run = { pending: true };
    renderResults();
    await loadPool(ctx.api);
    if (!pool) { fail('Could not load the prices. Try again in a moment.'); return; }
  }
  if (settings.type === 'combos') { generateCombos(); return; }
  if (settings.type === 'system') { generateSystem(); return; }
  const sgm = settings.kind === 'sgm';
  if (sgm) {
    if (!sgmGame()) {
      run = { pending: true };
      renderResults();
      await loadGame(settings.game);
      if (!sgmGame()) { fail("Could not load this game's model. Try again in a moment."); return; }
    }
    if (!SGM_SPORTS.includes(settings.game.split(':')[0])) { fail('Same Game Multis are for NFL and NHL games.'); return; }
  }
  const { legs, byId, lockIds, missing } = runLegs();
  const s = { ...settings }, n = num(s.n), k = num(s.k);
  const id = ++runSeq;
  const rate = refundRate({ stake: s.stake, cap: s.cap, refund: s.refund, bonusPct: s.bonusPct });
  run = { id, type: 'insurance', settings: s, legs: byId, book: bookOf(), basis: judgeCal() ? 'cal' : 'model', rate, missing, started: Date.now(),
          nLegs: legs.length, nGroups: new Set(legs.map(l => l.group)).size, progress: null };
  const job = { id, n, k, minTotal: num(s.minTotal, 1), top: TOP, locked: lockIds, rate };
  // A Same Game Multi: the engine's own chances unless judging by the
  // calibrated ones: the worker prices each leg and the multis from the game's bins
  const answer = runJob(sgm
    ? { ...job, type: 'sgm', sport: s.game.split(':')[0], game: sgmGame().data,
        legs: legs.map(l => ({ id: l.id, group: l.group, sig: l.sig, price: l.price, p: l.basis === 'cal' ? l.p : null, leg: l.leg })) }
    : { ...job, type: 'regular', legs: legs.map(({ id: lid, group, sig, price, p }) => ({ id: lid, group, sig, price, p })) },
  f => { if (run?.id === id) { run.progress = f; renderResults(); } });
  renderResults();
  try {
    const data = await answer;
    if (run?.id === id) finishInsurance(data);
  } catch (err) {
    if (run?.id === id) fail(err.message);
  }
}

// The legs for a run, and the locked ones among them (or not: missing)
function runLegs() {
  const legs = candidates();
  const byId = new Map(legs.map(l => [l.id, l]));
  return { legs, byId, lockIds: [...locked.keys()].filter(id => byId.has(id)), missing: [...locked.values()].filter(r => !byId.has(legId(r))) };
}

// A run's legs back from ids, at the model's own chances where a game's
// engine priced them (marginals): the calibrated chances stay as they were
function resolver(r, marginals) {
  return lid => {
    const l = r.legs.get(lid), pm = marginals?.[lid];
    if (pm == null) return l;
    const p = l.basis === 'cal' ? l.p : pm;
    return { ...l, pModel: pm, p, edge: edgeAt(p, l.price, commissionOf(l.row)) };
  };
}

function finishInsurance(data) {
  const r = run;
  run = null;
  const legOfId = resolver(r, data.marginals);
  results = { ...data, type: 'insurance', settings: r.settings, book: r.book, basis: r.basis, rate: r.rate, missing: r.missing, at: Date.now(),
              nLegs: r.nLegs, nGroups: r.nGroups, secs: (Date.now() - r.started) / 1000,
              results: data.results.map(x => ({ ...x, legs: x.legs.map(legOfId), quote: '' })).sort(comparer(settings.sort)) };
  renderResults();
}

// The pool row's fields sgm-legs.js legOf reads
const rowFields = r => ({ market_kind: r.market_kind, market_id: r.market_id, side: r.side, line: r.line, player_id: r.player_id, three_way: r.three_way });

// Bonus bet combos: one Worker per number of legs per combo, at once; with
// same-game legs allowed, the shortlists' games' models loaded, then every
// set priced with them in one more
async function generateCombos() {
  const { legs, byId, lockIds, missing } = runLegs();
  const s = { ...settings }, same = s.sameGame;
  const id = ++runSeq;
  const win = oddsWindow(num(s.target), num(s.tol) / 100);
  const plan = (s.per === 'any' ? COMBO_SIZES : [+s.per]).map(K => ({ K, nn: nearestN(num(s.bets), K) }));
  run = { id, type: 'combos', settings: s, legs: byId, book: bookOf(), basis: judgeCal() ? 'cal' : 'model', missing, started: Date.now(),
          nLegs: legs.length, nGroups: new Set(legs.map(l => l.game)).size, phase: 'search', done: 0, total: plan.filter(p => p.nn).length };
  renderResults();
  const slimLegs = legs.map(({ id: lid, group, game, solo, sig, price, p }) => ({ id: lid, group, game, solo, sig, price, p }));
  const slack = same ? Math.log(SLACK) : 0;
  let perK;
  try {
    perK = await Promise.all(plan.map(async ({ K, nn }) => {
      if (!nn) return { K, reason: 'no-n', results: [], complete: true };
      const out = await runJob({ id, type: 'combos', legs: slimLegs, K, n: nn.n, L: win.L, U: win.U, slack, top: same ? SHORTLIST : TOP,
                                 locked: lockIds, budget: same ? 6e5 : 1e6, priced: !same });
      if (run?.id === id) { run.done++; renderResults(); }
      return { ...out, K, n: nn.n, count: nn.count };
    }));
  } catch (err) {
    if (run?.id === id) fail(err.message);
    return;
  }
  if (run?.id !== id) return;
  let marginals = null;
  if (same) {
    // The games with two or more legs in a set shortlisted: their models
    const need = new Set();
    for (const pk of perK) {
      for (const r of pk.results) {
        const count = new Map();
        for (const lid of r.legs) { const g = byId.get(lid).game; count.set(g, (count.get(g) || 0) + 1); }
        for (const [g, c] of count) if (c > 1 && SGM_SPORTS.includes(g.split(':')[0])) need.add(g);
      }
    }
    Object.assign(run, { phase: 'models', done: 0, total: need.size });
    renderResults();
    await Promise.all([...need].map(g => loadGame(g).then(() => { if (run?.id === id) { run.done++; renderResults(); } })));
    if (run?.id !== id) return;
    run.phase = 'pricing';
    renderResults();
    const games = Object.fromEntries([...need].filter(g => gameData.get(g)?.data).map(g => [g, gameData.get(g).data]));
    const used = [...new Set(perK.flatMap(pk => pk.results.flatMap(r => r.legs)))].map(lid => byId.get(lid));
    try {
      const priced = await runJob({ id, type: 'combos-sgm', games, L: win.L, U: win.U, top: TOP,
                                    legs: used.map(l => ({ id: l.id, group: l.group, game: l.game, sig: l.sig, price: l.price, p: l.p,
                                                           pModel: l.pModel, sport: l.row.sport, row: rowFields(l.row) })),
                                    jobs: perK.filter(pk => pk.results.length).map(pk => ({ K: pk.K, sets: pk.results.map(r => r.legs) })) });
      if (run?.id !== id) return;
      marginals = priced.marginals;
      perK = perK.map(pk => {
        const p = priced.perK.find(x => x.K === pk.K);
        return p ? { ...pk, results: p.results, dropped: p.dropped, scored: p.scored } : pk;
      });
    } catch (err) {
      if (run?.id === id) fail(err.message);
      return;
    }
  }
  finishCombos(perK, marginals);
}

function finishCombos(perK, marginals) {
  const r = run;
  run = null;
  comboK = null;
  const legOfId = resolver(r, marginals);
  const all = [];
  const summary = perK.map(pk => {
    const sets = pk.results.map(x => ({ ...x, K: pk.K, n: pk.n, count: x.combos.length, legs: x.legs.map(legOfId) }));
    all.push(...sets);
    return { K: pk.K, n: pk.n, count: pk.count, complete: pk.complete, reason: pk.results.length ? null : pk.reason, groups: pk.groups,
             dropped: pk.dropped, best: sets[0] || null };
  });
  results = { type: 'combos', settings: r.settings, book: r.book, basis: r.basis, missing: r.missing, at: Date.now(),
              nLegs: r.nLegs, nGroups: r.nGroups, secs: (Date.now() - r.started) / 1000, perK: summary,
              results: all.sort(comboComparer(settings.comboSort)) };
  renderResults();
}

// System multis: the sizes from the smallest asked to every leg, staked by
// Kelly at the legs' cautious chances
async function generateSystem() {
  const { legs, byId, lockIds, missing } = runLegs();
  const s = { ...settings }, n = num(s.sysN), ks = [];
  for (let k = num(s.sysMin); k <= n; k++) ks.push(k);
  const id = ++runSeq;
  run = { id, type: 'system', settings: s, legs: byId, book: bookOf(), basis: judgeCal() ? 'cal' : 'model', missing, started: Date.now(),
          nLegs: legs.length, nGroups: new Set(legs.map(l => l.game)).size };
  renderResults();
  try {
    const out = await runJob({ id, type: 'system', n, ks, top: TOP, locked: lockIds,
                               legs: legs.map(({ id: lid, group, sig, price, p, pStake }) => ({ id: lid, group, sig, price, p, pStake })) });
    if (run?.id !== id) return;
    const r = run;
    run = null;
    const legOfId = resolver(r);
    results = { ...out, type: 'system', ks, settings: r.settings, book: r.book, basis: r.basis, missing: r.missing, at: Date.now(),
                nLegs: r.nLegs, nGroups: r.nGroups, staked: legs.filter(l => legGrowth(l.pStake ?? 0, l.price) > 0).length,
                secs: (Date.now() - r.started) / 1000,
                results: out.results.map(x => ({ ...x, legs: x.legs.map(legOfId) })).sort(systemComparer(settings.sysSort)) };
    renderResults();
  } catch (err) {
    if (run?.id === id) fail(err.message);
  }
}

// How a system multi's stakes are sized now (the bank, Risk level and Spend
// are read as they are, so changing them redraws without searching again):
// { unit: dollars (or bank shares) per unit of Kelly's stakes, dollars, label }
function stakeOf(res) {
  const risk = RISK_LEVELS[ctx?.stake?.risk] || RISK_LEVELS.medium, k = kellyFraction(risk);
  const bank = ctx?.stake?.balance, spend = num(settings.spend);
  if (spend > 0) {
    const total = res.s.reduce((t, x, j) => t + x * res.stats.levels[j].count, 0);
    return { unit: total > 0 ? spend / total : 0, dollars: true,
             label: `${money(spend)} spread over the sizes in the proportions Kelly gives them (Spend). Clear Spend for stakes from your bank.` };
  }
  return bank
    ? { unit: k * bank, dollars: true, label: `${k.toFixed(2)} × Kelly on your ${money(bank)} bank at ${risk.label} risk: ${risk.text}. Kelly at the legs' cautious chances, as the Stake column's.` }
    : { unit: k, dollars: false, label: `${k.toFixed(2)} × Kelly at ${risk.label} risk, as shares of your bank (type your bank at the top for dollars). Kelly at the legs' cautious chances, as the Stake column's.` };
}

// --- rendering --------------------------------------------------------------------------

function renderKind() {
  const type = settings.type;
  $('mg-type').value = type;
  for (const el of document.querySelectorAll('#mg-form [data-only]')) el.classList.toggle('hidden', el.dataset.only !== type);
  $('mg-kind').classList.toggle('hidden', type !== 'insurance');
  $('mg-kind').innerHTML = Object.entries(KINDS).map(([key, label]) => `
    <button type="button" data-kind="${key}" aria-pressed="${key === settings.kind}"
            class="px-3 py-1 rounded-md text-sm transition-all ${key === settings.kind
              ? 'bg-amber-400 text-gray-900 font-bold' : 'text-gray-400 font-semibold hover:text-gray-200'}">${label}</button>`).join('');
  const sgm = sgmKind();
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
  if (pool && sgmKind() && !games.some(g => gameKey(g) === settings.game)) settings.game = games[0] ? gameKey(games[0]) : '';
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
  $('mg-type').value = s.type;
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
  $('mg-bonus-total').value = s.bonusTotal;
  $('mg-bets').value = s.bets;
  $('mg-per').value = s.per;
  $('mg-target').value = s.target;
  $('mg-tol').value = s.tol;
  $('mg-same').checked = s.sameGame;
  $('mg-sys-n').value = s.sysN;
  $('mg-sys-min').value = s.sysMin;
  $('mg-spend').value = s.spend;
}

// The form into the settings, then saved
function readForm() {
  const v = id => $(id).value.trim();
  settings = { ...settings, n: v('mg-n'), k: v('mg-k'), minLeg: v('mg-min-leg'), maxLeg: v('mg-max-leg'), minTotal: v('mg-min-total'),
               valueOnly: $('mg-value').checked, myFilters: $('mg-filters').checked, stake: v('mg-stake'), cap: v('mg-cap'),
               refund: $('mg-refund').value === 'cash' ? 'cash' : 'bonus', bonusPct: v('mg-bonus'),
               bonusTotal: v('mg-bonus-total'), bets: v('mg-bets'), per: $('mg-per').value || 'any', target: v('mg-target'), tol: v('mg-tol'),
               sameGame: $('mg-same').checked, sysN: v('mg-sys-n'), sysMin: v('mg-sys-min'), spend: v('mg-spend'),
               book: $('mg-book').value || settings.book, until: +$('mg-until').value || 0,
               game: sgmKind() ? $('mg-game').value || settings.game : settings.game };
  saveSettings();
}

// Games (all but an insurance Same Game Multi): the window's games of the
// sports ticked, ticked when in. Keys of games no longer priced are dropped.
function renderGames() {
  $('mg-games-wrap').classList.toggle('hidden', sgmKind());
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
  const target = num(settings.target), tol = num(settings.tol);
  const win = target > 1 && tol >= 0 ? oddsWindow(target, tol / 100) : null;
  $('mg-window').textContent = win ? `(${odds(win.lo)}–${odds(win.hi)})` : '';
  const note = $('mg-pool-note');
  if (!pool) { note.textContent = poolFailed ? 'Could not load the prices.' : 'Loading prices…'; return; }
  if (sgmKind() && settings.game && !sgmGame()) {
    const g = gameData.get(settings.game);
    if (g?.failed && Date.now() - g.at < 30_000) { note.textContent = "Could not load this game's model."; return; }
    loadGame(settings.game);
    note.textContent = "Loading this game's model…";
    return;
  }
  const legs = candidates();
  const games = new Set(legs.map(l => l.game)).size;
  const basis = `${settings.myFilters ? 'your filters · ' : ''}${judgeCal() ? 'calibrated chances' : 'model chances'}`;
  const inGames = `in ${games} game${games === 1 ? '' : 's'}`;
  if (settings.type === 'system') {
    if (ctx && ctx.stakeReady === false) { note.textContent = 'Loading the settled bets the stakes are worked out from…'; return; }
    const staked = legs.filter(l => legGrowth(l.pStake ?? 0, l.price) > 0);
    note.textContent = `${staked.length.toLocaleString()} of ${legs.length.toLocaleString()} legs at ${bookLabel(bookOf())} have a stake (${
      new Set(staked.map(l => l.game)).size} games) · ${basis}`;
    note.title = 'A system multi takes legs the Stake column would stake on: an edge at the cautious chance (the calibrated or predicted-close edge\'s 90% low end, or the model\'s edge cut to what settled bets like it have proven)';
    return;
  }
  note.textContent = sgmKind()
    ? `${legs.length.toLocaleString()} legs at ${bookLabel(bookOf())} in this game · ${basis}`
    : `${legs.length.toLocaleString()} legs at ${bookLabel(bookOf())} ${inGames} · ${basis}`;
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
    <div class="mt-2">${res.legs.map(l => legRow(l, { book: out.book, showGame: !sgm, locked: locked.has(l.id) })).join('')}</div>
  </div>`;
}

// The results shown: bonus bet combos filtered to one number of legs per
// combo when one is picked, at most TOP
const shownResults = () => (results.type === 'combos' && comboK != null ? results.results.filter(r => r.K === comboK) : results.results).slice(0, TOP);

function progressText() {
  if (run.type === 'combos') {
    if (run.phase === 'models') return `Loading ${run.total} game${run.total === 1 ? "'s model" : "s' models"} for the same-game combos… ${run.done} of ${run.total}`;
    if (run.phase === 'pricing') return "Pricing the same-game combos with the games' models…";
    return `Searching ${run.nLegs.toLocaleString()} legs… ${run.done} of ${run.total} combo size${run.total === 1 ? '' : 's'} done`;
  }
  if (run.progress != null) return `Pricing the best multis with the game's model… ${Math.round(run.progress * 100)}%`;
  return `Searching${run.nLegs ? ` ${run.nLegs.toLocaleString()} legs` : ''}…`;
}

function renderResults() {
  const box = $('mg-results');
  renderLocks();
  if (run) {
    box.innerHTML = `<p class="text-sm text-gray-400">${progressText()}</p>`
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
  const out = results, s = out.settings, type = out.type;
  const warn = out.missing?.length ? `<p class="text-xs text-amber-300">Locked but not available under these settings: ${
    out.missing.map(r => esc(selectionText(r))).join(', ')}.</p>` : '';
  const sgm = type === 'insurance' && s.kind === 'sgm';
  const scope = sgm ? 'this game' : `${out.nGroups} game${out.nGroups === 1 ? '' : 's'}`;
  const ranks = type === 'combos' ? COMBO_RANKS : type === 'system' ? SYSTEM_RANKS : RANKS;
  const sortNow = type === 'combos' ? settings.comboSort : type === 'system' ? settings.sysSort : settings.sort;
  const shown = shownResults();
  const sortSel = `<label class="flex items-center gap-1.5 text-xs text-gray-400" title="The order the results are shown in">Sort by
    <select data-sort class="bg-gray-800 border border-gray-600 rounded px-1.5 py-1 text-xs text-white">${
      ranks.map(x => `<option value="${x}"${x === sortNow ? ' selected' : ''}>${RANK_LABELS[x]}</option>`).join('')}</select></label>`;
  const what = type === 'combos' ? 'set' : 'multi';
  const cut = type === 'combos' ? out.perK.some(pk => pk.best && !pk.complete) : type === 'insurance' && !out.complete;
  const head = `<div class="flex items-start justify-between gap-3 flex-wrap"><p class="text-xs text-gray-500 min-w-0 flex-1">${
    shown.length ? `The best ${shown.length}` : 'No'} ${what}${shown.length === 1 ? '' : 's'} from
    ${out.nLegs.toLocaleString()} legs at ${esc(bookLabel(out.book))} in ${scope}, ${out.basis === 'cal' ? 'calibrated' : 'model'} chances${
    sgm && out.scored ? ` · the best ${out.scored} assuming independent legs, priced again with the game's model` : ''}${
    type === 'combos' && s.sameGame ? " · legs of one game in a combo priced with the game's model" : ''}${
    type === 'system' ? ` · ${out.staked} with a stake` : ''}${
    cut ? ' · the search was cut short: the best found' : ''} · ${new Date(out.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</p>${
    shown.length > 1 ? sortSel : ''}</div>`;
  if (type === 'combos') { renderCombos(box, head + warn, shown); return; }
  if (type === 'system') { renderSystem(box, head + warn, shown); return; }
  if (!shown.length) {
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
  box.innerHTML = head + warn + shown.map((r, i) => card(r, i, out)).join('');
}

function renderCombos(box, top, shown) {
  const out = results, s = out.settings, bonus = num(settings.bonusTotal, num(s.bonusTotal, 0));
  const summary = out.perK.length > 1 ? combosSummaryHtml(out, bonus, comboK) : '';
  if (!shown.length) {
    const win = oddsWindow(num(s.target), num(s.tol) / 100);
    const pk = out.perK[0];
    const dropped = out.perK.reduce((t, x) => t + (x.dropped?.window || 0) + (x.dropped?.unpriced || 0), 0);
    const why = out.perK.length === 1 && pk.reason === 'few-groups'
      ? `Only ${pk.groups} ${s.sameGame ? 'markets or players' : 'games'} with legs that could fit: fewer than the ${pk.n} legs ${pk.count} bets need. Allow more games or markets, or widen the ±.`
      : out.perK.every(x => x.reason?.startsWith('locked')) ? "The locked legs can't all be in combos in the window together, or are more than the legs asked for."
      : `No set of legs has every combo between ${odds(win.lo)} and ${odds(win.hi)} at these settings. Widen the ±, move the target, allow more markets or games, or untick My Best Bets filters.${
        dropped ? ` ${dropped} same-game set${dropped === 1 ? '' : 's'} left the window or couldn't be priced once the games' models priced them.` : ''}`;
    box.innerHTML = top + summary + `<p class="text-sm text-gray-400">${esc(why)}</p>`;
    return;
  }
  const lockedIds = new Set(locked.keys());
  box.innerHTML = top + summary + shown.map((r, i) => combosCardHtml(r, i, out, { bonus, sortBy: settings.comboSort, lockedIds })).join('');
}

function renderSystem(box, top, shown) {
  const out = results, s = out.settings;
  if (!shown.length) {
    const why = out.reason === 'few-groups'
      ? `Only ${out.groups} game${out.groups === 1 ? '' : 's'} with a leg the Stake column would stake on (an edge at the cautious chance): fewer than the ${s.sysN} legs asked for. Lower Legs, allow more games or markets, or untick My Best Bets filters.`
      : out.reason === 'locked-group' ? 'Two locked legs are from the same game: a system multi takes one leg a game.'
      : out.reason === 'locked-count' ? 'More legs are locked than the multi has.'
      : 'No system multi at these settings.';
    box.innerHTML = top + `<p class="text-sm text-gray-400">${esc(why)}</p>`;
    return;
  }
  const lockedIds = new Set(locked.keys());
  box.innerHTML = top + shown.map((r, i) => systemCardHtml(r, i, out, { stake: stakeOf(r), sortBy: settings.sysSort, lockedIds })).join('');
}

function legsText(res, out) {
  const s = out.settings;
  return [`${KINDS[s.kind]} at ${bookLabel(out.book)}: ${s.n} legs, insurance if ${s.k}+ win · ${odds(res.price)}`,
          ...res.legs.map((l, i) => `${i + 1}. ${selectionText(l.row)} (${marketLabel(marketOf(l.row))}) @ ${odds(l.price)} · ${l.row.home_team} v ${l.row.away_team}, ${kickoffText(l.row.kickoff)}`)].join('\n');
}

const copyText = (res, out) => (out.type === 'combos' ? combosText(res, out, num(settings.bonusTotal, num(out.settings.bonusTotal, 0)))
  : out.type === 'system' ? systemText(res, out, stakeOf(res)) : legsText(res, out));

const NOTES = {
  insurance: 'Insurance multis from every selection the bookie prices, at its price when last checked (each leg shows how long ago: '
    + 'check the price at the bookie before you bet). The best by the least chance of losing the stake outright - fewer than the number chosen '
    + 'win, so neither the multi nor the insurance pays - among the multis whose total price reaches the minimum; Sort by shows them by that or by EV. '
    + 'With My Best Bets filters on, legs are only bets the Upcoming list shows under your Filters. '
    + 'A regular multi takes at most one leg a game (of the games ticked), and its legs are '
    + "independent. Chances are the model's, or the calibrated ones when Filters judges by the calibrated edge. EV: the price times the chance "
    + "all win, plus the refund's worth times the chance the insurance pays, less the stake. Players are assumed to play: a leg voided at the "
    + "bookie changes the multi. A Same Game Multi takes one leg per market or player, and its legs are priced together with the game's model "
    + "(the Multi Builder's): its price is the bookie's leg prices with the model's correlation between them applied, as a bookie prices "
    + "one - type the bookie's real quote on a multi for the EV at it. It has the legs the Multi Builder has: no 60-minute result or totals, "
    + 'whole or quarter lines.',
  combos: 'Bonus bet combos: the bonus split evenly over every combination of K of N legs (a bet on each), each combo priced within the window '
    + 'around the target. For each number of legs per combo (2 to 6, or the one chosen) the number of legs whose combinations come closest to '
    + 'the bets asked for, and the legs that make the most expected cash: each combo\'s chance times its price less 1 (a bonus bet\'s stake '
    + "doesn't come back), added up. The best of each number is shown above the sets. Prices are the bookie's when last checked: check them "
    + 'before you bet. With My Best Bets filters on, legs are only bets the Upcoming list shows under your Filters. One leg a game, unless '
    + "same-game legs are allowed: then a combo's legs of one game are a Same Game Multi at the bookie, priced here at the model's correlation "
    + "(an estimate of the bookie's price; NFL and NHL), one leg per market or player. Chances are the model's, or the calibrated ones when "
    + 'Filters judges by the calibrated edge.',
  system: 'System multis: every combination of N legs at each size from the smallest chosen (doubles, trebles, ...), one stake per combo at '
    + "each size, as a bookie's system or combo betslip takes them. The stakes are Kelly's: the shares of the bank that grow it fastest over "
    + 'every way the legs can finish, at the cautious chances the Stake column stakes on (the calibrated or predicted-close edge\'s 90% low end, '
    + "or the model's edge cut to what settled bets like it have proven), times the Risk level's fraction - or a Spend amount split in the same "
    + 'proportions. Legs are only those with such an edge, one a game, ranked by the bank growth they make. Expected profit and the chances '
    + "shown are at the legs' chances shown (the model's or calibrated). Prices are the bookie's when last checked: check them before you bet.",
};

function renderNotes() {
  if (!pool && !poolFailed) $('status').textContent = 'Loading prices…';
  else if (poolFailed && !pool) $('status').textContent = 'Could not load the prices. Trying again shortly.';
  else $('status').textContent = '';
  $('method-note').textContent = NOTES[settings.type];
}

// --- events ------------------------------------------------------------------------------

function regenerate() { if (results && !results.error) generate(); }

function bind() {
  bound = true;
  fillForm();
  $('mg-form').addEventListener('submit', e => { e.preventDefault(); generate(); });
  $('mg-form').addEventListener('input', () => {
    readForm();
    renderPoolNote();
    // The bonus to split and the amount to spend scale the results shown
    if (results && !results.error && results.type !== 'insurance' && !run) renderResults();
  });
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
    if (t.id === 'mg-type') {
      settings.type = TYPES[t.value] ? t.value : 'insurance';
      saveSettings();
      stopWorker();
      run = null;
      locked.clear();
      excluded.clear();
      results = null;
      comboK = null;
      renderKind();
      renderNotes();
      renderResults();
      ctx?.refresh?.();   // the page's bank and Risk level show for system multis
    }
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
    if (results.type === 'combos') {
      settings.comboSort = COMBO_RANKS.includes(sel.value) ? sel.value : 'ev';
      results.results.sort(comboComparer(settings.comboSort));
    } else if (results.type === 'system') {
      settings.sysSort = SYSTEM_RANKS.includes(sel.value) ? sel.value : 'growth';
      results.results.sort(systemComparer(settings.sysSort));
    } else {
      settings.sort = rankOf(sel.value) || 'lose';
      results.results.sort(comparer(settings.sort));
    }
    saveSettings();
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
    const pickK = e.target.closest('[data-combo-k]');
    const find = id => results?.results?.flatMap(r => r.legs).find(l => l.id === id)?.row;
    if (pickK) {
      comboK = pickK.dataset.comboK ? +pickK.dataset.comboK : null;
      renderResults();
    } else if (lock) {
      const id = lock.dataset.lock;
      if (locked.has(id)) locked.delete(id); else { const r = find(id); if (r) locked.set(id, r); }
      regenerate();
    } else if (excl) {
      const id = excl.dataset.excl, r = find(id);
      locked.delete(id);
      if (r) excluded.set(id, r);
      renderPoolNote();
      regenerate();
    } else if (copy) {
      const res = shownResults()[copy.dataset.copy];
      if (!res) return;
      const label = copy.textContent;
      try {
        await navigator.clipboard.writeText(copyText(res, results));
        copy.textContent = 'Copied';
      } catch { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = label; }, 1500);
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

// The tab, drawn: c = { api, calib, judge, prefs, filtered, stake, stakeReady,
// stakeChance, refresh } from best-bets.js
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
