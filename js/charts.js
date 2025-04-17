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

export function updateChart(data, category, prevData = {}) {
  const label = typeMap[category];
  const filteredTeams = data.filter(r => r["Team"] && parseFloat(r[label]) > 0);

  const baseValues = [], topValues = [], baseColors = [], topColors = [], labels = [], totalValues = [], deltaValues = [];

  filteredTeams.forEach(team => {
    const teamName = team["Team"];
    const current = parseFloat(team[label]) * 100;
    const previous = prevData[teamName] ? parseFloat(prevData[teamName][label]) * 100 : null;
    const delta = previous !== null ? current - previous : 0;

    const base = previous !== null ? Math.min(current, previous) : 0;
    const top = previous !== null ? Math.abs(delta) : current;
    const gain = delta >= 0;

    baseValues.push(base);
    topValues.push(top);
    baseColors.push("#2563EB");
    topColors.push(gain ? "#16a34a" : "rgba(220, 38, 38, 0.2)");
    labels.push(teamName);
    totalValues.push(current.toFixed(2));
    deltaValues.push(delta.toFixed(1));
  });

  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(chartCanvas, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: `${category} Base`,
          data: baseValues,
          backgroundColor: baseColors
        },
        {
          label: `${category} Change`,
          data: topValues,
          backgroundColor: topColors
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        tooltip: {
          callbacks: {
            label: function (context) {
              const teamIndex = context.dataIndex;
              const datasetIndex = context.datasetIndex;
              if (datasetIndex === 0) {
                return `${labels[teamIndex]}: ${totalValues[teamIndex]}%`;
              } else {
                const delta = parseFloat(deltaValues[teamIndex]);
                const symbol = delta > 0 ? "+" : "";
                return `${labels[teamIndex]}: ${symbol}${delta}%`;
              }
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
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

export async function updateScatter(data) {
  const points = data.filter(r => r["Team"] && r["Offensive Rating"] && r["Defensive Rating"]).map(team => ({
    x: parseFloat(team["Defensive Rating"]),
    y: parseFloat(team["Offensive Rating"]),
    label: team["Team"]
  }));

  const maxVal = Math.ceil(Math.max(...points.map(p => Math.abs(p.x)).concat(points.map(p => Math.abs(p.y)))));

  if (scatterInstance) scatterInstance.destroy();

  const teamLogos = await loadTeamLogos(data);

  scatterInstance = new Chart(scatterCanvas, {
    plugins: [{
      id: 'logoPoints',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        chart.data.datasets[0].data.forEach((point, index) => {
          const meta = chart.getDatasetMeta(0).data[index];
          const img = teamLogos[point.label];
          if (img && meta) {
            ctx.drawImage(img, meta.x - 12, meta.y - 12, 24, 24);
          }
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
      backgroundColor: '#000000',
      plugins: {
        tooltip: {
          callbacks: {
            label: context => `${context.raw.label}: Off ${context.raw.y.toFixed(2)}, Def ${context.raw.x.toFixed(2)}`
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: "Defensive Rating" },
          min: -maxVal, max: maxVal
        },
        y: {
          title: { display: true, text: "Offensive Rating" },
          min: -maxVal, max: maxVal
        }
      }
    }
  });
}
