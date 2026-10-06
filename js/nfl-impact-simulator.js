// nfl-impact-simulator.js — drives nfl/pages/simulator.html
//
// Unlike NRL's impact-simulator.js (which fetches whole round_snapshot blobs
// and filters/aggregates client-side), NFL's ext_impacts_* data is too large
// per-team to ship to the browser, so all combo-filtering and weighted
// averaging happens server-side via /api/nfl/impact_meta + /impact_projection.
// This file only renders whatever the backend already computed.

import { apiUrl } from './api-config.js';
import { probColor, rankChangeBadge, deltaBadge } from './rankings-shared.js';
import { nflLogoUrl } from './nfl-logos.js';
import { teamSlug } from './utils.js';
import { rankNflTeams, seedNflConference } from './nfl-seeding.js';

const form            = document.getElementById('simulation-form');
const weekBadge       = document.getElementById('week-badge');
const chanceBox       = document.getElementById('selection-chance');
const groupsContainer = document.getElementById('rankings-groups');
const btnLeague       = document.getElementById('btn-view-league');
const btnConference   = document.getElementById('btn-view-conference');
const btnDivision     = document.getElementById('btn-view-division');

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
];

let view = 'division'; // 'division' | 'conference' | 'league'
let currentWeekNumber = null;
let matches = [];      // [{home_team, away_team, home_perc, away_perc}], same order as the backend's `matches`
let weekGames = [];    // /week_predictions `predictions` for this week
let latestTeams = [];  // last /impact_projection response's `teams` array

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

// --- Match selection form ---------------------------------------------------

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

// --- Projection fetch --------------------------------------------------------

async function updateProjection() {
  const picks = getSelectedPicks();
  const hasSelections = picks.some(Boolean);

  const url = apiUrl('nfl', `impact_projection?week=${currentWeekNumber}&picks=${encodeURIComponent(JSON.stringify(picks))}`);
  const res = await fetch(url);
  if (!res.ok) return;
  const json = await res.json();
  latestTeams = json.teams || [];

  chanceBox.textContent = (hasSelections && json.matched_sims != null && json.total_sims != null)
    ? `Combination of selections occurred in ${json.matched_sims} out of ${json.total_sims} simulations`
    : '';

  renderSeeding();
  renderStandings();
}

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
      <td>
        <div class="flex items-center gap-2">
          <img src="${nflLogoUrl(t.team)}" alt="${t.team}" class="w-6 h-6 object-contain shrink-0" onerror="this.style.display='none'">
          <span>${t.team}</span>
        </div>
      </td>
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
  const cells = STANDINGS_COLUMNS.slice(3).map(c => pctCell(t, c.key)).join('');
  const badge = rankChangeBadge(currentRank, baseRankByTeam[t.team]);
  return `
    <tr>
      <td class="text-center text-gray-400 font-medium leading-tight">
        <div>${currentRank}</div>
        ${badge ? `<div class="text-[0.65rem] leading-tight">${badge}</div>` : ''}
      </td>
      <td>
        <div class="flex items-center gap-2">
          <img src="${nflLogoUrl(t.team)}" alt="${t.team}" class="w-6 h-6 object-contain shrink-0" onerror="this.style.display='none'">
          <span>${t.team}</span>
        </div>
      </td>
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

// --- Form wiring -------------------------------------------------------------

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
