// nhl-charts.js — playoff-odds wheels + off/def scatterplot for nhl/pages/rankings.html
// Structurally a port of nfl-charts.js: conference wheels (Eastern/Western
// instead of AFC/NFC) and a Stanley Cup odds wheel instead of a Super Bowl one.
import { nhlLogoUrl } from './nhl-logos.js';

// Primary team colours, keyed by the exact name nhl.teams.name returns. Falls
// back to a neutral grey (same as nfl-charts.js) for any name mismatch, so an
// unmatched team just loses its colour rather than breaking the chart.
const NHL_TEAM_COLORS = {
  'Boston Bruins': '#FFB81C', 'Buffalo Sabres': '#002654', 'Detroit Red Wings': '#CE1126',
  'Florida Panthers': '#041E42', 'Montreal Canadiens': '#AF1E2D', 'Ottawa Senators': '#C52032',
  'Tampa Bay Lightning': '#002868', 'Toronto Maple Leafs': '#00205B',
  'Carolina Hurricanes': '#CC0000', 'Columbus Blue Jackets': '#002654', 'New Jersey Devils': '#CE1126',
  'New York Islanders': '#00539B', 'New York Rangers': '#0038A8', 'Philadelphia Flyers': '#F74902',
  'Pittsburgh Penguins': '#FCB514', 'Washington Capitals': '#C8102E',
  'Chicago Blackhawks': '#CF0A2C', 'Colorado Avalanche': '#6F263D', 'Dallas Stars': '#006847',
  'Minnesota Wild': '#154734', 'Nashville Predators': '#FFB81C', 'St. Louis Blues': '#002F87',
  'Utah Mammoth': '#71AFE5', 'Winnipeg Jets': '#041E42',
  'Anaheim Ducks': '#F47A38', 'Calgary Flames': '#C8102E', 'Edmonton Oilers': '#FF4C00',
  'Los Angeles Kings': '#111111', 'San Jose Sharks': '#006D75', 'Seattle Kraken': '#99D9D9',
  'Vancouver Canucks': '#00205B', 'Vegas Golden Knights': '#B4975A',
};

let easternWheelInstance, westernWheelInstance, scfWheelInstance, scatterInstance;

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

// Draws img centered at (cx, cy), scaled to fit within a maxSize x maxSize box
// while preserving its natural aspect ratio (logo SVGs aren't all square).
function drawLogoContain(ctx, img, cx, cy, maxSize) {
  if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return;
  const ratio = img.naturalWidth / img.naturalHeight;
  const w = ratio >= 1 ? maxSize : maxSize * ratio;
  const h = ratio >= 1 ? maxSize / ratio : maxSize;
  ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
}

async function preloadLogos(teamNames) {
  const logos = {};
  await Promise.all(teamNames.map(name => new Promise(resolve => {
    const img = new Image();
    img.onload = resolve;
    img.onerror = resolve;
    img.src = nhlLogoUrl(name);
    logos[name] = img;
  })));
  return logos;
}

function wheelChart(canvasId, teamNames, ringDatasets, ringLabels) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const container = canvas.parentElement;
  container.style.maxWidth = '480px';
  container.style.maxHeight = '480px';
  container.style.marginLeft = 'auto';
  container.style.marginRight = 'auto';
  canvas.style.height = '480px';

  const teamColours = teamNames.map(name => NHL_TEAM_COLORS[name] || '#CCCCCC');

  return preloadLogos(teamNames).then(logos => {
    const ctx = canvas.getContext('2d');
    const instance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: teamNames,
        datasets: ringDatasets.map(data => ({
          data, backgroundColor: teamColours, weight: 1, borderColor: '#1e2a3a', borderWidth: 1,
        })),
      },
      options: {
        cutout: '15%',
        radius: '100%',
        maintainAspectRatio: false,
        layout: { padding: { top: 30, bottom: 30, left: 30, right: 30 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(ctx) {
                return `${ringLabels[ctx.datasetIndex]} – ${ctx.label}: ${ctx.formattedValue}%`;
              }
            }
          }
        }
      },
      plugins: [
        {
          id: 'ringLabels',
          afterDatasetsDraw(chart) {
            const { ctx, chartArea } = chart;
            const centerX = chartArea.left + chartArea.width  / 2;
            const centerY = chartArea.top  + chartArea.height / 2;
            const baseAngle = -Math.PI / 2;
            ringLabels.forEach((text, i) => {
              const arc = chart.getDatasetMeta(i).data[0];
              if (!arc) return;
              const r = arc.outerRadius - 5;
              const x = centerX + Math.cos(baseAngle) * r;
              const y = centerY + Math.sin(baseAngle) * r;
              ctx.save();
              ctx.translate(x, y);
              ctx.rotate(baseAngle + Math.PI / 2);
              ctx.font         = 'bold 11px sans-serif';
              ctx.fillStyle    = '#fff';
              ctx.textAlign    = 'center';
              ctx.textBaseline = 'top';
              ctx.fillText(text, 0, 4);
              ctx.restore();
            });
          }
        },
        {
          id: 'outerLogos',
          afterDatasetsDraw(chart) {
            const { ctx } = chart;
            const meta = chart.getDatasetMeta(0);
            const arcs = meta.data;
            if (!arcs.length) return;
            const offset = 18;
            arcs.forEach((arcElem, i) => {
              const angle       = (arcElem.startAngle + arcElem.endAngle) / 2;
              const outerRadius = arcElem.outerRadius;
              const x = arcElem.x + Math.cos(angle) * (outerRadius + offset);
              const y = arcElem.y + Math.sin(angle) * (outerRadius + offset);
              drawLogoContain(ctx, logos[teamNames[i]], x, y, 22);
            });
          }
        }
      ]
    });
    return instance;
  });
}

export async function drawConferenceWheel(rankings, conference, canvasId) {
  const filtered = rankings
    .filter(r => r.conference === conference && (r.percent_playoffs ?? 0) > 0)
    .sort((a, b) => a.team.localeCompare(b.team));

  const teamNames = filtered.map(r => r.team);
  const ringLabels = ['Playoffs', 'Second Round', 'Conf Final', 'Reach SCF'];
  const ringKeys   = ['percent_playoffs', 'percent_second_round',
                       'percent_conf_final', 'percent_scf_appearance'];
  const ringDatasets = ringKeys.map(key => filtered.map(r => (r[key] ?? 0) * 100));

  if (canvasId === 'easternWheel' && easternWheelInstance) easternWheelInstance.destroy();
  if (canvasId === 'westernWheel' && westernWheelInstance) westernWheelInstance.destroy();

  const instance = await wheelChart(canvasId, teamNames, ringDatasets, ringLabels);
  if (canvasId === 'easternWheel') easternWheelInstance = instance;
  if (canvasId === 'westernWheel') westernWheelInstance = instance;
}

export async function drawStanleyCupWheel(rankings, canvasId) {
  const filtered = rankings
    .filter(r => (r.percent_stanley_cup_champion ?? 0) > 0)
    .sort((a, b) => a.team.localeCompare(b.team));

  const teamNames = filtered.map(r => r.team);
  const ringDatasets = [filtered.map(r => (r.percent_stanley_cup_champion ?? 0) * 100)];

  if (scfWheelInstance) scfWheelInstance.destroy();
  scfWheelInstance = await wheelChart(canvasId, teamNames, ringDatasets, ['Win Stanley Cup']);
}

export async function updateScatter(rankings) {
  const canvas = document.getElementById('ratingsScatter');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const points = rankings
    .filter(r => r.team && r.off_rating != null && r.def_rating != null)
    .map(r => ({ x: Number(r.def_rating), y: Number(r.off_rating), label: r.team }));

  const maxVal = Math.ceil(
    Math.max(...points.map(p => Math.abs(p.x)), ...points.map(p => Math.abs(p.y)))
  );

  if (scatterInstance) scatterInstance.destroy();

  const logos = await preloadLogos(points.map(p => p.label));

  scatterInstance = new Chart(ctx, {
    plugins: [{
      id: 'logoPoints',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        chart.data.datasets[0].data.forEach((point, index) => {
          const meta = chart.getDatasetMeta(0).data[index];
          if (meta) drawLogoContain(ctx, logos[point.label], meta.x, meta.y, 28);
        });
      }
    }],
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Offensive vs Defensive Ratings',
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
