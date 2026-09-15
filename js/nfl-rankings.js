// nfl-rankings.js — drives nfl/pages/rankings.html
import { apiUrl } from './api-config.js';
import { rankChangeBadge, probColor, deltaBadge } from './rankings-shared.js';
import { nflLogoUrl } from './nfl-logos.js';
import { drawConferenceWheel, drawSuperBowlWheel, updateScatter } from './nfl-charts.js';

const weekBadge      = document.getElementById("week-badge");
const groupsContainer = document.getElementById("rankings-groups");
const btnLeague      = document.getElementById("btn-view-league");
const btnConference  = document.getElementById("btn-view-conference");
const btnDivision    = document.getElementById("btn-view-division");

let view = 'division'; // 'division' | 'conference' | 'league'
let currentRankings = [];
let prevRankByTeam = {};
let prevRowByTeam = {};

const COLUMNS = [
  { label: 'Rank' },
  { label: 'Team' },
  { label: 'Rating' },
  { label: 'Proj. Record' },
  { label: 'Playoffs',       key: 'percent_playoffs' },
  { label: 'Div Winner',     key: 'percent_division_winner' },
  { label: '1st-Rd Bye',     key: 'percent_first_round_bye' },
  { label: 'Div Round',      key: 'percent_divisional_round' },
  { label: 'Conf Champ Game', key: 'percent_conf_championship' },
  { label: 'Reach SB',       key: 'percent_super_bowl_appearance' },
  { label: 'Win SB',         key: 'percent_super_bowl_champion' },
];

function formatPercent(val) {
  if (val == null || isNaN(parseFloat(val))) return '—';
  return `${(parseFloat(val) * 100).toFixed(1)}%`;
}

// Percent fields are stored as fractions (0-1), so a delta is expressed in
// percentage points by scaling both sides up first - matches the convention
// nfl-impact-simulator.js's pctCell already established for deltaBadge().
function pctDelta(curr, prev) {
  if (curr == null || prev == null) return null;
  return parseFloat(curr) * 100 - parseFloat(prev) * 100;
}

// Value and its week-over-week delta badge stack vertically (value on top,
// badge in small text underneath) rather than sitting side by side, to keep
// each column narrow - same pattern as nfl-impact-simulator.js's pctCell.
function pctCell(val, prevVal) {
  const badge = deltaBadge(pctDelta(val, prevVal));
  return `
    <td class="text-center font-medium leading-tight" style="${probColor(val)}">
      <div>${formatPercent(val)}</div>
      ${badge ? `<div class="text-[0.65rem] leading-tight">${badge}</div>` : ''}
    </td>`;
}

function rowHtml(r) {
  const prevRow = prevRowByTeam[r.team];
  const wc = r.weekly_change;
  const formArrow = wc != null
    ? (wc > 0
        ? `<span style='color:#4ade80'>▲</span>${Math.abs(wc).toFixed(2)}`
        : wc < 0
          ? `<span style='color:#f87171'>▼</span>${Math.abs(wc).toFixed(2)}`
          : '')
    : '';
  const record = r.projected_wins != null && r.projected_losses != null
    ? `${Math.round(r.projected_wins)}-${Math.round(r.projected_losses)}${Math.round(r.projected_ties) > 0 ? `-${Math.round(r.projected_ties)}` : ''}`
    : '—';
  const rankBadge = rankChangeBadge(r.rank, prevRankByTeam[r.team]);
  const pctCols = COLUMNS.slice(4).map(c => pctCell(r[c.key], prevRow?.[c.key])).join('');

  return `
    <tr>
      <td class="text-center text-gray-400 font-medium leading-tight">
        <div>${r.rank}</div>
        ${rankBadge ? `<div class="text-[0.65rem] leading-tight">${rankBadge}</div>` : ''}
      </td>
      <td>
        <div class="flex items-center gap-2">
          <img src="${nflLogoUrl(r.team)}"
               alt="${r.team}" class="w-6 h-6 object-contain shrink-0"
               onerror="this.style.display='none'">
          <span>${r.team}</span>
        </div>
      </td>
      <td class="text-center font-mono leading-tight">
        <div>${Number(r.total_rating).toFixed(2)}</div>
        ${formArrow ? `<div class="text-[0.65rem] leading-tight">${formArrow}</div>` : ''}
      </td>
      <td class="text-center font-mono">${record}</td>
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
      <tbody>${rows.map(rowHtml).join('')}</tbody>
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

// Ordering for projected seeding: best projected record first, with
// tiebreakers falling back to more decimal-precise/independent signals
// (projected_seed is deliberately NOT used here - it's only averaged over
// the simulation trials where a team made the playoffs at all, so it isn't
// comparable across teams with different playoff odds).
function compareByProjectedRecord(a, b) {
  const wpA = a.extra.projected_win_pct ?? -1;
  const wpB = b.extra.projected_win_pct ?? -1;
  if (wpB !== wpA) return wpB - wpA;
  const winsA = a.extra.projected_wins ?? -1;
  const winsB = b.extra.projected_wins ?? -1;
  if (winsB !== winsA) return winsB - winsA;
  return (b.rating ?? -Infinity) - (a.rating ?? -Infinity);
}

// Builds the seeded (division leaders + wildcards) and "in the hunt" lists
// for a conference from a given week's extra-stats map, so the exact same
// ordering logic can be replayed against last week's snapshot to derive
// week-over-week position badges below.
function computeSeedOrder(conf, extraByTeam) {
  const confTeams = currentRankings
    .filter(r => r.conference === conf)
    .map(r => ({ team: r.team, division: r.division, rating: r.total_rating, extra: extraByTeam[r.team] }))
    .filter(x => x.extra && x.extra.projected_win_pct != null);

  // Seeds 1-4: the team with the best projected record in each division.
  const bestInDivision = {};
  confTeams.forEach(x => {
    const cur = bestInDivision[x.division];
    if (!cur || compareByProjectedRecord(x, cur) < 0) bestInDivision[x.division] = x;
  });
  const divisionLeaders = Object.values(bestInDivision).sort(compareByProjectedRecord);
  const divisionLeaderTeams = new Set(divisionLeaders.map(x => x.team));

  // Seeds 5-7: the rest of the conference, by best projected record.
  const wildcards = confTeams
    .filter(x => !divisionLeaderTeams.has(x.team))
    .sort(compareByProjectedRecord)
    .slice(0, 3);

  const seededTeams = [...divisionLeaders, ...wildcards];
  const seededTeamNames = new Set(seededTeams.map(x => x.team));

  // Next up to 3 teams still mathematically alive (playoff odds > 0), shown
  // below a divider as context for who's just outside the playoff picture.
  // Late in the season this can shrink to fewer than 3, or none at all, once
  // teams are mathematically eliminated.
  const inTheHunt = confTeams
    .filter(x => !seededTeamNames.has(x.team))
    .filter(x => (x.extra.percent_playoffs ?? 0) > 0)
    .sort(compareByProjectedRecord)
    .slice(0, 3);

  return { seededTeams, inTheHunt };
}

async function loadSeedingTable(conf, tableId) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  const teamExtra = {};
  (window.__nflProjectedStandings?.teams || []).forEach(t => { teamExtra[t.team] = t; });
  const prevTeamExtra = {};
  (window.__nflProjectedStandingsPrev?.teams || []).forEach(t => { prevTeamExtra[t.team] = t; });

  const { seededTeams, inTheHunt } = computeSeedOrder(conf, teamExtra);

  // Replay the same seeding logic against last week's snapshot to get each
  // team's previous position (seeded or in-the-hunt alike), for the arrow.
  const prevPositionByTeam = {};
  if (Object.keys(prevTeamExtra).length) {
    const prevOrder = computeSeedOrder(conf, prevTeamExtra);
    [...prevOrder.seededTeams, ...prevOrder.inTheHunt].forEach((x, i) => { prevPositionByTeam[x.team] = i + 1; });
  }

  function seedRow(x, rank) {
    const e = x.extra;
    const prevE = prevTeamExtra[x.team];
    const record  = e.projected_wins != null && e.projected_losses != null
      ? `${Math.round(e.projected_wins)}-${Math.round(e.projected_losses)}${Math.round(e.projected_ties) > 0 ? `-${Math.round(e.projected_ties)}` : ''}`
      : '—';
    const rankBadge = rankChangeBadge(rank, prevPositionByTeam[x.team]);
    return `
      <tr>
        <td class="text-center font-mono leading-tight">
          <div>${rank}</div>
          ${rankBadge ? `<div class="text-[0.65rem] leading-tight">${rankBadge}</div>` : ''}
        </td>
        <td>
          <div class="flex items-center gap-2">
            <img src="${nflLogoUrl(x.team)}" alt="${x.team}" class="w-6 h-6 object-contain shrink-0" onerror="this.style.display='none'">
            <span>${x.team}</span>
          </div>
        </td>
        <td class="text-center font-mono">${record}</td>
        ${pctCell(e.percent_first_round_bye, prevE?.percent_first_round_bye)}
        ${pctCell(e.percent_division_winner, prevE?.percent_division_winner)}
        ${pctCell(e.percent_playoffs, prevE?.percent_playoffs)}
      </tr>
    `;
  }

  const seededRows = seededTeams.map((x, i) => seedRow(x, i + 1)).join('');

  const huntDivider = inTheHunt.length ? `
    <tr>
      <td colspan="6" class="text-center text-xs font-semibold text-gray-500 uppercase tracking-widest" style="border-top:2px solid var(--border-default); padding-top:0.75rem;">In the Hunt</td>
    </tr>
  ` : '';
  const huntRows = inTheHunt.map((x, i) => seedRow(x, seededTeams.length + i + 1)).join('');

  tbody.innerHTML = seededRows + huntDivider + huntRows;
}

async function loadProjectedStandings() {
  try {
    const res = await fetch(apiUrl('nfl', 'projected_standings'));
    if (!res.ok) return;
    const json = await res.json();
    window.__nflProjectedStandings = json.data || {};
    const weekNumber = json.week_number;

    window.__nflProjectedStandingsPrev = null;
    if (weekNumber > 1) {
      try {
        const prevRes = await fetch(apiUrl('nfl', `projected_standings?week=${weekNumber - 1}`));
        if (prevRes.ok) {
          const prevJson = await prevRes.json();
          window.__nflProjectedStandingsPrev = prevJson.data || {};
        }
      } catch (e) { /* previous week snapshot may not exist yet, non-fatal */ }
    }

    loadSeedingTable('AFC', 'seeding-table-afc');
    loadSeedingTable('NFC', 'seeding-table-nfc');
  } catch (e) { /* non-fatal — seeding table just stays empty */ }
}

async function loadRankings() {
  const res = await fetch(apiUrl('nfl', 'power_rankings'));
  if (!res.ok) return;
  const json = await res.json();

  currentRankings = json.rankings || [];
  const weekNumber = json.week_number;

  if (weekBadge && weekNumber != null) weekBadge.textContent = `Week ${weekNumber}`;

  prevRankByTeam = {};
  prevRowByTeam = {};
  if (weekNumber > 1) {
    try {
      const prevRes = await fetch(apiUrl('nfl', `power_rankings?week=${weekNumber - 1}`));
      if (prevRes.ok) {
        const prevJson = await prevRes.json();
        (prevJson.rankings || []).forEach(r => {
          prevRankByTeam[r.team] = r.rank;
          prevRowByTeam[r.team] = r;
        });
      }
    } catch (e) { /* previous week may not exist yet, non-fatal */ }
  }

  render();

  drawConferenceWheel(currentRankings, 'AFC', 'afcWheel');
  drawConferenceWheel(currentRankings, 'NFC', 'nfcWheel');
  drawSuperBowlWheel(currentRankings, 'superBowlWheel');
  updateScatter(currentRankings);

  // Seeding table needs both the rankings (for records) and the snapshot data.
  if (window.__nflProjectedStandings) {
    loadSeedingTable('AFC', 'seeding-table-afc');
    loadSeedingTable('NFC', 'seeding-table-nfc');
  }
}

loadRankings();
loadProjectedStandings();
