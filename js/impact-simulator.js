// impact-simulator.js
import { teamSlug } from './utils.js';

const BACKEND = 'https://bsmachine-backend.onrender.com/api';
const form = document.getElementById("simulation-form");

const OUTCOME_KEYS = ['ext_impacts_top8', 'ext_impacts_top4', 'ext_impacts_mp', 'ext_impacts_spoon'];

const snapshotCache = {};

async function getSnapshotData(snapshotType) {
  if (snapshotCache[snapshotType]) return snapshotCache[snapshotType];
  const res = await fetch(`${BACKEND}/round_snapshot/${snapshotType}`);
  if (!res.ok) throw new Error(`Failed to fetch snapshot: ${snapshotType}`);
  const json = await res.json();
  snapshotCache[snapshotType] = json.data;
  return json.data;
}

function computeProbs(snapshotData, selectedWinners) {
  const { teams, combo_results, counts } = snapshotData;
  const validCols = combo_results.map(result =>
    selectedWinners.every((winner, i) => !winner || result[i] === winner)
  );
  const totalAll = counts.reduce((a, b) => a + b, 0);
  const totalFiltered = counts.reduce((sum, c, i) => validCols[i] ? sum + c : sum, 0);

  return teams.map(teamRow => {
    let weightedAdj = 0, weightedBase = 0;
    combo_results.forEach((_, col) => {
      const p = teamRow.probs[col] / 100;
      weightedBase += p * counts[col];
      if (validCols[col]) weightedAdj += p * counts[col];
    });
    const base = totalAll ? (weightedBase / totalAll) * 100 : 0;
    const adjusted = totalFiltered ? (weightedAdj / totalFiltered) * 100 : base;
    return { team: teamRow.name, base, adjusted };
  });
}

// Normalize value within column range, then map to a Tailwind color class.
// invert=true for Wooden Spoon (low = good).
function valueColor(value, min, max, invert = false) {
  const range = max - min || 1;
  let t = (value - min) / range; // 0 = worst in column, 1 = best
  if (invert) t = 1 - t;
  if (t >= 0.8) return 'text-green-300';
  if (t >= 0.6) return 'text-green-400';
  if (t >= 0.4) return 'text-yellow-400';
  if (t >= 0.2) return 'text-orange-400';
  return 'text-red-400';
}

// invert=true for Wooden Spoon: a drop is good (green), a rise is bad (red)
function formatDelta(delta, hasSelections, invert = false) {
  if (!hasSelections || Math.abs(delta) < 0.05) return '';
  const sign = delta > 0 ? '+' : '';
  const positive = invert ? delta < 0 : delta > 0;
  const color = positive ? 'text-green-400' : 'text-red-400';
  return `<span class="${color} text-xs ml-1 font-medium">${sign}${delta.toFixed(1)}%</span>`;
}

function formatRankChange(change, hasSelections) {
  if (!hasSelections || change === 0) return '<span class="text-gray-600 text-xs ml-1">—</span>';
  if (change > 0) return `<span class="text-green-400 text-xs ml-1 font-medium">▲${change}</span>`;
  return `<span class="text-red-400 text-xs ml-1 font-medium">▼${Math.abs(change)}</span>`;
}

function renderTable(rows, hasSelections) {
  const container = document.getElementById('sim-table-container');

  // Compute per-column min/max from adjusted values for color normalization
  const col = (key) => rows.map(r => r[key].adjusted);
  const minMax = (arr) => ({ min: Math.min(...arr), max: Math.max(...arr) });
  const top8Range  = minMax(col('top8'));
  const top4Range  = minMax(col('top4'));
  const mpRange    = minMax(col('mp'));
  const spoonRange = minMax(col('spoon'));

  // Baseline rank = order by base Top 8 (no selections applied)
  const baselineOrder = [...rows].sort((a, b) => b.top8.base - a.top8.base);
  const baselineRank = {};
  baselineOrder.forEach((row, i) => { baselineRank[row.team] = i + 1; });

  const thead = `
    <table class="w-full text-sm">
      <thead>
        <tr class="text-gray-400 text-xs uppercase tracking-wider border-b border-gray-700">
          <th class="pb-3 w-10 text-center text-gray-600">#</th>
          <th class="pb-3 text-left pl-2">Team</th>
          <th class="pb-3 text-center px-3">Top 8</th>
          <th class="pb-3 text-center px-3">Top 4</th>
          <th class="pb-3 text-center px-3">Minor Prem</th>
          <th class="pb-3 text-center px-3">Wooden Spoon</th>
        </tr>
      </thead>
      <tbody>
  `;

  const tbody = rows.map((row, i) => {
    const currentRank = i + 1;
    const rankChange  = baselineRank[row.team] - currentRank; // positive = moved up

    const top8Delta  = row.top8.adjusted  - row.top8.base;
    const top4Delta  = row.top4.adjusted  - row.top4.base;
    const mpDelta    = row.mp.adjusted    - row.mp.base;
    const spoonDelta = row.spoon.adjusted - row.spoon.base;
    const bg = i % 2 !== 0 ? 'bg-gray-800/30' : '';

    const c8     = valueColor(row.top8.adjusted,  top8Range.min,  top8Range.max);
    const c4     = valueColor(row.top4.adjusted,  top4Range.min,  top4Range.max);
    const cmp    = valueColor(row.mp.adjusted,    mpRange.min,    mpRange.max);
    const cspoon = valueColor(row.spoon.adjusted, spoonRange.min, spoonRange.max, true);

    const slug = teamSlug(row.team);

    return `
      <tr class="${bg} border-b border-gray-800/40 hover:bg-gray-700/30 transition-colors">
        <td class="py-2 text-center whitespace-nowrap">
          <span class="text-gray-400 text-xs">${currentRank}</span>${formatRankChange(rankChange, hasSelections)}
        </td>
        <td class="py-2 pl-2 whitespace-nowrap">
          <div class="flex items-center gap-2">
            <img src="../logos/${slug}.svg" alt="${row.team}" class="w-6 h-6 object-contain shrink-0" onerror="this.style.display='none'">
            <span class="font-medium text-gray-100">${row.team}</span>
          </div>
        </td>
        <td class="py-2 px-3 text-center whitespace-nowrap font-medium ${c8}">${row.top8.adjusted.toFixed(1)}%${formatDelta(top8Delta, hasSelections)}</td>
        <td class="py-2 px-3 text-center whitespace-nowrap font-medium ${c4}">${row.top4.adjusted.toFixed(1)}%${formatDelta(top4Delta, hasSelections)}</td>
        <td class="py-2 px-3 text-center whitespace-nowrap font-medium ${cmp}">${row.mp.adjusted.toFixed(1)}%${formatDelta(mpDelta, hasSelections)}</td>
        <td class="py-2 px-3 text-center whitespace-nowrap font-medium ${cspoon}">${row.spoon.adjusted.toFixed(1)}%${formatDelta(spoonDelta, hasSelections, true)}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = thead + tbody + '</tbody></table>';
}

function renderMatchOptions(matches) {
  form.innerHTML = `<button id="clear-btn" type="button" class="mb-4 px-3 py-1 text-sm text-white bg-red-500 rounded hover:bg-red-600">Clear All</button>`;
  matches.forEach((match, index) => {
    const matchBlock = document.createElement("div");
    matchBlock.className = "bg-gray-700 p-2 rounded text-white text-sm border border-gray-500 space-y-1";
    matchBlock.innerHTML = `
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="radio" name="match-${index}" value="${match.home_team}" class="accent-blue-500 w-3 h-3 shrink-0">
        <span>${match.home_team}</span>
      </label>
      <div class="text-xs text-gray-400 pl-5">vs</div>
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="radio" name="match-${index}" value="${match.away_team}" class="w-3 h-3 shrink-0">
        <span>${match.away_team}</span>
      </label>
    `;
    form.appendChild(matchBlock);
  });
}

function getSelectedWinners(matches) {
  return matches.map((_, index) => {
    const selected = form.querySelector(`input[name='match-${index}']:checked`);
    return selected ? selected.value : null;
  });
}

async function updateTable(matches) {
  const selectedWinners = getSelectedWinners(matches);
  const hasSelections = selectedWinners.some(Boolean);

  const [top8Data, top4Data, mpData, spoonData] = await Promise.all(
    OUTCOME_KEYS.map(k => getSnapshotData(k))
  );

  // Update selection chance display using top8 combos
  const { combo_results, counts } = top8Data;
  const validCols = combo_results.map(result =>
    selectedWinners.every((winner, i) => !winner || result[i] === winner)
  );
  const totalAll = counts.reduce((a, b) => a + b, 0);
  const totalFiltered = counts.reduce((sum, c, i) => validCols[i] ? sum + c : sum, 0);
  const chanceOfSelections = totalAll > 0 ? (totalFiltered / totalAll * 100).toFixed(2) : '0.00';
  const summaryBox = document.getElementById('selection-chance');
  summaryBox.textContent = hasSelections
    ? `Chance of all selected outcomes occurring: ${chanceOfSelections}%`
    : '';

  const top8Probs  = computeProbs(top8Data,  selectedWinners);
  const top4Probs  = computeProbs(top4Data,  selectedWinners);
  const mpProbs    = computeProbs(mpData,    selectedWinners);
  const spoonProbs = computeProbs(spoonData, selectedWinners);

  // Merge all metrics by team name
  const rows = top8Probs.map(d => ({
    team:  d.team,
    top8:  d,
    top4:  top4Probs.find(x => x.team === d.team)  || { base: 0, adjusted: 0 },
    mp:    mpProbs.find(x => x.team === d.team)    || { base: 0, adjusted: 0 },
    spoon: spoonProbs.find(x => x.team === d.team) || { base: 0, adjusted: 0 }
  }));

  // Sort by adjusted Top 8 descending
  rows.sort((a, b) => b.top8.adjusted - a.top8.adjusted);

  renderTable(rows, hasSelections);
}

async function init() {
  const data = await getSnapshotData('ext_impacts_top8');
  const matches = data.matches.map(m => ({ home_team: m.home, away_team: m.away }));

  renderMatchOptions(matches);

  // Auto-select and lock completed game winners
  try {
    const results = await fetch('https://bsmachine-backend.onrender.com/latest-results').then(r => r.json());
    results.forEach(result => {
      const matchIndex = matches.findIndex(
        m => m.home_team.toLowerCase() === result.home.toLowerCase() &&
             m.away_team.toLowerCase() === result.away.toLowerCase()
      );
      if (matchIndex !== -1) {
        const radio = form.querySelector(`input[name='match-${matchIndex}'][value="${result.winner}"]`);
        if (radio) {
          radio.checked = true;
          radio.disabled = true;
          form.querySelectorAll(`input[name='match-${matchIndex}']:not([value="${result.winner}"])`).forEach(r => r.disabled = true);
        }
      }
    });
  } catch (e) {
    console.warn('Could not load latest results:', e);
  }

  form.addEventListener("change", () => updateTable(matches));

  document.getElementById("clear-btn").addEventListener("click", () => {
    form.querySelectorAll("input[type='radio']").forEach(input => {
      input.checked = false;
      input.disabled = false;
    });
    updateTable(matches);
  });

  await updateTable(matches);
}

init();
