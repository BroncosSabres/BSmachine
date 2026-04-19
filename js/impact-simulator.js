// impact-simulator.js

const BACKEND = 'https://bsmachine-backend.onrender.com/api';

const form = document.getElementById("simulation-form");
const outcomeSelect = document.getElementById("impact-select");
const chartCanvas = document.getElementById("impactChart").getContext("2d");
let impactChart;

const OUTCOME_TYPES = {
  "Top 8":              "ext_impacts_top8",
  "Top 4":              "ext_impacts_top4",
  "Minor Premiership":  "ext_impacts_mp",
  "Wooden Spoon":       "ext_impacts_spoon"
};

// In-memory cache so switching outcomes doesn't re-fetch the same data
const snapshotCache = {};

async function getSnapshotData(snapshotType) {
  if (snapshotCache[snapshotType]) return snapshotCache[snapshotType];
  const res = await fetch(`${BACKEND}/round_snapshot/${snapshotType}`);
  if (!res.ok) throw new Error(`Failed to fetch snapshot: ${snapshotType}`);
  const json = await res.json();
  snapshotCache[snapshotType] = json.data;
  return json.data;
}

function renderMatchOptions(matches) {
  form.innerHTML = "<button id=\"clear-btn\" type=\"button\" class=\"mb-4 px-3 py-1 text-sm text-white bg-red-500 rounded hover:bg-red-600\">Clear All</button>";
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

let baseData = null;
let currentOutcomeKey = "";

async function updateChart(matches) {
  const selectedWinners = getSelectedWinners(matches);
  const snapshotType = OUTCOME_TYPES[outcomeSelect.value];
  const { teams, combo_results, counts } = await getSnapshotData(snapshotType);

  // Determine which combos match the selected winners
  const validCols = combo_results.map(result =>
    selectedWinners.every((winner, i) => !winner || result[i] === winner)
  );

  const totalMatchingCount = counts.reduce((sum, c, i) => validCols[i] ? sum + c : sum, 0);
  const totalAllCounts = counts.reduce((a, b) => a + b, 0);
  const chanceOfSelections = totalAllCounts > 0
    ? (totalMatchingCount / totalAllCounts * 100).toFixed(2)
    : "0.00";

  let summaryBox = document.getElementById("selection-chance");
  if (!summaryBox) {
    summaryBox = document.createElement("div");
    summaryBox.id = "selection-chance";
    summaryBox.className = "mb-4 text-sm text-gray-700 font-medium";
    form.prepend(summaryBox);
  }
  summaryBox.textContent = `Chance of all selected outcomes occurring: ${chanceOfSelections}%`;

  // Compute weighted probability per team for the selected scenario
  const chartData = teams.map(teamRow => {
    let weighted = 0, total = 0;
    combo_results.forEach((_, col) => {
      if (validCols[col]) {
        weighted += (teamRow.probs[col] / 100) * counts[col];
        total += counts[col];
      }
    });
    return { team: teamRow.name, probability: total ? weighted / total : 0 };
  });

  // Recalculate base probabilities (unfiltered) when no selection or outcome changes
  if (!selectedWinners.some(Boolean) || outcomeSelect.value !== currentOutcomeKey) {
    baseData = teams.map(teamRow => {
      const weighted = teamRow.probs.reduce((sum, p, i) => sum + (p / 100) * counts[i], 0);
      return { team: teamRow.name, probability: totalAllCounts ? weighted / totalAllCounts : 0 };
    });
    currentOutcomeKey = outcomeSelect.value;
  }

  const labels = chartData.map(d => d.team);
  const baseValues = baseData.map(d => d.probability * 100);
  const currentValues = chartData.map(d => d.probability * 100);
  const positiveChanges = chartData.map((_, i) => Math.max(0, currentValues[i] - baseValues[i]));
  const negativeChanges = chartData.map((_, i) => Math.max(0, baseValues[i] - currentValues[i]));
  const baseAdjusted = chartData.map((_, i) => Math.min(currentValues[i], baseValues[i]));

  if (impactChart) impactChart.destroy();

  impactChart = new Chart(chartCanvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `${outcomeSelect.value} Base`,
          data: baseAdjusted,
          backgroundColor: "#2563EB",
          stack: 'base'
        },
        {
          label: `Gain`,
          data: positiveChanges,
          backgroundColor: "#16a34a",
          stack: 'base'
        },
        {
          label: `Loss`,
          data: negativeChanges,
          backgroundColor: "rgba(220, 38, 38, 0.3)",
          stack: 'base'
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        tooltip: {
          callbacks: {
            label: function(context) {
              const index = context.dataIndex;
              const datasetLabel = context.dataset.label;
              if (datasetLabel === `${outcomeSelect.value} Base`) {
                const gain = positiveChanges[index];
                return `Current: ${(baseAdjusted[index] + gain).toFixed(2)}%`;
              } else if (datasetLabel === 'Gain') {
                return `Gain: +${context.raw.toFixed(2)}%`;
              } else if (datasetLabel === 'Loss') {
                return `Loss: -${context.raw.toFixed(2)}%`;
              }
              return `${context.raw.toFixed(2)}%`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          title: { display: true, text: "%" },
          stacked: true
        },
        x: { stacked: true }
      }
    }
  });
}

async function init() {
  // Load top8 snapshot first to get the matches list (same matches across all outcome types)
  const data = await getSnapshotData('ext_impacts_top8');
  const matches = data.matches.map(m => ({ home_team: m.home, away_team: m.away }));

  renderMatchOptions(matches);

  // Auto-select and lock completed game winners
  fetch('https://bsmachine-backend.onrender.com/latest-results')
    .then(res => res.json())
    .then(results => {
      results.forEach(result => {
        const matchIndex = matches.findIndex(
          m =>
            m.home_team.toLowerCase() === result.home.toLowerCase() &&
            m.away_team.toLowerCase() === result.away.toLowerCase()
        );
        if (matchIndex !== -1) {
          const winner = result.winner;
          const radioSelector = `input[name='match-${matchIndex}'][value="${winner}"]`;
          const radio = form.querySelector(radioSelector);
          if (radio) {
            radio.checked = true;
            radio.disabled = true;
            const others = form.querySelectorAll(`input[name='match-${matchIndex}']:not([value="${winner}"])`);
            others.forEach(r => r.disabled = true);
          }
        }
      });
      updateChart(matches);
    });

  form.addEventListener("change", () => updateChart(matches));

  document.getElementById("clear-btn").addEventListener("click", () => {
    form.querySelectorAll("input[type='radio']").forEach(input => {
      input.checked = false;
      input.disabled = false;
    });
    updateChart(matches);
  });

  outcomeSelect.addEventListener("change", () => updateChart(matches));
  updateChart(matches);
}

init();
