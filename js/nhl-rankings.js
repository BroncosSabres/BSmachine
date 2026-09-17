// nhl-rankings.js — drives nhl/pages/rankings.html
// Structurally a port of nfl-rankings.js, adapted for NHL's schema: rankings
// are snapshotted by as_of_date (not week_number), records are W-L-OTL (not
// W-L-T), and playoff seeding is computed client-side from each team's
// PROJECTED end-of-season points (nhl.team_season_predictions.projected_points,
// via /api/nhl/power_rankings) - the same "sort by the simulated outcome, not
// today's real standings" approach nfl-rankings.js's computeSeedOrder uses -
// rather than from the REAL current standings the projected_standings
// snapshot's conference_seeds/divisions blobs hold (those reflect
// nhl_tiebreakers.py's real-record seeding, which is a different question:
// "who would make the playoffs today," not "who's projected to."). The
// seeding table itself is split into a section per division plus a Wild Card
// section (matching the real NHL playoff bracket's qualification structure),
// each row showing the actual projected points total so the ranking is
// legible instead of implied by row order alone.
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

function projRecordStr(r) {
  if (r.projected_wins == null) return '—';
  const wins = Math.round(r.projected_wins);
  const rl   = Math.round(r.projected_regulation_losses ?? 0);
  const otso = Math.round(r.projected_ot_so_losses ?? 0);
  return `${wins}-${rl}-${otso}`;
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

// Cascading comparator for ranking teams by PROJECTED outcome: primary key is
// projected end-of-season points; ties (rare with simulated floats, but
// possible) fall back to projected ROW (regulation + OT wins, the NHL's own
// first real tiebreaker once points are equal - "games played" isn't a
// useful tiebreaker here since every team's projection covers a full
// 82-game season), then current rating, for a fully deterministic order.
function compareByProjected(a, b) {
  const ppA = a.projected_points ?? -1;
  const ppB = b.projected_points ?? -1;
  if (ppB !== ppA) return ppB - ppA;
  const rowA = a.projected_row ?? -1;
  const rowB = b.projected_row ?? -1;
  if (rowB !== rowA) return rowB - rowA;
  return (b.total_rating ?? -Infinity) - (a.total_rating ?? -Infinity);
}

// Reproduces nhl_tiebreakers.py's qualification rule (top 3 of each division
// qualify directly, next 2 best in the conference fill the wild card spots)
// but driven by PROJECTED points instead of real current standings -
// answering "who's projected to make the playoffs," not "who would make it
// if the season ended today." Grouped by real division name (not an abstract
// "A"/"B" bracket label) since the table displays each division separately,
// same as the actual NHL playoff picture.
function computeProjectedSeedGroups(conf) {
  const confTeams = currentRankings.filter(r => r.conference === conf && r.projected_points != null);
  const divisions = [...new Set(confTeams.map(r => r.division))].sort();

  const divisionGroups = divisions.map(div => ({
    name: div,
    teams: confTeams.filter(r => r.division === div).sort(compareByProjected).slice(0, 3),
  }));

  const divisionTeamNames = new Set(divisionGroups.flatMap(g => g.teams.map(t => t.team)));
  const remaining = confTeams
    .filter(t => !divisionTeamNames.has(t.team))
    .sort(compareByProjected);

  const wildcards = remaining.slice(0, 2);

  // Next-best teams still mathematically alive for a wild card spot, shown
  // below a divider as context for how close the race is - same "In the
  // Hunt" convention nfl-rankings.js's computeSeedOrder uses. Filtered to
  // percent_playoffs > 0 since late in the season this can shrink to fewer
  // than 3 teams, or none at all, once teams are mathematically eliminated.
  const inTheHunt = remaining
    .slice(2)
    .filter(t => (t.percent_playoffs ?? 0) > 0)
    .slice(0, 3);

  return { divisionGroups, wildcards, inTheHunt };
}

function pointsStr(t) {
  return t.projected_points != null ? t.projected_points.toFixed(1) : '—';
}

function seedRowHtml(t, rank) {
  return `
    <tr>
      <td class="text-center font-mono">${rank}</td>
      <td>
        <div class="flex items-center gap-2">
          <img src="${nhlLogoUrl(t.team)}" alt="${t.team}" class="w-6 h-6 object-contain shrink-0" onerror="this.style.display='none'">
          <span>${t.team}</span>
        </div>
      </td>
      <td class="text-center font-mono">${pointsStr(t)}</td>
      <td class="text-center font-mono">${projRecordStr(t)}</td>
      ${pctCell(t.percent_division_top3)}
      ${pctCell(t.percent_playoffs)}
    </tr>
  `;
}

function seedGroupHeaderHtml(label) {
  return `
    <tr>
      <td colspan="6" class="text-xs font-semibold text-gray-500 uppercase tracking-widest" style="padding-top:0.75rem;">${label}</td>
    </tr>
  `;
}

function loadSeedingTable(conf, tableId) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;

  const { divisionGroups, wildcards, inTheHunt } = computeProjectedSeedGroups(conf);

  let html = '';
  divisionGroups.forEach(g => {
    html += seedGroupHeaderHtml(g.name);
    html += g.teams.map((t, i) => seedRowHtml(t, i + 1)).join('');
  });
  if (wildcards.length) {
    html += seedGroupHeaderHtml('Wild Card');
    html += wildcards.map((t, i) => seedRowHtml(t, i + 1)).join('');
  }
  if (inTheHunt.length) {
    html += seedGroupHeaderHtml('In the Hunt');
    html += inTheHunt.map((t, i) => seedRowHtml(t, i + 1)).join('');
  }

  tbody.innerHTML = html;
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

  loadSeedingTable('Eastern', 'seeding-table-eastern');
  loadSeedingTable('Western', 'seeding-table-western');
}

loadRankings();
