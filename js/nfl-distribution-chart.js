// nfl-distribution-chart.js
// NFL margin/total-points distribution modal — machine (simulation) curve only,
// since there is no crowd/user-picks dataset for NFL (unlike NRL's predictions.js
// modal, which blends in a crowd KDE from round_picks). Mirrors the NRL modal's
// look, PDF/CDF toggle and CSV export, plus a 3D joint-distribution toggle shared
// with NRL via distribution-3d.js.
import { apiUrl } from './api-config.js';
import { renderDistribution3D, purgeDistribution3D } from './distribution-3d.js';

const distCache = {};
const chartInstances = {};

async function fetchDistribution(gameId) {
  if (distCache[gameId]) return distCache[gameId];
  try {
    const res  = await fetch(apiUrl('nfl', `game_score_distributions/${gameId}`));
    const data = await res.json();
    if (data.error) return null;
    distCache[gameId] = data;
    return data;
  } catch {
    return null;
  }
}

// Group machine bins into the same bin size, clamped to a realistic range, renormalised to sum=1
function normaliseMachineBins(rawBins, binSize, xMin = -Infinity, xMax = Infinity) {
  const grouped = {};
  rawBins.forEach(({ x, prob }) => {
    if (x < xMin || x > xMax) return;
    const b = Math.floor(x / binSize) * binSize;
    grouped[b] = (grouped[b] || 0) + prob;
  });
  const entries = Object.entries(grouped)
    .map(([x, p]) => ({ x: Number(x), y: p }))
    .sort((a, b) => a.x - b.x);
  const total = entries.reduce((s, e) => s + e.y, 0);
  return total > 0 ? entries.map(e => ({ x: e.x, y: e.y / total })) : entries;
}

function ensureModal() {
  if (document.getElementById('nfl-dist-modal')) return;
  const el = document.createElement('div');
  el.id = 'nfl-dist-modal';
  el.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.75);align-items:center;justify-content:center;padding:1rem;';
  el.innerHTML = `
    <div style="background:#161b24;border:1px solid #2e3a4e;border-radius:16px;width:100%;max-width:min(900px,calc(100vw - 2rem));max-height:90vh;overflow-y:auto;padding:1.5rem;position:relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;">
        <div id="nfl-dist-modal-title" style="font-family:'Barlow Condensed',system-ui,sans-serif;font-size:1.1rem;font-weight:700;color:#e2e8f0;"></div>
        <button id="nfl-dist-modal-close" style="background:none;border:none;color:#4a5568;cursor:pointer;font-size:1.25rem;line-height:1;padding:0.25rem;">✕</button>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;flex-wrap:wrap;gap:0.75rem;">
        <div style="display:flex;align-items:center;gap:1.25rem;font-size:0.75rem;color:#4a5568;">
          <span style="display:flex;align-items:center;gap:5px;">
            <span style="width:18px;height:2px;background:#f59e0b;display:inline-block;border-radius:1px;"></span>BS Machine
          </span>
          <span id="nfl-dist-modal-result-legend" style="display:none;align-items:center;gap:5px;">
            <span style="width:18px;height:2px;background:#f87171;display:inline-block;border-radius:1px;border-top:2px dashed #f87171;"></span>Result
          </span>
        </div>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <div id="nfl-dist-mode-toggle" style="display:flex;gap:2px;background:#0f1117;border:1px solid #2e3a4e;border-radius:6px;padding:2px;">
            <button id="nfl-dist-toggle-pdf" style="padding:3px 10px;border-radius:4px;border:none;font-size:0.7rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;background:#f59e0b;color:#0a0d14;">PDF</button>
            <button id="nfl-dist-toggle-cdf" style="padding:3px 10px;border-radius:4px;border:none;font-size:0.7rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;background:transparent;color:#4a5568;">CDF</button>
            <button id="nfl-dist-toggle-3d" style="padding:3px 10px;border-radius:4px;border:none;font-size:0.7rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;background:transparent;color:#4a5568;">3D</button>
          </div>
          <button id="nfl-dist-download-csv" style="padding:3px 10px;border-radius:4px;border:1px solid #2e3a4e;font-size:0.7rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;background:transparent;color:#4a5568;" title="Download distribution data as CSV">&#8595; CSV</button>
        </div>
      </div>
      <div id="nfl-dist-modal-loading" style="text-align:center;color:#4a5568;font-size:0.875rem;padding:2rem;">Loading distributions…</div>
      <div id="nfl-dist-modal-charts" style="display:none;">
        <div style="margin-bottom:1.5rem;">
          <div style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#4a5568;margin-bottom:0.5rem;">Margin (home – away)</div>
          <canvas id="nfl-dist-modal-margin"></canvas>
        </div>
        <div>
          <div style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#4a5568;margin-bottom:0.5rem;">Total Points</div>
          <canvas id="nfl-dist-modal-total"></canvas>
        </div>
      </div>
      <div id="nfl-dist-modal-3d" style="display:none;height:520px;"></div>
    </div>
  `;
  document.body.appendChild(el);

  el.addEventListener('click', e => { if (e.target === el) closeModal(); });
  document.getElementById('nfl-dist-modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

function closeModal() {
  const modal = document.getElementById('nfl-dist-modal');
  if (modal) modal.style.display = 'none';
  const tt = document.getElementById('nfl-dist-chart-tooltip');
  if (tt) tt.style.display = 'none';
  chartInstances['margin']?.destroy(); delete chartInstances['margin'];
  chartInstances['total']?.destroy();  delete chartInstances['total'];
  const el3d = document.getElementById('nfl-dist-modal-3d');
  if (el3d) purgeDistribution3D(el3d);
}

function ensureTooltipEl() {
  let el = document.getElementById('nfl-dist-chart-tooltip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'nfl-dist-chart-tooltip';
    el.style.cssText = `
      position:absolute; pointer-events:none; display:none;
      background:#0f1117; border:1px solid #2e3a4e; border-radius:8px;
      padding:0.5rem 0.75rem; font-size:0.72rem; color:#e2e8f0;
      line-height:1.6; white-space:nowrap; z-index:99999;
      font-family:'Barlow',system-ui,sans-serif; box-shadow:0 4px 16px rgba(0,0,0,0.5);
    `;
    document.body.appendChild(el);
  }
  return el;
}

function cdf(bins, x) {
  let gte = 0, lte = 0;
  for (const b of (bins || [])) {
    if (b.x >= x) gte += b.y;
    if (b.x <= x) lte += b.y;
  }
  return { gte: Math.min(gte, 1), lte: Math.min(lte, 1) };
}

function niceYStep(maxY) {
  const candidates = [0.005, 0.01, 0.02, 0.025, 0.05, 0.10, 0.20];
  return candidates.find(s => maxY / s <= 6 && maxY / s >= 3) ?? 0.05;
}

const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart) {
    if (chart._crosshairX == null) return;
    const { ctx, chartArea: { top, bottom } } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(chart._crosshairX, top);
    ctx.lineTo(chart._crosshairX, bottom);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  },
};

function makeChartOptions(xTitle, machineBinsRef, xLabelFn, mode, xMin, xMax, xStepSize) {
  return {
    responsive: true,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    onHover: (event, _elements, chart) => {
      const tooltipEl = ensureTooltipEl();
      if (!event.native) { chart._crosshairX = null; chart.draw(); tooltipEl.style.display = 'none'; return; }
      chart._crosshairX = event.x;
      chart.draw();

      const xScale = chart.scales.x;
      if (!xScale) { tooltipEl.style.display = 'none'; return; }
      const xVal = xScale.getValueForPixel(event.x);
      if (xVal == null) { tooltipEl.style.display = 'none'; return; }

      const allXs = machineBinsRef.map(b => b.x);
      if (!allXs.length) { tooltipEl.style.display = 'none'; return; }
      const xLo = xMin != null ? xMin : Math.min(...allXs);
      const xHi = xMax != null ? xMax : Math.max(...allXs);
      const nearest = Math.round(Math.max(xLo, Math.min(xHi, xVal)));

      const g = cdf(machineBinsRef, nearest).gte;
      const probs = { over: g, under: 1 - g };
      const pct  = v => `${(v * 100).toFixed(1)}%`;
      const odds = p => p >= 0.00005 ? `$${(1 / p).toFixed(2)}` : '—';
      const labels = xLabelFn ? xLabelFn(nearest) : { over: `≥${nearest}`, under: `<${nearest}` };
      const row = (label, p) => `
        <div style="display:flex;justify-content:space-between;gap:1.5rem;">
          <span>${label}</span>
          <span style="font-variant-numeric:tabular-nums;">${pct(p)} <span style="color:#4a5568;">${odds(p)}</span></span>
        </div>`;

      let html = `<div style="color:#f59e0b;font-weight:600;margin-bottom:0.15rem;">BS Machine</div>`;
      html += probs.under === null ? row(labels.over, probs.over) : `${row(labels.over, probs.over)}${row(labels.under, probs.under)}`;
      tooltipEl.innerHTML = html;
      tooltipEl.style.display = 'block';

      const canvasRect = event.native.target.getBoundingClientRect();
      let left = canvasRect.left + window.scrollX + event.x + 12;
      let top  = canvasRect.top  + window.scrollY + event.y - 10;
      tooltipEl.style.left = `${left}px`;
      tooltipEl.style.top  = `${top}px`;
      const ttRect = tooltipEl.getBoundingClientRect();
      if (ttRect.right > window.innerWidth - 8) {
        tooltipEl.style.left = `${left - ttRect.width - 24}px`;
      }
    },
    scales: {
      x: {
        type: 'linear', offset: false,
        min: xMin, max: xMax,
        title: { display: true, text: xTitle, color: '#4a5568', font: { size: 10, weight: '600' }, padding: { top: 4 } },
        ticks: { ...(xStepSize ? { stepSize: xStepSize } : { maxTicksLimit: 12 }), color: '#4a5568', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'rgba(255,255,255,0.08)' },
      },
      y: {
        display: true,
        min: 0,
        ...(mode === 'cdf' ? { max: 1 } : {}),
        title: {
          display: true,
          text: mode === 'cdf' ? 'Cumulative probability' : 'Relative frequency',
          color: '#4a5568', font: { size: 10, weight: '600' }, padding: { bottom: 4 },
        },
        ticks: {
          color: '#4a5568', font: { size: 9 },
          stepSize: (() => {
            if (mode === 'cdf') return 0.25;
            const maxY = machineBinsRef.length ? Math.max(...machineBinsRef.map(b => b.y)) * 1.15 : 0.15;
            return niceYStep(maxY);
          })(),
          callback: v => `${Math.round(v * 100)}%`,
        },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'rgba(255,255,255,0.08)' },
      },
    },
  };
}

function toCdf(bins) {
  if (!bins.length) return [];
  const sorted = [...bins].sort((a, b) => a.x - b.x);
  let cum = 0;
  const points = sorted.map(b => { cum += b.y; return { x: b.x, y: Math.min(cum, 1) }; });
  return [
    { x: sorted[0].x - 1, y: 0 },
    ...points,
    { x: points[points.length - 1].x + 1, y: 1 },
  ];
}

function makeDatasets(machineData, actualVal, mode) {
  machineData = machineData ?? [];

  if (mode === 'cdf') {
    const machineCdf = toCdf(machineData);
    return [
      ...(machineCdf.length ? [{
        type: 'line', data: machineCdf,
        borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.07)',
        borderWidth: 2, pointRadius: 0, fill: true, tension: 0, order: 2,
      }] : []),
      ...(actualVal !== null && actualVal !== undefined ? [{
        type: 'line', data: [{ x: actualVal, y: 0 }, { x: actualVal, y: 1 }],
        borderColor: '#f87171', borderWidth: 2, borderDash: [5, 3],
        pointRadius: 0, fill: false, tension: 0, order: 1,
      }] : []),
    ];
  }

  const maxY = machineData.length ? Math.max(...machineData.map(d => d.y)) * 1.15 : 0.3;
  return [
    ...(machineData.length ? [{
      type: 'line', data: machineData.map(d => ({ x: d.x, y: d.y })),
      borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.07)',
      borderWidth: 2, pointRadius: 0, fill: true, tension: 0.35, order: 2,
    }] : []),
    ...(actualVal !== null && actualVal !== undefined ? [{
      type: 'line', data: [{ x: actualVal, y: 0 }, { x: actualVal, y: maxY }],
      borderColor: '#f87171', borderWidth: 2, borderDash: [5, 3],
      pointRadius: 0, fill: false, tension: 0, order: 1,
    }] : []),
  ];
}

const marginLabelFn = x => ({ over: `≥ ${x}`, under: `< ${x}` });
const totalLabelFn  = x => ({ over: `Over ${(x - 0.5).toFixed(1)}`, under: `Under ${(x + 0.5).toFixed(1)}` });

const hideTooltip = () => { const el = document.getElementById('nfl-dist-chart-tooltip'); if (el) el.style.display = 'none'; };

export async function openDistModal(title, gameId, actualMargin = null, actualTotal = null) {
  ensureModal();
  const modal   = document.getElementById('nfl-dist-modal');
  const loading = document.getElementById('nfl-dist-modal-loading');
  const charts  = document.getElementById('nfl-dist-modal-charts');
  const dist3d  = document.getElementById('nfl-dist-modal-3d');
  const titleEl = document.getElementById('nfl-dist-modal-title');

  closeModal();
  titleEl.textContent = title;
  loading.style.display = 'block';
  charts.style.display  = 'none';
  dist3d.style.display  = 'none';
  modal.style.display   = 'flex';

  const machineDist = await fetchDistribution(gameId);

  loading.style.display = 'none';
  charts.style.display  = 'block';

  const resultLegend = document.getElementById('nfl-dist-modal-result-legend');
  if (resultLegend) resultLegend.style.display = actualMargin !== null ? 'flex' : 'none';

  const machineMBins = machineDist?.margins ? normaliseMachineBins(machineDist.margins, 1, -60, 60) : [];
  const machineTBins = machineDist?.totals  ? normaliseMachineBins(machineDist.totals,  1,   0, 100) : [];

  const csvBtn = document.getElementById('nfl-dist-download-csv');
  if (csvBtn) {
    csvBtn.onclick = () => {
      const fmt = v => v != null ? v.toFixed(6) : '0.000000';
      const rows = ['Margin (home-away),BS Machine'];
      machineMBins.forEach(b => rows.push(`${b.x},${fmt(b.y)}`));
      rows.push('');
      rows.push('Total Points,BS Machine');
      machineTBins.forEach(b => rows.push(`${b.x},${fmt(b.y)}`));

      const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const safeName = (title || 'distributions').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '_');
      a.href     = url;
      a.download = `${safeName}_distributions.csv`;
      a.click();
      URL.revokeObjectURL(url);
    };
  }

  function renderCharts(mode) {
    chartInstances['margin']?.destroy(); delete chartInstances['margin'];
    chartInstances['total']?.destroy();  delete chartInstances['total'];

    const mCtx = document.getElementById('nfl-dist-modal-margin')?.getContext('2d');
    if (mCtx) {
      chartInstances['margin'] = new Chart(mCtx, {
        data: { datasets: makeDatasets(machineMBins, actualMargin, mode) },
        options: makeChartOptions('Margin (home – away, pts)', machineMBins, marginLabelFn, mode, -60, 60),
        plugins: [crosshairPlugin],
      });
      mCtx.canvas.addEventListener('mouseleave', hideTooltip);
      mCtx.canvas.addEventListener('pointerleave', hideTooltip);
      mCtx.canvas.style.touchAction = 'pan-y';
      mCtx.canvas.style.userSelect = 'none';
    }

    const tCtx = document.getElementById('nfl-dist-modal-total')?.getContext('2d');
    if (tCtx) {
      chartInstances['total'] = new Chart(tCtx, {
        data: { datasets: makeDatasets(machineTBins, actualTotal, mode) },
        options: makeChartOptions('Total points', machineTBins, totalLabelFn, mode, 0, 100, 4),
        plugins: [crosshairPlugin],
      });
      tCtx.canvas.addEventListener('mouseleave', hideTooltip);
      tCtx.canvas.addEventListener('pointerleave', hideTooltip);
      tCtx.canvas.style.touchAction = 'pan-y';
      tCtx.canvas.style.userSelect = 'none';
    }
  }

  renderCharts('pdf');

  const pdfBtn = document.getElementById('nfl-dist-toggle-pdf');
  const cdfBtn = document.getElementById('nfl-dist-toggle-cdf');
  const btn3d  = document.getElementById('nfl-dist-toggle-3d');

  function setMode(mode) {
    const active   = { background: '#f59e0b', color: '#0a0d14' };
    const inactive = { background: 'transparent', color: '#4a5568' };
    Object.assign(pdfBtn.style, mode === 'pdf' ? active : inactive);
    Object.assign(cdfBtn.style, mode === 'cdf' ? active : inactive);
    Object.assign(btn3d.style,  mode === '3d'  ? active : inactive);

    if (mode === '3d') {
      charts.style.display = 'none';
      dist3d.style.display = 'block';
      renderDistribution3D(dist3d, { sport: 'nfl', id: gameId });
    } else {
      dist3d.style.display = 'none';
      purgeDistribution3D(dist3d);
      charts.style.display = 'block';
      renderCharts(mode);
    }
  }
  pdfBtn.onclick = () => setMode('pdf');
  cdfBtn.onclick = () => setMode('cdf');
  btn3d.onclick  = () => setMode('3d');
}
