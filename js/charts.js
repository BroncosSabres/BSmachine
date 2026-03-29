// charts.js
import { loadTeamLogos } from './logoLoader.js';

let chartInstance;
let scatterInstance;

export const formatPercent = (val) => `${(parseFloat(val) * 100).toFixed(1)}%`;
export const formatDecimal = (val) => `${parseFloat(val).toFixed(2)}`;

const chartCanvas = document.getElementById("finalsChart").getContext("2d");
const scatterCanvas = document.getElementById("ratingsScatter").getContext("2d");

const typeMap = {
  "Top 8": "Top 8",
  "Top 4": "Top 4",
  "Minor Premiership": "Minor Premiers",
  "Premiership": "Premiers",
  "Wooden Spoon": "Spoon"
};

const darkThemeScales = {
  x: {
    ticks: { color: "#9ca3af" },
    grid:  { color: "rgba(255,255,255,0.06)" },
    title: { color: "#9ca3af" },
    border: { color: "rgba(255,255,255,0.1)" },
  },
  y: {
    ticks: { color: "#9ca3af" },
    grid:  { color: "rgba(255,255,255,0.06)" },
    title: { color: "#9ca3af" },
    border: { color: "rgba(255,255,255,0.1)" },
  }
};

export function updateChart(data, category, prevData = {}) {
  const label = typeMap[category];
  const filteredTeams = data.filter(r => r["Team"] && parseFloat(r[label]) > 0);

  const baseValues = [], topValues = [], baseColors = [], topColors = [],
        labels = [], totalValues = [], deltaValues = [];

  filteredTeams.forEach(team => {
    const teamName = team["Team"];
    const current  = parseFloat(team[label]) * 100;
    const previous = prevData[teamName] ? parseFloat(prevData[teamName][label]) * 100 : null;
    const delta    = previous !== null ? current - previous : 0;
    const base     = previous !== null ? Math.min(current, previous) : 0;
    const top      = previous !== null ? Math.abs(delta) : current;
    const gain     = delta >= 0;

    baseValues.push(base);
    topValues.push(top);
    baseColors.push("rgba(96,165,250,0.85)");           // blue-400
    topColors.push(gain ? "rgba(74,222,128,0.85)"       // green-400
                        : "rgba(248,113,113,0.5)");     // red-400 dimmed
    labels.push(teamName);
    totalValues.push(current.toFixed(2));
    deltaValues.push(delta.toFixed(1));
  });

  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(chartCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: `${category} Base`,   data: baseValues, backgroundColor: baseColors },
        { label: `${category} Change`, data: topValues,  backgroundColor: topColors  }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#9ca3af" } },
        tooltip: {
          callbacks: {
            label(context) {
              const i = context.dataIndex;
              if (context.datasetIndex === 0) return `${labels[i]}: ${totalValues[i]}%`;
              const d = parseFloat(deltaValues[i]);
              return `Change: ${d > 0 ? "+" : ""}${d}%`;
            }
          }
        }
      },
      scales: {
        y: {
          ...darkThemeScales.y,
          beginAtZero: true,
          stacked: true,
          title: { display: true, text: "%", color: "#9ca3af" }
        },
        x: {
          ...darkThemeScales.x,
          stacked: true,
          ticks: { color: "#e5e7eb", font: { size: 11 } }
        }
      }
    }
  });
}

export async function updateScatter(data) {
  const points = data
    .filter(r => r["Team"] && r["Offensive Rating"] && r["Defensive Rating"])
    .map(team => ({
      x: parseFloat(team["Defensive Rating"]),
      y: parseFloat(team["Offensive Rating"]),
      label: team["Team"]
    }));

  const maxVal = Math.ceil(
    Math.max(...points.map(p => Math.abs(p.x)), ...points.map(p => Math.abs(p.y)))
  );

  if (scatterInstance) scatterInstance.destroy();

  const teamLogos = await loadTeamLogos(data);

  scatterInstance = new Chart(scatterCanvas, {
    plugins: [{
      id: 'logoPoints',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        chart.data.datasets[0].data.forEach((point, index) => {
          const meta = chart.getDatasetMeta(0).data[index];
          const img  = teamLogos[point.label];
          if (img && meta) ctx.drawImage(img, meta.x - 14, meta.y - 14, 28, 28);
        });
      }
    }],
    type: 'scatter',
    data: {
      datasets: [{
        label: "Offensive vs Defensive Ratings",
        data: points,
        backgroundColor: 'transparent',
        pointRadius: 0,
      }]
    },
    options: {
      aspectRatio: 1,
      plugins: {
        legend: { labels: { color: "#9ca3af" } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.raw.label}: Off ${ctx.raw.y.toFixed(2)}, Def ${ctx.raw.x.toFixed(2)}`
          }
        }
      },
      scales: {
        x: {
          ...darkThemeScales.x,
          title: { display: true, text: "Defensive Rating (higher = better defence)", color: "#9ca3af" },
          min: -maxVal, max: maxVal
        },
        y: {
          ...darkThemeScales.y,
          title: { display: true, text: "Offensive Rating (higher = better attack)", color: "#9ca3af" },
          min: -maxVal, max: maxVal
        }
      }
    }
  });
}
