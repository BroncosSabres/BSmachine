// js/finalsWheel.js

const BACKEND = 'https://bsmachine-backend.onrender.com/api';

const TEAM_COLORS = {
  broncos:   "#760135",
  raiders:   "#32CD32",
  bulldogs:  "#00539F",
  sharks:    "#00A9D8",
  dolphins:  "#E0121A",
  titans:    "#009DDC",
  manly:     "#6F163D",
  storm:     "#632390",
  knights:   "#EE3524",
  cowboys:   "#002B5C",
  eels:      "#006EB5",
  panthers:  "#000000",
  rabbitohs: "#025D17",
  dragons:   "#E2231B",
  roosters:  "#E82C2E",
  warriors:  "#231F20",
  tigers:    "#F57600",
};

function teamSlug(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('broncos'))   return 'broncos';
  if (n.includes('bulldogs'))  return 'bulldogs';
  if (n.includes('cowboys'))   return 'cowboys';
  if (n.includes('dolphins'))  return 'dolphins';
  if (n.includes('dragons'))   return 'dragons';
  if (n.includes('eels'))      return 'eels';
  if (n.includes('knights'))   return 'knights';
  if (n.includes('sea eagles') || n.includes('manly')) return 'manly';
  if (n.includes('panthers'))  return 'panthers';
  if (n.includes('rabbitohs')) return 'rabbitohs';
  if (n.includes('raiders'))   return 'raiders';
  if (n.includes('roosters'))  return 'roosters';
  if (n.includes('sharks'))    return 'sharks';
  if (n.includes('storm'))     return 'storm';
  if (n.includes('tigers'))    return 'tigers';
  if (n.includes('titans'))    return 'titans';
  if (n.includes('warriors'))  return 'warriors';
  return n.replace(/\s+/g, '_');
}

async function drawFinalsWheel() {
  const canvas = document.getElementById('finalsWheel');
  const container = canvas.parentElement;
  container.style.maxWidth = '600px';
  container.style.maxHeight = '600px';
  canvas.style.height = '600px';

  let rankings;
  try {
    const res = await fetch(`${BACKEND}/power_rankings/nrl`);
    if (!res.ok) throw new Error(`Backend error ${res.status}`);
    const json = await res.json();
    rankings = json.rankings || [];
  } catch (e) {
    console.error('[finalsWheel] Failed to load power rankings:', e);
    return;
  }

  // Only show teams with any finals chance, sorted alphabetically for even sector distribution
  const filtered = rankings
    .filter(r => (r.percent_top8 ?? 0) > 0)
    .sort((a, b) => a.team.localeCompare(b.team));

  const teamNames   = filtered.map(r => r.team);
  const top8Odds     = filtered.map(r => (r.percent_top8         ?? 0) * 100);
  const week2Odds    = filtered.map(r => (r.percent_week2        ?? 0) * 100);
  const week3Odds    = filtered.map(r => (r.percent_week3        ?? 0) * 100);
  const gfOdds       = filtered.map(r => (r.percent_grand_final  ?? 0) * 100);
  const premiersOdds = filtered.map(r => (r.percent_premiers     ?? 0) * 100);

  const teamColours = teamNames.map(name => TEAM_COLORS[teamSlug(name)] || '#CCCCCC');

  // Preload logos
  const logos = teamNames.map(name => {
    const img = new Image();
    img.src = `./logos/${teamSlug(name)}.svg`;
    return img;
  });
  await Promise.all(logos.map(img => new Promise(resolve => {
    if (img.complete) resolve();
    else { img.onload = resolve; img.onerror = resolve; }
  })));

  const ctx = canvas.getContext('2d');
  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: teamNames,
      datasets: [
        { label: 'Qualifying Finals',    data: top8Odds,     backgroundColor: teamColours, weight: 1, borderColor: '#ccc', borderWidth: 1 },
        { label: 'Semi Finals',          data: week2Odds,    backgroundColor: teamColours, weight: 1, borderColor: '#ccc', borderWidth: 1 },
        { label: 'Preliminary Finals',   data: week3Odds,    backgroundColor: teamColours, weight: 1, borderColor: '#ccc', borderWidth: 1 },
        { label: 'Grand Final',          data: gfOdds,       backgroundColor: teamColours, weight: 1, borderColor: '#ccc', borderWidth: 1 },
        { label: 'Premiers',             data: premiersOdds, backgroundColor: teamColours, weight: 1, borderColor: '#ccc', borderWidth: 1 },
      ]
    },
    options: {
      cutout: '15%',
      radius: '100%',
      maintainAspectRatio: false,
      layout: { padding: { top: 40, bottom: 40, left: 40, right: 40 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `${ctx.dataset.label} – ${ctx.label}: ${ctx.formattedValue}%`;
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
          const labels  = ['Qualifying Finals', 'Semi Finals', 'Preliminary Finals', 'Grand Final', 'Premiers'];
          const baseAngle = -Math.PI / 2;
          labels.forEach((text, i) => {
            const arc = chart.getDatasetMeta(i).data[0];
            const r   = arc.outerRadius - 5;
            const x   = centerX + Math.cos(baseAngle) * r;
            const y   = centerY + Math.sin(baseAngle) * r;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(baseAngle + Math.PI / 2);
            ctx.font         = 'bold 12px sans-serif';
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
          const offset = 20;
          arcs.forEach((arcElem, i) => {
            const angle      = (arcElem.startAngle + arcElem.endAngle) / 2;
            const outerRadius = arcElem.outerRadius;
            const x = arcElem.x + Math.cos(angle) * (outerRadius + offset);
            const y = arcElem.y + Math.sin(angle) * (outerRadius + offset);
            const img = logos[i];
            const size = 24;
            if (img.complete) ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
          });
        }
      },
      {
        id: 'centerImage',
        beforeDraw(chart) {
          const { ctx, chartArea } = chart;
          const img = document.getElementById('trophy');
          if (!img || !img.complete) return;
          const maxDim = Math.min(chartArea.width, chartArea.height) * 0.10;
          const ratio  = img.naturalWidth / img.naturalHeight;
          const drawWidth  = ratio >= 1 ? maxDim : maxDim * ratio;
          const drawHeight = ratio >= 1 ? maxDim / ratio : maxDim;
          const x = chartArea.left + (chartArea.width  - drawWidth)  / 2;
          const y = chartArea.top  + (chartArea.height - drawHeight) / 2;
          ctx.drawImage(img, x, y, drawWidth, drawHeight);
        }
      }
    ]
  });
}

window.addEventListener('DOMContentLoaded', drawFinalsWheel);
