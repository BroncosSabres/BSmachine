// best-bets-analysis.js — drives pages/best_bets_analysis.html.
//
// /api/best_bets/analysis returns every settled selection the model has
// priced against a bookie price, whatever its edge (priced_selections). This
// page cuts them by model edge and asks whether the edge is real: actual RoI
// per bin with a range that allows for bets in one game moving together, a
// fit of results on the model's and the bookie's probabilities (how much
// weight the model deserves, per sport and market), and closing line value
// where a closing price exists. A table of betting rules (edge at least X,
// at cuts fitted to the bets, within the odds range on the slider) shows where
// a return is holding up and where it is too early to say. A grid of edge by
// odds shows which bins have proven a profit and what stake each earns at the
// Risk level chosen, and where bets turn to losing again (safe-stake.js). The
// maths is in roi-stats.js; everything is recomputed in the browser so the
// filters apply to all of it. Same access rules as the Best Bets page.
import { BACKEND } from './api-config.js';
import { getSession } from './supabase-client.js';
import { SPORT_LABELS, esc, odds, pct, signedPct, signCls, wonCount, selectionText, loadStakePrefs, saveStakePrefs, money } from './best-bets-shared.js';
import { summarise, binByEdge, calibration, expectedWins, fitBlend, profitableFrom, profit,
         FIT_MIN_BETS, FIT_MIN_GAMES, teamGames, sportLevels, leanOf, leanFit, LEAN_MIN_POINTS,
         dropEmptyMarkets, onePerMarket, ruleRows, bestRule, MAX_BOOK, RULE_MIN_BETS, RULE_MIN_GAMES } from './roi-stats.js';
import { BASES } from './best-bets-filters.js';
import { localPrefs, syncPrefs, savePrefs } from './best-bets-prefs.js';
import { kindLabel, groupLabel, sourceKey, decodeRows, toBet, RISK_LEVELS, BIN_DETAIL, binGrid, binStats, kellyStake,
         edgeBandLabel, oddsBandLabel, CEILING_MIN_BETS, CEILING_MIN_GAMES, CEILING_CONF } from './safe-stake.js';

const $ = id => document.getElementById(id);

// Series colours, checked against the card surface for contrast and for
// colour-blind separation. Reference lines stay grey.
const C_ACTUAL = '#d97706', C_SECOND = '#3b82f6', C_REF = '#6b7280', C_INK = '#9ca3af';
const GRID = 'rgba(255,255,255,0.06)';
// A profit and a loss, wherever a chart tells the two apart
const C_UP = '#22c55e', C_DOWN = '#ef4444';

let raw = [];        // decoded rows
let pending = 0;
let roiChart = null, calChart = null, leanChart = null, timeChart = null, ruleChart = null;
let teamKey = null;  // 'sport|team' of the team charted over time, or null for all of them
let gridMode = 'rule';   // 'rule' / 'band': rows of the rule table take an edge and over, or up to the next
let selEdge = 0;         // the low edge of the row in the detail panel
let listed = null;       // { title, bets } of that row, for the window that lists its bets
let betsShow = 'all';    // 'all' / 'won' / 'lost': which of them that window shows
let bestCache = { key: null, rows: [] };
let betsOpen = null;     // { title, bets } in the window that lists bets
const stakePrefs = loadStakePrefs();
// The price bets are judged at, shared with the Best Bets page's Filters (and
// so saved to the account): the best single bookie's ('book') or the median
// across them ('avg')
let prefs = localPrefs();
const basis = () => $('f-price').value === 'avg' ? 'avg' : 'book';
// "odds when first priced · best bookie"
function stageText(capital = false) {
  const t = `${$('f-stage').value === 'close' ? 'closing odds' : 'odds when first priced'} · ${BASES[basis()].toLowerCase()}`;
  return capital ? t[0].toUpperCase() + t.slice(1) : t;
}
const riskOf = () => RISK_LEVELS[stakePrefs.risk] || RISK_LEVELS.medium;

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

const SOURCE_LABELS = { book: 'bookmaker odds', betfair: 'Betfair odds' };

// Stops of the odds slider: close together where most prices are, wide apart
// up the long end. The last is "any price".
const ODDS_STOPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50, Infinity];
const ODDS_DEFAULT = [1, 10];
const oddsRange = () => [ODDS_STOPS[+$('f-odds-min').value], ODDS_STOPS[+$('f-odds-max').value]];
// "odds under $10", "odds $2 to $10", "odds $2 and over"; null when every price is in
function oddsText() {
  const [lo, hi] = oddsRange();
  return lo <= 1 ? (isFinite(hi) ? `odds under $${hi}` : null) : isFinite(hi) ? `odds $${lo} to $${hi}` : `odds $${lo} and over`;
}

// Keeps the two ends apart (the one being dragged gives way) and redraws the
// bar between them and the readout.
function syncOdds(moved) {
  const lo = $('f-odds-min'), hi = $('f-odds-max'), last = ODDS_STOPS.length - 1;
  if (+lo.value >= +hi.value) {
    if (moved === hi) hi.value = +lo.value + 1;
    else lo.value = +hi.value - 1;
  }
  // A thumb's centre travels the track less half a thumb at each end
  Object.assign($('odds-fill').style, { left: `calc(8px + (100% - 16px) * ${+lo.value / last})`, width: `calc((100% - 16px) * ${(hi.value - lo.value) / last})` });
  const [a, b] = oddsRange();
  $('odds-readout').textContent = `$${a} – ${isFinite(b) ? `$${b}` : 'any'}`;
}

// The bets under the "odds from", "odds taken", "count" and odds choices. A
// selection priced once has no closing price: it has no CLV and is left out of
// the closing view. Markets with no real prices are always left out.
//   base   what the tiles, rules, charts and breakdown read
//   every  each selection whatever "count" says: the team view pairs up the
//          two sides of a head-to-head itself
//   anyOdds as base at every price: the grid's columns are the odds
function scopes() {
  const stage = $('f-stage').value, source = $('f-source').value, [oddsLo, oddsHi] = oddsRange();
  const out = [];
  for (const r of raw) {
    if (source !== 'all' && sourceKey(r) !== source) continue;
    if (stage === 'close' && !(r.n_checks > 1)) continue;
    out.push(toBet(r, stage, basis()));
  }
  const { kept, dropped } = dropEmptyMarkets(out);
  // The bet that stands for a market is picked before the odds cut, so moving
  // the slider never changes which line or side that is
  const counted = $('f-count').value === 'one' ? onePerMarket(kept) : kept;
  const inOdds = b => b.back >= oddsLo && b.back < oddsHi;
  const base = counted.filter(inOdds);
  return { base, every: kept.filter(inOdds), anyOdds: counted, empty: dropped, repeats: kept.length - counted.length,
           fallbacks: base.filter(b => b.fallback).length };
}

const selected = bets => bets.filter(b => ($('f-sport').value === 'all' || b.sport === $('f-sport').value)
  && ($('f-market').value === 'all' || b.kind === $('f-market').value));

// --- formatting ---------------------------------------------------------------

const range = ci => ci ? `${signedPct(ci[0], 0)} to ${signedPct(ci[1], 0)}` : 'too few games';
const binLabel = b => !isFinite(b.lo) ? `under ${signedPct(b.hi, 0)}` : !isFinite(b.hi) ? `${signedPct(b.lo, 0)} and over`
  : `${signedPct(b.lo, 0)} to ${signedPct(b.hi, 0)}`;
const clvText = st => st.clvN ? signedPct(st.clv) : 'n/a';
const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const capital = s => s[0].toUpperCase() + s.slice(1);

const marketText = () => {
  const s = $('f-sport').value, m = $('f-market').value;
  return `${s === 'all' ? 'All sports' : SPORT_LABELS[s]} · ${m === 'all' ? 'all markets' : kindLabel(m)}`;
};

function scopeText() {
  return [marketText(), SOURCE_LABELS[$('f-source').value],
          stageText(), oddsText()].filter(Boolean).join(' · ');
}

function renderCountNote(s) {
  const parts = [];
  if (s.repeats) parts.push(`${count(s.repeats, 'selection')} left out as the other side, another line or a second source of a bet already counted`);
  if (s.empty) parts.push(`${s.empty.toLocaleString()} left out from markets with no real prices (the prices on offer add up to over ${Math.round(MAX_BOOK * 100)}%)`);
  if (s.fallbacks) parts.push(`${count(s.fallbacks, 'bet')} of ${s.base.length.toLocaleString()} priced at the average: no best bookie price was recorded for them`);
  $('count-note').textContent = !raw.some(r => r.market_id != null) ? 'Counting every selection: the data to tell repeats apart is not being returned yet.'
    : parts.length ? `${capital(parts.join('; '))}.` : '';
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

// The line between a loss and a profit on the return axis: a bold one along
// zero. Given `from` (a value on the x axis), also a dashed upright there with
// `label` beside it, for where the profit starts.
const profitLine = {
  id: 'profitLine',
  beforeDatasetsDraw(chart, _args, { from, label }) {
    const { ctx, scales: { x, y }, chartArea: a } = chart;
    const zero = y.getPixelForValue(0);
    ctx.save();
    if (zero >= a.top && zero <= a.bottom) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.left, zero); ctx.lineTo(a.right, zero);
      ctx.stroke();
    }
    const px = from == null ? null : x.getPixelForValue(from);
    if (px != null && px >= a.left && px <= a.right) {
      ctx.strokeStyle = C_UP;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom);
      ctx.stroke();
      ctx.font = `600 11px ${Chart.defaults.font.family}`;
      ctx.fillStyle = '#4ade80';
      ctx.textBaseline = 'top';
      // Beside the line on whichever side has the room
      const right = px + 6 + ctx.measureText(label).width <= a.right;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillText(label, px + (right ? 6 : -6), a.top + 4);
    }
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

  // Where the profit starts: the lowest bin with a profit in it and in every
  // bin above it. None when the top bin lost.
  let from = null;
  for (let i = shown.length - 1; i >= 0 && shown[i].st.roi > 0; i--) from = shown[i];
  const fromText = !from ? 'The top bin lost, so there is no edge yet above which every bin is in profit. '
    : from === shown[0] ? 'Every bin has returned a profit. '
    : `Every bin from a model edge of ${signedPct(from.lo, 0)} up has returned a profit: the dashed line. `;

  $('roi-chart-sub').textContent = `${scopeText()} · 1 unit on every selection in the bin`;
  const hidden = bins.length - shown.length;
  $('roi-chart-note').textContent = !bets.length ? 'No settled selections match these filters yet.'
    : !shown.length ? `No bin has ${minBets} bets yet: lower "Min bets per bin" or use wider bins.`
    : `${fromText}Bars are the 90% range, from resampling whole games. ${hidden ? `${count(hidden, 'bin')} under ${minBets} bets left off. ` : ''}`
      + (fit ? `The fitted line is what each bin should return once the bookie's price is weighed in${pooled ? ' (fitted on all sports and markets: too few bets here)' : ''}.`
             : `A fitted line appears at ${FIT_MIN_BETS} settled bets over ${FIT_MIN_GAMES} games.`);

  const points = shown.map(b => ({ x: pc(b.st.edge), y: pc(b.st.roi), lo: b.st.roiCI && pc(b.st.roiCI[0]), hi: b.st.roiCI && pc(b.st.roiCI[1]),
    tip: [`Model edge ${binLabel(b)}`, `Returned ${signedPct(b.st.roi)} (90% range ${range(b.st.roiCI)})`,
          `Model expected ${signedPct(b.st.edge)}${b.fitted != null ? `, fitted ${signedPct(b.fitted)}` : ''}`,
          `${count(b.st.n, 'bet')}, ${wonCount(b.st.wins)} won, over ${count(b.st.games, 'game')}`] }));
  const xs = points.map(p => p.x);
  const x0 = Math.min(0, ...xs), x1 = Math.max(0, ...xs);
  // Two series for the one measure, so a bin's colour says which side of zero it is on
  const dots = (label, color, data) => ({ label, data, borderColor: color, backgroundColor: color, pointRadius: 5, pointHoverRadius: 7, showLine: false });
  const datasets = [
    dots('Actual return: profit', C_UP, points.filter(p => p.y > 0)),
    dots('Actual return: loss', C_DOWN, points.filter(p => p.y <= 0)),
    { label: 'If the model were exactly right', data: [{ x: x0, y: x0 }, { x: x1, y: x1 }], borderColor: C_REF, borderDash: [5, 4],
      borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0, showLine: true, pointStyle: 'line' },
  ];
  if (fit) datasets.splice(2, 0, { label: 'Fitted: model and bookie price together',
    data: shown.map(b => ({ x: pc(b.st.edge), y: pc(b.fitted) })), borderColor: C_SECOND, backgroundColor: C_SECOND,
    borderWidth: 2, pointRadius: 0, pointHitRadius: 0, showLine: true, pointStyle: 'line' });

  const options = chartOptions('Model edge: the return the model expects', 'Actual return', p => p.tip);
  // Keep a wild small-sample range from flattening everything else
  const ys = points.flatMap(p => [p.y, p.lo ?? p.y, p.hi ?? p.y]).concat(x0, x1);
  options.scales.y.min = Math.max(-100, Math.floor(Math.min(...ys) / 10) * 10);
  options.scales.y.max = Math.min(150, Math.ceil(Math.max(...ys) / 10) * 10);
  options.plugins.profitLine = from && from !== shown[0] ? { from: pc(from.lo), label: `Profit from ${signedPct(from.lo, 0)} edge` } : {};
  roiChart?.destroy();
  roiChart = new Chart($('roi-chart'), { type: 'scatter', data: { datasets }, options, plugins: [profitLine, rangeBars] });

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

// --- betting rules --------------------------------------------------------------

const wholePct = x => `${Math.round(x * 100)}%`;
const edgeLabel = r => !isFinite(r.edgeLo) ? `under ${wholePct(r.edgeHi)}` : !isFinite(r.edgeHi) ? `${wholePct(r.edgeLo)}+`
  : `${Math.round(r.edgeLo * 100)}–${wholePct(r.edgeHi)}`;
const ruleText = r => `edge ${edgeLabel(r)}`;
const fittedOf = (bets, fit) => fit && bets.length ? bets.reduce((a, b) => a + fit.expected(b), 0) / bets.length : null;
const units = x => `${x > 0 ? '+' : ''}${x.toFixed(1)} unit${Math.abs(x).toFixed(1) === '1.0' ? '' : 's'}`;

const VERDICT_CHIPS = {
  thin:   ['Too few to call', 'bg-gray-700 text-gray-300'],
  open:   ['Could still be zero', 'bg-amber-900/50 text-amber-300'],
  ahead:  ['Profit, clear of zero', 'bg-green-900/60 text-green-300'],
  behind: ['Loss, clear of zero', 'bg-red-900/60 text-red-300'],
};

// One row's return as a bar out from zero, its 90% range as a whisker and
// what the model expected as a tick: where the model is right the bar ends at
// the tick. The fill says how sure, a strong one only where the whole range is
// one side of zero and an outline on a thin row. `max` is the scale's end;
// anything past it is cut off there.
function returnBar(row, max) {
  const at = x => 50 + Math.max(-1, Math.min(1, x / max)) * 50;
  const rgb = row.roi >= 0 ? '34,197,94' : '239,68,68';
  const fill = row.verdict === 'thin' ? `border:1px solid rgba(${rgb},0.6);` : `background:rgba(${rgb},${row.verdict === 'open' ? 0.3 : 0.8});`;
  const span = (a, b) => `left:${Math.min(at(a), at(b))}%;width:${Math.abs(at(b) - at(a))}%;`;
  return `<div class="relative h-6" aria-hidden="true">
    <div class="absolute inset-y-0" style="left:50%;width:1px;background:rgba(255,255,255,0.2);"></div>
    <div class="absolute rounded-sm" style="top:6px;bottom:6px;${span(0, row.roi)}${fill}"></div>
    ${row.roiCI ? `<div class="absolute" style="top:50%;height:1px;${span(row.roiCI[0], row.roiCI[1])}background:rgba(255,255,255,0.7);"></div>` : ''}
    <div class="absolute" style="top:3px;bottom:3px;left:${at(row.edge)}%;width:2px;margin-left:-1px;background:#d97706;"></div>
  </div>`;
}

// The row in the detail panel: the one at the chosen edge, or failing that
// (the cuts moved with the bets) the one starting at zero.
const rowAt = rows => rows.find(r => r.rule.edgeLo === selEdge) || rows.find(r => r.rule.edgeLo === 0) || rows[0] || null;

// -> the selected row, or null
function renderRuleTable(rows, fit) {
  const sel = rowAt(rows);
  // The scale takes in every return and every model edge, not the ranges: one wild range would flatten the rest
  const reach = Math.max(0.2, ...rows.filter(r => r.n).flatMap(r => [Math.abs(r.roi), Math.abs(r.edge)]));
  const max = [0.2, 0.3, 0.5, 0.75, 1, 1.5].find(m => m >= reach) ?? 1.5;
  $('rules-scale').innerHTML = [-max, 0, max].map(x => `<span>${x ? signedPct(x, 0) : '0'}</span>`).join('');
  const cell = (x, cls = 'text-gray-300') => `<td class="px-2 py-1 text-right ${cls}">${x}</td>`;
  $('rules-rows').innerHTML = rows.map(r => {
    const on = r === sel, fitted = fittedOf(r.bets, fit);
    const open = `<tr data-edge="${r.rule.edgeLo}" aria-selected="${on}" class="border-t border-gray-700/60 cursor-pointer hover:bg-gray-700/20 tabular-nums ${on ? 'bg-gray-700/40' : ''}"
      title="${r.n ? esc(`${capital(ruleText(r.rule))}: ${signedPct(r.roi)} on ${count(r.n, 'bet')} over ${count(r.games, 'game')}${r.roiCI ? `, 90% range ${range(r.roiCI)}` : ''}. ${VERDICT_CHIPS[r.verdict][0]}.`) : ''}">
      <th scope="row" class="px-2 py-1 text-left font-semibold text-gray-100 whitespace-nowrap" style="${on ? 'box-shadow:inset 3px 0 0 #d97706;' : ''}">${edgeLabel(r.rule)}</th>`;
    if (!r.n) return `${open}<td class="px-2 py-1 text-gray-600" colspan="5">No bets</td></tr>`;
    return `${open}
      <td class="px-2 py-1 text-right text-gray-300 leading-tight">${r.n.toLocaleString()}<span class="block text-[10px] text-gray-500">${count(r.games, 'game')}</span></td>
      ${cell(signedPct(r.edge, 0))}
      ${cell(signedPct(r.roi, 0), `font-bold ${r.verdict === 'thin' ? (r.roi >= 0 ? 'text-green-400/60' : 'text-red-400/60') : signCls(r.roi)}`)}
      <td class="px-2 py-1">${returnBar(r, max)}</td>
      ${cell(fitted != null ? signedPct(fitted, 0) : '–')}</tr>`;
  }).join('') || '<tr><td colspan="6" class="px-2 py-8 text-center text-sm text-gray-500">No settled selections match these filters yet.</td></tr>';
  return sel;
}

// --- stakes -------------------------------------------------------------------
// What a group of bets earns at the Risk level: Kelly scaled down, off the
// low end of its return at that level, at its median odds. Only once that low
// end is above zero. -> { st (binStats), stake (kellyStake) or null }
function stakeOfBets(bets) {
  const st = binStats(bets, riskOf(), { callThin: true });   // called on few bets too, with a warning
  return { st, stake: st.verdict === 'ahead' ? kellyStake(st.low, st.odds, st.commission, riskOf()) : null };
}
const share = f => pct(f, f < 0.01 ? 2 : 1);
const thinMark = s => s.stake && s.st.thin ? '<span class="text-amber-400 mr-1" aria-label="not proven yet">⚠</span>' : '';
const stakeText = s => !s.stake ? '–' : thinMark(s) + (stakePrefs.balance ? `${money(stakePrefs.balance * s.stake.frac)} <span class="text-gray-500 font-normal">${share(s.stake.frac)}</span>` : share(s.stake.frac));
const lowText = st => `${Math.round(riskOf().conf * 100)}% low end ${signedPct(st.low)}`;
const stakeSub = s => s.stake ? `at ${odds(s.st.odds)} · about ${s.stake.betsToSure.toLocaleString()} bets to be 99% sure of a profit`
    + (s.st.thin ? ` · ⚠ not proven yet: under ${RULE_MIN_BETS} bets over ${RULE_MIN_GAMES} games, so less sure than it looks` : '')
  : !s.st.n ? 'no bets' : s.st.verdict === 'behind' ? 'a loss, clear of zero' : `no profit clear of zero: ${lowText(s.st)}`;

function renderRuleDetail(cell, fit) {
  const stat = (label, value, sub = '', title = '') => `<div title="${esc(title)}"><dt class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">${label}</dt>
    <dd class="text-sm font-semibold tabular-nums text-gray-100">${value}</dd>${sub ? `<dd class="text-[10px] text-gray-500 leading-snug">${sub}</dd>` : ''}</div>`;
  ruleChart?.destroy();
  ruleChart = null;
  $('rule-chart-wrap').classList.toggle('hidden', !cell?.n);
  const title = cell && `${marketText()}: ${ruleText(cell.rule)}, ${oddsText() ?? 'any odds'}`;
  listed = cell?.n ? { title, bets: cell.bets } : null;
  // The bets can only be named once the backend sends their names
  $('rule-bets').classList.toggle('hidden', !raw.some(r => r.selection_name != null));
  if (!cell?.n) {
    $('rule-title').textContent = title || 'Nothing to show';
    $('rule-verdict').textContent = 'No settled bets here yet.';
    $('rule-stats').innerHTML = '';
    return;
  }
  const st = cell;
  const exp = expectedWins(cell.bets);
  const fitted = fittedOf(cell.bets, fit);
  const [chip, chipCls] = VERDICT_CHIPS[st.verdict];
  $('rule-title').textContent = title;
  $('rule-verdict').innerHTML = `<span class="inline-block rounded px-1.5 py-0.5 mr-1.5 text-[10px] font-semibold ${chipCls}">${chip}</span>`
    + (st.verdict === 'thin' ? `${count(st.n, 'bet')} over ${count(st.games, 'game')}. A rule is called once it has ${RULE_MIN_BETS} bets over ${RULE_MIN_GAMES} games.`
      : st.verdict === 'open' ? `The 90% range runs from ${signedPct(st.roiCI[0], 0)} to ${signedPct(st.roiCI[1], 0)}, so the result so far could be luck either way.`
      : st.verdict === 'ahead' ? 'Even the low end of the 90% range is a profit. It is one of several rules looked at, so check the rows around it agree.'
      : 'Even the high end of the 90% range is a loss.');
  $('rule-stats').innerHTML = [
    stat('Returned', `<span class="${signCls(st.roi)}">${signedPct(st.roi)}</span>`, st.roiCI ? `90% range ${range(st.roiCI)}` : 'too few games for a range'),
    stat('Profit', `<span class="${signCls(st.units)}">${units(st.units)}</span>`, `${count(st.n, 'bet')} over ${count(st.games, 'game')}`),
    stat('Won', `${wonCount(st.wins)} of ${st.n}`, exp.n ? `model expected ${exp.model.toFixed(1)} · bookie ${exp.bookie.toFixed(1)}` : ''),
    stat('Model expected', signedPct(st.edge), fitted != null ? `${signedPct(fitted)} with the bookie's price weighed in` : '',
      "The return the model's own prices say these bets should make, and what the fit of results on the model's and the bookie's prices says"),
    stat('Without best game', st.restRoi != null ? `<span class="${signCls(st.restRoi)}">${signedPct(st.restRoi)}</span>` : '–', 'the return with its most profitable game taken out',
      'A rule that lives off one game falls over here'),
    stat('Closing line value', st.clvN ? `<span class="${signCls(st.clv)}">${signedPct(st.clv)}</span>` : 'n/a',
      st.clvN ? `${count(st.clvN, 'bet')} priced more than once` : 'no closing prices here',
      'Odds when first priced against the closing odds. Above zero means the market moved toward the model: the earliest sign an edge is real.'),
    (s => stat('Safe stake', stakeText(s), stakeSub(s),
      `A share of the bank per bet at ${riskOf().label} risk: ${riskOf().text}. This rule is one of several looked at, so it flatters.`))(stakeOfBets(cell.bets)),
  ].join('');

  let run = 0;
  const data = cell.bets.map((b, k) => { run += profit(b); return { x: k + 1, y: run, date: b.date }; });
  // Green above zero and red below, split exactly at the zero line (a step
  // that crosses it changes colour part way), so the swings in and out of
  // profit show: a gradient down the chart with one hard stop at zero.
  const UP = C_UP, DOWN = C_DOWN;
  const bySign = ({ chart }) => {
    const { chartArea: area, scales } = chart;
    if (!area) return UP;
    const zero = Math.max(0, Math.min(1, (scales.y.getPixelForValue(0) - area.top) / (area.bottom - area.top)));
    const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, UP); g.addColorStop(zero, UP); g.addColorStop(zero, DOWN); g.addColorStop(1, DOWN);
    return g;
  };
  const pointColor = ctx => (ctx.raw?.y ?? 0) >= 0 ? UP : DOWN;
  ruleChart = new Chart($('rule-chart'), { type: 'line',
    data: { datasets: [{ data: [{ x: 0, y: 0 }, ...data], borderColor: bySign, pointBackgroundColor: pointColor, pointBorderColor: pointColor,
                         borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, stepped: true }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: { type: 'linear', min: 0, max: Math.max(1, data.length), title: { display: true, text: 'Bets, in date order', color: C_INK, font: { size: 10 } },
             ticks: { color: C_INK, precision: 0, font: { size: 10 } }, grid: { display: false }, border: { color: 'rgba(255,255,255,0.1)' } },
        y: { title: { display: true, text: 'Units', color: C_INK, font: { size: 10 } }, ticks: { color: C_INK, font: { size: 10 } },
             grid: { color: ctx => ctx.tick.value === 0 ? 'rgba(255,255,255,0.35)' : GRID }, border: { color: 'rgba(255,255,255,0.1)' } },
      },
      plugins: { legend: { display: false },
        tooltip: { filter: item => item.raw.date != null, displayColors: false,
          callbacks: { title: () => '', label: item => `${units(item.raw.y)} after ${count(item.raw.x, 'bet')} · ${dayText(item.raw.date)}` } } },
    } });
}

// --- the bets behind a rule ------------------------------------------------------
// A window over the page listing the bets of the row in the detail panel,
// newest first: what each was, at what price and edge, and how it went. Built
// as player-stats-modal.js builds its window.

const BETS_MAX = 100;
const betsModal = document.createElement('div');
betsModal.className = 'fixed inset-0 hidden items-end sm:items-center justify-center bg-black/60 sm:p-4';
betsModal.style.zIndex = '1200';   // above the site header (1100)
betsModal.innerHTML = `
  <div role="dialog" aria-modal="true" aria-labelledby="bets-title"
       class="bg-gray-800 border border-gray-700 w-full sm:max-w-3xl max-h-[88vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl p-4">
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <h2 id="bets-title" class="text-base font-bold leading-tight"></h2>
        <p id="bets-sub" class="text-xs text-gray-400 mt-0.5"></p>
      </div>
      <button type="button" data-close-bets aria-label="Close"
              class="shrink-0 w-8 h-8 -mr-1 -mt-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 text-lg leading-none">✕</button>
    </div>
    <div id="bets-show" class="mt-3 inline-flex shrink-0 self-start rounded border border-gray-600 overflow-hidden text-xs" role="group" aria-label="Which bets to list"></div>
    <div class="mt-3 overflow-auto -mx-1 min-h-0">
      <table class="w-full text-xs sm:min-w-[40rem]">
        <thead class="sticky top-0 bg-gray-800">
          <tr class="text-[10px] text-gray-500 uppercase tracking-wider">
            <th class="px-2 py-1.5 text-left font-semibold">Date</th>
            <th class="px-2 py-1.5 text-left font-semibold">Game</th>
            <th class="px-2 py-1.5 text-left font-semibold">Bet</th>
            <th class="px-2 py-1.5 text-right font-semibold">Odds</th>
            <th class="px-2 py-1.5 text-right font-semibold" title="The return the model expected at these odds, and its chance of the bet winning">Edge</th>
            <th class="px-2 py-1.5 text-right font-semibold" title="How it went, and the profit on 1 unit">Result</th>
          </tr>
        </thead>
        <tbody id="bets-rows"></tbody>
      </table>
    </div>
    <p id="bets-note" class="mt-2 text-[11px] text-gray-500 leading-snug"></p>
  </div>`;
document.body.appendChild(betsModal);
let betsOpener = null;   // what had the focus, to hand it back on closing

const outcome = b => b.push >= 1 ? 'Push' : b.win >= 1 ? 'Won' : b.win + b.push <= 0 ? 'Lost' : b.win > 0 ? 'Half won' : 'Half lost';

function renderBets() {
  const all = [...betsOpen.bets].reverse();   // they come oldest first
  const parts = { all, won: all.filter(b => profit(b) > 0), lost: all.filter(b => profit(b) < 0) };
  const bets = parts[betsShow], shown = bets.slice(0, BETS_MAX);
  const total = bets.reduce((a, b) => a + profit(b), 0);
  const manySports = new Set(all.map(b => b.sport)).size > 1;
  $('bets-title').textContent = betsOpen.title;
  $('bets-sub').textContent = `${count(bets.length, 'bet')}${bets.length ? ` · ${units(total)} at 1 unit a bet` : ''} · newest first`;
  $('bets-show').innerHTML = [['all', 'All'], ['won', 'Won'], ['lost', 'Lost']].map(([key, label], i) =>
    `<button type="button" data-show="${key}" aria-pressed="${key === betsShow}" class="px-2.5 py-1 ${i ? 'border-l border-gray-600 ' : ''}${
      key === betsShow ? 'bg-gray-600 text-white font-semibold' : 'bg-gray-900 text-gray-400 hover:text-gray-200'}">${label} <span class="tabular-nums opacity-70">${parts[key].length}</span></button>`).join('');
  $('bets-rows').innerHTML = shown.map(b => {
    const r = b.row, p = profit(b);
    return `<tr class="border-t border-gray-700/60 tabular-nums text-gray-300 align-top">
      <td class="px-2 py-1.5 whitespace-nowrap">${dayText(b.date)}</td>
      <td class="px-2 py-1.5">${esc(r.home_team)} v ${esc(r.away_team)}${manySports ? `<span class="block text-[10px] text-gray-500">${esc(SPORT_LABELS[b.sport] || b.sport)}</span>` : ''}</td>
      <td class="px-2 py-1.5"><span class="font-semibold text-gray-100">${esc(selectionText(r))}</span><span class="block text-[10px] text-gray-500">${esc(kindLabel(b.kind))} · ${b.source === 'book' ? 'bookmakers' : 'Betfair'}</span></td>
      <td class="px-2 py-1.5 text-right">${odds(b.back)}</td>
      <td class="px-2 py-1.5 text-right">${signedPct(b.edge, 0)}<span class="block text-[10px] text-gray-500">model ${pct(b.prob, 0)}</span></td>
      <td class="px-2 py-1.5 text-right whitespace-nowrap"><span class="font-semibold ${signCls(p)}">${outcome(b)}</span><span class="block text-[10px] ${signCls(p)}">${p > 0 ? '+' : ''}${p.toFixed(2)}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="px-2 py-8 text-center text-sm text-gray-500">None of these.</td></tr>';
  $('bets-note').textContent = `${bets.length > BETS_MAX ? `The latest ${BETS_MAX} of ${bets.length.toLocaleString()}. ` : ''}Odds and edge are as ${
    $('f-stage').value === 'close' ? 'at the close' : 'when first priced'}, at the ${basis() === 'book' ? 'best bookie price' : 'average price'}. Profit is on 1 unit, after commission where it applies.`;
}

// list: { title, bets }, the rule panel's row by default
function openBets(list = listed) {
  if (!list) return;
  betsOpen = list;
  betsOpener = document.activeElement;
  betsShow = 'all';
  renderBets();
  betsModal.classList.remove('hidden');
  betsModal.classList.add('flex');
  document.body.style.overflow = 'hidden';
  betsModal.querySelector('.overflow-auto').scrollTop = 0;
  betsModal.querySelector('[data-close-bets]').focus();
}

function closeBets() {
  betsModal.classList.add('hidden');
  betsModal.classList.remove('flex');
  document.body.style.overflow = '';
  betsOpener?.focus?.();
}

betsModal.addEventListener('click', e => {
  if (e.target === betsModal || e.target.closest('[data-close-bets]')) { closeBets(); return; }
  const show = e.target.closest('button[data-show]')?.dataset.show;
  if (show && show !== betsShow) { betsShow = show; renderBets(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !betsModal.classList.contains('hidden')) closeBets();
});

// One row per sport and market: its best-supported rule, whatever Sport and
// Market are set to. Only the odds source, stage, count, odds range and risk change it.
function renderBestRules(base) {
  const key = [$('f-source').value, $('f-stage').value, basis(), $('f-count').value, $('f-odds-min').value, $('f-odds-max').value, stakePrefs.risk, raw.length].join('|');
  if (bestCache.key !== key) {
    const rows = [...new Set(base.map(b => b.group))].sort().map(g => {
      const bets = base.filter(b => b.group === g), pos = bets.filter(b => b.edge >= 0), best = bestRule(bets);
      return { g, best, stake: best && stakeOfBets(best.bets), pos: pos.length, games: new Set(pos.map(b => b.game)).size,
               roi: pos.length ? pos.reduce((a, b) => a + profit(b), 0) / pos.length : null };
    });
    rows.sort((a, b) => (b.best ? b.best.roiCI[0] : -Infinity) - (a.best ? a.best.roiCI[0] : -Infinity) || b.pos - a.pos);
    bestCache = { key, rows };
  }
  const { rows } = bestCache;
  const cell = (x, cls = 'text-gray-300') => `<td class="px-2 py-2 text-right ${cls}">${x}</td>`;
  $('best-rules').innerHTML = !rows.length ? '<tr><td colspan="8" class="px-2 py-6 text-center text-sm text-gray-500">No settled selections yet.</td></tr>'
    : rows.map(({ g, best, stake, pos, games, roi }) => {
      const open = `<tr data-group="${esc(g)}" ${best ? `data-edge="${best.rule.edgeLo}"` : ''} class="border-t border-gray-700/60 cursor-pointer hover:bg-gray-700/20 tabular-nums">
        <td class="px-2 py-2 text-left font-semibold text-gray-100">${esc(groupLabel(g))}</td>`;
      if (!best) return `${open}<td class="px-2 py-2 text-left text-gray-500" colspan="7">Not enough yet: ${count(pos, 'bet')} at an edge of 0% or more over ${count(games, 'game')}${
        roi != null ? `, <span class="${roi >= 0 ? 'text-green-400/60' : 'text-red-400/60'}">${signedPct(roi, 0)}</span> so far` : ''}</td></tr>`;
      const [chip, chipCls] = VERDICT_CHIPS[best.verdict];
      return `${open}<td class="px-2 py-2 text-left text-gray-200 whitespace-nowrap">${capital(ruleText(best.rule))}
          <span class="inline-block rounded px-1.5 py-0.5 ml-1 text-[10px] font-semibold ${chipCls}">${chip}</span></td>
        ${cell(best.n.toLocaleString())}${cell(best.games.toLocaleString())}
        <td class="px-2 py-2 text-right"><span class="font-bold ${signCls(best.roi)}">${signedPct(best.roi)}</span><span class="block text-[10px] text-gray-500">${range(best.roiCI)}</span></td>
        ${cell(signedPct(best.restRoi), signCls(best.restRoi))}
        <td class="px-2 py-2 text-right text-gray-300" title="${best.clvN} of ${best.n} with a closing price">${clvText(best)}</td>
        <td class="px-2 py-2 text-right font-semibold text-gray-100 whitespace-nowrap" title="${esc(stakeSub(stake))}">${stakeText(stake)}</td></tr>`;
    }).join('');
  const source = SOURCE_LABELS[$('f-source').value];
  $('best-rules-sub').textContent = `${stageText(true)}${source ? ` · ${source}` : ''} · ${oddsText() ?? 'any odds'} · rules with at least ${RULE_MIN_BETS} bets over ${RULE_MIN_GAMES} games · select a row to open it above`;
  $('best-rules-note').textContent = 'Each row is the best of several rules, one for each edge its bets are cut at, and the best of several always flatters. Trust one more when the rows around it agree, '
    + 'when it holds up without its best game, and when the closing price moved its way. Its safe stake flatters it for the same reason.';
}

function renderRules(base) {
  const bets = selected(base);
  const fit = fitBlend(bets) || fitBlend(base);
  $('rules-sub').textContent = [marketText(), SOURCE_LABELS[$('f-source').value],
    stageText(), oddsText() ?? 'any odds', '1 unit on every bet in the row'].filter(Boolean).join(' · ');
  for (const b of $('rules-mode').children) {
    const on = b.dataset.mode === gridMode;
    b.className = `px-2.5 py-1 ${b.dataset.mode === 'band' ? 'border-l border-gray-600 ' : ''}${on ? 'bg-gray-600 text-white font-semibold' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`;
    b.setAttribute('aria-pressed', on);
  }
  $('rules-note').textContent = 'The edges the rows are cut at are fitted to the bets in view: a cut is added, and they reach higher, once there are enough bets to fill a row. '
    + (gridMode === 'rule' ? 'A row takes every bet with at least its edge, so rows overlap: a good rule shows as a run of rows that agree, not one that stands out.'
                           : "A row takes the bets from its edge up to the next row's, so no bet is in two rows.")
    + ' Narrow the odds with the slider above.';
  // The range is worked out for thin rows too: the whisker shows how little they say
  renderRuleDetail(renderRuleTable(ruleRows(bets, { mode: gridMode, thinRange: true }), fit), fit);
  renderBestRules(base);
}

// --- where to bet: edge by odds -------------------------------------------------
// The bins the Best Bets page stakes from, for the bets in view at every
// price: which have proven a profit at the Risk level, what each earns, and
// the edge and odds past which bets turn to losing again.

const GRID_VERDICT = { ahead: 'proven profit', behind: 'proven loss', open: 'unproven', thin: 'too few to call' };
const UP_RGB = '34,197,94', DOWN_RGB = '239,68,68';
let gridLists = new Map();   // data-cell -> { title, bets }

function gridCellStyle(st) {
  const rgb = st.roi >= 0 ? UP_RGB : DOWN_RGB;
  return st.verdict === 'ahead' || st.verdict === 'behind' ? `background:rgba(${rgb},0.55);`
    : st.verdict === 'open' ? `background:rgba(${rgb},0.15);` : `box-shadow:inset 0 0 0 1px rgba(${rgb},0.35);`;
}

function renderGrid(anyOdds) {
  const detail = BIN_DETAIL[stakePrefs.detail] || BIN_DETAIL.coarse, risk = riskOf();
  const bets = selected(anyOdds).filter(b => b.edge >= 0);
  const grid = binGrid(bets, risk, detail);
  const total = binStats(bets, risk);
  const E = grid.edge, O = grid.odds, ce = grid.ceil.edge, co = grid.ceil.odds;
  const edgeName = i => edgeBandLabel(E, i).replace('edge ', '');
  gridLists = new Map();

  const cell = (st, key, label, { strong = false, top = false, left = false } = {}) => {
    const lines = [`${label}: ${st.n ? `${signedPct(st.roi)} on ${count(st.n, 'bet')} over ${count(st.games, 'game')}` : 'no settled bets'}`];
    const borders = `${top ? 'border-top:2px dashed rgba(239,68,68,0.8);' : ''}${left ? 'border-left:2px dashed rgba(239,68,68,0.8);' : ''}`;
    if (!st.n) return `<td class="px-1.5 py-1 text-center text-gray-700" style="${borders}">·</td>`;
    const s = st.verdict === 'ahead' ? kellyStake(st.low, st.odds, st.commission, risk) : null;
    lines.push(`${capital(GRID_VERDICT[st.verdict])}${st.low != null ? `: ${signedPct(st.low)} to ${signedPct(st.high)}, each end ${Math.round(risk.conf * 100)}% sure (${risk.label} risk)` : ''}`);
    if (s) lines.push(`Safe stake ${share(s.frac)}${stakePrefs.balance ? ` (${money(stakePrefs.balance * s.frac)})` : ''} at ${odds(st.odds)}, about ${s.betsToSure.toLocaleString()} bets to be 99% sure of a profit`);
    lines.push('Select to list the bets');
    gridLists.set(key, { title: `${marketText()}: ${label}`, bets: st.bets });
    return `<td data-cell="${key}" class="px-1.5 py-1 text-center cursor-pointer hover:outline hover:outline-1 hover:outline-gray-400 tabular-nums ${strong ? 'border-l border-gray-700' : ''}"
      style="${gridCellStyle(st)}${borders}" title="${esc(lines.join('\n'))}">
      <div class="font-semibold ${st.verdict === 'thin' ? 'text-gray-400' : 'text-gray-100'}">${signedPct(st.roi, 0)}</div>
      <div class="text-[10px] ${s ? 'text-green-300 font-semibold' : 'text-gray-500'}">${s ? share(s.frac) : st.n}</div></td>`;
  };

  const head = `<thead><tr class="text-[10px] text-gray-500 uppercase tracking-wider">
      <th class="px-1.5 py-1.5 text-left font-semibold whitespace-nowrap">Edge \\ odds</th>
      ${O.slice(0, -1).map((_, j) => `<th class="px-1.5 py-1.5 text-center font-semibold whitespace-nowrap normal-case ${co != null && j >= co ? 'text-red-400/80' : ''}">${oddsBandLabel(O, j)}</th>`).join('')}
      <th class="px-1.5 py-1.5 text-center font-semibold whitespace-nowrap border-l border-gray-700">Any odds</th></tr></thead>`;
  const body = E.slice(0, -1).map((_, i) => `<tr>
      <th scope="row" class="px-1.5 py-1 text-left font-semibold whitespace-nowrap ${ce != null && i >= ce ? 'text-red-400/80' : 'text-gray-200'}"
          style="${ce === i ? 'border-top:2px dashed rgba(239,68,68,0.8);' : ''}">${edgeName(i)}</th>
      ${grid.cells[i].map((st, j) => cell(st, `${i}:${j}`, `${edgeBandLabel(E, i)} · ${oddsBandLabel(O, j)}`, { top: ce === i, left: co === j })).join('')}
      ${cell(grid.rows[i], `${i}:*`, `${edgeBandLabel(E, i)} · any odds`, { strong: true, top: ce === i })}</tr>`).join('')
    + `<tr class="border-t border-gray-700"><th scope="row" class="px-1.5 py-1 text-left font-semibold text-gray-400 whitespace-nowrap">Any edge</th>
      ${grid.cols.map((st, j) => cell(st, `*:${j}`, `edge 0%+ · ${oddsBandLabel(O, j)}`, { left: co === j })).join('')}
      ${cell(total, '*:*', 'edge 0%+ · any odds', { strong: true })}</tr>`;
  $('grid-table').innerHTML = head + `<tbody>${body}</tbody>`;

  const source = SOURCE_LABELS[$('f-source').value];
  $('grid-sub').textContent = [marketText(), source, stageText(),
    'every price (the odds slider is left out: the columns are the odds)', `${risk.label} risk`].filter(Boolean).join(' · ');
  for (const b of $('grid-detail').children) {
    const on = b.dataset.detail === stakePrefs.detail;
    b.className = `px-2.5 py-1 ${b.previousElementSibling ? 'border-l border-gray-600 ' : ''}${on ? 'bg-gray-600 text-white font-semibold' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`;
    b.setAttribute('aria-pressed', on);
  }

  const ceilings = [ce != null && `bets at an ${edgeBandLabel(E, ce)}`, co != null && `bets at odds of ${oddsBandLabel(O, co)} and longer`].filter(Boolean);
  const conf = `${Math.round(CEILING_CONF * 100)}%`;
  $('grid-ceilings').innerHTML = ceilings.length
    ? `<span class="font-semibold text-red-400">Outliers</span> (dashed line): ${ceilings.join('; ')} have lost, and together the loss is clear of luck (${conf}). `
      + 'Past there a bigger model edge has meant model error, not value, so the Best Bets page stakes nothing.'
    : `No edge or odds yet past which bets have turned to losing, clear of luck. That takes every band from there up (with ${CEILING_MIN_BETS} bets over ${CEILING_MIN_GAMES} games) losing, `
      + `and the bets from there up together losing at the high end of their ${conf} range. Long odds win rarely, so a few without a winner yet is no sign of a loss.`;

  const called = grid.cells.flat().filter(st => st.verdict !== 'thin');
  const proven = called.filter(st => st.verdict === 'ahead').length;
  const byLuck = called.length * (1 - risk.conf);
  $('grid-note').textContent = !bets.length ? 'No settled selections at an edge of 0% or more match these filters yet.'
    : `${count(called.length, 'cell')} of ${grid.cells.flat().length} ${called.length === 1 ? 'has' : 'have'} enough bets to call (${RULE_MIN_BETS} bets over ${RULE_MIN_GAMES} games). `
      + `If there were no edge anywhere, about ${byLuck.toFixed(1)} of them would still show a proven profit by luck at ${risk.label} risk; ${proven} ${proven === 1 ? 'does' : 'do'}. `
      + 'Finer bins look closer but each needs longer to prove anything, and more of them look good by luck. '
      + "The Best Bets page doesn't stake from these cells but from each bet's own pool: settled bets in its market at an edge no higher than its own, "
      + 'at odds from half its own to the next step up (all markets where its own market has proven nothing either way), '
      + 'at odds when first priced (at the price chosen here, which the Best Bets page shares), every source, one bet per market. The outlier lines here apply to it.';
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
    stageText(),
    oddsText(), 'not narrowed by Market'].filter(Boolean).join(' · ');
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
  $('breakdown-sub').textContent = `${stageText(true)}${source ? ` · ${source}` : ''}${oddsText() ? ` · ${oddsText()}` : ''} · select a row to chart it`;
  $('breakdown-body').innerHTML = !base.length
    ? '<tr><td colspan="11" class="px-2 py-8 text-center text-sm text-gray-500">No settled selections yet.</td></tr>'
    : breakdownRow('All sports and markets', base, 'all', current === 'all')
      + groups.map(g => breakdownRow(groupLabel(g), base.filter(b => b.group === g), g, current === g)).join('');
  $('method-note').textContent = 'Returns are per unit staked at the bookie odds, after commission where it applies. Ranges are 90%, from resampling whole games, '
    + "because selections in one game win and lose together. Counted one bet per market, a game's head-to-head, line and total each give one bet: the main line, on the side the model likes best. "
    + 'Scorer odds are the median of US bookmakers, fetched once per game, so those markets have no closing line value. '
    + 'Small samples swing a lot: read the range, not the point.';
}

// --- wiring -------------------------------------------------------------------

function render() {
  const s = scopes(), base = s.base;
  const bets = selected(base);
  let fit = fitBlend(bets), pooled = false;
  if (!fit && bets.length !== base.length) { fit = fitBlend(base); pooled = !!fit; }
  renderCountNote(s);
  renderTiles(bets, fit, pooled);
  renderRules(base);
  renderGrid(s.anyOdds);
  renderRoiChart(bets, fit, pooled);
  renderCalChart(bets);
  renderTeams(s.every);
  renderBreakdown(base);
}

function fillSelect(id, options) {
  $(id).innerHTML = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
}

['f-sport', 'f-market', 'f-source', 'f-stage', 'f-count', 'f-bins', 'f-min-bets', 'f-cal-by'].forEach(id => $(id).addEventListener('change', render));
$('f-price').value = prefs.basis;
$('f-price').addEventListener('change', () => {
  prefs = { ...prefs, basis: basis() };
  savePrefs(prefs);
  render();
});

// Risk, bank and bin detail are shared with the Best Bets page
$('f-risk').value = stakePrefs.risk;
$('f-balance').value = stakePrefs.balance ?? '';
$('f-risk').addEventListener('change', e => { stakePrefs.risk = e.target.value; saveStakePrefs(stakePrefs); render(); });
$('f-balance').addEventListener('change', e => {
  const v = parseFloat(e.target.value);
  stakePrefs.balance = v > 0 ? v : null;
  saveStakePrefs(stakePrefs);
  render();
});
$('grid-detail').addEventListener('click', e => {
  const d = e.target.closest('button[data-detail]')?.dataset.detail;
  if (!d || d === stakePrefs.detail) return;
  stakePrefs.detail = d;
  saveStakePrefs(stakePrefs);
  renderGrid(scopes().anyOdds);
});
$('grid-table').addEventListener('click', e => {
  const list = gridLists.get(e.target.closest('td[data-cell]')?.dataset.cell);
  if (list) openBets(list);
});

// The odds slider: the readout follows the drag, the page redraws on release
for (const [id, start] of [['f-odds-min', ODDS_DEFAULT[0]], ['f-odds-max', ODDS_DEFAULT[1]]]) {
  const el = $(id);
  Object.assign(el, { min: 0, max: ODDS_STOPS.length - 1, value: ODDS_STOPS.indexOf(start) });
  el.addEventListener('input', () => syncOdds(el));
  el.addEventListener('change', render);
}
syncOdds();

function showGroup(key) {
  const [s, k] = key === 'all' ? ['all', 'all'] : key.split('|');
  $('f-sport').value = s;
  $('f-market').value = k;
}

$('breakdown-body').addEventListener('click', e => {
  const key = e.target.closest('tr[data-group]')?.dataset.group;
  if (!key) return;
  showGroup(key);
  render();
});

$('rules-mode').addEventListener('click', e => {
  const mode = e.target.closest('button[data-mode]')?.dataset.mode;
  if (!mode || mode === gridMode) return;
  gridMode = mode;
  renderRules(scopes().base);
});

$('rules-rows').addEventListener('click', e => {
  const row = e.target.closest('tr[data-edge]');
  if (!row) return;
  selEdge = Number(row.dataset.edge);
  renderRules(scopes().base);
});

$('rule-bets').addEventListener('click', () => openBets());

// A row of the best-rules table: that sport and market, with its rule's row open
$('best-rules').addEventListener('click', e => {
  const row = e.target.closest('tr[data-group]');
  if (!row) return;
  showGroup(row.dataset.group);
  gridMode = 'rule';
  selEdge = Number(row.dataset.edge ?? 0);
  render();
});

$('team-table').addEventListener('click', e => {
  const row = e.target.closest('tr[data-team]');
  if (!row) return;
  teamKey = row.dataset.team || null;
  renderTeams(scopes().every);
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
  raw = decodeRows(data);
  pending = data.pending;
  fillSelect('f-sport', [['all', 'All'], ...Object.keys(SPORT_LABELS).filter(s => raw.some(r => r.sport === s)).map(s => [s, SPORT_LABELS[s]])]);
  fillSelect('f-market', [['all', 'All'], ...[...new Set(raw.map(r => r.kind))].sort().map(k => [k, kindLabel(k)])]);
  // Repeats can only be told apart once the backend says which market a selection is in
  if (!raw.some(r => r.market_id != null)) { $('f-count').value = 'all'; $('f-count').disabled = true; }
  $('gate').innerHTML = '';
  $('content').classList.remove('hidden');
  render();
  // The account's price basis, where it differs from this browser's
  syncPrefs(prefs).then(remote => {
    if (!remote) return;
    prefs = remote;
    if ($('f-price').value !== prefs.basis) { $('f-price').value = prefs.basis; render(); }
  }).catch(() => {});
}

init();
