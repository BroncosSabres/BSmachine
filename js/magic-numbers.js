// magic-numbers.js

import { getLatestRoundFolder } from './utils.js';

// ---- Chart.js plugin for vertical lines + labels above ----
const outcomeStyles = {
  finals:   { label: "Finals", color: "#ff9800", fillAlpha: 0.12 },      // orange
  top4:     { label: "Top 4", color: "#2196f3", fillAlpha: 0.10 },       // blue
  minor_premiership: { label: "Minor Prem", color: "#ffd600", fillAlpha: 0.13 }, // yellow
  spoon:    { label: "Spoon", color: "#f44336", fillAlpha: 0.13 }        // red
};

const magicLinesPlugin = {
  id: 'magicLinesPlugin',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales: { x } } = chart;
    const magicNumbers = chart.options.plugins.magicLinesPlugin.magicNumbers || {};
    const outcomeStyles = chart.options.plugins.magicLinesPlugin.outcomeStyles || {};
    const labelY = chartArea.top - 10;
    Object.entries(magicNumbers).forEach(([key, value]) => {
      if (value !== null && !isNaN(value)) {
        const style = outcomeStyles[key] || { label: key, color: "#888" };
        const xPos = x.getPixelForValue(value);

        ctx.save();
        ctx.strokeStyle = style.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(xPos, chartArea.top);
        ctx.lineTo(xPos, chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "bold 15px sans-serif";
        ctx.fillStyle = style.color;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(style.label, xPos, labelY);
        ctx.restore();
      }
    });
  }
};

// ---- Magic Number Extraction ----
function findMagicNumber50(section) {
  const pointsRow = section[1].map(Number);
  const probsRow = section[2].map(Number);
  for (let i = 0; i < pointsRow.length; ++i) {
    if (probsRow[i] > 0.5) {
      return pointsRow[i];
    }
  }
  return null;
}
function findSpoonMagicNumber(section) {
  const pointsRow = section[1].map(Number);
  const probsRow = section[2].map(Number);
  for (let i = 0; i < pointsRow.length; ++i) {
    if (probsRow[i] < 0.5 && probsRow[i] > 0) {
      return pointsRow[i];
    }
  }
  return null;
}

// ---- Robust contiguous zone extractor for 0 < P < 1 ----
function findOutcomeZone(section, outcomeKey = "") {
  const pointsRow = section[1].map(Number);
  const probsRow = section[2].map(Number);

  // Find all indices where 0 < P < 1
  const validIndices = [];
  for (let i = 0; i < pointsRow.length; ++i) {
    if (probsRow[i] > 0 && probsRow[i] < 1) {
      validIndices.push(i);
    }
  }

  if (validIndices.length === 0) return null;

  // Use first and last valid indices as min/max (handles spoon and all other outcomes)
  const minIdx = validIndices[0];
  const maxIdx = validIndices[validIndices.length - 1];

  return [pointsRow[minIdx] + 6, pointsRow[maxIdx] + 6];
}

async function getOutcomeZones(roundFolder) {
  const csv = await fetch(`../data/${roundFolder}/magic numbers.csv`).then(r => r.text());
  const lines = csv.split(/\r?\n/);
  const outcomes = ["finals:", "top4:", "minor_premiership:", "spoon:"];
  let sections = {};
  let idx = 0;
  while (idx < lines.length) {
    const outcome = outcomes.find(o => lines[idx] && lines[idx].toLowerCase().includes(o));
    if (outcome) {
      sections[outcome.replace(":", "")] = [
        lines[idx],
        lines[idx + 1],
        lines[idx + 2],
      ];
      idx += 3;
    } else {
      idx++;
    }
  }
  let outcomeZones = {};
  for (let key in sections) {
    const arr = sections[key].map(line =>
      line.split(/[ ,]+/).filter(Boolean)
    );
    outcomeZones[key] = findOutcomeZone(arr, key);
  }
  return outcomeZones;
}


async function getMagicNumbers50(roundFolder) {
  const csv = await fetch(`../data/${roundFolder}/magic numbers.csv`).then(r => r.text());
  const lines = csv.split(/\r?\n/);
  const outcomes = ["finals:", "top4:", "minor_premiership:", "spoon:"];
  let sections = {};
  let idx = 0;
  while (idx < lines.length) {
    const outcome = outcomes.find(o => lines[idx] && lines[idx].toLowerCase().includes(o));
    if (outcome) {
      sections[outcome.replace(":", "")] = [
        lines[idx],
        lines[idx + 1],
        lines[idx + 2],
      ];
      idx += 3;
    } else {
      idx++;
    }
  }
  let magicNumbers = {};
  for (let key in sections) {
    const arr = sections[key].map(line =>
      line.split(/[ ,]+/).filter(Boolean)
    );
    if (key === "spoon") {
      magicNumbers[key] = findSpoonMagicNumber(arr);
    } else {
      magicNumbers[key] = findMagicNumber50(arr);
    }
  }
  let outcomeZones = {};
  for (let key in sections) {
    const arr = sections[key].map(line =>
        line.split(/[ ,]+/).filter(Boolean)
    );
    outcomeZones[key] = findOutcomeZone(arr);
  }

  return outcomeZones; //magicNumbers;
}

// ---- Team Data Loader ----
async function loadTeamDataFromResults(roundFolder) {
  const res = await fetch(`../data/${roundFolder}/results.csv`);
  if (!res.ok) throw new Error("results.csv not found in " + roundFolder);
  const currentRoundNum = parseInt(roundFolder.replace("Round", ""), 10);
  const resultsText = await res.text();
  const parsedResults = Papa.parse(resultsText, { header: true });
  return parsedResults.data
    .filter(row => row.Team && row.Points && row["Projected Points"])
    .map(row => {
      const wins = parseInt(row.Wins || 0, 10);
      const draws = parseInt(row.Draws || 0, 10);
      const losses = parseInt(row.Losses || 0, 10);
      const gamesPlayed = wins + draws + losses;
      const byesPlayed = currentRoundNum - gamesPlayed;

      const current = parseFloat(row.Points) + 2 * byesPlayed;
      const min = parseFloat(row.Points) + 6;
      const projected = parseFloat(row["Projected Points"]) + 6;
      const max = parseFloat(row.Points) + 2 * (24 - gamesPlayed) + 6;
      return {
        team: row.Team,
        current,
        min,
        projected,
        max
      };
    });
}

const outcomeZonesPlugin = {
  id: "outcomeZonesPlugin",
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales: { x } } = chart;
    const outcomeZones = chart.options.plugins.outcomeZonesPlugin.outcomeZones || {};
    const outcomeStyles = chart.options.plugins.outcomeZonesPlugin.outcomeStyles || {};

    Object.entries(outcomeZones).forEach(([key, range]) => {
      if (!range) return;
      const style = outcomeStyles[key] || { color: "#888", label: key };
      const [min, max] = range;
      if (min === undefined || max === undefined) return;
      const xMin = x.getPixelForValue(min);
      const xMax = x.getPixelForValue(max);

      ctx.save();
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      // Left boundary
      ctx.beginPath();
      ctx.moveTo(xMin, chartArea.top);
      ctx.lineTo(xMin, chartArea.bottom);
      ctx.stroke();
      // Right boundary
      ctx.beginPath();
      ctx.moveTo(xMax, chartArea.top);
      ctx.lineTo(xMax, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label at center of zone, just above chart
      const midX = (xMin + xMax) / 2;
      ctx.font = "bold 15px sans-serif";
      ctx.fillStyle = style.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(style.label, midX, chartArea.top - 12);

      ctx.restore();
    });
  }
};

// ---- Chart Drawing ----
function drawChart(teamData, outcomeZones) {
  // Sort by projected (descending)
  const combined = teamData.map((d, i) => ({...d, idx: i}));
  combined.sort((a, b) => b.projected - a.projected);
  const sortedLabels = combined.map(d => d.team);

  // Main green bar: current → projected
  const predictedData = combined.map(d => [d.min, d.projected]);
  // Blue bar: projected → max
  const maxData = combined.map(d => [d.projected, d.max]);

  //Chart.register(magicLinesPlugin);
  Chart.register(outcomeZonesPlugin);

  if (window.magicNumbersChart && typeof window.magicNumbersChart.destroy === 'function') {
    window.magicNumbersChart.destroy();
  }

  const ctx = document.getElementById('magicNumbersChart').getContext('2d');
  window.magicNumbersChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sortedLabels,
      datasets: [
        {
          label: "Predicted Points",
          data: predictedData,
          backgroundColor: 'rgba(40,167,69,0.75)', // green
          borderColor: 'rgba(17,77,36,0.7)',
          borderWidth: 1,
          barPercentage: 0.8,
          categoryPercentage: 0.8,
          grouped: false,
          order: 1,
        },
        {
          label: "Max Possible Points",
          data: maxData,
          backgroundColor: 'rgba(52,162,255,0.3)', // light blue, semi-transparent
          borderColor: 'rgba(52,162,255,0.5)',
          borderWidth: 1,
          barPercentage: 0.8,
          categoryPercentage: 0.8,
          grouped: false,
          order: 2,
        }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          top: 32,
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          max: 54,
          ticks: {
            stepSize: 2,
            color: "#fff",
            font: { size: 14 }
          },
          title: {
            display: true,
            text: "Competition Points",
            color: "#fff",
            font: { size: 18, weight: 'bold' }
          },
          grid: { color: "#444", lineWidth: 0.5 },
        },
        y: {
          ticks: { color: "#fff", font: { size: 15, weight: 'bold' } },
          grid: { color: "#393939" }
        }
      },
      plugins: {
        legend: {
            display: true,
            position: 'bottom', // or 'right'
            labels: {
                color: "#fff",
                font: { size: 15, weight: "bold" },
                boxWidth: 25,
                padding: 16
            }
        },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              const [start, end] = ctx.raw;
              if (ctx.dataset.label === "Predicted Points") {
                return `Current: ${start} pts → Projected: ${end} pts`;
              } else if (ctx.dataset.label === "Max Possible Points") {
                return `Projected: ${start} pts → Max: ${end} pts`;
              }
              return "";
            }
          }
        },
        //magicLinesPlugin: {
        //  magicNumbers,
        //  outcomeStyles
        //}
        outcomeZonesPlugin: {
            outcomeZones,
            outcomeStyles
        },
      }
    }
  });
}

// ---- MAIN ----
(async () => {
  const roundFolder = await getLatestRoundFolder();
  if (!roundFolder) throw new Error("No round folder found!");

  const [outcomeZones, teamData] = await Promise.all([
    getOutcomeZones(roundFolder),
    loadTeamDataFromResults(roundFolder)
  ]);

  drawChart(teamData, outcomeZones);
})();
