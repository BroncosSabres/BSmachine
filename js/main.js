// main.js
import { updateChart, updateScatter, formatDecimal, formatPercent } from './charts.js';

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

// Map full DB team names to site short names (for logo paths)
function teamSlug(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('broncos'))                              return 'broncos';
  if (n.includes('raiders'))                              return 'raiders';
  if (n.includes('bulldogs'))                             return 'bulldogs';
  if (n.includes('sharks'))                               return 'sharks';
  if (n.includes('dolphins'))                             return 'dolphins';
  if (n.includes('titans'))                               return 'titans';
  if (n.includes('sea eagles') || n.includes('manly'))    return 'manly';
  if (n.includes('storm'))                                return 'storm';
  if (n.includes('knights'))                              return 'knights';
  if (n.includes('cowboys'))                              return 'cowboys';
  if (n.includes('eels') || n.includes('parramatta'))     return 'eels';
  if (n.includes('panthers'))                             return 'panthers';
  if (n.includes('rabbitohs'))                            return 'rabbitohs';
  if (n.includes('dragons'))                              return 'dragons';
  if (n.includes('roosters'))                             return 'roosters';
  if (n.includes('warriors'))                             return 'warriors';
  if (n.includes('tigers'))                               return 'tigers';
  return n.replace(/\s+/g, '_');
}

(async () => {
  const res = await fetch(`${BACKEND}/power_rankings/nrl`);
  if (!res.ok) return;
  const json = await res.json();
  const rankings = json.rankings || [];
  const roundNumber = json.round_number;

  // Update round badge
  const badge = document.getElementById('round-badge');
  if (badge && roundNumber != null) badge.textContent = `Round ${roundNumber}`;

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

  rankings.forEach(r => {
    const formArrow = r.form != null
      ? (r.form > 0
          ? `<span style='color:#4ade80'>▲</span>${Math.abs(r.form).toFixed(2)}`
          : r.form < 0
            ? `<span style='color:#f87171'>▼</span>${Math.abs(r.form).toFixed(2)}`
            : '')
      : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-center text-gray-400 font-medium">${r.rank}</td>
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

  updateChart(resultsData, 'Top 8', {});
  updateScatter(resultsData);

  chartDropdown.addEventListener('change', (e) => {
    updateChart(resultsData, e.target.value, {});
  });
})();
