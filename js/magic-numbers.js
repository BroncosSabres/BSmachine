// magic-numbers.js

const BACKEND = 'https://bsmachine-backend.onrender.com/api';

const outcomeStyles = {
  finals:   { label: "Finals", color: "#ff9800", fillAlpha: 0.12 },
  top4:     { label: "Top 4", color: "#2196f3", fillAlpha: 0.10 },
  minor_premiership: { label: "Minor Prem", color: "#ffd600", fillAlpha: 0.13 },
  spoon:    { label: "Spoon", color: "#f44336", fillAlpha: 0.13 }
};

// ---- Outcome Zone Extractor ----
// Finds the points range where 0 < probability < 1 (the "zone of uncertainty")
function findOutcomeZone(points, probs) {
  const validIndices = [];
  for (let i = 0; i < points.length; ++i) {
    if (probs[i] > 0 && probs[i] < 1) validIndices.push(i);
  }
  if (validIndices.length === 0) return null;
  const minIdx = validIndices[0];
  const maxIdx = validIndices[validIndices.length - 1];
  return [points[minIdx] + 6, points[maxIdx] + 6];
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
      ctx.beginPath();
      ctx.moveTo(xMin, chartArea.top);
      ctx.lineTo(xMin, chartArea.bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(xMax, chartArea.top);
      ctx.lineTo(xMax, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

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
  const combined = teamData.map((d, i) => ({ ...d, idx: i }));
  combined.sort((a, b) => b.projected - a.projected);
  const sortedLabels = combined.map(d => d.team);

  const predictedData = combined.map(d => [d.min, d.projected]);
  const maxData = combined.map(d => [d.projected, d.max]);

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
          backgroundColor: 'rgba(40,167,69,0.75)',
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
          backgroundColor: 'rgba(52,162,255,0.3)',
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
        padding: { top: 32 }
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
          position: 'bottom',
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
                return `Min: ${start} pts → Projected: ${end} pts`;
              } else if (ctx.dataset.label === "Max Possible Points") {
                return `Projected: ${start} pts → Max: ${end} pts`;
              }
              return "";
            }
          }
        },
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
  const [magicRes, ladderRes, rankingsRes] = await Promise.all([
    fetch(`${BACKEND}/round_snapshot/magic_numbers`),
    fetch(`${BACKEND}/round_snapshot/projected_ladder`),
    fetch(`${BACKEND}/power_rankings/nrl`),
  ]);

  if (!magicRes.ok || !ladderRes.ok || !rankingsRes.ok) {
    console.error('Failed to load magic numbers data from API');
    return;
  }

  const [magicJson, ladderJson, rankingsJson] = await Promise.all([
    magicRes.json(),
    ladderRes.json(),
    rankingsRes.json(),
  ]);

  const magicData = magicJson.data;       // { points, finals, top4, minor_premiership, spoon, totals }
  const ladderData = ladderJson.data;     // [{ rank, team, points, wins, draws, losses, pd, pfor, pagainst }]
  const rankings = rankingsJson.rankings; // [{ team, wins, losses, draws, ... }]
  const roundNumber = rankingsJson.round_number;

  // Build outcome zones from magic_numbers snapshot
  const outcomeZones = {};
  for (const key of ['finals', 'top4', 'minor_premiership', 'spoon']) {
    outcomeZones[key] = findOutcomeZone(magicData.points, magicData[key]);
  }

  // Build record lookup from power rankings
  const recordByTeam = {};
  for (const r of rankings) {
    recordByTeam[r.team] = { wins: r.wins, losses: r.losses, draws: r.draws };
  }

  // Build team chart data from projected_ladder + power rankings
  const teamData = ladderData.map(row => {
    const rec = recordByTeam[row.team] || { wins: 0, losses: 0, draws: 0 };
    const gamesPlayed = rec.wins + rec.losses + rec.draws;
    const byesPlayed = roundNumber - gamesPlayed;
    const ladderPoints = rec.wins * 2 + rec.draws;
    const current   = ladderPoints + 2 * byesPlayed;
    const min       = ladderPoints + 6;
    const projected = row.points + 6;
    const max       = ladderPoints + 2 * (24 - gamesPlayed) + 6;
    return { team: row.team, current, min, projected, max };
  });

  drawChart(teamData, outcomeZones);
})();
