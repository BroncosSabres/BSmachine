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
// filters apply to all of it. "My filters" narrows everything further to the
// Best Bets page's own filters (best-bets-filters.js: the markets on, the
// edge each needs, the odds range), on top of Sport and Market, so selecting
// a market below still narrows to it; Edit opens the same Filters modal,
// "Most profitable" and all. Same access rules as the Best Bets page.
// "My filters over time" charts the bets My filters let through by game day,
// without and with the outlier bets the markets' ⚡ rules in Filters add.
// "Outlier prices" is apart from all that: bets on one bookie far above the
// median of the others, at its price averaged while the gap was there, by
// market and by the model's edge class (above 0 at the median, only at the
// outlier price, neither), with each class's threshold (betfair-api
// outliers.py: where they've paid; with My filters, the markets' ⚡ rules),
// and a gap's bets charted by day, all and by class.
import { BACKEND } from './api-config.js';
import { getSession } from './supabase-client.js';
import { SPORT_LABELS, esc, odds, pct, signedPct, signCls, wonCount, selectionText, loadStakePrefs, saveStakePrefs, money } from './best-bets-shared.js';
import { summarise, binByEdge, calibration, expectedWins, fitBlend, profitableFrom, profit, lineMoveStats,
         FIT_MIN_BETS, FIT_MIN_GAMES, teamGames, sportLevels, leanOf, leanFit, LEAN_MIN_POINTS,
         dropEmptyMarkets, onePerMarket, ruleRows, ruleStats, bestRule, MAX_BOOK, RULE_MIN_BETS, RULE_MIN_GAMES } from './roi-stats.js';
import { BASES, passesMarket, passesEdge, prefsSummary, oddsRangeOf, oddsTyped, inRange, oddsText as rangeText,
         outlierFits, OUT_CLASSES, OUT_CLASS_LABELS, OUT_DEFAULT_CUT, outCutsFor, outRuleOf, windowKeys, fittedCut } from './best-bets-filters.js';
import { localPrefs, syncPrefs, savePrefs, openFilters, filterKeys, filtersDataReady, autoOptimise } from './best-bets-prefs.js';
import { optimiseMarkets, judgeEdgeOf } from './best-bets-optimise.js';
import { installTapTips } from './tap-tips.js';
import { loadCalibration, calibrateBet, closeBet } from './calibrate-client.js';
import { overrounds, MIN_JUDGE_BETS, MIN_JUDGE_GAMES } from './calibrate.js';
import { kindLabel, groupLabel, sourceKey, decodeRows, toBet, outlierBet, outlierBets, rowWindow, windowBet, OUTLIER_CUTS,
         RISK_LEVELS, BIN_DETAIL, binGrid, binStats, kellyStake,
         edgeBandLabel, oddsBandLabel, CEILING_MIN_BETS, CEILING_MIN_GAMES, CEILING_CONF } from './safe-stake.js';

const $ = id => document.getElementById(id);

// Series colours, checked against the card surface for contrast and for
// colour-blind separation. Reference lines stay grey.
const C_ACTUAL = '#d97706', C_SECOND = '#3b82f6', C_REF = '#6b7280', C_INK = '#9ca3af';
const GRID = 'rgba(255,255,255,0.06)';
// A profit and a loss, wherever a chart tells the two apart
const C_UP = '#22c55e', C_DOWN = '#ef4444';

let raw = [];        // decoded rows
let dataVersion = null;   // /api/best_bets/analysis version (what the calibration is cached by)
let calib = null;    // calibrate-client.js result: null while fitting, false if it couldn't be
let rawOverrounds = null;
let pending = 0;
let roiChart = null, calChart = null, leanChart = null, timeChart = null, ruleChart = null;
let teamKey = null;  // 'sport|team' of the team charted over time, or null for all of them
let gridShow = 'roi';     // the edge × odds grid's cells: 'roi' actual return / 'cal' calibrated edge
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
// Which odds a selection is judged at. The last three are over the window in
// which its median edge was positive (only selections that ever showed value):
// the first price then, the time-weighted mean (the return of betting at a
// random moment while it showed), and the highest - a ceiling nobody times.
const STAGES = {
  open: ['odds when first priced', 'when first priced'],
  close: ['closing odds', 'at the close'],
  first: ['odds when first showing value', 'when it first showed value'],
  avg: ['average odds while showing value', 'averaged over the time it showed value'],
  peak: ['peak odds while showing value (not achievable)', 'at the best price while it showed value, a ceiling no one can time'],
};
const stageOf = () => STAGES[$('f-stage').value] || STAGES.avg;
// "odds when first priced · best bookie"
function stageText(capital = false) {
  const t = `${stageOf()[0]} · ${BASES[basis()].toLowerCase()}`;
  return capital ? t[0].toUpperCase() + t.slice(1) : t;
}
const riskOf = () => RISK_LEVELS[stakePrefs.risk] || RISK_LEVELS.medium;

// "My filters": the Best Bets page's filters on top of Sport and Market. Ticked
// or not is remembered in this browser.
const MINE_KEY = 'bsm_best_bets_analysis_mine';
const mine = () => $('f-mine').checked;
// The bets the Best Bets filters let through: the market on, its edge range
// and (odds: false leaves it out) the odds range, all at the median price.
// The edge is the one Filters judges by: the calibrated or predicted-close one
// once it is in.
const minePrefs = () => ((prefs.judge === 'cal' && !calib) || (prefs.judge === 'close' && !calib?.close)
  ? { ...prefs, judge: 'model' } : prefs);
function calEdgeOfBet(b) {
  if (!calib) return null;
  rawOverrounds ??= overrounds(raw, 'close');
  const c = calibrateBet(calib, { ...b.row, mkt_sum: rawOverrounds.get(b.row) }, { modelProb: b.prob, median: b.back, taken: b.taken });
  return c ? c.bookEdge : null;
}
// The predicted-close edge of a bet, at a moment whose time before kickoff is
// known: when first priced (the 'open' stage), else when it first showed value
// (the stages within its value window). Settled rows carry the kickoff's date
// only; the hours left are the real ones (counted back from midnight UTC).
function closeEdgeOfBet(b) {
  const r = b.row;
  if (!calib?.close) return null;
  const st = $('f-stage').value === 'open' ? 'open' : 'first';
  const hrs = r[`${st}_hrs`];
  if (hrs == null || r[`${st}_back`] == null) return null;
  rawOverrounds ??= overrounds(raw, 'close');
  const kick = Date.parse(`${r.kickoff}T00:00:00Z`);
  const c = closeBet(calib, { ...r, kickoff: new Date(kick).toISOString(), mkt_sum: rawOverrounds.get(r) },
                     { modelProb: r[`${st}_prob`], median: r[`${st}_back`],
                       taken: (basis() === 'book' ? r[`${st}_book_back`] : null) ?? r[`${st}_back`], at: kick / 1000 - hrs * 3600 });
  return c ? c.edge : null;
}
const judgedEdge = b => (minePrefs().judge === 'cal' ? calEdgeOfBet(b) : minePrefs().judge === 'close' ? closeEdgeOfBet(b) : b.edge);
const passesMine = (b, odds = true) => odds ? passesMarket(minePrefs(), b.group, judgedEdge(b), b.back)
  : passesEdge(minePrefs(), b.group, judgedEdge(b));

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

// Stops of the odds slider: close together where most prices are, wide apart
// up the long end. The last is "any price".
const ODDS_STOPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50, Infinity];
const ODDS_DEFAULT = [1, Infinity];   // any odds
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

// The bets under the "odds taken", "count" and odds choices. A
// selection priced once has no closing price: it has no CLV and is left out of
// the closing view. Markets with no real prices are always left out.
//   base   what the tiles, rules, charts and breakdown read
//   every  each selection whatever "count" says: the team view pairs up the
//          two sides of a head-to-head itself
//   anyOdds as base at every price: the grid's columns are the odds
function scopes(withMine = mine()) {
  const stage = $('f-stage').value, [oddsLo, oddsHi] = oddsRange();
  const out = [];
  const when = periodTest();
  for (const r of raw) {
    if (when && !when(r)) continue;
    if (stage === 'close' && !(r.n_checks > 1)) continue;
    if (r[`${stage}_back`] == null) continue;   // never showed value (or not recorded)
    out.push(toBet(r, stage, basis()));
  }
  const { kept, dropped } = dropEmptyMarkets(out);
  // The bet that stands for a market is picked before the odds cut, so moving
  // the slider never changes which line or side that is
  const counted = $('f-count').value === 'one' ? onePerMarket(kept) : kept;
  const inOdds = withMine ? b => b.back >= oddsLo && b.back < oddsHi && passesMine(b) : b => b.back >= oddsLo && b.back < oddsHi;
  const base = counted.filter(inOdds);
  // My filters' own odds range (the Best Bets page's) on top of the slider:
  // the bets it alone leaves out
  const bbOdds = oddsRangeOf(minePrefs());
  const oddsCut = withMine && oddsTyped(minePrefs())
    ? counted.filter(b => b.back >= oddsLo && b.back < oddsHi && passesMine(b, false) && !inRange(b.back, bbOdds)).length : 0;
  return { base, every: kept.filter(inOdds), anyOdds: withMine ? counted.filter(b => passesMine(b, false)) : counted,
           empty: dropped, repeats: kept.length - counted.length, fallbacks: base.filter(b => b.fallback).length, oddsCut };
}

// Period: the games that started in it, by the viewer's own calendar
// (kickoff_ts; before the backend sent it, the UTC kickoff date read as a
// local one). -> a row test, or null for all time.
const PERIODS = { all: 'all time', year: 'this year', month: 'this month', d14: 'last 14 days', d7: 'last 7 days', today: 'today' };
function periodTest() {
  const p = $('f-period').value;
  if (!PERIODS[p] || p === 'all') return null;
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const from = { year: new Date(y, 0, 1), month: new Date(y, m, 1), d14: new Date(y, m, d - 13), d7: new Date(y, m, d - 6),
                 today: new Date(y, m, d) }[p].getTime();
  return r => (r.kickoff_ts != null ? r.kickoff_ts * 1000 : new Date(`${r.kickoff}T12:00:00`).getTime()) >= from;
}
const periodText = () => ($('f-period').value === 'all' ? '' : ` · ${PERIODS[$('f-period').value]}`);

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
  return `${s === 'all' ? 'All sports' : SPORT_LABELS[s]} · ${m === 'all' ? 'all markets' : kindLabel(m)}${periodText()}${mine() ? ' · my filters' : ''}`;
};

function scopeText() {
  return [marketText(), stageText(), oddsText()].filter(Boolean).join(' · ');
}

function renderCountNote(s) {
  const parts = [];
  if (s.repeats) parts.push(`${count(s.repeats, 'selection')} left out as the other side, another line or a second source of a bet already counted`);
  if (s.empty) parts.push(`${s.empty.toLocaleString()} left out from markets with no real prices (the prices on offer add up to over ${Math.round(MAX_BOOK * 100)}%)`);
  if (s.oddsCut) parts.push(`${count(s.oddsCut, 'bet')} left out by your Best Bets odds range (${rangeText(oddsRangeOf(minePrefs()))}, at the median price): My filters takes it from the Best Bets page, on top of the slider here`);
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

// The calibration's model weight for the sport / market selected, as the
// model's share of the weight (b / (b + market's)) with its 90% range:
// a market priced from both sources reads its bigger one
function calShare() {
  if (!calib) return null;
  const s = $('f-sport').value, k = $('f-market').value;
  let w = calib.rootWeights, label = 'all markets';
  if (s !== 'all' && k !== 'all') {
    const m = calib.markets.filter(x => x.key.startsWith(`${s}|${k}|`)).sort((a, b) => b.n - a.n)[0];
    if (m) { w = m.weights; label = 'this market'; }
  } else if (s !== 'all' && calib.sportWeights[s]) { w = calib.sportWeights[s]; label = SPORT_LABELS[s]; }
  const total = w.bModel + w.bMarket;
  if (!(total > 0)) return null;
  const c = x => Math.min(1, Math.max(0, x / total));
  return { share: c(w.bModel), lo: c(w.lo), hi: c(w.hi), label };
}

function renderTiles(bets, fit, pooled) {
  const all = summarise(bets), pos = summarise(bets.filter(b => b.edge > 0));
  const cs = calShare();
  $('tiles').innerHTML = [
    tile('Settled selections', all.n.toLocaleString(), `${count(all.games, 'game')} · ${pending.toLocaleString()} more awaiting a result`),
    tile('Return at edge above 0', pos.n ? `<span class="${signCls(pos.roi)}">${signedPct(pos.roi)}</span>` : '–',
      pos.n ? `${count(pos.n, 'bet')}, ${wonCount(pos.wins)} won · model expected ${signedPct(pos.edge)} · 90% range ${range(pos.roiCI)}` : 'No positive-edge bets settled yet',
      'One unit on every selection the model rated above 0%, at the bookie odds'),
    cs ? tile('Model weight', pct(cs.share, 0),
      `90% range ${pct(cs.lo, 0)} to ${pct(cs.hi, 0)} · ${cs.label}, from Model vs market below`,
      "The model's share when its chance and the bookies' (margin out) are fitted to results together, every settled selection at the close, each market leaning on its sport as far as the held-out days said to. 100% = the model's chance is the truth; 0% = the bookies' is.")
    : tile('Model weight', fit?.weight != null ? pct(fit.weight, 0) : '–',
      fit ? `${fit.weightCI ? `90% range ${pct(fit.weightCI[0], 0)} to ${pct(fit.weightCI[1], 0)} · ` : ''}against the bookie price${pooled ? ' · all sports and markets pooled (too few here)' : ''}`
          : `Needs ${FIT_MIN_BETS} settled bets over ${FIT_MIN_GAMES} games`,
      "The model's share when its probability and the bookie's are fitted to results together. 100% = the model's price is the truth; 0% = the bookie's is."),
    tile('Closing line value', pos.clvN ? `<span class="${signCls(pos.clv)}">${signedPct(pos.clv)}</span>` : 'n/a',
      pos.clvN ? `${count(pos.clvN, 'positive-edge bet')} with a closing price` : 'No positive-edge bets here have a closing price',
      'Odds taken against the closing odds. Above zero means the market moved toward the model. A line or total whose line the bookies moved is judged against the close at its own line (Line moves below). Selections priced only once have none.'),
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

// One figure in a detail panel's list
const stat = (label, value, sub = '', title = '') => `<div title="${esc(title)}"><dt class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">${label}</dt>
  <dd class="text-sm font-semibold tabular-nums text-gray-100">${value}</dd>${sub ? `<dd class="text-[10px] text-gray-500 leading-snug">${sub}</dd>` : ''}</div>`;

function renderRuleDetail(cell, fit) {
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
      st.clvN ? `${count(st.clvN, 'bet')} with a closing price` : 'no closing prices here',
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
  // An outlier bet's odds are the outlier price: its gap and the median under
  // them, and its edge at that price with the median's under it
  const out = betsOpen.outlier;
  $('bets-rows').innerHTML = shown.map(b => {
    const r = b.row, p = profit(b);
    return `<tr class="border-t border-gray-700/60 tabular-nums text-gray-300 align-top">
      <td class="px-2 py-1.5 whitespace-nowrap">${dayText(b.date)}</td>
      <td class="px-2 py-1.5">${esc(r.home_team)} v ${esc(r.away_team)}${manySports ? `<span class="block text-[10px] text-gray-500">${esc(SPORT_LABELS[b.sport] || b.sport)}</span>` : ''}</td>
      <td class="px-2 py-1.5"><span class="font-semibold text-gray-100">${esc(selectionText(r))}</span><span class="block text-[10px] text-gray-500">${esc(kindLabel(b.kind))} · ${b.book ? esc(b.book) : 'bookmakers'}</span></td>
      <td class="px-2 py-1.5 text-right">${odds(b.taken ?? b.back)}${out ? `<span class="block text-[10px] text-gray-500 whitespace-nowrap">${b.gap != null ? `gap ${signedPct(b.gap, 0)} · ` : ''}median ${odds(b.back)}</span>` : ''}</td>
      <td class="px-2 py-1.5 text-right">${out
        ? `<span class="${signCls(b.bookEdge)}">${signedPct(b.bookEdge, 0)}</span><span class="block text-[10px] text-gray-500 whitespace-nowrap">median ${signedPct(b.edge, 0)} · model ${pct(b.prob, 0)}</span>`
        : `${signedPct(b.edge, 0)}<span class="block text-[10px] text-gray-500">model ${pct(b.prob, 0)}</span>`}</td>
      <td class="px-2 py-1.5 text-right whitespace-nowrap"><span class="font-semibold ${signCls(p)}">${outcome(b)}</span><span class="block text-[10px] ${signCls(p)}">${p > 0 ? '+' : ''}${p.toFixed(2)}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="px-2 py-8 text-center text-sm text-gray-500">None of these.</td></tr>';
  $('bets-note').textContent = `${bets.length > BETS_MAX ? `The latest ${BETS_MAX} of ${bets.length.toLocaleString()}. ` : ''}${betsOpen.note
    || `Odds and edge are as ${stageOf()[1]}, at the ${basis() === 'book' ? 'best bookie price' : 'average price'}.`} Profit is on 1 unit, after commission where it applies.`;
}

// list: { title, bets, note?, outlier? }, the rule panel's row by default
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
// Market are set to. Only the stage, count, odds range and risk change it.
function renderBestRules(base) {
  const key = [$('f-stage').value, basis(), $('f-count').value, $('f-odds-min').value, $('f-odds-max').value, stakePrefs.risk, raw.length,
               mine() && JSON.stringify([prefs.markets, prefs.odds])].join('|');
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
  $('best-rules-sub').textContent = `${stageText(true)} · ${oddsText() ?? 'any odds'} · rules with at least ${RULE_MIN_BETS} bets over ${RULE_MIN_GAMES} games · select a row to open it above`;
  $('best-rules-note').textContent = 'Each row is the best of several rules, one for each edge its bets are cut at, and the best of several always flatters. Trust one more when the rows around it agree, '
    + 'when it holds up without its best game, and when the closing price moved its way. Its safe stake flatters it for the same reason.';
}

function renderRules(base) {
  const bets = selected(base);
  const fit = fitBlend(bets) || fitBlend(base);
  $('rules-sub').textContent = [marketText(), stageText(), oddsText() ?? 'any odds', '1 unit on every bet in the row'].filter(Boolean).join(' · ');
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

  const showCal = gridShow === 'cal' && !!calib;
  const cell = (st, key, label, { strong = false, top = false, left = false } = {}) => {
    const lines = [`${label}: ${st.n ? `${signedPct(st.roi)} on ${count(st.n, 'bet')} over ${count(st.games, 'game')}` : 'no settled bets'}`];
    const borders = `${top ? 'border-top:2px dashed rgba(239,68,68,0.8);' : ''}${left ? 'border-left:2px dashed rgba(239,68,68,0.8);' : ''}`;
    if (!st.n) return `<td class="px-1.5 py-1 text-center text-gray-700" style="${borders}">·</td>`;
    if (showCal) {
      const edges = st.bets.map(calEdgeOfBet).filter(x => x != null);
      const ce = edges.length ? edges.reduce((a, x) => a + x, 0) / edges.length : null;
      const alpha = ce == null ? 0 : Math.min(0.55, Math.abs(ce) / 0.1 * 0.55);
      const bg = ce == null ? '' : `background:${ce > 0 ? `rgba(34,197,94,${alpha.toFixed(2)})` : `rgba(239,68,68,${alpha.toFixed(2)})`};`;
      lines.push(`Calibrated edge at the price taken, on average: ${signedPct(ce)} (${count(edges.length, 'bet')})`, 'Select to list the bets');
      gridLists.set(key, { title: `${marketText()}: ${label}`, bets: st.bets });
      return `<td data-cell="${key}" class="px-1.5 py-1 text-center cursor-pointer hover:outline hover:outline-1 hover:outline-gray-400 tabular-nums ${strong ? 'border-l border-gray-700' : ''}"
        style="${bg}${borders}" title="${esc(lines.join('\n'))}">
        <div class="font-semibold text-gray-100">${signedPct(ce, 1)}</div>
        <div class="text-[10px] text-gray-400">${signedPct(st.roi, 0)}</div></td>`;
    }
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

  $('grid-sub').textContent = [marketText(), stageText(),
    'every price (the odds slider is left out: the columns are the odds)', `${risk.label} risk`].filter(Boolean).join(' · ');
  for (const b of $('grid-detail').children) {
    const on = b.dataset.detail === stakePrefs.detail;
    b.className = `px-2.5 py-1 ${b.previousElementSibling ? 'border-l border-gray-600 ' : ''}${on ? 'bg-gray-600 text-white font-semibold' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`;
    b.setAttribute('aria-pressed', on);
  }
  for (const b of $('grid-show').children) {
    const on = b.dataset.show === gridShow;
    b.disabled = b.dataset.show === 'cal' && !calib;
    b.className = `px-2.5 py-1 disabled:opacity-40 ${b.previousElementSibling ? 'border-l border-gray-600 ' : ''}${on ? 'bg-gray-600 text-white font-semibold' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`;
    b.setAttribute('aria-pressed', on);
  }

  const ceilings = [ce != null && `bets at an ${edgeBandLabel(E, ce)}`, co != null && `bets at odds of ${oddsBandLabel(O, co)} and longer`].filter(Boolean);
  const conf = `${Math.round(CEILING_CONF * 100)}%`;
  $('grid-ceilings').innerHTML = ceilings.length
    ? `<span class="font-semibold text-red-400">Outliers</span> (dashed line): ${ceilings.join('; ')} have lost, and together the loss is clear of luck (${conf}). `
      + 'Past there a bigger model edge has meant model error, not value, so the Best Bets page stakes nothing.'
    : `No edge or odds yet past which bets have turned to losing, clear of luck. That takes every band from there up (with ${CEILING_MIN_BETS} bets over ${CEILING_MIN_GAMES} games) losing, `
      + `and the bets from there up together losing at the high end of their ${conf} range. Long odds win rarely, so a few without a winner yet is no sign of a loss.`;

  if (showCal) {
    $('grid-note').textContent = "Each cell's bets judged by the calibrated edge at the price taken (Model vs market): green where the fit says there is value, red where it says the model's edge is mostly its own error; the cell's actual return below. "
      + 'A smooth surface fitted to all markets at once rather than a patch picked from the grid, so it moves little with luck. It is fitted on these same results, so it flatters them a little: the out-of-sample columns above are the honest test.';
    return;
  }
  const called = grid.cells.flat().filter(st => st.verdict !== 'thin');
  const proven = called.filter(st => st.verdict === 'ahead').length;
  const byLuck = called.length * (1 - risk.conf);
  $('grid-note').textContent = !bets.length ? 'No settled selections at an edge of 0% or more match these filters yet.'
    : `${count(called.length, 'cell')} of ${grid.cells.flat().length} ${called.length === 1 ? 'has' : 'have'} enough bets to call (${RULE_MIN_BETS} bets over ${RULE_MIN_GAMES} games). `
      + `If there were no edge anywhere, about ${byLuck.toFixed(1)} of them would still show a proven profit by luck at ${risk.label} risk; ${proven} ${proven === 1 ? 'does' : 'do'}. `
      + 'Finer bins look closer but each needs longer to prove anything, and more of them look good by luck. '
      + "The Best Bets page doesn't stake from these cells but from each bet's own pool: settled bets in its market at an edge no higher than its own, "
      + 'at odds from half its own to the next step up (all markets where its own market has proven nothing either way), '
      + 'at the average price while showing value (at the price chosen here, which the Best Bets page shares), every source, one bet per market. The outlier lines here apply to it.';
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
  $('team-sub').textContent = [sport === 'all' ? 'All sports' : SPORT_LABELS[sport], stageText(),
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

// --- model vs market ---------------------------------------------------------------
// calibrate.js per market (in a Worker): the model's weight against the
// price, whether it beat the price out of sample, what betting the calibrated
// edge returned on the held-out days, and closing line value.

const VERDICTS = {
  adds: ['Adds information', 'text-green-400', "Its weight is clear of 0 and the blend beat the price out of sample: the model's edges here carry information the price doesn't."],
  none: ['No evidence yet', 'text-gray-300', "Not shown either way: the model's edges here haven't beaten the price clearly (yet)."],
  hurts: ['Hurts', 'text-red-400', "Its weight is below 0, or the blend did worse than the price out of sample beyond luck: the model's edges here are noise or worse."],
  thin: ['Too few to judge', 'text-gray-500', `Under ${MIN_JUDGE_BETS} settled selections or ${MIN_JUDGE_GAMES} games: it leans on its sport's fit.`],
};

function startCalibration() {
  const b = basis();
  loadCalibration(raw, { version: dataVersion, basis: b, prefs }).then(c => {
    if (b !== basis()) return;
    calib = c || false;
    keepOptimised();   // judging by the calibrated edge, it waited for this
    filtersDataReady();
    render();
  });
}

// Kept on "Most profitable" (prefs.autoOpt): the filters re-fitted to the
// settled bets and calibration in now
function keepOptimised() {
  const next = autoOptimise(prefs, optimise);
  if (next) prefs = next;
}

const roiCell = r => (r && r.n ? `${signedPct(r.roi, 0)}<span class="block text-[10px] text-gray-500">${r.n} bet${r.n === 1 ? '' : 's'}</span>` : '<span class="text-gray-600">–</span>');

// close-model.js, fitted with the calibration: how its predicted closes have
// done out of sample, per market and all told
function renderPredictedClose() {
  const cm = calib && calib.close;
  if (!cm) {
    $('pc-sub').textContent = calib === null ? 'Fitting where prices go by kickoff…'
      : calib === false ? 'Could not be fitted in this browser.'
      : 'Needs the backend that sends when each selection was first priced (open_hrs): not deployed yet.';
    $('pc-summary').innerHTML = '';
    $('pc-body').innerHTML = calib === null ? Array.from({ length: 3 }, () =>
      '<tr><td colspan="7" class="px-2 py-1.5"><span class="bsm-skeleton h-5 w-full block"></span></td></tr>').join('') : '';
    $('pc-note').textContent = '';
    return;
  }
  const s = $('f-sport').value, k = $('f-market').value;
  const ev = cm.eval, days = cm.days || [];
  const cell = (x, f) => (x && x.n ? f(x) : '<span class="text-gray-600">–</span>');
  const clvCell = x => cell(x, v => `<span class="${signCls(v.clv)} font-semibold">${signedPct(v.clv)}</span>`);
  const nCell = x => cell(x, v => `${v.n}`);
  const predCell = x => cell(x, v => `<span class="${signCls(v.pred)}">${signedPct(v.pred)}</span>`);
  const resCell = x => cell(x, v => `<span class="${signCls(v.roi)}">${signedPct(v.roi, 0)}</span>`);
  const a = ev.all;
  $('pc-sub').textContent = `${count(cm.points, 'price move')} learnt from (every selection with a closing price - a moved line's at its own line: when first priced and when it first showed value, each to its close) · held out ${count(days.length, 'day')}`;
  $('pc-summary').innerHTML = !days.length ? 'Too few days settled yet to hold any out.'
    : `Out of sample (${dayText(days[0])} to ${dayText(days.at(-1))}, each day predicted by a fit on the days before), betting when first priced at the best bookie: `
      + `close edge above 0 <span class="${signCls(a.open.close.clv)} font-semibold">${signedPct(a.open.close.clv)}</span> closing line value on ${count(a.open.close.n, 'bet')} `
      + `(predicted ${signedPct(a.open.close.pred)}; results ${signedPct(a.open.close.roi)}) · `
      + `model edge above 0 <span class="${signCls(a.open.model.clv)} font-semibold">${signedPct(a.open.model.clv)}</span> on ${count(a.open.model.n, 'bet')}. `
      + `The model explains ${pct(Math.max(0, ev.move.r2 ?? 0), 0)} of how far held-out prices moved.`;
  const rows = Object.entries(ev.byKey).filter(([key]) => (s === 'all' || key.startsWith(`${s}|`)) && (k === 'all' || key.split('|')[1] === k))
    .sort(([x], [y]) => x.localeCompare(y));
  $('pc-body').innerHTML = rows.map(([key, t]) => {
    const [sport, kind] = key.split('|');
    return `<tr class="border-t border-gray-700/60">
      <td class="px-2 py-1.5 text-left font-semibold text-gray-100">${esc(`${SPORT_LABELS[sport] || sport} · ${kindLabel(kind)}`)}</td>
      <td class="px-2 py-1.5 text-right text-gray-300">${nCell(t.open.close)}</td>
      <td class="px-2 py-1.5 text-right">${predCell(t.open.close)}</td>
      <td class="px-2 py-1.5 text-right">${clvCell(t.open.close)}</td>
      <td class="px-2 py-1.5 text-right">${resCell(t.open.close)}</td>
      <td class="px-2 py-1.5 text-right">${clvCell(t.open.model)}</td>
      <td class="px-2 py-1.5 text-right">${clvCell(t.first.close)}<span class="block text-[10px] text-gray-500">${t.first.close.n ? count(t.first.close.n, 'bet') : ''}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="px-2 py-6 text-center text-sm text-gray-500">No held-out bets in this market yet.</td></tr>';
  $('pc-note').textContent = "Results take thousands of bets to tell a few percent of edge from luck; the closing price settles it far faster. "
    + "This learns, per market, how far prices still move by kickoff with the model's view and the best bookie's premium over the median, and how long is left, "
    + "then judges the price you'd take against the fair closing price it predicts (the bookies' margin out, from how closing prices have done against results). "
    + "Predicted and actual CLV agreeing out of sample says the predictions can be trusted; positive actual CLV is what a real edge looks like before the results can show it. "
    + 'Filters → Judge by: Predicted close lists and stakes by it.';
}

// Lines, totals and yards: how far the bookies moved the line from each bet's
// by the close, and closing-line value with those moves counted (the bets as
// counted above, every filter applied)
function renderLineMoves(base) {
  const bets = selected(base).filter(b => b.lineSrc != null);
  const all = lineMoveStats(bets);
  $('lm-sub').textContent = `${scopeText()} · lines, totals and yards props`;
  if (!all.n) {
    $('lm-summary').textContent = raw.some(r => r.lc_src != null) ? 'No line, total or yards bets here.'
      : 'Needs the backend that sends where each line closed: not deployed yet.';
    $('lm-body').innerHTML = '';
    $('lm-note').textContent = '';
    return;
  }
  const clvCell = (v, n) => (n ? `<span class="${signCls(v)} font-semibold">${signedPct(v)}</span>` : '<span class="text-gray-600">–</span>');
  const ptsCell = v => (v == null ? '<span class="text-gray-600">–</span>' : `<span class="${signCls(v)}">${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}</span>`);
  const roiPair = st => `${st.forN ? `<span class="${signCls(st.roiFor)}">${signedPct(st.roiFor, 0)}</span>` : '–'} / `
    + `${st.againstN ? `<span class="${signCls(st.roiAgainst)}">${signedPct(st.roiAgainst, 0)}</span>` : '–'}`;
  $('lm-summary').innerHTML = `The bookies moved the line on ${count(all.moved, 'bet')} of ${all.n.toLocaleString()} `
    + `(${pct(all.moved / all.n, 0)}): toward ${all.forN}, against ${all.againstN}. `
    + `With line moves counted, closing line value is ${clvCell(all.clv, all.clvN)} on ${count(all.clvN, 'bet')} `
    + `(${all.movedClvN ? `${clvCell(all.movedClv, all.movedClvN)} on the moved ones; ` : ''}against the price alone ${clvCell(all.clvPrice, all.clvPriceN)}), `
    + `${all.beat == null ? '' : `and ${pct(all.beat, 0)} beat the close.`}`;
  const groups = new Map();
  for (const b of bets) {
    if (!groups.has(b.group)) groups.set(b.group, []);
    groups.get(b.group).push(b);
  }
  $('lm-body').innerHTML = [...groups.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([group, gb]) => {
    const st = lineMoveStats(gb);
    return `<tr class="border-t border-gray-700/60">
      <td class="px-2 py-1.5 text-left font-semibold text-gray-100">${esc(groupLabel(group))}</td>
      <td class="px-2 py-1.5 text-right text-gray-300">${st.n.toLocaleString()}</td>
      <td class="px-2 py-1.5 text-right text-gray-300">${pct(st.moved / st.n, 0)}</td>
      <td class="px-2 py-1.5 text-right text-gray-300">${st.forN} / ${st.againstN}</td>
      <td class="px-2 py-1.5 text-right">${ptsCell(st.pts)}</td>
      <td class="px-2 py-1.5 text-right text-gray-300">${st.beat == null ? '–' : pct(st.beat, 0)}</td>
      <td class="px-2 py-1.5 text-right">${clvCell(st.clv, st.clvN)}<span class="block text-[10px] text-gray-500">${st.clvN || ''}</span></td>
      <td class="px-2 py-1.5 text-right">${clvCell(st.clvPrice, st.clvPriceN)}</td>
      <td class="px-2 py-1.5 text-right">${roiPair(st)}</td>
    </tr>`;
  }).join('');
  const src = all.srcs;
  const how = [src.alt && `${src.alt} from the bookies' alternate line at the bet's line`,
               src.model && `${src.model} from the new line's price moved back by the model's chances at the two lines (taken at the closing check)`,
               src.approx && `${src.approx} the same from the model's chances when each line was last priced (older bets: less exact)`,
               src.none && `${src.none} with no closing price at the new line (no CLV)`].filter(Boolean);
  $('lm-note').textContent = 'Bookies move these lines rather than the price, which sits near 1.90 at every line, so the price alone shows almost no movement, '
    + 'and a bet whose line moved used to be judged against its last price before the move. Here it is judged against the closing price at its own line. '
    + (how.length ? `Of the moved: ${how.join('; ')}. ` : '')
    + 'NHL puck lines only ever sit at ±1.5, so a move there is the favourite changing (3 goals on paper, a small move in chance).';
}

function renderModelVsMarket() {
  if (!calib) {
    $('mvm-sub').textContent = calib === false ? 'Could not be fitted in this browser.' : 'Fitting each market against the price…';
    $('mvm-summary').innerHTML = '';
    $('mvm-body').innerHTML = calib === false ? '' : Array.from({ length: 4 }, () =>
      '<tr><td colspan="10" class="px-2 py-1.5"><span class="bsm-skeleton h-5 w-full block"></span></td></tr>').join('');
    $('mvm-note').textContent = '';
    return;
  }
  const s = $('f-sport').value, k = $('f-market').value;
  const rows = calib.markets.filter(m => (s === 'all' || m.key.startsWith(`${s}|`)) && (k === 'all' || m.key.split('|')[1] === k))
    .sort((a, b) => a.key.localeCompare(b.key));
  const fitted = calib.markets.reduce((a, m) => a + m.n, 0);
  const days = calib.days || [];
  const a = calib.all || {};
  const rule = (r, text) => (r && r.n ? `${text} <span class="${signCls(r.roi)} font-semibold">${signedPct(r.roi)}</span> on ${count(r.n, 'bet')}` : null);
  $('mvm-sub').textContent = `${count(fitted, 'settled selection')} (while showing value, else at the close) ·${calib.basis === 'book' ? 'best bookie' : 'average bookie'} price for the returns`;
  $('mvm-summary').innerHTML = !days.length ? 'Too few days settled yet to hold any out: the out-of-sample columns fill in from the 8th day.'
    : `Held out ${count(days.length, 'day')} (${dayText(days[0])} to ${dayText(days.at(-1))}), each scored by a fit on the days before it. One bet per market, at the average price while it showed value: `
      + [rule(a.cal, 'calibrated edge above 0'), rule(a.model, 'every bet that showed value'), rule(a.mine, 'your filters')].filter(Boolean).join(' · ') + '.';
  $('mvm-body').innerHTML = rows.map(m => {
    const [sport, kind] = m.key.split('|');
    const w = m.weights, v = VERDICTS[m.verdict] || VERDICTS.thin;
    const gap = m.gap;
    return `<tr class="border-t border-gray-700/60">
      <td class="px-2 py-1.5 text-left font-semibold text-gray-100">${esc(`${SPORT_LABELS[sport] || sport} · ${kindLabel(kind)}`)}</td>
      <td class="px-2 py-1.5 text-right text-gray-300">${m.n.toLocaleString()}<span class="block text-[10px] text-gray-500">${count(m.games, 'game')}</span></td>
      <td class="px-2 py-1.5 text-right"><span class="font-semibold text-gray-100">${w.bModel.toFixed(2)}</span><span class="block text-[10px] text-gray-500">${w.lo == null ? '' : `${w.lo.toFixed(2)} to ${w.hi.toFixed(2)}`}</span></td>
      <td class="px-2 py-1.5 text-right text-gray-300">${pct(m.own, 0)}</td>
      <td class="px-2 py-1.5 text-right">${gap ? `<span class="font-semibold ${gap.gap < 0 ? 'text-green-400' : gap.gap > 0 ? 'text-red-400' : 'text-gray-300'}">${(gap.gap * 1000).toFixed(1)}</span><span class="block text-[10px] text-gray-500">${gap.lo == null ? `${count(gap.games, 'game')}` : `${(gap.lo * 1000).toFixed(1)} to ${(gap.hi * 1000).toFixed(1)}`}</span>` : '<span class="text-gray-600">–</span>'}</td>
      <td class="px-2 py-1.5 text-left font-semibold ${v[1]}" title="${esc(v[2])}">${v[0]}</td>
      <td class="px-2 py-1.5 text-right">${roiCell(m.returns?.cal)}</td>
      <td class="px-2 py-1.5 text-right">${roiCell(m.returns?.model)}</td>
      <td class="px-2 py-1.5 text-right">${roiCell(m.returns?.mine)}</td>
      <td class="px-2 py-1.5 text-right">${m.clv ? `<span class="${signCls(m.clv.mean)}">${signedPct(m.clv.mean)}</span><span class="block text-[10px] text-gray-500">${m.clv.n}</span>` : '<span class="text-gray-600">–</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="px-2 py-6 text-center text-sm text-gray-500">No settled selections in this market yet.</td></tr>';
  $('mvm-note').textContent = 'Instead of hunting the edge × odds grid for a profitable patch (with dozens of patches to choose from, the best one is mostly luck), '
    + "this fits each market's results on the model's chance and the bookies' (their margin taken out) together: the model weight says how much of the model's disagreement with the price has been worth, "
    + "at the size of the market's typical value bet (the share can grow or shrink with the size of the edge). "
    + `Thin markets lean on their sport, and sports on all markets, as much as the held-out bets that showed value said to (${typeof calib.n0 === 'number' ? `worth ${calib.n0.toLocaleString()} of its bets each`
        : `the model's terms: a sport worth ${calib.n0.sport.toLocaleString()} of all markets' bets, a market ${calib.n0.leaf.toLocaleString()} of its sport's; each market's own margin and lean ${(calib.n0.market ?? calib.n0.leaf).toLocaleString()}`}). `
    + "The calibrated edge it gives every bet - the model's chance moved toward the price by that much - is what Filters → Judge by: Calibrated edge lists and stakes. "
    + 'A selection that showed value is fitted at its average price while it did, the rest at the close. Few days are settled yet: read the ranges, not the points.';
}

// --- breakdown ----------------------------------------------------------------

// The calibration's weight for a breakdown row: its market's (the bigger
// source's), its sport's or all markets'
function calWeightFor(key) {
  if (!calib) return null;
  let w = calib.rootWeights;
  if (key !== 'all') {
    const m = calib.markets.filter(x => x.key.startsWith(`${key}|`)).sort((a, b) => b.n - a.n)[0];
    if (m) w = m.weights;
  }
  const total = w.bModel + w.bMarket;
  if (!(total > 0)) return null;
  const c = x => Math.min(1, Math.max(0, x / total));
  return { share: c(w.bModel), lo: c(w.lo), hi: c(w.hi), w };
}

function breakdownRow(label, bets, key, active) {
  const all = summarise(bets), posBets = bets.filter(b => b.edge > 0), pos = summarise(posBets);
  const fit = fitBlend(bets);
  const cw = calWeightFor(key);
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
    ${cw ? `<td class="px-2 py-2 text-right text-gray-300" title="From Model vs market: model weight ${cw.w.bModel.toFixed(2)}, the bookies' ${cw.w.bMarket.toFixed(2)} (every settled selection, at its typical value bet's edge, leaning on its sport)"><span class="font-semibold text-gray-100">${pct(cw.share, 0)}</span><span class="block text-[10px] text-gray-500">${pct(cw.lo, 0)} to ${pct(cw.hi, 0)}</span></td>`
    : `<td class="px-2 py-2 text-right text-gray-300" title="${fit ? `logit(win) = ${fit.a.toFixed(2)} + ${fit.bModel.toFixed(2)} × model + ${fit.bMarket.toFixed(2)} × bookie` : `Needs ${FIT_MIN_BETS} settled bets over ${FIT_MIN_GAMES} games`}"><span class="font-semibold text-gray-100">${fit?.weight != null ? pct(fit.weight, 0) : '–'}</span>${fit?.weightCI ? `<span class="block text-[10px] text-gray-500">${pct(fit.weightCI[0], 0)} to ${pct(fit.weightCI[1], 0)}</span>` : ''}</td>`}
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
  $('breakdown-sub').textContent = `${stageText(true)}${oddsText() ? ` · ${oddsText()}` : ''} · select a row to chart it`;
  $('breakdown-body').innerHTML = !base.length
    ? '<tr><td colspan="11" class="px-2 py-8 text-center text-sm text-gray-500">No settled selections yet.</td></tr>'
    : breakdownRow('All sports and markets', base, 'all', current === 'all')
      + groups.map(g => breakdownRow(groupLabel(g), base.filter(b => b.group === g), g, current === g)).join('');
  $('method-note').textContent = 'Returns are per unit staked at the bookie odds, after commission where it applies. Ranges are 90%, from resampling whole games, '
    + "because selections in one game win and lose together. Counted one bet per market, a game's head-to-head, line and total each give one bet: the main line, on the side the model likes best. "
    + 'Scorer odds are the median of US bookmakers, fetched once per game, so those markets have no closing line value. '
    + 'Small samples swing a lot: read the range, not the point.';
}

// --- outlier prices -----------------------------------------------------------
// One bookie far above the median of the others (betfair-api outliers.py),
// judged apart by the model's edge - its edge class: above 0 at the median
// price, above 0 only at the outlier price, neither (migration 041). Every
// settled selection keeps, per class and gap of OUTLIER_CUTS, its first price
// there and its average over the time it stayed there (safe-stake.js
// rowWindow; games pruned before 2026-10-28: their first prices only), so the
// bets at any gap are exact, each taken at the best bookie's price averaged
// while it showed. Read from every bookmaker row: Odds from / taken / count /
// odds range don't apply; Sport and Market do. Each market's classes have
// their own threshold: fitted ("Where they've paid"), or with My filters
// ticked, what its ⚡ rule in Filters says. The gap row selected is charted
// below its table by game day, all of it and each class.

let fits = { byClass: false, markets: {} };   // best-bets-filters.js outlierFits of the response's outliers
let outLists = {};         // data-out-list -> { title, bets, note, outlier } behind the tables' cells and the panel
let outSel = null;         // the gap row charted (its cut), or null: the gap chosen above, else the market's threshold
let outChart = null;
const OUT_DEFAULT = OUT_DEFAULT_CUT;     // the gap a class is shown at here while it has no threshold
// Settings that take every market's fitted thresholds ("Where they've paid")
const PAID = { outliers: 'any', markets: {} };
const outPrefs = () => (mine() ? minePrefs() : PAID);

// The gap each class needs in a market, under My filters or the fitted ones
const outCutsOf = g => outCutsFor(outPrefs(), g, fits);
const marketMode = () => $('out-cut').value === 'market';
// The gap a class is shown at in the markets table: its threshold (a class
// that is off: its best judged gap, else +25%), or the gap chosen above
function classCut(g, cls) {
  if (!marketMode()) return +$('out-cut').value;
  return outCutsOf(g)[cls] ?? fits.markets[g]?.classes?.[cls]?.cut ?? OUT_DEFAULT;
}
const outBets = (rows, cut, cls = null) => rows.map(r => outlierBet(r, cut, cls)).filter(Boolean);
const meanOf = xs => xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
const gapText = cut => signedPct(cut, 0);
const outNote = cut => `Odds are the best bookie's averaged while the gap was ${cut != null ? `${gapText(cut)} or more` : 'shown'} (first price there, then the gap over the other bookies' median and the median across all of them, below). `
  + "Edge is the model's at the price taken, with its edge at the median below.";
// Line colours by class (checked against the card for colour-blind separation)
const C_CLASS = { value: C_SECOND, made: C_ACTUAL, none: '#ec4899' };

function outCell(listKey, title, bets, note, extra = '', amber = false) {
  if (!bets.length) return `<td class="px-2 py-2 text-right border-l border-gray-700/60${amber ? ' bg-amber-900/20' : ''}"><span class="text-gray-600">–</span>${extra}</td>`;
  const roi = bets.reduce((a, b) => a + profit(b), 0) / bets.length, wins = bets.reduce((a, b) => a + b.win, 0);
  outLists[listKey] = { title, bets, note, outlier: true };
  return `<td class="px-2 py-2 text-right border-l border-gray-700/60${amber ? ' bg-amber-900/20' : ''}"><button type="button" data-out-list="${esc(listKey)}" class="text-right rounded hover:bg-gray-700/50 px-1 -mx-1" title="List these bets">
      <span class="font-semibold ${signCls(roi)}">${signedPct(roi, 0)}</span><span class="block text-[10px] text-gray-500 whitespace-nowrap">${count(bets.length, 'bet')} · ${wonCount(wins)} won</span></button>${extra}</td>`;
}

// A class's status in a market: what "Where they've paid" makes of it, and
// with My filters ticked, the market's own ⚡ rule where it differs
function classStatus(g, cls) {
  const row = fits.markets[g]?.classes?.[cls];
  const t = fittedCut(fits, g, cls, null);
  let paid;
  if (t != null) {
    const c = (row?.curve || []).find(x => row.cut != null && Math.abs(x.cut - row.cut) < 1e-9);
    paid = `<span class="text-amber-300">shown from ${gapText(t)}</span>${row?.opt_n ? ` <span class="text-gray-500">${c ? `${units(c.units)} · ` : ''}${row.opt_n} bets, ${signedPct(row.opt_roi, 0)}</span>` : ''}`;
  } else if (!fits.byClass) {
    paid = '<span class="text-gray-400">none: not judged by class yet</span>';
  } else if (row?.method === 'unprofitable') {
    const best = row.cut != null ? `Most profitable gap with enough bets and winners: ${gapText(row.cut)}, ${signedPct(row.opt_roi, 0)} on ${row.opt_n} bets` : '';
    paid = `<span class="text-gray-400"${best ? ` title="${esc(best)}"` : ''}>off: lost at every gap</span>`;
  } else paid = '<span class="text-gray-400">off: too few to judge</span>';
  let own = '';
  if (mine()) {
    const out = outRuleOf(minePrefs(), g);
    if (minePrefs().outliers === 'off' || out.mode === 'off') own = 'yours: off';
    else if (out.mode === 'custom') own = `yours: ${out.gaps[cls] === '' ? 'off' : `from ${gapText(+out.gaps[cls])}`}`;
  }
  return `<span class="block text-[10px] whitespace-nowrap">${paid}</span>${own ? `<span class="block text-[10px] text-blue-300 whitespace-nowrap">${own}</span>` : ''}`;
}

// The final value of each line just past its right end, nudged apart so two
// that end close together don't overlap: a dash in the line's colour, the
// figure in ink.
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea: a } = chart;
    const pctLabels = chart.options.plugins.endLabels?.pct;
    const items = chart.data.datasets.map((ds, i) => {
      const end = chart.isDatasetVisible(i) && chart.getDatasetMeta(i).data.at(-1);
      return end ? { y: end.y, value: ds.data.at(-1).y, color: ds.borderColor } : null;
    }).filter(Boolean).sort((p, q) => p.y - q.y);
    for (let k = 1; k < items.length; k++) items[k].y = Math.max(items[k].y, items[k - 1].y + 13);
    ctx.save();
    ctx.font = `600 10px ${Chart.defaults.font.family}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const it of items) {
      ctx.fillStyle = it.color;
      ctx.fillRect(a.right + 4, it.y - 1, 6, 2);
      ctx.fillStyle = C_INK;
      ctx.fillText(pctLabels ? `${it.value > 0 ? '+' : ''}${Math.round(it.value)}%` : `${it.value > 0 ? '+' : ''}${it.value.toFixed(1)}`, a.right + 13, it.y);
    }
    ctx.restore();
  },
};

// The total's line: neutral, as its parts add up to it
const C_ALL = '#d1d5db';
const DAY_MS = 86400000;
const dayMs = date => Date.parse(`${date}T00:00:00Z`);

// A running chart by game day: lines [{ label, color, width, bets }], each
// with a point on every day any bet settled, so the tooltip reads them
// together. y: 'units' (running profit) or 'roi' (running profit / bets, %).
function runningChart(canvas, lines, y = 'units') {
  const days = [...new Set(lines.flatMap(l => l.bets.map(b => b.date)))].sort();
  if (!days.length) return null;
  const start = dayMs(days[0]) - DAY_MS;
  const datasets = lines.map(({ label, color, width, bets }) => {
    const byDay = new Map();
    for (const b of bets) byDay.set(b.date, [...(byDay.get(b.date) || []), b]);
    let run = 0, n = 0;
    const data = [{ x: start, y: 0 }];
    for (const d of days) {
      const today = byDay.get(d) || [];
      run += today.reduce((a, b) => a + profit(b), 0);
      n += today.length;
      data.push({ x: dayMs(d), y: y === 'roi' ? (n ? 100 * run / n : 0) : run, units: run, n, day: d, today: today.length });
    }
    return { label, data, borderColor: color, backgroundColor: color, borderWidth: width,
             pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 6, stepped: 'after' };
  });
  const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
  return new Chart(canvas, { type: 'line', data: { datasets }, plugins: [endLabels],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      layout: { padding: { right: 44 } },
      scales: {
        x: { type: 'linear', min: start, max: dayMs(days.at(-1)),
             // Ticks on whole days, a week or more apart once the span is long
             afterBuildTicks: axis => {
               const span = (axis.max - axis.min) / DAY_MS;
               const step = [1, 2, 3, 7, 14, 28].find(s => span / s <= 8) ?? 56;
               axis.ticks = [];
               for (let t = axis.min + DAY_MS; t <= axis.max; t += step * DAY_MS) axis.ticks.push({ value: t });
             },
             ticks: { color: C_INK, font: { size: 10 }, maxRotation: 0, callback: v => dayText(isoDay(v)) },
             grid: { display: false }, border: { color: 'rgba(255,255,255,0.1)' } },
        y: { title: { display: true, text: y === 'roi' ? 'ROI so far (%)' : 'Units', color: C_INK, font: { size: 10 } },
             ticks: { color: C_INK, font: { size: 10 } },
             grid: { color: ctx => ctx.tick.value === 0 ? 'rgba(255,255,255,0.35)' : GRID }, border: { color: 'rgba(255,255,255,0.1)' } },
      },
      plugins: {
        endLabels: { pct: y === 'roi' },
        legend: { labels: { color: C_INK, usePointStyle: true, pointStyle: 'line', pointStyleWidth: 18, font: { size: 11 } } },
        tooltip: { filter: item => item.raw.day != null,
          callbacks: { title: items => dayText(items[0].raw.day),
                       label: item => `${item.dataset.label}: ${units(item.raw.units)}${item.raw.n ? ` (${signedPct(item.raw.units / item.raw.n)})` : ''} after ${count(item.raw.n, 'bet')}`,
                       footer: items => { const all = items.find(i => i.datasetIndex === 0)?.raw; return all ? `${count(all.today, 'bet')} on the day` : ''; } } },
      },
    } });
}

// The gap row selected (or null): what it returned, its chart (all of it
// and each class), and its median-edge and outlier-price-only bets by the
// edge at the price taken
function renderOutDetail(sel, scope) {
  outChart?.destroy();
  outChart = null;
  $('out-detail').classList.toggle('hidden', !sel);
  if (!sel) return;
  const { cut, bets, st } = sel;
  const title = `${scope} · gap ${gapText(cut)} and over`;
  outLists.sel = { title, bets, note: outNote(cut), outlier: true };
  const [chip, chipCls] = VERDICT_CHIPS[st.verdict];
  $('out-sel-title').textContent = title;
  $('out-sel-verdict').innerHTML = `<span class="inline-block rounded px-1.5 py-0.5 mr-1.5 text-[10px] font-semibold ${chipCls}">${chip}</span>`
    + (st.verdict === 'thin' ? `${count(st.n, 'bet')} over ${count(st.games, 'game')}. A gap is called once it has ${RULE_MIN_BETS} bets over ${RULE_MIN_GAMES} games.`
      : st.verdict === 'open' ? `The 90% range runs from ${signedPct(st.roiCI[0], 0)} to ${signedPct(st.roiCI[1], 0)}, so the result so far could be luck either way.`
      : st.verdict === 'ahead' ? 'Even the low end of the 90% range is a profit. It is one of several gaps looked at, so check the rows around it agree.'
      : 'Even the high end of the 90% range is a loss.');
  const exp = expectedWins(bets.filter(b => b.prob != null));
  const atBook = meanOf(bets.map(b => b.bookEdge).filter(x => x != null)), atMedian = meanOf(bets.map(b => b.edge).filter(x => x != null));
  $('out-sel-stats').innerHTML = [
    stat('Returned', `<span class="${signCls(st.roi)}">${signedPct(st.roi)}</span>`, st.roiCI ? `90% range ${range(st.roiCI)}` : 'too few games for a range'),
    stat('Profit', `<span class="${signCls(st.units)}">${units(st.units)}</span>`, `${count(st.n, 'bet')} over ${count(st.games, 'game')}`),
    stat('Won', `${wonCount(st.wins)} of ${st.n.toLocaleString()}`, exp.n ? `model expected ${exp.model.toFixed(1)} · median price ${exp.bookie.toFixed(1)}` : '',
      "How many won, against what the model's chances and the bookies' median price (1 / odds, margin included) expected"),
    stat('Model expected', signedPct(atBook), `at the outlier price${atMedian != null ? ` · ${signedPct(atMedian)} at the median` : ''}`,
      "The return the model's chances say these bets should make at the price taken, and at the median price"),
    stat('Without best game', st.restRoi != null ? `<span class="${signCls(st.restRoi)}">${signedPct(st.restRoi)}</span>` : '–', 'the return with its most profitable game taken out',
      'A gap that lives off one game falls over here'),
  ].join('');
  outChart = runningChart($('out-chart'), [
    { label: 'All', color: C_ALL, width: 2.5, bets },
    ...OUT_CLASSES.map(cls => ({ label: OUT_CLASS_LABELS[cls], color: C_CLASS[cls], width: 2, bets: bets.filter(b => b.cls === cls) })),
  ]);
  renderOutBands(sel, title);
}

// Bands of the model's edge at the outlier price taken (averaged while it
// showed), for the bets with an edge there: whether the biggest edges are the
// model's error. For reading only - nothing is filtered by them.
const EDGE_BANDS = [[0, 0.1, '0–10%'], [0.1, 0.2, '10–20%'], [0.2, 0.4, '20–40%'], [0.4, Infinity, '40%+']];
function renderOutBands(sel, title) {
  const classes = ['value', 'made'];
  const bets = sel.bets.filter(b => classes.includes(b.cls) && b.bookEdge != null);
  if (!bets.length) { $('out-bands').innerHTML = ''; return; }
  const head = EDGE_BANDS.map(([, , label]) => `<th class="px-2 py-1.5 text-right font-semibold border-l border-gray-700/60">${label}</th>`).join('');
  const rows = classes.map(cls => {
    const mineCls = bets.filter(b => b.cls === cls);
    const cells = EDGE_BANDS.map(([lo, hi, label]) => outCell(`band|${cls}|${label}`, `${title} · ${OUT_CLASS_LABELS[cls].toLowerCase()} · edge ${label} at the outlier price`,
      mineCls.filter(b => b.bookEdge >= lo && b.bookEdge < hi), outNote(sel.cut))).join('');
    return `<tr class="border-t border-gray-700/60 tabular-nums"><td class="px-2 py-2 text-left text-gray-200 whitespace-nowrap">${esc(OUT_CLASS_LABELS[cls])}</td>${cells}</tr>`;
  }).join('');
  $('out-bands').innerHTML = `<div class="text-[11px] text-gray-500 mb-1">By the model's edge at the outlier price (averaged while shown). For reading only: the filters don't use it.</div>
    <div class="overflow-x-auto -mx-1"><table class="w-full text-sm sm:min-w-[36rem]"><thead><tr class="text-xs text-gray-500 uppercase tracking-wider">
      <th class="px-2 py-1.5 text-left font-semibold">Edge class</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function outRoi(st) {
  if (!st.n) return '<span class="text-gray-600">–</span>';
  return `<span class="font-bold ${signCls(st.roi)}">${signedPct(st.roi, 0)}</span>${st.roiCI ? `<span class="block text-[10px] text-gray-500">${range(st.roiCI)}</span>` : ''}`;
}

function renderOutliers() {
  const when = periodTest();
  const rows = raw.filter(r => sourceKey(r) === 'book' && (!when || when(r)));
  const groups = [...new Set([...rows.filter(r => rowWindow(r)).map(r => r.group), ...Object.keys(fits.markets)])].sort();
  const mm = marketMode();
  $('out-sub').textContent = 'One bookie well above the median of the others, bet at that price averaged while the gap was '
    + `${mm ? `at least ${mine() ? 'what your Filters set' : "its class's threshold"} (each market and edge class apart)` : `${gapText(+$('out-cut').value)} or more`}. `
    + 'Select a market to see it by gap, or a cell to list its bets.';
  outLists = {};
  if (!rows.some(r => rowWindow(r))) {
    $('out-markets').innerHTML = '<tr><td colspan="9" class="px-2 py-8 text-center text-sm text-gray-500">No outlier prices recorded yet.</td></tr>';
    $('out-gaps').innerHTML = '';
    $('out-gap-title').textContent = '';
    $('out-gap-sub').textContent = '';
    $('out-note').textContent = '';
    renderOutDetail(null);
    return;
  }
  const current = $('f-sport').value !== 'all' && $('f-market').value !== 'all' ? `${$('f-sport').value}|${$('f-market').value}` : null;
  $('out-markets').innerHTML = groups.map(g => {
    const m = fits.markets[g]?.all;
    const mineRows = rows.filter(r => r.group === g);
    // The bets shown: under each class's threshold (the union), or every class at the gap chosen
    const bets = mm ? mineRows.map(r => { const k = windowKeys(outPrefs(), g, rowWindow(r), fits); return k.length ? windowBet(r, k) : null; }).filter(Boolean)
      : outBets(mineRows, +$('out-cut').value);
    const st = ruleStats(bets, { thinRange: true });
    const title = `${groupLabel(g)}${periodText()} · ${mm ? (mine() ? 'your outlier settings' : 'where they\'ve paid') : `gap ${gapText(+$('out-cut').value)} and over`}`;
    if (st.n) outLists[g] = { title, bets, note: outNote(mm ? null : +$('out-cut').value), outlier: true };
    // A class that is on: the bets it shows (each at its threshold, or its
    // consensus band's floor where that is higher, as the Best Bets page);
    // one that is off, or a gap chosen above: every bet in it at that gap
    const cells = OUT_CLASSES.map(cls => {
      const cut = classCut(g, cls), on = mm && outCutsOf(g)[cls] != null;
      const bets = on ? mineRows.map(r => {
        const k = windowKeys(outPrefs(), g, rowWindow(r), fits).filter(x => x.startsWith(`${cls}:`));
        return k.length ? windowBet(r, k) : null;
      }).filter(Boolean) : outBets(mineRows, cut, cls);
      return outCell(`${g}|${cls}`, `${groupLabel(g)}${periodText()} · ${OUT_CLASS_LABELS[cls].toLowerCase()} · gap ${on ? 'from ' : ''}${gapText(cut)}${on ? '' : ' and over'}`,
        bets, outNote(on ? null : cut), `${mm ? `<span class="block text-[10px] text-gray-500">${on ? 'from' : 'at'} ${gapText(cut)}+</span>` : ''}${classStatus(g, cls)}`);
    }).join('');
    return `<tr data-group="${esc(g)}" class="border-t border-gray-700/60 cursor-pointer hover:bg-gray-700/20 tabular-nums align-top ${g === current ? 'bg-gray-700/30' : ''}">
      <td class="px-2 py-2 text-left font-semibold text-gray-100">${esc(groupLabel(g))}</td>
      <td class="px-2 py-2 text-right text-gray-300">${m ? m.n_games.toLocaleString() : '–'}</td>
      <td class="px-2 py-2 text-right text-gray-300"${m?.h != null ? ` title="${esc(`A unit bet at the others' median price returned ${m.h.toFixed(3)} over ${m.n.toLocaleString()} settled selections`)}"` : ''}>${m?.breakeven != null ? gapText(m.breakeven) : '–'}</td>
      <td class="px-2 py-2 text-right text-gray-300">${st.n ? `<button type="button" data-out-list="${esc(g)}" class="rounded hover:bg-gray-700/50 px-1 -mx-1" title="List these bets">${st.n.toLocaleString()}</button>` : '–'}</td>
      <td class="px-2 py-2 text-right text-gray-300">${st.n ? wonCount(st.wins) : '–'}</td>
      <td class="px-2 py-2 text-right">${outRoi(st)}</td>
      ${cells}
    </tr>`;
  }).join('');

  // By gap, for the Sport and Market chosen
  const sel = rows.filter(r => ($('f-sport').value === 'all' || r.sport === $('f-sport').value)
    && ($('f-market').value === 'all' || r.kind === $('f-market').value));
  const cuts = current ? outCutsOf(current) : null;
  const scope = marketText().replace(' · my filters', '');
  const lines = OUTLIER_CUTS.map(cut => {
    const bets = outBets(sel, cut);
    if (!bets.length) return null;
    return { cut, bets, st: ruleStats(bets, { thinRange: true }), expected: meanOf(bets.map(b => b.bookEdge).filter(x => x != null)) };
  }).filter(Boolean);
  // The row charted: the one selected, else the gap chosen above (the
  // lowest class threshold of the market, +25% without one)
  const lowest = cuts ? Math.min(...Object.values(cuts).filter(c => c != null)) : Infinity;
  const preferred = mm ? (isFinite(lowest) ? lowest : OUT_DEFAULT) : +$('out-cut').value;
  const shown = lines.find(l => l.cut === outSel) || lines.find(l => l.cut === preferred) || lines.find(l => l.cut === OUT_DEFAULT) || lines[0] || null;
  const reach = Math.max(0.2, ...lines.flatMap(l => [Math.abs(l.st.roi), Math.abs(l.expected ?? 0)]));
  $('out-gap-title').textContent = `By gap · ${scope}`;
  $('out-gap-sub').textContent = 'Each row: every bet whose gap reached it, so the rows overlap. Select one to chart it below, or a cell to list its bets.'
    + (cuts && Object.values(cuts).some(c => c != null) ? ` Amber: the gap each class is shown from${mine() ? ' under your Filters' : ''}.` : '');
  $('out-gaps').innerHTML = lines.map(l => {
    const on = l === shown, title = `${scope} · gap ${gapText(l.cut)} and over`;
    const cells = OUT_CLASSES.map(cls => outCell(`cut:${l.cut}|${cls}`, `${title} · ${OUT_CLASS_LABELS[cls].toLowerCase()}`,
      outBets(sel, l.cut, cls), outNote(l.cut), '', cuts?.[cls] === l.cut)).join('');
    return `
    <tr data-cut="${l.cut}" aria-selected="${on}" class="border-t border-gray-700/60 cursor-pointer hover:bg-gray-700/20 tabular-nums ${on ? 'bg-gray-700/40' : ''}">
      <td class="px-2 py-2 text-left font-semibold text-gray-100" style="${on ? 'box-shadow:inset 3px 0 0 #d97706;' : ''}">${gapText(l.cut)}</td>
      <td class="px-2 py-2 text-right text-gray-300">${l.st.n.toLocaleString()}</td>
      <td class="px-2 py-2 text-right text-gray-300">${wonCount(l.st.wins)}</td>
      <td class="px-2 py-2 text-right ${signCls(l.st.units)}">${l.st.units > 0 ? '+' : ''}${l.st.units.toFixed(1)}</td>
      <td class="px-2 py-2 text-right">${outRoi(l.st)}</td>
      <td class="px-2 py-2">${returnBar({ ...l.st, edge: l.expected ?? 0 }, reach)}</td>
      ${cells}
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="px-2 py-8 text-center text-sm text-gray-500">No settled outlier prices here.</td></tr>';
  renderOutDetail(shown, scope);
  $('out-note').textContent = 'Gap: the best price over the median of the other bookies, minus 1 (Ladbrokes $17 against $7.50 is +127%); '
    + 'only with 3 or more bookies, and Ladbrokes / Neds and TABtouch / Unibet, which share price feeds, count as one. '
    + 'Each bet is taken at that bookie\'s price averaged over the time it showed at that gap or more, every check counted (games before '
    + "28 Oct kept only their first and last prices before kickoff, so theirs are the first price there). Edge classes: the model's edge "
    + 'at the median price across the bookies above 0 (what would list it without any gap), above 0 only at the outlier price (the gap '
    + 'made the value), or neither (or not priced); a bet whose edge moved counts in each class it showed in, and once in a market\'s total. '
    + "Break-even: the gap a bet needs if the others' median were right after their margin, measured on every settled selection of the "
    + "market. Where they've paid: each class's threshold is the gap at which its settled outlier bets have made the most profit (units, not ROI), once one has "
    + 'at least 15 bets and 5 winners and is in profit (for the classes without a median edge, at or above a cautious break-even); '
    + 'a class that has lost at every such gap, or has none with that many, is off; a class on is shown from the higher of its threshold and its consensus price band\'s cautious break-even (not for a median edge). With My filters ticked, each market\'s ⚡ rule in '
    + 'Filters sets the gaps instead. The rows by gap are exactly what betting at each gap would have got, but picking the best of '
    + 'them is fitted to these results: expect less from it. These bets are in every other table on the page too, by their own edge and odds.';
}

// --- my filters over time -------------------------------------------------------
// The bets My filters let through (the value bets the page counts, at the
// stage and price chosen) by game day, without and with the outlier bets the
// markets' ⚡ rules add: outliers already among those bets (a median edge in
// the market's range) count once, the rest at their average best price while
// shown (their first price there for the open and first stages).

let mtChart = null;
let mtY = 'units';
let mtLists = {};          // data-mt-list -> the bets behind a tile

function mineTimeBets() {
  const s = scopes(true);
  const base = selected(s.base);
  const when = periodTest(), [oddsLo, oddsHi] = oddsRange(), bbOdds = oddsRangeOf(minePrefs());
  const oneEach = $('f-count').value === 'one';
  const counted = new Set(base.map(b => b.row));
  const markets = new Set(oneEach ? base.map(b => b.market).filter(Boolean) : []);
  const added = [];
  const rows = raw.filter(r => !when || when(r));
  for (const b of selected(outlierBets(rows, minePrefs(), fits, $('f-stage').value))) {
    if (counted.has(b.row) || !(b.back >= oddsLo && b.back < oddsHi) || !inRange(b.back, bbOdds)) continue;
    if (oneEach && b.market) {
      if (markets.has(b.market)) continue;
      markets.add(b.market);
    }
    added.push(b);
  }
  return { base, added, all: [...base, ...added] };
}

function renderMineTime() {
  mtChart?.destroy();
  mtChart = null;
  for (const b of $('mt-y').children) {
    const on = b.dataset.y === mtY;
    b.className = `px-2.5 py-1 ${b.previousElementSibling ? 'border-l border-gray-600 ' : ''}${on ? 'bg-gray-600 text-white font-semibold' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`;
    b.setAttribute('aria-pressed', on);
  }
  const on = mine();
  $('mt-body').classList.toggle('hidden', !on);
  $('mt-y').classList.toggle('hidden', !on);
  if (!on) {
    $('mt-sub').textContent = 'Tick My filters above to see the bets your Best Bets filters let through over time, with and without the outlier bets they add.';
    $('mt-note').textContent = '';
    return;
  }
  const { base, added, all } = mineTimeBets();
  mtLists = {};
  $('mt-sub').textContent = `${scopeText()} · your outlier settings${minePrefs().outliers === 'off' ? ' (off)' : ''}`;
  const tile = (label, bets, key, note) => {
    const st = ruleStats(bets, { thinRange: true });
    mtLists[key] = { title: `${label} · ${scopeText()}`, bets, outlier: key === 'mt-added',
                      note: key === 'mt-added' ? outNote(null) : undefined };
    return `<div class="rounded-lg border border-gray-700/70 p-3">
      <div class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">${label}</div>
      <div class="text-xl font-bold tabular-nums mt-0.5">${st.n ? `<span class="${signCls(st.roi)}">${signedPct(st.roi)}</span>` : '–'}</div>
      <div class="text-[11px] text-gray-500">${st.n ? `${units(st.units)} · ${bets.length ? `<button type="button" data-mt-list="${key}" class="text-blue-400 hover:underline">${count(st.n, 'bet')}</button>` : '0 bets'}, ${wonCount(st.wins)} won${st.roiCI ? ` · 90% range ${range(st.roiCI)}` : ''}` : note}</div>
    </div>`;
  };
  $('mt-stats').innerHTML = tile('Without outliers', base, 'mt-base', 'No bets under your filters here')
    + tile('With outliers', all, 'mt-all', 'No bets under your filters here')
    + tile('Outliers added', added, 'mt-added', minePrefs().outliers === 'off' ? 'Outliers are off in your Filters' : 'No outlier bets your filters would add here');
  mtChart = runningChart($('mt-chart'), [
    { label: 'With outliers', color: C_ALL, width: 2.5, bets: all },
    { label: 'Without outliers', color: C_SECOND, width: 2, bets: base },
    { label: 'Outliers added', color: C_ACTUAL, width: 2, bets: added },
  ], mtY);
  $('mt-note').textContent = 'Without: the bets your filters let through, as the rest of the page counts them. Outliers added: the outlier '
    + "prices your markets' ⚡ rules in Filters list that those don't already count (one per market when Count is one per market), "
    + 'at the best bookie\'s price averaged while shown, edge or not; With: the two together, which is what following the Best Bets list '
    + 'would have bet. Sport, Market, Period, the odds slider and your odds range apply to both.';
}

// --- wiring -------------------------------------------------------------------

// The Filters button's summary, and the modal's markets: every one of the
// sports with settled bets
const modalKeys = () => filterKeys(Object.keys(SPORT_LABELS).filter(sp => raw.some(r => r.sport === sp)), raw.map(r => r.group));
function renderMine() {
  // The odds range too: the Best Bets page shows it in its own top bar, so
  // its summary leaves it out, but here it would otherwise be invisible
  const odds = oddsTyped(prefs) ? rangeText(oddsRangeOf(prefs)) : null;
  $('f-mine-summary').textContent = prefsSummary(prefs, modalKeys()) + (odds ? ` · ${odds}` : '');
}

// { market: settled bets my filters let through, at the scope chosen, and
// the outlier bets its ⚡ rule adds ({ n, out }) }
function mineCounts() {
  const counts = {};
  const { base, added } = mineTimeBets();
  for (const b of base) (counts[b.group] ||= { n: 0, out: 0 }).n += 1;
  for (const b of added) (counts[b.group] ||= { n: 0, out: 0 }).out += 1;
  return counts;
}

function render() {
  renderMine();
  renderModelVsMarket();
  renderPredictedClose();
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
  renderLineMoves(base);
  renderTeams(s.every);
  renderOutliers();
  renderMineTime();
  renderBreakdown(base);
}

function fillSelect(id, options) {
  $(id).innerHTML = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
}

['f-sport', 'f-market', 'f-period', 'f-stage', 'f-count', 'f-bins', 'f-min-bets', 'f-cal-by'].forEach(id => $(id).addEventListener('change', render));
try { $('f-mine').checked = localStorage.getItem(MINE_KEY) === '1'; } catch { /* storage unavailable */ }
$('f-mine').addEventListener('change', () => {
  try { localStorage.setItem(MINE_KEY, mine() ? '1' : '0'); } catch { /* storage unavailable */ }
  render();
});
// The Best Bets page's Filters modal, here: changes are saved for both pages.
// "Most profitable" (and kept on it) judges as Filters says, once the
// calibration it needs is in.
const optimise = Object.assign(next => optimiseMarkets(raw, next, modalKeys(), judgeEdgeOf(raw, next, calib) ?? null),
                               { ready: next => raw.length > 0 && judgeEdgeOf(raw, next ?? prefs, calib) !== undefined });
$('f-mine-edit').addEventListener('click', () => openFilters({
  prefs, keys: modalKeys(), counts: mineCounts(), countLabel: 'settled', opener: $('f-mine-edit'), optimise, fits,
  onChange: next => {
    prefs = next;
    savePrefs(prefs);
    $('f-price').value = prefs.basis;
    if (!mine()) { $('f-mine').checked = true; try { localStorage.setItem(MINE_KEY, '1'); } catch { /* storage unavailable */ } }
    render();
    return mineCounts();
  },
}));

$('f-price').value = prefs.basis;
$('f-price').addEventListener('change', () => {
  prefs = { ...prefs, basis: basis() };
  savePrefs(prefs);
  if (calib !== null) { calib = null; startCalibration(); }
  keepOptimised();
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
$('grid-show').addEventListener('click', e => {
  const b = e.target.closest('[data-show]');
  if (!b || b.disabled || b.dataset.show === gridShow) return;
  gridShow = b.dataset.show;
  renderGrid(scopes().anyOdds);
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

$('out-cut').innerHTML = [['market', "Each market's threshold"], ...OUTLIER_CUTS.map(c => [String(c), gapText(c)])]
  .map(([v, label]) => `<option value="${v}">${esc(label)}</option>`).join('');
$('out-cut').value = 'market';
$('out-cut').addEventListener('change', () => { outSel = null; renderOutliers(); });
// A split (or a market's bet count) lists its bets; elsewhere on a row, the
// market's row chooses it above and the gap's row is charted
const outListAt = e => outLists[e.target.closest('[data-out-list]')?.dataset.outList];
$('out-markets').addEventListener('click', e => {
  const list = outListAt(e);
  if (list) { openBets(list); return; }
  const key = e.target.closest('tr[data-group]')?.dataset.group;
  if (!key) return;
  outSel = null;
  showGroup(key);
  render();
});
$('out-gaps').addEventListener('click', e => {
  const list = outListAt(e);
  if (list) { openBets(list); return; }
  const cut = e.target.closest('tr[data-cut]')?.dataset.cut;
  if (cut == null) return;
  outSel = Number(cut);
  renderOutliers();
});
$('mt-y').addEventListener('click', e => {
  const y = e.target.closest('button[data-y]')?.dataset.y;
  if (!y || y === mtY) return;
  mtY = y;
  renderMineTime();
});
$('mt-stats').addEventListener('click', e => {
  const list = mtLists[e.target.closest('[data-mt-list]')?.dataset.mtList];
  if (list) openBets(list);
});
$('out-sel-bets').addEventListener('click', () => { if (outLists.sel) openBets(outLists.sel); });
installTapTips(document.body);

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
  // Bookmaker odds only: Betfair is no longer used (the backend leaves its
  // rows out too; this covers a response from before it did)
  raw = decodeRows(data).filter(r => String(r.market_id).startsWith('oddsapi:'));
  dataVersion = data.version ?? null;
  rawOverrounds = null;
  pending = data.pending;
  fits = outlierFits(data.outliers);
  fillSelect('f-sport', [['all', 'All'], ...Object.keys(SPORT_LABELS).filter(s => raw.some(r => r.sport === s)).map(s => [s, SPORT_LABELS[s]])]);
  fillSelect('f-market', [['all', 'All'], ...[...new Set(raw.map(r => r.kind))].sort().map(k => [k, kindLabel(k)])]);
  // Repeats can only be told apart once the backend says which market a selection is in
  if (!raw.some(r => r.market_id != null)) { $('f-count').value = 'all'; $('f-count').disabled = true; }
  $('gate').innerHTML = '';
  $('content').classList.remove('hidden');
  keepOptimised();
  render();
  startCalibration();
  // The account's filters and price basis, where they differ from this browser's
  syncPrefs(prefs).then(remote => {
    if (!remote) return;
    prefs = remote;
    keepOptimised();
    $('f-price').value = prefs.basis;
    render();
  }).catch(() => {});
}

init();
