// best-bets.js — drives pages/best_bets.html.
//
// Model prices vs Betfair Exchange back prices, pre-computed off-site (the
// betfair-api repo) and served by /api/best_bets — this page never talks to
// Betfair. Access is per account: the API answers 401 (not signed in), 403
// (signed in, not granted) or the data, and the page shows a sign-in card, a
// "Restricted" card or the tables accordingly. The Filters modal sets which
// markets show, the edge each needs and whether bets are judged at the best
// single bookie's price (the default) or the median across them; it is saved to
// the account. The track-record sidebar aggregates the settled picks from
// /api/best_bets/results in the browser so those filters, the sport and the
// odds range apply to the ROI numbers too. NFL / NHL
// scorers open the player's stats window (player-stats-modal.js) and show his
// team and how often he has scored (last 10 / last season / career, from the
// Multi Builder's game_player_logs) against the chance the bookie odds imply.
// The game links to that game's Multi Builder. The Stake column comes from
// the settled selections in /api/best_bets/analysis like each bet (its market,
// edge up to its own, odds near its own: safe-stake.js), at the Risk level
// chosen and the bank entered. Each bet shows its opening, best and current
// odds. The Live view (/api/best_bets/live) is every tracked bet whose game
// has started, until it settles: the score, where the bet stands, its chance
// from here and the expected return, with a projected ROI over them all.
import { BACKEND, apiUrl } from './api-config.js';
import { supabase, getSession } from './supabase-client.js';
import { involvesMyTeam, hasAnyTeams, loadMyTeams, MY_TEAMS_CHANGED } from './my-teams.js';
import { openPlayerStats, STATS_SPORTS } from './player-stats-modal.js';
import { SPORT_LABELS, SPORT_COLORS, esc, odds, pct, signedPct, signCls, wonCount,
         selectionText, bestBookHtml, edgeBands, loadStakePrefs, saveStakePrefs, money,
         PROP_KINDS, isProp } from './best-bets-shared.js';
import { decodeRows, toBet, stakeModel, stakeFor, liveBet } from './safe-stake.js';
import { dropEmptyMarkets, onePerMarket, RULE_MIN_BETS, RULE_MIN_GAMES } from './roi-stats.js';
import { marketOf, passesMarket, priceAt, oddsRangeOf, oddsTyped, oddsText, prefsSummary, spanRange,
         BASES, LIVE_STAGES } from './best-bets-filters.js';
import { localPrefs, syncPrefs, savePrefs as storePrefs, openFilters, filterKeys } from './best-bets-prefs.js';

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
let shown = [];            // the rows in the table, in order (data-row indexes it)
let results = null;        // /api/best_bets/results, loaded on first open
let tab = 'all';
let sport = 'all';
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
  $('odds-min').value = prefs.odds[0];
  $('odds-max').value = prefs.odds[1];
}
// The bar's controls into the settings, then saved
function savePrefs() {
  prefs = { ...prefs, sort: $('sort-by').value === 'time' ? 'time' : 'edge', myTeams: $('my-teams-only').checked,
            liveStage: LIVE_STAGES.includes($('odds-basis').value) ? $('odds-basis').value : 'best',
            odds: [$('odds-min').value.trim(), $('odds-max').value.trim()] };
  storePrefs(prefs);
}

// Sport / My Teams: shared by the table and the track record.
function passes(r) {
  return (sport === 'all' || r.sport === sport)
    && (!$('my-teams-only').checked || !hasAnyTeams() || involvesMyTeam(r.sport, r.home_team, r.away_team));
}
// Its market switched on, the edge that market needs and the odds range, both
// at the median: the same bets pass whichever price they are taken at
const passesFilters = r => passesMarket(prefs, marketOf(r), r.avgEdge ?? r.edge, r.avgBack ?? r.median ?? r.back);

const byTime = (a, b) => new Date(a.kickoff) - new Date(b.kickoff);

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

function gameCell(r) {
  return `<td class="px-2 py-2">
    <a href="${builderUrl(r)}" title="Open this game in the Multi Builder"
       class="block font-semibold text-gray-100 hover:underline decoration-gray-500 underline-offset-2">${esc(r.home_team)} <span class="text-gray-500 font-normal">v</span> ${esc(r.away_team)}</a>
    <div class="text-[11px] text-gray-500">${sportTag(r.sport)} · ${esc(kickoffText(r.kickoff))}</div>
  </td>`;
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

function selectionCell(r) {
  const name = esc(selectionText(r));
  const team = hasStats(r) ? teamOf(r) : null;
  return `<td class="px-2 py-2">
    <div class="font-semibold text-gray-100">${hasStats(r)
      ? `<button type="button" class="text-left font-semibold group-hover:underline decoration-gray-500 decoration-dotted underline-offset-2" title="Show player stats">${name}</button>`
      : name}${team ? ` <span class="ml-1 text-xs font-medium text-gray-400 whitespace-nowrap">${esc(team)}</span>` : ''}</div>
    <div class="text-[11px] text-gray-500">${esc(r.market_name)}</div>
    ${bestBookHtml(r, r.atBook ? r.median : null)}
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

// --- stakes -----------------------------------------------------------------
// Settled selections as the analysis page counts them by default: odds when
// first priced, every source, one bet per market.

const VERDICT_TEXT = { thin: 'too few to call', open: 'unproven', ahead: 'proven profit', behind: 'proven loss' };

let settledRows = null;    // decoded /api/best_bets/analysis rows
let settledBasis = null;   // the price basis `settled` was read at

function buildModel() {
  if (settledRows && settledBasis !== prefs.basis) {
    settled = onePerMarket(dropEmptyMarkets(settledRows.map(r => toBet(r, 'open', prefs.basis))).kept);
    settledBasis = prefs.basis;
  }
  model = settled && stakeModel(settled, stakePrefs.risk, stakePrefs.detail);
}

async function loadStakes() {
  try {
    const data = await api('best_bets/analysis');
    if (!data) return;
    settledRows = decodeRows(data);
    buildModel();
  } catch {
    stakesFailed = true;
  }
  renderView();
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

function stakeCell(r) {
  const td = (inner, title = '') => `<td class="px-2 py-2 text-right tabular-nums whitespace-nowrap"${title ? ` title="${esc(title)}"` : ''}>${inner}</td>`;
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
function upcomingAt(r) {
  const book = bookBasis() && r.best_book_back != null && r.best_book_edge != null;
  return book
    ? { ...r, back: r.best_book_back, bestEdge: r.best_book_edge, open: r.open_book_odds ?? r.open_odds,
        best: r.best_book_odds ?? r.best_odds, median: r.back, atBook: true }
    : { ...r, bestEdge: r.best_book_edge ?? r.edge, open: r.open_odds, best: r.best_odds, median: r.back };
}

function betRow(r, i) {
  return `
    <tr class="group border-t border-gray-700/60 hover:bg-gray-700/20${hasStats(r) ? ' cursor-pointer' : ''}"${hasStats(r) ? ` data-row="${i}"` : ''}>
      ${gameCell(r)}${selectionCell(r)}
      <td class="hidden sm:table-cell px-2 py-2 text-right tabular-nums text-gray-400">${odds(r.open)}</td>
      <td class="hidden sm:table-cell px-2 py-2 text-right tabular-nums text-gray-300">${odds(r.best)}</td>
      <td class="px-2 py-2 text-right tabular-nums font-bold text-amber-400">${odds(r.back)}</td>
      <td class="hidden sm:table-cell px-2 py-2 text-right tabular-nums text-gray-300">${pct(r.model_prob)}</td>
      <td class="px-2 py-2 text-right tabular-nums text-gray-300">${odds(r.fair_odds)}</td>
      <td class="px-2 py-2 text-right tabular-nums font-bold ${signCls(r.edge)}">${signedPct(r.edge)}</td>
      <td class="px-2 py-2 text-right tabular-nums font-bold ${signCls(r.bestEdge)}">${signedPct(r.bestEdge)}</td>
      ${stakeCell(r)}
    </tr>`;
}

// A game's alternate lines and totals win and lose with its standard one, so
// at most one line is shown per game, market and side. With no odds range
// typed that is the bookies' standard line; with one, the standard line when
// its price fits, else the alternate nearest it that does.
function oneLinePerSide(rows, oddsTyped) {
  if (!oddsTyped) return rows.filter(r => !r.alternate);
  const key = r => `${r.sport}:${r.game_id}|${r.market_kind}|${r.side}`;
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

// The upcoming bets that pass the sport / My Teams / market filters, at the
// price chosen, one line per side (any tab)
const upcomingRows = () => oneLinePerSide(bets.map(upcomingAt).filter(r => passes(r) && passesFilters(r)), oddsTyped(prefs));

function renderBets() {
  const kinds = TABS.find(t => t.key === tab).kinds;
  const byEdge = $('sort-by').value !== 'time';
  const inTab = bets.filter(r => kinds.includes(r.market_kind));
  const rows = upcomingRows().filter(r => kinds.includes(r.market_kind));
  const body = $('bets-body');
  let summary = '';
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="10" class="px-2 py-8 text-center text-sm text-gray-500">${
      inTab.length ? 'No bets match these filters.' : 'No value found in these markets at the last check.'}</td></tr>`;
  } else {
    rows.sort((a, b) => byEdge ? b.edge - a.edge : byTime(a, b) || b.edge - a.edge);
    loadLogs(rows);
    body.innerHTML = rows.map(betRow).join('');
    summary = `${rows.length} selection${rows.length === 1 ? '' : 's'}`;
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
    + 'Scorer and player prop prices assume the player takes the field (bookmakers void the bet if he does not).';
  const stakeNote = ' Stake: a share of the bank, sized off the low end of what settled bets like it have returned (same market, '
    + 'edge no higher, odds from half its own to the next step up), '
    + 'falling back to all markets where that market has not proven anything either way. None until that low end is a profit, and none past the edge or odds '
    + `where bets have turned to losing again (outliers). ⚠ marks a stake resting on fewer than ${RULE_MIN_BETS} bets over ${RULE_MIN_GAMES} games: not proven yet.`;
  const exchangeNote = 'Other bookie odds are the best back price on the Betfair Exchange at the last check (delayed, and '
    + 'they will have moved): use them as a guide to where the value is. Their edge allows for Betfair commission.';
  $('method-note').textContent = tab === 'scorers' || tab === 'props' ? bookNote : `${bookNote} ${exchangeNote}`;
  $('method-note').textContent += stakeNote;
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
      { label: `Odds (${basis()})`, value: odds(r.back), cls: 'text-amber-400', sub: `Open ${odds(r.prices.open)} · Best ${odds(r.prices.best)} · Close ${odds(r.prices.close)}` },
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

// The Odds at choice: which of a bet's prices its edge, EV and the filters use
const basis = () => LIVE_STAGES.includes($('odds-basis').value) ? $('odds-basis').value : 'best';

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
  unknown:      ['No live data', 'text-gray-500 border-gray-700'],
};
const LOCKED = new Set(['won', 'lost', 'push', 'half_won', 'half_lost']);

// A live pick as the shared filters and cells read it: its open / best /
// close prices at the price chosen in Filters (the best bookie's where one was
// recorded, else the median), back and edge at the one chosen in Odds at (an
// opening price that was only a Betfair placeholder falls back to the price
// it was first flagged at), ev = expected return per unit from here, sd = the
// spread of that return.
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
  const { p_win: w, p_lose: l } = p.live;
  const ev = w == null ? null : w * net - l;
  const sd = w == null ? null : Math.sqrt(Math.max(0, w * net * net + l - ev * ev));
  return { ...p, prices, back, edge, avgBack, avgEdge, bestEdge, ev, sd };
}

// The live rows that pass the sport / My Teams / market filters, one line per side (any tab)
const liveAll = () => liveData ? oneLinePerSide(liveData.rows.map(liveBetAt).filter(r => passes(r) && passesFilters(r)),
                                                oddsTyped(prefs)) : [];

// The live rows that pass the view's tab and filters, sorted
function liveRows() {
  if (!liveData) return [];
  const kinds = TABS.find(t => t.key === tab).kinds;
  const rows = liveAll().filter(r => kinds.includes(r.market_kind));
  const byEdge = $('sort-by').value !== 'time';
  const game = r => `${r.sport}:${r.game_id}`;
  return rows.sort((a, b) => byEdge ? b.avgEdge - a.avgEdge
    : byTime(a, b) || game(a).localeCompare(game(b)) || b.avgEdge - a.avgEdge);
}

function liveGameCell(r) {
  const g = r.game;
  const dot = g.state === 'live' && g.live
    ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse mr-1 align-middle" aria-hidden="true"></span>' : '';
  const score = g.home != null ? `<span class="font-semibold tabular-nums text-gray-200">${g.home}–${g.away}</span> ` : '';
  return `<td class="px-2 py-2">
    <a href="${builderUrl(r)}" title="Open this game in the Multi Builder"
       class="block font-semibold text-gray-100 hover:underline decoration-gray-500 underline-offset-2">${esc(r.home_team)} <span class="text-gray-500 font-normal">v</span> ${esc(r.away_team)}</a>
    <div class="text-[11px] text-gray-500 whitespace-nowrap">${sportTag(r.sport)} · ${dot}${score}${esc(g.state === 'pre' ? kickoffText(r.kickoff) : g.label)}</div>
  </td>`;
}

function liveSelectionCell(r) {
  const [badge, cls] = LIVE_STATUS[r.live.status] || LIVE_STATUS.unknown;
  const team = hasStats(r) ? teamOf(r) : null;
  const name = esc(selectionText(r));
  return `<td class="px-2 py-2">
    <div class="font-semibold text-gray-100">${hasStats(r)
      ? `<button type="button" class="text-left font-semibold group-hover:underline decoration-gray-500 decoration-dotted underline-offset-2" title="Show player stats">${name}</button>`
      : name}${team ? ` <span class="ml-1 text-xs font-medium text-gray-400 whitespace-nowrap">${esc(team)}</span>` : ''}</div>
    <div class="text-[11px] text-gray-500">${esc(r.market_name)}</div>
    <div class="mt-1 flex items-center gap-1.5 text-[11px] leading-none">
      <span class="px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap ${cls}">${badge}</span>
      ${r.live.detail ? `<span class="text-gray-400">${esc(r.live.detail)}</span>` : ''}
    </div>
  </td>`;
}

function liveRow(r, i) {
  const ch = r.live.p_win, m = r.model_prob;
  const move = ch == null || m == null || LOCKED.has(r.live.status) || Math.abs(ch - m) < 0.005 ? ''
    : ch > m ? '<span class="text-green-400 text-[10px] mr-0.5">▲</span>' : '<span class="text-red-400 text-[10px] mr-0.5">▼</span>';
  const chTitle = ch == null ? 'No estimate' : `Chance it wins from here; ${pct(m)} at kickoff`
    + (r.live.p_push > 0.001 ? `, ${pct(r.live.p_push)} it pushes` : '');
  const at = (o, key) => `<td class="hidden sm:table-cell px-2 py-2 text-right tabular-nums ${key === basis() ? 'font-bold text-amber-400' : 'text-gray-400'}">${odds(o)}</td>`;
  return `
    <tr class="group border-t border-gray-700/60 hover:bg-gray-700/20${hasStats(r) ? ' cursor-pointer' : ''}"${hasStats(r) ? ` data-row="${i}"` : ''}>
      ${liveGameCell(r)}${liveSelectionCell(r)}
      ${at(r.prices.open, 'open')}${at(r.prices.best, 'best')}${at(r.prices.close, 'close')}
      <td class="hidden sm:table-cell px-2 py-2 text-right tabular-nums text-gray-300">${signedPct(r.avgEdge)}</td>
      <td class="hidden sm:table-cell px-2 py-2 text-right tabular-nums text-gray-300">${signedPct(r.bestEdge)}</td>
      <td class="px-2 py-2 text-right tabular-nums text-gray-100 whitespace-nowrap" title="${esc(chTitle)}">${move}${pct(ch, 0)}</td>
      <td class="px-2 py-2 text-right tabular-nums font-bold ${signCls(r.ev)}">${signedPct(r.ev)}<div class="sm:hidden text-[11px] font-normal text-gray-500">@ ${odds(r.back)}</div></td>
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
        <div>${n} bet${n === 1 ? '' : 's'}, 1 unit each at ${basis()} odds${bookBasis() ? ' (best bookie)' : ' (average)'}</div>
        <div class="mt-0.5">${tally}</div>
        <div class="mt-0.5" id="live-updated">Updated ${liveAgo()}</div>
      </div>
    </div>`;
}

function renderLive() {
  const body = $('live-body');
  const rows = liveRows();
  liveShown = rows;
  let summary = '';
  if (!liveData) {
    $('live-summary').innerHTML = '';
    body.innerHTML = liveFailed
      ? '<tr><td colspan="9" class="px-2 py-8 text-center text-sm text-gray-500">Could not load the live bets. Trying again shortly.</td></tr>'
      : Array.from({ length: 4 }, () => '<tr><td colspan="9" class="px-2 py-2"><span class="bsm-skeleton h-8 w-full block"></span></td></tr>').join('');
  } else if (!rows.length) {
    $('live-summary').innerHTML = '';
    body.innerHTML = `<tr><td colspan="9" class="px-2 py-8 text-center text-sm text-gray-500">${
      liveData.rows.length ? 'No bets in play match these filters.' : 'Nothing in play right now.'}</td></tr>`;
  } else {
    loadLogs(rows);
    renderLiveSummary(rows);
    body.innerHTML = rows.map(liveRow).join('');
    summary = `${rows.length} bet${rows.length === 1 ? '' : 's'} in play · sorted by ${$('sort-by').value !== 'time' ? 'edge' : 'start time'}`;
  }
  $('status').textContent = summary;
  $('method-note').textContent = 'Every bet tracked before kickoff with value at the average price, from the start of its game until it '
    + 'settles. Scores: NHL from the NHL\'s live feed, NFL from ESPN\'s; NRL only once our own results are in. Scorers and overs are '
    + 'marked won the moment they land; anything else at full time shows its result as provisional until it settles (usually within '
    + 'the hour; NFL scorers can wait on snap counts). Chance: from the current score and the time left on the pre-game model (the sim\'s '
    + 'score spread shrunk to the time left; scorers from the chance the model gave them), so at kickoff it is the model\'s own. '
    + 'Live EV: the expected return per unit from here at the odds chosen, after commission; locked bets show what they returned. '
    + 'Filters and the Odds range use the odds chosen too. A player not in the line-up (NHL) or listed inactive (NFL) shows as void.';
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
  return {
    n,
    wins:     live.reduce((a, p) => a + p.win_frac, 0),   // a half-win counts as half
    roi:      mean(p => profit(p, p.takeFlagged)),
    roiAvg:   mean(p => profit(p, p.flagged_back)),
    roiBook:  mean(p => profit(p, p.bookFlagged)),
    roiBest:  mean(p => profit(p, p.takeBest)),
    roiClose: mean(p => profit(p, p.takeClose)),
    clv:      mean(p => p.takeFlagged / p.takeClose - 1),
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

// A settled pick at the price chosen in Filters: the flagged / best / close
// odds it is taken at, the best bookie's (where recorded) or the median. It
// is chosen (edge, odds range) at the median either way. fallback: the best
// bookie's price was not recorded for it.
function trackAt(p) {
  const f = priceAt(p, 'flagged', prefs.basis);
  return { ...p, takeFlagged: f.back, fallback: f.fallback, bookFlagged: priceAt(p, 'flagged', 'book').back,
           takeBest: priceAt(p, 'best', prefs.basis).back, takeClose: priceAt(p, 'close', prefs.basis).back };
}

function renderTrackRecord() {
  const t = TABS.find(x => x.key === tab);
  const at = bookBasis() ? 'best bookie odds' : 'average odds';
  const oddsLabel = oddsText(oddsRangeOf(prefs));
  $('roi-scope').textContent = `${t.label}${sport === 'all' ? '' : ' · ' + SPORT_LABELS[sport]}${oddsLabel ? ` · ${oddsLabel}` : ''} · your filters · settled bets, 1 unit each at the ${at} when flagged`;
  if (!results) {
    $('roi-headline').innerHTML = '';
    $('roi-bars').innerHTML = resultsFailed ? '' : Array.from({ length: 5 }, () => '<span class="bsm-skeleton h-4 w-full block"></span>').join('');
    $('roi-note').textContent = resultsFailed ? 'Could not load results. Try again in a moment.' : '';
    return;
  }
  // Each pick judged by its own market's filter at the median price when flagged
  const picks = results.picks.map(trackAt).filter(p => t.kinds.includes(p.market_kind) && passes(p)
    && passesMarket(prefs, marketOf(p), p.flagged_edge, p.flagged_back));
  const keys = modalKeys().filter(k => t.kinds.includes(k.split('|')[1].replace(':3', '')));
  const bands = edgeBands(picks, spanRange(prefs, keys), MIN_BAND_BETS).filter(b => b.picks.length)
    .map(b => ({ ...b, st: summarise(b.picks) }));
  const sel = summarise(picks);
  const fallbacks = picks.filter(p => p.fallback && p.result !== 'void').length;

  $('roi-headline').innerHTML = sel.n ? `
    <div class="flex items-baseline gap-2">
      <span class="text-2xl font-bold tabular-nums text-gray-100">${signedPct(sel.roi)}</span>
      <span class="text-xs font-semibold ${signCls(sel.roi)}">${sel.roi > 0 ? 'profit' : sel.roi < 0 ? 'loss' : ''}</span>
    </div>
    <div class="text-[11px] text-gray-500">ROI at your filters · ${sel.n} bet${sel.n === 1 ? '' : 's'}, ${wonCount(sel.wins)} won</div>
    <div class="mt-1.5 text-xs tabular-nums text-gray-300" title="The same bets, 1 unit each when flagged, at the average price across the bookies and at the best price any one bookie offered">
      Average odds <span class="font-semibold ${signCls(sel.roiAvg)}">${signedPct(sel.roiAvg)}</span> · Best bookie <span class="font-semibold ${signCls(sel.roiBook)}">${signedPct(sel.roiBook)}</span></div>
    <div class="mt-1.5 text-[11px] text-gray-400 tabular-nums" title="The same bets at the best odds seen before kickoff (an upper bound) and at the last odds before kickoff; CLV compares flagged odds with closing odds. All at the ${at}.">
      best seen ${signedPct(sel.roiBest)} · closing ${signedPct(sel.roiClose)} · CLV ${signedPct(sel.clv)}</div>`
    : '<div class="text-xs text-gray-500">No settled bets at these filters yet.</div>';

  const scale = Math.max(0.1, ...bands.filter(b => b.st.n).map(b => Math.abs(b.st.roi)));
  $('roi-bars').innerHTML = `
    <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
      <span class="w-14 shrink-0">Edge</span><span class="flex-1 text-center">loss · profit</span>
      <span class="w-14 shrink-0 text-right">ROI</span><span class="w-12 shrink-0 text-right" title="Bets won out of bets settled. A half-win counts as half.">Won</span>
    </div>` + bands.map(b => roiBar(b.label, b.st, scale, false)).join('');
  $('roi-note').textContent = `${results.pending.toLocaleString()} tracked bet${results.pending === 1 ? '' : 's'} awaiting a result. `
    + `Each band is as narrow as it can be with ${MIN_BAND_BETS} settled bets in it, so there are more bands as results come in. `
    + (fallbacks ? `${fallbacks} of these bets had no best bookie price recorded and count at the average. ` : '')
    + 'Settled from our own results data; voided bets excluded. Small samples swing a lot.';
}

let resultsFailed = false;
async function loadResults() {
  try {
    results = await api('best_bets/results');
  } catch {
    resultsFailed = true;
  }
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
  $('th-open').title = `The first price recorded for this selection, whatever the edge was then: ${price}`;
  $('th-best').title = `The highest price seen since it first showed value (or now, if higher): ${price}`;
  $('th-now').title = `Now: ${price}, when last checked. At kickoff this becomes the closing price.`;
  $('lth-open').title = `The first price recorded for this selection: ${price}`;
  $('lth-best').title = `The highest price seen from when it first showed value to kickoff: ${price}`;
  $('lth-close').title = `The last price before kickoff: ${price}`;
  $('filters-summary').textContent = `${prefsSummary(prefs, modalKeys())} · ${BASES[prefs.basis].toLowerCase()}`;
}

function render() {
  const isLive = view === 'live';
  renderViewSwitch();
  renderTabs();
  $('bets-view').classList.toggle('hidden', isLive);
  $('live-view').classList.toggle('hidden', !isLive);
  $('risk-wrap').classList.toggle('hidden', isLive);
  $('bank-wrap').classList.toggle('hidden', isLive);
  $('basis-wrap').classList.toggle('hidden', !isLive);
  $('my-teams-wrap').classList.toggle('hidden', !hasAnyTeams());
  renderHeads();
  renderSportPills();
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
['odds-min', 'odds-max'].forEach(id => $(id).addEventListener('change', () => { savePrefs(); render(); }));
$('filters-btn').addEventListener('click', () => openFilters({
  prefs, keys: modalKeys(), counts: marketCounts(), opener: $('filters-btn'),
  onChange: next => {
    prefs = next;
    storePrefs(prefs);
    buildModel();   // the stakes follow the price basis
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
['sort-by', 'my-teams-only', 'odds-basis'].forEach(id =>
  $(id).addEventListener('change', () => { savePrefs(); render(); }));
window.addEventListener(MY_TEAMS_CHANGED, () => { if (!$('content').classList.contains('hidden')) render(); });

async function init() {
  let data;
  try {
    data = await api('best_bets');
  } catch {
    gateCard('Could not load Best Bets', 'Try again in a moment.');
    return;
  }
  if (!data) return;   // sign-in / restricted card is showing
  bets = data.rows;
  if (data.checked_at) {
    const mins = Math.max(0, Math.round((Date.now() - new Date(data.checked_at)) / 60000));
    const ago = mins < 60 ? `${mins} min` : mins < 2880 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
    $('updated').textContent = `Odds checked ${ago} ago`;
    $('updated').classList.remove('hidden');
  }
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
  loadResults();   // the track record fills in when it arrives
  loadStakes();    // and the Stake column
  loadLive();      // and the bets in play (the Live tab's count too)
  // The account's filters, where they differ from this browser's
  syncPrefs(prefs).then(remote => {
    if (!remote) return;
    prefs = remote;
    applyPrefs();
    buildModel();
    render();
  }).catch(() => {});
}

init();
