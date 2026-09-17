// nhl-rankings.js — drives nhl/pages/rankings.html
// Structurally a port of nfl-rankings.js, adapted for NHL's schema: rankings
// are snapshotted by as_of_date (not week_number), records are W-L-OTL (not
// W-L-T), and playoff seeding comes straight from the REAL current
// division/conference standings written into the projected_standings
// snapshot (nhl_tiebreakers.py) rather than being sorted client-side from
// simulated win percentages the way NFL's seeding table is.
import { apiUrl } from './api-config.js';
import { probColor } from './rankings-shared.js';
import { nhlLogoUrl } from './nhl-logos.js';
import { drawConferenceWheel, drawStanleyCupWheel, updateScatter } from './nhl-charts.js';

const dateBadge        = document.getElementById("week-badge");
const groupsContainer  = document.getElementById("rankings-groups");
const btnLeague        = document.getElementById("btn-view-league");
const btnConference    = document.getElementById("btn-view-conference");
const btnDivision      = document.getElementById("btn-view-division");

let view = 'division'; // 'division' | 'conference' | 'league'
let currentRankings = [];

// Seed labels in division-rank-then-wildcard display order (bracket pairing
// itself, e.g. A1 vs WC2, is handled server-side by nhl_tiebreakers.py - this
// is purely a display order for the seeding table).
const SEED_LABELS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'WC1', 'WC2'];

const COLUMNS = [
  { label: 'Rank' },
  { label: 'Team' },
  { label: 'Rating' },
  { label: 'Record' },
  { label: 'Playoffs',      key: 'percent_playoffs' },
  { label: 'Div Top-3',     key: 'percent_division_top3' },
  { label: '2nd Round',     key: 'percent_second_round' },
  { label: 'Conf Final',    key: 'percent_conf_final' },
  { label: 'Reach SCF',     key: 'percent_scf_appearance' },
  { label: 'Win SCF',       key: 'percent_stanley_cup_champion' },
];

function formatPercent(val) {
  if (val == null || isNaN(parseFloat(val))) return '—';
  return `${(parseFloat(val) * 100).toFixed(1)}%`;
}

function pctCell(val) {
  return `<td class="text-center font-medium" style="${probColor(val)}">${formatPercent(val)}</td>`;
}

function recordStr(r) {
  if (r.reg_wins == null) return '—';
  const wins = (r.reg_wins || 0) + (r.ot_wins || 0) + (r.so_wins || 0);
  const otso = (r.ot_losses || 0) + (r.so_losses || 0);
  return `${wins}-${r.reg_losses || 0}-${otso}`;
}

function formArrow(r) {
  const wc = r.weekly_change;
  if (wc == null) return '';
  if (wc > 0) return `<span style='color:#4ade80'>▲</span>${Math.abs(wc).toFixed(2)}`;
  if (wc < 0) return `<span style='color:#f87171'>▼</span>${Math.abs(wc).toFixed(2)}`;
  return '';
}

function rowHtml(r, rank) {
  const pctCols = COLUMNS.slice(4).map(c => pctCell(r[c.key])).join('');
  return `
    <tr>
      <td class="text-center text-gray-400 font-medium">${rank}</td>
      <td>
        <div class="flex items-center gap-2">
          <img src="${nhlLogoUrl(r.team)}"
               alt="${r.team}" class="w-6 h-6 object-contain shrink-0"
               onerror="this.style.display='none'">
          <span>${r.team}</span>
        </div>
      </td>
      <td class="text-center font-mono leading-tight">
        <div>${Number(r.total_rating).toFixed(2)}</div>
        <div class="text-[0.65rem] leading-tight">${formArrow(r)}</div>
      </td>
      <td class="text-center font-mono">${recordStr(r)}</td>
      ${pctCols}
    </tr>
  `;
}

function tableHtml(rows) {
  return `
    <table class="data-table data-table--compact">
      <thead>
        <tr>${COLUMNS.map(c => `<th>${c.label}</th>`).join('')}</tr>
      </thead>
      <tbody>${rows.map((r, i) => rowHtml(r, i + 1)).join('')}</tbody>
    </table>
  `;
}

function render() {
  if (view === 'league') {
    groupsContainer.innerHTML = `<div class="overflow-x-auto">${tableHtml(currentRankings)}</div>`;
    return;
  }

  const groups = {};
  currentRankings.forEach(r => {
    const key = view === 'conference' ? r.conference : `${r.conference} ${r.division}`;
    (groups[key] = groups[key] || []).push(r);
  });

  groupsContainer.innerHTML = Object.keys(groups).sort().map(key => `
    <div class="mb-6 last:mb-0">
      <h3 class="text-sm font-bold uppercase tracking-widest text-gray-400 mb-2">${key}</h3>
      <div class="overflow-x-auto">${tableHtml(groups[key])}</div>
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
  render();
}

btnLeague.addEventListener('click', () => setView('league'));
btnConference.addEventListener('click', () => setView('conference'));
btnDivision.addEventListener('click', () => setView('division'));

function loadSeedingTable(conf, tableId) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  const snapshot = window.__nhlProjectedStandings;
  if (!tbody || !snapshot) return;

  const confSeeds = snapshot.conference_seeds?.[conf];
  if (!confSeeds || !confSeeds.seeds) { tbody.innerHTML = ''; return; }

  // Real current record for each team, from the division standings the
  // snapshot already computed (nhl_tiebreakers.py) - not simulated.
  const recordByTeam = {};
  Object.values(snapshot.divisions || {}).forEach(rows => {
    (rows || []).forEach(r => { recordByTeam[r.team] = r; });
  });
  const rankingByTeam = {};
  currentRankings.forEach(r => { rankingByTeam[r.team] = r; });

  const seededTeams = SEED_LABELS
    .map(label => confSeeds.seeds[label])
    .filter(Boolean);

  tbody.innerHTML = seededTeams.map((team, i) => {
    const rec = recordByTeam[team];
    const rk  = rankingByTeam[team];
    return `
      <tr>
        <td class="text-center font-mono">${i + 1}</td>
        <td>
          <div class="flex items-center gap-2">
            <img src="${nhlLogoUrl(team)}" alt="${team}" class="w-6 h-6 object-contain shrink-0" onerror="this.style.display='none'">
            <span>${team}</span>
          </div>
        </td>
        <td class="text-center font-mono">${rec ? recordStr(rec) : '—'}</td>
        ${pctCell(rk?.percent_division_top3)}
        ${pctCell(rk?.percent_playoffs)}
      </tr>
    `;
  }).join('');
}

async function loadProjectedStandings() {
  try {
    const res = await fetch(apiUrl('nhl', 'projected_standings'));
    if (!res.ok) return;
    const json = await res.json();
    window.__nhlProjectedStandings = json.data || {};

    loadSeedingTable('Eastern', 'seeding-table-eastern');
    loadSeedingTable('Western', 'seeding-table-western');
  } catch (e) { /* non-fatal — seeding table just stays empty */ }
}

async function loadRankings() {
  const res = await fetch(apiUrl('nhl', 'power_rankings'));
  if (!res.ok) return;
  const json = await res.json();

  currentRankings = json.rankings || [];
  if (dateBadge && json.as_of_date) {
    dateBadge.textContent = new Date(json.as_of_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  render();

  drawConferenceWheel(currentRankings, 'Eastern', 'easternWheel');
  drawConferenceWheel(currentRankings, 'Western', 'westernWheel');
  drawStanleyCupWheel(currentRankings, 'stanleyCupWheel');
  updateScatter(currentRankings);

  if (window.__nhlProjectedStandings) {
    loadSeedingTable('Eastern', 'seeding-table-eastern');
    loadSeedingTable('Western', 'seeding-table-western');
  }
}

loadRankings();
loadProjectedStandings();
