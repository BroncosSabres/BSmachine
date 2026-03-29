// main.js
import { updateChart, updateScatter, formatDecimal, formatPercent } from './charts.js';

const ladderTable   = document.querySelector("#ladder-table tbody");
const rankingsTable = document.querySelector("#rankings-table tbody");
const chartDropdown = document.getElementById("chart-select");

let resultsData = [];

async function getLatestRoundFolder() {
  const roundCount = 30;
  for (let i = roundCount; i >= 0; i--) {
    const response = await fetch(`../data/Round${i}/results.csv`);
    if (response.ok) return `Round${i}`;
  }
  return null;
}

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

(async () => {
  const roundFolder = await getLatestRoundFolder();
  if (!roundFolder) return;
  const currentRoundNum = parseInt(roundFolder.replace("Round", ""));
  const prevRoundFolder = `Round${currentRoundNum - 1}`;

  // Update round badge
  const badge = document.getElementById('round-badge');
  if (badge) badge.textContent = `Round ${currentRoundNum}`;

  let prevDataMap = {};
  try {
    const prevRes = await fetch(`../data/${prevRoundFolder}/results.csv`);
    if (prevRes.ok) {
      const prevText = await prevRes.text();
      Papa.parse(prevText, { header: true }).data.forEach(row => {
        if (row["Team"]) prevDataMap[row["Team"]] = row;
      });
    }
  } catch (err) {
    console.warn("Previous round data not available");
  }

  const res = await fetch(`../data/${roundFolder}/results.csv`);
  resultsData = Papa.parse(await res.text(), { header: true }).data;

  resultsData.forEach(row => {
    if (!row["Team"]) return;
    const prev   = prevDataMap[row["Team"]];
    const change = prev ? (parseFloat(row["Total Rating"]) - parseFloat(prev["Total Rating"])).toFixed(2) : null;
    const changeArrow = change !== null
      ? (change > 0 ? `<span style='color:#4ade80'>▲</span>${Math.abs(change)}`
                    : change < 0 ? `<span style='color:#f87171'>▼</span>${Math.abs(change)}` : '')
      : '';

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="text-center text-gray-400 font-medium">${row["Rank"]}</td>
      <td>
        <div class="flex items-center gap-2">
          <img src="../logos/${row["Team"].toLowerCase()}.svg"
               alt="${row["Team"]}" class="w-6 h-6 object-contain shrink-0"
               onerror="this.style.display='none'">
          <span>${row["Team"]}</span>
        </div>
      </td>
      <td class="text-center font-mono">${formatDecimal(row["Total Rating"])} ${changeArrow}</td>
      <td class="text-center">${formBadge(row["form"])}</td>
      <td class="text-center font-medium" style="${probColor(row["Top 8"])}">${formatPercent(row["Top 8"])}</td>
      <td class="text-center font-medium" style="${probColor(row["Top 4"])}">${formatPercent(row["Top 4"])}</td>
      <td class="text-center font-medium" style="${probColor(row["Minor Premiers"])}">${formatPercent(row["Minor Premiers"])}</td>
      <td class="text-center font-medium" style="${probColor(row["Premiers"])}">${formatPercent(row["Premiers"])}</td>
      <td class="text-center font-medium" style="${spoonColor(row["Spoon"])}">${formatPercent(row["Spoon"])}</td>
    `;
    rankingsTable.appendChild(tr);
  });

  updateChart(resultsData, "Top 8", prevDataMap);
  updateScatter(resultsData);

  chartDropdown.addEventListener("change", (e) => {
    updateChart(resultsData, e.target.value, prevDataMap);
  });

  const ladderRes  = await fetch(`../data/${roundFolder}/projected_ladder.csv`);
  const parsedLadder = Papa.parse(await ladderRes.text(), { header: true });

  parsedLadder.data.forEach(row => {
    if (!row["Team"]) return;
    const pd = parseFloat(row["PD"]);
    const pdColor = pd > 0 ? 'color:#4ade80' : pd < 0 ? 'color:#f87171' : '';
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="text-center text-gray-400 font-medium">${row["Rank"]}</td>
      <td>
        <div class="flex items-center gap-2">
          <img src="../logos/${row["Team"].toLowerCase()}.svg"
               alt="${row["Team"]}" class="w-6 h-6 object-contain shrink-0"
               onerror="this.style.display='none'">
          <span>${row["Team"]}</span>
        </div>
      </td>
      <td class="text-center">${row["Wins"]}</td>
      <td class="text-center">${row["Losses"]}</td>
      <td class="text-center font-medium" style="${pdColor}">${pd > 0 ? '+' : ''}${pd}</td>
      <td class="text-center">${row["Points For"]}</td>
      <td class="text-center">${row["Points Against"]}</td>
    `;
    ladderTable.appendChild(tr);
  });
})();
