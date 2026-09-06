// distribution-3d.js
// Shared 3D (margin, total_points, probability) surface renderer for both NRL and NFL
// distribution modals. Renders via Plotly.js, loaded lazily from CDN on first use so
// pages that never open the 3D view don't pay for the bundle.
import { BACKEND, apiUrl } from './api-config.js';

const PLOTLY_CDN = 'https://cdn.plot.ly/plotly-2.35.2.min.js';
let plotlyLoadPromise = null;

function loadPlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (plotlyLoadPromise) return plotlyLoadPromise;
  plotlyLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PLOTLY_CDN;
    script.onload = () => resolve(window.Plotly);
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return plotlyLoadPromise;
}

function jointBinsUrl(sport, id) {
  // NRL's joint-bins endpoint is registered flat (not sport-nested); NFL's is under /nfl/.
  return sport === 'nfl'
    ? apiUrl('nfl', `game_sgm_bins_range/${id}`)
    : `${BACKEND}/match_sgm_bins_range/${id}`;
}

async function fetchJointBins(sport, id) {
  try {
    const res = await fetch(jointBinsUrl(sport, id));
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data; // { bins: [{m,t,c,...}], total_count, ... } — unfiltered = full grid
  } catch {
    return null;
  }
}

// Turn the sparse {m,t,c} bin list into a dense (margins x totals) probability grid,
// zero-filling any (margin, total) combination not present in the simulation output.
function buildGrid(bins, totalCount) {
  const margins = [...new Set(bins.map(b => b.m))].sort((a, b) => a - b);
  const totals  = [...new Set(bins.map(b => b.t))].sort((a, b) => a - b);
  const lookup  = new Map(bins.map(b => [`${b.m}_${b.t}`, b.c]));
  const z = totals.map(t => margins.map(m => (lookup.get(`${m}_${t}`) ?? 0) / totalCount));
  return { margins, totals, z };
}

export async function renderDistribution3D(containerEl, { sport, id }) {
  containerEl.innerHTML = '<div style="text-align:center;color:#4a5568;font-size:0.875rem;padding:2rem;">Loading 3D surface…</div>';

  const [Plotly, data] = await Promise.all([loadPlotly(), fetchJointBins(sport, id)]);
  if (!data || !data.bins?.length) {
    containerEl.innerHTML = '<div style="text-align:center;color:#4a5568;font-size:0.875rem;padding:2rem;">No joint distribution data available.</div>';
    return;
  }

  containerEl.innerHTML = '';
  const { margins, totals, z } = buildGrid(data.bins, data.total_count || 1);

  Plotly.newPlot(containerEl, [{
    type: 'surface',
    x: margins,
    y: totals,
    z,
    colorscale: [[0, '#161b24'], [0.5, '#f59e0b'], [1, '#fde68a']],
    showscale: false,
    contours: { z: { show: false } },
  }], {
    paper_bgcolor: '#161b24',
    plot_bgcolor: '#161b24',
    font: { color: '#94a3b8', size: 10 },
    margin: { l: 0, r: 0, t: 10, b: 0 },
    scene: {
      xaxis: { title: 'Margin (home − away)', color: '#4a5568', gridcolor: 'rgba(255,255,255,0.08)' },
      yaxis: { title: 'Total points',         color: '#4a5568', gridcolor: 'rgba(255,255,255,0.08)' },
      zaxis: { title: 'Probability',          color: '#4a5568', gridcolor: 'rgba(255,255,255,0.08)' },
      bgcolor: '#161b24',
    },
  }, { displayModeBar: false, responsive: true });
}

export function purgeDistribution3D(containerEl) {
  if (window.Plotly && containerEl) {
    try { window.Plotly.purge(containerEl); } catch { /* no-op: container already empty/detached */ }
  }
}
