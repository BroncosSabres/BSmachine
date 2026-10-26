// best-bets.js — drives pages/best_bets.html.
//
// Model prices vs Betfair Exchange back prices, pre-computed off-site (the
// betfair-api repo) and served by /api/best_bets — this page never talks to
// Betfair. Access is per account: the API answers 401 (not signed in), 403
// (signed in, not granted) or the data, and the page shows a sign-in card, a
// "Restricted" card or the tables accordingly. The Filters modal sets which
// markets show, the edge each needs and whether bets are judged at the best
// single bookie's price (the default) or the median across them; it is saved to
// the account. The track-record sidebar aggregates the settled selections
// from /api/best_bets/analysis in the browser, one bet per market as the
// analysis page counts them, so those filters, the sport and the odds range
// apply to the ROI numbers too (its outlier line: /api/best_bets/results). NFL / NHL
// scorers open the player's stats window (player-stats-modal.js) and show his
// team and how often he has scored (last 10 / last season / career, from the
// Multi Builder's game_player_logs) against the chance the bookie odds imply.
// The game links to that game's Multi Builder. The Stake column comes from
// the settled selections in /api/best_bets/analysis like each bet (its market,
// edge up to its own, odds near its own: safe-stake.js), at the Risk level
// chosen and the bank entered. Each bet shows its opening, best and current
// odds. The Live view (/api/best_bets/live) is every tracked bet whose game
// has started, until it settles: the score, where the bet stands, its chance
// from here and the expected return, with a projected ROI over them all. Live
// bets are judged by default at their average price while they showed value
// (at the price basis chosen: the best bookie's by default), and pass the
// same filters as the upcoming ones. The Filters modal's "Most profitable"
// sets each market from the settled bets (best-bets-optimise.js).
import { BACKEND, apiUrl } from './api-config.js';
import { supabase, getSession } from './supabase-client.js';
import { involvesMyTeam, hasAnyTeams, loadMyTeams, MY_TEAMS_CHANGED } from './my-teams.js';
import { openPlayerStats, STATS_SPORTS } from './player-stats-modal.js';
import { SPORT_LABELS, SPORT_COLORS, esc, odds, pct, signedPct, signCls, wonCount,
         selectionText, bestBookHtml, edgeBands, loadStakePrefs, saveStakePrefs, money,
         PROP_KINDS, isProp, outlierHtml, pickOutlierHtml } from './best-bets-shared.js';
import { installTapTips } from './tap-tips.js';
import { decodeRows, toBet, stakeModel, stakeFor, liveBet, kellyStake, RISK_LEVELS } from './safe-stake.js';
import { dropEmptyMarkets, onePerMarket, RULE_MIN_BETS, RULE_MIN_GAMES } from './roi-stats.js';
import { marketOf, passesMarket, passesBet, priceAt, oddsRangeOf, oddsTyped, oddsText, prefsSummary, spanRange,
         edgeRangeOf, inRange, BASES, LIVE_STAGES, LIVE_STAGE_LABELS, LIVE_SORTS, LIVE_FINALS,
         closeAt, lineMoved, hasRealClose } from './best-bets-filters.js';
import { listedInfo, pointPasses, hasHistory, spanText, lineSeriesOf, linePointsFor } from './best-bets-history.js';
import { localPrefs, syncPrefs, savePrefs as storePrefs, openFilters, filterKeys, filtersDataReady, autoOptimise } from './best-bets-prefs.js';
import { optimiseMarkets, judgeEdgeOf } from './best-bets-optimise.js';
import { logit, sigmoid, edgeAt as edgeAtOdds } from './calibrate.js';
import { loadCalibration, calibrateBet, calEdgeAtPoint, closeBet, closeEdgeAtPoint, commissionOf } from './calibrate-client.js';

const TABS = [
  { key: 'all',     label: 'All',          kinds: ['match_odds', 'handicap', 'anytime_scorer', 'multi_scorer', 'total', ...PROP_KINDS] },
  { key: 'match',   label: 'Match Lines',  kinds: ['match_odds', 'handicap'] },
  { key: 'scorers', label: 'Scorers',      kinds: ['anytime_scorer', 'multi_scorer'] },
  { key: 'props',   label: 'Player Props', kinds: PROP_KINDS },
  { key: 'totals',  label: 'Totals',       kinds: ['total'] },
];
// Track-record bands (edge when first flagged) are widened until each holds
// this many settled bets: see edgeBands in best-bets-shared.js.
const MIN_BAND_BETS = 10;

const $ = id => document.getElementById(id);

let bets = [];             // /api/best_bets rows
let dropped = [];          // /api/best_bets dropped: tracked bets listed at an earlier check, not now
let checkedAt = null;      // when the odds were last fetched (/api/best_bets checked_at)
let calib = null;          // calibrate-client.js: the model-vs-market fit per market (null until in, false if it couldn't be)
let shown = [];            // the rows in the table, in order (data-row indexes it)
let results = null;        // /api/best_bets/results, loaded on first open
let tab = 'all';
let sport = 'all';
let day = 'all';           // a local kickoff date 'YYYY-MM-DD' (upcoming view only)
let settled = null;        // settled selections as bets, for the stakes (null until loaded)
let stakesFailed = false;
let model = null;          // stakeModel over them at the current settings
let view = 'upcoming';     // 'upcoming' | 'live'
const stakePrefs = loadStakePrefs();

// The filter settings (best-bets-filters.js): which markets, the edge each
// needs, the odds range, the price bets are judged at (the best bookie's or
// the average), sort, My Teams and the Live odds. Kept in this browser and the
// account's profile (best-bets-prefs.js), so they follow the account.
let prefs = localPrefs();
const bookBasis = () => prefs.basis === 'book';

function applyPrefs() {
  $('sort-by').value = prefs.sort;
  $('my-teams-only').checked = prefs.myTeams;
  $('odds-basis').value = prefs.liveStage;
  $('live-sort').value = prefs.liveSort;
  $('live-final').value = prefs.liveFinal;
  $('odds-min').value = prefs.odds[0];
  $('odds-max').value = prefs.odds[1];
}
// The bar's controls into the settings, then saved
function savePrefs() {
  prefs = { ...prefs, sort: $('sort-by').value === 'time' ? 'time' : 'edge', myTeams: $('my-teams-only').checked,
            liveStage: LIVE_STAGES.includes($('odds-basis').value) ? $('odds-basis').value : 'avg',
            liveSort: LIVE_SORTS.includes($('live-sort').value) ? $('live-sort').value : 'edge',
            liveFinal: LIVE_FINALS.includes($('live-final').value) ? $('live-final').value : 'any',
            odds: [$('odds-min').value.trim(), $('odds-max').value.trim()] };
  storePrefs(prefs);
}

// Sport / My Teams: shared by the table and the track record.
function passes(r) {
  return (sport === 'all' || r.sport === sport)
    && (!$('my-teams-only').checked || !hasAnyTeams() || involvesMyTeam(r.sport, r.home_team, r.away_team));
}
// Its market switched on, the edge that market needs and the odds range, both
// at the median: the same bets pass whichever price they are taken at. An
// outlier price (upcoming: its market's threshold met now; live: it was one
// before kickoff, and its market's outliers are still on - outlier_on) needs
// no edge, unless Filters has outliers off.
const isOutlierBet = r => !!(r.outlier ? r.outlier.is_outlier : (r.outlier_on ?? r.outlier_at));
// Filters can judge by the calibrated edge (r.cal, calibrate-client.js) or the
// predicted-close edge (r.close, close-model.js): once the calibration (and
// its close model) is in. Until then, by the model's edge and its ranges. Both
// are at the price the bet is taken at (the best bookie's, with Price on best
// bookie), not the median.
const fprefs = () => ((prefs.judge === 'cal' && !calib) || (prefs.judge === 'close' && !calib?.close)
  ? { ...prefs, judge: 'model' } : prefs);
const judgeBy = () => fprefs().judge;
const judging = () => judgeBy() === 'cal';
const judgedEdge = r => (judgeBy() === 'cal' ? (r.cal ? r.cal.bookEdge : null)
  : judgeBy() === 'close' ? (r.close ? r.close.edge : null) : (r.avgEdge ?? r.edge));
const passesFilters = r => passesBet(fprefs(), marketOf(r), judgedEdge(r), r.avgBack ?? r.median ?? r.back, isOutlierBet(r));
// A price-history point judged as the filters judge (best-bets-history.js)
const pointEdge = r => (judgeBy() === 'cal' ? (pt => calEdgeAtPoint(calib, r, pt, bookBasis()))
  : judgeBy() === 'close' ? (pt => closeEdgeAtPoint(calib, r, pt, bookBasis())) : null);
const listingOf = (r, end) => listedInfo(r.history, pt => pointPasses(fprefs(), marketOf(r), pt, pointEdge(r)), end);

const byTime = (a, b) => new Date(a.kickoff) - new Date(b.kickoff);

// The kickoff's date in the viewer's time zone, 'YYYY-MM-DD'
function dayOf(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const passesDay = r => day === 'all' || dayOf(r.kickoff) === day;

// --- access states ----------------------------------------------------------

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

const showRestricted = () => gateCard('Restricted', "This page is restricted. Your account doesn't have access to Best Bets.");

// The session is read on every call, never kept: access tokens last an hour
// and the Live poll outlives that. getSession hands back a refreshed one once
// it has expired. A 401 refreshes and retries once before the sign-in card,
// since the backend also answers 401 when Supabase's token check blips.
async function api(path) {
  const call = session => fetch(`${BACKEND}/${path}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
  let session = await getSession();
  if (!session) { showSignIn(); return null; }
  let res = await call(session);
  if (res.status === 401) {
    const { data } = await supabase.auth.refreshSession();
    session = data?.session;
    if (session) res = await call(session);
  }
  if (res.status === 401 || !session) { showSignIn(); return null; }
  if (res.status === 403) { showRestricted(); return null; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- shared rendering -------------------------------------------------------

function sportTag(s) {
  return `<span class="text-[10px] font-bold tracking-wide" style="color:${SPORT_COLORS[s] || '#8892a4'}">${SPORT_LABELS[s] || esc(s)}</span>`;
}

function kickoffText(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// The game's Multi Builder. NFL needs the week as well as the game.
function builderUrl(r) {
  const page = 'pages/tryscorer_predictions.html';
  if (r.sport === 'nfl') return `/nfl/${page}?${r.week != null ? `week=${r.week}&` : ''}game_id=${r.game_id}`;
  if (r.sport === 'nhl') return `/nhl/${page}?game_id=${r.game_id}`;
  return `/nrl/${page}?match_id=${r.game_id}${r.sport === 'nrlw' ? '&comp=nrlw' : ''}`;
}

// Wide screens: a column of its own. Phones: a line under the selection
// (gameLine), to leave the width for the prices.
function gameCell(r) {
  return `<td class="hidden sm:table-cell px-2 py-2">
    <a href="${builderUrl(r)}" title="Open this game in the Multi Builder"
       class="block font-semibold text-gray-100 hover:underline decoration-gray-500 underline-offset-2">${esc(r.home_team)} <span class="text-gray-500 font-normal">v</span> ${esc(r.away_team)}</a>
    <div class="text-[11px] text-gray-500">${sportTag(r.sport)} · ${esc(kickoffText(r.kickoff))}</div>
  </td>`;
}

function gameLine(r, when) {
  return `<div class="sm:hidden text-[11px] text-gray-500 leading-snug">${sportTag(r.sport)} ·
    <a href="${builderUrl(r)}" class="text-gray-400 hover:underline">${esc(r.home_team)} v ${esc(r.away_team)}</a> · ${when}</div>`;
}

// --- price history ------------------------------------------------------------
// /api/best_bets rows carry history: [unix s, median, best bookie's price] at
// every check so far, runs of one price cut to their ends.

// [unix s, price] at the price on show (the best bookie's, else the median)
const seriesOf = r => (r.history || []).map(([t, med, book]) => [t, r.atBook ? (book ?? med) : med]);

// The latest move: the price now against the last different one, and when it moved
function lastMove(series) {
  const now = series.at(-1)?.[1];
  for (let i = series.length - 2; i >= 0; i--) {
    if (series[i][1] !== now) return { from: series[i][1], to: now, at: series[i + 1][0], up: now > series[i][1] };
  }
  return null;
}

function agoText(unix) {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unix) / 60));
  return mins < 60 ? `${mins} min ago` : mins < 2880 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
}

// Lengthened (a better price than before) up and green, shortened down and red
function moveArrow(mv) {
  if (!mv) return '';
  return mv.up ? '<span class="text-green-400 text-[10px] ml-0.5" aria-label="lengthened">▲</span>'
    : '<span class="text-red-400 text-[10px] ml-0.5" aria-label="shortened">▼</span>';
}

// A value over time as a step line (it holds until the next check), with the
// latest marked: the price, or a main line's line (lineSeriesOf). mark: a
// dashed guide at that value (the bet's own line); tone: the latest's colour,
// 'for' / 'against' the bet (default amber, the price now).
const SPARK_TONES = { for: '#4ade80', against: '#f87171' };
function sparkline(series, { mark = null, tone = null } = {}) {
  if (series.length < 2) return '';
  const W = 64, H = 16, P = 2;
  const t0 = series[0][0], t1 = series.at(-1)[0];
  const vals = series.map(p => p[1]);
  const lo = Math.min(...vals, mark ?? Infinity), hi = Math.max(...vals, mark ?? -Infinity);
  const x = t => (t1 === t0 ? W - P : P + (t - t0) / (t1 - t0) * (W - 2 * P)).toFixed(1);
  const y = v => (hi === lo ? H / 2 : H - P - (v - lo) / (hi - lo) * (H - 2 * P)).toFixed(1);
  let d = `M${x(t0)},${y(vals[0])}`;
  for (let i = 1; i < series.length; i++) d += `H${x(series[i][0])}V${y(vals[i])}`;
  const guide = mark == null ? '' : `<line x1="${P}" x2="${W - P}" y1="${y(mark)}" y2="${y(mark)}" stroke="currentColor" stroke-width="0.75" stroke-dasharray="2 2" opacity="0.6"/>`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="inline-block text-gray-500" aria-hidden="true">
    ${guide}<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
    <circle cx="${x(t1)}" cy="${y(vals.at(-1))}" r="2" fill="${SPARK_TONES[tone] || '#fbbf24'}"/></svg>`;
}

// --- line moves ----------------------------------------------------------------
// Main lines (spreads, totals, NFL yards) move the line, not the price: their
// price history is one line's and sits near 1.90, so where the line went
// (line_history) is what shows how the market moved.

// A line as the market quotes it: a handicap signed, a total or yards plain
const lineText = (r, x) => (r.market_kind === 'handicap' && x > 0 ? `+${x}` : `${x}`);
// "+1 pt", "−2.5 yds": how far a line moved a bet's way
function ptsText(r, pts) {
  const a = Math.abs(pts), unit = isProp(r) ? 'yd' : 'pt';
  return `${pts > 0 ? '+' : pts < 0 ? '−' : ''}${a} ${unit}${a === 1 ? '' : 's'}`;
}

// A row's line history for the sparkline: { series, from, now, pts (how far
// from the row's own line the market is now, its way) }, or null when its
// line hasn't moved
function lineInfo(r) {
  const series = lineSeriesOf(r);
  if (!series) return null;
  const now = series.at(-1)[1];
  return { series, from: series[0][1], now, pts: linePointsFor(r.side, r.line, now) };
}

// The sparkline: the line where it has moved (a guide at the row's own line,
// the latest coloured by whether the market went its way), else the price.
// Up is a better offer for this side either way, as a longer price is: an
// over's line falling, an under's or a handicap's (the side's own) rising.
function historySpark(r, series, { tone = true } = {}) {
  const li = lineInfo(r);
  if (!li) return sparkline(series);
  const t = !tone || li.pts === 0 ? null : li.pts > 0 ? 'for' : 'against';
  const sgn = r.side === 'over' ? -1 : 1;
  const offer = li.series.map(([at, x]) => [at, sgn * x]);
  return `<span class="inline-flex items-center gap-1"><span class="text-[10px] text-gray-500">line</span>${sparkline(offer, { mark: sgn * r.line, tone: t })}</span>`;
}

// The tooltip's lines about the line, where it has moved
function lineTitle(r) {
  const li = lineInfo(r);
  if (!li) return [];
  // Gone at its own line: the selection itself was taken down, not moved
  const when = r.gone_at && li.now === r.line ? 'when last priced' : 'now';
  const out = [`Line: ${lineText(r, li.from)} when first priced, ${lineText(r, li.now)} ${when}. Bookies move these lines rather than the price, so the price above is this line's only.`];
  if (li.now !== r.line) out.push(`This bet is at ${lineText(r, r.line)}: the market has moved ${ptsText(r, li.pts)} its way since.`);
  return out;
}

function historyTitle(r, series, mv) {
  const lines = [`${r.atBook ? 'Best bookie price' : 'Median price'}: ${odds(r.back)} now`];
  if (mv) lines.push(`${mv.up ? 'Lengthened' : 'Shortened'} from ${odds(mv.from)} ${agoText(mv.at)}`);
  else if (series.length) lines.push(`Unchanged since ${kickoffText(new Date(series[0][0] * 1000))}`);
  if (series.length > 1) {
    const vals = series.map(p => p[1]);
    lines.push(`Since ${kickoffText(new Date(series[0][0] * 1000))}: low ${odds(Math.min(...vals))}, high ${odds(Math.max(...vals))}`);
  }
  lines.push(`Open ${odds(r.open)}: the first price recorded. Best ${odds(r.best)}: the highest since it first showed value.`);
  return [...lines, ...lineTitle(r)].join('\n');
}

// Scorers with a stats window (the multi builders' player_detail endpoints).
const hasStats = r => r.player_id != null && STATS_SPORTS.includes(r.sport);

// --- scorer history -----------------------------------------------------------
// One /api/<sport>/game_player_logs per game on show, fetched as its rows
// first appear: {players: {id: {stat: {l10|prev|car: [[value, games], ...]}}},
// sides: {id: 'home'|'away'}, prev_season}.
const LOG_STAT = { nfl: 'td', nhl: 'goal' };
// Over / under player markets: the log stat each is settled on
const PROP_LOG_STAT = { pass_yds: 'pass_yds', pass_tds: 'pass_td', rec_yds: 'rec_yds', rush_yds: 'rush_yds',
                        assists: 'assist', points: 'point' };
const HIT_BAND = 3;        // points either side of the bookie's chance shown neutral
const logs = new Map();    // 'sport:game_id' -> response (undefined = loading, null = failed)
const logsKey = r => `${r.sport}:${r.game_id}`;
let logsPaint = 0;

// A few games at a time: each request holds a database connection on the
// backend, and a slate can be 20 games.
const LOGS_PARALLEL = 3;
const logsQueue = [];
let logsActive = 0;

async function fetchLogs(sport, gameId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(apiUrl(sport, `game_player_logs/${gameId}`));
      if (res.ok) return await res.json();
    } catch { /* try once more */ }
  }
  return null;
}

function pumpLogs() {
  while (logsActive < LOGS_PARALLEL && logsQueue.length) {
    const { key, sport, gameId } = logsQueue.shift();
    logsActive++;
    fetchLogs(sport, gameId).then(data => {
      logsActive--;
      logs.set(key, data);
      clearTimeout(logsPaint);          // several land together: one repaint
      logsPaint = setTimeout(renderView, 60);
      pumpLogs();
    });
  }
}

function loadLogs(rows) {
  for (const r of rows) {
    const key = logsKey(r);
    if (!hasStats(r) || logs.has(key)) continue;
    logs.set(key, undefined);
    logsQueue.push({ key, sport: r.sport, gameId: r.game_id });
  }
  pumpLogs();
}

// The player's team, once the game's logs are in.
function teamOf(r) {
  const side = logs.get(logsKey(r))?.sides?.[r.player_id];
  return side === 'home' ? r.home_team : side === 'away' ? r.away_team : null;
}

const histGames = h => h.reduce((s, [, n]) => s + n, 0);
const histHit = (h, line) => h.reduce((s, [v, n]) => s + (v >= line ? n : 0), 0) / histGames(h);
// Share of games the selection would have won: N+ for scorers, over / under the line for props
const hitRate = (h, r) => !isProp(r) ? histHit(h, r.line || 1)
  : h.reduce((s, [v, n]) => s + ((r.side === 'under' ? v < r.line : v > r.line) ? n : 0), 0) / histGames(h);

// How often he has hit this selection over his last 10 games, last season and
// his career: green above the chance the bookie odds imply, red below.
function historyHtml(r) {
  if (!hasStats(r)) return '';
  const data = logs.get(logsKey(r));
  if (data === undefined) return '<span class="bsm-skeleton h-3 w-40 block mt-1"></span>';
  const hist = data?.players?.[r.player_id]?.[isProp(r) ? PROP_LOG_STAT[r.market_kind] : LOG_STAT[r.sport]];
  if (!hist) return '';
  const implied = Math.round(100 / r.back);
  const prev = r.sport === 'nhl' ? `${String(data.prev_season).slice(2)}-${String(data.prev_season + 1).slice(2)}` : String(data.prev_season);
  const wins = [
    ['l10', g => `L${Math.min(g, 10)}`, 'Last games played (up to 10)'],
    ['prev', () => prev, `${prev} season, playoffs included`],
    ['car', () => 'Career', 'Every game of his career, playoffs included'],
  ];
  return `<div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400 leading-none">${wins.map(([w, label, tip]) => {
    const h = hist[w] || [], g = histGames(h);
    const hit = g ? Math.round(hitRate(h, r) * 100) : null;
    const cls = hit == null || Math.abs(hit - implied) <= HIT_BAND ? 'text-gray-200' : hit > implied ? 'text-green-400' : 'text-red-400';
    const title = `${tip}: ${g} game${g === 1 ? '' : 's'} · bookie odds imply ${implied}%`;
    return `<span class="whitespace-nowrap" title="${esc(title)}">${label(g)} ${g ? `<span class="${cls} font-semibold">${hit}%</span>` : '–'}</span>`;
  }).join('')}</div>`;
}

// fresh: listed since the last time the page looked (a "New" chip)
function selectionCell(r, { fresh = false } = {}) {
  const name = esc(selectionText(r));
  const team = hasStats(r) ? teamOf(r) : null;
  return `<td class="px-2 py-2">
    <div class="font-semibold text-gray-100">${hasStats(r)
      ? `<button type="button" class="text-left font-semibold group-hover:underline decoration-gray-500 decoration-dotted underline-offset-2" title="Show player stats">${name}</button>`
      : name}${team ? ` <span class="ml-1 text-xs font-medium text-gray-400 whitespace-nowrap">${esc(team)}</span>` : ''}${fresh
      ? ' <span class="ml-1 rounded bg-green-500/15 border border-green-500/40 px-1 text-[10px] font-semibold text-green-300 align-middle" title="Listed in the last half hour">New</span>' : ''}</div>
    <div class="text-[11px] text-gray-500">${esc(r.market_name)}</div>
    ${gameLine(r, esc(kickoffText(r.kickoff)))}
    ${bestBookHtml(r, r.atBook ? r.median : null)}
    ${r.outlier ? `<div class="mt-0.5">${outlierHtml(r)}</div>` : ''}
    ${historyHtml(r)}
  </td>`;
}

function renderTabs() {
  $('view-tabs').innerHTML = TABS.map(t => `
    <button type="button" data-tab="${t.key}" role="tab" aria-selected="${t.key === tab}"
            class="px-4 py-1.5 rounded-md text-sm transition-all ${t.key === tab
              ? 'bg-amber-400 text-gray-900 font-bold' : 'text-gray-400 font-semibold hover:text-gray-200'}">${t.label}</button>`).join('');
}

// The rows behind the view on show
const viewRows = () => view === 'live' ? (liveData?.rows || []) : bets;

function renderSportPills() {
  const source = viewRows();
  const present = Object.keys(SPORT_LABELS).filter(s => source.some(r => r.sport === s));
  if (sport !== 'all' && !present.includes(sport)) sport = 'all';
  $('sport-pills').innerHTML = (present.length > 1 ? ['all', ...present] : []).map(s => `
    <button type="button" data-sport="${s}"
            class="px-2.5 py-1 rounded-full border text-xs font-semibold transition-colors ${s === sport
              ? 'border-amber-400 text-amber-400' : 'border-gray-700 text-gray-400 hover:text-gray-200'}">${s === 'all' ? 'All' : SPORT_LABELS[s]}</button>`).join('');
}

// Today, Tomorrow, the weekday within the week ahead, else the date
function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ahead = Math.round((date - today) / 86400000);
  if (ahead === 0) return 'Today';
  if (ahead === 1) return 'Tomorrow';
  if (ahead > 1 && ahead < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// The days the upcoming bets start on. Upcoming only: live games have started.
function renderDayFilter() {
  const isLive = view === 'live';
  const days = [...new Set(bets.map(r => dayOf(r.kickoff)).filter(Boolean))].sort();
  if (day !== 'all' && !days.includes(day)) day = 'all';
  $('day-wrap').classList.toggle('hidden', isLive || days.length < 2);
  $('day-filter').innerHTML = ['all', ...days].map(k =>
    `<option value="${k}"${k === day ? ' selected' : ''}>${k === 'all' ? 'Any' : esc(dayLabel(k))}</option>`).join('');
}

// --- stakes -----------------------------------------------------------------
// Settled selections as the analysis page counts them by default: at the
// average price while they showed value (the 'avg' stage - only selections
// that did), every source, one bet per market.
const STAKE_STAGE = 'avg';

const VERDICT_TEXT = { thin: 'too few to call', open: 'unproven', ahead: 'proven profit', behind: 'proven loss' };

let settledRows = null;    // decoded /api/best_bets/analysis rows
let settledBasis = null;   // the price basis `settled` was read at
let modelKey = null;       // what `model` was built from

// The stake model, rebuilt only when what it reads changes (the basis, the
// risk level, the detail): it bootstraps every market's grid
function buildModel() {
  if (settledRows && settledBasis !== prefs.basis) {
    // A selection that never showed value has no avg price: left out (as the
    // analysis page's avg stage leaves it), not counted at an edge of zero
    settled = onePerMarket(dropEmptyMarkets(settledRows.filter(r => r[`${STAKE_STAGE}_back`] != null)
      .map(r => toBet(r, STAKE_STAGE, prefs.basis))).kept);
    settledBasis = prefs.basis;
  }
  const key = settled && [prefs.basis, stakePrefs.risk, stakePrefs.detail].join('|');
  if (key && key === modelKey) return;
  modelKey = key;
  model = settled && stakeModel(settled, stakePrefs.risk, stakePrefs.detail);
}

let settledVersion = null;  // /api/best_bets/analysis version (what the calibration is cached by)

async function loadStakes() {
  try {
    const data = await api('best_bets/analysis');
    if (!data) return;
    settledRows = decodeRows(data).filter(r => String(r.market_id).startsWith('oddsapi:'));   // no Betfair
    settledVersion = data.version ?? null;
    settledBasis = modelKey = null;
    keepOptimised();
    buildModel();
    filtersDataReady();
    startCalibration();
  } catch {
    stakesFailed = true;
  }
  renderView();
  renderTrackRecord();
}

// The calibration (calibrate-client.js): from this browser's cache, else
// fitted in a Worker; the page redraws when it lands
function startCalibration() {
  if (!settledRows) return;
  const basisNow = prefs.basis;
  loadCalibration(settledRows, { version: settledVersion, basis: basisNow, prefs }).then(c => {
    if (basisNow !== prefs.basis) return;
    calib = c || false;
    keepOptimised();   // judging by the calibrated edge, it waited for this
    filtersDataReady();
    render();
  });
}

// Kept on "Most profitable" (prefs.autoOpt): the filters re-fitted to the
// settled bets and calibration in now -> whether that changed them
function keepOptimised() {
  const next = autoOptimise(prefs, optimise);
  if (!next) return false;
  prefs = next;
  return true;
}

function stakeTitle(s) {
  const risk = model.risk;
  const binText = t => {
    const st = t.stats;
    return `${t.label}: ${st.n ? `${signedPct(st.roi)} on ${st.n} bet${st.n === 1 ? '' : 's'} over ${st.games} game${st.games === 1 ? '' : 's'}` : 'no settled bets'}`
      + `, ${VERDICT_TEXT[st.verdict]}${st.low != null ? ` (low end ${signedPct(st.low)})` : ''}${st.thin && st.n ? ', on few bets' : ''}`;
  };
  const lines = [
    s.reason === 'outlier' ? `No stake: outlier. ${s.outlier.label}: past here a bigger model edge has meant model error, not value.`
    : s.reason === 'behind' ? 'No stake: bets like this have proven a loss.'
    : s.reason ? 'No stake yet: bets like this have not proven a profit.'
    : `Stake ${pct(s.frac, 2)} of the bank${s.dollars != null ? ` (${money(s.dollars)})` : ''}`,
  ];
  if (s.thin) lines.push(`⚠ Not proven yet: this rests on ${s.used.stats.n} bet${s.used.stats.n === 1 ? '' : 's'} over ${s.used.stats.games} game${s.used.stats.games === 1 ? '' : 's'}. `
    + `A pool is called proven at ${RULE_MIN_BETS} bets over ${RULE_MIN_GAMES} games; with fewer, its range runs narrower than it should, so the stake is less sure than it looks.`);
  if (s.warning) lines.push("⚠ This market's own bets have lost so far (not proven either way): the stake comes from all markets.");
  if (s.path.length) lines.push('', 'Bets like this (edge no higher, odds from half to the next step up), its own market first:',
    ...s.path.map(t => `${t === s.used ? '→' : '·'} ${binText(t)}`));
  if (s.kelly) lines.push('', `${s.kelly.k.toFixed(2)} × Kelly on a ${signedPct(s.kelly.edge)} edge (full Kelly ${pct(s.kelly.kelly)})`,
    `About ${s.kelly.betsToSure.toLocaleString()} bets at this edge to be 99% sure of a profit`);
  lines.push('', `${risk.label} risk: ${risk.text}.`);
  return lines.join('\n');
}

// Judging by the calibrated (or predicted-close) edge: fractional Kelly (the
// Risk level's) on its 90% low end at the price taken - the calibration has
// the doubt about the model in it already, and the low end the doubt about
// the calibration (for the close: the close going least our way)
function calStakeCell(r, td) {
  const risk = RISK_LEVELS[stakePrefs.risk] || RISK_LEVELS.medium;
  const close = judgeBy() === 'close';
  const lo = close ? r.close?.edgeLo : r.cal?.bookEdgeLo, name = close ? 'predicted-close edge' : 'calibrated edge';
  const s = lo != null && kellyStake(lo, r.back, commissionOf(r), risk);
  if (!s) return td('<span class="text-gray-500">–</span>', lo != null
    ? `No stake: the ${name}'s 90% low end at the price taken is ${signedPct(lo)}`
    : close ? 'No predicted close for this bet' : 'No calibration for this bet');
  const share = pct(s.frac, s.frac < 0.01 ? 2 : 1);
  const title = [`Stake ${pct(s.frac, 2)} of the bank`, '',
    `${s.k.toFixed(2)} × Kelly on the ${name}'s 90% low end at the price taken, ${signedPct(s.edge)} (full Kelly ${pct(s.kelly)})`,
    `About ${s.betsToSure.toLocaleString()} bets at this edge to be 99% sure of a profit`, '', `${risk.label} risk: ${risk.text}.`].join('\n');
  return td(stakePrefs.balance
    ? `<div class="font-bold text-gray-100">${money(s.frac * stakePrefs.balance)}</div><div class="text-[11px] text-gray-500">${share}</div>`
    : `<span class="font-bold text-gray-100">${share}</span>`, title);
}

function stakeCell(r) {
  const td = (inner, title = '') => `<td class="px-2 py-2 text-right tabular-nums whitespace-nowrap"${title ? ` title="${esc(title)}"` : ''}>${inner}</td>`;
  if (judgeBy() !== 'model') return calStakeCell(r, td);
  if (!model) return td(stakesFailed ? '<span class="text-gray-600">–</span>' : '<span class="bsm-skeleton h-3 w-10 inline-block"></span>',
    stakesFailed ? 'Could not load the settled bets the stake is worked out from' : '');
  const s = stakeFor(liveBet(r), model, stakePrefs.balance);
  const title = stakeTitle(s);
  if (s.reason === 'outlier') return td('<span class="text-[11px] font-semibold text-red-400">Outlier</span>', title);
  if (s.reason === 'behind') return td('<span class="text-[11px] text-red-400/80">Losing</span>', title);
  if (s.reason) return td('<span class="text-gray-500">–</span>', title);
  const share = pct(s.frac, s.frac < 0.01 ? 2 : 1);
  const warn = s.warning || s.thin ? `<span class="text-amber-400 mr-1" aria-label="${s.thin ? 'not proven yet' : 'warning'}">⚠</span>` : '';
  return td(s.dollars != null
    ? `<div class="font-bold text-gray-100">${warn}${money(s.dollars)}</div><div class="text-[11px] text-gray-500">${share}</div>`
    : `<span class="font-bold text-gray-100">${warn}${share}</span>`, title);
}

// --- current bets -----------------------------------------------------------

// An upcoming bet at the price chosen: back now, and its open / best odds.
// At the best bookie's price where the bookies name one; Betfair rows (and
// checks from before the best price was kept) at their own. edge stays the
// median's (the value signal the filters read); bookEdge is at the price taken.
// cal: its calibrated chance and edges (calibrate-client.js), once in; close:
// its predicted close and the edge against it (close-model.js), once in.
function upcomingAt(r) {
  const book = bookBasis() && r.best_book_back != null && r.best_book_edge != null;
  const out = book
    ? { ...r, back: r.best_book_back, bestEdge: r.best_book_edge, open: r.open_book_odds ?? r.open_odds,
        best: r.best_book_odds ?? r.best_odds, median: r.back, atBook: true }
    : { ...r, bestEdge: r.best_book_edge ?? r.edge, open: r.open_odds, best: r.best_odds, median: r.back };
  out.cal = calibrateBet(calib, out, { median: out.median, taken: out.back });
  out.close = closeBet(calib, out, { median: out.median, taken: out.back });
  return out;
}

// The predicted-close edge's line under a bet's edges, and what it is made of
function closeLine(r) {
  const c = r.close;
  if (!c) return '';
  const title = [`Predicted-close edge at the price taken (${odds(r.back)}): ${signedPct(c.edge)} (90% low end ${signedPct(c.edgeLo)})`,
    `Median ${odds(r.median ?? r.back)} now, predicted ${odds(c.closeBack)} at kickoff: `
    + `${c.move > 0.005 ? 'shortening' : c.move < -0.005 ? 'drifting' : 'about where it is'}, from how prices in this market have moved with the model's view this far out.`,
    `Fair chance at that close, the bookies' margin out: ${pct(c.fair)}.`].join('\n');
  return `<div class="text-[11px] leading-snug" title="${esc(title)}"><span class="text-gray-500">close</span> <span class="font-semibold ${signCls(c.edge)}">${signedPct(c.edge)}</span></div>`;
}

// The calibrated edge's line under a bet's edges, and what it is made of
function calLine(r) {
  if (!r.cal) return '';
  const c = r.cal, w = c.w;
  const title = [`Calibrated edge at the price taken (${odds(r.back)}): ${signedPct(c.bookEdge)} (90% range ${signedPct(c.bookEdgeLo)} to ${signedPct(edgeAtOdds(c.hi, r.back, commissionOf(r)))})`,
    `At the median price: ${signedPct(c.edge)}`,
    `Chance ${pct(c.p)} (90%: ${pct(c.lo)} to ${pct(c.hi)}): the model's ${pct(r.model_prob)} blended with the bookies' (margin out) `
    + `by how far this market's settled bets have trusted a disagreement this size: weight ${w.toFixed(2)} (0: the bookies' chance; 1: the model's).`].join('\n');
  return `<div class="text-[11px] leading-snug" title="${esc(title)}"><span class="text-gray-500">cal</span> <span class="font-semibold ${signCls(c.bookEdge)}">${signedPct(c.bookEdge)}</span></div>`;
}

// Prices, model and edges each stacked in one cell: the selection cell is
// three or four lines tall anyway, and a phone has room for few columns.
function betRow(r, i) {
  const series = seriesOf(r);
  const mv = lastMove(series);
  return `
    <tr class="group border-t border-gray-700/60 hover:bg-gray-700/20 align-top${hasStats(r) ? ' cursor-pointer' : ''}"${hasStats(r) ? ` data-row="${i}"` : ''}>
      ${gameCell(r)}${selectionCell(r, { fresh: isNew(r) })}
      <td class="px-2 py-2 text-right tabular-nums whitespace-nowrap" title="${esc(historyTitle(r, series, mv))}">
        <div class="font-bold text-amber-400">${odds(r.back)}${moveArrow(mv)}</div>
        <div class="text-[11px] text-gray-400 leading-snug">Open ${odds(r.open)}</div>
        <div class="text-[11px] text-gray-400 leading-snug">Best ${odds(r.best)}</div>
        ${historySpark(r, series, { tone: false })}
      </td>
      <td class="hidden sm:table-cell px-2 py-2 text-right tabular-nums whitespace-nowrap">
        <div class="text-gray-200">${pct(r.model_prob)}</div>
        <div class="text-[11px] text-gray-400 leading-snug">Fair ${odds(r.fair_odds)}</div>
      </td>
      <td class="px-2 py-2 text-right tabular-nums whitespace-nowrap">
        <div class="font-bold ${signCls(r.edge)}" title="At the average (median) price">${signedPct(r.edge)}</div>
        <div class="text-[11px] leading-snug" title="At the best bookie's price"><span class="text-gray-500">best</span> <span class="font-semibold ${signCls(r.bestEdge)}">${signedPct(r.bestEdge)}</span></div>
        ${calLine(r)}${closeLine(r)}
        <div class="sm:hidden text-[11px] text-gray-500 leading-snug">fair ${odds(r.fair_odds)}</div>
      </td>
      ${stakeCell(r)}
    </tr>`;
}

// A game's alternate lines and totals win and lose with its standard one, so
// at most one line is shown per game, market and side. With no odds range
// typed that is the bookies' standard line; with one, the standard line when
// its price fits, else the alternate nearest it that does.
// NHL totals come under two settlement rules (market_id ending ':reg' /
// ':ot'), each a market of its own with its own standard line.
const ruleOf = r => /:(reg|ot)$/.exec(r.market_id || '')?.[1] || '';
function oneLinePerSide(rows, oddsTyped) {
  if (!oddsTyped) return rows.filter(r => !r.alternate);
  const key = r => `${r.sport}:${r.game_id}|${r.market_kind}|${ruleOf(r)}|${r.side}`;
  const standard = new Set(rows.filter(r => !r.alternate).map(key));
  const nearest = new Map();
  for (const r of rows) {
    if (!r.alternate || standard.has(key(r))) continue;
    const dist = r.main_line == null ? Infinity : Math.abs(r.line - r.main_line);
    const best = nearest.get(key(r));
    if (!best || dist < best.dist || (dist === best.dist && r.edge > best.r.edge)) nearest.set(key(r), { r, dist });
  }
  const shownAlts = new Set([...nearest.values()].map(b => b.r));
  return rows.filter(r => !r.alternate || shownAlts.has(r));
}

// The list refreshes every couple of minutes; a game that has started since
// drops out at once
const notStarted = r => Date.parse(r.kickoff) > Date.now();

// The upcoming bets that pass the sport / day / My Teams / market filters, at
// the price chosen, one line per side (any tab)
const upcomingRows = () => oneLinePerSide(bets.map(upcomingAt).filter(r => notStarted(r) && passes(r) && passesDay(r)
                                          && passesFilters(r)), oddsTyped(prefs));

// --- new since last looked ------------------------------------------------------
// Every bet that passed the filters, with when it first did (this browser):
// a "New" chip for half an hour, and an alert (when switched on) for one
// that appears at a refresh. A bet that starts passing because the filters
// changed isn't new.
const SEEN_KEY = 'bsm_bb_seen';
const NEW_MS = 30 * 60_000;
const rowKey = r => `${r.market_id}|${r.selection_id}|${r.line ?? ''}`;
let seen = (() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; } })();

// Marks rows as seen -> the ones not seen before (none when silent, or the
// very first time this browser looks)
function noteSeen(rows, silent = false) {
  const now = Date.now();
  const first = !Object.keys(seen).length;
  const fresh = [];
  let changed = false;
  for (const r of rows) {
    const k = rowKey(r);
    if (seen[k]) continue;
    seen[k] = [silent || first ? 0 : now, Date.parse(r.kickoff) || 0];
    changed = true;
    if (!silent && !first) fresh.push(r);
  }
  for (const [k, [, ko]] of Object.entries(seen)) if (ko < now) { delete seen[k]; changed = true; }
  if (changed) try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* storage unavailable */ }
  return fresh;
}
const isNew = r => { const s = seen[rowKey(r)]; return !!(s && s[0] && Date.now() - s[0] < NEW_MS); };

function renderBets() {
  const kinds = TABS.find(t => t.key === tab).kinds;
  const byEdge = $('sort-by').value !== 'time';
  const inTab = bets.filter(r => kinds.includes(r.market_kind));
  const rows = upcomingRows().filter(r => kinds.includes(r.market_kind));
  const body = $('bets-body');
  let summary = '';
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="px-2 py-8 text-center text-sm text-gray-500">${
      inTab.length ? 'No bets match these filters.' : 'No value found in these markets at the last check.'}</td></tr>`;
  } else {
    // Outliers first (unless Filters has them off), then by the chosen order
    const outFirst = r => (prefs.outliers !== 'off' && isOutlierBet(r) ? 0 : 1);
    rows.sort((a, b) => outFirst(a) - outFirst(b)
      || (byEdge ? b.edge - a.edge : byTime(a, b) || b.edge - a.edge));
    loadLogs(rows);
    body.innerHTML = rows.map(betRow).join('');
    summary = `${rows.length} selection${rows.length === 1 ? '' : 's'}`
      + (rows.some(r => outFirst(r) === 0) ? ' · outliers first' : '');
  }
  shown = rows;
  $('status').textContent = summary && `${summary} · sorted by ${byEdge ? 'edge' : 'start time'}`;
  // Scorer prices and match / total prices come from different places
  // Rows that count bookmakers in the market name ("6 AU books") are bookmaker
  // prices; the rest are Betfair's
  const bookNote = 'Where the market names bookmakers ("6 AU books"), bookie odds are '
    + (bookBasis() ? 'the best price any one of them offers, named under the selection with the median across them '
      : 'the median price across them, with the best price found and who had it underneath ')
    + '(Filters → Price chooses which the edges, stakes and track record use). They are refreshed up to every 15 minutes close '
    + 'to the start, but can still have moved: check the price before betting. Alternate lines and totals ("Alt Line") only show '
    + 'with an odds range set, one per game and side: the standard line wins and loses with them. '
    + 'Scorer and player prop prices assume the player takes the field (bookmakers void the bet if he does not). '
    + 'A Gap chip marks one bookie well above the rest (against the median of the others; bookies on one price feed count once): '
    + "tap it for the prices and how bets at that gap have done. ⚡ Outlier: a gap at least its market's threshold, the most profitable "
    + "gap among the market's settled outlier bets once there are enough of them, and of winners, to judge (+25% until then; none "
    + 'where no gap has paid). Outliers are listed even without '
    + 'a model edge, in the markets switched on and the odds range; Filters → Outliers only lists nothing else.';
  const stakeNote = ' Stake: a share of the bank, sized off the low end of what settled bets like it have returned (same market, '
    + 'edge no higher, odds from half its own to the next step up), '
    + 'falling back to all markets where that market has not proven anything either way. None until that low end is a profit, and none past the edge or odds '
    + `where bets have turned to losing again (outliers). ⚠ marks a stake resting on fewer than ${RULE_MIN_BETS} bets over ${RULE_MIN_GAMES} games: not proven yet.`;
  const exchangeNote = 'Other bookie odds are the best back price on the Betfair Exchange at the last check (delayed, and '
    + 'they will have moved): use them as a guide to where the value is. Their edge allows for Betfair commission.';
  $('method-note').textContent = tab === 'scorers' || tab === 'props' ? bookNote : `${bookNote} ${exchangeNote}`;
  $('method-note').textContent += stakeNote + ' The list refreshes every 2 minutes while the page is open; New marks a bet listed '
    + 'in the last half hour. Below the list, No longer value: bets you could have seen listed under your filters earlier that '
    + "aren't now.";
  renderDropped();
}

// --- no longer value ----------------------------------------------------------
// Tracked bets of games not started that the list showed under the current
// filters at an earlier check and doesn't now: /api/best_bets rows that fail
// the filters now, and its dropped list (median edge gone, or no longer
// priced). Each check in a bet's history is judged as the list judged it.
function droppedRows() {
  const kinds = TABS.find(t => t.key === tab).kinds;
  const listedNow = new Set(upcomingRows().map(rowKey));
  const now = Date.now() / 1000;
  const out = [];
  for (const r of [...bets.filter(b => !b.alternate && !listedNow.has(rowKey(b))), ...dropped]) {
    if (!notStarted(r) || !kinds.includes(r.market_kind) || !passes(r) || !passesDay(r)) continue;
    const end = Math.min(now, r.gone_at ? Date.parse(r.gone_at) / 1000 : Infinity);
    const listing = listingOf(r, end);
    if (listing.ever) out.push({ ...upcomingAt(r), listing });
  }
  return out.sort(byTime);
}

// [chip, why]: what keeps it off the list now
function droppedReason(r) {
  const key = marketOf(r);
  if (r.gone_at && r.close_line != null && r.close_line !== r.line) {
    const lc = lineMoved(r) ? closeAt(r, prefs.basis).back : null;
    return ['Line moved', `The bookies moved the line to ${lineText(r, r.close_line)} (${ptsText(r, r.line_pts)} for this bet) `
      + `at ${kickoffText(r.gone_at)}` + (lc ? `. At this bet's ${lineText(r, r.line)} that is worth about ${odds(lc)} now `
      + `(${{ alt: "the bookies' alternate line", model: "the new line's price, moved back by the model's chances at the two lines", approx: "the new line's price, moved back by the model's chances at the two lines" }[r.lc_src]})` : '')];
  }
  if (r.gone_at) return ['Off the board', `Not in the latest check since ${kickoffText(r.gone_at)}: the bookies took it down or moved the line`];
  const edge = judgedEdge(r);
  if (!(edge > 0)) return ['No edge now', judgeBy() === 'cal' ? 'Its calibrated edge at the price taken is no longer positive'
    : judgeBy() === 'close' ? 'Its edge against the predicted close, at the price taken, is no longer positive'
    : 'Its edge at the median price is no longer positive'];
  if (!inRange(r.median ?? r.back, oddsRangeOf(prefs))) return ['Odds out of range', 'Its median price is outside your odds range'];
  if (!inRange(edge, edgeRangeOf(fprefs(), key))) return ['Edge out of range', 'Its edge is outside the range you set for this market'];
  return ['Off your filters', ''];
}

function droppedRow(r) {
  const was = r.listing.lastPoint;
  const wasPrice = bookBasis() ? (was[2] ?? was[1]) : was[1];
  const [chip, why] = droppedReason(r);
  const gone = !!r.gone_at;
  // A moved line: about what its own line is worth now, from the new line's price
  const lc = gone && lineMoved(r) ? closeAt(r, prefs.basis).back : null;
  const priceNow = lc ? `<span title="About what this bet's line is worth now: ${esc(why)}">≈${odds(lc)}</span>` : gone ? '–' : odds(r.back);
  const series = seriesOf(r);
  return `
    <tr class="group border-t border-gray-700/60 hover:bg-gray-700/20 align-top">
      ${gameCell(r)}${selectionCell(r)}
      <td class="px-2 py-2 text-right tabular-nums whitespace-nowrap" title="${esc(lineTitle(r).join('\n'))}">
        <div class="font-semibold ${gone && !lc ? 'text-gray-500' : 'text-gray-200'}">${priceNow}</div>
        <div class="text-[11px] text-gray-400 leading-snug">was ${odds(wasPrice)}</div>
        ${historySpark(r, series)}
      </td>
      <td class="px-2 py-2 text-right tabular-nums whitespace-nowrap">
        <div class="font-semibold ${gone ? 'text-gray-500' : signCls(r.edge)}">${gone ? '–' : signedPct(r.edge)}</div>
        <div class="text-[11px] text-gray-400 leading-snug">was <span class="${signCls(was[3])}">${signedPct(was[3])}</span></div>
      </td>
      <td class="px-2 py-2 text-right text-[11px] leading-snug whitespace-nowrap">
        <div class="text-gray-300">${spanText(r.listing.secs)}</div>
        <div class="text-gray-500">until ${agoText(r.listing.lastEnd)}</div>
        <span class="mt-0.5 inline-block rounded border border-gray-600 px-1 text-[10px] font-semibold text-gray-300" title="${esc(why)}">${esc(chip)}</span>
      </td>
    </tr>`;
}

function renderDropped() {
  const rows = droppedRows();
  $('dropped-wrap').classList.toggle('hidden', !rows.length);
  $('dropped-count').textContent = rows.length ? `${rows.length} bet${rows.length === 1 ? '' : 's'}` : '';
  $('dropped-body').innerHTML = rows.map(droppedRow).join('');
}

function openStats(r) {
  const g = r.game;   // live rows only
  openPlayerStats({
    sport: r.sport, gameId: r.game_id, playerId: r.player_id,
    name: r.selection_name,
    team: teamOf(r), teams: { home: r.home_team, away: r.away_team },
    subtitle: `${SPORT_LABELS[r.sport]} · ${r.home_team} v ${r.away_team} · ${g
      ? `${g.home != null ? `${g.home}–${g.away} ` : ''}${g.state === 'pre' ? kickoffText(r.kickoff) : g.label}` : kickoffText(r.kickoff)}`,
    tiles: g ? [
      { label: `Odds (${LIVE_STAGE_LABELS[basis()]})`, value: odds(r.back), cls: 'text-amber-400', sub: `Avg ${odds(r.prices.avg)} · Open ${odds(r.prices.open)} · Best ${odds(r.prices.best)} · Close ${odds(r.prices.close)}` },
      { label: 'Model at kickoff', value: pct(r.model_prob) },
      { label: 'Chance now', value: pct(r.live.p_win), sub: (LIVE_STATUS[r.live.status] || LIVE_STATUS.unknown)[0] },
      { label: 'Live EV', value: signedPct(r.ev), cls: signCls(r.ev) },
    ] : [
      { label: `Bookie odds (${bookBasis() ? 'best bookie' : 'average'})`, value: odds(r.back), cls: 'text-amber-400', sub: `Open ${odds(r.open)} · Best ${odds(r.best)}` },
      { label: 'Model', value: pct(r.model_prob) },
      { label: 'Fair odds', value: odds(r.fair_odds) },
      { label: 'Edge', value: signedPct(r.edge), cls: signCls(r.edge), sub: `average price · ${signedPct(r.bestEdge)} at the best` },
    ],
    note: `${selectionText(r)} — ${r.market_name}. `
      + (!g && r.best_book && r.best_book_back != null ? `Best price ${odds(r.best_book_back)} at ${r.best_book}; median ${odds(r.median)}. ` : '')
      + (g && bookBasis() && r.best_book ? `Best price before kickoff at ${r.best_book}. ` : '')
      + 'Price assumes the player takes the field.',
  });
}

// --- live -------------------------------------------------------------------
// /api/best_bets/live: every tracked bet whose game has started, until it
// settles, with the score and where the bet stands (best_bets_live.py on the
// backend: won / lost as soon as nothing can change it, else its chance from
// here on the pre-game model). Refreshed every 30 s while the Live view is up
// and the tab visible (the backend caches 20 s), otherwise every 2 minutes for
// the count on the Live tab.

const LIVE_MS = 30_000;
const LIVE_IDLE_MS = 120_000;
let liveData = null;       // /api/best_bets/live (null until loaded)
let liveFailed = false;
let liveLoadedAt = 0;
let liveTimer = 0;
let liveShown = [];        // the live rows on show, in order (data-row indexes it)

// The Odds at choice: which of a bet's prices its edge, EV and the filters
// use. 'avg' (the default): the time-weighted average while its median edge
// was positive, the price a bet taken at any moment it was listed got on average
const basis = () => LIVE_STAGES.includes($('odds-basis').value) ? $('odds-basis').value : 'avg';

// [badge, classes]; the settled-looking ones are final or locked
const LIVE_STATUS = {
  won:          ['Won ✓', 'bg-green-500/20 text-green-300 border-green-500/50'],
  lost:         ['Lost ✗', 'bg-red-500/20 text-red-300 border-red-500/50'],
  push:         ['Push', 'text-gray-300 border-gray-600'],
  half_won:     ['Half won', 'bg-green-500/10 text-green-300 border-green-500/40'],
  half_lost:    ['Half lost', 'bg-red-500/10 text-red-300 border-red-500/40'],
  winning:      ['Winning', 'text-green-400 border-green-500/40'],
  half_winning: ['Half winning', 'text-green-400 border-green-500/30'],
  losing:       ['Losing', 'text-red-400 border-red-500/40'],
  half_losing:  ['Half losing', 'text-red-400 border-red-500/30'],
  level:        ['Level', 'text-gray-300 border-gray-600'],
  needs:        ['Needs', 'text-amber-300 border-amber-500/40'],
  void:         ['Void', 'text-gray-400 border-gray-600'],
  pending:      ['Not started', 'text-gray-400 border-gray-700'],
  snaps:        ['Snap counts?', 'text-amber-300 border-amber-500/40'],
  unknown:      ['No live data', 'text-gray-500 border-gray-700'],
};
const LOCKED = new Set(['won', 'lost', 'push', 'half_won', 'half_lost']);

// A live pick as the shared filters and cells read it: its average-with-value
// / open / best / close prices at the price chosen in Filters (the best
// bookie's where one was recorded, else the median), back and edge at the one
// chosen in Odds at (a price not recorded - an opening price that was only a
// Betfair placeholder, a window from before it was kept - falls back to the
// price it was first flagged at), ev = expected return per unit from here, sd
// = the spread of that return. Its edge, what the filters read, is at the
// median price of that stage, as the upcoming bets' is.
function liveBetAt(p) {
  const at = stage => (bookBasis() ? p[`${stage}_book_back`] : null) ?? p[`${stage}_back`];
  const prices = Object.fromEntries(LIVE_STAGES.map(s => [s, at(s)]));
  const back = prices[basis()] ?? at('flagged');
  const edgeAt = o => p.model_prob == null || o == null ? null : p.model_prob * (o - 1) * (1 - p.commission) - (1 - p.model_prob);
  const net = (back - 1) * (1 - p.commission);
  const edge = edgeAt(back);
  // What the filters read: the median price and the edge at it
  const avgBack = p[`${basis()}_back`] ?? p.flagged_back;
  const avgEdge = edgeAt(avgBack);
  const bestEdge = edgeAt(p[`${basis()}_book_back`] ?? avgBack);
  // Calibrated: the stage's price judged by the calibrated chance at kickoff,
  // and (judging by it) the live chance moved by the same amount the
  // calibration moved the model's at kickoff
  const cal = calibrateBet(calib, p, { modelProb: p.model_prob, median: avgBack, taken: back });
  const close = firstClose(p);
  let { p_win: w, p_lose: l } = p.live;
  if (judging() && cal && w != null && l != null && w > 0 && l > 0 && !LOCKED.has(p.live.status)) {
    const push = p.live.p_push || 0;
    const q = sigmoid(logit(w / (1 - push)) + logit(cal.p) - logit(p.model_prob));
    w = (1 - push) * q;
    l = (1 - push) * (1 - q);
  }
  const ev = w == null ? null : w * net - l;
  const sd = w == null ? null : Math.sqrt(Math.max(0, w * net * net + l - ev * ev));
  return { ...p, prices, back, edge, avgBack, avgEdge, bestEdge, cal, close, ev, sd, chance: w };
}

// Whether a live pick was listed under the current filters at a check before
// kickoff, judged as the list judged it then (best-bets-history.js
// listedInfo), or null when it has no history to tell by
const liveListing = p => !hasHistory(p.history) ? null
  : listingOf(p, Math.min(Date.parse(p.kickoff), p.gone_at ? Date.parse(p.gone_at) : Infinity) / 1000);

const LIVE_ALL_KEY = 'bsm_bb_live_all';
let liveShowAll = (() => { try { return sessionStorage.getItem(LIVE_ALL_KEY) === '1'; } catch { return false; } })();

// The live picks that pass the sport / My Teams filters, each with whether it
// was listed under the market filters before kickoff (a pick with no history:
// whether it passes them at the Odds at stage)
const liveCandidates = () => liveData ? liveData.rows.map(liveBetAt).filter(passes).map(r => {
  const listing = liveListing(r);
  return { ...r, listing, listed: listing ? listing.ever : passesFilters(r) };
}) : [];

// The live rows on show, one line per side (any tab): those listed before
// kickoff, and with "show all" the rest too
const liveAll = () => oneLinePerSide(liveCandidates().filter(r => r.listed || liveShowAll), oddsTyped(prefs));

// "Listed 2h 40m · until 35 min before the start"
function listingHtml(r) {
  if (!r.listing) return '';
  if (!r.listing.ever) return '<div class="text-[11px] text-red-300/80">Not listed under your filters before kickoff</div>';
  const before = Date.parse(r.kickoff) / 1000 - r.listing.lastEnd;
  const until = before <= 90 ? 'up to the start' : `until ${spanText(before)} before the start`;
  return `<div class="text-[11px] text-gray-500" title="How long the list showed it under your filters before kickoff, all told">Listed ${spanText(r.listing.secs)} · ${until}</div>`;
}

// Finished: the game is over but the bet hasn't settled (its result provisional)
const isFinished = r => r.game?.state === 'final';
const LIVE_SORT_LABELS = { edge: 'edge', time: 'start time', result: 'result', ev: 'live EV', chance: 'chance' };
// Result order: won first, lost last, the undecided by how they stand
const RESULT_RANK = Object.fromEntries(['won', 'half_won', 'winning', 'half_winning', 'needs', 'level', 'push', 'snaps',
  'pending', 'unknown', 'void', 'half_losing', 'losing', 'half_lost', 'lost'].map((st, i) => [st, i]));
const resultRank = r => RESULT_RANK[r.live.status] ?? RESULT_RANK.unknown;
// Descending, nothing to go on last
const desc = (x, y) => (y ?? -Infinity) - (x ?? -Infinity);

// The live rows in the view's tab under the filters, before Finished
function liveInTab() {
  if (!liveData) return [];
  const kinds = TABS.find(t => t.key === tab).kinds;
  return liveAll().filter(r => kinds.includes(r.market_kind));
}

// The live rows that pass the view's tab, filters and Finished, sorted
function liveRows() {
  const final = prefs.liveFinal;
  const rows = liveInTab().filter(r => final === 'any' || (final === 'only') === isFinished(r));
  const game = r => `${r.sport}:${r.game_id}`;
  const chanceOf = r => r.chance ?? r.live.p_win;
  const by = {
    edge: (a, b) => b.avgEdge - a.avgEdge,
    time: (a, b) => byTime(a, b) || game(a).localeCompare(game(b)) || b.avgEdge - a.avgEdge,
    result: (a, b) => resultRank(a) - resultRank(b) || desc(chanceOf(a), chanceOf(b)) || desc(a.ev, b.ev),
    ev: (a, b) => desc(a.ev, b.ev) || b.avgEdge - a.avgEdge,
    chance: (a, b) => desc(chanceOf(a), chanceOf(b)) || desc(a.ev, b.ev),
  }[prefs.liveSort] || ((a, b) => b.avgEdge - a.avgEdge);
  return rows.sort(by);
}

function liveGameCell(r) {
  const g = r.game;
  const dot = g.state === 'live' && g.live
    ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse mr-1 align-middle" aria-hidden="true"></span>' : '';
  const score = g.home != null ? `<span class="font-semibold tabular-nums text-gray-200">${g.home}–${g.away}</span> ` : '';
  return `<td class="hidden sm:table-cell px-2 py-2">
    <a href="${builderUrl(r)}" title="Open this game in the Multi Builder"
       class="block font-semibold text-gray-100 hover:underline decoration-gray-500 underline-offset-2">${esc(r.home_team)} <span class="text-gray-500 font-normal">v</span> ${esc(r.away_team)}</a>
    <div class="text-[11px] text-gray-500 whitespace-nowrap">${sportTag(r.sport)} · ${dot}${score}${esc(g.state === 'pre' ? kickoffText(r.kickoff) : g.label)}</div>
  </td>`;
}

function liveSelectionCell(r) {
  const [badge, cls] = LIVE_STATUS[r.live.status] || LIVE_STATUS.unknown;
  const team = hasStats(r) ? teamOf(r) : null;
  const name = esc(selectionText(r));
  const g = r.game;
  return `<td class="px-2 py-2">
    <div class="font-semibold text-gray-100">${hasStats(r)
      ? `<button type="button" class="text-left font-semibold group-hover:underline decoration-gray-500 decoration-dotted underline-offset-2" title="Show player stats">${name}</button>`
      : name}${team ? ` <span class="ml-1 text-xs font-medium text-gray-400 whitespace-nowrap">${esc(team)}</span>` : ''}</div>
    <div class="text-[11px] text-gray-500">${esc(r.market_name)}</div>
    ${listingHtml(r)}
    ${gameLine(r, `${g.home != null ? `<span class="font-semibold tabular-nums text-gray-300">${g.home}–${g.away}</span> ` : ''}${esc(g.state === 'pre' ? kickoffText(r.kickoff) : g.label)}`)}
    <div class="mt-1 flex items-center gap-1.5 text-[11px] leading-none">
      <span class="px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap ${cls}">${badge}</span>
      ${r.live.detail ? `<span class="text-gray-400">${esc(r.live.detail)}</span>` : ''}${pickOutlierHtml(r)}
    </div>
  </td>`;
}

// Under a live main line's Close: the line the market closed at when it moved
// off the pick's, and the closing price at the pick's own line
function liveLineNote(r) {
  if (r.close_line == null || r.close_line === r.line) return '';
  const lc = lineMoved(r) ? closeAt(r, prefs.basis).back : null;
  const title = `The bookies closed this market at ${lineText(r, r.close_line)}, ${ptsText(r, r.line_pts)} this pick's way. `
    + 'Close above is the last price at its own line, before the line moved.'
    + (lc ? ` At its ${lineText(r, r.line)}, the close was worth about ${odds(lc)}: closing-line value is judged against that.` : '');
  return `<div class="text-[10px] leading-snug text-gray-500" title="${esc(title)}">line ${lineText(r, r.close_line)}
    <span class="${signCls(r.line_pts)}">(${ptsText(r, r.line_pts)})</span>${lc ? ` ≈${odds(lc)}` : ''}</div>`;
}

function liveRow(r, i) {
  const ch = r.chance ?? r.live.p_win, m = judging() && r.cal ? r.cal.p : r.model_prob;
  const move = ch == null || m == null || LOCKED.has(r.live.status) || Math.abs(ch - m) < 0.005 ? ''
    : ch > m ? '<span class="text-green-400 text-[10px] mr-0.5">▲</span>' : '<span class="text-red-400 text-[10px] mr-0.5">▼</span>';
  const chTitle = ch == null ? 'No estimate' : `Chance it wins from here; ${pct(m)} at kickoff`
    + (r.live.p_push > 0.001 ? `, ${pct(r.live.p_push)} it pushes` : '');
  // The prices stacked, the one chosen in Odds at highlighted
  const at = (key, label) => `<div class="text-[11px] leading-snug ${key === basis() ? 'font-semibold text-amber-400' : 'text-gray-400'}">${label} ${odds(r.prices[key])}</div>`;
  return `
    <tr class="group border-t border-gray-700/60 hover:bg-gray-700/20 align-top${hasStats(r) ? ' cursor-pointer' : ''}"${hasStats(r) ? ` data-row="${i}"` : ''}>
      ${liveGameCell(r)}${liveSelectionCell(r)}
      <td class="px-2 py-2 text-right tabular-nums whitespace-nowrap">
        <div class="font-bold text-amber-400">${odds(r.back)}</div>
        ${at('avg', 'Avg')}${at('open', 'Open')}${at('best', 'Best')}${at('close', 'Close')}${liveLineNote(r)}
      </td>
      <td class="hidden sm:table-cell px-2 py-2 text-right tabular-nums whitespace-nowrap">
        <div class="font-semibold ${signCls(r.avgEdge)}" title="At the average (median) price">${signedPct(r.avgEdge)}</div>
        <div class="text-[11px] leading-snug" title="At the best bookie's price"><span class="text-gray-500">best</span> <span class="${signCls(r.bestEdge)}">${signedPct(r.bestEdge)}</span></div>
        ${calLine({ ...r, median: r.avgBack })}
      </td>
      <td class="px-2 py-2 text-right tabular-nums text-gray-100 whitespace-nowrap" title="${esc(chTitle)}">${move}${pct(ch, 0)}</td>
      <td class="px-2 py-2 text-right tabular-nums font-bold ${signCls(r.ev)}">${signedPct(r.ev)}</td>
    </tr>`;
}

const units = x => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}u`;

function liveAgo() {
  if (!liveLoadedAt) return '';
  const s = Math.round((Date.now() - liveLoadedAt) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

// Projected ROI over the bets on show (voids and bets with no estimate left
// out), 1 unit each at the odds chosen: the expected return from here, what
// is locked in already, and what the model expected at kickoff.
function renderLiveSummary(rows) {
  const counted = rows.filter(r => r.ev != null && r.live.status !== 'void');
  const n = counted.length;
  if (!n) { $('live-summary').innerHTML = ''; return; }
  const sum = f => counted.reduce((a, r) => a + f(r), 0);
  const exp = sum(r => r.ev), sd = Math.sqrt(sum(r => r.sd * r.sd));
  const pre = sum(r => r.edge) / n;
  const locked = counted.filter(r => LOCKED.has(r.live.status));
  const has = st => counted.filter(r => st.includes(r.live.status)).length;
  const tally = [
    [has(['won', 'half_won']), 'won', 'text-green-400'], [has(['lost', 'half_lost']), 'lost', 'text-red-400'],
    [has(['winning', 'half_winning']), 'winning', 'text-green-400/80'], [has(['losing', 'half_losing']), 'losing', 'text-red-400/80'],
    [has(['needs']), 'need more', 'text-amber-300'], [has(['level', 'push']), 'level', 'text-gray-300'],
    [has(['pending']), 'not started', 'text-gray-400'],
  ].filter(([k]) => k).map(([k, label, cls]) => `<span class="${cls}">${k} ${label}</span>`).join(' · ');
  $('live-summary').innerHTML = `
    <div class="rounded-lg border border-gray-700 bg-gray-900/60 p-3 flex flex-wrap items-end gap-x-6 gap-y-2">
      <div title="Mean expected return per unit from here, over the bets below">
        <div class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Projected ROI</div>
        <div class="text-2xl font-bold tabular-nums ${signCls(exp)}">${signedPct(exp / n)}</div>
      </div>
      <div title="Expected profit from here in units (1 unit a bet), ± one standard deviation of how it could land">
        <div class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Expected</div>
        <div class="text-lg font-semibold tabular-nums text-gray-100">${units(exp)} <span class="text-xs font-normal text-gray-500">± ${sd.toFixed(1)}u</span></div>
      </div>
      <div title="Profit already decided: bets won or lost, whatever happens next (results are provisional until they settle)">
        <div class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Locked</div>
        <div class="text-lg font-semibold tabular-nums ${signCls(locked.length ? sum(r => LOCKED.has(r.live.status) ? r.ev : 0) : 0)}">${
          locked.length ? units(sum(r => LOCKED.has(r.live.status) ? r.ev : 0)) : '–'}</div>
      </div>
      <div title="The model's expected ROI on the same bets at kickoff, at the same odds">
        <div class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">At kickoff</div>
        <div class="text-lg font-semibold tabular-nums ${signCls(pre)}">${signedPct(pre)}</div>
      </div>
      <div class="flex-1 min-w-[12rem] text-right text-[11px] text-gray-500">
        <div>${n} bet${n === 1 ? '' : 's'}, 1 unit each at ${LIVE_STAGE_LABELS[basis()]} odds${bookBasis() ? ' (best bookie)' : ' (median)'}</div>
        <div class="mt-0.5">${tally}</div>
        <div class="mt-0.5" id="live-updated">Updated ${liveAgo()}</div>
      </div>
    </div>`;
}

// The picks in play hidden for never having been listed under the filters
function renderLiveUnlisted() {
  const kinds = TABS.find(t => t.key === tab).kinds;
  const n = liveCandidates().filter(r => !r.listed && kinds.includes(r.market_kind)).length;
  const el = $('live-unlisted');
  el.classList.toggle('hidden', !n);
  el.innerHTML = !n ? '' : `${liveShowAll ? `Showing ${n} tracked bet${n === 1 ? '' : 's'} the list never showed under your filters.`
    : `${n} more tracked bet${n === 1 ? '' : 's'} in play the list never showed under your filters.`}
    <button type="button" data-live-all class="ml-1 text-gray-300 underline decoration-dotted hover:text-white">${liveShowAll ? 'Hide them' : 'Show them'}</button>`;
}

function renderLive() {
  const body = $('live-body');
  const rows = liveRows();
  liveShown = rows;
  renderLiveUnlisted();
  let summary = '';
  if (!liveData) {
    $('live-summary').innerHTML = '';
    body.innerHTML = liveFailed
      ? '<tr><td colspan="6" class="px-2 py-8 text-center text-sm text-gray-500">Could not load the live bets. Trying again shortly.</td></tr>'
      : Array.from({ length: 4 }, () => '<tr><td colspan="6" class="px-2 py-2"><span class="bsm-skeleton h-8 w-full block"></span></td></tr>').join('');
  } else if (!rows.length) {
    $('live-summary').innerHTML = '';
    body.innerHTML = `<tr><td colspan="6" class="px-2 py-8 text-center text-sm text-gray-500">${
      !liveData.rows.length ? 'Nothing in play right now.'
      : prefs.liveFinal === 'only' ? 'No finished bets awaiting settlement match these filters.'
      : 'No bets in play match these filters.'}</td></tr>`;
  } else {
    loadLogs(rows);
    renderLiveSummary(rows);
    body.innerHTML = rows.map(liveRow).join('');
    const finished = rows.filter(isFinished).length;
    const hidden = prefs.liveFinal === 'hide' ? liveInTab().filter(isFinished).length : 0;
    summary = `${rows.length} bet${rows.length === 1 ? '' : 's'} ${prefs.liveFinal === 'only' ? 'finished, awaiting settlement' : 'in play'}`
      + (prefs.liveFinal === 'any' && finished ? ` (${finished} finished, awaiting settlement)` : '')
      + (hidden ? ` · ${hidden} finished hidden` : '')
      + ` · sorted by ${LIVE_SORT_LABELS[prefs.liveSort] || 'edge'}`;
  }
  $('status').textContent = summary;
  $('method-note').textContent = 'Every bet the list showed under your filters at some check before kickoff (Show them for the other '
    + 'tracked ones), from the start of its game until it settles, with how long it was listed. Scores: NHL from the NHL\'s live feed, NFL from ESPN\'s; NRL only once our own results are in. Scorers and overs are '
    + 'marked won the moment they land; anything else at full time shows its result as provisional until it settles (usually within '
    + 'the hour; NFL scorers can wait on snap counts). Chance: from the current score and the time left on the pre-game model (the sim\'s '
    + 'score spread shrunk to the time left; scorers from the chance the model gave them), so at kickoff it is the model\'s own. '
    + 'Live EV: the expected return per unit from here at the odds chosen, after commission; locked bets show what they returned. '
    + 'Odds at Avg (the default): the average price over the time the bet showed value before kickoff, weighted by time, at the price '
    + 'chosen in Filters (the best bookie\'s by default): what taking it whenever it was listed got on average. Filters and the Odds range '
    + 'read the median price at the odds chosen, as for upcoming bets. A player not in the line-up (NHL) or listed inactive (NFL) shows as void. '
    + 'NHL totals are settled by each bookie\'s rule: Unibet and TABtouch\'s main totals on 60 minutes, the rest on the final score '
    + '(overtime and the shootout\'s +1 in). An NFL player bet waits, after full time, for the snap counts to show he took the field '
    + '(any snap: a loss if he didn\'t score) or didn\'t (void), unless he touched the ball.';
}

function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(loadLive, view === 'live' && !document.hidden ? LIVE_MS : LIVE_IDLE_MS);
}

async function loadLive() {
  clearTimeout(liveTimer);
  try {
    const data = await api('best_bets/live');
    if (!data) return;   // signed out / restricted: the gate card is up
    liveData = data;
    liveFailed = false;
    liveLoadedAt = Date.now();
  } catch {
    liveFailed = true;
  }
  renderViewSwitch();
  if (view === 'live') {
    renderSportPills();
    renderLive();
  }
  scheduleLive();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && view === 'live' && Date.now() - liveLoadedAt > LIVE_MS) loadLive();
});
setInterval(() => { const el = $('live-updated'); if (el) el.textContent = `Updated ${liveAgo()}`; }, 5000);

// --- track record -----------------------------------------------------------
// Settled picks for the current tab's markets, by the edge they were first
// flagged at: does a bigger model edge actually return more?

// Profit per unit staked at the given odds, after commission on winnings.
const profit = (p, o) => p.win_frac * (o - 1) * (1 - p.commission) - (1 - p.win_frac - p.push_frac);

function summarise(picks) {
  const live = picks.filter(p => p.result !== 'void');
  const n = live.length;
  const mean = f => n ? live.reduce((a, p) => a + f(p), 0) / n : null;
  // CLV only where there was a later price to close at (as the analysis page):
  // priced again at its line, or its line moved and the close at it is known
  const repriced = live.filter(p => p.clvClose != null);
  return {
    n,
    wins:     live.reduce((a, p) => a + p.win_frac, 0),   // a half-win counts as half
    roi:      mean(p => profit(p, p.takeAt)),
    roiAvg:   mean(p => profit(p, p.backAt)),
    roiBook:  mean(p => profit(p, p.bookAt)),
    roiBest:  mean(p => profit(p, p.takeBest)),
    roiClose: mean(p => profit(p, p.takeClose)),
    clv:      repriced.length ? repriced.reduce((a, p) => a + p.takeAt / p.clvClose - 1, 0) / repriced.length : null,
  };
}

// One band: label, a bar growing left (loss) or right (profit) from a centre
// zero line, then the ROI and how many of the bets behind it won.
function roiBar(label, st, scale, dim) {
  const width = st.n ? Math.min(50, Math.abs(st.roi) / scale * 50) : 0;
  const up = st.roi >= 0;
  const bar = st.n ? `<span class="absolute top-0.5 bottom-0.5 ${up ? 'bg-green-500 rounded-r' : 'bg-red-500 rounded-l'}"
      style="${up ? 'left' : 'right'}:50%; width:${width.toFixed(1)}%; min-width:2px"></span>` : '';
  const title = st.n ? `${label} edge: ${signedPct(st.roi)} ROI over ${st.n} settled bet${st.n === 1 ? '' : 's'}, ${wonCount(st.wins)} won` : `${label} edge: no settled bets yet`;
  return `<div class="flex items-center gap-2 text-xs ${dim ? 'opacity-40' : ''}" title="${esc(title)}">
    <span class="w-14 shrink-0 tabular-nums text-gray-400">${label}</span>
    <span class="relative flex-1 h-4">
      <span class="absolute inset-y-0 left-1/2 w-px bg-gray-600"></span>${bar}
    </span>
    <span class="w-14 shrink-0 text-right tabular-nums font-semibold text-gray-100">${st.n ? signedPct(st.roi, 0) : '–'}</span>
    <span class="w-12 shrink-0 text-right tabular-nums text-gray-500">${st.n ? `${wonCount(st.wins)}/${st.n}` : ''}</span>
  </div>`;
}

// A settled or live pick's predicted-close edge when it first showed value
// (first_* and first_hrs: the one moment of its value window whose time
// before kickoff is known), at the price it would have been taken at then
function firstClose(p) {
  if (!calib?.close || p.first_back == null || p.first_hrs == null) return null;
  return closeBet(calib, p, { modelProb: p.first_prob, median: p.first_back,
                              taken: (bookBasis() ? p.first_book_back : null) ?? p.first_back,
                              at: Date.parse(p.kickoff) / 1000 - p.first_hrs * 3600 });
}

// The track record counts the analysis page's bets as that page does by
// default, so the two agree under the same filters: the settled selections
// that showed value, at their average price then (`settled`, buildModel: no
// markets without real prices, one bet per market, chosen before any filter).
// The edge that judges them is the analysis page's too (judgeEdgeOf), kept
// while the rows, calibration, judge and basis stay the same.
let trackJudge = null;
function trackEdgeOf() {
  const fp = fprefs();
  if (!trackJudge || trackJudge.rows !== settledRows || trackJudge.calib !== calib
      || trackJudge.judge !== fp.judge || trackJudge.basis !== fp.basis) {
    trackJudge = { rows: settledRows, calib, judge: fp.judge, basis: fp.basis,
                   edgeOf: judgeEdgeOf(settledRows, fp, calib) ?? null };
  }
  return trackJudge.edgeOf;
}

// A settled bet (safe-stake.js toBet) as the track record reads it. takeAt:
// the price it is taken at (the best bookie's where recorded, or the median);
// backAt / edgeAt: the median's price and the edge that judges, what the
// filters and bands read; bookAt: the best bookie's; takeBest / takeClose: the
// peak while it showed value and the closing price, at the basis chosen.
// clvClose: the close its CLV is judged by (a moved main line's: the close at
// its own line; null without a real close). fallback: the best bookie's price
// was not recorded for it.
function trackBet(b, edgeOf) {
  const r = b.row;
  return { ...r, takeAt: b.taken, fallback: b.fallback, backAt: b.back,
           edgeAt: edgeOf ? edgeOf(r) : b.edge, bookAt: priceAt(r, STAKE_STAGE, 'book').back,
           takeBest: priceAt(r, 'peak', prefs.basis).back, takeClose: priceAt(r, 'close', prefs.basis).back,
           clvClose: hasRealClose(r) ? closeAt(r, prefs.basis).back : null };
}

function renderTrackRecord() {
  const t = TABS.find(x => x.key === tab);
  const at = bookBasis() ? 'best bookie odds' : 'average odds';
  const oddsLabel = oddsText(oddsRangeOf(prefs));
  $('roi-scope').textContent = `${t.label}${sport === 'all' ? '' : ' · ' + SPORT_LABELS[sport]}${oddsLabel ? ` · ${oddsLabel}` : ''} · your filters · settled bets, one per market, 1 unit each at the ${at} averaged while they showed value`;
  if (settledRows) buildModel();   // `settled` follows the price basis
  if (!settled) {
    $('roi-headline').innerHTML = '';
    $('roi-bars').innerHTML = stakesFailed ? '' : Array.from({ length: 5 }, () => '<span class="bsm-skeleton h-4 w-full block"></span>').join('');
    $('roi-note').textContent = stakesFailed ? 'Could not load results. Try again in a moment.' : '';
    return;
  }
  // Each bet judged by its own market's filter at the median price
  const edgeOf = trackEdgeOf();
  const picks = settled.filter(b => t.kinds.includes(b.row.market_kind) && passes(b.row))
    .map(b => trackBet(b, edgeOf)).filter(p => passesMarket(fprefs(), marketOf(p), p.edgeAt, p.backAt));
  // Outlier picks apart (the tracked picks, /api/best_bets/results), edge or
  // not, at the outlier price they were picked at: those of markets whose
  // outliers are still on (outlier_on), unless Filters has outliers off
  const outs = prefs.outliers === 'off' || !results ? [] : results.picks.filter(p => p.outlier_at && (p.outlier_on ?? true)
    && p.result !== 'void' && t.kinds.includes(p.market_kind) && passes(p)
    && passesBet({ ...prefs, outliers: 'any' }, marketOf(p), p.flagged_edge, p.flagged_back, true));
  const outUnits = outs.reduce((a, p) => a + profit(p, p.outlier_book_back ?? p.flagged_back), 0);
  const outWins = outs.reduce((a, p) => a + p.win_frac, 0);
  const outLine = outs.length ? `
    <div class="mt-1.5 text-[11px] text-gray-400 tabular-nums" title="Picks made for an outlier price (one bookie far above the rest), with or without a model edge, 1 unit each at that bookie's price when it became an outlier. Not in the numbers above unless they also had an edge.">
      ⚡ Outlier picks <span class="font-semibold ${signCls(outUnits)}">${signedPct(outUnits / outs.length)}</span> · ${outs.length} bet${outs.length === 1 ? '' : 's'}, ${wonCount(outWins)} won</div>` : '';
  const keys = modalKeys().filter(k => t.kinds.includes(k.split('|')[1].replace(':3', '')));
  const bands = edgeBands(picks, spanRange(fprefs(), keys), MIN_BAND_BETS, p => p.edgeAt).filter(b => b.picks.length)
    .map(b => ({ ...b, st: summarise(b.picks) }));
  const sel = summarise(picks);
  const fallbacks = picks.filter(p => p.fallback && p.result !== 'void').length;

  $('roi-headline').innerHTML = sel.n ? `
    <div class="flex items-baseline gap-2">
      <span class="text-2xl font-bold tabular-nums text-gray-100">${signedPct(sel.roi)}</span>
      <span class="text-xs font-semibold ${signCls(sel.roi)}">${sel.roi > 0 ? 'profit' : sel.roi < 0 ? 'loss' : ''}</span>
    </div>
    <div class="text-[11px] text-gray-500">ROI at your filters · ${sel.n} bet${sel.n === 1 ? '' : 's'}, ${wonCount(sel.wins)} won</div>
    <div class="mt-1.5 text-xs tabular-nums text-gray-300" title="The same bets, 1 unit each at their average price while they showed value, at the median across the bookies and at the best price any one bookie offered">
      Average odds <span class="font-semibold ${signCls(sel.roiAvg)}">${signedPct(sel.roiAvg)}</span> · Best bookie <span class="font-semibold ${signCls(sel.roiBook)}">${signedPct(sel.roiBook)}</span></div>
    <div class="mt-1.5 text-[11px] text-gray-400 tabular-nums" title="The same bets at the best odds seen while they showed value (an upper bound) and at the last odds before kickoff; CLV compares the average odds while they showed value with the closing odds, for bets priced more than once. A line or total whose line the bookies moved is judged against the closing odds at its own line. All at the ${at}.">
      peak ${signedPct(sel.roiBest)} · closing ${signedPct(sel.roiClose)} · CLV ${signedPct(sel.clv)}</div>${outLine}`
    : `<div class="text-xs text-gray-500">No settled bets at these filters yet.</div>${outLine}`;

  const scale = Math.max(0.1, ...bands.filter(b => b.st.n).map(b => Math.abs(b.st.roi)));
  $('roi-bars').innerHTML = `
    <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
      <span class="w-14 shrink-0">Edge</span><span class="flex-1 text-center">loss · profit</span>
      <span class="w-14 shrink-0 text-right">ROI</span><span class="w-12 shrink-0 text-right" title="Bets won out of bets settled. A half-win counts as half.">Won</span>
    </div>` + bands.map(b => roiBar(b.label, b.st, scale, false)).join('');
  $('roi-note').textContent = (results ? `${results.pending.toLocaleString()} tracked bet${results.pending === 1 ? '' : 's'} awaiting a result. ` : '')
    + 'Counted as the analysis page counts them: one bet per market (the main line, the side the model liked best), '
    + 'so alternate lines and the other side of a result already counted are left out. '
    + `Each band is as narrow as it can be with ${MIN_BAND_BETS} settled bets in it, so there are more bands as results come in. `
    + (fallbacks ? `${fallbacks} of these bets had no best bookie price recorded and count at the average. ` : '')
    + 'Settled from our own results data; voided bets excluded. Small samples swing a lot.';
}

// The tracked picks: the track record's outlier line and pending count
async function loadResults() {
  try {
    results = await api('best_bets/results');
  } catch { /* the track record goes without them */ }
  renderTrackRecord();
}

// --- view switching ---------------------------------------------------------

// Upcoming / Live, with how many bets are in play under the current filters
function renderViewSwitch() {
  const n = liveData ? liveRows().length : null;
  const item = (key, label, extra = '') => `
    <button type="button" data-view="${key}" role="tab" aria-selected="${key === view}"
            class="-mb-px pb-2 border-b-2 text-sm font-semibold flex items-center gap-1.5 transition-colors ${key === view
              ? 'border-amber-400 text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'}">${label}${extra}</button>`;
  $('view-switch').innerHTML = item('upcoming', 'Upcoming')
    + item('live', 'Live', n ? `<span class="inline-flex items-center gap-1 rounded-full bg-red-500/15 text-red-300 px-1.5 text-[11px] tabular-nums">
        <span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" aria-hidden="true"></span>${n}</span>` : '');
}

const renderView = () => view === 'live' ? renderLive() : renderBets();

// --- filters ------------------------------------------------------------------

// The markets the Filters modal lists: every one of the sports on the page
// (upcoming, in play or settled), then any other market the data has
function modalKeys() {
  const rows = [...bets, ...(liveData?.rows || []), ...(results?.picks || [])];
  const sports = Object.keys(SPORT_LABELS).filter(s => rows.some(r => r.sport === s));
  return filterKeys(sports.length ? sports : ['nfl', 'nhl'], rows.map(marketOf));
}

// { market: bets on show now in the view up, whatever the tab }
function marketCounts() {
  const counts = {};
  for (const r of view === 'live' ? liveAll() : upcomingRows()) counts[marketOf(r)] = (counts[marketOf(r)] || 0) + 1;
  return counts;
}

// Column titles say which price they are
function renderHeads() {
  const book = bookBasis();
  const price = book ? 'the best price any one bookie offers (Betfair markets: the exchange\'s best back price)'
    : 'the median price across the bookies (Betfair markets: the exchange\'s best back price)';
  $('th-odds').title = `All at ${price}. Top: the price now, when last checked, with ▲ / ▼ for its latest move `
    + '(lengthened / shortened). Open: the first price recorded, whatever the edge was then. Best: the highest seen since it '
    + 'first showed value (or now, if higher). The line: the price at every check so far, the dot is now. Hover a price for its history.';
  $('lth-odds').title = `All at ${price}. Top: the price chosen in Odds at. Avg: the average while it showed value before kickoff, `
    + 'weighted by time. Open: the first price recorded. Best: the highest from when it first showed value to kickoff. Close: the last before kickoff.';
  $('filters-summary').textContent = `${prefsSummary(prefs, modalKeys())} · ${BASES[prefs.basis].toLowerCase()}`;
}

function render() {
  noteSeen(upcomingRows(), true);
  const isLive = view === 'live';
  renderViewSwitch();
  renderTabs();
  $('bets-view').classList.toggle('hidden', isLive);
  $('live-view').classList.toggle('hidden', !isLive);
  $('risk-wrap').classList.toggle('hidden', isLive);
  $('bank-wrap').classList.toggle('hidden', isLive);
  $('basis-wrap').classList.toggle('hidden', !isLive);
  $('sort-wrap').classList.toggle('hidden', isLive);
  $('live-sort-wrap').classList.toggle('hidden', !isLive);
  $('live-final-wrap').classList.toggle('hidden', !isLive);
  $('my-teams-wrap').classList.toggle('hidden', !hasAnyTeams());
  renderHeads();
  renderSportPills();
  renderDayFilter();
  renderView();
  renderTrackRecord();
}

function setParam(key, value) {
  const url = new URL(location.href);
  url.searchParams.set(key, value);
  history.replaceState(null, '', url);
}

function setTab(next) {
  tab = next;
  setParam('tab', tab);
  render();
}

function setView(next) {
  view = next;
  setParam('view', view);
  render();
  if (view === 'live' && Date.now() - liveLoadedAt > LIVE_MS) loadLive();
  else scheduleLive();   // 30 s while Live is up, 2 min otherwise
}

$('view-switch').addEventListener('click', e => {
  const b = e.target.closest('[data-view]');
  if (b && b.dataset.view !== view) setView(b.dataset.view);
});

$('view-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b && b.dataset.tab !== tab) setTab(b.dataset.tab);
});
$('sport-pills').addEventListener('click', e => {
  const b = e.target.closest('[data-sport]');
  if (b) { sport = b.dataset.sport; render(); }
});
$('day-filter').addEventListener('change', e => { day = e.target.value; render(); });
['odds-min', 'odds-max'].forEach(id => $(id).addEventListener('change', () => { savePrefs(); keepOptimised(); render(); }));
// "Most profitable" in the modal (and kept on it): from the settled bets the
// stakes load, judged as Filters says once the calibration it needs is in
const optimise = Object.assign(next => settledRows && optimiseMarkets(settledRows, next, modalKeys(), judgeEdgeOf(settledRows, next, calib) ?? null),
                               { ready: next => !!settledRows && judgeEdgeOf(settledRows, next ?? prefs, calib) !== undefined });
$('filters-btn').addEventListener('click', () => openFilters({
  prefs, keys: modalKeys(), counts: marketCounts(), opener: $('filters-btn'), optimise,
  onChange: next => {
    const basisChanged = next.basis !== prefs.basis;
    prefs = next;
    storePrefs(prefs);
    buildModel();   // the stakes follow the price basis
    if (basisChanged) startCalibration();
    render();
    return marketCounts();
  },
}));
$('bets-body').addEventListener('click', e => {
  if (e.target.closest('a')) return;   // the game's Multi Builder link
  const row = e.target.closest('tr[data-row]');
  if (row && shown[row.dataset.row]) openStats(shown[row.dataset.row]);
});
$('live-body').addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const row = e.target.closest('tr[data-row]');
  if (row && liveShown[row.dataset.row]) openStats(liveShown[row.dataset.row]);
});
$('stake-risk').addEventListener('change', e => {
  stakePrefs.risk = e.target.value;
  saveStakePrefs(stakePrefs);
  buildModel();
  renderView();
});
$('stake-balance').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  stakePrefs.balance = v > 0 ? v : null;
  saveStakePrefs(stakePrefs);
  renderView();
});
['sort-by', 'live-sort', 'live-final', 'my-teams-only', 'odds-basis'].forEach(id =>
  $(id).addEventListener('change', () => { savePrefs(); render(); }));
window.addEventListener(MY_TEAMS_CHANGED, () => { if (!$('content').classList.contains('hidden')) render(); });

installTapTips(document.body);

// --- keeping the list current -------------------------------------------------
// /api/best_bets again every BETS_MS while the page is in view (the backend
// caches a minute; the odds are checked every 15 minutes, every 15 near the
// start): new bets appear and started games go without a reload. In a
// background tab only while alerts are on, else again on coming back.
const BETS_MS = 120_000;
let betsLoadedAt = 0;
let betsTimer = 0;
let betsLoading = false;

function renderUpdated() {
  if (!checkedAt) return;
  const mins = Math.max(0, Math.round((Date.now() - new Date(checkedAt)) / 60000));
  const ago = mins < 60 ? `${mins} min` : mins < 2880 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  $('updated').textContent = `Odds checked ${ago} ago`;
  $('updated').classList.remove('hidden');
}

function applyBets(data, initial = false) {
  bets = data.rows || [];
  dropped = data.dropped || [];
  checkedAt = data.checked_at || null;
  betsLoadedAt = Date.now();
  renderUpdated();
  const fresh = noteSeen(upcomingRows());
  if (!initial) notifyNew(fresh);
}

async function loadBets() {
  clearTimeout(betsTimer);
  if (betsLoading) return;
  betsLoading = true;
  let ok = true;
  try {
    const data = await api('best_bets');
    ok = !!data;                 // null: signed out or restricted, the gate card is up
    if (data) {
      applyBets(data);
      render();
    }
  } catch { /* keep what is on show: the next tick tries again */ }
  betsLoading = false;
  if (ok) scheduleBets();
}

function scheduleBets() {
  clearTimeout(betsTimer);
  if (document.hidden && !alertsOn()) return;
  betsTimer = setTimeout(loadBets, BETS_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !betsLoadedAt) return;
  if (Date.now() - betsLoadedAt > 60_000) loadBets(); else scheduleBets();
});
setInterval(renderUpdated, 30_000);

// --- alerts ---------------------------------------------------------------------
// A browser notification for bets that start passing the filters at a
// refresh, while a tab with the page is open. This browser only.
const ALERTS_KEY = 'bsm_bb_alerts';
const canNotify = () => typeof Notification !== 'undefined';
const alertsOn = () => {
  try { return canNotify() && Notification.permission === 'granted' && localStorage.getItem(ALERTS_KEY) === '1'; } catch { return false; }
};

function renderAlerts() {
  const b = $('alerts-btn');
  b.classList.toggle('hidden', !canNotify());
  const on = alertsOn();
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('border-amber-400', on);
  b.classList.toggle('text-amber-300', on);
  if (canNotify() && Notification.permission === 'denied') $('alerts-label').textContent = 'Alerts blocked';
  else $('alerts-label').textContent = on ? 'Alerts on' : 'Alerts off';
}

function notifyNew(rows) {
  if (!rows.length || !alertsOn()) return;
  const top = [...rows].sort((a, b) => b.edge - a.edge).slice(0, 3);
  const body = top.map(r => `${selectionText(r)} (${r.home_team} v ${r.away_team}) ${odds(r.back)}, edge ${signedPct(r.edge)}`).join('\n')
    + (rows.length > top.length ? `\nand ${rows.length - top.length} more` : '');
  try {
    const n = new Notification(`Best Bets: ${rows.length} new bet${rows.length === 1 ? '' : 's'}`, { body, tag: 'bsm-best-bets' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some browsers only notify from a service worker */ }
}

$('alerts-btn').addEventListener('click', async () => {
  if (alertsOn()) {
    try { localStorage.setItem(ALERTS_KEY, '0'); } catch { /* storage unavailable */ }
  } else if (canNotify()) {
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm === 'granted') try { localStorage.setItem(ALERTS_KEY, '1'); } catch { /* storage unavailable */ }
  }
  renderAlerts();
  scheduleBets();
});

$('live-unlisted').addEventListener('click', e => {
  if (!e.target.closest('[data-live-all]')) return;
  liveShowAll = !liveShowAll;
  try { sessionStorage.setItem(LIVE_ALL_KEY, liveShowAll ? '1' : '0'); } catch { /* storage unavailable */ }
  render();
});

async function init() {
  let data;
  try {
    data = await api('best_bets');
  } catch {
    gateCard('Could not load Best Bets', 'Try again in a moment.');
    return;
  }
  if (!data) return;   // sign-in / restricted card is showing
  applyBets(data, true);
  renderAlerts();
  $('gate').innerHTML = '';
  $('content').classList.remove('hidden');
  applyPrefs();
  $('stake-risk').value = stakePrefs.risk;
  $('stake-balance').value = stakePrefs.balance ?? '';
  loadMyTeams();   // profile teams may arrive later; MY_TEAMS_CHANGED re-renders
  const wanted = new URLSearchParams(location.search).get('tab');
  tab = TABS.some(t => t.key === wanted) ? wanted : 'all';
  view = new URLSearchParams(location.search).get('view') === 'live' ? 'live' : 'upcoming';
  render();
  scheduleBets();  // and keeps itself current
  loadResults();   // the track record fills in when it arrives
  loadStakes();    // and the Stake column
  loadLive();      // and the bets in play (the Live tab's count too)
  // The account's filters, where they differ from this browser's
  syncPrefs(prefs).then(remote => {
    if (!remote) return;
    prefs = remote;
    keepOptimised();
    applyPrefs();
    buildModel();
    render();
  }).catch(() => {});
}

init();
