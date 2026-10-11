// best-bets.js — drives pages/best_bets.html.
//
// Model prices vs Betfair Exchange back prices, pre-computed off-site (the
// betfair-api repo) and served by /api/best_bets — this page never talks to
// Betfair. Access is per account: the API answers 401 (not signed in), 403
// (signed in, not granted) or the data, and the page shows a sign-in card, a
// "Restricted" card or the tables accordingly. The track-record sidebar aggregates the
// settled picks from /api/best_bets/results in the browser so the sport and
// minimum-edge and maximum-odds filters apply to the ROI numbers too. NFL / NHL
// scorers open the player's stats window (player-stats-modal.js) and show his
// team and how often he has scored (last 10 / last season / career, from the
// Multi Builder's game_player_logs) against the chance the bookie odds imply.
// The game links to that game's Multi Builder.
import { BACKEND, apiUrl } from './api-config.js';
import { getSession } from './supabase-client.js';
import { involvesMyTeam, hasAnyTeams, loadMyTeams, MY_TEAMS_CHANGED } from './my-teams.js';
import { openPlayerStats, STATS_SPORTS } from './player-stats-modal.js';

const TABS = [
  { key: 'match',   label: 'Match Lines', kinds: ['match_odds', 'handicap'] },
  { key: 'scorers', label: 'Scorers',     kinds: ['anytime_scorer', 'multi_scorer'] },
  { key: 'totals',  label: 'Totals',      kinds: ['total'] },
];
const SPORT_LABELS = { nrl: 'NRL', nrlw: 'NRLW', nfl: 'NFL', nhl: 'NHL' };
const SPORT_COLORS = { nrl: '#fbbf24', nrlw: '#e879f9', nfl: '#60a5fa', nhl: '#818cf8' };
// Edge (when first flagged) bands for the track-record sidebar.
const EDGE_BANDS = [[0, 0.02, '0–2%'], [0.02, 0.05, '2–5%'], [0.05, 0.1, '5–10%'], [0.1, 0.15, '10–15%'],
                    [0.15, 0.2, '15–20%'], [0.2, 0.3, '20–30%'], [0.3, Infinity, '30%+']];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const odds = o => o == null ? '–' : o.toFixed(o >= 10 ? 1 : 2);
const pct = (x, dp = 1) => x == null || !isFinite(x) ? '–' : `${(x * 100).toFixed(dp)}%`;
const signedPct = (x, dp = 1) => x == null || !isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(dp)}%`;
const signCls = x => x == null || !isFinite(x) || x === 0 ? 'text-gray-400' : x > 0 ? 'text-green-400' : 'text-red-400';

let token = null;
let bets = [];             // /api/best_bets rows
let shown = [];            // the rows in the table, in order (data-row indexes it)
let results = null;        // /api/best_bets/results, loaded on first open
let tab = 'match';
let sport = 'all';

// Sort / My Teams / NHL 3-way choices are remembered between visits.
const PREFS_KEY = 'bsm_best_bets_prefs';
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    $('sort-by').value = p.sort === 'time' ? 'time' : 'edge';
    $('my-teams-only').checked = !!p.myTeams;
    $('nhl-three-way').checked = !!p.threeWay;
  } catch { /* storage unavailable */ }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      sort: $('sort-by').value, myTeams: $('my-teams-only').checked, threeWay: $('nhl-three-way').checked }));
  } catch { /* storage unavailable */ }
}

// NHL head-to-head comes two ways: the moneyline (overtime and shootout
// count) and the 60-minute market with a draw. The moneyline is the default.
const isNhlThreeWay = r => r.sport === 'nhl' && r.market_kind === 'match_odds'
  && (r.three_way ?? /3 way|60 min/i.test(r.market_name));

// Sport / NHL 3-way / My Teams: shared by the table and the track record.
function passes(r) {
  return (sport === 'all' || r.sport === sport)
    && ($('nhl-three-way').checked || !isNhlThreeWay(r))
    && (!$('my-teams-only').checked || !hasAnyTeams() || involvesMyTeam(r.sport, r.home_team, r.away_team));
}

// Bookie odds under the Max odds choice (0 = any price).
const underMaxOdds = o => { const max = +$('max-odds').value; return !max || o < max; };

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

async function api(path) {
  const res = await fetch(`${BACKEND}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { showSignIn(); return null; }
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

// Betfair names the line in most runner names ("Roosters -4.5"); Asian-handicap
// style runners are just the team / Over / Under, so add it.
function selectionText(r) {
  let name = r.selection_name;
  if (r.line != null && (r.market_kind === 'handicap' || r.market_kind === 'total') && !/\d/.test(name)) {
    name += ` ${r.market_kind === 'handicap' && r.line > 0 ? '+' : ''}${r.line}`;
  }
  return name;
}

// Scorers with a stats window (the multi builders' player_detail endpoints).
const hasStats = r => r.player_id != null && STATS_SPORTS.includes(r.sport);

// --- scorer history -----------------------------------------------------------
// One /api/<sport>/game_player_logs per game on show, fetched as its rows
// first appear: {players: {id: {stat: {l10|prev|car: [[value, games], ...]}}},
// sides: {id: 'home'|'away'}, prev_season}.
const LOG_STAT = { nfl: 'td', nhl: 'goal' };
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
      logsPaint = setTimeout(renderBets, 60);
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

// How often he has hit this selection over his last 10 games, last season and
// his career: green above the chance the bookie odds imply, red below.
function historyHtml(r) {
  if (!hasStats(r)) return '';
  const data = logs.get(logsKey(r));
  if (data === undefined) return '<span class="bsm-skeleton h-3 w-40 block mt-1"></span>';
  const hist = data?.players?.[r.player_id]?.[LOG_STAT[r.sport]];
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
    const hit = g ? Math.round(histHit(h, r.line || 1) * 100) : null;
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
    ${historyHtml(r)}
  </td>`;
}

function renderTabs() {
  $('view-tabs').innerHTML = TABS.map(t => `
    <button type="button" data-tab="${t.key}" role="tab" aria-selected="${t.key === tab}"
            class="px-4 py-1.5 rounded-md text-sm transition-all ${t.key === tab
              ? 'bg-amber-400 text-gray-900 font-bold' : 'text-gray-400 font-semibold hover:text-gray-200'}">${t.label}</button>`).join('');
}

function renderSportPills() {
  const source = bets;
  const present = Object.keys(SPORT_LABELS).filter(s => source.some(r => r.sport === s));
  if (sport !== 'all' && !present.includes(sport)) sport = 'all';
  $('sport-pills').innerHTML = (present.length > 1 ? ['all', ...present] : []).map(s => `
    <button type="button" data-sport="${s}"
            class="px-2.5 py-1 rounded-full border text-xs font-semibold transition-colors ${s === sport
              ? 'border-amber-400 text-amber-400' : 'border-gray-700 text-gray-400 hover:text-gray-200'}">${s === 'all' ? 'All' : SPORT_LABELS[s]}</button>`).join('');
}

// --- current bets -----------------------------------------------------------

function betRow(r, i) {
  return `
    <tr class="group border-t border-gray-700/60 hover:bg-gray-700/20${hasStats(r) ? ' cursor-pointer' : ''}"${hasStats(r) ? ` data-row="${i}"` : ''}>
      ${gameCell(r)}${selectionCell(r)}
      <td class="px-2 py-2 text-right tabular-nums font-bold text-amber-400">${odds(r.back)}</td>
      <td class="hidden sm:table-cell px-2 py-2 text-right tabular-nums text-gray-300">${pct(r.model_prob)}</td>
      <td class="px-2 py-2 text-right tabular-nums text-gray-300">${odds(r.fair_odds)}</td>
      <td class="px-2 py-2 text-right tabular-nums font-bold text-green-400">${signedPct(r.edge)}</td>
    </tr>`;
}

function renderBets() {
  const kinds = TABS.find(t => t.key === tab).kinds;
  const byEdge = $('sort-by').value !== 'time';
  const inTab = bets.filter(r => kinds.includes(r.market_kind));
  const rows = inTab.filter(r => passes(r) && r.edge >= +$('min-edge').value && underMaxOdds(r.back));
  const body = $('bets-body');
  let summary = '';
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="px-2 py-8 text-center text-sm text-gray-500">${
      inTab.length ? 'No bets match these filters.' : 'No value found in these markets at the last check.'}</td></tr>`;
  } else {
    rows.sort((a, b) => byEdge ? b.edge - a.edge : byTime(a, b) || b.edge - a.edge);
    loadLogs(rows);
    body.innerHTML = rows.map(betRow).join('');
    summary = `${rows.length} selection${rows.length === 1 ? '' : 's'}`;
  }
  shown = rows;
  $('status').textContent = summary && `${summary} · sorted by ${byEdge ? 'edge' : 'start time'}`;
  $('method-note').textContent = tab === 'scorers'
    ? 'Bookie odds are the median price across US bookmakers, fetched once per game when the market first goes up — '
      + 'they will have moved, and local bookmakers will differ, so use them as a guide to where the value is. '
      + 'Scorer prices assume the player takes the field.'
    : 'Bookie odds are the best back price on the Betfair Exchange at the last check (delayed, and '
      + 'they will have moved) — use them as a guide to where the value is. Edge allows for Betfair commission.';
}

function openStats(r) {
  openPlayerStats({
    sport: r.sport, gameId: r.game_id, playerId: r.player_id,
    name: r.selection_name,
    team: teamOf(r), teams: { home: r.home_team, away: r.away_team },
    subtitle: `${SPORT_LABELS[r.sport]} · ${r.home_team} v ${r.away_team} · ${kickoffText(r.kickoff)}`,
    tiles: [
      { label: 'Bookie odds', value: odds(r.back), cls: 'text-amber-400' },
      { label: 'Model', value: pct(r.model_prob) },
      { label: 'Fair odds', value: odds(r.fair_odds) },
      { label: 'Edge', value: signedPct(r.edge), cls: signCls(r.edge) },
    ],
    note: `${selectionText(r)} — ${r.market_name}. Price assumes the player takes the field.`,
  });
}

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
    roi:      mean(p => profit(p, p.flagged_back)),
    roiBest:  mean(p => profit(p, p.best_back)),
    roiClose: mean(p => profit(p, p.close_back)),
    clv:      mean(p => p.flagged_back / p.close_back - 1),
  };
}

// One band: label, a bar growing left (loss) or right (profit) from a centre
// zero line, then the ROI and the number of bets behind it.
function roiBar(label, st, scale, dim) {
  const width = st.n ? Math.min(50, Math.abs(st.roi) / scale * 50) : 0;
  const up = st.roi >= 0;
  const bar = st.n ? `<span class="absolute top-0.5 bottom-0.5 ${up ? 'bg-green-500 rounded-r' : 'bg-red-500 rounded-l'}"
      style="${up ? 'left' : 'right'}:50%; width:${width.toFixed(1)}%; min-width:2px"></span>` : '';
  const title = st.n ? `${label} edge: ${signedPct(st.roi)} ROI over ${st.n} settled bet${st.n === 1 ? '' : 's'}` : `${label} edge: no settled bets yet`;
  return `<div class="flex items-center gap-2 text-xs ${dim ? 'opacity-40' : ''}" title="${esc(title)}">
    <span class="w-12 shrink-0 tabular-nums text-gray-400">${label}</span>
    <span class="relative flex-1 h-4">
      <span class="absolute inset-y-0 left-1/2 w-px bg-gray-600"></span>${bar}
    </span>
    <span class="w-14 shrink-0 text-right tabular-nums font-semibold text-gray-100">${st.n ? signedPct(st.roi, 0) : '–'}</span>
    <span class="w-7 shrink-0 text-right tabular-nums text-gray-500">${st.n || ''}</span>
  </div>`;
}

function renderTrackRecord() {
  const t = TABS.find(x => x.key === tab);
  const minEdge = +$('min-edge').value, maxOdds = +$('max-odds').value;
  $('roi-scope').textContent = `${t.label}${sport === 'all' ? '' : ' · ' + SPORT_LABELS[sport]}${maxOdds ? ` · odds under $${maxOdds}` : ''} · settled bets, 1 unit each at the odds when flagged`;
  if (!results) {
    $('roi-headline').innerHTML = '';
    $('roi-bars').innerHTML = resultsFailed ? '' : Array.from({ length: 7 }, () => '<span class="bsm-skeleton h-4 w-full block"></span>').join('');
    $('roi-note').textContent = resultsFailed ? 'Could not load results. Try again in a moment.' : '';
    return;
  }
  const picks = results.picks.filter(p => t.kinds.includes(p.market_kind) && passes(p) && underMaxOdds(p.flagged_back));
  const bands = EDGE_BANDS.map(([lo, hi, label]) => ({ lo, label, st: summarise(picks.filter(p => p.flagged_edge >= lo && p.flagged_edge < hi)) }));
  const sel = summarise(picks.filter(p => p.flagged_edge >= minEdge));
  const which = minEdge ? `at ${Math.round(minEdge * 100)}%+ edge` : 'all edges';

  $('roi-headline').innerHTML = sel.n ? `
    <div class="flex items-baseline gap-2">
      <span class="text-2xl font-bold tabular-nums text-gray-100">${signedPct(sel.roi)}</span>
      <span class="text-xs font-semibold ${signCls(sel.roi)}">${sel.roi > 0 ? 'profit' : sel.roi < 0 ? 'loss' : ''}</span>
    </div>
    <div class="text-[11px] text-gray-500">ROI ${which} · ${sel.n} bet${sel.n === 1 ? '' : 's'}</div>
    <div class="mt-1.5 text-[11px] text-gray-400 tabular-nums" title="The same bets at the best odds seen before kickoff (an upper bound) and at the last odds captured; CLV compares flagged odds with closing odds">
      best odds ${signedPct(sel.roiBest)} · closing ${signedPct(sel.roiClose)} · CLV ${signedPct(sel.clv)}</div>`
    : `<div class="text-xs text-gray-500">No settled bets ${which} yet.</div>`;

  const scale = Math.max(0.1, ...bands.filter(b => b.st.n).map(b => Math.abs(b.st.roi)));
  $('roi-bars').innerHTML = `
    <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
      <span class="w-12 shrink-0">Edge</span><span class="flex-1 text-center">loss · profit</span>
      <span class="w-14 shrink-0 text-right">ROI</span><span class="w-7 shrink-0 text-right">Bets</span>
    </div>` + bands.map(b => roiBar(b.label, b.st, scale, b.lo < minEdge && EDGE_BANDS.find(e => e[0] === b.lo)[1] <= minEdge)).join('');
  $('roi-note').textContent = `${results.pending.toLocaleString()} tracked bet${results.pending === 1 ? '' : 's'} awaiting a result. `
    + 'Bands below the minimum edge are dimmed. Settled from our own results data; voided bets excluded. Small samples swing a lot.';
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

function render() {
  renderTabs();
  $('my-teams-wrap').classList.toggle('hidden', !hasAnyTeams());
  $('three-way-wrap').classList.toggle('hidden', !bets.some(isNhlThreeWay));
  renderSportPills();
  renderBets();
  renderTrackRecord();
}

function setTab(next) {
  tab = next;
  const url = new URL(location.href);
  url.searchParams.set('tab', tab);
  history.replaceState(null, '', url);
  render();
}

$('view-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b && b.dataset.tab !== tab) setTab(b.dataset.tab);
});
$('sport-pills').addEventListener('click', e => {
  const b = e.target.closest('[data-sport]');
  if (b) { sport = b.dataset.sport; render(); }
});
$('min-edge').addEventListener('change', render);
$('max-odds').addEventListener('change', render);
$('bets-body').addEventListener('click', e => {
  if (e.target.closest('a')) return;   // the game's Multi Builder link
  const row = e.target.closest('tr[data-row]');
  if (row && shown[row.dataset.row]) openStats(shown[row.dataset.row]);
});
['sort-by', 'my-teams-only', 'nhl-three-way'].forEach(id =>
  $(id).addEventListener('change', () => { savePrefs(); render(); }));
window.addEventListener(MY_TEAMS_CHANGED, () => { if (!$('content').classList.contains('hidden')) render(); });

async function init() {
  const session = await getSession();
  if (!session) { showSignIn(); return; }
  token = session.access_token;
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
  loadPrefs();
  loadMyTeams();   // profile teams may arrive later; MY_TEAMS_CHANGED re-renders
  const wanted = new URLSearchParams(location.search).get('tab');
  tab = TABS.some(t => t.key === wanted) ? wanted : 'match';
  render();
  loadResults();   // the track record fills in when it arrives
}

init();
