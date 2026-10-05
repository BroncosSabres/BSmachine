// nhl-impact-simulator.js — drives nhl/pages/simulator.html
//
// NHL has no rounds, so unlike nfl-impact-simulator.js ("pick every game this
// week") the user picks ONE team and sets W / OTL / L for that team's next 5
// games; every team's projections then update. All combo filtering and
// weighted averaging happens server-side via /api/nhl/impact_meta +
// /impact_projection (backed by nhl.ext_impacts_team_combo) — this file only
// renders what the backend computed. Seeding mirrors nhl-rankings.js's
// computeProjectedSeedGroups (top 3 per division + 2 wild cards, by
// projected points), with rank-change badges against the no-picks baseline.
//
// Two ways to condition: game by game (default), or "by record" -- a W-L-OTL
// total over the next 5 in any order, which the backend expands to every
// matching combo. The default team is the viewer's first NHL My Team.

import { apiUrl } from './api-config.js';
import { probColor, rankChangeBadge, deltaBadge } from './rankings-shared.js';
import { nhlLogoUrl } from './nhl-logos.js';
import { getMyTeams, loadMyTeams, teamKey } from './my-teams.js';

const form            = document.getElementById('simulation-form');
const teamSelect      = document.getElementById('team-select');
const dateBadge       = document.getElementById('week-badge');
const chanceBox       = document.getElementById('selection-chance');
const groupsContainer = document.getElementById('rankings-groups');
const btnLeague       = document.getElementById('btn-view-league');
const btnConference   = document.getElementById('btn-view-conference');
const btnDivision     = document.getElementById('btn-view-division');
const nextGamesTitle  = document.getElementById('next-games-heading');
const recordSection   = document.getElementById('record-section');
const gamesSection    = document.getElementById('games-section');
const recordSelect    = document.getElementById('record-select');
const expectedRecord  = document.getElementById('expected-record');
const expectedLabel   = document.getElementById('expected-record-label');
const spotlight       = document.getElementById('focal-spotlight');

const OUTCOMES = ['W', 'OTL', 'L'];

const STANDINGS_COLUMNS = [
  { label: 'Rank' },
  { label: 'Team' },
  { label: 'Points' },
  { label: 'Record' },
  { label: 'Playoffs',   key: 'pct_playoffs' },
  { label: 'Div Top-3',  key: 'pct_division_top3' },
  { label: '2nd Round',  key: 'pct_second_round' },
  { label: 'Conf Final', key: 'pct_conf_final' },
  { label: 'Reach SCF',  key: 'pct_scf' },
  { label: 'Win SCF',    key: 'pct_cup' },
];

let view = 'division'; // 'division' | 'conference' | 'league'
let mode = 'games';    // 'games' (pick each game) | 'record' (W-L-OTL over the next 5)
let metaTeams = [];    // /impact_meta `teams`: [{team, games: [...]}, ...]
let focalTeam = null;  // currently selected team's meta entry
let latestTeams = [];  // last /impact_projection response's `teams` array
let requestSeq = 0;    // drops out-of-order responses when picks change quickly

function formatPercent(val) {
  if (val == null || isNaN(parseFloat(val))) return '—';
  return `${parseFloat(val).toFixed(1)}%`;
}

function formatRecord(m) {
  if (m.exp_wins == null) return '—';
  return `${Math.round(m.exp_wins)}-${Math.round(m.exp_reg_losses)}-${Math.round(m.exp_ot_so_losses)}`;
}

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

function pointsCell(t) {
  const adj = t.adjusted.exp_points;
  const base = t.base.exp_points;
  const delta = (adj != null && base != null) ? adj - base : null;
  const badge = deltaBadge(delta, { suffix: '', threshold: 0.05 });
  return `
    <td class="text-center font-mono leading-tight">
      <div>${adj != null ? adj.toFixed(1) : '—'}</div>
      ${badge ? `<div class="text-[0.65rem] leading-tight">${badge}</div>` : ''}
    </td>`;
}

function isFocal(t) {
  return !!focalTeam && t.team === focalTeam.team;
}

function teamCell(t) {
  const highlight = isFocal(t) ? ' text-amber-300 font-semibold' : '';
  return `
    <td>
      <div class="flex items-center gap-2">
        <img src="${nhlLogoUrl(t.team)}" alt="${t.team}" class="w-6 h-6 object-contain shrink-0" onerror="this.style.display='none'">
        <span class="${highlight}">${t.team}</span>
      </div>
    </td>`;
}

// --- Team + game selection ---------------------------------------------------

function formatGameDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function renderTeamOptions() {
  teamSelect.innerHTML = metaTeams
    .map(t => `<option value="${t.team}">${t.team}</option>`)
    .join('');
}

function renderGameOptions() {
  form.innerHTML = `
    <div class="flex flex-wrap gap-2 mb-4">
      <button id="clear-btn" type="button" class="px-3 py-1 text-sm text-white bg-red-500 rounded hover:bg-red-600">Clear All</button>
      <button id="simulate-btn" type="button" class="px-3 py-1 text-sm text-gray-900 font-semibold bg-amber-400 rounded hover:bg-amber-300">Simulate Remaining Games</button>
    </div>`;
  if (!focalTeam.games.length) {
    form.insertAdjacentHTML('beforeend', `<div class="text-gray-400">No remaining regular-season games.</div>`);
    return;
  }
  focalTeam.games.forEach((g, i) => {
    const block = document.createElement('div');
    block.className = 'bg-gray-700 p-2 rounded text-white text-sm border border-gray-500';
    const buttons = OUTCOMES.map(o => {
      const locked = g.finished;
      const checked = locked && g.result === o;
      // Finished games are locked to their real result (green); open games
      // highlight the picked outcome amber.
      const cls = locked
        ? (checked ? 'bg-green-600 text-white font-semibold' : 'bg-gray-800 opacity-30')
        : 'bg-gray-800 cursor-pointer hover:border-amber-400 peer-checked:bg-amber-400 peer-checked:text-gray-900 peer-checked:font-semibold';
      // Simulated chance of this result for the selected team, when available
      // (open games only -- finished games are locked to the real result).
      const pct = g.pct?.[o];
      return `
        <label class="flex-1">
          <input type="radio" name="game-${i}" value="${o}" class="peer sr-only" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
          <span class="block text-center rounded px-2 py-1 border border-gray-500 ${cls}">${o}</span>
          ${pct != null ? `<span class="block text-center text-[0.65rem] text-gray-400 mt-0.5">${pct.toFixed(1)}%</span>` : ''}
        </label>`;
    }).join('');
    block.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        <span class="text-xs text-gray-400 w-20 shrink-0">${formatGameDate(g.date)}</span>
        <span class="text-xs text-gray-400">${g.home ? 'vs' : '@'}</span>
        <img src="${nhlLogoUrl(g.opponent)}" alt="" class="w-4 h-4 object-contain shrink-0" onerror="this.style.display='none'">
        <span class="truncate">${g.opponent}</span>
        ${g.finished ? '<span class="ml-auto text-[0.65rem] text-green-400 uppercase tracking-wider">Final</span>' : ''}
      </div>
      <div class="flex gap-1">${buttons}</div>
    `;
    form.appendChild(block);
  });
}

// --- Next-5 record (record mode) ---------------------------------------------

// Records are W-L-OTL (NHL standings order); the backend's next_record
// summary is already conditioned on any of the games that have finished.
function finishedCounts() {
  const c = { W: 0, L: 0, OTL: 0 };
  focalTeam.games.forEach(g => { if (g.finished) c[g.result] += 1; });
  return c;
}

function isFeasibleRecord(r, fixed) {
  return r.W >= fixed.W && r.L >= fixed.L && r.OTL >= fixed.OTL;
}

// The whole-game record closest to the (unrounded) expected record; ties go
// to the more likely record.
function nearestRecord(records, expected, fixed) {
  let best = null;
  let bestDist = Infinity;
  records.filter(r => isFeasibleRecord(r, fixed)).forEach(r => {
    const dist = (r.W - expected.W) ** 2 + (r.L - expected.L) ** 2 + (r.OTL - expected.OTL) ** 2;
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && r.pct > best.pct)) {
      best = r;
      bestDist = dist;
    }
  });
  return best;
}

function renderRecordOptions() {
  const nr = focalTeam.next_record;
  const n = focalTeam.games.length;
  nextGamesTitle.textContent = `Next ${n || 5} Games`;
  expectedLabel.textContent = `Expected Next ${n || 5} Record`;

  if (!nr || !nr.expected || !nr.records.length) {
    expectedRecord.textContent = '—';
    recordSection.hidden = true;
    setMode('games', { refresh: false });
    return;
  }
  recordSection.hidden = false;
  const e = nr.expected;
  expectedRecord.textContent = `${e.W.toFixed(2)}-${e.L.toFixed(2)}-${e.OTL.toFixed(2)}`;

  // Most likely first; records ruled out by finished games go last.
  const fixed = finishedCounts();
  const sorted = [...nr.records].sort((a, b) =>
    (isFeasibleRecord(b, fixed) - isFeasibleRecord(a, fixed)) || b.pct - a.pct);
  recordSelect.innerHTML = sorted.map(r => {
    const feasible = isFeasibleRecord(r, fixed);
    return `<option value="${r.record}" class="text-sm font-normal text-white" ${feasible ? '' : 'disabled'}>${r.record}${feasible ? `  (${r.pct.toFixed(1)}%)` : ''}</option>`;
  }).join('');
  const nearest = nearestRecord(nr.records, e, fixed);
  if (nearest) recordSelect.value = nearest.record;
}

function setMode(newMode, { refresh = true } = {}) {
  const changed = newMode !== mode;
  mode = newMode;
  document.querySelectorAll("input[name='sim-mode']").forEach(r => { r.checked = r.value === mode; });
  recordSection.classList.toggle('opacity-40', mode !== 'record');
  gamesSection.classList.toggle('opacity-40', mode !== 'games');
  if (changed && refresh && focalTeam) updateProjection();
}

// --- Picks -------------------------------------------------------------------

function getSelectedPicks() {
  // Record mode ignores the game-by-game picks but keeps finished games
  // pinned to their real result.
  if (mode === 'record') return focalTeam.games.map(g => (g.finished ? g.result : null));
  return focalTeam.games.map((_, i) => {
    const selected = form.querySelector(`input[name='game-${i}']:checked`);
    return selected ? selected.value : null;
  });
}

function selectTeam(name) {
  focalTeam = metaTeams.find(t => t.team === name) || metaTeams[0];
  teamSelect.value = focalTeam.team;
  try { localStorage.setItem('nhl_impact_team', focalTeam.team); } catch (e) { /* storage unavailable */ }
  renderGameOptions();
  renderRecordOptions();
  updateProjection();
}

// --- Projection fetch --------------------------------------------------------

async function updateProjection() {
  const seq = ++requestSeq;
  const picks = getSelectedPicks();
  const record = mode === 'record' ? recordSelect.value : null;
  const hasSelections = !!record || picks.some(Boolean);

  let query = `team=${encodeURIComponent(focalTeam.team)}&picks=${encodeURIComponent(JSON.stringify(picks))}`;
  if (record) query += `&record=${encodeURIComponent(record)}`;
  const res = await fetch(apiUrl('nhl', `impact_projection?${query}`));
  if (!res.ok || seq !== requestSeq) return;
  const json = await res.json();
  if (seq !== requestSeq) return;
  latestTeams = json.teams || [];

  const what = record ? `A ${record} record` : 'Combination of results';
  chanceBox.textContent = (hasSelections && json.matched_sims != null && json.total_sims != null)
    ? `${what} occurred in ${json.matched_sims.toLocaleString()} out of ${json.total_sims.toLocaleString()} simulations (${json.chance_of_selection}%)`
    : '';

  renderSpotlight();
  renderSeeding();
  renderStandings();
}

// --- Projected Playoff Seeding -----------------------------------------------

// Projected points first, then projected wins (proxy for the ROW tiebreaker,
// which the impact table doesn't carry), then playoff odds -- deterministic.
function compareByProjected(a, b, useBase) {
  const ma = useBase ? a.base : a.adjusted;
  const mb = useBase ? b.base : b.adjusted;
  const pd = (mb.exp_points ?? -1) - (ma.exp_points ?? -1);
  if (pd !== 0) return pd;
  const wd = (mb.exp_wins ?? -1) - (ma.exp_wins ?? -1);
  if (wd !== 0) return wd;
  return (mb.pct_playoffs ?? -1) - (ma.pct_playoffs ?? -1);
}

// Same qualification rule as nhl-rankings.js's computeProjectedSeedGroups:
// top 3 per division, then the 2 best remaining in the conference, then up
// to 3 "In the Hunt" teams with non-zero playoff odds.
function seedGroups(conf, useBase) {
  const cmp = (a, b) => compareByProjected(a, b, useBase);
  const metric = useBase ? 'base' : 'adjusted';
  const confTeams = latestTeams.filter(t => t.conference === conf);
  const divisions = [...new Set(confTeams.map(t => t.division))].sort();

  const divisionGroups = divisions.map(div => ({
    name: div,
    teams: confTeams.filter(t => t.division === div).sort(cmp).slice(0, 3),
  }));
  const divNames = new Set(divisionGroups.flatMap(g => g.teams.map(t => t.team)));
  const remaining = confTeams.filter(t => !divNames.has(t.team)).sort(cmp);
  const wildcards = remaining.slice(0, 2);
  const inTheHunt = remaining.slice(2).filter(t => (t[metric].pct_playoffs ?? 0) > 0).slice(0, 3);
  return { divisionGroups, wildcards, inTheHunt, remaining };
}

// Where a team sits in its conference's seeding: its slot label ("Atlantic
// 2", "Wild Card 1", "Outside") and its position in the full seed order
// (division slots, then everyone else by projected points).
function seedSlot(teamName, conf, useBase) {
  const groups = seedGroups(conf, useBase);
  const order = [...groups.divisionGroups.flatMap(g => g.teams), ...groups.remaining];
  const position = order.findIndex(t => t.team === teamName) + 1;
  for (const g of groups.divisionGroups) {
    const i = g.teams.findIndex(t => t.team === teamName);
    if (i >= 0) return { label: `${g.name} ${i + 1}`, inPlayoffs: true, position };
  }
  const wc = groups.wildcards.findIndex(t => t.team === teamName);
  if (wc >= 0) return { label: `Wild Card ${wc + 1}`, inPlayoffs: true, position };
  return { label: 'Outside Playoffs', inPlayoffs: false, position };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function spotlightStat(label, valueHtml, badge, style = '') {
  return `
    <div class="bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-2 text-center">
      <div class="text-[0.65rem] text-gray-400 uppercase tracking-wider">${label}</div>
      <div class="text-lg font-semibold font-mono" style="${style}">${valueHtml}</div>
      <div class="text-[0.7rem] leading-tight h-4">${badge || ''}</div>
    </div>`;
}

function renderSpotlight() {
  const t = latestTeams.find(isFocal);
  if (!t) { spotlight.innerHTML = ''; return; }

  const now = seedSlot(t.team, t.conference, false);
  const was = seedSlot(t.team, t.conference, true);
  const moved = rankChangeBadge(now.position, was.position);
  const slotColor = now.inPlayoffs ? 'text-green-400' : 'text-gray-400';
  const delta = key => (t.adjusted[key] != null && t.base[key] != null ? t.adjusted[key] - t.base[key] : null);
  const pct = key => spotlightStat(
    { pct_division_top3: 'Div Top-3', pct_playoffs: 'Playoffs', pct_cup: 'Win Cup' }[key],
    formatPercent(t.adjusted[key]), deltaBadge(delta(key)), probColor((t.adjusted[key] ?? 0) / 100));

  spotlight.innerHTML = `
    <div class="rounded-xl border border-amber-400/60 bg-amber-400/5 p-4 flex flex-col md:flex-row md:items-center gap-4">
      <div class="flex items-center gap-3 min-w-0 md:w-64 shrink-0">
        <img src="${nhlLogoUrl(t.team)}" alt="${t.team}" class="w-14 h-14 object-contain shrink-0" onerror="this.style.display='none'">
        <div class="min-w-0">
          <div class="text-lg font-bold text-amber-300 truncate">${t.team}</div>
          <div class="text-sm font-semibold ${slotColor}">${now.label}${moved}</div>
          <div class="text-xs text-gray-400">
            ${ordinal(now.position)} in ${t.conference}${was.label !== now.label ? ` &middot; was ${was.label}` : ''}
          </div>
        </div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 flex-1">
        ${spotlightStat('Proj. Points', t.adjusted.exp_points != null ? t.adjusted.exp_points.toFixed(1) : '—',
                        deltaBadge(delta('exp_points'), { suffix: '', threshold: 0.05 }))}
        ${spotlightStat('Proj. Record', formatRecord(t.adjusted), '')}
        ${pct('pct_playoffs')}
        ${pct('pct_division_top3')}
        ${pct('pct_cup')}
      </div>
    </div>`;
}

// Position key per team ("<group>:<rank>") in the no-picks baseline, so a
// team moving e.g. from Wild Card 2 into Atlantic 3 gets an arrow too: we
// compare overall seed order (division slots, then wild cards, then hunt).
function seedOrder(groups) {
  return [
    ...groups.divisionGroups.flatMap(g => g.teams),
    ...groups.wildcards,
    ...groups.inTheHunt,
  ];
}

function seedRowHtml(t, rank, overallRank, baseOverall) {
  const badge = rankChangeBadge(overallRank, baseOverall[t.team]);
  return `
    <tr${isFocal(t) ? ' class="bg-amber-400/10"' : ''}>
      <td class="text-center font-mono leading-tight">
        <div>${rank}</div>
        ${badge ? `<div class="text-[0.65rem] leading-tight">${badge}</div>` : ''}
      </td>
      ${teamCell(t)}
      ${pointsCell(t)}
      <td class="text-center font-mono">${formatRecord(t.adjusted)}</td>
      ${pctCell(t, 'pct_playoffs')}
      ${pctCell(t, 'pct_division_top3')}
    </tr>`;
}

function seedGroupHeaderHtml(label) {
  return `
    <tr>
      <td colspan="6" class="text-xs font-semibold text-gray-500 uppercase tracking-widest" style="padding-top:0.75rem;">${label}</td>
    </tr>`;
}

function renderSeedingTable(conf, tableId) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;

  const baseOverall = {};
  seedOrder(seedGroups(conf, true)).forEach((t, i) => { baseOverall[t.team] = i + 1; });

  const groups = seedGroups(conf, false);
  const overall = {};
  seedOrder(groups).forEach((t, i) => { overall[t.team] = i + 1; });

  const section = (label, teams) => teams.length
    ? seedGroupHeaderHtml(label) + teams.map((t, i) => seedRowHtml(t, i + 1, overall[t.team], baseOverall)).join('')
    : '';

  tbody.innerHTML =
    groups.divisionGroups.map(g => section(g.name, g.teams)).join('') +
    section('Wild Card', groups.wildcards) +
    section('In the Hunt', groups.inTheHunt);
}

function renderSeeding() {
  renderSeedingTable('Eastern', 'seeding-table-eastern');
  renderSeedingTable('Western', 'seeding-table-western');
}

// --- Standings, grouped per view-toggle --------------------------------------

// Division view ranks by avg_division_rank (unconditional: every team gets a
// division rank every trial). Conference/league views rank by projected
// points -- avg_conf_seed is only averaged over seeded trials, so it can
// mis-order teams (same trap nfl-impact-simulator.js documents).
function groupRank(teamsInGroup, useBase) {
  const cmp = view === 'division'
    ? (a, b) => {
        const av = (useBase ? a.base : a.adjusted).avg_division_rank;
        const bv = (useBase ? b.base : b.adjusted).avg_division_rank;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av - bv;
      }
    : (a, b) => compareByProjected(a, b, useBase);
  const sorted = [...teamsInGroup].sort(cmp);
  const rankByTeam = {};
  sorted.forEach((t, i) => { rankByTeam[t.team] = i + 1; });
  return { sorted, rankByTeam };
}

function rowHtml(t, currentRank, baseRankByTeam) {
  const cells = STANDINGS_COLUMNS.slice(4).map(c => pctCell(t, c.key)).join('');
  const badge = rankChangeBadge(currentRank, baseRankByTeam[t.team]);
  return `
    <tr>
      <td class="text-center text-gray-400 font-medium leading-tight">
        <div>${currentRank}</div>
        ${badge ? `<div class="text-[0.65rem] leading-tight">${badge}</div>` : ''}
      </td>
      ${teamCell(t)}
      ${pointsCell(t)}
      <td class="text-center font-mono">${formatRecord(t.adjusted)}</td>
      ${cells}
    </tr>`;
}

function groupTableHtml(teamsInGroup) {
  const { sorted } = groupRank(teamsInGroup, false);
  const { rankByTeam: baseRankByTeam } = groupRank(teamsInGroup, true);
  const rows = sorted.map((t, i) => rowHtml(t, i + 1, baseRankByTeam)).join('');
  return `
    <div class="overflow-x-auto">
      <table class="data-table data-table--compact">
        <thead><tr>${STANDINGS_COLUMNS.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderStandings() {
  if (view === 'league') {
    groupsContainer.innerHTML = groupTableHtml(latestTeams);
    return;
  }
  const groups = {};
  latestTeams.forEach(t => {
    const key = view === 'conference' ? t.conference : `${t.conference} — ${t.division}`;
    (groups[key] = groups[key] || []).push(t);
  });
  groupsContainer.innerHTML = Object.keys(groups).sort().map(key => `
    <div class="mb-6 last:mb-0">
      <h3 class="text-sm font-bold uppercase tracking-widest text-gray-400 mb-2">${key}</h3>
      ${groupTableHtml(groups[key])}
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

// --- Form wiring -------------------------------------------------------------

teamSelect.addEventListener('change', () => selectTeam(teamSelect.value));
form.addEventListener('change', () => updateProjection());
recordSelect.addEventListener('change', () => updateProjection());
document.querySelectorAll("input[name='sim-mode']").forEach(r => {
  r.addEventListener('change', () => { if (r.checked) setMode(r.value); });
});
// Interacting with the greyed-out section switches to that method.
recordSection.addEventListener('pointerdown', () => setMode('record'));
recordSection.addEventListener('focusin', () => setMode('record'));
gamesSection.addEventListener('pointerdown', () => setMode('games'));
gamesSection.addEventListener('focusin', () => setMode('games'));
// Fills every unpicked, unfinished game with a W/OTL/L drawn from that
// game's simulated odds (g.pct).
function simulateRemaining() {
  setMode('games', { refresh: false });
  focalTeam.games.forEach((g, i) => {
    if (g.finished || !g.pct) return;
    if (form.querySelector(`input[name='game-${i}']:checked`)) return;
    const total = OUTCOMES.reduce((sum, o) => sum + (g.pct[o] || 0), 0);
    if (!total) return;
    let r = Math.random() * total;
    const outcome = OUTCOMES.find(o => (r -= g.pct[o] || 0) < 0) || OUTCOMES[OUTCOMES.length - 1];
    const radio = form.querySelector(`input[name='game-${i}'][value='${outcome}']`);
    if (radio) radio.checked = true;
  });
  updateProjection();
}

form.addEventListener('click', (e) => {
  if (e.target.id === 'simulate-btn') {
    simulateRemaining();
    return;
  }
  if (e.target.id !== 'clear-btn') return;
  // Finished games stay locked to their real result.
  form.querySelectorAll("input[type='radio']:not(:disabled)").forEach(input => {
    input.checked = false;
  });
  updateProjection();
});

// --- Bootstrap ---------------------------------------------------------------

// The viewer's first NHL My Team, if they follow one; otherwise the last
// team picked here; otherwise the first team alphabetically.
function defaultTeam() {
  const mine = (getMyTeams().teams.nhl || [])
    .map(name => metaTeams.find(t => teamKey('nhl', t.team) === teamKey('nhl', name)))
    .find(Boolean);
  if (mine) return mine.team;
  try { return localStorage.getItem('nhl_impact_team'); } catch (e) { return null; }
}

async function loadSimulator() {
  setMode('games', { refresh: false });
  // Profile My Teams load alongside the meta, so signed-in picks are known in time.
  const [res] = await Promise.all([
    fetch(apiUrl('nhl', 'impact_meta')),
    loadMyTeams().catch(() => null),
  ]);
  if (!res.ok) {
    chanceBox.textContent = 'Impact simulation data is not available yet.';
    return;
  }
  const json = await res.json();
  metaTeams = json.teams || [];
  if (!metaTeams.length) return;
  if (dateBadge && json.as_of_date) dateBadge.textContent = `As of ${formatGameDate(json.as_of_date)}`;

  renderTeamOptions();
  selectTeam(defaultTeam());
}

loadSimulator();
