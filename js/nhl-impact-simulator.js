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

import { apiUrl } from './api-config.js';
import { probColor, rankChangeBadge, deltaBadge } from './rankings-shared.js';
import { nhlLogoUrl } from './nhl-logos.js';

const form            = document.getElementById('simulation-form');
const teamSelect      = document.getElementById('team-select');
const dateBadge       = document.getElementById('week-badge');
const chanceBox       = document.getElementById('selection-chance');
const groupsContainer = document.getElementById('rankings-groups');
const btnLeague       = document.getElementById('btn-view-league');
const btnConference   = document.getElementById('btn-view-conference');
const btnDivision     = document.getElementById('btn-view-division');

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

function teamCell(t) {
  const highlight = focalTeam && t.team === focalTeam.team ? ' text-amber-300 font-semibold' : '';
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
  form.innerHTML = `<button id="clear-btn" type="button" class="mb-4 px-3 py-1 text-sm text-white bg-red-500 rounded hover:bg-red-600">Clear All</button>`;
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
      return `
        <label class="flex-1">
          <input type="radio" name="game-${i}" value="${o}" class="peer sr-only" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
          <span class="block text-center rounded px-2 py-1 border border-gray-500 ${cls}">${o}</span>
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

function getSelectedPicks() {
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
  updateProjection();
}

// --- Projection fetch --------------------------------------------------------

async function updateProjection() {
  const seq = ++requestSeq;
  const picks = getSelectedPicks();
  const hasSelections = picks.some(Boolean);

  const url = apiUrl('nhl', `impact_projection?team=${encodeURIComponent(focalTeam.team)}&picks=${encodeURIComponent(JSON.stringify(picks))}`);
  const res = await fetch(url);
  if (!res.ok || seq !== requestSeq) return;
  const json = await res.json();
  if (seq !== requestSeq) return;
  latestTeams = json.teams || [];

  chanceBox.textContent = (hasSelections && json.matched_sims != null && json.total_sims != null)
    ? `Combination of results occurred in ${json.matched_sims.toLocaleString()} out of ${json.total_sims.toLocaleString()} simulations (${json.chance_of_selection}%)`
    : '';

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
  return { divisionGroups, wildcards, inTheHunt };
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
    <tr>
      <td class="text-center font-mono leading-tight">
        <div>${rank}</div>
        ${badge ? `<div class="text-[0.65rem] leading-tight">${badge}</div>` : ''}
      </td>
      ${teamCell(t)}
      ${pointsCell(t)}
      <td class="text-center font-mono">${formatRecord(t.adjusted)}</td>
      ${pctCell(t, 'pct_division_top3')}
      ${pctCell(t, 'pct_playoffs')}
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
form.addEventListener('click', (e) => {
  if (e.target.id !== 'clear-btn') return;
  // Finished games stay locked to their real result.
  form.querySelectorAll("input[type='radio']:not(:disabled)").forEach(input => {
    input.checked = false;
  });
  updateProjection();
});

// --- Bootstrap ---------------------------------------------------------------

async function loadSimulator() {
  const res = await fetch(apiUrl('nhl', 'impact_meta'));
  if (!res.ok) {
    chanceBox.textContent = 'Impact simulation data is not available yet.';
    return;
  }
  const json = await res.json();
  metaTeams = json.teams || [];
  if (!metaTeams.length) return;
  if (dateBadge && json.as_of_date) dateBadge.textContent = `As of ${formatGameDate(json.as_of_date)}`;

  renderTeamOptions();
  let saved = null;
  try { saved = localStorage.getItem('nhl_impact_team'); } catch (e) { /* storage unavailable */ }
  selectTeam(saved);
}

loadSimulator();
