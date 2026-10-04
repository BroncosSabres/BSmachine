// nfl-charts.js — playoff-odds wheels + off/def scatterplot for nfl/pages/rankings.html
import { nflLogoUrl } from './nfl-logos.js';

const NFL_TEAM_COLORS = {
  'Buffalo Bills': '#00338D', 'Miami Dolphins': '#008E97', 'New England Patriots': '#002244',
  'New York Jets': '#125740', 'Baltimore Ravens': '#241773', 'Cincinnati Bengals': '#FB4F14',
  'Cleveland Browns': '#311D00', 'Pittsburgh Steelers': '#FFB612', 'Houston Texans': '#03202F',
  'Indianapolis Colts': '#002C5F', 'Jacksonville Jaguars': '#101820', 'Tennessee Titans': '#0C2340',
  'Denver Broncos': '#FB4F14', 'Kansas City Chiefs': '#E31837', 'Las Vegas Raiders': '#000000',
  'Los Angeles Chargers': '#0080C6', 'Dallas Cowboys': '#041E42', 'New York Giants': '#0B2265',
  'Philadelphia Eagles': '#004C54', 'Washington Commanders': '#5A1414', 'Chicago Bears': '#0B162A',
  'Detroit Lions': '#0076B6', 'Green Bay Packers': '#203731', 'Minnesota Vikings': '#4F2683',
  'Atlanta Falcons': '#A71930', 'Carolina Panthers': '#0085CA', 'New Orleans Saints': '#D3BC8D',
  'Tampa Bay Buccaneers': '#D50A0A', 'Arizona Cardinals': '#97233F', 'Los Angeles Rams': '#003594',
  'San Francisco 49ers': '#AA0000', 'Seattle Seahawks': '#002244',
};

const wheelInstances = {};
let scatterInstance;

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

// Wheel geometry scales with the rendered width (the canvas sits in a square,
// width-driven box) so the logo ring and labels still fit on narrow screens.
function wheelScale(chart) { return Math.max(0.6, Math.min(1, chart.width / 480)); }
function wheelLogoSize(chart) { return Math.round(22 * wheelScale(chart)); }
function wheelLogoOffset(chart) { return wheelLogoSize(chart) * 0.8; }
function wheelPadding(chart) { return Math.ceil(wheelLogoOffset(chart) + wheelLogoSize(chart) / 2 + 2); }

async function preloadLogos(teamNames) {
  const logos = {};
  await Promise.all(teamNames.map(name => new Promise(resolve => {
    const img = new Image();
    img.onload = resolve;
    img.onerror = resolve;
    img.src = nflLogoUrl(name);
    logos[name] = img;
  })));
  return logos;
}

function wheelChart(canvasId, teamNames, ringDatasets, ringLabels) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const teamColours = teamNames.map(name => NFL_TEAM_COLORS[name] || '#CCCCCC');

  return preloadLogos(teamNames).then(logos => {
    // Destroy only once the logos are in, so overlapping redraws (e.g. a quick
    // toggle back and forth) never leave two charts on one canvas.
    if (wheelInstances[canvasId]) wheelInstances[canvasId].destroy();
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
        layout: { padding: ({ chart }) => wheelPadding(chart) },
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
            const fontSize = Math.max(8, Math.round(11 * wheelScale(chart)));
            ringLabels.forEach((text, i) => {
              const arc = chart.getDatasetMeta(i).data[0];
              if (!arc) return;
              const r = arc.outerRadius - 5;
              const x = centerX + Math.cos(baseAngle) * r;
              const y = centerY + Math.sin(baseAngle) * r;
              ctx.save();
              ctx.translate(x, y);
              ctx.rotate(baseAngle + Math.PI / 2);
              ctx.font         = `bold ${fontSize}px sans-serif`;
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
            const offset = wheelLogoOffset(chart);
            const size = wheelLogoSize(chart);
            arcs.forEach((arcElem, i) => {
              const angle       = (arcElem.startAngle + arcElem.endAngle) / 2;
              const outerRadius = arcElem.outerRadius;
              const x = arcElem.x + Math.cos(angle) * (outerRadius + offset);
              const y = arcElem.y + Math.sin(angle) * (outerRadius + offset);
              drawLogoContain(ctx, logos[teamNames[i]], x, y, size);
            });
          }
        }
      ]
    });
    wheelInstances[canvasId] = instance;
    return instance;
  });
}

// Full-league wheel: every team with a playoff chance, one ring per round
// through to winning the Super Bowl.
export async function drawLeagueWheel(rankings, canvasId) {
  const filtered = rankings
    .filter(r => (r.percent_playoffs ?? 0) > 0)
    .sort((a, b) => a.team.localeCompare(b.team));

  const teamNames = filtered.map(r => r.team);
  const ringLabels = ['Playoffs', 'Div Round', 'Conf Champ', 'Super Bowl', 'Champions'];
  const ringKeys   = ['percent_playoffs', 'percent_divisional_round', 'percent_conf_championship',
                       'percent_super_bowl_appearance', 'percent_super_bowl_champion'];
  const ringDatasets = ringKeys.map(key => filtered.map(r => (r[key] ?? 0) * 100));

  await wheelChart(canvasId, teamNames, ringDatasets, ringLabels);
}

export async function drawConferenceWheel(rankings, conference, canvasId) {
  const filtered = rankings
    .filter(r => r.conference === conference && (r.percent_playoffs ?? 0) > 0)
    .sort((a, b) => a.team.localeCompare(b.team));

  const teamNames = filtered.map(r => r.team);
  const ringLabels = ['Playoffs', 'Div Round', 'Conf Champ Game', 'Conference Champions'];
  const ringKeys   = ['percent_playoffs', 'percent_divisional_round',
                       'percent_conf_championship', 'percent_super_bowl_appearance'];
  const ringDatasets = ringKeys.map(key => filtered.map(r => (r[key] ?? 0) * 100));

  await wheelChart(canvasId, teamNames, ringDatasets, ringLabels);
}

export async function drawSuperBowlWheel(rankings, canvasId) {
  const filtered = rankings
    .filter(r => (r.percent_super_bowl_champion ?? 0) > 0)
    .sort((a, b) => a.team.localeCompare(b.team));

  const teamNames = filtered.map(r => r.team);
  const ringDatasets = [filtered.map(r => (r.percent_super_bowl_champion ?? 0) * 100)];

  await wheelChart(canvasId, teamNames, ringDatasets, ['Win Super Bowl']);
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
