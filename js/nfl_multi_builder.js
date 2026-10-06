// nfl_multi_builder.js — drives nfl/pages/tryscorer_predictions.html ("Multi Builder")
// NFL counterpart to js/tryscorer_predictions.js (same layout: team cards with
// anytime prices + steppers, line selectors, betslip, community strip). No crowd
// blend (no crowd picks exist for NFL).
//
// Lines (margin / total / team points) filter nfl.game_sgm_bins joint score
// distributions (/api/nfl/game_sgm_bins_range). Player legs — anytime TD, QB
// passing TDs, kicker FGs, team D/ST TD, each any N+ — come from
// /api/nfl/game_player_data (per-player shares of team TDs, see
// nrl-flask-backend/nfl_player_model.py) and are combined with each bin's own
// TD/FG count distributions, so they stay correlated with the lines.
// Selections are kept per game; the betslip multiplies across games like NRL.
import { apiUrl, BACKEND } from './api-config.js';
import { nflLogoUrl } from './nfl-logos.js';
import { getSession } from './supabase-client.js';
import { nflWeatherLabel } from './nfl-weather.js';

const $ = id => document.getElementById(id);

const weekBadge      = $('week-badge');
const weekPrevBtn    = $('week-prev');
const weekNextBtn    = $('week-next');
const gameSelect     = $('game-select');
const noGamesMsg     = $('no-games-msg');
const builderSection = $('builder-section');
const builderMatchup = $('builder-matchup');
const builderKickoff = $('builder-kickoff');
const teamsContainer = $('teams-container');
const resultDiv      = $('result');
const resetMatchBtn  = $('reset-match-btn');
const resetAllBtn    = $('reset-all-btn');

const marginDirHome  = $('margin-dir-home');
const marginDirAway  = $('margin-dir-away');
const marginValSel   = $('margin-val');
const marginClearBtn = $('margin-clear');

let currentWeek  = null;
let games        = [];
let currentGame  = null;
const binsCache  = {};   // game_id -> bins[] (with per-bin h_td/a_td/h_fg/a_fg)
const gameState  = {};   // game_id -> per-game selections, see newGameState()
let betslipExpanded = false;
let bookieOdds   = null;

const MAX_N = { anytime: 4, pass_td: 6, fg: 5, dst_td: 3 };
const MIN_SHOWN_PROB = 0.02;   // condensed list: hide players below 2% anytime
const EXCLUDED = ['out', 'inactive', 'ir'];

function newGameState() {
  return {
    lines: { marginTeam: null, marginL: null, totalDir: null, totalN: null,
             homeTotalDir: null, homeTotalN: null, awayTotalDir: null, awayTotalN: null },
    picks: new Map(),          // key -> { side, kind, playerId, teamId, name, n }
    out: new Set(), in: new Set(),
    showAll: { home: false, away: false },
    playerData: null,          // /api/nfl/game_player_data for this game's overrides
    teamDists: null,           // { home: {td, fg}, away: {td, fg} } — whole-game mixtures
    loadSeq: 0,                // drops stale game_player_data responses
  };
}
const S = (gid = currentGame?.game_id) => (gameState[gid] ||= newGameState());
const gameById = gid => games.find(g => String(g.game_id) === String(gid));

// --- FORMATTING ---
const pct  = p => (p == null ? '–' : `${(p * 100).toFixed(1)}%`);
const odds = p => (p > 1e-6 ? `$${(1 / p).toFixed(2)}` : '–');
const esc  = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function lineToN(L) { return Math.floor(-L) + 1; }

// =============================================================================
// PROBABILITY ENGINE (mirrors nfl_player_model.build_atoms / pick_success_by_n)
// =============================================================================
// Every team TD is exactly one of: a D/ST TD, a rush TD by player i, or a pass TD
// from the starting QB to receiver r. A pass TD credits the receiver's anytime
// pick AND the QB's pass-TD pick — never the QB's anytime pick. Shares are
// conditional on the player playing: picked players are assumed to play (bets on
// a player who sits out are void); everyone else is weighted by p_play.
function buildAtoms(team, teamPicks) {
  const dst = team.dst_frac, pf = team.pass_frac, qbId = team.starting_qb_id;
  const pickedIds = new Set(teamPicks.filter(p => p.playerId != null).map(p => p.playerId));
  const atoms = new Map();
  let used = 0;
  const add = (scorerId, passerId, isDst, p) => {
    if (p <= 0) return;
    const cred = [];
    teamPicks.forEach((pk, i) => {
      if (pk.kind === 'dst_td' && isDst) cred.push(i);
      else if (pk.kind === 'anytime' && scorerId != null && pk.playerId === scorerId) cred.push(i);
      else if (pk.kind === 'pass_td' && passerId != null && pk.playerId === passerId) cred.push(i);
    });
    const key = cred.join(',');
    const a = atoms.get(key) || { p: 0, cred };
    a.p += p;
    atoms.set(key, a);
    used += p;
  };
  add(null, null, true, dst);
  for (const pl of team.players) {
    if (!pl.active) continue;
    const w = pickedIds.has(pl.id) ? 1 : (pl.p_play ?? 1);
    add(pl.id, null, false, (1 - dst) * (1 - pf) * pl.rush_share * w);
    add(pl.id, qbId, false, (1 - dst) * pf * pl.rec_share * w);
  }
  const list = [...atoms.values()];
  if (used < 1) list.push({ p: 1 - used, cred: [] });
  else if (used > 1) list.forEach(a => { a.p /= used; });
  return list;
}

// S[n] = P(every pick reaches its min | team scores n TDs); DP with counts capped at mins.
function pickSuccessByN(atoms, mins, maxN) {
  const target = mins.join(',');
  let state = new Map([[mins.map(() => 0).join(','), 1]]);
  const out = [];
  for (let n = 0; n <= maxN; n++) {
    out.push(state.get(target) || 0);
    if (n === maxN) break;
    const next = new Map();
    for (const [key, sp] of state) {
      const st = key.split(',').map(Number);
      for (const { p, cred } of atoms) {
        let k2 = key;
        if (cred.length) {
          const s2 = st.slice();
          for (const i of cred) if (s2[i] < mins[i]) s2[i]++;
          k2 = s2.join(',');
        }
        next.set(k2, (next.get(k2) || 0) + sp * p);
      }
    }
    state = next;
  }
  return out;
}

function atLeast(arr, k) {
  let s = 0;
  for (let n = k; n < arr.length; n++) s += arr[n] || 0;
  return s;
}

function binomAtLeast(n, p, k) {
  if (k <= 0) return 1;
  if (n < k) return 0;
  let below = 0, c = 1;
  for (let j = 0; j < k; j++) {
    below += c * Math.pow(p, j) * Math.pow(1 - p, n - j);
    c = c * (n - j) / (j + 1);
  }
  return Math.max(0, 1 - below);
}

function mixtureDist(bins, key) {
  const total = bins.reduce((s, b) => s + (b.c || 0), 0) || 1;
  const out = [];
  for (const b of bins) {
    (b[key] || [1]).forEach((p, n) => { out[n] = (out[n] || 0) + p * b.c / total; });
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i] || 0;
  return out;
}

// Per-TD atom probability for a single leg (FG legs read the team FG dist instead).
function legAtomP(team, kind, player) {
  if (kind === 'anytime') return player.td_share;
  if (kind === 'pass_td') return player.pass_td_share;
  if (kind === 'dst_td')  return team.dst_frac;
  return 0;
}

// Unconditional single-leg probability (whole game, no lines) — the table prices.
function singleLegProb(gs, side, kind, player, n) {
  if (!gs.teamDists || !gs.playerData) return null;
  const d = gs.teamDists[side];
  if (kind === 'fg') return atLeast(d.fg, n);
  const p = legAtomP(gs.playerData[side], kind, player);
  let s = 0;
  d.td.forEach((pn, k) => { s += pn * binomAtLeast(k, p, n); });
  return s;
}

// --- LINES ---
function buildConstraints(L) {
  let margin = null, total = null, homeTotal = null, awayTotal = null;
  if (L.marginTeam && L.marginL != null) {
    const N1 = lineToN(L.marginL);  // margin (home - away) >= N1 for home, <= -N1 for away
    margin = L.marginTeam === 'home' ? { type: 'over', val: N1 } : { type: 'under', val: 1 - N1 };
  }
  if (L.totalDir && L.totalN != null) total = { type: L.totalDir, val: L.totalN };
  if (L.homeTotalDir && L.homeTotalN != null) homeTotal = { type: L.homeTotalDir, val: L.homeTotalN };
  if (L.awayTotalDir && L.awayTotalN != null) awayTotal = { type: L.awayTotalDir, val: L.awayTotalN };
  return { margin, total, homeTotal, awayTotal };
}

function filterBins(bins, c) {
  return bins.filter(b => {
    if (c.margin?.type === 'over'  && b.m < c.margin.val)  return false;
    if (c.margin?.type === 'under' && b.m >= c.margin.val) return false;
    if (c.total?.type  === 'over'  && b.t < c.total.val)   return false;
    if (c.total?.type  === 'under' && b.t >= c.total.val)  return false;
    const hs = (b.m + b.t) / 2, as_ = (b.t - b.m) / 2;
    if (c.homeTotal?.type === 'over'  && hs  <  c.homeTotal.val) return false;
    if (c.homeTotal?.type === 'under' && hs  >= c.homeTotal.val) return false;
    if (c.awayTotal?.type === 'over'  && as_ <  c.awayTotal.val) return false;
    if (c.awayTotal?.type === 'under' && as_ >= c.awayTotal.val) return false;
    return true;
  });
}

function lineLabels(game, L) {
  const out = [];
  if (L.marginTeam && L.marginL != null) {
    const team = L.marginTeam === 'home' ? game.home_team : game.away_team;
    out.push(L.marginL === -0.5 ? `${team} To Win` : `${team} ${L.marginL < 0 ? '' : '+'}${L.marginL}`);
  }
  if (L.totalDir && L.totalN != null) out.push(`Total ${L.totalDir === 'over' ? 'Over' : 'Under'} ${L.totalN - 0.5}`);
  if (L.homeTotalDir && L.homeTotalN != null) out.push(`${game.home_team} ${L.homeTotalDir === 'over' ? 'Over' : 'Under'} ${L.homeTotalN - 0.5}`);
  if (L.awayTotalDir && L.awayTotalN != null) out.push(`${game.away_team} ${L.awayTotalDir === 'over' ? 'Over' : 'Under'} ${L.awayTotalN - 0.5}`);
  return out;
}

function legLabel(kind, name, n) {
  switch (kind) {
    case 'anytime': return n === 1 ? `${name} Anytime TD` : `${name} ${n}+ TDs`;
    case 'pass_td': return `${name} ${n}+ Pass TD${n > 1 ? 's' : ''}`;
    case 'dst_td':  return `${name} D/ST ${n}+ TD${n > 1 ? 's' : ''}`;
    case 'fg':      return `${name} ${n}+ FG${n > 1 ? 's' : ''} Made`;
  }
  return name;
}

// Joint probability of one game's line filters + player legs, bin by bin.
function gameProbability(gid) {
  const gs = S(gid), bins = binsCache[gid];
  if (!bins?.length) return null;
  const totalCount = bins.reduce((s, b) => s + (b.c || 0), 0) || 1;
  const filtered = filterBins(bins, buildConstraints(gs.lines));
  const lineProb = filtered.reduce((s, b) => s + b.c, 0) / totalCount;
  const perSide = {};
  for (const side of ['home', 'away']) {
    const team = gs.playerData?.[side];
    const sidePicks = [...gs.picks.values()].filter(p => p.side === side);
    const tdPicks = sidePicks.filter(p => p.kind !== 'fg');
    const fgMin = Math.max(0, ...sidePicks.filter(p => p.kind === 'fg').map(p => p.n));
    let Sn = null;
    if (tdPicks.length && team) {
      const key = side === 'home' ? 'h_td' : 'a_td';
      const maxN = Math.max(0, ...filtered.map(b => (b[key] || [1]).length - 1));
      Sn = pickSuccessByN(buildAtoms(team, tdPicks), tdPicks.map(p => p.n), maxN);
    }
    perSide[side] = { Sn, fgMin };
  }
  let num = 0;
  for (const b of filtered) {
    let f = b.c || 0;
    for (const side of ['home', 'away']) {
      const { Sn, fgMin } = perSide[side];
      if (Sn) {
        let s = 0;
        (b[side === 'home' ? 'h_td' : 'a_td'] || [1]).forEach((pn, n) => { s += pn * (Sn[n] || 0); });
        f *= s;
      }
      // Within a bin TD and FG counts are stored as marginals only; treated as
      // independent there (the bin already pins the team's points).
      if (fgMin > 0) f *= atLeast(b[side === 'home' ? 'h_fg' : 'a_fg'] || [1], fgMin);
    }
    num += f;
  }
  return { prob: num / totalCount, lineProb };
}

function gameHasSelections(gid) {
  const gs = gameState[gid];
  return !!gs && (gs.picks.size > 0 || lineLabels(gameById(gid) || {}, gs.lines).length > 0);
}

// =============================================================================
// TEAM CARDS
// =============================================================================
const STATUS_BADGE = {
  questionable: ['Q', 'text-yellow-300 border-yellow-500/40 bg-yellow-500/10', 'Questionable'],
  doubtful:     ['D', 'text-orange-300 border-orange-500/40 bg-orange-500/10', 'Doubtful'],
  out:          ['OUT', 'text-red-300 border-red-500/40 bg-red-500/10', 'Out'],
  inactive:     ['INA', 'text-red-300 border-red-500/40 bg-red-500/10', 'Inactive'],
  ir:           ['IR', 'text-red-300 border-red-500/40 bg-red-500/10', 'Injured reserve'],
};
const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4 };

function stepperHtml(key, val, max) {
  const base = 'w-6 h-6 border rounded flex items-center justify-center text-sm font-bold transition-colors';
  const minus = val > 0 ? `${base} border-red-500 text-red-400 hover:bg-red-500/20` : `${base} border-gray-700 text-gray-600`;
  const plus = val >= max ? `${base} border-gray-700 text-gray-600`
    : val > 0 ? `${base} border-green-500 text-green-400 hover:bg-green-500/20`
              : `${base} border-gray-600 text-gray-400 hover:border-green-400 hover:text-green-400`;
  return `
    <div class="flex items-center gap-1 shrink-0">
      <button type="button" class="${minus}" data-step="-1" data-key="${key}">−</button>
      <span class="w-6 text-center text-sm font-bold text-white select-none">${val}</span>
      <button type="button" class="${plus}" data-step="1" data-key="${key}">+</button>
    </div>`;
}

function priceHtml(p, loading) {
  if (p == null) return loading ? '<span class="bsm-skeleton h-3 w-14 ml-auto block"></span>'
                                : '<div class="text-xs font-semibold text-gray-500">–</div>';
  return `<div class="text-xs font-semibold text-gray-300">${pct(p)}</div><div class="text-xs text-gray-500">${odds(p)}</div>`;
}

// One selectable row. kind: anytime | pass_td | fg | dst_td
function marketRow(gs, side, kind, { key, name, sub = '', subTitle = '', meta = '', player = null, badge = '', availBtn = '' }) {
  const picked = gs.picks.get(key);
  const val = picked ? picked.n : 0;
  const p = singleLegProb(gs, side, kind, player, Math.max(1, val));
  return `
    <div class="flex items-center gap-2 py-2 px-1 player-row${val > 0 ? ' bg-gray-700/40' : ''}">
      <div class="flex-1 min-w-0">
        <span class="text-sm">${esc(name)}</span>
        ${sub ? `<span class="text-xs text-gray-500 ml-1"${subTitle ? ` title="${esc(subTitle)}"` : ''}>${sub}</span>` : ''}${badge}${availBtn}
        ${meta ? `<div class="text-[11px] text-gray-500 leading-tight mt-0.5">${meta}</div>` : ''}
      </div>
      <div class="w-20 text-right shrink-0">${priceHtml(p, binsCache[currentGame?.game_id] === undefined)}</div>
      ${stepperHtml(key, val, MAX_N[kind])}
    </div>`;
}

function statusBadge(pl) {
  const b = STATUS_BADGE[pl.status];
  if (!b) return '';
  const title = [b[2], pl.status_detail].filter(Boolean).join(' — ');
  return `<span class="ml-1 px-1 rounded border text-[10px] font-bold align-middle ${b[1]}" title="${esc(title)}">${b[0]}</span>`;
}

// "WR1" by projected role (backend role_rank); the published depth-chart slot
// lags, so it's kept in the tooltip.
const slotLabel = pl => `${pl.pos}${pl.role_rank ?? pl.depth}`;
const slotTitle = pl => `Depth chart: ${pl.pos}${pl.depth}` + (pl.role_rank && pl.role_rank !== pl.depth ? ' (ranked by projected role)' : '');

// Expected snaps · last 3 games' snaps with TDs · TD totals
function playerMeta(pl) {
  const s = pl.stats || {};
  const bits = [];
  if (pl.active && pl.snap_proj != null) bits.push(`Exp <span class="text-gray-300">${Math.round(pl.snap_proj * 100)}%</span> snaps`);
  const snaps = s.recent_snaps || [];
  if (snaps.length) {
    const games = snaps.map((v, i) => {
      const td = (s.recent_tds || [])[i] || 0;
      const pctTxt = v == null ? '–' : `${Math.round(v * 100)}%`;
      return td ? `${pctTxt}<span class="text-green-400 font-semibold">${td > 1 ? ` ${td}TD` : ' TD'}</span>` : pctTxt;
    });
    bits.push(`<span title="Offensive snap share in the last ${snaps.length} games played, newest first">L${snaps.length}: ${games.join(' · ')}</span>`);
  }
  if (pl.pos !== 'K') bits.push(`${s.last5_tds ?? 0} TD L5 · ${s.season_tds ?? 0} in ${s.season_games ?? 0} gms`);
  return bits.join(' &nbsp;|&nbsp; ');
}

function availButton(pl) {
  return pl.active
    ? `<button type="button" data-avail="${pl.id}" data-make="out" title="Mark as not playing — redistributes their work"
               class="ml-1 text-[10px] text-gray-600 hover:text-red-400 align-middle">✕ out</button>`
    : `<button type="button" data-avail="${pl.id}" data-make="in" title="Mark as playing"
               class="ml-1 text-[10px] text-blue-400 hover:text-blue-300 align-middle">+ in</button>`;
}

// Mean of the team's TD count distribution: the sim-bin mixture the prices use,
// else the stored whole-game distribution from game_player_data.
function expectedTds(gs, side) {
  const arr = gs.teamDists?.[side]?.td;
  if (arr?.length) return arr.reduce((s, p, n) => s + n * p, 0);
  const d = gs.playerData?.[side]?.td_dist;
  if (d) return Object.entries(d).reduce((s, [n, p]) => s + Number(n) * p, 0);
  return null;
}

function renderTeamCard(game, side) {
  const gs = S(game.game_id);
  const team = gs.playerData?.[side];
  const teamName = side === 'home' ? game.home_team : game.away_team;
  const card = document.createElement('div');
  card.className = 'bg-gray-800 border border-gray-700 rounded-xl p-4 w-full md:w-96 shadow-md';

  let body;
  if (!gs.playerData) {
    body = '<div class="py-6 text-center"><span class="bsm-skeleton h-3 w-32 inline-block"></span></div>';
  } else if (!team?.players?.length) {
    body = '<p class="py-4 text-sm text-gray-500 text-center">No player data for this team yet.</p>';
  } else {
    const anyKey = pl => `${side}:anytime:${pl.id}`;
    const skill = team.players.filter(pl => pl.pos !== 'K')
      .sort((a, b) => (POS_ORDER[a.pos] - POS_ORDER[b.pos]) || ((a.role_rank ?? a.depth) - (b.role_rank ?? b.depth)));
    // Condensed list: expected to play and a realistic scorer (or already picked)
    const shown = [], hidden = [];
    for (const pl of skill) {
      const p1 = singleLegProb(gs, side, 'anytime', pl, 1);
      const keep = gs.picks.has(anyKey(pl))
        || (pl.active && pl.expected && (p1 == null || p1 >= MIN_SHOWN_PROB || pl.is_starting_qb));
      (keep ? shown : hidden).push(pl);
    }
    const row = pl => marketRow(gs, side, 'anytime', {
      key: anyKey(pl), name: pl.name, player: pl, meta: playerMeta(pl),
      sub: `(${slotLabel(pl)})`, subTitle: slotTitle(pl), badge: statusBadge(pl) + (pl.overridden ? '<span class="ml-1 text-[10px] text-blue-300">manual</span>' : ''),
      availBtn: availButton(pl),
    });
    const hiddenRow = pl => pl.active ? row(pl) : `
      <div class="flex items-center gap-2 py-2 px-1 opacity-60">
        <div class="flex-1 min-w-0"><span class="text-sm line-through">${esc(pl.name)}</span>
          <span class="text-xs text-gray-500 ml-1" title="${esc(slotTitle(pl))}">(${slotLabel(pl)})</span>${statusBadge(pl)}${availButton(pl)}</div>
      </div>`;

    const qb = team.players.find(pl => pl.id === team.starting_qb_id);
    const k  = team.players.find(pl => pl.id === team.kicker_id);
    const extra = [
      qb ? marketRow(gs, side, 'pass_td', { key: `${side}:pass_td:${qb.id}`, name: qb.name, sub: '(Pass TDs)', player: qb,
                                meta: `${qb.stats?.season_pass_tds ?? 0} pass TDs in ${qb.stats?.season_games ?? 0} gms this season` }) : '',
      k  ? marketRow(gs, side, 'fg', { key: `${side}:fg:${k.id}`, name: k.name, sub: '(FGs made)', player: k,
                           meta: `${k.stats?.season_fg_made ?? 0} FGs made in ${k.stats?.season_games ?? 0} gms this season`, badge: statusBadge(k), availBtn: availButton(k) }) : '',
      marketRow(gs, side, 'dst_td', { key: `${side}:dst_td:${team.team_id}`, name: `${team.abbr} D/ST`, sub: '(Def/ST TD)' }),
    ].join('');

    const showAll = gs.showAll[side];
    body = `
      <div class="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 px-1">
        <span class="flex-1">Player</span>
        <span class="w-20 text-right">Anytime</span>
        <span class="w-20 text-center">TDs</span>
      </div>
      <div class="flex flex-col divide-y divide-gray-700/50">${shown.map(row).join('')}</div>
      ${hidden.length ? `
        <button type="button" data-showall="${side}"
                class="w-full mt-1 px-2 py-1.5 text-xs text-gray-500 hover:text-gray-300 text-left">
          ${showAll ? '▾ Hide' : '▸ Show'} ${hidden.length} more (inactive, unlikely to play or &lt;2% to score)
        </button>
        ${showAll ? `<div class="flex flex-col divide-y divide-gray-700/50">${hidden.map(hiddenRow).join('')}</div>` : ''}` : ''}
      <div class="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mt-4 mb-1 px-1">
        <span class="flex-1">Passing · Kicking · D/ST</span>
        <span class="w-20 text-right">Price</span>
        <span class="w-20 text-center">Count</span>
      </div>
      <div class="flex flex-col divide-y divide-gray-700/50">${extra}</div>
      <p class="mt-3 text-[11px] text-gray-600 leading-snug">
        Prices assume the player plays (bets on players who sit out are void). Pass TD share
        ${pct(team.pass_frac)} · D/ST share ${pct(team.dst_frac)} of team TDs.
      </p>`;
  }

  card.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2 min-w-0">
        <img src="${nflLogoUrl(teamName)}" class="w-8 h-8 object-contain shrink-0" alt="" onerror="this.style.display='none'">
        <div class="min-w-0">
          <div class="font-bold text-base truncate">${esc(teamName)}</div>
          <div class="text-xs text-gray-400">Expected touchdowns:
            <span class="font-semibold text-amber-400">${expectedTds(gs, side)?.toFixed(2) ?? '–'}</span></div>
        </div>
      </div>
      <button type="button" data-clear="${side}" class="text-xs text-gray-400 hover:text-white border border-gray-600 hover:border-gray-400 px-2 py-1 rounded transition-colors">Clear</button>
    </div>
    ${body}`;
  return card;
}

function renderTeams() {
  if (!currentGame) return;
  teamsContainer.innerHTML = '';
  teamsContainer.appendChild(renderTeamCard(currentGame, 'home'));
  teamsContainer.appendChild(renderTeamCard(currentGame, 'away'));
}

function findPlayer(gs, side, id) {
  return gs.playerData?.[side]?.players.find(p => String(p.id) === String(id)) || null;
}

teamsContainer.addEventListener('click', e => {
  if (!currentGame) return;
  const gs = S();
  const step = e.target.closest('[data-step]');
  if (step) {
    const key = step.dataset.key;
    const [side, kind, id] = key.split(':');
    const cur = gs.picks.get(key)?.n || 0;
    const n = Math.max(0, Math.min(MAX_N[kind], cur + Number(step.dataset.step)));
    if (n === 0) {
      gs.picks.delete(key);
    } else {
      const team = gs.playerData[side];
      const pl = kind === 'dst_td' ? null : findPlayer(gs, side, id);
      gs.picks.set(key, {
        side, kind, n,
        playerId: pl ? pl.id : null,
        teamId: team.team_id,
        name: kind === 'dst_td' ? team.abbr : pl.name,
      });
    }
    renderTeams();
    recalculate();
    return;
  }
  const clear = e.target.closest('[data-clear]');
  if (clear) {
    for (const [k, p] of gs.picks) if (p.side === clear.dataset.clear) gs.picks.delete(k);
    renderTeams();
    recalculate();
    return;
  }
  const showAll = e.target.closest('[data-showall]');
  if (showAll) {
    gs.showAll[showAll.dataset.showall] = !gs.showAll[showAll.dataset.showall];
    renderTeams();
    return;
  }
  const avail = e.target.closest('[data-avail]');
  if (avail) {
    const id = Number(avail.dataset.avail);
    const makeIn = avail.dataset.make === 'in';
    gs.out.delete(id); gs.in.delete(id);
    const pl = findPlayer(gs, 'home', id) || findPlayer(gs, 'away', id);
    const syncedActive = !EXCLUDED.includes(pl?.status);
    if (makeIn !== syncedActive) (makeIn ? gs.in : gs.out).add(id);
    loadPlayerData(currentGame.game_id);
  }
});

// =============================================================================
// LINE CONTROLS (state lives in gameState[game].lines)
// =============================================================================
function populateMarginDropdown() {
  marginValSel.innerHTML = '';
  for (let v = -50.5; v <= 50.5; v += 1) {
    const label = v === -0.5 ? 'To Win' : `${v >= 0 ? '+' : ''}${v}`;
    marginValSel.innerHTML += `<option value="${v}"${v === -0.5 ? ' selected' : ''}>${label}</option>`;
  }
}
function populateTotalDropdown(sel, max) {
  sel.innerHTML = '<option value="" disabled selected>—</option>';
  for (let n = 1; n <= max; n++) sel.innerHTML += `<option value="${n}">${n - 0.5}</option>`;
}
populateMarginDropdown();

function paintDir(btnA, btnB, activeA, activeB) {
  for (const [b, on] of [[btnA, activeA], [btnB, activeB]]) {
    b.classList.toggle('bg-blue-500', on);
    b.classList.toggle('text-white', on);
    b.classList.toggle('text-gray-400', !on);
  }
}

function syncMarginUI() {
  const L = S().lines;
  paintDir(marginDirHome, marginDirAway, L.marginTeam === 'home', L.marginTeam === 'away');
  marginValSel.disabled = !L.marginTeam;
  marginValSel.value = L.marginL != null ? String(L.marginL) : '-0.5';
}
function setMarginTeam(team) {
  const L = S().lines;
  L.marginTeam = team;
  if (team && L.marginL == null) L.marginL = -0.5;
  if (!team) L.marginL = null;
  syncMarginUI();
  recalculate();
}
marginDirHome.addEventListener('click', () => setMarginTeam(S().lines.marginTeam === 'home' ? null : 'home'));
marginDirAway.addEventListener('click', () => setMarginTeam(S().lines.marginTeam === 'away' ? null : 'away'));
marginValSel.addEventListener('change', () => { S().lines.marginL = parseFloat(marginValSel.value); recalculate(); });
marginClearBtn.addEventListener('click', () => setMarginTeam(null));

// The three over/under groups share one wiring
const totalGroups = [
  { prefix: 'total',      dir: 'totalDir',     n: 'totalN',     max: 100 },
  { prefix: 'home-total', dir: 'homeTotalDir', n: 'homeTotalN', max: 70 },
  { prefix: 'away-total', dir: 'awayTotalDir', n: 'awayTotalN', max: 70 },
].map(g => ({ ...g, over: $(`${g.prefix}-dir-over`), under: $(`${g.prefix}-dir-under`),
              sel: $(`${g.prefix}-val`), clear: $(`${g.prefix}-clear`) }));

function syncTotalUI(g) {
  const L = S().lines;
  paintDir(g.over, g.under, L[g.dir] === 'over', L[g.dir] === 'under');
  g.sel.disabled = !L[g.dir];
  g.sel.value = L[g.n] != null ? String(L[g.n]) : '';
}
for (const g of totalGroups) {
  populateTotalDropdown(g.sel, g.max);
  const setDir = d => { const L = S().lines; L[g.dir] = L[g.dir] === d ? null : d; syncTotalUI(g); recalculate(); };
  g.over.addEventListener('click', () => setDir('over'));
  g.under.addEventListener('click', () => setDir('under'));
  g.sel.addEventListener('change', () => { S().lines[g.n] = parseInt(g.sel.value, 10); recalculate(); });
  g.clear.addEventListener('click', () => { const L = S().lines; L[g.dir] = null; L[g.n] = null; syncTotalUI(g); recalculate(); });
}

function syncLineUI() {
  syncMarginUI();
  totalGroups.forEach(syncTotalUI);
}

resetMatchBtn.addEventListener('click', () => {
  if (!currentGame) return;
  const gs = S();
  const hadOverrides = gs.out.size || gs.in.size;
  const keep = gs.playerData, dists = gs.teamDists;
  gameState[currentGame.game_id] = newGameState();
  Object.assign(S(), { playerData: keep, teamDists: dists });
  syncLineUI();
  if (hadOverrides) loadPlayerData(currentGame.game_id);
  renderTeams();
  recalculate();
});
resetAllBtn.addEventListener('click', () => {
  for (const gid of Object.keys(gameState)) {
    const { playerData, teamDists, out, in: inn } = gameState[gid];
    gameState[gid] = newGameState();
    // keep loaded data unless overrides changed it
    if (!out.size && !inn.size) Object.assign(gameState[gid], { playerData, teamDists });
  }
  syncLineUI();
  if (currentGame) loadPlayerData(currentGame.game_id);
  recalculate();
});

// =============================================================================
// BETSLIP
// =============================================================================
function buildResults() {
  const results = [];
  for (const gid of Object.keys(gameState)) {
    if (!gameHasSelections(gid)) continue;
    const game = gameById(gid);
    if (!game) continue;
    const r = gameProbability(gid);
    if (!r) continue;
    const gs = S(gid);
    results.push({
      matchId: Number(gid),
      matchLabel: `${game.home_team} vs ${game.away_team}`,
      prob: r.prob,
      lineProb: r.lineProb,
      lineItems: lineLabels(game, gs.lines),
      picks: [...gs.picks.values()].map(p => {
        const pl = p.playerId != null ? findPlayer(gs, p.side, p.playerId) : null;
        return { ...p, label: legLabel(p.kind, p.name, p.n), indivProb: singleLegProb(gs, p.side, p.kind, pl, p.n) };
      }),
    });
  }
  return results;
}

function recalculate() {
  const results = buildResults();
  resetMatchBtn.disabled = !(currentGame && (gameHasSelections(currentGame.game_id)
    || S().out.size || S().in.size));
  resetAllBtn.disabled = !Object.keys(gameState).some(gameHasSelections);
  updateOptionBadges();
  renderBetslip(results);
}

function isGameStarted(gid) {
  const g = gameById(gid);
  return !!g?.date && g.has_kickoff_time && new Date(g.date).getTime() <= Date.now();
}

function renderBetslip(results) {
  if (!results.length) {
    resultDiv.innerHTML = '';
    resultDiv.classList.remove('betslip-open');
    betslipExpanded = false;
    return;
  }
  const combinedProb = results.reduce((acc, r) => acc * r.prob, 1);
  const combinedOdds = combinedProb > 0 ? (1 / combinedProb).toFixed(2) : '∞';
  const totalLegs = results.reduce((acc, r) => acc + r.picks.length + r.lineItems.length, 0);
  const isMulti = results.length > 1 || totalLegs > 1;

  const dotRow = (dot, text, italic, right) => `
    <div class="flex items-center justify-between gap-2 py-0.5">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="w-1.5 h-1.5 rounded-full ${dot} shrink-0 mt-0.5"></span>
        <span class="text-sm ${italic ? 'text-gray-300 italic' : 'text-white'} truncate">${esc(text)}</span>
      </div>
      ${right ? `<div class="text-right shrink-0"><div class="text-sm font-semibold text-gray-300">${pct(right)}</div>
                 <div class="text-xs text-gray-500">${odds(right)}</div></div>` : ''}
    </div>`;

  const legsHtml = results.map(r => {
    const lines = r.lineItems.map((l, i) => dotRow('bg-blue-400', l, true, i === r.lineItems.length - 1 ? r.lineProb : null)).join('');
    const picks = r.picks.map(p => dotRow('bg-green-400', p.label, false, p.indivProb)).join('');
    const gameOdds = results.length > 1 && (r.picks.length + r.lineItems.length) > 1
      ? `<div class="flex justify-between text-xs text-gray-500 mt-1"><span>Same game</span><span class="text-amber-400 font-semibold">${odds(r.prob)} · ${pct(r.prob)}</span></div>` : '';
    return `
      <div class="py-2.5 border-b border-gray-700/40 last:border-b-0">
        <div class="text-xs font-semibold text-gray-400 truncate mb-1.5">${esc(r.matchLabel)}</div>
        ${lines}${picks}${gameOdds}
      </div>`;
  }).join('');

  const anyStarted = results.some(r => isGameStarted(r.matchId));
  resultDiv.innerHTML = `
    <div id="betslip-toggle" class="flex items-center justify-between cursor-pointer select-none">
      <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Betslip</span>
      <div class="flex items-center gap-2">
        <span class="text-base font-bold text-amber-400">${totalLegs} leg${totalLegs !== 1 ? 's' : ''} · $${combinedOdds}</span>
        <span id="betslip-chevron" class="text-gray-400 text-xs">${betslipExpanded ? '▼' : '▲'}</span>
      </div>
    </div>
    <div id="betslip-body" class="${betslipExpanded ? '' : 'hidden'} mt-1">
      ${legsHtml}
      <div class="mt-3 pt-3 border-t border-gray-600">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-gray-300">${isMulti ? `Multi (${totalLegs} legs)` : 'Selection'}</span>
          <div class="text-right">
            <div class="text-2xl font-extrabold text-amber-400">${(combinedProb * 100).toFixed(2)}%</div>
            <div class="text-xs text-gray-500">$${combinedOdds}</div>
          </div>
        </div>
      </div>
      <div class="mt-3 pt-3 border-t border-gray-700/40">
        <div class="flex items-center gap-2">
          <label for="bookie-odds-input" class="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0">Bookie Odds</label>
          <div class="flex items-center gap-1 flex-1">
            <span class="text-sm text-gray-400">$</span>
            <input id="bookie-odds-input" type="number" min="1.01" step="0.05" placeholder="e.g. 4.50"
                   value="${bookieOdds != null ? bookieOdds : ''}"
                   class="flex-1 min-w-0 bg-gray-800 border border-gray-600 text-white text-sm rounded px-2 py-1 focus:outline-none focus:border-amber-500/60">
          </div>
        </div>
        <p id="bookie-ev" class="text-xs mt-1 ${bookieOdds ? '' : 'text-gray-600'}">${evText(combinedProb)}</p>
      </div>
      <div class="text-xs mt-3 text-gray-400 text-center leading-tight">
        Find this useful? <a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" class="text-yellow-300 hover:underline">Buy me a coffee</a> to help pay server costs.
      </div>
    </div>
    <div class="mt-2 flex justify-center">
      <button id="save-betslip-btn" type="button" ${anyStarted ? 'disabled title="Game has started — bets are locked"' : ''}
              class="px-4 py-1.5 rounded-lg border font-semibold text-sm transition-colors ${anyStarted
                ? 'border-gray-600 text-gray-500 opacity-50 cursor-not-allowed'
                : 'border-blue-500/40 text-blue-400 hover:bg-blue-500/10'}">
        ${anyStarted ? 'Locked' : '☆ Save Betslip'}
      </button>
    </div>`;
  resultDiv.classList.toggle('betslip-open', betslipExpanded);

  resultDiv.querySelector('#betslip-toggle').addEventListener('click', () => {
    betslipExpanded = !betslipExpanded;
    resultDiv.classList.toggle('betslip-open', betslipExpanded);
    resultDiv.querySelector('#betslip-body').classList.toggle('hidden', !betslipExpanded);
    resultDiv.querySelector('#betslip-chevron').textContent = betslipExpanded ? '▼' : '▲';
  });
  const input = resultDiv.querySelector('#bookie-odds-input');
  input.addEventListener('input', () => {
    bookieOdds = input.value ? parseFloat(input.value) : null;
    const ev = resultDiv.querySelector('#bookie-ev');
    ev.innerHTML = evText(combinedProb);
    ev.className = `text-xs mt-1 ${bookieOdds ? '' : 'text-gray-600'}`;
  });
  resultDiv.querySelector('#save-betslip-btn').addEventListener('click', e => saveBetslip(e.currentTarget, results));
}

function evText(prob) {
  if (!bookieOdds || !prob) return 'Optional · compare with the model';
  const ev = (bookieOdds * prob - 1) * 100;
  return `<span class="${ev >= 0 ? 'text-green-400' : 'text-red-400'} font-semibold">${ev >= 0 ? '+' : ''}${ev.toFixed(1)}% EV</span>`;
}

function showToast(msg, linkHref, linkText) {
  let c = $('_bs-toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = '_bs-toast-container';
    c.style.cssText = 'position:fixed;bottom:5rem;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
    document.body.appendChild(c);
  }
  const t = document.createElement('div');
  t.style.cssText = 'background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:10px 16px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,0.5);pointer-events:auto;white-space:nowrap;opacity:1;transition:opacity 0.35s';
  t.innerHTML = linkHref ? `${msg} <a href="${linkHref}" style="color:#60a5fa;text-decoration:underline">${linkText || 'here'}</a>` : msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 360); }, 3000);
}

function seasonOf(game) {
  const d = new Date(game?.date || Date.now());
  return d.getMonth() < 2 ? d.getFullYear() - 1 : d.getFullYear();   // Jan/Feb games belong to last season
}

async function saveBetslip(btn, results) {
  const session = await getSession();
  if (!session) {
    showToast('Sign in to save betslips', '/pages/login.html?next=' + encodeURIComponent(window.location.pathname), 'Sign in');
    return;
  }
  if (!results.length) return;
  if (results.some(r => isGameStarted(r.matchId))) {
    showToast('Game has already started — bets are locked');
    return;
  }
  const first = gameById(results[0].matchId);

  // Picks carry everything the NFL scorer needs (kind, n, player/team) plus a
  // display label, since "name ×n" doesn't describe a pass-TD or FG leg.
  const picks = results.flatMap(r => r.picks.map(p => ({
    match_id:  r.matchId,
    id:        p.kind === 'dst_td' ? `dst-${p.teamId}` : p.playerId,
    player_id: p.playerId,
    team_id:   p.teamId,
    side:      p.side,
    kind:      p.kind,
    n:         p.n,
    name:      p.name,
    label:     p.label,
  })));
  const LEG_TYPE = { margin: 'margin1', total: 'total1', homeTotal: 'home_total', awayTotal: 'away_total' };
  const line_legs = results.flatMap(r => {
    const game = gameById(r.matchId);
    const L = S(r.matchId).lines;
    const c = buildConstraints(L);
    const labels = lineLabels(game, L);
    let i = 0;
    return Object.entries(LEG_TYPE).filter(([k]) => c[k]).map(([k, legType]) => ({
      match_id: r.matchId, leg_type: legType, ...c[k], label: labels[i++],
    }));
  });

  const combinedProb = results.reduce((acc, r) => acc * r.prob, 1);
  const payload = {
    match_ids:       results.map(r => r.matchId),
    round_number:    first?.week_number ?? currentWeek,
    season:          seasonOf(first),
    competition:     'nfl',
    match_label:     results.length === 1 ? results[0].matchLabel : `Multi (${results.length} games)`,
    picks,
    line_legs,
    calculated_prob: combinedProb > 0 ? parseFloat(combinedProb.toFixed(5)) : null,
    combined_odds:   combinedProb > 0 ? parseFloat((1 / combinedProb).toFixed(2)) : null,
    bookie_odds:     bookieOdds || null,
    is_public:       true,
  };

  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    const res = await fetch(`${BACKEND}/betslips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      btn.textContent = '★ Saved';
      btn.style.borderColor = '#22c55e';
      btn.style.color = '#4ade80';
      showToast('Betslip saved! View it on the', '/nfl/pages/betslips.html', 'community page');
      setTimeout(() => renderCommunityBetslips(currentGame?.game_id), 500);
    } else {
      const err = await res.json().catch(() => ({}));
      btn.textContent = '☆ Save Betslip';
      btn.disabled = false;
      showToast(err.error || 'Failed to save betslip');
    }
  } catch {
    btn.textContent = '☆ Save Betslip';
    btn.disabled = false;
    showToast('Failed to save betslip');
  }
}

// =============================================================================
// COMMUNITY BETSLIPS STRIP
// =============================================================================
let communityGameId = null;

function communityTile(b) {
  const items = [
    ...(b.picks || []).map(p => ({ dot: 'bg-green-400', text: p.label || (p.name + (p.n > 1 ? ` ×${p.n}` : '')) })),
    ...(b.line_legs || []).map(l => ({ dot: 'bg-blue-400', text: l.label || '' })),
  ];
  const visible = items.slice(0, 3);
  const extra = items.length - visible.length;
  const score = b.is_scored
    ? (b.won === true ? '<span class="text-green-400 text-xs font-bold" title="Won">✓</span>'
      : b.won === false ? '<span class="text-red-400 text-xs font-bold" title="Lost">✗</span>'
      : '<span class="text-gray-400 text-xs font-bold" title="Void">–</span>')
    : '<span class="text-gray-600 text-xs" title="Pending">·</span>';
  const net = b.net_votes || 0;
  const voteColor = net > 0 ? '#4ade80' : net < 0 ? '#f87171' : '#6b7280';
  return `
    <div class="shrink-0 bg-gray-800 border border-gray-700 rounded-xl p-3 flex flex-col gap-1.5" style="width:172px;scroll-snap-align:start;">
      <div class="flex items-center justify-between gap-1">
        <span class="text-xs font-semibold text-gray-200 truncate min-w-0">${esc(b.username || 'Unknown')}</span>
        <div class="flex items-center gap-1.5 shrink-0">
          ${score}
          <button data-vote-betslip="${b.id}" data-v="1" class="text-gray-600 hover:text-green-400 font-bold leading-none" style="font-size:10px;">▲</button>
          <span style="font-size:10px;font-weight:700;color:${voteColor};min-width:1rem;text-align:center;" data-community-votes="${b.id}">${net}</span>
          <button data-vote-betslip="${b.id}" data-v="-1" class="text-gray-600 hover:text-red-400 font-bold leading-none" style="font-size:10px;">▼</button>
        </div>
      </div>
      <div class="flex flex-col gap-0.5 text-xs text-gray-400 min-w-0">
        ${visible.map(it => `<span class="flex items-center gap-1 min-w-0"><span class="w-1.5 h-1.5 rounded-full ${it.dot} shrink-0"></span><span class="truncate">${esc(it.text)}</span></span>`).join('')}
        ${extra > 0 ? `<span class="text-gray-600">+${extra}</span>` : ''}
      </div>
      <div class="flex items-baseline justify-between mt-auto pt-1 border-t border-gray-700/50">
        <span class="text-sm font-extrabold text-amber-400">${b.combined_odds ? `$${b.combined_odds}` : '–'}</span>
        ${b.calculated_prob ? `<span class="text-xs text-gray-500">${(b.calculated_prob * 100).toFixed(1)}%</span>` : ''}
      </div>
    </div>`;
}

async function renderCommunityBetslips(gameId) {
  const section = $('community-betslips-section');
  const list = $('community-betslips-list');
  const link = $('community-betslips-link');
  if (!gameId) { section.classList.add('hidden'); return; }
  communityGameId = gameId;
  const sort = $('community-sort').value || 'recent';
  link.href = `/nfl/pages/betslips.html?match=${gameId}`;
  section.classList.remove('hidden');
  list.innerHTML = '<div class="text-xs text-gray-500 py-2 px-1">Loading…</div>';
  try {
    const res = await fetch(`${BACKEND}/betslips/match/${gameId}?competition=nfl&sort=${sort}&limit=5`);
    const betslips = res.ok ? await res.json() : [];
    if (communityGameId !== gameId) return;
    list.innerHTML = betslips.length
      ? betslips.map(communityTile).join('')
      : '<div class="text-xs text-gray-500 py-2 px-1 italic">No betslips saved yet — be the first!</div>';
  } catch {
    list.innerHTML = '<div class="text-xs text-gray-500 py-2 px-1">Could not load betslips.</div>';
  }
}

$('community-betslips-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-vote-betslip]');
  if (!btn) return;
  const session = await getSession();
  if (!session) {
    showToast('Sign in to vote on betslips', '/pages/login.html?next=' + encodeURIComponent(window.location.pathname), 'Sign in');
    return;
  }
  const id = btn.dataset.voteBetslip;
  try {
    const res = await fetch(`${BACKEND}/betslips/${id}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ vote: parseInt(btn.dataset.v, 10) }),
    });
    if (!res.ok) { showToast((await res.json().catch(() => ({}))).error || 'Could not vote'); return; }
    const net = (await res.json()).net_votes ?? 0;
    const el = document.querySelector(`[data-community-votes="${id}"]`);
    if (el) { el.textContent = net; el.style.color = net > 0 ? '#4ade80' : net < 0 ? '#f87171' : '#6b7280'; }
  } catch { showToast('Could not vote'); }
});
$('community-sort').addEventListener('change', () => renderCommunityBetslips(currentGame?.game_id));

// =============================================================================
// LOADING
// =============================================================================
function formatKickoff(game) {
  if (!game?.date) return '';
  const d = new Date(game.date);
  if (isNaN(d.getTime())) return '';
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (game.has_kickoff_time) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString(undefined, opts);
}

async function loadBinsForGame(gid) {
  if (binsCache[gid]) return binsCache[gid];
  try {
    const res = await fetch(apiUrl('nfl', `game_sgm_bins_range/${gid}?with_dists=1`));
    binsCache[gid] = res.ok ? ((await res.json()).bins || []) : [];
  } catch {
    binsCache[gid] = [];
  }
  return binsCache[gid];
}

async function loadPlayerData(gid) {
  const gs = S(gid);
  const seq = ++gs.loadSeq;
  const qs = new URLSearchParams();
  if (gs.out.size) qs.set('out', [...gs.out].join(','));
  if (gs.in.size)  qs.set('in',  [...gs.in].join(','));
  let data = null;
  try {
    const res = await fetch(apiUrl('nfl', `game_player_data/${gid}${qs.toString() ? '?' + qs : ''}`));
    data = res.ok ? await res.json() : null;
  } catch { /* leave null */ }
  if (seq !== gs.loadSeq) return;
  gs.playerData = data;
  // Drop legs that no longer apply: a player now ruled out, or a pass-TD / FG leg
  // whose player is no longer the projected starting QB / kicker.
  for (const [k, p] of gs.picks) {
    if (p.playerId == null) continue;
    const pl = findPlayer(gs, p.side, p.playerId);
    if (!pl || !pl.active || (p.kind === 'pass_td' && !pl.is_starting_qb) || (p.kind === 'fg' && !pl.is_kicker)) gs.picks.delete(k);
  }
  if (String(currentGame?.game_id) === String(gid)) renderTeams();
  recalculate();
}

function updateOptionBadges() {
  Array.from(gameSelect.options).forEach(opt => {
    const gs = gameState[opt.value];
    const n = gs ? gs.picks.size + lineLabels(gameById(opt.value) || {}, gs.lines).length : 0;
    const base = opt.dataset.label || opt.textContent;
    opt.dataset.label = base;
    opt.textContent = n > 0 ? `${base} (${n} leg${n !== 1 ? 's' : ''})` : base;
  });
}

async function selectGame(gid) {
  currentGame = gameById(gid);
  if (!currentGame) { builderSection.classList.add('hidden'); return; }
  const gs = S();
  builderMatchup.textContent = `${currentGame.home_team} vs ${currentGame.away_team}`;
  const wx = currentGame?.is_finished ? null : nflWeatherLabel(currentGame?.weather);
  builderKickoff.textContent = formatKickoff(currentGame) + (wx ? ` · ${wx.text}` : '');
  builderKickoff.title = wx ? wx.title : '';
  $('home-pts-label').textContent = `${currentGame.home_team} Pts`;
  $('away-pts-label').textContent = `${currentGame.away_team} Pts`;
  marginDirHome.textContent = currentGame.home_abbr || 'H';
  marginDirAway.textContent = currentGame.away_abbr || 'A';
  builderSection.classList.remove('hidden');
  syncLineUI();
  renderTeams();
  renderCommunityBetslips(currentGame.game_id);

  const loadingId = currentGame.game_id;
  const [bins] = await Promise.all([loadBinsForGame(loadingId), gs.playerData ? null : loadPlayerData(loadingId)]);
  if (bins.length && !gs.teamDists) {
    gs.teamDists = {
      home: { td: mixtureDist(bins, 'h_td'), fg: mixtureDist(bins, 'h_fg') },
      away: { td: mixtureDist(bins, 'a_td'), fg: mixtureDist(bins, 'a_fg') },
    };
  }
  if (currentGame?.game_id !== loadingId) return;
  renderTeams();
  recalculate();
}

gameSelect.addEventListener('change', () => selectGame(gameSelect.value));

async function loadWeek(week) {
  gameSelect.innerHTML = '';
  noGamesMsg.classList.add('hidden');
  builderSection.classList.add('hidden');
  weekBadge.textContent = `Week ${week}`;

  const res = await fetch(apiUrl('nfl', `week_predictions/${week}`));
  if (!res.ok) return;
  const json = await res.json();
  currentWeek = json.week_number ?? week;
  weekBadge.textContent = `Week ${currentWeek}`;

  // Selections from other weeks can't share a betslip (one round per betslip)
  for (const gid of Object.keys(gameState)) {
    if (!json.predictions?.some(g => String(g.game_id) === gid)) delete gameState[gid];
  }
  games = (json.predictions || []).filter(g => g.has_prediction);
  if (!games.length) {
    noGamesMsg.classList.remove('hidden');
    renderCommunityBetslips(null);
    recalculate();
    return;
  }
  gameSelect.innerHTML = games.map(g => `<option value="${g.game_id}">${esc(g.home_team)} vs ${esc(g.away_team)}</option>`).join('');
  // Default to the next game that hasn't kicked off
  const upcoming = games.find(g => !g.is_finished && !isGameStarted(g.game_id)) || games[0];
  gameSelect.value = upcoming.game_id;
  await selectGame(upcoming.game_id);
}

weekPrevBtn.addEventListener('click', () => { if (currentWeek > 1) loadWeek(currentWeek - 1); });
weekNextBtn.addEventListener('click', () => { if (currentWeek != null) loadWeek(currentWeek + 1); });

async function init() {
  const params = new URLSearchParams(window.location.search);
  const weekParam = params.get('week');
  const gameIdParam = params.get('game_id');
  if (weekParam) {
    await loadWeek(Number(weekParam));
    if (gameIdParam && gameById(gameIdParam)) {
      gameSelect.value = gameIdParam;
      selectGame(gameIdParam);
    }
    return;
  }
  const res = await fetch(apiUrl('nfl', 'current_week'));
  if (res.ok) loadWeek((await res.json()).week_number);
}

init();
