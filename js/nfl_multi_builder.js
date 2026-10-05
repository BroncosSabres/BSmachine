// nfl_multi_builder.js — drives nfl/pages/tryscorer_predictions.html ("Multi Builder")
// NFL counterpart to js/tryscorer_predictions.js (no crowd-blend slider — no crowd
// picks exist for NFL). Lines (margin / total / team points) filter real
// nfl.game_sgm_bins joint score distributions via /api/nfl/game_sgm_bins_range.
// Player legs — anytime rushing/receiving TD, QB passing TDs, team D/ST TD and
// kicker FGs, all any-N+ — come from /api/nfl/game_player_data (per-player shares
// of team TDs, see nrl-flask-backend/nfl_player_model.py) and are combined with
// each bin's own TD/FG count distributions so they stay correlated with the lines.
import { apiUrl } from './api-config.js';

const weekBadge       = document.getElementById('week-badge');
const weekPrevBtn      = document.getElementById('week-prev');
const weekNextBtn      = document.getElementById('week-next');
const gameSelect       = document.getElementById('game-select');
const noGamesMsg       = document.getElementById('no-games-msg');
const builderSection   = document.getElementById('builder-section');
const builderMatchup   = document.getElementById('builder-matchup');
const builderKickoff   = document.getElementById('builder-kickoff');
const resetBuilderBtn  = document.getElementById('reset-builder-btn');

const marginDirHome  = document.getElementById('margin-dir-home');
const marginDirAway  = document.getElementById('margin-dir-away');
const marginValSel   = document.getElementById('margin-val');
const marginClearBtn = document.getElementById('margin-clear');

const totalDirOver  = document.getElementById('total-dir-over');
const totalDirUnder = document.getElementById('total-dir-under');
const totalValSel    = document.getElementById('total-val');
const totalClearBtn  = document.getElementById('total-clear');

const homePtsLabel     = document.getElementById('home-pts-label');
const homeTotalDirOver  = document.getElementById('home-total-dir-over');
const homeTotalDirUnder = document.getElementById('home-total-dir-under');
const homeTotalValSel   = document.getElementById('home-total-val');
const homeTotalClearBtn = document.getElementById('home-total-clear');

const awayPtsLabel     = document.getElementById('away-pts-label');
const awayTotalDirOver  = document.getElementById('away-total-dir-over');
const awayTotalDirUnder = document.getElementById('away-total-dir-under');
const awayTotalValSel   = document.getElementById('away-total-val');
const awayTotalClearBtn = document.getElementById('away-total-clear');

const resultCard  = document.getElementById('result-card');
const resultLegs  = document.getElementById('result-legs');
const resultProb  = document.getElementById('result-prob');
const resultOdds  = document.getElementById('result-odds');

const playersSection = document.getElementById('players-section');
const playersMeta    = document.getElementById('players-meta');
const playersTable   = document.getElementById('players-table');
const playersEmpty   = document.getElementById('players-empty');
const teamTabHome    = document.getElementById('team-tab-home');
const teamTabAway    = document.getElementById('team-tab-away');

let currentWeek   = null;
let games         = [];
let currentGame   = null;
let binsCache     = {}; // { game_id: bins[] } (bins carry per-bin h_td/a_td/h_fg/a_fg)

// --- PLAYER STATE ---
let playerData   = null;            // /api/nfl/game_player_data response for currentGame
let playerTab    = 'home';
let forcedOut    = new Set();       // manual availability overrides (player ids)
let forcedIn     = new Set();
let picks        = new Map();       // key -> { side, kind, playerId, min, label }
let cellN        = new Map();       // key -> N currently shown in a market cell (default 1)
let teamDists    = null;            // { home: {td:[], fg:[]}, away: {...} } — mixture over all bins
let playerLoadSeq = 0;

// --- STATE ---
let marginTeam = null;   // 'home' | 'away' | null
let marginL    = null;   // dropdown value, e.g. -0.5, -6.5, +3.5
let totalDir   = null;   // 'over' | 'under' | null
let totalN     = null;
let homeTotalDir = null;
let homeTotalN   = null;
let awayTotalDir = null;
let awayTotalN   = null;

function lineToN(L) { return Math.floor(-L) + 1; }

function populateMarginDropdown() {
  marginValSel.innerHTML = '';
  for (let v = -50.5; v <= 50.5; v += 1) {
    const sign  = v >= 0 ? '+' : '';
    const label = v === -0.5 ? 'To Win' : `${sign}${v}`;
    marginValSel.innerHTML += `<option value="${v}"${v === -0.5 ? ' selected' : ''}>${label}</option>`;
  }
}

function populateTotalDropdown(sel, max) {
  sel.innerHTML = '<option value="" disabled selected>—</option>';
  for (let n = 1; n <= max; n++) {
    sel.innerHTML += `<option value="${n}">${n - 0.5}</option>`;
  }
}

populateMarginDropdown();
populateTotalDropdown(totalValSel, 100);
populateTotalDropdown(homeTotalValSel, 70);
populateTotalDropdown(awayTotalValSel, 70);

// --- CONSTRAINT BUILDING (mirrors js/tryscorer_predictions.js buildConstraints) ---
function buildConstraints() {
  let margin = null, total = null, homeTotal = null, awayTotal = null;

  if (marginTeam && marginL != null) {
    const N1 = lineToN(marginL); // margin (home - away) >= N1 for home, <= -N1 for away
    margin = marginTeam === 'home'
      ? { type: 'over',  val: N1 }
      : { type: 'under', val: 1 - N1 };
  }
  if (totalDir && totalN != null) {
    total = { type: totalDir, val: totalN };
  }
  if (homeTotalDir && homeTotalN != null) homeTotal = { type: homeTotalDir, val: homeTotalN };
  if (awayTotalDir && awayTotalN != null) awayTotal = { type: awayTotalDir, val: awayTotalN };

  return { margin, total, homeTotal, awayTotal };
}

function filterBins(bins, c) {
  let filtered = bins.filter(b => {
    if (c.margin?.type === 'over'  && b.m < c.margin.val)  return false;
    if (c.margin?.type === 'under' && b.m >= c.margin.val) return false;
    if (c.total?.type  === 'over'  && b.t < c.total.val)   return false;
    if (c.total?.type  === 'under' && b.t >= c.total.val)  return false;
    return true;
  });
  if (c.homeTotal || c.awayTotal) {
    filtered = filtered.filter(b => {
      const hs  = (b.m + b.t) / 2;
      const as_ = (b.t - b.m) / 2;
      if (c.homeTotal?.type === 'over'  && hs  <  c.homeTotal.val) return false;
      if (c.homeTotal?.type === 'under' && hs  >= c.homeTotal.val) return false;
      if (c.awayTotal?.type === 'over'  && as_ <  c.awayTotal.val) return false;
      if (c.awayTotal?.type === 'under' && as_ >= c.awayTotal.val) return false;
      return true;
    });
  }
  return filtered;
}

function hasAnyConstraint(c) {
  return !!(c.margin || c.total || c.homeTotal || c.awayTotal || picks.size);
}

// --- PLAYER PROBABILITY ENGINE (mirrors nfl_player_model.build_atoms / pick_success_by_n) ---
// Every team TD is exactly one of: a D/ST TD, a rush TD by player i, or a pass TD
// from the starting QB to receiver r. A pass TD credits the receiver's anytime pick
// AND the QB's pass-TD pick — never the QB's anytime pick.
function buildAtoms(team, teamPicks) {
  const dst = team.dst_frac, pf = team.pass_frac, qbId = team.starting_qb_id;
  const atoms = new Map(); // credit-key -> { p, cred: [pick idx] }
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
    add(pl.id, null, false, (1 - dst) * (1 - pf) * pl.rush_share);
    add(pl.id, qbId, false, (1 - dst) * pf * pl.rec_share);
  }
  if (used < 1) add(null, null, false, 1 - used);
  return [...atoms.values()];
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
  let below = 0, c = 1; // c = C(n, j)
  for (let j = 0; j < k; j++) {
    below += c * Math.pow(p, j) * Math.pow(1 - p, n - j);
    c = c * (n - j) / (j + 1);
  }
  return Math.max(0, 1 - below);
}

// Unconditional single-leg probability (whole game, no lines) for the table prices.
function singleLegProb(side, kind, atomP, k) {
  if (!teamDists) return null;
  const d = teamDists[side];
  if (kind === 'fg') return atLeast(d.fg, k);
  let s = 0;
  d.td.forEach((pn, n) => { s += pn * binomAtLeast(n, atomP, k); });
  return s;
}

function mixtureDist(bins, key) {
  const total = bins.reduce((s, b) => s + (b.c || 0), 0) || 1;
  const out = [];
  for (const b of bins) {
    const arr = b[key] || [1];
    arr.forEach((p, n) => { out[n] = (out[n] || 0) + p * b.c / total; });
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i] || 0;
  return out;
}

// Joint probability of the line filters + every player leg, bin by bin.
function jointProbability(bins, filtered) {
  const totalCount = bins.reduce((s, b) => s + (b.c || 0), 0) || 1;
  const perSide = {};
  for (const side of ['home', 'away']) {
    const team = playerData?.[side];
    const sidePicks = [...picks.values()].filter(p => p.side === side);
    const tdPicks = sidePicks.filter(p => p.kind !== 'fg');
    const fgMin = Math.max(0, ...sidePicks.filter(p => p.kind === 'fg').map(p => p.min));
    let S = null;
    if (tdPicks.length && team) {
      const maxN = Math.max(...filtered.map(b => (b[side === 'home' ? 'h_td' : 'a_td'] || [1]).length - 1), 0);
      S = pickSuccessByN(buildAtoms(team, tdPicks), tdPicks.map(p => p.min), maxN);
    }
    perSide[side] = { S, fgMin };
  }
  let num = 0;
  for (const b of filtered) {
    let f = b.c || 0;
    for (const side of ['home', 'away']) {
      const { S, fgMin } = perSide[side];
      const td = b[side === 'home' ? 'h_td' : 'a_td'] || [1];
      const fg = b[side === 'home' ? 'h_fg' : 'a_fg'] || [1];
      if (S) {
        let s = 0;
        td.forEach((pn, n) => { s += pn * (S[n] || 0); });
        f *= s;
      }
      // Within a bin TD and FG counts are stored as marginals only; treat them as
      // independent there (the bin already pins the team's points).
      if (fgMin > 0) f *= atLeast(fg, fgMin);
    }
    num += f;
  }
  return num / totalCount;
}

function marginLabel() {
  if (!marginTeam || marginL == null) return null;
  const teamName = marginTeam === 'home' ? currentGame?.home_team : currentGame?.away_team;
  if (marginL === -0.5) return `${teamName} To Win`;
  const sign = marginL < 0 ? '' : '+';
  return `${teamName} ${sign}${marginL}`;
}
function totalLabel() {
  if (!totalDir || totalN == null) return null;
  return `Total ${totalDir === 'over' ? 'Over' : 'Under'} ${totalN - 0.5}`;
}
function homeTotalLabel() {
  if (!homeTotalDir || homeTotalN == null) return null;
  return `${currentGame?.home_team} ${homeTotalDir === 'over' ? 'Over' : 'Under'} ${homeTotalN - 0.5}`;
}
function awayTotalLabel() {
  if (!awayTotalDir || awayTotalN == null) return null;
  return `${currentGame?.away_team} ${awayTotalDir === 'over' ? 'Over' : 'Under'} ${awayTotalN - 0.5}`;
}

function recalculate() {
  if (!currentGame) return;
  const bins = binsCache[currentGame.game_id];
  const c = buildConstraints();

  if (!bins || !hasAnyConstraint(c)) {
    resultCard.classList.add('hidden');
    return;
  }

  const filtered   = filterBins(bins, c);
  const prob       = jointProbability(bins, filtered);

  const legs = [marginLabel(), totalLabel(), homeTotalLabel(), awayTotalLabel(),
                ...[...picks.values()].map(p => p.label)].filter(Boolean);
  resultLegs.textContent = legs.join(' + ');
  resultProb.textContent = `${(prob * 100).toFixed(1)}%`;
  resultOdds.textContent = prob >= 1e-6 ? `$${(1 / prob).toFixed(2)}` : '—';
  resultCard.classList.remove('hidden');
}

function updateResetState() {
  const active = !!(marginTeam || totalDir || homeTotalDir || awayTotalDir || picks.size
                    || forcedOut.size || forcedIn.size);
  resetBuilderBtn.disabled = !active;
}

// --- MARGIN CONTROLS ---
function setMarginTeam(team) {
  marginTeam = team;
  marginValSel.disabled = false;
  marginDirHome.classList.toggle('bg-blue-500', team === 'home');
  marginDirHome.classList.toggle('text-white', team === 'home');
  marginDirHome.classList.toggle('text-gray-400', team !== 'home');
  marginDirAway.classList.toggle('bg-blue-500', team === 'away');
  marginDirAway.classList.toggle('text-white', team === 'away');
  marginDirAway.classList.toggle('text-gray-400', team !== 'away');
  if (marginL == null) marginL = -0.5;
  marginValSel.value = String(marginL);
  updateResetState();
  recalculate();
}
marginDirHome.addEventListener('click', () => setMarginTeam(marginTeam === 'home' ? null : 'home'));
marginDirAway.addEventListener('click', () => setMarginTeam(marginTeam === 'away' ? null : 'away'));
marginValSel.addEventListener('change', () => { marginL = parseFloat(marginValSel.value); recalculate(); });
marginClearBtn.addEventListener('click', () => {
  marginTeam = null; marginL = null;
  marginValSel.disabled = true;
  [marginDirHome, marginDirAway].forEach(b => { b.classList.remove('bg-blue-500', 'text-white'); b.classList.add('text-gray-400'); });
  updateResetState();
  recalculate();
});

// --- TOTAL POINTS CONTROLS (factory for the 3 identical over/under groups) ---
function wireTotalGroup(dirOverBtn, dirUnderBtn, valSel, clearBtn, setDir, setVal, getDir) {
  function paint() {
    const dir = getDir();
    dirOverBtn.classList.toggle('bg-blue-500', dir === 'over');
    dirOverBtn.classList.toggle('text-white', dir === 'over');
    dirOverBtn.classList.toggle('text-gray-400', dir !== 'over');
    dirUnderBtn.classList.toggle('bg-blue-500', dir === 'under');
    dirUnderBtn.classList.toggle('text-white', dir === 'under');
    dirUnderBtn.classList.toggle('text-gray-400', dir !== 'under');
    valSel.disabled = !dir;
  }
  dirOverBtn.addEventListener('click', () => { setDir(getDir() === 'over' ? null : 'over'); paint(); recalculate(); updateResetState(); });
  dirUnderBtn.addEventListener('click', () => { setDir(getDir() === 'under' ? null : 'under'); paint(); recalculate(); updateResetState(); });
  valSel.addEventListener('change', () => { setVal(parseInt(valSel.value, 10)); recalculate(); });
  clearBtn.addEventListener('click', () => {
    setDir(null); setVal(null); valSel.value = '';
    paint(); recalculate(); updateResetState();
  });
  return paint;
}

wireTotalGroup(totalDirOver, totalDirUnder, totalValSel, totalClearBtn,
  d => { totalDir = d; }, n => { totalN = n; }, () => totalDir);
wireTotalGroup(homeTotalDirOver, homeTotalDirUnder, homeTotalValSel, homeTotalClearBtn,
  d => { homeTotalDir = d; }, n => { homeTotalN = n; }, () => homeTotalDir);
wireTotalGroup(awayTotalDirOver, awayTotalDirUnder, awayTotalValSel, awayTotalClearBtn,
  d => { awayTotalDir = d; }, n => { awayTotalN = n; }, () => awayTotalDir);

function resetBuilder() {
  marginTeam = null; marginL = null;
  totalDir = null; totalN = null;
  homeTotalDir = null; homeTotalN = null;
  awayTotalDir = null; awayTotalN = null;

  marginValSel.value = ''; marginValSel.disabled = true;
  totalValSel.value = ''; totalValSel.disabled = true;
  homeTotalValSel.value = ''; homeTotalValSel.disabled = true;
  awayTotalValSel.value = ''; awayTotalValSel.disabled = true;

  [marginDirHome, marginDirAway, totalDirOver, totalDirUnder,
   homeTotalDirOver, homeTotalDirUnder, awayTotalDirOver, awayTotalDirUnder].forEach(b => {
    b.classList.remove('bg-blue-500', 'text-white');
    b.classList.add('text-gray-400');
  });

  const hadOverrides = forcedOut.size || forcedIn.size;
  picks.clear();
  cellN.clear();
  forcedOut.clear();
  forcedIn.clear();

  resultCard.classList.add('hidden');
  updateResetState();
  return hadOverrides;
}
resetBuilderBtn.addEventListener('click', () => {
  if (resetBuilder() && currentGame) loadPlayerData(currentGame.game_id);
  else renderPlayers();
});

// --- PLAYER MARKETS UI ---
const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K'];
const STATUS_BADGE = {
  questionable: ['Q', 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40'],
  doubtful:     ['D', 'bg-orange-500/20 text-orange-300 border-orange-500/40'],
  out:          ['OUT', 'bg-red-500/20 text-red-300 border-red-500/40'],
  inactive:     ['INACTIVE', 'bg-red-500/20 text-red-300 border-red-500/40'],
  ir:           ['IR', 'bg-red-500/20 text-red-300 border-red-500/40'],
};

function pct(p) { return p == null ? '—' : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`; }
function odds(p) { return p >= 1e-6 ? `$${(1 / p).toFixed(2)}` : '—'; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

function marketKey(side, kind, playerId) { return `${side}:${kind}:${playerId ?? 'team'}`; }

function legLabel(side, kind, player, n) {
  const abbr = playerData?.[side]?.abbr || '';
  const name = player?.name || '';
  switch (kind) {
    case 'anytime': return n === 1 ? `${name} Anytime TD` : `${name} ${n}+ TDs`;
    case 'pass_td': return `${name} ${n}+ Pass TD${n > 1 ? 's' : ''}`;
    case 'dst_td':  return `${abbr} D/ST ${n}+ TD${n > 1 ? 's' : ''}`;
    case 'fg':      return `${name || abbr} ${n}+ FG${n > 1 ? 's' : ''} Made`;
  }
  return '';
}

// The per-TD atom probability for a market (FG legs read the team FG dist instead).
function marketAtomP(side, kind, player) {
  const team = playerData?.[side];
  if (!team) return 0;
  if (kind === 'anytime') return player.td_share;
  if (kind === 'pass_td') return player.pass_td_share;
  if (kind === 'dst_td')  return team.dst_frac;
  return 0;
}

function marketCell(side, kind, player) {
  const key = marketKey(side, kind, player?.id);
  const picked = picks.get(key);
  const n = picked ? picked.min : (cellN.get(key) || 1);
  const p = singleLegProb(side, kind, marketAtomP(side, kind, player), n);
  const label = kind === 'fg' ? 'FG' : kind === 'pass_td' ? 'Pass TD' : kind === 'dst_td' ? 'D/ST TD' : 'TD';
  const sel = picked ? 'bg-blue-500 border-blue-400 text-white' : 'bg-gray-700 border-gray-600 text-gray-200 hover:border-blue-400';
  return `
    <div class="flex items-center gap-1">
      <button type="button" data-step="-1" data-key="${key}" class="px-1.5 text-gray-500 hover:text-white">&minus;</button>
      <button type="button" data-pick="${key}" data-side="${side}" data-kind="${kind}" data-player="${player?.id ?? ''}"
              class="min-w-[5.5rem] px-2 py-1 rounded-lg border text-xs font-semibold transition-colors ${sel}"
              title="${esc(legLabel(side, kind, player, n))} — ${odds(p)}">
        ${n}+ ${label} <span class="${picked ? 'text-white' : 'text-amber-400'}">${pct(p)}</span>
      </button>
      <button type="button" data-step="1" data-key="${key}" class="px-1.5 text-gray-500 hover:text-white">+</button>
    </div>`;
}

function playerRow(side, pl) {
  const [badgeTxt, badgeCls] = STATUS_BADGE[pl.status] || [];
  const badge = badgeTxt
    ? `<span class="ml-1 px-1.5 py-0.5 rounded border text-[10px] font-bold ${badgeCls}" title="${esc(pl.status_detail || '')}">${badgeTxt}</span>` : '';
  const overridden = pl.overridden ? '<span class="ml-1 text-[10px] text-blue-300">(manual)</span>' : '';
  const snap = pl.active && pl.snap_proj != null ? `${Math.round(pl.snap_proj * 100)}% snaps` : '';
  const s = pl.stats || {};
  const statLine = pl.pos === 'K'
    ? `${s.season_fg_made ?? 0} FG this season`
    : pl.pos === 'QB'
      ? `${s.season_pass_tds ?? 0} pass / ${s.season_tds ?? 0} rush TD this season`
      : `${s.season_tds ?? 0} TD in ${s.season_games ?? 0} gms · ${s.last5_rz_opps ?? 0} RZ opps last 5`;

  const markets = [];
  if (pl.active) {
    if (pl.pos === 'K') {
      if (pl.is_kicker) markets.push(marketCell(side, 'fg', pl));
    } else {
      markets.push(marketCell(side, 'anytime', pl));
      if (pl.is_starting_qb) markets.push(marketCell(side, 'pass_td', pl));
    }
  }
  return `
    <div class="flex flex-col sm:flex-row sm:items-center gap-2 py-2 border-b border-gray-800 ${pl.active ? '' : 'opacity-50'}">
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium ${pl.active ? '' : 'line-through'}">
          <span class="text-gray-500 text-xs mr-1">${pl.pos}${pl.depth}</span>${esc(pl.name)}${badge}${overridden}
        </div>
        <div class="text-[11px] text-gray-500">${[snap, statLine].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        ${markets.join('')}
        <button type="button" data-avail="${pl.id}" data-active="${pl.active ? 1 : 0}"
                class="px-2 py-1 rounded-lg border border-gray-600 text-[11px] font-semibold text-gray-400 hover:text-white hover:border-gray-400">
          ${pl.active ? 'Out' : 'In'}
        </button>
      </div>
    </div>`;
}

function renderPlayers() {
  [teamTabHome, teamTabAway].forEach(b => {
    const on = (b === teamTabHome) === (playerTab === 'home');
    b.classList.toggle('bg-blue-500', on);
    b.classList.toggle('text-white', on);
    b.classList.toggle('text-gray-400', !on);
  });
  const team = playerData?.[playerTab];
  if (!team || !team.players?.length) {
    playersTable.innerHTML = '';
    playersMeta.textContent = '';
    playersEmpty.classList.remove('hidden');
    return;
  }
  playersEmpty.classList.add('hidden');
  const qb = team.players.find(p => p.id === team.starting_qb_id);
  playersMeta.innerHTML =
    `Starting QB: <span class="text-gray-200">${esc(qb?.name || '—')}</span> · ` +
    `Pass TD share ${pct(team.pass_frac)} · D/ST TD share ${pct(team.dst_frac)}`;

  const groups = POS_ORDER.map(pos => {
    const rows = team.players.filter(p => p.pos === pos);
    if (!rows.length) return '';
    return `<div>
      <div class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-1">${pos}</div>
      ${rows.map(pl => playerRow(playerTab, pl)).join('')}
    </div>`;
  });
  const dst = `<div>
      <div class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-1">Team</div>
      <div class="flex items-center justify-between gap-2 py-2">
        <div class="text-sm font-medium">${esc(team.abbr)} Defense / Special Teams</div>
        ${marketCell(playerTab, 'dst_td', null)}
      </div>
    </div>`;
  playersTable.innerHTML = groups.join('') + dst;
}

function findPlayer(side, id) {
  return playerData?.[side]?.players.find(p => String(p.id) === String(id)) || null;
}

playersTable.addEventListener('click', e => {
  const stepBtn = e.target.closest('[data-step]');
  if (stepBtn) {
    const key = stepBtn.dataset.key;
    const picked = picks.get(key);
    const cur = picked ? picked.min : (cellN.get(key) || 1);
    const n = Math.max(1, Math.min(8, cur + Number(stepBtn.dataset.step)));
    cellN.set(key, n);
    if (picked) {
      picked.min = n;
      const [side, kind] = key.split(':');
      picked.label = legLabel(side, kind, findPlayer(side, picked.playerId), n);
      recalculate();
    }
    renderPlayers();
    return;
  }
  const pickBtn = e.target.closest('[data-pick]');
  if (pickBtn) {
    const key = pickBtn.dataset.pick;
    if (picks.has(key)) {
      picks.delete(key);
    } else {
      const { side, kind } = pickBtn.dataset;
      const playerId = pickBtn.dataset.player ? Number(pickBtn.dataset.player) : null;
      const n = cellN.get(key) || 1;
      picks.set(key, { side, kind, playerId, min: n, label: legLabel(side, kind, findPlayer(side, playerId), n) });
    }
    renderPlayers();
    updateResetState();
    recalculate();
    return;
  }
  const availBtn = e.target.closest('[data-avail]');
  if (availBtn) {
    const id = Number(availBtn.dataset.avail);
    const makeActive = availBtn.dataset.active !== '1';
    forcedOut.delete(id); forcedIn.delete(id);
    // Only record an override when it differs from the synced status.
    const pl = findPlayer('home', id) || findPlayer('away', id);
    const syncedActive = !['out', 'inactive', 'ir'].includes(pl?.status);
    if (makeActive !== syncedActive) (makeActive ? forcedIn : forcedOut).add(id);
    updateResetState();
    loadPlayerData(currentGame.game_id);
  }
});

teamTabHome.addEventListener('click', () => { playerTab = 'home'; renderPlayers(); });
teamTabAway.addEventListener('click', () => { playerTab = 'away'; renderPlayers(); });

async function loadPlayerData(gameId) {
  const seq = ++playerLoadSeq;
  const qs = new URLSearchParams();
  if (forcedOut.size) qs.set('out', [...forcedOut].join(','));
  if (forcedIn.size)  qs.set('in',  [...forcedIn].join(','));
  try {
    const res = await fetch(apiUrl('nfl', `game_player_data/${gameId}${qs.toString() ? '?' + qs : ''}`));
    const json = res.ok ? await res.json() : null;
    if (seq !== playerLoadSeq) return;
    playerData = json;
  } catch (e) {
    if (seq !== playerLoadSeq) return;
    playerData = null;
  }
  // Drop legs that no longer apply: a player now ruled out, or a pass-TD / FG leg
  // whose player is no longer the projected starting QB / kicker.
  for (const [k, p] of picks) {
    if (p.playerId == null) continue;
    const pl = findPlayer(p.side, p.playerId);
    if (!pl || !pl.active || (p.kind === 'pass_td' && !pl.is_starting_qb) || (p.kind === 'fg' && !pl.is_kicker)) {
      picks.delete(k);
    }
  }
  updateResetState();
  playersSection.classList.remove('hidden');
  renderPlayers();
  recalculate();
}

// --- GAME LOADING ---
function formatKickoff(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

async function loadBinsForGame(gameId) {
  if (binsCache[gameId]) return binsCache[gameId];
  try {
    const res = await fetch(apiUrl('nfl', `game_sgm_bins_range/${gameId}?with_dists=1`));
    if (!res.ok) { binsCache[gameId] = []; return []; }
    const json = await res.json();
    binsCache[gameId] = json.bins || [];
    return binsCache[gameId];
  } catch (e) {
    binsCache[gameId] = [];
    return [];
  }
}

async function selectGame(gameId) {
  currentGame = games.find(g => String(g.game_id) === String(gameId));
  resetBuilder();
  if (!currentGame) { builderSection.classList.add('hidden'); return; }

  builderMatchup.textContent = `${currentGame.home_team} vs ${currentGame.away_team}`;
  builderKickoff.textContent = formatKickoff(currentGame.date);
  homePtsLabel.textContent = `${currentGame.home_team} Pts`;
  awayPtsLabel.textContent = `${currentGame.away_team} Pts`;
  marginDirHome.textContent = currentGame.home_abbr || currentGame.home_team;
  marginDirAway.textContent = currentGame.away_abbr || currentGame.away_team;
  builderSection.classList.remove('hidden');
  teamTabHome.textContent = currentGame.home_abbr || currentGame.home_team;
  teamTabAway.textContent = currentGame.away_abbr || currentGame.away_team;
  playerData = null;
  teamDists = null;
  playersSection.classList.add('hidden');

  const loadingId = currentGame.game_id;
  const [bins] = await Promise.all([loadBinsForGame(loadingId), loadPlayerData(loadingId)]);
  if (currentGame?.game_id !== loadingId) return;
  teamDists = bins.length ? {
    home: { td: mixtureDist(bins, 'h_td'), fg: mixtureDist(bins, 'h_fg') },
    away: { td: mixtureDist(bins, 'a_td'), fg: mixtureDist(bins, 'a_fg') },
  } : null;
  renderPlayers();
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

  games = (json.predictions || []).filter(g => g.has_prediction);
  if (!games.length) {
    noGamesMsg.classList.remove('hidden');
    return;
  }

  gameSelect.innerHTML = games.map(g =>
    `<option value="${g.game_id}">${g.home_team} vs ${g.away_team}</option>`
  ).join('');
  selectGame(games[0].game_id);
}

weekPrevBtn.addEventListener('click', () => {
  if (currentWeek == null || currentWeek <= 1) return;
  loadWeek(currentWeek - 1);
});
weekNextBtn.addEventListener('click', () => {
  if (currentWeek == null) return;
  loadWeek(currentWeek + 1);
});

async function init() {
  const params = new URLSearchParams(window.location.search);
  const weekParam = params.get('week');
  const gameIdParam = params.get('game_id');
  if (weekParam) {
    await loadWeek(Number(weekParam));
    if (gameIdParam && games.some(g => String(g.game_id) === gameIdParam)) {
      selectGame(gameIdParam);
    }
    return;
  }
  const res = await fetch(apiUrl('nfl', 'current_week'));
  if (res.ok) {
    const json = await res.json();
    loadWeek(json.week_number);
  }
}

init();
