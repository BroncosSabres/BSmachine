// main.js
import { updateChart, updateScatter, formatDecimal, formatPercent } from './charts.js';
import { teamSlug } from './utils.js';

const ladderTable   = document.querySelector("#ladder-table tbody");
const rankingsTable = document.querySelector("#rankings-table tbody");
const chartDropdown = document.getElementById("chart-select");

const BACKEND = 'https://bsmachine-backend.onrender.com/api';

let resultsData = [];

// Colour a probability cell from red → yellow → green
function probColor(val) {
  const p = parseFloat(val);
  if (isNaN(p)) return '';
  if (p >= 0.8)  return 'color:#4ade80';  // green
  if (p >= 0.5)  return 'color:#a3e635';  // lime
  if (p >= 0.2)  return 'color:#facc15';  // yellow
  if (p > 0)     return 'color:#fb923c';  // orange
  return 'color:#6b7280';                 // gray (0%)
}

// Spoon: inverse — high prob is bad
function spoonColor(val) {
  const p = parseFloat(val);
  if (isNaN(p)) return '';
  if (p >= 0.2)  return 'color:#f87171';  // red
  if (p > 0)     return 'color:#fb923c';  // orange
  return 'color:#6b7280';
}

// Form badge: coloured arrow + value
function formBadge(form) {
  const f = parseFloat(form ?? 0);
  const sign  = f > 0 ? '▲' : f < 0 ? '▼' : '—';
  const color = f > 0 ? '#4ade80' : f < 0 ? '#f87171' : '#6b7280';
  return `<span style="color:${color};font-weight:600">${sign} ${Math.abs(f).toFixed(2)}</span>`;
}

// Rank change badge: positive delta = moved up (smaller rank number)
function rankChangeBadge(current, prev) {
  if (prev == null) return '';
  const delta = prev - current;
  if (delta > 0) return `<span style="color:#4ade80;font-size:0.7rem;font-weight:600;margin-left:3px">▲${delta}</span>`;
  if (delta < 0) return `<span style="color:#f87171;font-size:0.7rem;font-weight:600;margin-left:3px">▼${Math.abs(delta)}</span>`;
  return `<span style="color:#6b7280;font-size:0.7rem;margin-left:3px">—</span>`;
}


(async () => {
  // Single request: current + previous round rankings and ladders in one call
  const res = await fetch(`${BACKEND}/power_rankings_with_prev/nrl`);
  if (!res.ok) return;
  const json = await res.json();

  const rankings    = json.rankings || [];
  const roundNumber = json.round_number;
  const ladderData  = json.ladder   || [];

  // Update round badge
  const badge = document.getElementById('round-badge');
  if (badge && roundNumber != null) badge.textContent = `Round ${roundNumber}`;

  // Build prev-round lookup maps from the bundled previous-round data
  let prevData = {}, prevRankByTeam = {}, prevLadderRankByTeam = {};
  (json.prev_rankings || []).forEach(r => {
    prevRankByTeam[r.team] = r.rank;
    prevData[r.team] = {
      'Top 8':          r.percent_top8,
      'Top 4':          r.percent_top4,
      'Minor Premiers': r.percent_minor_premiers,
      'Premiers':       r.percent_premiers,
      'Spoon':          r.percent_wooden_spoon,
    };
  });
  (json.prev_ladder || []).forEach(row => {
    prevLadderRankByTeam[row.team] = row.rank;
  });

  // Render projected ladder
  if (ladderData.length) {
    ladderData.forEach((row, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="text-center text-gray-400 font-medium">
          ${row.rank ?? i + 1}${rankChangeBadge(row.rank ?? i + 1, prevLadderRankByTeam[row.team])}
        </td>
        <td>
          <div class="flex items-center gap-2">
            <img src="../logos/${teamSlug(row.team)}.svg"
                 alt="${row.team}" class="w-6 h-6 object-contain shrink-0"
                 onerror="this.style.display='none'">
            <span>${row.team}</span>
          </div>
        </td>
        <td class="text-center font-mono">${row.wins ?? ''}</td>
        <td class="text-center font-mono">${row.losses ?? ''}</td>
        <td class="text-center font-mono">${row.pd ?? ''}</td>
        <td class="text-center font-mono">${row.pfor ?? ''}</td>
        <td class="text-center font-mono">${row.pagainst ?? ''}</td>
      `;
      ladderTable.appendChild(tr);
    });
  }

  // Build resultsData in a shape compatible with updateChart / updateScatter
  resultsData = rankings.map(r => ({
    'Rank':              r.rank,
    'Team':              r.team,
    'Total Rating':      r.total_rating,
    'Offensive Rating':  r.off_rating,
    'Defensive Rating':  r.def_rating,
    'form':              r.form,
    'Top 8':             r.percent_top8,
    'Top 4':             r.percent_top4,
    'Minor Premiers':    r.percent_minor_premiers,
    'Premiers':          r.percent_premiers,
    'Spoon':             r.percent_wooden_spoon,
    'W':                 r.wins,
    'L':                 r.losses,
    'D':                 r.draws,
  }));

  // Render power rankings table
  rankings.forEach(r => {
    const wc = r.weekly_change;
    const formArrow = wc != null
      ? (wc > 0
          ? `<span style='color:#4ade80'>▲</span>${Math.abs(wc).toFixed(2)}`
          : wc < 0
            ? `<span style='color:#f87171'>▼</span>${Math.abs(wc).toFixed(2)}`
            : '')
      : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-center text-gray-400 font-medium">
        ${r.rank}${rankChangeBadge(r.rank, prevRankByTeam[r.team])}
      </td>
      <td>
        <div class="flex items-center gap-2">
          <img src="../logos/${teamSlug(r.team)}.svg"
               alt="${r.team}" class="w-6 h-6 object-contain shrink-0"
               onerror="this.style.display='none'">
          <span>${r.team}</span>
        </div>
      </td>
      <td class="text-center font-mono">${formatDecimal(r.total_rating)} ${formArrow}</td>
      <td class="text-center">${formBadge(r.form)}</td>
      <td class="text-center font-medium" style="${probColor(r.percent_top8)}">${formatPercent(r.percent_top8)}</td>
      <td class="text-center font-medium" style="${probColor(r.percent_top4)}">${formatPercent(r.percent_top4)}</td>
      <td class="text-center font-medium" style="${probColor(r.percent_minor_premiers)}">${formatPercent(r.percent_minor_premiers)}</td>
      <td class="text-center font-medium" style="${probColor(r.percent_premiers)}">${formatPercent(r.percent_premiers)}</td>
      <td class="text-center font-medium" style="${spoonColor(r.percent_wooden_spoon)}">${formatPercent(r.percent_wooden_spoon)}</td>
    `;
    rankingsTable.appendChild(tr);
  });

  updateChart(resultsData, 'Top 8', prevData);
  updateScatter(resultsData);

  chartDropdown.addEventListener('change', (e) => {
    updateChart(resultsData, e.target.value, prevData);
  });
})();
