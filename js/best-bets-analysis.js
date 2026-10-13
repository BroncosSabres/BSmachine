// best-bets-analysis.js — drives pages/best_bets_analysis.html.
//
// /api/best_bets/analysis returns every settled selection the model has
// priced against a bookie price, whatever its edge (priced_selections). This
// page cuts them by model edge and asks whether the edge is real: actual RoI
// per bin with a range that allows for bets in one game moving together, a
// fit of results on the model's and the bookie's probabilities (how much
// weight the model deserves, per sport and market), and closing line value
// where a closing price exists. The maths is in roi-stats.js; everything is
// recomputed in the browser so the filters apply to all of it. Same access
// rules as the Best Bets page.
import { BACKEND } from './api-config.js';
import { getSession } from './supabase-client.js';
import { SPORT_LABELS, KIND_LABELS, esc, pct, signedPct, signCls, wonCount } from './best-bets-shared.js';
import { summarise, binByEdge, calibration, expectedWins, fitBlend, profitableFrom,
         FIT_MIN_BETS, FIT_MIN_GAMES, teamGames, sportLevels, leanOf, leanFit, LEAN_MIN_POINTS } from './roi-stats.js';

const $ = id => document.getElementById(id);

// Series colours, checked against the card surface for contrast and for
// colour-blind separation. Reference lines stay grey.
const C_ACTUAL = '#d97706', C_SECOND = '#3b82f6', C_REF = '#6b7280', C_INK = '#9ca3af';
const GRID = 'rgba(255,255,255,0.06)';

let raw = [];        // decoded rows
let pending = 0;
let roiChart = null, calChart = null, leanChart = null, timeChart = null;
let teamKey = null;  // 'sport|team' of the team charted over time, or null for all of them

// --- access states (as best-bets.js) ------------------------------------------

function gateCard(title, text, button) {
  $('content').classList.add('hidden');
  $('gate').innerHTML = `
    <div class="card text-center py-10">
      <div style="font-family:'Barlow Condensed',system-ui,sans-serif; font-size:1.25rem; font-weight:700; margin-bottom:0.5rem;">${title}</div>
      <div style="color:#8892a4; font-size:0.875rem; line-height:1.6;${button ? ' margin-bottom:1.25rem;' : ''}">${text}</div>
      ${button || ''}
    </div>`;
}

function showSignIn() {
  const next = encodeURIComponent(location.pathname + location.search);
  gateCard('Sign in required', 'Best Bets is only available to signed-in accounts with access.',
    `<a href="/pages/login.html?next=${next}"
        style="display:inline-block; padding:0.65rem 1.5rem; border-radius:8px; font-family:'Barlow Condensed',system-ui,sans-serif; font-size:1rem; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; background:#f59e0b; color:#0a0d14; text-decoration:none;">Sign In</a>`);
}

// --- data ---------------------------------------------------------------------

const kindKey = r => r.market_kind + (r.market_kind === 'match_odds' && r.three_way ? ':3' : '');
const kindLabel = k => k === 'match_odds:3' ? 'Match odds (3-way)' : KIND_LABELS[k] || k;
const groupLabel = g => { const [s, k] = g.split('|'); return `${SPORT_LABELS[s] || s} · ${kindLabel(k)}`; };

function decode(data) {
  const cols = data.columns;
  return data.rows.map(row => {
    const r = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    r.kind = kindKey(r);
    r.group = `${r.sport}|${r.kind}`;
    return r;
  });
}

// Bookmaker rows come from The Odds API ('oddsapi', 'oddsapi-lines'); the rest are Betfair's.
const sourceKey = r => r.source.startsWith('oddsapi') ? 'book' : 'betfair';
const SOURCE_LABELS = { book: 'bookmaker odds', betfair: 'Betfair odds' };

// The bets under the "odds from", "odds taken" and max-odds choices. A selection
// priced once has no closing price: it has no CLV and is left out of the closing view.
function baseBets() {
  const stage = $('f-stage').value, maxOdds = +$('f-max-odds').value, source = $('f-source').value;
  const out = [];
  for (const r of raw) {
    if (source !== 'all' && sourceKey(r) !== source) continue;
    const repriced = r.n_checks > 1;
    if (stage === 'close' && !repriced) continue;
    const back = r[`${stage}_back`];
    if (maxOdds && back >= maxOdds) continue;
    out.push({
      game: `${r.sport}:${r.game_id}`, sport: r.sport, kind: r.kind, group: r.group,
      edge: r[`${stage}_edge`], prob: r[`${stage}_prob`], back, commission: r.commission,
      win: r.win_frac, push: r.push_frac,
      team: r.team, opponent: r.opponent, date: r.kickoff, source: sourceKey(r),
      clv: repriced ? r.open_back / r.close_back - 1 : null,
    });
  }
  return out;
}

const selected = bets => bets.filter(b => ($('f-sport').value === 'all' || b.sport === $('f-sport').value)
  && ($('f-market').value === 'all' || b.kind === $('f-market').value));

// --- formatting ---------------------------------------------------------------

const range = ci => ci ? `${signedPct(ci[0], 0)} to ${signedPct(ci[1], 0)}` : 'too few games';
const binLabel = b => !isFinite(b.lo) ? `under ${signedPct(b.hi, 0)}` : !isFinite(b.hi) ? `${signedPct(b.lo, 0)} and over`
  : `${signedPct(b.lo, 0)} to ${signedPct(b.hi, 0)}`;
const clvText = st => st.clvN ? signedPct(st.clv) : 'n/a';
const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function scopeText() {
  const s = $('f-sport').value, m = $('f-market').value, maxOdds = +$('f-max-odds').value;
  return [s === 'all' ? 'All sports' : SPORT_LABELS[s], m === 'all' ? 'all markets' : kindLabel(m),
          SOURCE_LABELS[$('f-source').value],
          $('f-stage').value === 'close' ? 'closing odds' : 'odds when first priced',
          maxOdds ? `odds under $${maxOdds}` : null].filter(Boolean).join(' · ');
}

// --- tiles --------------------------------------------------------------------

function tile(label, value, sub, title = '') {
  return `<div class="card !p-4" title="${esc(title)}">
    <div class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">${label}</div>
    <div class="text-2xl font-bold tabular-nums text-gray-100 mt-1">${value}</div>
    <div class="text-[11px] text-gray-500 mt-0.5 leading-snug">${sub}</div>
  </div>`;
}

function renderTiles(bets, fit, pooled) {
  const all = summarise(bets), pos = summarise(bets.filter(b => b.edge > 0));
  $('tiles').innerHTML = [
    tile('Settled selections', all.n.toLocaleString(), `${count(all.games, 'game')} · ${pending.toLocaleString()} more awaiting a result`),
    tile('Return at edge above 0', pos.n ? `<span class="${signCls(pos.roi)}">${signedPct(pos.roi)}</span>` : '–',
      pos.n ? `${count(pos.n, 'bet')}, ${wonCount(pos.wins)} won · model expected ${signedPct(pos.edge)} · 90% range ${range(pos.roiCI)}` : 'No positive-edge bets settled yet',
      'One unit on every selection the model rated above 0%, at the bookie odds'),
    tile('Model weight', fit?.weight != null ? pct(fit.weight, 0) : '–',
      fit ? `${fit.weightCI ? `90% range ${pct(fit.weightCI[0], 0)} to ${pct(fit.weightCI[1], 0)} · ` : ''}against the bookie price${pooled ? ' · all sports and markets pooled (too few here)' : ''}`
          : `Needs ${FIT_MIN_BETS} settled bets over ${FIT_MIN_GAMES} games`,
      "The model's share when its probability and the bookie's are fitted to results together. 100% = the model's price is the truth; 0% = the bookie's is."),
    tile('Closing line value', pos.clvN ? `<span class="${signCls(pos.clv)}">${signedPct(pos.clv)}</span>` : 'n/a',
      pos.clvN ? `${count(pos.clvN, 'positive-edge bet')} priced more than once` : 'No positive-edge bets here have a closing price',
      'Odds when first priced against the closing odds. Above zero means the market moved toward the model. Scorer odds are fetched once per game, so they have none.'),
  ].join('');
}

// --- charts -------------------------------------------------------------------

// Vertical 90% range through each point that carries { lo, hi }.
const rangeBars = {
  id: 'rangeBars',
  afterDatasetsDraw(chart) {
    const { ctx, scales: { x, y }, chartArea } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
    ctx.clip();
    chart.data.datasets.forEach((ds, i) => {
      if (!chart.isDatasetVisible(i)) return;
      ctx.strokeStyle = ds.borderColor;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      for (const p of ds.data) {
        if (p.lo == null) continue;
        const px = x.getPixelForValue(p.x), top = y.getPixelForValue(p.hi), bottom = y.getPixelForValue(p.lo);
        ctx.beginPath();
        ctx.moveTo(px, top); ctx.lineTo(px, bottom);
        ctx.moveTo(px - 3, top); ctx.lineTo(px + 3, top);
        ctx.moveTo(px - 3, bottom); ctx.lineTo(px + 3, bottom);
        ctx.stroke();
      }
    });
    ctx.restore();
  },
};

const axis = title => ({
  type: 'linear',
  title: { display: true, text: title, color: C_INK, font: { size: 11 } },
  ticks: { color: C_INK, callback: v => `${v}%` },
  grid: { color: GRID }, border: { color: 'rgba(255,255,255,0.1)' },
});

function chartOptions(xTitle, yTitle, tooltipLines) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'nearest', intersect: false },
    scales: { x: axis(xTitle), y: axis(yTitle) },
    plugins: {
      legend: { labels: { color: C_INK, boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { size: 11 } } },
      tooltip: {
        filter: item => item.raw.tip != null,
        callbacks: { title: () => '', label: item => tooltipLines(item.raw) },
      },
    },
  };
}

const pc = x => x * 100;

// "Auto" keeps about 40 bets in a bin while the sample is small, then moves
// to fixed 2-point bins once there are enough to fill them.
function binSpec(n) {
  const [mode, value] = $('f-bins').value.split(':');
  if (mode === 'w') return { width: +value };
  if (mode === 'c') return { mode: 'count', count: +value };
  return n >= 2000 ? { width: 0.02 } : { mode: 'count', count: Math.max(2, Math.min(12, Math.round(n / 40))) };
}

function renderRoiChart(bets, fit, pooled) {
  const minBets = +$('f-min-bets').value;
  const bins = binByEdge(bets, binSpec(bets.length))
    .map(b => ({ ...b, st: summarise(b.bets), fitted: fit ? b.bets.reduce((a, x) => a + fit.expected(x), 0) / b.bets.length : null }));
  const shown = bins.filter(b => b.st.n >= minBets);

  $('roi-chart-sub').textContent = `${scopeText()} · 1 unit on every selection in the bin`;
  const hidden = bins.length - shown.length;
  $('roi-chart-note').textContent = !bets.length ? 'No settled selections match these filters yet.'
    : !shown.length ? `No bin has ${minBets} bets yet: lower "Min bets per bin" or use wider bins.`
    : `Bars are the 90% range, from resampling whole games. ${hidden ? `${count(hidden, 'bin')} under ${minBets} bets left off. ` : ''}`
      + (fit ? `The fitted line is what each bin should return once the bookie's price is weighed in${pooled ? ' (fitted on all sports and markets: too few bets here)' : ''}.`
             : `A fitted line appears at ${FIT_MIN_BETS} settled bets over ${FIT_MIN_GAMES} games.`);

  const points = shown.map(b => ({ x: pc(b.st.edge), y: pc(b.st.roi), lo: b.st.roiCI && pc(b.st.roiCI[0]), hi: b.st.roiCI && pc(b.st.roiCI[1]),
    tip: [`Model edge ${binLabel(b)}`, `Returned ${signedPct(b.st.roi)} (90% range ${range(b.st.roiCI)})`,
          `Model expected ${signedPct(b.st.edge)}${b.fitted != null ? `, fitted ${signedPct(b.fitted)}` : ''}`,
          `${count(b.st.n, 'bet')}, ${wonCount(b.st.wins)} won, over ${count(b.st.games, 'game')}`] }));
  const xs = points.map(p => p.x);
  const x0 = Math.min(0, ...xs), x1 = Math.max(0, ...xs);
  const datasets = [
    { label: 'Actual return', data: points, borderColor: C_ACTUAL, backgroundColor: C_ACTUAL, pointRadius: 5, pointHoverRadius: 7, showLine: false },
    { label: 'If the model were exactly right', data: [{ x: x0, y: x0 }, { x: x1, y: x1 }], borderColor: C_REF, borderDash: [5, 4],
      borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0, showLine: true, pointStyle: 'line' },
  ];
  if (fit) datasets.splice(1, 0, { label: 'Fitted: model and bookie price together',
    data: shown.map(b => ({ x: pc(b.st.edge), y: pc(b.fitted) })), borderColor: C_SECOND, backgroundColor: C_SECOND,
    borderWidth: 2, pointRadius: 0, pointHitRadius: 0, showLine: true, pointStyle: 'line' });

  const options = chartOptions('Model edge: the return the model expects', 'Actual return', p => p.tip);
  // Keep a wild small-sample range from flattening everything else
  const ys = points.flatMap(p => [p.y, p.lo ?? p.y, p.hi ?? p.y]).concat(x0, x1);
  options.scales.y.min = Math.max(-100, Math.floor(Math.min(...ys) / 10) * 10);
  options.scales.y.max = Math.min(150, Math.ceil(Math.max(...ys) / 10) * 10);
  roiChart?.destroy();
  roiChart = new Chart($('roi-chart'), { type: 'scatter', data: { datasets }, options, plugins: [rangeBars] });

  const head = ['Model edge', 'Bets', 'Won', 'Games', 'Expected', 'Actual', '90% range', 'Fitted', 'CLV'];
  $('bins-table').innerHTML = `<thead><tr class="text-gray-500">${head.map((h, i) => `<th class="px-2 py-1 font-semibold ${i ? 'text-right' : 'text-left'}">${h}</th>`).join('')}</tr></thead>
    <tbody>${bins.map(b => `<tr class="border-t border-gray-700/60 tabular-nums ${b.st.n < minBets ? 'text-gray-500' : 'text-gray-300'}">
      <td class="px-2 py-1 text-left">${binLabel(b)}</td>
      <td class="px-2 py-1 text-right">${b.st.n}</td><td class="px-2 py-1 text-right">${wonCount(b.st.wins)}</td><td class="px-2 py-1 text-right">${b.st.games}</td>
      <td class="px-2 py-1 text-right">${signedPct(b.st.edge)}</td>
      <td class="px-2 py-1 text-right font-semibold">${signedPct(b.st.roi)}</td>
      <td class="px-2 py-1 text-right">${range(b.st.roiCI)}</td>
      <td class="px-2 py-1 text-right">${b.fitted != null ? signedPct(b.fitted) : '–'}</td>
      <td class="px-2 py-1 text-right" title="${b.st.clvN} with a closing price">${clvText(b.st)}</td>
    </tr>`).join('')}</tbody>`;
}

function renderCalChart(bets) {
  // Grouped by the model's probability, the question is whether the model is
  // right; grouped by the bookie odds, where along the price range it parts
  // from the bookie (favourites or outsiders) and which of the two results follow.
  const byBook = $('f-cal-by').value === 'implied';
  const cal = bets.length >= 20 ? calibration(bets, { count: 10, by: byBook ? 'implied' : 'prob' }) : [];
  $('cal-chart-sub').textContent = byBook
    ? "Selections grouped by the bookie odds, shortest price on the right. On the dashed line, the rate matches the bookie's chance."
    : "Selections grouped by the model's probability. On the dashed line, the rate matches the model.";
  $('cal-chart-note').textContent = !cal.length ? 'Needs at least 20 settled selections.'
    : byBook ? "The bookie's chance is 1 / odds, so it includes their margin: a fair result sits a little under the dashed line. Where the model's marks sit away from the actual rate, that is where its edges come from its own error."
    : "The bookie's chance is 1 / odds, so it includes their margin and sits a little above the true rate. Where the actual rate follows the bookie's and not the model's, the model's edge is not real.";
  const xOf = c => pc(byBook ? c.implied : c.prob);
  const actual = cal.map(c => ({ x: xOf(c), y: pc(c.actual), lo: c.actualCI && pc(c.actualCI[0]), hi: c.actualCI && pc(c.actualCI[1]),
    tip: [`Model ${pct(c.prob)} · bookie ${pct(c.implied)}`,
          `Won ${pct(c.actual)}${c.actualCI ? ` (90% range ${pct(c.actualCI[0], 0)} to ${pct(c.actualCI[1], 0)})` : ''}`, `${count(c.n, 'selection')}, ${wonCount(c.wins)} won`] }));
  const other = cal.map(c => ({ x: xOf(c), y: pc(byBook ? c.prob : c.implied) }));
  const top = Math.min(100, Math.ceil(Math.max(10, ...cal.flatMap(c => [c.prob, c.actual, c.implied, c.actualCI?.[1] ?? 0]).map(pc)) / 10) * 10);
  const options = chartOptions(byBook ? "Bookie's implied chance" : "Model's probability", 'Rate', p => p.tip);
  Object.assign(options.scales.x, { min: 0, max: top });
  Object.assign(options.scales.y, { min: 0, max: top });
  calChart?.destroy();
  calChart = new Chart($('cal-chart'), { type: 'scatter', plugins: [rangeBars], options, data: { datasets: [
    { label: 'Actual win rate', data: actual, borderColor: C_ACTUAL, backgroundColor: C_ACTUAL, pointRadius: 5, pointHoverRadius: 7 },
    { label: byBook ? "Model's probability" : "Bookie's implied chance", data: other, borderColor: C_SECOND, backgroundColor: C_SECOND, pointStyle: 'rectRot',
      pointRadius: 5, pointHitRadius: 0 },
    { label: byBook ? 'Bookie exactly right' : 'Model exactly right', data: [{ x: 0, y: 0 }, { x: top, y: top }], borderColor: C_REF, borderDash: [5, 4], borderWidth: 1.5,
      pointRadius: 0, pointHitRadius: 0, showLine: true, pointStyle: 'line' },
  ] } });
}

// --- by team ------------------------------------------------------------------

const sumRows = rows => rows.reduce((a, g) => ({ ...a, n: a.n + g.n, model: a.model + g.model, bookie: a.bookie + g.bookie, actual: a.actual + g.actual }),
  { sport: rows[0]?.sport, n: 0, model: 0, bookie: 0, actual: 0 });

// Weeks run Wednesday to Tuesday (UTC), which keeps an NFL round, Thursday
// night to Monday night US time, in one week.
function weekOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 4) % 7);
  return d.toISOString().slice(0, 10);
}
const dayText = date => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function renderLeanChart(tgs, levels) {
  const points = tgs.filter(g => g.n).map(g => ({ g, ...leanOf(g, levels) })).filter(p => p.lean != null && p.outcome != null);
  const fit = leanFit(points.map(p => ({ x: p.lean, y: p.outcome, w: p.g.bookie, game: p.g.game })));
  $('lean-chart-note').textContent = !points.length ? 'No team has settled scorer prices under these filters.'
    : fit ? `Fitted slope ${fit.slope.toFixed(2)}${fit.slopeCI ? ` (90% range ${fit.slopeCI[0].toFixed(2)} to ${fit.slopeCI[1].toFixed(2)})` : ''} over ${count(fit.n, 'team game')}. `
            + "A slope of 1 says the model's view of a team is the truth; 0 says the bookies' is, and the lean is model error."
          : `A fitted line appears at ${LEAN_MIN_POINTS} team games.`;
  const data = points.map(p => ({ x: pc(p.lean), y: pc(p.outcome), key: p.g.key,
    tip: [`${p.g.team} v ${p.g.opponent}, ${dayText(p.g.date)}`, `Model lean ${signedPct(p.lean, 0)} · outcome ${signedPct(p.outcome, 0)}`,
          `${wonCount(p.g.actual)} of ${p.g.n} listed scored · model ${p.g.model.toFixed(1)} · bookie ${p.g.bookie.toFixed(1)}`] }));
  const xs = data.map(p => p.x), x0 = Math.min(-10, ...xs), x1 = Math.max(10, ...xs);
  const datasets = [
    { label: 'Team in a game', data, borderColor: 'transparent', backgroundColor: data.map(p => teamKey && p.key !== teamKey ? 'rgba(217,119,6,0.25)' : C_ACTUAL),
      pointRadius: data.map(p => p.key === teamKey ? 7 : 4), pointHoverRadius: 7, showLine: false, clip: false },
    { label: 'If the model were exactly right', data: [{ x: x0, y: x0 }, { x: x1, y: x1 }], borderColor: C_REF, borderDash: [5, 4],
      borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0, showLine: true, pointStyle: 'line' },
  ];
  if (fit) datasets.splice(1, 0, { label: 'Fitted', data: [x0, x1].map(x => ({ x, y: pc(fit.intercept + fit.slope * x / 100) })),
    borderColor: C_SECOND, backgroundColor: C_SECOND, borderWidth: 2, pointRadius: 0, pointHitRadius: 0, showLine: true, pointStyle: 'line' });
  const options = chartOptions("Model lean: its scorers for the team against the bookies'", "Outcome: actual scorers against the bookies'", p => p.tip);
  options.plugins.legend.labels.generateLabels = chart => Chart.defaults.plugins.legend.labels.generateLabels(chart)
    .map((l, i) => i ? l : { ...l, fillStyle: C_ACTUAL, strokeStyle: C_ACTUAL });
  const ys = data.map(p => p.y);
  options.scales.y.min = Math.floor(Math.min(-20, ...ys) / 20) * 20;
  options.scales.y.max = Math.min(300, Math.ceil(Math.max(20, ...ys) / 20) * 20);
  leanChart?.destroy();
  leanChart = new Chart($('lean-chart'), { type: 'scatter', data: { datasets }, options });
}

// One team: its games in order. All teams: weeks, per team game.
function renderTimeChart(tgs) {
  const scored = tgs.filter(g => g.n);
  const mine = teamKey && scored.filter(g => g.key === teamKey);
  let labels, rows, tips;
  if (mine) {
    labels = mine.map(g => dayText(g.date));
    rows = mine;
    tips = mine.map(g => `v ${g.opponent} · ${wonCount(g.actual)} of ${g.n} listed scored`);
    $('time-chart-title').textContent = `${mine[0]?.team ?? ''}: scorers by game`;
    $('time-chart-sub').textContent = 'Listed players expected to score, by the model and by the bookies, and how many did.';
  } else {
    const weeks = [...new Set(scored.map(g => weekOf(g.date)))].sort();
    labels = weeks.map(w => `Week of ${dayText(w)}`);
    rows = weeks.map(w => {
      const part = scored.filter(g => weekOf(g.date) === w), s = sumRows(part);
      return { model: s.model / part.length, bookie: s.bookie / part.length, actual: s.actual / part.length, games: part.length };
    });
    tips = rows.map(r => count(r.games, 'team game'));
    $('time-chart-title').textContent = 'All teams: scorers per team game, by week';
    $('time-chart-sub').textContent = 'Select a team in the table to follow it game by game.';
  }
  $('time-chart-note').textContent = !rows.length ? '' : "The bookies' count is the sum of 1 / odds, so it includes their margin and runs a little high."
    + (rows.length < 3 ? ' A trend needs more than a couple of points.' : '');
  const series = (label, key, color, extra = {}) => ({ label, data: rows.map(r => r[key]), borderColor: color, backgroundColor: color,
    borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: 0, ...extra });
  timeChart?.destroy();
  timeChart = new Chart($('time-chart'), { type: 'line',
    data: { labels, datasets: [series('Actual', 'actual', C_ACTUAL), series('Model expected', 'model', C_SECOND, { pointStyle: 'rectRot' }),
                               series('Bookies expected', 'bookie', C_REF, { borderDash: [5, 4], pointStyle: 'triangle' })] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { color: C_INK }, grid: { color: GRID }, border: { color: 'rgba(255,255,255,0.1)' }, offset: true },
        y: { beginAtZero: true, title: { display: true, text: 'Scorers', color: C_INK, font: { size: 11 } }, ticks: { color: C_INK },
             grid: { color: GRID }, border: { color: 'rgba(255,255,255,0.1)' } },
      },
      plugins: {
        legend: { labels: { color: C_INK, boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { size: 11 } } },
        tooltip: { callbacks: { label: item => `${item.dataset.label}: ${item.parsed.y.toFixed(1)}`, footer: items => tips[items[0].dataIndex] } },
      },
    } });
}

function renderTeamTable(tgs, levels) {
  const teams = [...new Set(tgs.map(g => g.key))].map(key => {
    const games = tgs.filter(g => g.key === key), h2h = games.filter(g => g.h2h).map(g => g.h2h);
    const s = sumRows(games.filter(g => g.n));
    const avg = f => h2h.reduce((a, h) => a + f(h), 0) / h2h.length;
    return { key, sport: games[0].sport, team: games[0].team, games: new Set(games.map(g => g.game)).size, s, ...leanOf({ ...s, sport: games[0].sport }, levels),
             h2h: h2h.length ? { model: avg(h => h.model), bookie: avg(h => h.bookie), won: h2h.reduce((a, h) => a + h.won, 0), n: h2h.length } : null };
  }).sort((a, b) => (b.lean ?? -Infinity) - (a.lean ?? -Infinity) || a.team.localeCompare(b.team));
  const manySports = new Set(teams.map(t => t.sport)).size > 1;
  const cell = (x, cls = '') => `<td class="px-2 py-1.5 text-right ${cls}">${x}</td>`;
  const allRow = `<tr data-team="" class="border-t border-gray-700/60 cursor-pointer hover:bg-gray-700/20 ${teamKey ? '' : 'bg-gray-700/30'}">
    <td class="px-2 py-1.5 text-left font-semibold text-gray-100" colspan="7">All teams</td></tr>`;
  $('team-table').innerHTML = allRow + teams.map(t => `<tr data-team="${esc(t.key)}" class="border-t border-gray-700/60 cursor-pointer hover:bg-gray-700/20 tabular-nums text-gray-300 ${t.key === teamKey ? 'bg-gray-700/30' : ''}">
    <td class="px-2 py-1.5 text-left font-semibold text-gray-100">${esc(t.team)}${manySports ? ` <span class="text-[10px] font-normal text-gray-500">${esc(SPORT_LABELS[t.sport] || t.sport)}</span>` : ''}</td>
    ${cell(t.games)}
    ${cell(signedPct(t.lean, 0), 'font-semibold text-gray-100')}
    ${cell(signedPct(t.outcome, 0), t.lean != null && t.outcome != null ? signCls(t.lean * t.outcome) : '')}
    ${cell(t.s.n ? `<span class="font-semibold text-gray-100">${wonCount(t.s.actual)}</span><span class="block text-[10px] text-gray-500 whitespace-nowrap">model ${t.s.model.toFixed(1)} · bookie ${t.s.bookie.toFixed(1)}</span>` : '–')}
    ${cell(t.h2h ? `<span class="font-semibold text-gray-100">${pct(t.h2h.model, 0)}</span><span class="block text-[10px] text-gray-500 whitespace-nowrap">bookie ${pct(t.h2h.bookie, 0)}</span>` : '–')}
    ${cell(t.h2h ? `${wonCount(t.h2h.won)} of ${t.h2h.n}` : '–')}
  </tr>`).join('');
}

// The team view reads scorer and head-to-head prices together, so it follows
// every filter but Market.
function renderTeams(base) {
  const sport = $('f-sport').value;
  const tgs = teamGames(base.filter(b => sport === 'all' || b.sport === sport));
  if (teamKey && !tgs.some(g => g.key === teamKey && g.n)) teamKey = null;
  $('team-sub').textContent = [sport === 'all' ? 'All sports' : SPORT_LABELS[sport], SOURCE_LABELS[$('f-source').value],
    $('f-stage').value === 'close' ? 'closing odds' : 'odds when first priced',
    +$('f-max-odds').value ? `odds under $${$('f-max-odds').value}` : null, 'not narrowed by Market'].filter(Boolean).join(' · ');
  const none = !tgs.length;
  $('team-empty').classList.toggle('hidden', !none);
  $('team-body').classList.toggle('hidden', none);
  if (none) {
    $('team-empty').textContent = raw.length && !raw.some(r => r.team) ? 'Team data is not being returned yet.' : 'No settled selections with a team match these filters yet.';
    return;
  }
  const levels = sportLevels(tgs);
  renderLeanChart(tgs, levels);
  renderTimeChart(tgs);
  renderTeamTable(tgs, levels);
}

// --- breakdown ----------------------------------------------------------------

function breakdownRow(label, bets, key, active) {
  const all = summarise(bets), posBets = bets.filter(b => b.edge > 0), pos = summarise(posBets);
  const fit = fitBlend(bets);
  const exp = expectedWins(bets);
  const from = profitableFrom(bets);
  const fromText = from ? (from.minEdge ? `${signedPct(from.minEdge, 0)} edge and over` : 'any edge above 0%') : posBets.length < 50 ? 'not enough bets' : 'not shown yet';
  const fromTitle = from ? `Edge ${signedPct(from.minEdge, 0)} and over: ${signedPct(from.roi)} over ${from.n} bets, 90% range ${range(from.roiCI)}`
    : posBets.length < 50 ? 'Needs 50 settled positive-edge bets' : 'At no minimum edge is the 90% range of the return clear of zero yet';
  return `<tr data-group="${esc(key)}" class="border-t border-gray-700/60 cursor-pointer hover:bg-gray-700/20 tabular-nums ${active ? 'bg-gray-700/30' : ''}">
    <td class="px-2 py-2 text-left font-semibold text-gray-100">${esc(label)}</td>
    <td class="px-2 py-2 text-right text-gray-300">${all.n.toLocaleString()}</td>
    <td class="px-2 py-2 text-right text-gray-300">${all.games.toLocaleString()}</td>
    <td class="px-2 py-2 text-right text-gray-300 whitespace-nowrap" title="${exp.n ? `${wonCount(exp.wins)} of ${exp.n.toLocaleString()} won. The model expected ${exp.model.toFixed(1)}, the bookie odds ${exp.bookie.toFixed(1)} (margin included).` : ''}"><span class="font-semibold text-gray-100">${exp.n ? wonCount(exp.wins) : '–'}</span>${exp.n ? `<span class="block text-[10px] text-gray-500">model ${exp.model.toFixed(1)} · bookie ${exp.bookie.toFixed(1)}</span>` : ''}</td>
    <td class="px-2 py-2 text-right text-gray-300" title="${fit ? `logit(win) = ${fit.a.toFixed(2)} + ${fit.bModel.toFixed(2)} × model + ${fit.bMarket.toFixed(2)} × bookie` : `Needs ${FIT_MIN_BETS} settled bets over ${FIT_MIN_GAMES} games`}"><span class="font-semibold text-gray-100">${fit?.weight != null ? pct(fit.weight, 0) : '–'}</span>${fit?.weightCI ? `<span class="block text-[10px] text-gray-500">${pct(fit.weightCI[0], 0)} to ${pct(fit.weightCI[1], 0)}</span>` : ''}</td>
    <td class="px-2 py-2 text-right text-gray-300">${pos.n.toLocaleString()}</td>
    <td class="px-2 py-2 text-right text-gray-300">${pos.n ? wonCount(pos.wins) : '–'}</td>
    <td class="px-2 py-2 text-right text-gray-300">${pos.n ? signedPct(pos.edge) : '–'}</td>
    <td class="px-2 py-2 text-right" title="${pos.n ? `90% range ${range(pos.roiCI)}` : ''}"><span class="font-bold text-gray-100">${pos.n ? signedPct(pos.roi) : '–'}</span>${pos.roiCI ? `<span class="block text-[10px] text-gray-500">${range(pos.roiCI)}</span>` : ''}</td>
    <td class="px-2 py-2 text-right text-gray-300" title="${pos.clvN} of ${pos.n} with a closing price">${clvText(pos)}</td>
    <td class="px-2 py-2 text-right text-gray-300" title="${esc(fromTitle)}">${fromText}</td>
  </tr>`;
}

function renderBreakdown(base) {
  const groups = [...new Set(base.map(b => b.group))].sort();
  const current = $('f-sport').value === 'all' || $('f-market').value === 'all'
    ? ($('f-sport').value === 'all' && $('f-market').value === 'all' ? 'all' : null)
    : `${$('f-sport').value}|${$('f-market').value}`;
  const source = SOURCE_LABELS[$('f-source').value];
  $('breakdown-sub').textContent = `${$('f-stage').value === 'close' ? 'Closing odds' : 'Odds when first priced'}${source ? ` · ${source}` : ''}${+$('f-max-odds').value ? ` · odds under $${$('f-max-odds').value}` : ''} · select a row to chart it`;
  $('breakdown-body').innerHTML = !base.length
    ? '<tr><td colspan="11" class="px-2 py-8 text-center text-sm text-gray-500">No settled selections yet.</td></tr>'
    : breakdownRow('All sports and markets', base, 'all', current === 'all')
      + groups.map(g => breakdownRow(groupLabel(g), base.filter(b => b.group === g), g, current === g)).join('');
  $('method-note').textContent = 'Returns are per unit staked at the bookie odds, after commission where it applies. Ranges are 90%, from resampling whole games, '
    + 'because selections in one game win and lose together. Scorer odds are the median of US bookmakers, fetched once per game, so those markets have no closing line value. '
    + 'Small samples swing a lot: read the range, not the point.';
}

// --- wiring -------------------------------------------------------------------

function render() {
  const base = baseBets();
  const bets = selected(base);
  let fit = fitBlend(bets), pooled = false;
  if (!fit && bets.length !== base.length) { fit = fitBlend(base); pooled = !!fit; }
  renderTiles(bets, fit, pooled);
  renderRoiChart(bets, fit, pooled);
  renderCalChart(bets);
  renderTeams(base);
  renderBreakdown(base);
}

function fillSelect(id, options) {
  $(id).innerHTML = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
}

['f-sport', 'f-market', 'f-source', 'f-stage', 'f-max-odds', 'f-bins', 'f-min-bets', 'f-cal-by'].forEach(id => $(id).addEventListener('change', render));
$('breakdown-body').addEventListener('click', e => {
  const key = e.target.closest('tr[data-group]')?.dataset.group;
  if (!key) return;
  const [s, k] = key === 'all' ? ['all', 'all'] : key.split('|');
  $('f-sport').value = s;
  $('f-market').value = k;
  render();
});

$('team-table').addEventListener('click', e => {
  const row = e.target.closest('tr[data-team]');
  if (!row) return;
  teamKey = row.dataset.team || null;
  renderTeams(baseBets());
});

async function init() {
  const session = await getSession();
  if (!session) { showSignIn(); return; }
  let res;
  try {
    res = await fetch(`${BACKEND}/best_bets/analysis`, { headers: { Authorization: `Bearer ${session.access_token}` } });
  } catch { res = null; }
  if (res?.status === 401) { showSignIn(); return; }
  if (res?.status === 403) { gateCard('Restricted', "This page is restricted. Your account doesn't have access to Best Bets."); return; }
  if (!res?.ok) { gateCard('Could not load the analysis', 'Try again in a moment.'); return; }
  const data = await res.json();
  raw = decode(data);
  pending = data.pending;
  fillSelect('f-sport', [['all', 'All'], ...Object.keys(SPORT_LABELS).filter(s => raw.some(r => r.sport === s)).map(s => [s, SPORT_LABELS[s]])]);
  fillSelect('f-market', [['all', 'All'], ...[...new Set(raw.map(r => r.kind))].sort().map(k => [k, kindLabel(k)])]);
  $('gate').innerHTML = '';
  $('content').classList.remove('hidden');
  render();
}

init();
