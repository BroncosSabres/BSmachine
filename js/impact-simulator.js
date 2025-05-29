// impact-simulator.js
import { getLatestRoundFolder } from './utils.js';

const form = document.getElementById("simulation-form");
const outcomeSelect = document.getElementById("impact-select");
const chartCanvas = document.getElementById("impactChart").getContext("2d");
let impactChart;

const outcomeFiles = {
  "Top 8": "ext_impact_factors_top8.csv",
  "Top 4": "ext_impact_factors_top4.csv",
  "Minor Premiership": "ext_impact_factors_mp.csv",
  "Wooden Spoon": "ext_impact_factors_spoon.csv"
};

function renderMatchOptions(matches) {
  form.innerHTML = "<button id=\"clear-btn\" type=\"button\" class=\"mb-4 px-3 py-1 text-sm text-white bg-red-500 rounded hover:bg-red-600\">Clear All</button>";
  matches.forEach((match, index) => {
    const matchBlock = document.createElement("div");
    matchBlock.className = "flex gap-2 items-center bg-gray-700 p-1 rounded text-white text-sm border border-gray-500";
    matchBlock.innerHTML = `
      <label><input type="radio" name="match-${index}" value="${match.home_team}" class="mr-1 accent-blue-500 w-3 h-3"> ${match.home_team}</label>
      <span class="text-gray-300">vs</span>
      <label><input type="radio" name="match-${index}" value="${match.away_team}" class="mr-1 w-3 h-3"> ${match.away_team}</label>
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

function parseCSV(csvText) {
  const rows = Papa.parse(csvText.trim(), { skipEmptyLines: true }).data;

  // Determine header rows count (games this week)
  let headerRowCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Detect first team-data row: first cell non-empty and second cell numeric
    if (row[0] && row[0].trim() !== '' && !isNaN(parseFloat(row[1]))) {
      headerRowCount = i;
      break;
    }
  }

  // Extract header rows dynamically
  const rawHeaders = rows.slice(0, headerRowCount);

  // Build matchHeaders: each column after first represents a scenario across header rows
  const matchHeaders = rawHeaders[0].slice(1).map((_, colIdx) =>
    rawHeaders.map(row => row[colIdx + 1])
  );

  // Determine counts row index (first integer-only row after team data)
  let countsRowIndex = rows.findIndex((row, idx) => {
    if (idx <= headerRowCount) return false;
    return row.slice(1).every(cell => /^\d+$/.test(cell));
  });
  if (countsRowIndex === -1) countsRowIndex = rows.length - 1;

  // Team rows are between headers and counts row
  const teamRows = rows.slice(headerRowCount, countsRowIndex);
  const teamNames = teamRows.map(r => r[0]);
  const teamData = teamRows.map(r => r.slice(1).map(x => parseFloat(x) / 100));
  const counts = rows[countsRowIndex].slice(1).map(Number);

  return { matchHeaders, teamNames, teamData, counts };
}

function findMatchingColumns(matchHeaders, selectedWinners) {
  return matchHeaders.map((col) => {
    return selectedWinners.every((winner, matchIndex) => !winner || col[matchIndex]?.trim() === winner?.trim());
  });
};

let baseData = null;
let currentOutcomeKey = "";

function updateChartFromCSV(csvText, selectedWinners) {
  const { matchHeaders, teamNames, teamData, counts } = parseCSV(csvText);
  const validCols = findMatchingColumns(matchHeaders, selectedWinners);
  const matchingIndices = validCols
    .map((valid, index) => valid ? index : null)
    .filter(index => index !== null);
  const totalMatchingCount = matchingIndices.reduce((sum, i) => sum + counts[i], 0);
  const totalAllCounts = counts.reduce((sum, c) => sum + c, 0);
  const chanceOfSelections = totalAllCounts > 0 ? (totalMatchingCount / totalAllCounts * 100).toFixed(2) : "0.00";
  let summaryBox = document.getElementById("selection-chance");
  if (!summaryBox) {
    summaryBox = document.createElement("div");
    summaryBox.id = "selection-chance";
    summaryBox.className = "mb-4 text-sm text-gray-700 font-medium";
    form.prepend(summaryBox);
  }
  summaryBox.textContent = `Chance of all selected outcomes occurring: ${chanceOfSelections}%`;
  console.log("Matching columns:", matchingIndices);

  const chartData = teamNames.map((team, rowIndex) => {
    let weighted = 0;
    let total = 0;
    validCols.forEach((isValid, col) => {
      if (isValid) {
        weighted += teamData[rowIndex][col] * counts[col];
        total += counts[col];
      }
    });
    return {
      team,
      probability: total ? (weighted / total) : 0
    };
  });

  if (!selectedWinners.some(Boolean) || outcomeSelect.value !== currentOutcomeKey) {
    // Recalculate base using all simulations (no filtering)
    const allCols = Array.from({ length: matchHeaders.length }, (_, i) => true);
    baseData = teamNames.map((team, rowIndex) => {
      let weighted = 0;
      let total = 0;
      allCols.forEach((_, col) => {
        weighted += teamData[rowIndex][col] * counts[col];
        total += counts[col];
      });
      return {
        team,
        probability: total ? (weighted / total) : 0
      };
    });
    currentOutcomeKey = outcomeSelect.value;
  }

  const labels = chartData.map(d => d.team);
  const baseValues = baseData.map(d => d.probability * 100);
  const currentValues = chartData.map(d => d.probability * 100);
  const changeValues = currentValues.map((val, i) => val - baseValues[i]);
  const positiveChanges = chartData.map((d, i) => Math.max(0, currentValues[i] - baseValues[i]));
  const negativeChanges = chartData.map((d, i) => Math.max(0, baseValues[i] - currentValues[i]));
  const baseAdjusted = chartData.map((d, i) => Math.min(currentValues[i], baseValues[i]));

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
        x: {
          stacked: true
        }
      }
    }
  });
}

async function updateChart(matches) {
  const selected = getSelectedWinners(matches);
  const file = outcomeFiles[outcomeSelect.value];
  const round = await getLatestRoundFolder();
  const res = await fetch(`../data/${round}/${file}`);
  const text = await res.text();
  updateChartFromCSV(text, selected);
}

async function init() {
  const round = await getLatestRoundFolder();
  const res = await fetch(`../data/${round}/Predictions.txt`);
  const text = await res.text();
  const matches = text.trim().split("\n").map(l => JSON.parse(l.replace(/'/g, '"')));

  renderMatchOptions(matches);

  // Fetch real results and auto-select + grey-out winners
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

            // Also disable the opposing button to avoid accidental changes
            const others = form.querySelectorAll(`input[name='match-${matchIndex}']:not([value="${winner}"])`);
            others.forEach(r => r.disabled = true);
          }
        }
      });

      // Update chart after applying real winners
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
