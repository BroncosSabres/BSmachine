// predictions.js

const container = document.getElementById("predictions-container");
const TRYSCORER_API = 'https://bsmachine-backend.onrender.com/api';

// --- STATE ---
// All rounds are 1-indexed round numbers (same as display)
let latestRound  = 1;  // highest round with matches in current season
let currentRound = 1;  // currently selected round
let tryscorerMatchCache = null;

const teamColors = {
  "Broncos":   "#760135",
  "Raiders":   "#32CD32",
  "Bulldogs":  "#00539F",
  "Sharks":    "#00A9D8",
  "Dolphins":  "#E0121A",
  "Titans":    "#009DDC",
  "Manly":     "#6F163D",
  "Storm":     "#632390",
  "Knights":   "#EE3524",
  "Cowboys":   "#002B5C",
  "Eels":      "#006EB5",
  "Panthers":  "#000000",
  "Rabbitohs": "#025D17",
  "Dragons":   "#E2231B",
  "Roosters":  "#E82C2E",
  "Warriors":  "#231F20",
  "Tigers":    "#F57600",
};

const slugToShortName = {
  broncos: 'Broncos', bulldogs: 'Bulldogs', cowboys: 'Cowboys', dolphins: 'Dolphins',
  dragons: 'Dragons', eels: 'Eels', knights: 'Knights', manly: 'Manly',
  panthers: 'Panthers', rabbitohs: 'Rabbitohs', raiders: 'Raiders', roosters: 'Roosters',
  sharks: 'Sharks', storm: 'Storm', tigers: 'Tigers', titans: 'Titans', warriors: 'Warriors',
};

function teamColor(name) {
  const short = slugToShortName[teamSlug(name)] ?? name;
  return teamColors[short] ?? "#6b7280";
}

// Interpolates red→amber→green based on a 0–1 position (0 = red, 1 = green)
function bucketColor(fraction) {
  const stops = [
    { r: 244, g: 63,  b: 94  }, // 0%   rose-500
    { r: 251, g: 146, b: 60  }, // 25%  orange-400
    { r: 250, g: 204, b: 21  }, // 50%  yellow-400
    { r: 163, g: 230, b: 53  }, // 75%  lime-400
    { r: 74,  g: 222, b: 128 }, // 100% green-400
  ];
  const scaled = Math.max(0, Math.min(1, fraction)) * (stops.length - 1);
  const lo = Math.floor(scaled), hi = Math.min(lo + 1, stops.length - 1);
  const t  = scaled - lo;
  const a  = stops[lo], b = stops[hi];
  const r  = Math.round(a.r + (b.r - a.r) * t);
  const g  = Math.round(a.g + (b.g - a.g) * t);
  const bv = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bv})`;
}

function teamSlug(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('broncos'))              return 'broncos';
  if (n.includes('bulldogs'))             return 'bulldogs';
  if (n.includes('cowboys'))              return 'cowboys';
  if (n.includes('dolphins'))             return 'dolphins';
  if (n.includes('dragons'))              return 'dragons';
  if (n.includes('eels') || n.includes('parramatta')) return 'eels';
  if (n.includes('knights'))              return 'knights';
  if (n.includes('sea eagles') || n.includes('manly')) return 'manly';
  if (n.includes('panthers'))             return 'panthers';
  if (n.includes('rabbitohs'))            return 'rabbitohs';
  if (n.includes('raiders'))              return 'raiders';
  if (n.includes('roosters'))             return 'roosters';
  if (n.includes('sharks'))               return 'sharks';
  if (n.includes('storm'))                return 'storm';
  if (n.includes('tigers'))               return 'tigers';
  if (n.includes('titans'))               return 'titans';
  if (n.includes('warriors'))             return 'warriors';
  return n.replace(/\s+/g, '_');
}

function logoUrl(teamName) {
  return `../logos/${teamSlug(teamName)}.svg`;
}

// --- USER MODEL: STATS HELPERS ---
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

// Adaptive bin size: small n = exact values (bin 1), large n = grouped bins
function adaptiveBinSize(n) {
  if (n < 5)   return 1;
  if (n < 15)  return 2;
  if (n < 40)  return 4;
  if (n < 100) return 6;
  return 8;
}

// Bin raw pick values into a histogram normalised to max=1
// Normalise pick counts to relative frequency (sum = 1, directly comparable to machine)
function binPickValues(values, binSize) {
  if (!values.length) return [];
  const min = Math.floor(Math.min(...values) / binSize) * binSize;
  const max = Math.floor(Math.max(...values) / binSize) * binSize;
  const counts = {};
  for (let b = min; b <= max; b += binSize) counts[b] = 0;
  values.forEach(v => {
    const b = Math.floor(v / binSize) * binSize;
    counts[b] = (counts[b] || 0) + 1;
  });
  const entries = Object.entries(counts).map(([x, c]) => ({ x: Number(x), y: c })).sort((a, b) => a.x - b.x);
  const total = entries.reduce((sum, e) => sum + e.y, 0);
  return entries.map(e => ({ x: e.x, y: total > 0 ? e.y / total : 0 }));
}

// Group machine bins into the same bin size, preserving prob values (sum ≈ 1)
function normaliseMachineBins(rawBins, binSize) {
  const grouped = {};
  rawBins.forEach(({ x, prob }) => {
    const b = Math.floor(x / binSize) * binSize;
    grouped[b] = (grouped[b] || 0) + prob;
  });
  return Object.entries(grouped)
    .map(([x, p]) => ({ x: Number(x), y: p }))
    .sort((a, b) => a.x - b.x);
}

// --- USER MODEL: MACHINE DISTRIBUTION FETCH ---
const machineDistCache = {};
const chartInstances   = {};

async function fetchMachineDistributions(matchId) {
  if (machineDistCache[matchId]) return machineDistCache[matchId];
  try {
    const res  = await fetch(`${TRYSCORER_API}/match_score_distributions/${matchId}`);
    const data = await res.json();
    if (data.error) return null;
    machineDistCache[matchId] = data;
    return data;
  } catch { return null; }
}

// --- USER MODEL: PICKS FETCH ---
const userPicksCache = {};

async function fetchUserPicksForRound(displayRound) {
  if (userPicksCache[displayRound]) return userPicksCache[displayRound];

  try {
    const res  = await fetch(`${TRYSCORER_API}/round_picks/${displayRound}/nrl`);
    const data = await res.json();
    // Normalise into the same shape the rest of the code expects
    const byGame = data.byGame || {};
    // games list (used elsewhere as a fallback array) — derive from byGame keys
    const games = Object.entries(byGame).map(([game_id, d]) => ({
      game_id: Number(game_id), home_team: d.home_team, away_team: d.away_team,
    }));
    userPicksCache[displayRound] = { byGame, games };
  } catch {
    userPicksCache[displayRound] = { byGame: {}, games: [] };
  }

  return userPicksCache[displayRound];
}

// Returns pick data for a game by direct match_id lookup (game_id == matches.id)
function findPicksForMatch(result, matchId) {
  if (!result) return null;
  const picks = result.byGame[`${matchId}`];
  return { margins: [], totals: [], ...(picks || {}), matchId };
}

// --- DISTRIBUTION MODAL ---
let modalMcid = null, modalTcid = null;

function ensureModal() {
  if (document.getElementById('dist-modal')) return;
  const el = document.createElement('div');
  el.id = 'dist-modal';
  el.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.75);align-items:center;justify-content:center;padding:1rem;';
  el.innerHTML = `
    <div style="background:#161b24;border:1px solid #2e3a4e;border-radius:16px;width:100%;max-width:min(900px,calc(100vw - 2rem));max-height:90vh;overflow-y:auto;padding:1.5rem;position:relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;">
        <div id="dist-modal-title" style="font-family:'Barlow Condensed',system-ui,sans-serif;font-size:1.1rem;font-weight:700;color:#e2e8f0;"></div>
        <button id="dist-modal-close" style="background:none;border:none;color:#4a5568;cursor:pointer;font-size:1.25rem;line-height:1;padding:0.25rem;">✕</button>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;">
        <div style="display:flex;align-items:center;gap:1.25rem;font-size:0.75rem;color:#4a5568;">
          <span style="display:flex;align-items:center;gap:5px;">
            <span style="width:18px;height:2px;background:#f59e0b;display:inline-block;border-radius:1px;"></span>BS Machine
          </span>
          <span style="display:flex;align-items:center;gap:5px;">
            <span style="width:12px;height:12px;background:rgba(96,165,250,0.45);display:inline-block;border-radius:2px;border:1px solid rgba(96,165,250,0.7);"></span>User Model
          </span>
          <span id="dist-modal-result-legend" style="display:none;align-items:center;gap:5px;">
            <span style="width:18px;height:2px;background:#f87171;display:inline-block;border-radius:1px;border-top:2px dashed #f87171;"></span>Result
          </span>
        </div>
        <div id="dist-mode-toggle" style="display:flex;gap:2px;background:#0f1117;border:1px solid #2e3a4e;border-radius:6px;padding:2px;">
          <button id="dist-toggle-pdf" style="padding:3px 10px;border-radius:4px;border:none;font-size:0.7rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;background:#f59e0b;color:#0a0d14;">PDF</button>
          <button id="dist-toggle-cdf" style="padding:3px 10px;border-radius:4px;border:none;font-size:0.7rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;background:transparent;color:#4a5568;">CDF</button>
        </div>
      </div>
      <div id="dist-modal-loading" style="text-align:center;color:#4a5568;font-size:0.875rem;padding:2rem;">Loading distributions…</div>
      <div id="dist-modal-charts" style="display:none;">
        <div style="margin-bottom:1.5rem;">
          <div style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#4a5568;margin-bottom:0.5rem;">Margin (home – away)</div>
          <canvas id="dist-modal-margin"></canvas>
        </div>
        <div>
          <div style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#4a5568;margin-bottom:0.5rem;">Total Points</div>
          <canvas id="dist-modal-total"></canvas>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  el.addEventListener('click', e => { if (e.target === el) closeModal(); });
  document.getElementById('dist-modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

function closeModal() {
  const modal = document.getElementById('dist-modal');
  if (modal) modal.style.display = 'none';
  const tt = document.getElementById('dist-chart-tooltip');
  if (tt) tt.style.display = 'none';
  chartInstances['modal-margin']?.destroy(); delete chartInstances['modal-margin'];
  chartInstances['modal-total']?.destroy();  delete chartInstances['modal-total'];
}

async function openDistModal(title, pickData, matchId, actualMargin = null, actualTotal = null) {
  ensureModal();
  const modal    = document.getElementById('dist-modal');
  const loading  = document.getElementById('dist-modal-loading');
  const charts   = document.getElementById('dist-modal-charts');
  const titleEl  = document.getElementById('dist-modal-title');

  // Reset state
  closeModal();
  titleEl.textContent = title;
  loading.style.display = 'block';
  charts.style.display  = 'none';
  modal.style.display   = 'flex';

  const machineDist = await fetchMachineDistributions(matchId);

  loading.style.display = 'none';
  charts.style.display  = 'block';

  const resultLegend = document.getElementById('dist-modal-result-legend');
  if (resultLegend) resultLegend.style.display = actualMargin !== null ? 'flex' : 'none';

  // Crosshair plugin — draws a faint vertical line at the cursor
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

  // Ensure a single shared tooltip div exists in the modal
  function ensureTooltipEl() {
    let el = document.getElementById('dist-chart-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dist-chart-tooltip';
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
    // bins: [{x, y}] normalised probabilities
    let gte = 0, lte = 0;
    for (const b of bins) {
      if (b.x >= x) gte += b.y;
      if (b.x <= x) lte += b.y;
    }
    return { gte: Math.min(gte, 1), lte: Math.min(lte, 1) };
  }

  function makeChartOptions(xTitle, machineBinsRef, userBinsRef, xLabelFn, mode = 'pdf') {
    return {
      responsive: true,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      onHover: (event, _elements, chart) => {
        const tooltipEl = ensureTooltipEl();
        if (!event.native) { chart._crosshairX = null; chart.draw(); tooltipEl.style.display = 'none'; return; }
        chart._crosshairX = event.x;
        chart.draw();

        // Get x value at cursor
        const xScale = chart.scales.x;
        if (!xScale) { tooltipEl.style.display = 'none'; return; }
        const xVal = xScale.getValueForPixel(event.x);
        if (xVal == null) { tooltipEl.style.display = 'none'; return; }

        // Find nearest bin x in either dataset
        const allXs = [...machineBinsRef.map(b => b.x), ...userBinsRef.map(b => b.x)];
        if (!allXs.length) { tooltipEl.style.display = 'none'; return; }
        const nearest = allXs.reduce((a, b) => Math.abs(b - xVal) < Math.abs(a - xVal) ? b : a);

        const mc = machineBinsRef.length ? cdf(machineBinsRef, nearest) : null;
        const uc = userBinsRef.length    ? cdf(userBinsRef,    nearest) : null;

        const pct = v => `${(v * 100).toFixed(1)}%`;
        const labels = xLabelFn ? xLabelFn(nearest) : { over: `≥${nearest}`, under: `<${nearest}` };
        const odds = p => p > 0 ? `$${(1 / p).toFixed(2)}` : '—';
        const row = (label, p) => `
          <div style="display:flex;justify-content:space-between;gap:1.5rem;">
            <span>${label}</span>
            <span style="font-variant-numeric:tabular-nums;">${pct(p)} <span style="color:#4a5568;">${odds(p)}</span></span>
          </div>`;
        let html = '';
        if (mc) html += `
          <div style="color:#f59e0b;font-weight:600;margin-bottom:0.15rem;">BS Machine</div>
          ${row(labels.over, mc.gte)}${row(labels.under, 1 - mc.gte)}`;
        if (uc) html += `
          <div style="color:#60a5fa;font-weight:600;margin-top:0.4rem;margin-bottom:0.15rem;">User Model</div>
          ${row(labels.over, uc.gte)}${row(labels.under, 1 - uc.gte)}`;

        tooltipEl.innerHTML = html;
        tooltipEl.style.display = 'block';

        const canvasRect = event.native.target.getBoundingClientRect();
        let left = canvasRect.left + window.scrollX + event.x + 12;
        let top  = canvasRect.top  + window.scrollY + event.y - 10;
        // Prevent overflow off right edge
        tooltipEl.style.left = `${left}px`;
        tooltipEl.style.top  = `${top}px`;
        // After render, check right edge
        const ttRect = tooltipEl.getBoundingClientRect();
        if (ttRect.right > window.innerWidth - 8) {
          tooltipEl.style.left = `${left - ttRect.width - 24}px`;
        }
      },
      scales: {
        x: {
          type: 'linear', offset: false,
          title: { display: true, text: xTitle, color: '#4a5568', font: { size: 10, weight: '600' }, padding: { top: 4 } },
          ticks: { maxTicksLimit: 12, color: '#4a5568', font: { size: 10 } },
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
            ...(mode === 'cdf' ? { stepSize: 0.25 } : { stepSize: 0.25 }),
            callback: v => `${Math.round(v * 100)}%`,
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.08)' },
        },
      },
    };
  }

  const userBinM       = adaptiveBinSize(pickData.margins.length);
  const userBinT       = adaptiveBinSize(pickData.totals.length);
  const userMarginBins = binPickValues(pickData.margins, userBinM);
  const userTotalBins  = binPickValues(pickData.totals,  userBinT);

  // Build sorted cumulative bins from normalised {x,y} bins.
  // Sentinel points anchor the curve to 0 before the first bin and 1 after the last.
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

  function makeDatasets(machineBins, userBins, machineGroupBin, actualVal, mode = 'pdf') {
    const machineData = machineBins ? normaliseMachineBins(machineBins, machineGroupBin) : [];
    if (mode === 'cdf') {
      const machineCdf = toCdf(machineData);
      const userCdf    = toCdf(userBins);
      return [
        ...(machineCdf.length ? [{
          type: 'line',
          data: machineCdf,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.07)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0,
          order: 3,
        }] : []),
        ...(userCdf.length ? [{
          type: 'line',
          data: userCdf,
          borderColor: 'rgba(96,165,250,0.9)',
          backgroundColor: 'rgba(96,165,250,0.07)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0,
          order: 2,
        }] : []),
        ...(actualVal !== null && actualVal !== undefined ? [{
          type: 'line',
          data: [{ x: actualVal, y: 0 }, { x: actualVal, y: 1 }],
          borderColor: '#f87171',
          borderWidth: 2,
          borderDash: [5, 3],
          pointRadius: 0,
          fill: false,
          tension: 0,
          order: 1,
        }] : []),
      ];
    }
    // PDF mode
    const allY = [...machineData.map(d => d.y), ...userBins.map(d => d.y)];
    const maxY  = allY.length ? Math.max(...allY) * 1.15 : 0.3;
    return [
      ...(machineData.length ? [{
        type: 'line',
        data: machineData.map(d => ({ x: d.x, y: d.y })),
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245,158,11,0.07)',
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.35,
        order: 3,
      }] : []),
      {
        type: 'bar',
        data: userBins.map(d => ({ x: d.x, y: d.y })),
        backgroundColor: 'rgba(96,165,250,0.4)',
        borderColor: 'rgba(96,165,250,0.7)',
        borderWidth: 1,
        barPercentage: 0.85,
        categoryPercentage: 1,
        order: 2,
      },
      ...(actualVal !== null && actualVal !== undefined ? [{
        type: 'line',
        data: [{ x: actualVal, y: 0 }, { x: actualVal, y: maxY }],
        borderColor: '#f87171',
        borderWidth: 2,
        borderDash: [5, 3],
        pointRadius: 0,
        fill: false,
        tension: 0,
        order: 1,
      }] : []),
    ];
  }

  const machineMBins = machineDist?.margins ? normaliseMachineBins(machineDist.margins, 2) : [];
  const machineTBins = machineDist?.totals  ? normaliseMachineBins(machineDist.totals,  2) : [];

  const homeTeam = pickData?.home_team || 'Home';
  const awayTeam = pickData?.away_team || 'Away';

  const marginLabelFn = x => {
    if (x >= 0) {
      const line = x === 0 ? '0.5' : (x - 0.5).toFixed(1);
      return { over: `${homeTeam} -${line}`, under: `${awayTeam} +${line}` };
    } else {
      // Away team is winning at this margin. Keep winner-/loser+ convention:
      // awayTeam -line = away gives points (covers only if they win by even more) → low prob → under
      // homeTeam +line = home receives points (covers easily) → high prob → over
      const line = (-x - 0.5).toFixed(1);
      return { over: `${homeTeam} +${line}`, under: `${awayTeam} -${line}` };
    }
  };
  const totalLabelFn = x => {
    const line = (x - 0.5).toFixed(1);
    return { over: `Over ${line}`, under: `Under ${line}` };
  };

  const hideTooltip = () => { const el = document.getElementById('dist-chart-tooltip'); if (el) el.style.display = 'none'; };

  function renderCharts(mode) {
    chartInstances['modal-margin']?.destroy(); delete chartInstances['modal-margin'];
    chartInstances['modal-total']?.destroy();  delete chartInstances['modal-total'];

    const mCtx = document.getElementById('dist-modal-margin')?.getContext('2d');
    if (mCtx) {
      chartInstances['modal-margin'] = new Chart(mCtx, {
        data: { datasets: makeDatasets(machineDist?.margins, userMarginBins, 2, actualMargin, mode) },
        options: makeChartOptions('Margin (home – away, pts)', machineMBins, userMarginBins, marginLabelFn, mode),
        plugins: [crosshairPlugin],
      });
      mCtx.canvas.addEventListener('mouseleave', hideTooltip);
    }

    const tCtx = document.getElementById('dist-modal-total')?.getContext('2d');
    if (tCtx) {
      chartInstances['modal-total'] = new Chart(tCtx, {
        data: { datasets: makeDatasets(machineDist?.totals, userTotalBins, 2, actualTotal, mode) },
        options: makeChartOptions('Total points', machineTBins, userTotalBins, totalLabelFn, mode),
        plugins: [crosshairPlugin],
      });
      tCtx.canvas.addEventListener('mouseleave', hideTooltip);
    }
  }

  renderCharts('pdf');

  // Toggle buttons
  const pdfBtn = document.getElementById('dist-toggle-pdf');
  const cdfBtn = document.getElementById('dist-toggle-cdf');
  function setMode(mode) {
    const active   = { background: '#f59e0b', color: '#0a0d14' };
    const inactive = { background: 'transparent', color: '#4a5568' };
    Object.assign(pdfBtn.style, mode === 'pdf' ? active : inactive);
    Object.assign(cdfBtn.style, mode === 'cdf' ? active : inactive);
    renderCharts(mode);
  }
  pdfBtn.onclick = () => setMode('pdf');
  cdfBtn.onclick = () => setMode('cdf');
}

// --- USER MODEL: RENDER ---
function renderUserModel(card, matchKey, pickData, modelHomeScore, modelAwayScore) {
  const slot = card.querySelector('.js-user-model');
  if (!slot) return;

  const n         = pickData?.margins?.length ?? 0;
  const medMargin = n > 0 ? median(pickData.margins) : null;
  const medTotal  = n > 0 ? median(pickData.totals)  : null;
  const matchId   = pickData?.matchId ?? null;

  const userHome = (medMargin !== null && medTotal !== null) ? Math.round((medTotal + medMargin) / 2) : null;
  const userAway = (medMargin !== null && medTotal !== null) ? Math.round((medTotal - medMargin) / 2) : null;

  // Fraction of picks predicting home win
  const userHomeWinFrac = n > 0 ? pickData.margins.filter(m => m > 0).length / n : null;
  const userAwayWinFrac = userHomeWinFrac !== null ? 1 - userHomeWinFrac : null;
  const userHomeWin     = userHomeWinFrac !== null && userHomeWinFrac >= 0.5;
  const userHomePct     = userHomeWinFrac !== null ? (userHomeWinFrac * 100).toFixed(1) : null;
  const userAwayPct     = userAwayWinFrac !== null ? (userAwayWinFrac * 100).toFixed(1) : null;
  const userHomeOdds    = userHomeWinFrac > 0 ? (1 / userHomeWinFrac).toFixed(2) : null;
  const userAwayOdds    = userAwayWinFrac > 0 ? (1 / userAwayWinFrac).toFixed(2) : null;

  const homeColor = teamColor(matchKey.split('_v_')[0]);
  const awayColor = teamColor(matchKey.split('_v_')[1]);
  const canExpand = n > 0 && matchId !== null;
  const gameTitle = matchKey.replace('_v_', ' vs ').replace(/_/g, ' ');

  const userBar = n > 0 ? `
    <div class="flex w-full items-center" style="border:1px solid rgba(255,255,255,0.25); border-radius:5px; overflow:hidden;">
      <div style="width:${userHomePct}%; background:${homeColor}; height:8px; opacity:${userHomeWin ? '1' : '0.4'}; border-right:1px solid rgba(255,255,255,0.6); transition:width 0.6s ease;"></div>
      <div style="width:${userAwayPct}%; background:${awayColor}; height:8px; opacity:${userHomeWin ? '0.4' : '1'}; transition:width 0.6s ease;"></div>
    </div>` : `
    <div class="flex w-full items-center" style="border:1px solid rgba(255,255,255,0.1); border-radius:5px; overflow:hidden; height:8px; background:rgba(255,255,255,0.05);"></div>`;

  slot.innerHTML = `
    <div class="mt-3 pt-3 border-t border-gray-700">

      <!-- DESKTOP layout — mirrors BS model exactly -->
      <div class="hidden md:flex items-center justify-between gap-4">
        <div class="flex-1 min-w-0">
          <div class="text-xs text-gray-500">User Model</div>
        </div>
        <div class="flex flex-col items-center gap-1.5 w-64">
          ${n > 0 ? `
          <div class="flex items-center justify-between w-full text-sm font-bold">
            <div class="flex flex-col items-start">
              <span class="${userHomeWin ? 'text-white' : 'text-gray-500'}">${userHomePct}%</span>
              <span class="text-xs font-normal text-gray-500">${userHomeOdds ? '$' + userHomeOdds : ''}</span>
            </div>
            <span class="text-gray-600 text-xs font-normal px-2">vs</span>
            <div class="flex flex-col items-end">
              <span class="${!userHomeWin ? 'text-white' : 'text-gray-500'}">${userAwayPct}%</span>
              <span class="text-xs font-normal text-gray-500">${userAwayOdds ? '$' + userAwayOdds : ''}</span>
            </div>
          </div>` : `<div class="text-xs text-gray-600 italic w-full text-center pb-1">No picks yet</div>`}
          ${userBar}
          ${userHome !== null ? `<div class="text-2xl font-bold font-mono text-white tracking-wide mt-1">${userHome} – ${userAway}</div>` : ''}
          ${canExpand ? `<button class="js-dist-btn flex items-center gap-1.5 mt-1 px-2.5 py-1 rounded-lg border border-gray-600 hover:border-amber-500 hover:text-amber-400 transition-colors text-xs text-gray-300 font-medium" style="background:rgba(255,255,255,0.04);cursor:pointer;"><svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor" style="flex-shrink:0;opacity:0.85"><rect x="1" y="10" width="3" height="9" rx="1"/><rect x="6" y="6" width="3" height="13" rx="1"/><rect x="11" y="3" width="3" height="16" rx="1"/><rect x="16" y="7" width="3" height="12" rx="1"/></svg>${n} pick${n !== 1 ? 's' : ''} · Show Probability Distributions</button>` : `<div class="text-xs text-gray-700 mt-0.5">${n} pick${n !== 1 ? 's' : ''}</div>`}
        </div>
        <div class="flex-1 min-w-0"></div>
      </div>

      <!-- MOBILE layout -->
      <div class="flex flex-col gap-1 md:hidden">
        <div class="flex items-center justify-between text-xs">
          <span class="text-gray-500 font-semibold uppercase tracking-wider">User Model</span>
          ${canExpand ? `<button class="js-dist-btn flex items-center gap-1 px-2 py-0.5 rounded border border-gray-600 hover:border-amber-500 hover:text-amber-400 transition-colors text-gray-300 font-medium" style="background:rgba(255,255,255,0.04);cursor:pointer;font-size:0.7rem;"><svg width="11" height="11" viewBox="0 0 20 20" fill="currentColor" style="flex-shrink:0;"><rect x="1" y="10" width="3" height="9" rx="1"/><rect x="6" y="6" width="3" height="13" rx="1"/><rect x="11" y="3" width="3" height="16" rx="1"/><rect x="16" y="7" width="3" height="12" rx="1"/></svg>${n} pick${n !== 1 ? 's' : ''}</button>` : `<span class="text-gray-700 text-xs">${n} pick${n !== 1 ? 's' : ''}</span>`}
        </div>
        ${n > 0 ? `
        <div class="flex items-center justify-between text-sm font-bold">
          <span class="${userHomeWin ? 'text-white' : 'text-gray-500'}">${userHomePct}%</span>
          ${userHome !== null ? `<span class="font-mono font-bold text-white">${userHome}–${userAway}</span>` : ''}
          <span class="${!userHomeWin ? 'text-white' : 'text-gray-500'}">${userAwayPct}%</span>
        </div>
        ${userBar}` : `<div class="text-xs text-gray-600 italic">No picks yet</div>`}
      </div>

    </div>
  `;

  if (canExpand) {
    slot.querySelectorAll('.js-dist-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const hs = typeof modelHomeScore === 'number' ? modelHomeScore : null;
        const as = typeof modelAwayScore === 'number' ? modelAwayScore : null;
        const aMargin = (hs !== null && as !== null) ? hs - as : null;
        const aTotal  = (hs !== null && as !== null) ? hs + as : null;
        openDistModal(`${gameTitle} — Distributions`, pickData, matchId, aMargin, aTotal);
      });
    });
  }
}

// --- USER MODEL: OVERLAY ALL CARDS FOR ROUND ---
async function updateUserModelOverlays(predictions, displayRound) {
  const result = await fetchUserPicksForRound(displayRound);
  predictions.forEach(pred => {
    const matchKey = `${pred.home_team}_v_${pred.away_team}`;
    const card = container.querySelector(`.match-card[data-match-key="${matchKey}"]`);
    if (!card) return;
    const pickData = findPicksForMatch(result, pred.match_id);
    renderUserModel(card, matchKey, pickData, pred.home_score, pred.away_score);
  });
}

// --- ROUND NAVIGATION ---
function renderRoundNav() {
  const nav = document.getElementById('round-nav');
  if (!nav) return;

  const options = [];
  for (let r = 1; r <= latestRound; r++) {
    const label = r === currentRound ? `Round ${r} (Current)` : `Round ${r}`;
    options.push(`<option value="${r}" ${r === currentRound ? 'selected' : ''}>${label}</option>`);
  }

  nav.innerHTML = `
    <select id="round-select"
      class="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-gray-500 cursor-pointer">
      ${options.join('')}
    </select>
  `;

  const sel = nav.querySelector('#round-select');
  sel.value = String(currentRound);

  sel.addEventListener('change', function () {
    currentRound = Number(this.value);
    loadRound();
  });
}

// --- TRYSCORER MATCH CACHE ---
// Fuzzy match: short names ("Roosters") vs API full names ("Sydney Roosters")
function teamsMatch(shortName, fullName) {
  const s = shortName.toLowerCase();
  const f = fullName.toLowerCase();
  return f.includes(s) || s.includes(f);
}

async function getTryscorerMatches() {
  if (tryscorerMatchCache) return tryscorerMatchCache;
  try {
    const res = await fetch(`${TRYSCORER_API}/current_round_matches/nrl`);
    tryscorerMatchCache = await res.json();
  } catch {
    tryscorerMatchCache = [];
  }
  return tryscorerMatchCache;
}

async function checkTryscorerAvailable(homeTeam, awayTeam) {
  const matches = await getTryscorerMatches();
  const match = matches.find(m =>
    teamsMatch(homeTeam, m.home_team) && teamsMatch(awayTeam, m.away_team)
  );
  if (!match) return { available: false, matchId: null };
  try {
    const res = await fetch(`${TRYSCORER_API}/match_team_lists/${match.match_id}/nrl`);
    const data = await res.json();
    const hasPlayers = data?.home_players?.length > 0 || data?.away_players?.length > 0;
    return { available: hasPlayers, matchId: match.match_id };
  } catch {
    return { available: false, matchId: null };
  }
}

function tryscorerButtonDisabled() {
  return `<span title="Team lists not yet available"
               class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-800 border border-gray-700 text-xs font-medium text-gray-600 cursor-not-allowed select-none">
            <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>
            Tryscorer Predictions
          </span>`;
}

function tryscorerButtonEnabled(matchId) {
  const url = `tryscorer_predictions.html?match_id=${matchId}`;
  return `<a href="${url}"
             class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 border border-gray-600 hover:border-gray-500 text-xs font-medium text-gray-200 transition-colors">
            <svg class="w-3.5 h-3.5 text-green-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
            Tryscorer Predictions
          </a>`;
}

// --- LIVE SCORE / RESULT LINE PROBABILITY ---

const BACKEND_BASE = 'https://bsmachine-backend.onrender.com';
let liveResultsCache = null;

async function getLiveResults() {
  if (liveResultsCache) return liveResultsCache;
  try {
    const res = await fetch(`${BACKEND_BASE}/latest-results`);
    liveResultsCache = await res.json();
  } catch {
    liveResultsCache = [];
  }
  return liveResultsCache;
}

const lineProbCache = {};

async function fetchResultLineProb(matchId, homeScore, awayScore) {
  const margin = homeScore - awayScore;
  if (margin === 0) return null;

  const cacheKey = `${matchId}_${margin}`;
  if (cacheKey in lineProbCache) return lineProbCache[cacheKey];

  const params = margin > 0 ? `?margin_gte=${margin}` : `?margin_lte=${margin}`;

  try {
    const res = await fetch(`${TRYSCORER_API}/match_sgm_bins_range/${matchId}${params}`);
    const data = await res.json();
    const prob = typeof data.prob === 'number' ? data.prob : null;
    lineProbCache[cacheKey] = prob;
    return prob;
  } catch {
    lineProbCache[cacheKey] = null;
    return null;
  }
}

// Over X.5 = total_gte of the actual total; complement is under
async function fetchTotalProb(matchId, total) {
  const cacheKey = `total_${matchId}_${total}`;
  if (cacheKey in lineProbCache) return lineProbCache[cacheKey];

  try {
    const res = await fetch(`${TRYSCORER_API}/match_sgm_bins_range/${matchId}?total_gte=${total}`);
    const data = await res.json();
    const prob = typeof data.prob === 'number' ? data.prob : null;
    lineProbCache[cacheKey] = prob;
    return prob;
  } catch {
    lineProbCache[cacheKey] = null;
    return null;
  }
}

// Build a season-wide ranked list of all result probabilities (least likely first)
let seasonRankingCache = null;

async function buildSeasonRanking() {
  if (seasonRankingCache) return seasonRankingCache;

  // Fetch all rounds' match data in parallel
  const roundFetches = [];
  for (let r = 1; r <= latestRound; r++) {
    if (r === latestRound) {
      roundFetches.push(
        Promise.all([getLiveResults(), getTryscorerMatches()]).then(([live, curr]) =>
          curr.map(m => {
            const l = live.find(lv => teamsMatch(m.home_team, lv.home) && teamsMatch(m.away_team, lv.away));
            return l ? { ...m, home_score: l.home_score, away_score: l.away_score } : m;
          })
        )
      );
    } else {
      roundFetches.push(getRoundMatches(r));
    }
  }

  const seenIds = new Set();
  const allMatches = (await Promise.all(roundFetches)).flat().filter(m => {
    if (!m.match_id || seenIds.has(m.match_id)) return false;
    seenIds.add(m.match_id);
    return true;
  });

  // Compute probabilities for all completed matches in parallel (cache means no double-fetch)
  const entries = await Promise.all(
    allMatches
      .filter(m => typeof m.home_score === 'number' && typeof m.away_score === 'number' && m.home_score !== m.away_score)
      .map(async m => {
        const prob = await fetchResultLineProb(m.match_id, m.home_score, m.away_score);
        if (prob === null) return null;
        const margin    = m.home_score - m.away_score;
        const winner    = margin > 0 ? m.home_team : m.away_team;
        const winMargin = Math.abs(margin);
        return {
          match_id:   m.match_id,
          prob,
          home_team:  m.home_team,
          away_team:  m.away_team,
          home_score: m.home_score,
          away_score: m.away_score,
          round:      m.round_number ?? latestRound,
          lineLabel:  `${winner} -${winMargin - 1}.5`,
        };
      })
  );

  seasonRankingCache = entries.filter(Boolean).sort((a, b) => a.prob - b.prob);
  return seasonRankingCache;
}

// Season-wide ranking of total points probabilities (least likely first)
let totalRankingCache = null;

async function buildTotalRanking() {
  if (totalRankingCache) return totalRankingCache;

  const roundFetches = [];
  for (let r = 1; r <= latestRound; r++) {
    if (r === latestRound) {
      roundFetches.push(
        Promise.all([getLiveResults(), getTryscorerMatches()]).then(([live, curr]) =>
          curr.map(m => {
            const l = live.find(lv => teamsMatch(m.home_team, lv.home) && teamsMatch(m.away_team, lv.away));
            return l ? { ...m, home_score: l.home_score, away_score: l.away_score } : m;
          })
        )
      );
    } else {
      roundFetches.push(getRoundMatches(r));
    }
  }

  const seenIds2 = new Set();
  const allMatches = (await Promise.all(roundFetches)).flat().filter(m => {
    if (!m.match_id || seenIds2.has(m.match_id)) return false;
    seenIds2.add(m.match_id);
    return true;
  });

  const entries = await Promise.all(
    allMatches
      .filter(m => typeof m.home_score === 'number' && typeof m.away_score === 'number')
      .map(async m => {
        const actualTotal = m.home_score + m.away_score;
        const prob = await fetchTotalProb(m.match_id, actualTotal);
        if (prob === null) return null;
        return { match_id: m.match_id, prob };
      })
  );

  totalRankingCache = entries.filter(Boolean).sort((a, b) => a.prob - b.prob);
  return totalRankingCache;
}

async function getRoundMatches(roundNumber) {
  try {
    const res = await fetch(`${TRYSCORER_API}/round_results/${roundNumber}/nrl`);
    return await res.json();
  } catch {
    return [];
  }
}

async function updateLiveScoreOverlays(predictions) {
  let matches;

  if (currentRound === latestRound) {
    // Current round: scores from NRL live API, match IDs from current_round_matches
    const [liveResults, currentMatches] = await Promise.all([getLiveResults(), getTryscorerMatches()]);
    // Merge: attach live scores onto the match objects that have IDs
    matches = currentMatches.map(m => {
      const live = liveResults.find(r =>
        teamsMatch(m.home_team, r.home) && teamsMatch(m.away_team, r.away)
      );
      return live
        ? { ...m, home_score: live.home_score, away_score: live.away_score }
        : m;
    });
  } else {
    // Previous rounds: scores and match IDs from DB
    matches = await getRoundMatches(currentRound);
  }

  const renderedMatchIds = [];

  for (const pred of predictions) {
    const match = matches.find(m =>
      teamsMatch(pred.home_team, m.home_team) && teamsMatch(pred.away_team, m.away_team)
    );
    if (!match) continue;

    const homeScore = match.home_score;
    const awayScore = match.away_score;
    if (homeScore === null || homeScore === undefined) continue;
    if (awayScore === null || awayScore === undefined) continue;
    if (typeof homeScore !== 'number' || typeof awayScore !== 'number') continue;

    const margin = homeScore - awayScore;
    if (margin === 0) continue;

    const winner    = margin > 0 ? pred.home_team : pred.away_team;
    const winMargin = Math.abs(margin);
    const lineLabel = `${winner} -${winMargin - 1}.5`;

    const actualTotal = homeScore + awayScore;
    const [prob, overProb] = await Promise.all([
      fetchResultLineProb(match.match_id, homeScore, awayScore),
      fetchTotalProb(match.match_id, actualTotal),
    ]);

    const matchKey = `${pred.home_team}_v_${pred.away_team}`;
    const card = container.querySelector(`.match-card[data-match-key="${matchKey}"]`);
    if (!card) continue;

    const slot = card.querySelector('.js-result-prob');
    if (!slot) continue;
    // Clear loading indicator — will be replaced with actual content
    slot.querySelector('.js-result-loading')?.remove();

    const winnerColor = teamColor(winner);
    const probPct     = prob !== null ? (prob * 100) : null;

    // Colour the margin % by how likely the outcome was
    let probColor = 'text-gray-400';
    if (probPct !== null) {
      if (probPct >= 50)      probColor = 'text-green-400';
      else if (probPct >= 25) probColor = 'text-amber-400';
      else                    probColor = 'text-rose-400';
    }

    // Totals bar: over = teal, under = slate
    const overPct  = overProb !== null ? overProb * 100 : null;
    const underPct = overPct !== null ? 100 - overPct : null;
    const totalsHtml = overPct !== null ? `
      <div class="mt-3 pt-2.5 border-t border-gray-700/50">
        <div class="flex items-center justify-between text-xs mb-1.5">
          <span class="text-gray-500 font-semibold uppercase tracking-wider">Total · ${actualTotal} pts</span>
          <span class="js-total-rank text-right"></span>
        </div>
        <div class="flex items-center justify-between text-xs mb-1">
          <span class="font-semibold" style="color:${bucketColor(overPct / 100)}">Over ${actualTotal - 0.5} &nbsp;${overPct.toFixed(1)}%</span>
          <span class="font-semibold" style="color:${bucketColor(underPct / 100)}">${underPct.toFixed(1)}% &nbsp;Under ${actualTotal + 0.5}</span>
        </div>
        <div class="flex w-full" style="height:6px; border-radius:4px; border:1px solid rgba(255,255,255,0.15); overflow:hidden; gap:1px; background:rgba(255,255,255,0.15);">
          <div style="width:${overPct.toFixed(1)}%; background:${bucketColor(overPct / 100)}; height:100%; transition:width 0.8s ease;"></div>
          <div style="width:${underPct.toFixed(1)}%; background:${bucketColor(underPct / 100)}; height:100%; transition:width 0.8s ease;"></div>
        </div>
      </div>` : '';

    slot.innerHTML = `
      <div class="mt-3 rounded-lg overflow-hidden" style="border:1px solid rgba(255,255,255,0.07); background:rgba(255,255,255,0.03);">
        <div class="px-3 pt-2.5 pb-2.5">
          <div class="flex items-center justify-between gap-3 mb-2">
            <!-- Left: result info stacked -->
            <div class="flex flex-col gap-0.5 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-xs font-semibold uppercase tracking-wider text-gray-500">Result</span>
                <span class="text-gray-600">·</span>
                <span class="font-mono font-bold text-white">${homeScore}–${awayScore}</span>
              </div>
              <span class="text-sm font-semibold text-white truncate">${lineLabel}</span>
            </div>
            <!-- Right: likelihood + probability -->
            ${probPct !== null ? `
            <div class="shrink-0 flex items-center gap-3">
              <span class="js-season-rank text-right"></span>
              <div class="text-right leading-none">
                <div class="text-xl font-bold ${probColor}">${probPct.toFixed(1)}%</div>
                <div class="text-xs text-gray-500 mt-0.5">$${(1 / prob).toFixed(2)}</div>
              </div>
            </div>` : ''}
          </div>
          ${probPct !== null ? `
          <div class="w-full rounded-full" style="height:4px; background:rgba(255,255,255,0.08);">
            <div style="width:${Math.min(probPct, 100)}%; height:100%; background:${winnerColor}; border-radius:9999px; transition:width 0.8s ease;"></div>
          </div>` : ''}
          ${totalsHtml}
        </div>
      </div>
    `;

    renderedMatchIds.push({ matchId: match.match_id, matchKey });
  }

  // Clear any remaining loading indicators (cards with no result yet)
  container.querySelectorAll('.js-result-loading').forEach(el => el.remove());

  // Phase 2: fill margin likelihood badges
  buildSeasonRanking().then(ranking => {
    renderedMatchIds.forEach(({ matchId, matchKey }) => {
      const idx = ranking.findIndex(r => r.match_id === matchId);
      if (idx === -1) return;
      const rank  = idx + 1;
      const total = ranking.length;
      const card   = container.querySelector(`.match-card[data-match-key="${matchKey}"]`);
      const rankEl = card?.querySelector('.js-season-rank');
      if (rankEl) rankEl.innerHTML = `<div class="text-gray-500 text-xs uppercase tracking-wider leading-none mb-0.5">Likelihood</div><div class="text-gray-300 text-sm font-semibold leading-none">${total - rank + 1}/${total}</div>`;
    });
  });

  // Phase 2: fill total points likelihood badges
  buildTotalRanking().then(ranking => {
    renderedMatchIds.forEach(({ matchId, matchKey }) => {
      const idx = ranking.findIndex(r => r.match_id === matchId);
      if (idx === -1) return;
      const rank  = idx + 1;
      const total = ranking.length;
      const card    = container.querySelector(`.match-card[data-match-key="${matchKey}"]`);
      const rankEl  = card?.querySelector('.js-total-rank');
      if (rankEl) rankEl.innerHTML = `<div class="text-gray-500 text-xs uppercase tracking-wider leading-none mb-0.5">Likelihood</div><div class="text-gray-300 text-sm font-semibold leading-none">${total - rank + 1}/${total}</div>`;
    });
  });
}

// --- MATCH CARD ---
function createMatchCard(data) {
  const { home_team, away_team, home_score, away_score, home_perc, away_perc } = data;
  const matchKey = `${home_team}_v_${away_team}`;

  const homeWin = home_perc >= away_perc;
  const homePercValue   = home_perc * 100;
  const awayPercValue   = away_perc * 100;
  const homePercDisplay = homePercValue.toFixed(1);
  const awayPercDisplay = awayPercValue.toFixed(1);
  const homeFairOdds    = (1 / home_perc).toFixed(2);
  const awayFairOdds    = (1 / away_perc).toFixed(2);
  const expectedTotal   = home_score + away_score;
  const homeColor       = teamColor(home_team);
  const awayColor       = teamColor(away_team);

  const card = document.createElement("div");
  card.className = "match-card";
  card.dataset.matchKey = matchKey;

  const bar = `
    <div class="flex w-full items-center" style="border:1px solid rgba(255,255,255,0.25); border-radius:5px; overflow:hidden;">
      <div class="prob-bar-home" style="width:${homePercValue}%; background:${homeColor}; height:8px; opacity:${homeWin ? '1' : '0.4'}; border-right:1px solid rgba(255,255,255,0.6)"></div>
      <div class="prob-bar-away" style="width:${awayPercValue}%; background:${awayColor}; height:8px; opacity:${homeWin ? '0.4' : '1'}"></div>
    </div>`;

  card.innerHTML = `

    <!-- DESKTOP layout (md+) -->
    <div class="hidden md:flex items-center justify-between gap-4">
      <div class="flex-1 flex items-center gap-3 min-w-0">
        <img src="${logoUrl(home_team)}" alt="${home_team} logo"
             class="w-12 h-12 object-contain shrink-0" onerror="this.style.display='none'">
        <div class="min-w-0">
          <div class="text-base font-semibold leading-tight ${homeWin ? 'text-white' : 'text-gray-400'}">${home_team}</div>
          <div class="text-xs text-gray-500 mt-0.5">Home</div>
        </div>
      </div>
      <div class="flex flex-col items-center gap-1.5 w-64">
        <div class="flex items-center justify-between w-full text-sm font-bold">
          <div class="flex flex-col items-start">
            <span class="${homeWin ? 'text-white' : 'text-gray-500'}">${homePercDisplay}%</span>
            <span class="text-xs font-normal text-gray-500">$${homeFairOdds}</span>
          </div>
          <span class="text-gray-600 text-xs font-normal px-2">vs</span>
          <div class="flex flex-col items-end">
            <span class="${!homeWin ? 'text-white' : 'text-gray-500'}">${awayPercDisplay}%</span>
            <span class="text-xs font-normal text-gray-500">$${awayFairOdds}</span>
          </div>
        </div>
        ${bar}
        <div class="text-2xl font-bold font-mono text-white tracking-wide mt-1">${home_score} – ${away_score}</div>
      </div>
      <div class="flex-1 flex items-center justify-end gap-3 min-w-0">
        <div class="min-w-0 text-right">
          <div class="text-base font-semibold leading-tight ${!homeWin ? 'text-white' : 'text-gray-400'}">${away_team}</div>
          <div class="text-xs text-gray-500 mt-0.5">Away</div>
        </div>
        <img src="${logoUrl(away_team)}" alt="${away_team} logo"
             class="w-12 h-12 object-contain shrink-0" onerror="this.style.display='none'">
      </div>
    </div>

    <!-- MOBILE layout (<md) -->
    <div class="flex flex-col gap-2 md:hidden">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <img src="${logoUrl(home_team)}" alt="${home_team} logo"
               class="w-9 h-9 object-contain shrink-0" onerror="this.style.display='none'">
          <div class="min-w-0">
            <div class="text-sm font-semibold leading-tight truncate ${homeWin ? 'text-white' : 'text-gray-400'}">${home_team}</div>
            <div class="text-xs text-gray-500">Home · <span class="font-bold ${homeWin ? 'text-white' : 'text-gray-500'}">${homePercDisplay}%</span> · <span class="text-gray-500">$${homeFairOdds}</span></div>
          </div>
        </div>
        <div class="text-lg font-bold font-mono text-white tracking-wide shrink-0 px-2">${home_score}–${away_score}</div>
        <div class="flex items-center gap-2 flex-1 min-w-0 justify-end">
          <div class="min-w-0 text-right">
            <div class="text-sm font-semibold leading-tight truncate ${!homeWin ? 'text-white' : 'text-gray-400'}">${away_team}</div>
            <div class="text-xs text-gray-500">Away · <span class="font-bold ${!homeWin ? 'text-white' : 'text-gray-500'}">${awayPercDisplay}%</span> · <span class="text-gray-500">$${awayFairOdds}</span></div>
          </div>
          <img src="${logoUrl(away_team)}" alt="${away_team} logo"
               class="w-9 h-9 object-contain shrink-0" onerror="this.style.display='none'">
        </div>
      </div>
      ${bar}
    </div>

    <!-- Footer row: tryscorer only, no tipping -->
    <div class="mt-3 pt-3 border-t border-gray-700 text-xs text-gray-500">
      <div class="flex items-center justify-between">
        <span>${homeWin ? home_team : away_team} favoured · Expected total: <span class="text-gray-300 font-medium">${expectedTotal} pts</span></span>
        <span class="js-tryscorer-btn">${tryscorerButtonDisabled()}</span>
      </div>
    </div>

    <!-- User Model bar (populated async, sits above Result) -->
    <div class="js-user-model"></div>

    <!-- Result line probability (populated async) -->
    <div class="js-result-prob">
      <div class="js-result-loading mt-3 flex items-center gap-2 text-xs text-gray-600 animate-pulse">
        <div class="w-2 h-2 rounded-full bg-gray-700"></div>
        <span>Checking results…</span>
      </div>
    </div>
  `;

  return card;
}


// --- PREDICTION TRACKER ---

const roundPredictionsCache = {};

async function fetchPredictionsForRound(roundNumber) {
  if (roundPredictionsCache[roundNumber]) return roundPredictionsCache[roundNumber];
  try {
    const res = await fetch(`${TRYSCORER_API}/round_predictions/${roundNumber}/nrl`);
    if (!res.ok) return [];
    const data = await res.json();
    const preds = (data.predictions || []).filter(p => p.has_prediction);
    roundPredictionsCache[roundNumber] = preds;
    return preds;
  } catch { return []; }
}

const TRACKER_BUCKETS = ['0–10%','10–20%','20–30%','30–40%','40–50%','50–60%','60–70%','70–80%','80–90%','90–100%'];
let trackerEntries = null; // raw entries: { roundFolder, prob, won, predictedTotal, actualTotal }
let trackerFilter  = 'last5'; // 'season' | 'last10' | 'last5'

async function buildTrackerEntries() {
  if (trackerEntries) return trackerEntries;

  const roundNums = [];
  for (let r = 1; r <= latestRound; r++) roundNums.push(r);

  const [liveResults, currentMatches] = await Promise.all([getLiveResults(), getTryscorerMatches()]);

  const allEntries = [];

  await Promise.all(roundNums.map(async r => {
    // fetchPredictionsForRound returns only entries with has_prediction=true
    const preds = await fetchPredictionsForRound(r);
    let results;
    if (r === latestRound) {
      results = currentMatches.map(m => {
        const lv = liveResults.find(l => teamsMatch(m.home_team, l.home) && teamsMatch(m.away_team, l.away));
        return lv ? { ...m, home_score: lv.home_score, away_score: lv.away_score } : m;
      });
    } else {
      results = await getRoundMatches(r);
    }

    for (const pred of preds) {
      // Predictions from round_predictions already include actual scores for finished matches
      const hs = pred.home_score, as = pred.away_score;
      if (typeof hs !== 'number' || typeof as !== 'number') {
        // Fall back to results array for live round
        const result = results.find(m =>
          teamsMatch(pred.home_team, m.home_team) && teamsMatch(pred.away_team, m.away_team)
        );
        if (!result || typeof result.home_score !== 'number') continue;
      }
      const finalHs = typeof hs === 'number' ? hs : null;
      const finalAs = typeof as === 'number' ? as : null;
      if (finalHs === null || finalAs === null) continue;

      const homeWon = finalHs > finalAs, awayWon = finalAs > finalHs;
      const predTotal = pred.exp_home_score !== null ? pred.exp_home_score + pred.exp_away_score : null;

      allEntries.push({ roundFolder: r, prob: pred.home_perc, won: homeWon, predictedTotal: predTotal, actualTotal: finalHs + finalAs });
      allEntries.push({ roundFolder: r, prob: pred.away_perc, won: awayWon, predictedTotal: null, actualTotal: null });
    }
  }));

  trackerEntries = allEntries;
  return trackerEntries;
}

function applyTrackerFilter(entries) {
  if (trackerFilter === 'season') return entries;
  const n = trackerFilter === 'last5' ? 5 : 10;
  const maxRound = Math.max(...entries.map(e => e.roundFolder));
  return entries.filter(e => e.roundFolder >= maxRound - n + 1);
}

function bucketEntries(entries) {
  const buckets = {};
  TRACKER_BUCKETS.forEach(b => { buckets[b] = { wins: 0, total: 0 }; });
  let sumPredicted = 0, sumActual = 0, totalGames = 0;

  for (const e of entries) {
    const pct = e.prob * 100;
    const idx = Math.min(Math.floor(pct / 10), 9);
    const key = TRACKER_BUCKETS[idx];
    buckets[key].total++;
    if (e.won) buckets[key].wins++;

    if (e.predictedTotal !== null) {
      sumPredicted += e.predictedTotal;
      sumActual    += e.actualTotal;
      totalGames++;
    }
  }

  return { buckets, avgPredicted: totalGames ? sumPredicted / totalGames : null, avgActual: totalGames ? sumActual / totalGames : null, totalGames };
}

function renderTracker() {
  const el = document.getElementById('prediction-tracker');
  if (!el || !trackerEntries) return;

  const filtered = applyTrackerFilter(trackerEntries);
  const { buckets, avgPredicted, avgActual, totalGames } = bucketEntries(filtered);

  const filterBtns = ['season','last10','last5'].map(f => {
    const label = f === 'season' ? 'Season' : f === 'last10' ? 'Last 10 Rds' : 'Last 5 Rds';
    const active = trackerFilter === f;
    return `<button data-filter="${f}"
      class="tracker-filter-btn px-2.5 py-1 rounded-md text-xs font-medium transition-colors
             ${active ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-gray-300'}">${label}</button>`;
  }).join('');

  const rowsHtml = TRACKER_BUCKETS.map(key => {
    const { wins, total } = buckets[key];
    if (total === 0) return '';
    const pct      = (wins / total) * 100;
    const barColor = bucketColor(pct / 100);
    return `
      <div class="flex items-center gap-2 text-xs">
        <span class="text-gray-500 w-14 shrink-0">${key}</span>
        <div class="flex-1 rounded-full overflow-hidden" style="height:5px; background:rgba(255,255,255,0.07);">
          <div style="width:${pct.toFixed(0)}%; height:100%; background:${barColor}; border-radius:9999px; transition:width 0.5s ease;"></div>
        </div>
        <span class="text-gray-400 w-20 text-right shrink-0">${wins}/${total} <span class="text-gray-600">(${pct.toFixed(0)}%)</span></span>
      </div>`;
  }).join('');

  const totalHtml = avgPredicted !== null ? `
    <div class="mt-3 pt-3 border-t border-gray-700/50 grid grid-cols-2 gap-2 text-center">
      <div>
        <div class="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Avg Predicted</div>
        <div class="text-sm font-bold text-white">${avgPredicted.toFixed(1)} <span class="text-xs font-normal text-gray-500">pts</span></div>
      </div>
      <div>
        <div class="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Avg Actual</div>
        <div class="text-sm font-bold text-white">${avgActual.toFixed(1)} <span class="text-xs font-normal text-gray-500">pts</span></div>
      </div>
    </div>` : '';

  el.innerHTML = `
    <div class="bg-gray-800 border border-gray-700 rounded-xl p-4">
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Prediction Tracker</span>
        <div class="flex items-center gap-1">${filterBtns}</div>
      </div>
      <div class="text-xs text-gray-600 mb-2.5">Win rate by predicted probability (${totalGames} games)</div>
      <div class="flex flex-col gap-1.5">${rowsHtml}</div>
      ${totalHtml}
    </div>
  `;

  el.querySelectorAll('.tracker-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      trackerFilter = btn.dataset.filter;
      renderTracker();
    });
  });
}

function renderLeastLikely(ranking) {
  const el = document.getElementById('least-likely');
  if (!el) return;
  const top5 = ranking.slice(0, 5);

  const cardsHtml = top5.map(e => {
    const probPct = (e.prob * 100).toFixed(1);
    const hColor  = teamColor(e.home_team);
    const aColor  = teamColor(e.away_team);
    const homeWon = e.home_score > e.away_score;

    const bar = `
      <div class="flex w-full items-center mt-2" style="border:1px solid rgba(255,255,255,0.15); border-radius:4px; overflow:hidden; height:6px;">
        <div style="width:${homeWon ? 100 : 0}%; background:${hColor}; height:100%; opacity:${homeWon ? '1' : '0.3'}"></div>
        <div style="width:${homeWon ? 0 : 100}%; background:${aColor}; height:100%; opacity:${homeWon ? '0.3' : '1'}"></div>
      </div>`;

    return `
      <div class="match-card">
        <div class="text-xs font-semibold text-gray-400 mb-2">Round ${e.round}</div>
        <div class="flex items-center justify-between gap-3">
          <!-- Logos + score -->
          <div class="flex items-center gap-2 flex-1 min-w-0">
            <img src="${logoUrl(e.home_team)}" class="w-9 h-9 object-contain shrink-0 ${homeWon ? '' : 'opacity-40'}" onerror="this.style.display='none'" title="${e.home_team}">
            <span class="font-mono font-bold text-white text-lg shrink-0">${e.home_score}–${e.away_score}</span>
            <img src="${logoUrl(e.away_team)}" class="w-9 h-9 object-contain shrink-0 ${!homeWon ? '' : 'opacity-40'}" onerror="this.style.display='none'" title="${e.away_team}">
          </div>
          <!-- Probability — key stat -->
          <div class="shrink-0 text-right">
            <div class="text-2xl font-bold text-rose-400 leading-none">${probPct}%</div>
            <div class="text-xs text-gray-500 mt-0.5">$${(1 / e.prob).toFixed(2)}</div>
          </div>
        </div>
        ${bar}
        <div class="mt-2 text-xs text-gray-500 truncate">${e.lineLabel}</div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="flex flex-col gap-3">
      <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider px-1">Biggest Upsets</div>
      ${cardsHtml}
    </div>
  `;
}

// --- TOTALS TRACKER ---

let totalTrackerEntries = null;
let totalTrackerFilter  = 'last5';

async function buildTotalTrackerEntries() {
  if (totalTrackerEntries) return totalTrackerEntries;

  const roundNums = [];
  for (let r = 1; r <= latestRound; r++) roundNums.push(r);

  const [liveResults, currentMatches] = await Promise.all([getLiveResults(), getTryscorerMatches()]);
  const allEntries = [];

  await Promise.all(roundNums.map(async r => {
    const preds = await fetchPredictionsForRound(r);
    let results;
    if (r === latestRound) {
      results = currentMatches.map(m => {
        const lv = liveResults.find(l => teamsMatch(m.home_team, l.home) && teamsMatch(m.away_team, l.away));
        return lv ? { ...m, home_score: lv.home_score, away_score: lv.away_score } : m;
      });
    } else {
      results = await getRoundMatches(r);
    }

    await Promise.all(preds.map(async pred => {
      // Use actual scores from the prediction endpoint (finished matches)
      let hs = pred.home_score, as = pred.away_score;
      if (typeof hs !== 'number' || typeof as !== 'number') {
        const result = results.find(m =>
          teamsMatch(pred.home_team, m.home_team) && teamsMatch(pred.away_team, m.away_team)
        );
        if (!result) return;
        hs = result.home_score; as = result.away_score;
      }
      if (typeof hs !== 'number' || typeof as !== 'number') return;

      const actualTotal = hs + as;

      // Fetch P(Over actualTotal - 0.5) — the probability the model gave to this exact total occurring via the over
      const overProb = await fetchTotalProb(pred.match_id, actualTotal);
      if (overProb === null) return;

      // overHit = true: the actual total lands on the over side (always true by definition here,
      // but we track it as "over" since we're asking P(≥ actualTotal))
      // What we're really binning: where did the model put this outcome?
      allEntries.push({ roundFolder: r, overProb, underProb: 1 - overProb });
    }));
  }));

  totalTrackerEntries = allEntries;
  return totalTrackerEntries;
}

function applyTotalTrackerFilter(entries) {
  if (totalTrackerFilter === 'season') return entries;
  const n = totalTrackerFilter === 'last5' ? 5 : 10;
  const maxRound = Math.max(...entries.map(e => e.roundFolder));
  return entries.filter(e => e.roundFolder >= maxRound - n + 1);
}

function renderTotalsTracker() {
  const el = document.getElementById('totals-tracker');
  if (!el || !totalTrackerEntries) return;

  const filtered = applyTotalTrackerFilter(totalTrackerEntries);
  const total = filtered.length;

  // Cumulative buckets: bin i = count of entries with prob <= (i+1)*10%
  // A result in the 0-10% bin also "wins" all higher bins
  const overCum  = Array(10).fill(0);
  const underCum = Array(10).fill(0);
  for (const e of filtered) {
    const overIdx  = Math.min(Math.floor(e.overProb  * 10), 9);
    const underIdx = Math.min(Math.floor(e.underProb * 10), 9);
    for (let i = overIdx;  i < 10; i++) overCum[i]++;
    for (let i = underIdx; i < 10; i++) underCum[i]++;
  }

  const filterBtns = ['season', 'last10', 'last5'].map(f => {
    const label  = f === 'season' ? 'Season' : f === 'last10' ? 'Last 10 Rds' : 'Last 5 Rds';
    const active = totalTrackerFilter === f;
    return `<button data-tfilter="${f}"
      class="total-filter-btn px-2.5 py-1 rounded-md text-xs font-medium transition-colors
             ${active ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-gray-300'}">${label}</button>`;
  }).join('');

  const rowsHtml = overCum.map((overCount, i) => {
    const underCount = underCum[i];
    const label      = `${i * 10}–${(i + 1) * 10}%`;
    // Bar widths as % of total (last row is always 100%)
    const overBarPct  = total > 0 ? (overCount  / total) * 100 : 0;
    const underBarPct = total > 0 ? (underCount / total) * 100 : 0;

    return `
      <div>
        <div class="flex items-center justify-between text-xs mb-1">
          <span class="text-rose-400 font-medium">${underCount}/${total} <span class="text-gray-500 font-normal">(${underBarPct.toFixed(0)}%)</span></span>
          <span class="text-gray-500">${label}</span>
          <span class="text-green-400 font-medium">${overCount}/${total} <span class="text-gray-500 font-normal">(${overBarPct.toFixed(0)}%)</span></span>
        </div>
        <div class="flex gap-px" style="height:5px;">
          <div class="flex-1 flex justify-end" style="background:rgba(255,255,255,0.05); border-radius:2px 0 0 2px;">
            <div style="width:${underBarPct.toFixed(1)}%; background:${bucketColor(underBarPct / 100)}; height:100%; border-radius:2px 0 0 2px; transition:width 0.6s ease;"></div>
          </div>
          <div class="flex-1" style="background:rgba(255,255,255,0.05); border-radius:0 2px 2px 0;">
            <div style="width:${overBarPct.toFixed(1)}%; background:${bucketColor(overBarPct / 100)}; height:100%; border-radius:0 2px 2px 0; transition:width 0.6s ease;"></div>
          </div>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="bg-gray-800 border border-gray-700 rounded-xl p-4">
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Totals Tracker</span>
        <div class="flex items-center gap-1">${filterBtns}</div>
      </div>
      <div class="flex items-center justify-between text-xs text-gray-600 mb-2">
        <span>← Unders (cumul.)</span>
        <span>Overs (cumul.) →</span>
      </div>
      <div class="flex flex-col gap-3">${rowsHtml}</div>
    </div>
  `;

  el.querySelectorAll('.total-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      totalTrackerFilter = btn.dataset.tfilter;
      renderTotalsTracker();
    });
  });
}

async function loadTracker() {
  const el = document.getElementById('prediction-tracker');
  if (el) el.innerHTML = `<div class="bg-gray-800 border border-gray-700 rounded-xl p-4 text-xs text-gray-500 animate-pulse">Loading tracker...</div>`;
  const tel = document.getElementById('totals-tracker');
  if (tel) tel.innerHTML = `<div class="bg-gray-800 border border-gray-700 rounded-xl p-4 text-xs text-gray-500 animate-pulse">Loading totals tracker...</div>`;

  await buildTrackerEntries();
  renderTracker();

  // Totals tracker — runs in parallel, renders when ready
  buildTotalTrackerEntries().then(() => renderTotalsTracker());

  // Season ranking powers per-card likelihood badges and Biggest Upsets
  buildSeasonRanking().then(ranking => renderLeastLikely(ranking));
}

// --- LOAD ROUND ---
async function loadRound() {
  container.innerHTML = [1,2,3].map(() => `
    <div class="match-card animate-pulse">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3 flex-1">
          <div class="w-12 h-12 rounded-full bg-gray-700 shrink-0"></div>
          <div class="flex flex-col gap-2 flex-1">
            <div class="h-3 bg-gray-700 rounded w-24"></div>
            <div class="h-2 bg-gray-700 rounded w-12"></div>
          </div>
        </div>
        <div class="flex flex-col items-center gap-2 w-32">
          <div class="h-3 bg-gray-700 rounded w-20"></div>
          <div class="h-2 bg-gray-700 rounded w-full"></div>
        </div>
        <div class="flex items-center gap-3 flex-1 justify-end">
          <div class="flex flex-col gap-2 items-end flex-1">
            <div class="h-3 bg-gray-700 rounded w-24"></div>
            <div class="h-2 bg-gray-700 rounded w-12"></div>
          </div>
          <div class="w-12 h-12 rounded-full bg-gray-700 shrink-0"></div>
        </div>
      </div>
    </div>`).join('');

  try {
    const res  = await fetch(`${TRYSCORER_API}/round_predictions/${currentRound}/nrl`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const allMatches  = data.predictions || [];
    const predictions = allMatches.filter(p => p.has_prediction);

    container.innerHTML = '';

    if (allMatches.length === 0) {
      container.innerHTML = `<p class="text-gray-400">No matches found for Round ${currentRound}.</p>`;
      return;
    }

    for (const match of allMatches) {
      // Build card data: fall back to equal 50/50 if no prediction
      const cardData = {
        home_team:  match.home_team,
        away_team:  match.away_team,
        home_score: match.exp_home_score ?? 0,
        away_score: match.exp_away_score ?? 0,
        home_perc:  match.home_perc ?? 0.5,
        away_perc:  match.away_perc ?? 0.5,
      };
      const card = createMatchCard(cardData);
      container.appendChild(card);

      if (currentRound === latestRound) {
        checkTryscorerAvailable(match.home_team, match.away_team).then(({ available, matchId }) => {
          card.querySelectorAll('.js-tryscorer-btn').forEach(slot => {
            slot.innerHTML = available
              ? tryscorerButtonEnabled(matchId)
              : tryscorerButtonDisabled();
          });
        });
      } else {
        card.querySelectorAll('.js-tryscorer-btn').forEach(slot => {
          slot.innerHTML = '';
        });
      }
    }

    // Async: overlay result line probability for all rounds
    updateLiveScoreOverlays(predictions);

    // Async: overlay user model picks for this round — pass ALL matches so rounds
    // without model predictions (no SGM bins) still show user picks
    updateUserModelOverlays(allMatches, currentRound);
  } catch (err) {
    console.error("Failed to load predictions:", err);
    container.innerHTML = `<p class="text-gray-400">Predictions unavailable for Round ${currentRound}.</p>`;
  }
}

// --- INIT ---
async function init() {
  try {
    const res  = await fetch(`${TRYSCORER_API}/season_matches/nrl`);
    const data = await res.json();
    const matches = data.matches || [];
    if (matches.length > 0) {
      latestRound = Math.max(...matches.map(m => m.round_number));

      // Current round = earliest round with at least one unplayed match (null score)
      const unplayedRounds = [...new Set(
        matches.filter(m => m.home_score === null || m.home_score === undefined).map(m => m.round_number)
      )].sort((a, b) => a - b);

      // If all rounds are complete, default to the latest
      currentRound = unplayedRounds.length > 0 ? unplayedRounds[0] : latestRound;
    }
  } catch {
    latestRound  = 1;
    currentRound = 1;
  }

  renderRoundNav();
  loadRound();
  loadTracker();
}

init();
