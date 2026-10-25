// nfl-impact-simulator.js — drives nfl/pages/simulator.html
//
// Unlike NRL's impact-simulator.js (which fetches whole round_snapshot blobs
// and filters/aggregates client-side), NFL's ext_impacts_* data is too large
// per-team to ship to the browser, so all combo-filtering and weighted
// averaging happens server-side. This file only renders whatever the backend
// already computed.
//
// Two views:
//   - This Week (default): pick a winner for each of the upcoming week's
//     games -- /api/nfl/impact_meta + /impact_projection (+ /impact_sample).
//   - Team Schedule: pick one team and set W / L for its remaining games
//     (its next 12 at most), game by game or as a W-L record in any order,
//     like the NHL page's next-5 view -- /api/nfl/impact_team_meta +
//     /impact_team_projection (+ /impact_team_sample). Loaded on first use.
//     The default team is the viewer's first NFL My Team.

import { apiUrl } from './api-config.js';
import { probColor, rankChangeBadge, deltaBadge } from './rankings-shared.js';
import { nflLogoUrl } from './nfl-logos.js';
import { teamSlug } from './utils.js';
import { rankNflTeams, seedNflConference } from './nfl-seeding.js';
import { getMyTeams, loadMyTeams, teamKey } from './my-teams.js';

const form            = document.getElementById('simulation-form');
const weekBadge       = document.getElementById('week-badge');
const chanceBox       = document.getElementById('selection-chance');
const groupsContainer = document.getElementById('rankings-groups');
const btnLeague       = document.getElementById('btn-view-league');
const btnConference   = document.getElementById('btn-view-conference');
const btnDivision     = document.getElementById('btn-view-division');
const btnSimWeek      = document.getElementById('btn-sim-week');
const btnSimTeam      = document.getElementById('btn-sim-team');
const weekPanel       = document.getElementById('week-panel');
const teamPanel       = document.getElementById('team-panel');
const teamSelect      = document.getElementById('team-select');
const teamForm        = document.getElementById('team-form');
const teamGamesTitle  = document.getElementById('team-games-heading');
const teamGamesNote   = document.getElementById('team-games-note');
const recordSection   = document.getElementById('record-section');
const gamesSection    = document.getElementById('games-section');
const recordSelect    = document.getElementById('record-select');
const expectedRecord  = document.getElementById('expected-record');
const expectedLabel   = document.getElementById('expected-record-label');

// Which projected-finish metric each standings view is ranked/sorted by.
const RANK_METRIC_BY_VIEW = {
  division:   'avg_division_rank',
  conference: 'avg_conf_seed',
  league:     'avg_league_rank',
};

const STANDINGS_COLUMNS = [
  { label: 'Rank' },
  { label: 'Team' },
  { label: 'Record' },
  { label: 'Playoffs',   key: 'pct_made_playoffs' },
  { label: 'Div Title',  key: 'pct_division_winner' },
  { label: 'Bye',        key: 'pct_first_round_bye' },
  { label: 'Div Rd',     key: 'pct_made_divisional' },
  { label: 'Conf Champ', key: 'pct_made_conf_championship' },
  { label: 'Reach SB',   key: 'pct_made_super_bowl' },
  { label: 'Win SB',     key: 'pct_super_bowl_wins' },
  { label: 'Proj. Pick', key: 'avg_draft_pick', fmt: 'pick' },
  { label: '#1 Pick',    key: 'pct_first_pick' },
  { label: 'Top-5 Pick', key: 'pct_top5_pick' },
];

const TEAM_OUTCOMES = ['W', 'L'];

let view = 'division'; // standings grouping: 'division' | 'conference' | 'league'
let simView = 'week';  // 'week' (this week's games) | 'team' (one team's schedule)
let currentWeekNumber = null;
let matches = [];      // [{home_team, away_team, home_perc, away_perc}], same order as the backend's `matches`
let weekGames = [];    // /week_predictions `predictions` for this week
let latestTeams = [];  // last projection response's `teams` array
let requestSeq = 0;    // drops out-of-order responses when picks / views change quickly

// Team-schedule view state
let teamMode = 'games';   // 'games' (pick each game) | 'record' (W-L over the window)
let metaTeams = null;     // /impact_team_meta `teams` (null until first loaded)
let focalTeam = null;     // selected team's meta entry

function formatPercent(val) {
  if (val == null || isNaN(parseFloat(val))) return '—';
  return `${parseFloat(val).toFixed(1)}%`;
}

function formatRecord(t) {
  const e = t.adjusted;
  if (e.exp_wins == null || e.exp_losses == null) return '—';
  const ties = Math.round(e.exp_ties || 0);
  return `${Math.round(e.exp_wins)}-${Math.round(e.exp_losses)}${ties > 0 ? `-${ties}` : ''}`;
}

// Value and its change-badge stack vertically (value on top, badge in small
// text underneath) rather than sitting side by side -- keeps each column
// narrow enough to fit this many columns on one row without horizontal
// scrolling, using space the row's height already has to spare (team-name
// cells wrap to 2 lines for almost every team as it is).
function pctCell(t, key) {
  const adj = t.adjusted[key];
  const base = t.base[key];
  const delta = (adj != null && base != null) ? adj - base : null;
  const badge = deltaBadge(delta);
  return `
    <td class="text-center font-medium leading-tight" style="${probColor((adj ?? 0) / 100)}">
      <div>${formatPercent(adj)}</div>
      ${badge ? `<div class="text-[0.65rem] leading-tight">${badge}</div>` : ''}
    </td>`;
}

// Expected draft position (1 = first overall). A later pick means the
// team's outlook improved, so the badge is green on a rise -- the same
// "good for the team" colouring as the percentage columns.
function pickCell(t, key) {
  const adj = t.adjusted[key];
  const base = t.base[key];
  const delta = (adj != null && base != null) ? adj - base : null;
  const badge = deltaBadge(delta, { suffix: '', threshold: 0.05 });
  return `
    <td class="text-center font-mono leading-tight">
      <div>${adj != null ? adj.toFixed(1) : '—'}</div>
      ${badge ? `<div class="text-[0.65rem] leading-tight">${badge}</div>` : ''}
    </td>`;
}

function isFocal(t) {
  return simView === 'team' && !!focalTeam && t.team === focalTeam.team;
}

function teamCell(t) {
  const highlight = isFocal(t) ? ' class="text-amber-300 font-semibold"' : '';
  return `
    <td>
      <div class="flex items-center gap-2">
        <img src="${nflLogoUrl(t.team)}" alt="${t.team}" class="w-6 h-6 object-contain shrink-0" onerror="this.style.display='none'">
        <span${highlight}>${t.team}</span>
      </div>
    </td>`;
}

// --- Match selection form (This Week) ----------------------------------------

function getSelectedPicks() {
  return matches.map((_, i) => {
    const selected = form.querySelector(`input[name='match-${i}']:checked`);
    return selected ? selected.value : null;
  });
}

// Model win probability (0-1) shown beside each team; finished games hide it.
function pctLabel(p, finished) {
  if (finished || p == null) return '';
  return `<span class="ml-auto text-xs text-gray-400 font-mono">${(p * 100).toFixed(1)}%</span>`;
}

function renderMatchOptions() {
  form.innerHTML = `
    <div class="flex flex-wrap gap-2 mb-4">
      <button id="clear-btn" type="button" class="px-3 py-1 text-sm text-white bg-red-500 rounded hover:bg-red-600">Clear All</button>
      <button id="simulate-btn" type="button" class="px-3 py-1 text-sm text-gray-900 font-semibold bg-amber-400 rounded hover:bg-amber-300 disabled:opacity-50">Simulate Remaining Games</button>
    </div>`;
  matches.forEach((m, i) => {
    const block = document.createElement('div');
    block.className = 'bg-gray-700 p-2 rounded text-white text-sm border border-gray-500 space-y-1';
    block.innerHTML = `
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="radio" name="match-${i}" value="${m.home_team}" class="accent-amber-400 w-3 h-3 shrink-0">
        <img src="${nflLogoUrl(m.home_team)}" alt="" class="w-4 h-4 object-contain shrink-0" onerror="this.style.display='none'">
        <span>${m.home_team}</span>
        ${pctLabel(m.home_perc, m.finished)}
      </label>
      <div class="text-xs text-gray-400 pl-5">vs</div>
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="radio" name="match-${i}" value="${m.away_team}" class="w-3 h-3 shrink-0">
        <img src="${nflLogoUrl(m.away_team)}" alt="" class="w-4 h-4 object-contain shrink-0" onerror="this.style.display='none'">
        <span>${m.away_team}</span>
        ${pctLabel(m.away_perc, m.finished)}
      </label>
    `;
    form.appendChild(block);
  });
}

function matchIndexFor(g) {
  return matches.findIndex(m => teamSlug(m.home_team) === teamSlug(g.home_team) && teamSlug(m.away_team) === teamSlug(g.away_team));
}

async function loadWeekGames() {
  try {
    const res = await fetch(apiUrl('nfl', `week_predictions/${currentWeekNumber}`));
    if (!res.ok) return;
    weekGames = (await res.json()).predictions || [];
    weekGames.forEach(g => {
      const m = matches[matchIndexFor(g)];
      if (!m) return;
      m.home_perc = g.home_perc;
      m.away_perc = g.away_perc;
      m.finished = !!g.is_finished;
    });
  } catch (e) {
    console.warn('Could not load week predictions:', e);
  }
}

function autoLockFinishedGames() {
  weekGames.forEach(g => {
    if (!g.is_finished) return;
    const idx = matchIndexFor(g);
    if (idx === -1) return;
    // Real ties are bucketed under "away" for combo-indexing purposes on
    // the backend (see /api/nfl/impact_meta docs) — mirror that here.
    const winner = g.home_score > g.away_score ? g.home_team
                  : g.away_score > g.home_score ? g.away_team
                  : g.away_team;
    const radios = form.querySelectorAll(`input[name='match-${idx}']`);
    const radio = [...radios].find(r => teamSlug(r.value) === teamSlug(winner));
    if (!radio) return;
    radio.checked = true;
    radios.forEach(r => {
      r.disabled = true;
      const label = r.closest('label');
      if (!label) return;
      if (r === radio) {
        label.classList.add('text-green-400', 'font-semibold');
        label.classList.remove('text-white');
      } else {
        label.classList.add('opacity-30');
      }
    });
  });
}

// --- Team selection (Team Schedule) ------------------------------------------

function renderTeamOptions() {
  teamSelect.innerHTML = metaTeams
    .map(t => `<option value="${t.team}">${t.team}</option>`)
    .join('');
}

// The team's whole season, week by week (backend `schedule`): games already
// played show their result; the projectable window games (the next 12 at
// most, `slot` = their pick index) get W / L buttons; later games show as
// not projectable yet; plus the bye. Falls back to the window games alone.
function teamSchedule() {
  return focalTeam.schedule
    || focalTeam.games.map((g, k) => ({ ...g, status: 'window', slot: k }));
}

const RESULT_CLS = { W: 'bg-green-600', L: 'bg-red-600', T: 'bg-gray-500' };

function scheduleHeader(e, tail = '') {
  return `
    <div class="flex items-center gap-2">
      <span class="text-xs text-gray-400 w-12 shrink-0">Wk ${e.week_number}</span>
      <span class="text-xs text-gray-400">${e.home ? 'vs' : '@'}</span>
      <img src="${nflLogoUrl(e.opponent)}" alt="" class="w-4 h-4 object-contain shrink-0" onerror="this.style.display='none'">
      <span class="truncate">${e.opponent}</span>
      ${tail}
    </div>`;
}

function resultTag(e) {
  return `<span class="ml-auto shrink-0 flex items-center gap-1.5">
      <span class="text-xs font-mono text-gray-300">${e.score || ''}</span>
      <span class="text-[0.7rem] font-bold text-white rounded px-1.5 ${RESULT_CLS[e.result] || ''}">${e.result}</span>
    </span>`;
}

function windowGameBlock(e) {
  const k = e.slot;
  const g = focalTeam.games[k];
  const buttons = TEAM_OUTCOMES.map(o => {
    const locked = g.finished;
    const checked = locked && g.result === o;
    // Window games that have finished since the batch run are locked to
    // their real result (green); open games highlight the picked outcome amber.
    const cls = locked
      ? (checked ? 'bg-green-600 text-white font-semibold' : 'bg-gray-800 opacity-30')
      : 'bg-gray-800 cursor-pointer hover:border-amber-400 peer-checked:bg-amber-400 peer-checked:text-gray-900 peer-checked:font-semibold';
    // g.pct is the selected team's simulated win chance (open games only).
    const pct = g.pct == null ? null : (o === 'W' ? g.pct : 100 - g.pct);
    return `
      <label class="flex-1">
        <input type="radio" name="team-game-${k}" value="${o}" class="peer sr-only" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <span class="block text-center rounded px-2 py-1 border border-gray-500 ${cls}">${o}</span>
        ${pct != null ? `<span class="block text-center text-[0.65rem] text-gray-400 mt-0.5">${pct.toFixed(1)}%</span>` : ''}
      </label>`;
  }).join('');
  return `
    <div class="bg-gray-700 p-2 rounded text-white text-sm border border-gray-500">
      <div class="mb-2">${scheduleHeader(e, e.finished ? resultTag(e) : '')}</div>
      <div class="flex gap-1">${buttons}</div>
    </div>`;
}

function scheduleBlock(e) {
  if (e.status === 'window') return windowGameBlock(e);
  if (e.status === 'bye') {
    return `<div class="px-2 py-1 rounded text-xs text-gray-500 border border-dashed border-gray-700">
        <span class="inline-block w-12">Wk ${e.week_number}</span>Bye</div>`;
  }
  if (e.status === 'played') {
    return `<div class="bg-gray-800 p-2 rounded text-sm text-gray-200 border border-gray-700">${scheduleHeader(e, resultTag(e))}</div>`;
  }
  // 'beyond': past the projection window
  return `<div class="bg-gray-800 p-2 rounded text-sm text-gray-400 border border-gray-700 opacity-60">
      ${scheduleHeader(e, '<span class="ml-auto shrink-0 text-[0.65rem] uppercase tracking-wider">Not projectable yet</span>')}
    </div>`;
}

function renderTeamGames() {
  teamForm.innerHTML = `
    <div class="flex flex-wrap gap-2 mb-4">
      <button id="team-clear-btn" type="button" class="px-3 py-1 text-sm text-white bg-red-500 rounded hover:bg-red-600">Clear All</button>
      <button id="team-simulate-btn" type="button" class="px-3 py-1 text-sm text-gray-900 font-semibold bg-amber-400 rounded hover:bg-amber-300 disabled:opacity-50">Simulate Remaining Games</button>
    </div>`;
  const schedule = teamSchedule();
  const n = focalTeam.games.length;
  const beyond = schedule.filter(e => e.status === 'beyond').length;
  teamGamesNote.textContent = !n ? 'No remaining regular-season games to project.'
    : beyond ? `W = win · L = loss or tie. The next ${n} games can be projected; the ${beyond} after them aren't projectable yet.`
    : 'W = win · L = loss or tie.';
  teamForm.insertAdjacentHTML('beforeend', schedule.map(scheduleBlock).join(''));
}

// Season record from games outside the projection window (all played).
function playedRecord() {
  const c = { W: 0, L: 0, T: 0 };
  teamSchedule().forEach(e => { if (e.status === 'played' && e.result) c[e.result] += 1; });
  return c;
}

function formatWLT(w, l, t) {
  return `${w}-${l}${t ? `-${t}` : ''}`;
}

// --- Window record (record mode) ---------------------------------------------

// The backend's record summary is already conditioned on any window games
// that have finished.
function finishedCounts() {
  const c = { W: 0, L: 0 };
  focalTeam.games.forEach(g => { if (g.finished) c[g.result] += 1; });
  return c;
}

function isFeasibleRecord(r, fixed) {
  return r.W >= fixed.W && r.L >= fixed.L;
}

// The whole-game record closest to the (unrounded) expected wins; ties go
// to the more likely record.
function nearestRecord(records, expectedWins, fixed) {
  let best = null;
  let bestDist = Infinity;
  records.filter(r => isFeasibleRecord(r, fixed)).forEach(r => {
    const dist = Math.abs(r.W - expectedWins);
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && r.pct > best.pct)) {
      best = r;
      bestDist = dist;
    }
  });
  return best;
}

function renderRecordOptions() {
  const rec = focalTeam.record;
  const n = focalTeam.games.length;
  // The window is every remaining game unless the team has more left than
  // the backend's cap (early season), when it's the next n.
  const soFar = { W: 0, L: 0, T: 0 };
  teamSchedule().forEach(e => { if (e.finished && e.result) soFar[e.result] += 1; });
  teamGamesTitle.textContent = `Season Schedule (${formatWLT(soFar.W, soFar.L, soFar.T)} so far)`;
  expectedLabel.textContent = focalTeam.window_is_all
    ? `Expected Record (remaining ${n} ${n === 1 ? 'game' : 'games'})`
    : `Expected Record (next ${n} games)`;

  if (!rec || rec.expected_wins == null || !rec.records.length) {
    expectedRecord.textContent = '—';
    recordSection.hidden = true;
    setTeamMode('games', { refresh: false });
    return;
  }
  recordSection.hidden = false;
  const e = rec.expected_wins;
  expectedRecord.textContent = `${e.toFixed(2)}-${(n - e).toFixed(2)}`;

  // Most likely first; records ruled out by finished games go last.
  const fixed = finishedCounts();
  const sorted = [...rec.records].sort((a, b) =>
    (isFeasibleRecord(b, fixed) - isFeasibleRecord(a, fixed)) || b.pct - a.pct);
  // With every remaining game in the window, each option also shows the
  // season record it finishes on (games played before the window included).
  const p = playedRecord();
  const finalRecord = r => (focalTeam.window_is_all ? ` → ${formatWLT(p.W + r.W, p.L + r.L, p.T)}` : '');
  recordSelect.innerHTML = sorted.map(r => {
    const feasible = isFeasibleRecord(r, fixed);
    return `<option value="${r.record}" class="text-sm font-normal text-white" ${feasible ? '' : 'disabled'}>${r.record}${finalRecord(r)}${feasible ? `  (${r.pct.toFixed(1)}%)` : ''}</option>`;
  }).join('');
  const nearest = nearestRecord(rec.records, e, fixed);
  if (nearest) recordSelect.value = nearest.record;
}

function setTeamMode(newMode, { refresh = true } = {}) {
  const changed = newMode !== teamMode;
  teamMode = newMode;
  document.querySelectorAll("input[name='sim-mode']").forEach(r => { r.checked = r.value === teamMode; });
  recordSection.classList.toggle('opacity-40', teamMode !== 'record');
  gamesSection.classList.toggle('opacity-40', teamMode !== 'games');
  if (changed && refresh && focalTeam) updateProjection();
}

function getTeamPicks() {
  // Record mode ignores the game-by-game picks but keeps finished games
  // pinned to their real result.
  if (teamMode === 'record') return focalTeam.games.map(g => (g.finished ? g.result : null));
  return focalTeam.games.map((_, i) => {
    const selected = teamForm.querySelector(`input[name='team-game-${i}']:checked`);
    return selected ? selected.value : null;
  });
}

function selectTeam(name) {
  focalTeam = metaTeams.find(t => t.team === name) || metaTeams[0];
  teamSelect.value = focalTeam.team;
  try { localStorage.setItem('nfl_impact_team', focalTeam.team); } catch (e) { /* storage unavailable */ }
  renderTeamGames();
  renderRecordOptions();
  updateProjection();
}

// The viewer's first NFL My Team, if they follow one; otherwise the last
// team picked here; otherwise the first team alphabetically.
function defaultTeam() {
  const mine = (getMyTeams().teams.nfl || [])
    .map(name => metaTeams.find(t => teamKey('nfl', t.team) === teamKey('nfl', name)))
    .find(Boolean);
  if (mine) return mine.team;
  try { return localStorage.getItem('nfl_impact_team'); } catch (e) { return null; }
}

async function loadTeamMeta() {
  // Profile My Teams load alongside the meta, so signed-in picks are known in time.
  const [res] = await Promise.all([
    fetch(apiUrl('nfl', `impact_team_meta?week=${currentWeekNumber}`)),
    loadMyTeams().catch(() => null),
  ]);
  if (!res.ok) {
    metaTeams = [];
    return;
  }
  const json = await res.json();
  metaTeams = (json.teams || []).map(t => ({ ...t, window_is_all: t.games.length >= (t.remaining ?? 0) }));
}

// --- Projection fetch --------------------------------------------------------

async function updateProjection() {
  if (simView === 'team') return updateTeamProjection();
  const seq = ++requestSeq;
  const picks = getSelectedPicks();
  const hasSelections = picks.some(Boolean);

  const url = apiUrl('nfl', `impact_projection?week=${currentWeekNumber}&picks=${encodeURIComponent(JSON.stringify(picks))}`);
  const res = await fetch(url);
  if (!res.ok || seq !== requestSeq) return;
  const json = await res.json();
  if (seq !== requestSeq) return;
  latestTeams = json.teams || [];

  chanceBox.textContent = (hasSelections && json.matched_sims != null && json.total_sims != null)
    ? `Combination of selections occurred in ${json.matched_sims} out of ${json.total_sims} simulations`
    : '';

  renderSeeding();
  renderStandings();
}

async function updateTeamProjection() {
  if (!focalTeam) return;
  const seq = ++requestSeq;
  const picks = getTeamPicks();
  const record = teamMode === 'record' ? recordSelect.value : null;
  const hasSelections = !!record || picks.some(Boolean);

  let query = `week=${currentWeekNumber}&team=${encodeURIComponent(focalTeam.team)}&picks=${encodeURIComponent(JSON.stringify(picks))}`;
  if (record) query += `&record=${encodeURIComponent(record)}`;
  const res = await fetch(apiUrl('nfl', `impact_team_projection?${query}`));
  if (!res.ok || seq !== requestSeq) return;
  const json = await res.json();
  if (seq !== requestSeq) return;
  latestTeams = json.teams || [];

  const what = record ? `A ${record} record` : 'Combination of results';
  chanceBox.textContent = (hasSelections && json.matched_sims != null && json.total_sims != null)
    ? `${what} occurred in ${json.matched_sims.toLocaleString()} out of ${json.total_sims.toLocaleString()} simulations (${json.chance_of_selection}%)`
    : '';

  renderSeeding();
  renderStandings();
}

// --- This Week / Team Schedule switch ----------------------------------------

async function setSimView(newView) {
  if (newView === simView) return;
  simView = newView;
  [btnSimWeek, btnSimTeam].forEach(btn => {
    btn.classList.remove('bg-amber-400', 'text-gray-900', 'font-bold');
    btn.classList.add('text-gray-400', 'font-semibold');
  });
  const activeBtn = simView === 'team' ? btnSimTeam : btnSimWeek;
  activeBtn.classList.add('bg-amber-400', 'text-gray-900', 'font-bold');
  activeBtn.classList.remove('text-gray-400', 'font-semibold');
  weekPanel.hidden = simView !== 'week';
  teamPanel.hidden = simView !== 'team';
  chanceBox.textContent = '';

  if (simView === 'team' && metaTeams === null) {
    chanceBox.textContent = 'Loading team schedules…';
    await loadTeamMeta();
    if (simView !== 'team') return;
    chanceBox.textContent = '';
    if (!metaTeams.length) {
      chanceBox.textContent = 'Team schedule simulation data is not available yet.';
      return;
    }
    renderTeamOptions();
    setTeamMode('games', { refresh: false });
    selectTeam(defaultTeam());
    return;
  }
  if (simView === 'team' && !focalTeam) return;
  updateProjection();
}

btnSimWeek.addEventListener('click', () => setSimView('week'));
btnSimTeam.addEventListener('click', () => setSimView('team'));

// --- Projected Playoff Seeding (division-scoped, always) -------------------

// Ordering lives in nfl-seeding.js, shared with the power rankings page:
// projected record, then Div Title % within a division, 1st seed % (the only
// seed with a bye) and playoff % across divisions. avg_conf_seed isn't used --
// it's averaged only over the trials where a team made the playoffs, so it
// isn't comparable across teams with different playoff odds.
function seedingEntry(t, useBase) {
  const m = useBase ? t.base : t.adjusted;
  return { team: t.team, division: t.division, t,
           m: { wins: m.exp_wins, losses: m.exp_losses, ties: m.exp_ties, divPct: m.pct_division_winner,
                seed1Pct: m.pct_first_round_bye, playoffPct: m.pct_made_playoffs } };
}

function seedConference(conf, useBase = false) {
  const { seeded, inTheHunt } = seedNflConference(
    latestTeams.filter(t => t.conference === conf).map(t => seedingEntry(t, useBase)));
  return { seeded: seeded.map(e => e.t), hunt: inTheHunt.map(e => e.t) };
}

// Seed number a team held before the currently-selected picks were applied
// (i.e. their position in the base/unconditional ordering) — used to show
// movement arrows, same idea as the Standings table's rankChangeBadge.
// Extends across the "in the hunt" teams too, so those rows get arrows too.
function seedRankByTeam(conf) {
  const rankByTeam = {};
  const { seeded, hunt } = seedConference(conf, true);
  [...seeded, ...hunt].forEach((t, i) => { rankByTeam[t.team] = i + 1; });
  return rankByTeam;
}

function seedRow(t, rank, baseSeedByTeam) {
  const badge = rankChangeBadge(rank, baseSeedByTeam[t.team]);
  return `
    <tr>
      <td class="text-center font-mono leading-tight">
        <div>${rank}</div>
        ${badge ? `<div class="text-[0.65rem] leading-tight">${badge}</div>` : ''}
      </td>
      ${teamCell(t)}
      <td class="text-center font-mono">${formatRecord(t)}</td>
      ${pctCell(t, 'pct_made_playoffs')}
      ${pctCell(t, 'pct_division_winner')}
      ${pctCell(t, 'pct_first_round_bye')}
    </tr>
  `;
}

const huntDividerRow = `
  <tr>
    <td colspan="6" class="text-center text-xs font-semibold text-gray-500 uppercase tracking-widest" style="border-top:2px solid var(--border-default); padding-top:0.75rem;">In the Hunt</td>
  </tr>
`;

function seedingBodyHtml(conf, baseSeedByTeam) {
  const { seeded, hunt } = seedConference(conf);
  const seededRows = seeded.map((t, i) => seedRow(t, i + 1, baseSeedByTeam)).join('');
  const huntRows = hunt.map((t, i) => seedRow(t, seeded.length + i + 1, baseSeedByTeam)).join('');
  return seededRows + (hunt.length ? huntDividerRow : '') + huntRows;
}

function renderSeeding() {
  const afcBody = document.querySelector('#seeding-table-afc tbody');
  const nfcBody = document.querySelector('#seeding-table-nfc tbody');
  const afcBaseSeed = seedRankByTeam('AFC');
  const nfcBaseSeed = seedRankByTeam('NFC');
  if (afcBody) afcBody.innerHTML = seedingBodyHtml('AFC', afcBaseSeed);
  if (nfcBody) nfcBody.innerHTML = seedingBodyHtml('NFC', nfcBaseSeed);
}

// --- Standings, grouped per view-toggle, sorted by projected finish --------

function groupRank(teamsInGroup, metricKey, useBase) {
  // The 'conference' view ranks by avg_conf_seed, which has the
  // conditional-average trap described above seedingEntry -- rank by
  // projected record (with the seeding tiebreakers) instead.
  // 'division'/'league' use avg_division_rank/avg_league_rank, which ARE
  // unconditional (every team gets ranked every trial), so a plain numeric
  // sort on them is fine.
  if (metricKey === 'avg_conf_seed') {
    const sorted = rankNflTeams(teamsInGroup.map(t => seedingEntry(t, useBase))).map(e => e.t);
    const rankByTeam = {};
    sorted.forEach((t, i) => { rankByTeam[t.team] = i + 1; });
    return { sorted, rankByTeam };
  }
  const cmp = (a, b) => {
    const av = (useBase ? a.base : a.adjusted)[metricKey];
    const bv = (useBase ? b.base : b.adjusted)[metricKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av - bv; // lower rank/seed number = better = sorts first
  };
  const sorted = [...teamsInGroup].sort(cmp);
  const rankByTeam = {};
  sorted.forEach((t, i) => { rankByTeam[t.team] = i + 1; });
  return { sorted, rankByTeam };
}

function rowHtml(t, currentRank, baseRankByTeam) {
  const cells = STANDINGS_COLUMNS.slice(3).map(c => (c.fmt === 'pick' ? pickCell : pctCell)(t, c.key)).join('');
  const badge = rankChangeBadge(currentRank, baseRankByTeam[t.team]);
  return `
    <tr>
      <td class="text-center text-gray-400 font-medium leading-tight">
        <div>${currentRank}</div>
        ${badge ? `<div class="text-[0.65rem] leading-tight">${badge}</div>` : ''}
      </td>
      ${teamCell(t)}
      <td class="text-center font-mono">${formatRecord(t)}</td>
      ${cells}
    </tr>
  `;
}

function tableHtml(rows) {
  return `
    <table class="data-table data-table--compact">
      <thead><tr>${STANDINGS_COLUMNS.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function groupTableHtml(teamsInGroup, metricKey) {
  const { sorted, rankByTeam: adjRankByTeam } = groupRank(teamsInGroup, metricKey, false);
  const { rankByTeam: baseRankByTeam } = groupRank(teamsInGroup, metricKey, true);
  const rows = sorted.map((t, i) => rowHtml(t, i + 1, baseRankByTeam)).join('');
  return `<div class="overflow-x-auto">${tableHtml(rows)}</div>`;
}

function renderStandings() {
  const metricKey = RANK_METRIC_BY_VIEW[view];

  if (view === 'league') {
    groupsContainer.innerHTML = groupTableHtml(latestTeams, metricKey);
    return;
  }

  const groups = {};
  latestTeams.forEach(t => {
    const key = view === 'conference' ? t.conference : `${t.conference} ${t.division}`;
    (groups[key] = groups[key] || []).push(t);
  });

  groupsContainer.innerHTML = Object.keys(groups).sort().map(key => `
    <div class="mb-6 last:mb-0">
      <h3 class="text-sm font-bold uppercase tracking-widest text-gray-400 mb-2">${key}</h3>
      ${groupTableHtml(groups[key], metricKey)}
    </div>
  `).join('');
}

function setView(newView) {
  view = newView;
  [btnLeague, btnConference, btnDivision].forEach(btn => {
    btn.classList.remove('bg-amber-400', 'text-gray-900');
    btn.classList.add('text-gray-400');
  });
  const activeBtn = { league: btnLeague, conference: btnConference, division: btnDivision }[view];
  activeBtn.classList.add('bg-amber-400', 'text-gray-900');
  activeBtn.classList.remove('text-gray-400');
  renderStandings();
}

btnLeague.addEventListener('click', () => setView('league'));
btnConference.addEventListener('click', () => setView('conference'));
btnDivision.addEventListener('click', () => setView('division'));

// --- Form wiring (This Week) -------------------------------------------------

form.addEventListener('change', () => updateProjection());
// Fills every unpicked game with a random result. The backend draws one
// simulated combo consistent with the current picks (weighted by how often
// it occurred), so the result always lands on simulated data.
async function simulateRemaining(btn) {
  btn.disabled = true;
  try {
    const picks = getSelectedPicks();
    const res = await fetch(apiUrl('nfl', `impact_sample?week=${currentWeekNumber}&picks=${encodeURIComponent(JSON.stringify(picks))}`));
    if (!res.ok) return;
    const json = await res.json();
    (json.picks || []).forEach((winner, i) => {
      if (picks[i] || !winner) return;
      const radio = [...form.querySelectorAll(`input[name='match-${i}']`)].find(r => r.value === winner);
      if (radio && !radio.disabled) radio.checked = true;
    });
    await updateProjection();
  } finally {
    btn.disabled = false;
  }
}

form.addEventListener('click', (e) => {
  if (e.target.id === 'simulate-btn') {
    simulateRemaining(e.target);
    return;
  }
  if (e.target.id !== 'clear-btn') return;
  // Only clear picks the user actually made — auto-locked (already-finished)
  // games stay locked, since they're not really "what-if" selections.
  form.querySelectorAll("input[type='radio']:not(:disabled)").forEach(input => {
    input.checked = false;
  });
  updateProjection();
});

// --- Form wiring (Team Schedule) ---------------------------------------------

teamSelect.addEventListener('change', () => selectTeam(teamSelect.value));
teamForm.addEventListener('change', () => updateProjection());
recordSelect.addEventListener('change', () => updateProjection());
document.querySelectorAll("input[name='sim-mode']").forEach(r => {
  r.addEventListener('change', () => { if (r.checked) setTeamMode(r.value); });
});
// Interacting with the greyed-out section switches to that method.
recordSection.addEventListener('pointerdown', () => setTeamMode('record'));
recordSection.addEventListener('focusin', () => setTeamMode('record'));
gamesSection.addEventListener('pointerdown', () => setTeamMode('games'));
gamesSection.addEventListener('focusin', () => setTeamMode('games'));

// Same as the This Week button: the backend draws one simulated combo of the
// team's results consistent with the current picks.
async function simulateTeamRemaining(btn) {
  btn.disabled = true;
  try {
    setTeamMode('games', { refresh: false });
    const picks = getTeamPicks();
    const query = `week=${currentWeekNumber}&team=${encodeURIComponent(focalTeam.team)}&picks=${encodeURIComponent(JSON.stringify(picks))}`;
    const res = await fetch(apiUrl('nfl', `impact_team_sample?${query}`));
    if (!res.ok) return;
    const json = await res.json();
    (json.picks || []).forEach((outcome, i) => {
      if (picks[i] || !outcome) return;
      const radio = teamForm.querySelector(`input[name='team-game-${i}'][value='${outcome}']`);
      if (radio && !radio.disabled) radio.checked = true;
    });
    await updateProjection();
  } finally {
    btn.disabled = false;
  }
}

teamForm.addEventListener('click', (e) => {
  if (e.target.id === 'team-simulate-btn') {
    simulateTeamRemaining(e.target);
    return;
  }
  if (e.target.id !== 'team-clear-btn') return;
  // Finished games stay locked to their real result.
  teamForm.querySelectorAll("input[type='radio']:not(:disabled)").forEach(input => {
    input.checked = false;
  });
  updateProjection();
});

// --- Bootstrap ---------------------------------------------------------------

async function loadSimulator() {
  const res = await fetch(apiUrl('nfl', 'impact_meta'));
  if (!res.ok) return;
  const json = await res.json();

  currentWeekNumber = json.week_number;
  matches = (json.matches || []).map(m => ({ home_team: m.home, away_team: m.away }));
  if (weekBadge && currentWeekNumber != null) weekBadge.textContent = `Week ${currentWeekNumber}`;

  await loadWeekGames();
  renderMatchOptions();
  autoLockFinishedGames();
  await updateProjection();
}

loadSimulator();
