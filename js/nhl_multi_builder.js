// nhl_multi_builder.js — drives nhl/pages/tryscorer_predictions.html ("Multi Builder")
// NHL counterpart to js/nfl_multi_builder.js (same layout: team cards with
// prices + steppers, line selectors, betslip). Games are paged by calendar date
// (NHL has no weeks).
//
// Lines (margin / total / team goals) filter nhl.game_sgm_bins joint score
// distributions (/api/nhl/game_sgm_bins_range). Player legs — N+ goals, N+
// assists and N+ points for any player, goalies included, and N+ shots on goal
// for skaters — come from /api/nhl/game_player_data (per-player goal / assist
// weights and shot inputs, see nrl-flask-backend/nhl_player_model.py) and are
// priced bin by bin against each team's goals, so they stay correlated with the
// lines (a goal is always a shot on goal; saved shots scale with team goals). A shootout winner's extra goal isn't scored by any player, so
// it is removed per bin (bin.so = share of the bin's sims decided by shootout).
// Selections are kept per game; the betslip multiplies across games.
import { apiUrl } from './api-config.js';
import { nhlLogoUrl } from './nhl-logos.js';
import { findPlayer, gameProbabilityOf, legShare, maxLegN, playerGoalDists, singleLegProb } from './nhl-sgm-engine.js';

const $ = id => document.getElementById(id);

const dateBadge      = $('week-badge');
const datePrevBtn    = $('week-prev');
const dateNextBtn    = $('week-next');
const gameSelect     = $('game-select');
const noGamesMsg     = $('no-games-msg');
const builderSection = $('builder-section');
const builderMatchup = $('builder-matchup');
const builderKickoff = $('builder-kickoff');
const teamsContainer = $('teams-container');
const marketTabs     = $('market-tabs');
const resultDiv      = $('result');
const resetMatchBtn  = $('reset-match-btn');
const resetAllBtn    = $('reset-all-btn');

const marginDirHome  = $('margin-dir-home');
const marginDirAway  = $('margin-dir-away');
const marginValSel   = $('margin-val');
const marginClearBtn = $('margin-clear');

let allGames       = [];   // every game in the window (selections can span dates)
let games          = [];   // games on the selected date
let dateKeys       = [];
let gamesByDate    = {};
let currentDateIdx = 0;
let currentGame    = null;
const binsCache    = {};   // game_id -> bins[] ({m, t, c, so})
const gameState    = {};   // game_id -> per-game selections, see newGameState()
let betslipExpanded = false;
let bookieOdds     = null;

const TOP_N = 13;   // skaters listed before "Show more" (all expected goalies always shown)
const EXCLUDED = ['out', 'ir', 'ltir', 'suspended'];

// Market tabs: the team cards show one market at a time, players ranked by its
// 1+ price. Picks in the other tabs stay on the betslip.
const MARKETS = [
  { kind: 'goal',   tab: 'Goals',         head: 'Goals' },
  { kind: 'assist', tab: 'Assists',       head: 'Assists' },
  { kind: 'point',  tab: 'Points',        head: 'Points' },
  { kind: 'sog',    tab: 'Shots on Goal', head: 'SOG' },
];
let market = 'goal';

function newGameState() {
  return {
    lines: { marginTeam: null, marginL: null, totalDir: null, totalN: null,
             homeTotalDir: null, homeTotalN: null, awayTotalDir: null, awayTotalN: null },
    picks: new Map(),          // key -> { side, kind, playerId, teamId, name, n }
    out: new Set(), in: new Set(),
    showAll: {},               // `${market}:${side}` -> "Show more" expanded
    playerData: null,          // /api/nhl/game_player_data for this game's overrides
    teamDists: null,           // { home: [P(n player goals)], away: [...] } — from the bins
    loadSeq: 0,
  };
}
const S = (gid = currentGame?.game_id) => (gameState[gid] ||= newGameState());
const gameById = gid => allGames.find(g => String(g.game_id) === String(gid));

// --- FORMATTING ---
const pct  = p => (p == null ? '–' : `${(p * 100).toFixed(1)}%`);
const odds = p => (p > 1e-6 ? (p < 0.001 ? '$1000+' : `$${(1 / p).toFixed(2)}`) : '–');   // goalie goals are ~1 in 1500
const esc  = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const mmss = sec => (sec == null ? '–' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);
const minFmt = min => (min == null ? '–' : mmss(Math.round(min * 60)));
const pctInt = v => (v == null ? '–' : `${Math.round(v * 100)}%`);
const pct1 = v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
const POS_LABEL = { C: 'C', L: 'LW', R: 'RW', D: 'D', G: 'G' };

function lineLabels(game, L) {
  const out = [];
  if (L.marginTeam && L.marginL != null) {
    const team = L.marginTeam === 'home' ? game.home_team : game.away_team;
    out.push(L.marginL === -0.5 ? `${team} To Win` : `${team} ${L.marginL < 0 ? '' : '+'}${L.marginL}`);
  }
  if (L.totalDir && L.totalN != null) out.push(`Total Goals ${L.totalDir === 'over' ? 'Over' : 'Under'} ${L.totalN - 0.5}`);
  if (L.homeTotalDir && L.homeTotalN != null) out.push(`${game.home_team} ${L.homeTotalDir === 'over' ? 'Over' : 'Under'} ${L.homeTotalN - 0.5}`);
  if (L.awayTotalDir && L.awayTotalN != null) out.push(`${game.away_team} ${L.awayTotalDir === 'over' ? 'Over' : 'Under'} ${L.awayTotalN - 0.5}`);
  return out;
}

function legLabel(kind, name, n) {
  if (kind === 'goal') return n === 1 ? `${name} Anytime Goal` : `${name} ${n}+ Goals`;
  if (kind === 'point') return `${name} ${n}+ Point${n > 1 ? 's' : ''}`;
  if (kind === 'sog') return `${name} ${n}+ Shot${n > 1 ? 's' : ''} on Goal`;
  return `${name} ${n}+ Assist${n > 1 ? 's' : ''}`;
}

// Joint probability of one game's line filters + player legs, bin by bin
// (nhl-sgm-engine.js gameProbabilityOf).
function gameProbability(gid) {
  return gameProbabilityOf(S(gid), binsCache[gid]);
}

function gameHasSelections(gid) {
  const gs = gameState[gid];
  return !!gs && (gs.picks.size > 0 || lineLabels(gameById(gid) || {}, gs.lines).length > 0);
}

// =============================================================================
// TEAM CARDS
// =============================================================================
const STATUS_BADGE = {
  'day-to-day': ['DTD', 'text-yellow-300 border-yellow-500/40 bg-yellow-500/10', 'Day-to-day'],
  out:          ['OUT', 'text-red-300 border-red-500/40 bg-red-500/10', 'Out'],
  ir:           ['IR', 'text-red-300 border-red-500/40 bg-red-500/10', 'Injured reserve'],
  ltir:         ['LTIR', 'text-red-300 border-red-500/40 bg-red-500/10', 'Long-term injured reserve'],
  suspended:    ['SUSP', 'text-red-300 border-red-500/40 bg-red-500/10', 'Suspended'],
};

function stepperHtml(key, val, max) {
  const base = 'w-6 h-6 border rounded flex items-center justify-center text-sm font-bold transition-colors';
  const minus = val > 0 ? `${base} border-red-500 text-red-400 hover:bg-red-500/20` : `${base} border-gray-700 text-gray-600`;
  const plus = val >= max ? `${base} border-gray-700 text-gray-600`
    : val > 0 ? `${base} border-green-500 text-green-400 hover:bg-green-500/20`
              : `${base} border-gray-600 text-gray-400 hover:border-green-400 hover:text-green-400`;
  return `
    <div class="flex items-center gap-0.5 shrink-0">
      <button type="button" class="${minus}" data-step="-1" data-key="${key}">−</button>
      <span class="w-5 text-center text-sm font-bold text-white select-none">${val}</span>
      <button type="button" class="${plus}" data-step="1" data-key="${key}">+</button>
    </div>`;
}

// Price column for the active market: the picked N+ (1+ when unpicked).
function priceHtml(gs, side, kind, pl, val) {
  const p = singleLegProb(gs, side, kind, pl, Math.max(1, val));
  if (p == null) {
    return binsCache[currentGame?.game_id] === undefined
      ? '<span class="bsm-skeleton h-3 w-14 ml-auto block"></span>'
      : '<div class="text-xs font-semibold text-gray-400">–</div>';
  }
  return `<div class="text-xs font-semibold text-gray-300">${pct(p)}</div><div class="text-xs text-gray-400">${odds(p)}</div>`;
}

function statusBadge(pl) {
  const b = STATUS_BADGE[pl.status];
  if (!b) return '';
  const title = [b[2], pl.status_detail].filter(Boolean).join(' — ');
  return `<span class="shrink-0 px-1 rounded border text-[10px] font-bold ${b[1]}" title="${esc(title)}">${b[0]}</span>`;
}

// "C · L1 · PP1": position (flagging a recent move) and deployment read off the
// last game's ice time — the NHL publishes no line combinations.
function roleLabel(pl) {
  const pos = POS_LABEL[pl.pos] || pl.pos;
  const recent = POS_LABEL[pl.recent_pos] || pl.recent_pos;
  const parts = [recent && recent !== pos ? `${pos}→${recent}` : pos];
  if (pl.pos !== 'G' && pl.line) parts.push(`${pl.pos === 'D' ? 'P' : 'L'}${pl.line}`);
  if (pl.pp_unit) parts.push(`PP${pl.pp_unit}`);
  return parts.join(' · ');
}
const roleTitle = pl => {
  const bits = [];
  if (pl.recent_pos && pl.recent_pos !== pl.pos) bits.push(`Listed ${POS_LABEL[pl.pos] || pl.pos}, mostly played ${POS_LABEL[pl.recent_pos] || pl.recent_pos} over the last 5`);
  if (pl.line) bits.push(`${pl.pos === 'D' ? 'Pair' : 'Line'} ${pl.line} by even-strength ice time last game`);
  if (pl.pp_unit) bits.push(`PP unit ${pl.pp_unit} by power-play ice time last game`);
  return bits.join('. ');
};

// Last-5 form: one box per game played, newest first. Missing games (fewer than
// 5 played) are dashed. Fixed width so the strips line up from row to row.
function formStrip(counts = [], labels = [], unit = 'goal', tag = 'G') {
  const base = 'flex items-center justify-center h-4 rounded-sm text-[10px] font-semibold';
  const boxes = [];
  for (let i = 0; i < 5; i++) {
    const n = counts?.[i];
    if (n == null) { boxes.push(`<span class="${base} border border-dashed border-gray-700"></span>`); continue; }
    const tip = `${labels?.[i] || 'Game'}: ${n} ${unit}${n === 1 ? '' : 's'}`;
    boxes.push(`<span class="${base} ${n > 0 ? 'bg-green-500/20 text-green-300' : 'bg-gray-700/50 text-gray-400'}" title="${esc(tip)}">${n}</span>`);
  }
  return `<span class="flex items-center gap-[3px] w-[5.75rem] shrink-0"><span class="w-2 shrink-0 text-center" title="${unit[0].toUpperCase() + unit.slice(1)}s in the last 5 games played, newest first">${tag}</span>
    <span class="grid grid-cols-5 gap-px flex-1">${boxes.join('')}</span></span>`;
}

// Fixed-width lead cell (TOI / start chance) so every row's strips start in the same place
const metaLead = html => `<span class="w-[3.75rem] shrink-0 whitespace-nowrap overflow-hidden">${html}</span>`;

// Form strips relevant to each market tab
const MARKET_STRIPS = { goal: ['G'], assist: ['A'], point: ['P'], sog: ['S'] };

function playerMeta(pl, kind) {
  const s = pl.stats || {};
  let lead;
  if (pl.pos === 'G') {
    lead = `<span title="Chance to start, from recent starts (and back-to-backs). Prices assume he starts.">Start</span> <span class="text-gray-300 font-semibold">${pctInt(pl.start_prob)}</span>`;
  } else {
    const tip = pl.active && pl.toi_proj != null
      ? `Projected ice time: ${minFmt(pl.ev_toi_proj)} even strength, ${minFmt(pl.pp_toi_proj)} power play, ${minFmt(pl.sh_toi_proj)} short-handed`
      : 'Projected ice time';
    lead = `<span title="${esc(tip)}">TOI <span class="text-gray-300 font-semibold">${pl.active ? minFmt(pl.toi_proj) : '–'}</span></span>`;
  }
  const strip = {
    G: () => formStrip(s.recent_goals, s.recent_games, 'goal', 'G'),
    A: () => formStrip(s.recent_assists, s.recent_games, 'assist', 'A'),
    P: () => formStrip(s.recent_points, s.recent_games, 'point', 'P'),
    S: () => (pl.pos !== 'G' ? formStrip(s.recent_sog, s.recent_games, 'shot', 'S') : ''),
  };
  return metaLead(lead) + MARKET_STRIPS[kind].map(t => strip[t]()).join('');
}

function availButton(pl, forcedStarter = false) {
  if (pl.pos === 'G' && pl.active) {
    return forcedStarter
      ? `<button type="button" data-avail="${pl.id}" data-make="auto" title="Back to the model's start chances"
                 class="text-[10px] text-gray-400 hover:text-gray-300">↺ auto</button>`
      : `<button type="button" data-avail="${pl.id}" data-make="start" title="Set as tonight's starter"
                 class="text-[10px] text-blue-400 hover:text-blue-300">★ starts</button>`;
  }
  return pl.active
    ? `<button type="button" data-avail="${pl.id}" data-make="out" title="Mark as not playing — redistributes their ice time"
               class="text-[10px] text-gray-400 hover:text-red-400">✕ out</button>`
    : `<button type="button" data-avail="${pl.id}" data-make="in" title="Mark as playing"
               class="text-[10px] text-blue-400 hover:text-blue-300">+ in</button>`;
}

// --- history under each row: per-game average over the last 10 games played,
// the previous season and his career; with a pick, also how often he reached it. Values come as {window: [[value, games], ...]}.
const logsCache = {};   // game_id -> /api/nhl/game_player_logs (undefined = loading, null = failed)
const LOG_TAG = { goal: 'G', assist: 'A', point: 'P', sog: 'SOG' };

const histGames = h => h.reduce((s, [, n]) => s + n, 0);
const histAvg = h => h.reduce((s, [v, n]) => s + v * n, 0) / histGames(h);
const histHit = (h, line) => h.reduce((s, [v, n]) => s + (v >= line ? n : 0), 0) / histGames(h);
const seasonName2 = y => `${String(y).slice(2)}-${String(y + 1).slice(2)}`;

// Model's per-game expectation for a market if he plays — the yardstick the
// history averages are coloured against: team player-goals × his share
// (a point is a goal or an assist), or his projected shots on goal.
function modelMean(gs, side, kind, pl) {
  if (kind === 'sog') return pl.sog_mean ?? null;
  const e = expectedGoals(gs, side);
  return e == null ? null : e * legShare(kind, pl);
}

// Green / red: history above / below the model by more than a small neutral
// band (HIST_BAND), compared at the shown precision.
const HIST_BAND = { avg: 0.05, hit: 3 };   // averages / medians: ±5% of the model; hit rates: ±3 points
function vsModel(shown, model, tol) {
  if (model == null || Math.abs(shown - model) <= tol) return 'text-gray-200';
  return shown > model ? 'text-green-400' : 'text-red-400';
}

// model: { avg, hit } — the model's per-game mean and its chance for the picked line
function historyHtml(kind, id, line, model = {}) {
  const logs = logsCache[currentGame?.game_id];
  if (logs === undefined) return '<span class="bsm-skeleton h-3 w-full block"></span>';
  const hist = logs?.players?.[id]?.[kind];
  if (!hist) return '';
  const wins = [
    ['l10', g => `L${g}`, 'Last games played (up to 10)'],
    ['prev', () => seasonName2(logs.prev_season), `${seasonName2(logs.prev_season)} season, playoffs included`],
    ['car', () => 'Career', 'Every NHL game of his career, playoffs included'],
  ];
  // value(h) -> number at display precision; text(v) -> label
  const cell = (w, value, text, modelV, modelText, tol) => {
    const h = hist[w[0]] || [], g = histGames(h);
    const v = g ? value(h) : null;
    const body = g ? `<span class="${vsModel(v, modelV, tol)} font-semibold">${text(v)}</span>` : '–';
    const tip = `${w[2]}: ${g} game${g === 1 ? '' : 's'}${modelV != null ? ` · model ${modelText}` : ''}`;
    return `<span class="whitespace-nowrap truncate" title="${esc(tip)}">${w[1](Math.min(g, 10))} ${body}</span>`;
  };
  const round2 = x => Math.round(x * 100) / 100;
  const mAvg = model.avg != null ? round2(model.avg) : null;
  const mHit = model.hit != null ? Math.round(model.hit * 100) : null;
  return `
    <div class="grid grid-cols-[4.25rem_repeat(3,minmax(0,1fr))] gap-x-1.5 gap-y-1 text-[11px] text-gray-400 leading-none">
      <span>Avg ${LOG_TAG[kind]}</span>${wins.map(w => cell(w, h => round2(histAvg(h)), v => v.toFixed(2),
                                                   mAvg, mAvg?.toFixed(2), Math.abs(mAvg) * HIST_BAND.avg)).join('')}
      ${line > 0 ? `<span class="text-green-300/90 whitespace-nowrap">${line}+ ${LOG_TAG[kind]} hit</span>${wins.map(w => cell(w,
        h => Math.round(histHit(h, line) * 100), v => `${v}%`, mHit, `${mHit}%`, HIST_BAND.hit)).join('')}` : ''}
    </div>`;
}

async function loadLogs(gid) {
  if (gid in logsCache) return;
  logsCache[gid] = undefined;
  let data = null;
  try {
    const res = await fetch(apiUrl('nhl', `game_player_logs/${gid}`));
    data = res.ok ? await res.json() : null;
  } catch { /* leave null */ }
  logsCache[gid] = data;
  if (String(currentGame?.game_id) === String(gid)) renderTeams();
}

// One player in the active market: name / price / stepper, then a full-width
// stats line (TOI or start chance, the market's last-5 form, availability).
function playerRow(gs, side, pl, kind) {
  const key = `${side}:${kind}:${pl.id}`;
  const val = gs.picks.get(key)?.n || 0;
  const badges = statusBadge(pl)
    + (pl.overridden ? '<span class="shrink-0 text-[10px] text-blue-300">manual</span>' : '')
    + (pl.pos !== 'G' && !pl.expected
      ? `<span class="shrink-0 text-[10px] text-gray-400" title="Dresses in about ${Math.round((pl.p_play ?? 0) * 100)}% of games on recent form — price assumes he plays">unlikely</span>` : '');
  return `
    <div class="group grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1.5 py-2 px-1 player-row cursor-pointer hover:bg-gray-700/25${val > 0 ? ' bg-gray-700/40' : ''}"
         data-detail="${side}:${pl.id}">
      <div class="min-w-0 flex items-center gap-1">
        <span class="text-sm truncate group-hover:underline decoration-gray-500 decoration-dotted underline-offset-2">${esc(pl.name)}</span>
        <span class="text-xs text-gray-400 min-w-0 truncate shrink-[3]" title="${esc(roleTitle(pl))}">(${roleLabel(pl)})</span>${badges}
      </div>
      <div class="w-16 text-right">${priceHtml(gs, side, kind, pl, val)}</div>
      ${stepperHtml(key, val, maxLegN(gs, side, kind))}
      <div class="col-span-3 flex items-center gap-2 text-[11px] text-gray-400 leading-none">
        ${playerMeta(pl, kind)}<span class="ml-auto shrink-0 pl-1">${availButton(pl, gs.in.has(pl.id))}</span>
      </div>
      <div class="col-span-3">${historyHtml(kind, pl.id, val, {
        avg: modelMean(gs, side, kind, pl), hit: val > 0 ? singleLegProb(gs, side, kind, pl, val) : null })}</div>
    </div>`;
}

function ruledOutRow(side, pl) {
  return `
    <div class="flex items-center gap-1 py-2 px-1 opacity-60 cursor-pointer hover:bg-gray-700/25" data-detail="${side}:${pl.id}">
      <span class="text-sm line-through truncate">${esc(pl.name)}</span>
      <span class="text-xs text-gray-400 shrink-0">(${POS_LABEL[pl.pos] || pl.pos})</span>${statusBadge(pl)}
      <span class="ml-auto shrink-0">${availButton(pl)}</span>
    </div>`;
}

// Mean of the team's player-goal distribution (shootout winner's goal excluded)
function expectedGoals(gs, side) {
  const arr = gs.teamDists?.[side];
  if (arr?.length) return arr.reduce((s, p, n) => s + n * p, 0);
  const d = gs.playerData?.[side]?.goal_dist;
  if (d) return Object.entries(d).reduce((s, [n, p]) => s + Number(n) * p, 0);
  return null;
}

const sectionLabel = (title, head) => `
  <div class="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider mt-3 mb-0.5 px-1">
    <span class="flex-1">${title}</span>
    <span class="w-16 text-right">Chance</span>
    <span class="w-[4.5rem] text-center">${head}</span>
  </div>`;

const MARKET_NOTE = {
  goal: 'Team goals are split by projected ice time × goal rates per 60.',
  assist: 'Assists on team goals are split by projected ice time × assist rates per 60.',
  point: 'A point is a goal or an assist on a team goal.',
  sog: 'Shots on goal = his goals plus saved shots around expected goals ÷ shooting %.',
};

function renderTeamCard(game, side) {
  const gs = S(game.game_id);
  const team = gs.playerData?.[side];
  const teamName = side === 'home' ? game.home_team : game.away_team;
  const card = document.createElement('div');
  card.className = 'bg-gray-800 border border-gray-700 rounded-xl p-4 w-full md:w-96 shadow-md';

  let body;
  if (!gs.playerData) {
    body = '<div class="py-6 text-center"><span class="bsm-skeleton h-3 w-32 inline-block"></span></div>';
  } else if (!team?.players?.length) {
    body = '<p class="py-4 text-sm text-gray-400 text-center">No player data for this team yet.</p>';
  } else {
    // Skaters ranked by the active market's 1+ chance (shares break ties before
    // the bins load). The default list is drawn from players expected to dress;
    // anyone picked in this market always stays visible.
    const kind = market;
    const mk = MARKETS.find(m => m.kind === kind);
    const isPicked = pl => gs.picks.has(`${side}:${kind}:${pl.id}`);
    const chance = new Map(team.players.map(pl => [pl, singleLegProb(gs, side, kind, pl, 1) ?? -1]));
    const byChance = (a, b) => (chance.get(b) - chance.get(a))
      || ((b.goal_share + 0.5 * b.assist_share) - (a.goal_share + 0.5 * a.assist_share));
    const skaters = team.players.filter(pl => pl.group !== 'G' && pl.active).sort(byChance);
    const top = skaters.filter(pl => pl.expected).slice(0, TOP_N);
    const shown = skaters.filter(pl => top.includes(pl) || isPicked(pl));
    const hidden = skaters.filter(pl => !shown.includes(pl));
    // Goalies don't take shots on goal; elsewhere the expected starters are listed
    // (with the start toggle) under the skaters.
    let shownG = [];
    if (kind !== 'sog') {
      const goalies = team.players.filter(pl => pl.group === 'G' && pl.active)
        .sort((a, b) => (b.start_prob ?? 0) - (a.start_prob ?? 0));
      shownG = goalies.filter(pl => pl.expected || isPicked(pl));
      hidden.push(...goalies.filter(pl => !shownG.includes(pl)));
    }
    const ruledOut = team.players.filter(pl => !pl.active);

    const rows = list => `<div class="flex flex-col divide-y divide-gray-700/50">${list.map(pl => playerRow(gs, side, pl, kind)).join('')}</div>`;
    const showKey = `${kind}:${side}`;
    const showAll = gs.showAll[showKey];
    const moreCount = hidden.length + ruledOut.length;
    const ast = team.assist_dist || [];
    body = `
      ${sectionLabel('Skaters', mk.head)}${rows(shown)}
      ${shownG.length ? `${sectionLabel('Goalies', mk.head)}${rows(shownG)}` : ''}
      ${moreCount ? `
        <button type="button" data-showall="${showKey}"
                class="w-full mt-1 px-2 py-1.5 text-xs text-gray-400 hover:text-gray-300 text-left">
          ${showAll ? '▾ Hide' : '▸ Show'} ${moreCount} more (lower chance, unlikely to dress or ruled out)
        </button>
        ${showAll ? `<div class="flex flex-col divide-y divide-gray-700/50">
          ${hidden.map(pl => playerRow(gs, side, pl, kind)).join('')}${ruledOut.map(pl => ruledOutRow(side, pl)).join('')}</div>` : ''}` : ''}
      <p class="mt-3 text-[11px] text-gray-400 leading-snug">
        Prices assume the player dresses (goalies: starts) — bets on players who don't are void.
        ${MARKET_NOTE[kind]}
        ${kind === 'assist' || kind === 'point' ? (ast.length ? `Assists per goal: ${pctInt(ast[2])} two, ${pctInt(ast[1])} one, ${pctInt(ast[0])} none.` : '') : ''}
        Tap a player for stats.
        ${team.played_yesterday ? ' <span class="text-amber-400/80">Played last night (back-to-back).</span>' : ''}
      </p>`;
  }

  const xg = expectedGoals(gs, side);
  card.innerHTML = `
    <div class="flex items-center justify-between mb-1">
      <div class="flex items-center gap-2 min-w-0">
        <img src="${nhlLogoUrl(teamName)}" class="w-8 h-8 object-contain shrink-0" alt="" onerror="this.style.display='none'">
        <div class="min-w-0">
          <div class="font-bold text-base truncate">${esc(teamName)}</div>
          <div class="text-xs text-gray-400" title="Mean goals scored by players (excludes a shootout winner's extra goal)">Expected goals:
            <span class="font-semibold text-amber-400">${xg != null ? xg.toFixed(2) : '–'}</span></div>
        </div>
      </div>
      <button type="button" data-clear="${side}" class="text-xs text-gray-400 hover:text-white border border-gray-600 hover:border-gray-400 px-2 py-1 rounded transition-colors">Clear</button>
    </div>
    ${body}`;
  return card;
}

// Tab bar; each tab counts this game's picks in its market, since those rows
// are hidden while another tab is open.
function renderTabs() {
  const picks = [...S().picks.values()];
  marketTabs.innerHTML = MARKETS.map(m => {
    const on = m.kind === market;
    const n = picks.filter(p => p.kind === m.kind).length;
    return `
      <button type="button" role="tab" aria-selected="${on}" data-market="${m.kind}"
              class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-semibold whitespace-nowrap transition-colors
                     ${on ? 'bg-blue-500 border-blue-500 text-white' : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-blue-400 hover:text-white'}">
        ${m.tab}${n ? `<span class="min-w-[1.25rem] px-1 rounded-full text-[11px] leading-5 text-center ${on ? 'bg-white/25 text-white' : 'bg-green-500/20 text-green-300'}">${n}</span>` : ''}
      </button>`;
  }).join('');
}

marketTabs.addEventListener('click', e => {
  const tab = e.target.closest('[data-market]');
  if (!tab || tab.dataset.market === market) return;
  market = tab.dataset.market;
  renderTeams();
});

function renderTeams() {
  if (!currentGame) return;
  renderTabs();
  teamsContainer.innerHTML = '';
  teamsContainer.appendChild(renderTeamCard(currentGame, 'home'));
  teamsContainer.appendChild(renderTeamCard(currentGame, 'away'));
}

teamsContainer.addEventListener('click', e => {
  if (!currentGame) return;
  const gs = S();
  const step = e.target.closest('[data-step]');
  if (step) {
    const key = step.dataset.key;
    const [side, kind, id] = key.split(':');
    const cur = gs.picks.get(key)?.n || 0;
    const n = Math.max(0, Math.min(maxLegN(gs, side, kind), cur + Number(step.dataset.step)));
    if (n === 0) {
      gs.picks.delete(key);
    } else {
      const pl = findPlayer(gs, side, id);
      if (!pl) return;
      gs.picks.set(key, { side, kind, n, playerId: pl.id, teamId: gs.playerData[side].team_id, name: pl.name });
    }
    renderTeams();
    recalculate();
    return;
  }
  const clear = e.target.closest('[data-clear]');
  if (clear) {
    for (const [k, p] of gs.picks) if (p.side === clear.dataset.clear) gs.picks.delete(k);
    renderTeams();
    recalculate();
    return;
  }
  const showAll = e.target.closest('[data-showall]');
  if (showAll) {
    gs.showAll[showAll.dataset.showall] = !gs.showAll[showAll.dataset.showall];   // key: `${market}:${side}`
    renderTeams();
    return;
  }
  const avail = e.target.closest('[data-avail]');
  if (avail) {
    const id = Number(avail.dataset.avail);
    const make = avail.dataset.make;
    const side = findPlayer(gs, 'home', id) ? 'home' : 'away';
    const pl = findPlayer(gs, side, id);
    gs.out.delete(id); gs.in.delete(id);
    if (make === 'auto') {
      // overrides already cleared above
    } else if (make === 'start') {
      // One starter per team: clear any other forced goalie on this side
      for (const g of gs.playerData[side].players.filter(p => p.pos === 'G')) gs.in.delete(g.id);
      gs.in.add(id);
    } else {
      const syncedActive = !EXCLUDED.includes(pl?.status);
      const makeIn = make === 'in';
      if (makeIn !== syncedActive) (makeIn ? gs.in : gs.out).add(id);
    }
    loadPlayerData(currentGame.game_id);
    return;
  }
  const detail = e.target.closest('[data-detail]');
  if (detail && !e.target.closest('button')) {
    const [side, id] = detail.dataset.detail.split(':');
    openDetail(side, id);
  }
});

// =============================================================================
// STATS WINDOW (last 5 games, recent / season averages, season totals and
// shares of team scoring from /api/nhl/player_detail; model numbers come from
// game_player_data)
// =============================================================================
const detailModal = document.createElement('div');
detailModal.className = 'fixed inset-0 hidden items-end sm:items-center justify-center bg-black/60 sm:p-4';
detailModal.style.zIndex = '1200';   // above the site header (1100) and betslip
detailModal.innerHTML = `
  <div role="dialog" aria-modal="true" aria-labelledby="nhl-detail-title"
       class="bg-gray-800 border border-gray-700 w-full sm:max-w-2xl max-h-[88vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-2xl p-4"></div>`;
document.body.appendChild(detailModal);
const detailPanel = detailModal.firstElementChild;
const detailCache = new Map();   // url -> response
let detailSeq = 0;

function closeDetail() {
  detailSeq++;
  detailModal.classList.add('hidden');
  detailModal.classList.remove('flex');
  document.body.style.overflow = '';
}
detailModal.addEventListener('click', e => {
  if (e.target === detailModal || e.target.closest('[data-close-detail]')) closeDetail();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !detailModal.classList.contains('hidden')) closeDetail();
});

// Table with fixed lead columns (game / season ...) then grouped stat columns.
// flat: one header row, no group labels.
function groupedTable(lead, groups, rows, { flat = false } = {}) {
  const th = 'px-1.5 py-1 font-semibold text-gray-400 text-center whitespace-nowrap';
  const sep = 'border-l border-gray-700';
  const twoRows = !flat && groups.length > 0;
  const leadHead = lead.map(c => `<th ${twoRows ? 'rowspan="2"' : ''} class="${th} ${c.left ? 'text-left' : ''} align-bottom">${c.h}</th>`).join('');
  const groupHead = groups.map(g => `<th colspan="${g.cols.length}" class="${th} ${sep} text-[10px] uppercase tracking-wider">${g.label || ''}</th>`).join('');
  const subHead = groups.map(g => g.cols.map((c, i) => `<th class="${th}${i ? '' : ` ${sep}`}"${c.title ? ` title="${esc(c.title)}"` : ''}>${c.h}</th>`).join('')).join('');
  const cell = (c, r, i) => {
    const v = r[c.k];
    const txt = c.fmt ? c.fmt(v, r) : (v ?? 0);
    const tone = c.hi && v > 0 ? 'text-green-400 font-semibold' : v ? 'text-gray-200' : 'text-gray-400';
    return `<td class="px-1.5 py-1.5 text-center tabular-nums ${tone}${i ? '' : ' border-l border-gray-700/60'}">${txt}</td>`;
  };
  const body = rows.map(r => `
    <tr class="border-t border-gray-700/60">
      ${lead.map(c => `<td class="px-1.5 py-1.5 whitespace-nowrap ${c.left ? 'text-left' : 'text-center tabular-nums text-gray-200'}">${c.cell(r)}</td>`).join('')}
      ${groups.map(g => g.cols.map((c, i) => cell(c, r, i)).join('')).join('')}
    </tr>`).join('');
  return `
    <div class="overflow-x-auto -mx-1">
      <table class="w-full text-xs">
        <thead>${twoRows ? `<tr>${leadHead}${groupHead}</tr><tr>${subHead}</tr>` : `<tr>${leadHead}${subHead}</tr>`}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

const detailTile = (label, value, sub = '') => `
  <div class="bg-gray-900/60 border border-gray-700 rounded-lg px-2 py-2 text-center min-w-0">
    <div class="text-[10px] uppercase tracking-wider text-gray-400 leading-tight">${label}</div>
    <div class="text-base font-bold text-white mt-0.5">${value}</div>
    ${sub ? `<div class="text-[11px] text-gray-400">${sub}</div>` : ''}
  </div>`;
const tileGrid = tiles => `<div class="grid gap-2 grid-cols-2 sm:grid-cols-4">${tiles.join('')}</div>`;
const probTile = (label, p) => detailTile(label, p > 1e-6 ? odds(p) : '–', p > 1e-6 ? pct(p) : '');
const sectionHead = (title, note = '') => `
  <div class="flex items-baseline justify-between gap-2 mt-5 mb-1">
    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">${title}</h3>
    ${note ? `<span class="text-[11px] text-gray-400">${note}</span>` : ''}
  </div>`;

const num2 = v => (v == null ? '–' : Number(v).toFixed(2));
const signed = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${Number.isInteger(v) ? v : Number(v).toFixed(2)}`);
const svp = v => (v == null ? '–' : Number(v).toFixed(3).replace(/^0/, ''));

const gameLead = { h: 'Game', left: true, cell: g => `<span class="text-gray-300">${esc(g.label)}</span>` };
const roleLead = { h: 'Pos', cell: g => {
  const pos = POS_LABEL[g.pos] || g.pos || '–';
  return g.role ? `<span title="Position · line (by EV ice time) · PP unit">${pos} <span class="text-gray-400">${esc(g.role)}</span></span>` : pos;
} };
const seasonName = s => `${s}-${String(s + 1).slice(2)}`;

// Skater column groups
const SK_GAME_GROUPS = [
  { label: 'Ice time', cols: [{ k: 'toi_s', h: 'TOI', fmt: mmss }, { k: 'pp_toi_s', h: 'PP', fmt: mmss, title: 'Power-play ice time' }] },
  { label: 'Scoring', cols: [{ k: 'sog', h: 'SOG', title: 'Shots on goal' }, { k: 'goals', h: 'G', hi: true }, { k: 'assists', h: 'A', hi: true },
                             { k: 'plus_minus', h: '+/-', fmt: signed }] },
  { label: 'Power play', cols: [{ k: 'pp_goals', h: 'PPG', hi: true }, { k: 'pp_assists', h: 'PPA', hi: true }] },
];
const SK_AVG_GROUPS = [
  { label: 'Per game', cols: [{ k: 'toi_s', h: 'TOI', fmt: mmss }, { k: 'pp_toi_s', h: 'PP', fmt: mmss },
                              { k: 'sog', h: 'SOG', fmt: num2 }, { k: 'goals', h: 'G', fmt: num2 }, { k: 'assists', h: 'A', fmt: num2 },
                              { k: 'pp_points', h: 'PPP', fmt: num2, title: 'Power-play points' }, { k: 'plus_minus', h: '+/-', fmt: signed }] },
  { label: 'Rates', cols: [{ k: 'sh_pct', h: 'Sh%', fmt: pct1, title: 'Shooting % (goals / shots on goal)' },
                           { k: 'g60', h: 'G/60', fmt: num2 }, { k: 'a60', h: 'A/60', fmt: num2 }] },
];
const SK_SEASON_GROUPS = [
  { label: 'Totals', cols: [{ k: 'goals', h: 'G', hi: true }, { k: 'assists', h: 'A', hi: true }, { k: 'points', h: 'P' },
                            { k: 'sog', h: 'SOG' }, { k: 'sh_pct', h: 'Sh%', fmt: pct1 }, { k: 'plus_minus', h: '+/-', fmt: signed }] },
  { label: 'Power play', cols: [{ k: 'pp_goals', h: 'PPG' }, { k: 'pp_assists', h: 'PPA' }] },
];
const SK_SHARE_COLS = [
  { k: 'goal_share', h: 'Goals', fmt: pct1, title: 'Share of the team\'s goals in games he played' },
  { k: 'assist_share', h: 'Assists', fmt: pct1, title: 'Share of the team\'s goals he assisted' },
  { k: 'point_share', h: 'Points', fmt: pct1, title: 'Share of the team\'s goals he scored or assisted' },
  { k: 'pp_goal_share', h: 'PP goals', fmt: pct1 },
  { k: 'pp_point_share', h: 'PP pts', fmt: pct1, title: 'Share of the team\'s power-play goals he scored or assisted' },
  { k: 'pp_toi_share', h: 'PP time', fmt: pctInt, title: 'Share of the team\'s power-play time he was on the ice' },
];
// Goalie column groups
const G_GAME_GROUPS = [{ label: 'Goaltending', cols: [
  { k: 'decision', h: 'Dec', fmt: v => v || '–' }, { k: 'shots_against', h: 'SA' }, { k: 'saves', h: 'SV' },
  { k: 'goals_against', h: 'GA' }, { k: 'sv', h: 'SV%', fmt: (v, r) => svp(r.shots_against ? r.saves / r.shots_against : null) },
  { k: 'goals', h: 'G', hi: true }, { k: 'assists', h: 'A', hi: true }] }];
const G_AVG_GROUPS = [{ label: 'Per game', cols: [
  { k: 'starts', h: 'GS' }, { k: 'shots_against', h: 'SA', fmt: num2 }, { k: 'saves', h: 'SV', fmt: num2 },
  { k: 'goals_against', h: 'GA', fmt: num2 }, { k: 'sv_pct', h: 'SV%', fmt: svp }, { k: 'gaa', h: 'GAA', fmt: num2 }] }];
const G_SEASON_GROUPS = [{ label: 'Totals', cols: [
  { k: 'starts', h: 'GS' }, { k: 'wins', h: 'W' }, { k: 'shots_against', h: 'SA' }, { k: 'saves', h: 'SV' },
  { k: 'goals_against', h: 'GA' }, { k: 'sv_pct', h: 'SV%', fmt: svp }, { k: 'gaa', h: 'GAA', fmt: num2 },
  { k: 'goals', h: 'G', hi: true }, { k: 'assists', h: 'A', hi: true }] }];

function playerDetailBody(pl, data) {
  const g = data.is_goalie;
  let html = sectionHead('Last 5 games', 'newest first');
  html += data.games.length
    ? groupedTable(g ? [gameLead] : [gameLead, roleLead], g ? G_GAME_GROUPS : SK_GAME_GROUPS, data.games)
    : '<p class="text-xs text-gray-400 py-2">No NHL games played yet.</p>';
  if (data.averages?.length) {
    html += sectionHead('Recent vs season averages');
    html += groupedTable([{ h: '', left: true, cell: a => `<span class="text-gray-300">${a.label}</span>` }, { h: 'GP', cell: a => a.games }],
                         g ? G_AVG_GROUPS : SK_AVG_GROUPS, data.averages);
  }
  if (data.seasons.length) {
    const lead = [{ h: 'Season', left: true, cell: s => `<span class="text-gray-300">${seasonName(s.season)}</span>` },
                  { h: 'GP', cell: s => s.games }];
    html += sectionHead('Season totals');
    html += groupedTable(lead, g ? G_SEASON_GROUPS : SK_SEASON_GROUPS, data.seasons);
    html += sectionHead('Share of team', 'in games he played');
    html += groupedTable([lead[0]], [{ cols: g ? [SK_SHARE_COLS[1]] : SK_SHARE_COLS }], data.seasons, { flat: true });
  }
  html += `<p class="mt-3 text-[11px] text-gray-400 leading-snug">${g
    ? 'Last 5 counts only games he dressed for.'
    : 'Line / pair (L1–L4, P1–P3) and PP unit are read off each game\'s even-strength and power-play ice time — the NHL publishes no line combinations. Last 5 counts only games he played.'}</p>`;
  return html;
}

// data: undefined = loading, null = failed
function renderDetail({ gs, side, pl, data }) {
  const teamName = side === 'home' ? currentGame.home_team : currentGame.away_team;
  const status = STATUS_BADGE[pl.status];
  const subtitle = `<span title="${esc(roleTitle(pl))}">${roleLabel(pl)}</span> · ${esc(teamName)}`
    + (status ? ` · <span class="${status[1].split(' ')[0]}">${status[2]}${pl.status_detail ? ` — ${esc(pl.status_detail)}` : ''}</span>` : '');
  const tiles = [
    probTile('Anytime goal', singleLegProb(gs, side, 'goal', pl, 1)),
    probTile('1+ assist', singleLegProb(gs, side, 'assist', pl, 1)),
    probTile('1+ point', singleLegProb(gs, side, 'point', pl, 1)),
    probTile('2+ points', singleLegProb(gs, side, 'point', pl, 2)),
  ];
  if (pl.pos === 'G') {
    tiles.push(detailTile('Start chance', pctInt(pl.start_prob), gs.playerData[side].played_yesterday ? 'back-to-back' : 'recent starts'));
    tiles.push(detailTile('Team assist share', pl.active ? pct(pl.assist_share) : '–', 'model, per goal'));
  } else {
    tiles.push(detailTile('Proj. TOI', pl.active ? minFmt(pl.toi_proj) : '–',
                          pl.active ? `${minFmt(pl.ev_toi_proj)} EV · ${minFmt(pl.pp_toi_proj)} PP` : ''));
    tiles.push(detailTile('Model G / A per 60', pl.active ? `${num2(pl.g60)} / ${num2(pl.a60)}` : '–', 'at projected TOI'));
    tiles.push(detailTile('Team goal share', pl.active ? pct(pl.goal_share) : '–', 'model, per goal'));
    tiles.push(detailTile('Team assist share', pl.active ? pct(pl.assist_share) : '–', 'model, per goal'));
    tiles.push(probTile('2+ goals', singleLegProb(gs, side, 'goal', pl, 2)));
    tiles.push(probTile('2+ assists', singleLegProb(gs, side, 'assist', pl, 2)));
    tiles.push(detailTile('Proj. shots on goal', pl.active && pl.sog_mean != null ? num2(pl.sog_mean) : '–',
                          pl.sh_pct_est != null ? `model sh% ${pct1(pl.sh_pct_est)}` : ''));
    tiles.push(probTile('3+ SOG', singleLegProb(gs, side, 'sog', pl, 3)));
  }

  let body;
  if (data === undefined) {
    body = `<div class="mt-5 space-y-2">${'<span class="bsm-skeleton h-4 w-full block"></span>'.repeat(6)}</div>`;
  } else if (data === null) {
    body = '<p class="mt-5 text-sm text-gray-400 text-center">Could not load stats. Try again in a moment.</p>';
  } else {
    body = playerDetailBody(pl, data);
  }

  return `
    <div class="flex items-start gap-3">
      <img src="${nhlLogoUrl(teamName)}" class="w-9 h-9 object-contain shrink-0" alt="" onerror="this.style.display='none'">
      <div class="min-w-0 flex-1">
        <h2 id="nhl-detail-title" class="text-lg font-bold leading-tight truncate">${esc(pl.name)}</h2>
        <div class="text-xs text-gray-400 mt-0.5">${subtitle}</div>
      </div>
      <button type="button" data-close-detail aria-label="Close"
              class="shrink-0 w-8 h-8 -mr-1 -mt-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 text-lg leading-none">✕</button>
    </div>
    <div class="mt-4">${tileGrid(tiles)}</div>
    <p class="mt-1.5 text-[11px] text-gray-400">Prices assume he ${pl.pos === 'G' ? 'starts' : 'plays'}. Shares are of team goals, split by projected ice time × per-60 rates.</p>
    ${body}`;
}

async function openDetail(side, id) {
  const gs = S(), game = currentGame;
  const pl = findPlayer(gs, side, id);
  if (!game || !pl) return;
  const ctx = { gs, side, pl };
  const seq = ++detailSeq;
  const url = apiUrl('nhl', `player_detail/${game.game_id}/${pl.id}`);
  detailPanel.innerHTML = renderDetail({ ...ctx, data: detailCache.get(url) });
  detailPanel.scrollTop = 0;
  detailModal.classList.remove('hidden');
  detailModal.classList.add('flex');
  document.body.style.overflow = 'hidden';
  if (detailCache.has(url)) return;

  let data = null;
  try {
    const res = await fetch(url);
    data = res.ok ? await res.json() : null;
  } catch { /* leave null */ }
  if (data) detailCache.set(url, data);
  if (seq === detailSeq) detailPanel.innerHTML = renderDetail({ ...ctx, data });
}

// =============================================================================
// LINE CONTROLS (state lives in gameState[game].lines)
// =============================================================================
function populateMarginDropdown() {
  marginValSel.innerHTML = '';
  for (let v = -10.5; v <= 10.5; v += 1) {
    const label = v === -0.5 ? 'To Win' : `${v >= 0 ? '+' : ''}${v}`;
    marginValSel.innerHTML += `<option value="${v}"${v === -0.5 ? ' selected' : ''}>${label}</option>`;
  }
}
function populateTotalDropdown(sel, max) {
  sel.innerHTML = '<option value="" disabled selected>—</option>';
  for (let n = 1; n <= max; n++) sel.innerHTML += `<option value="${n}">${n - 0.5}</option>`;
}
populateMarginDropdown();

function paintDir(btnA, btnB, activeA, activeB) {
  for (const [b, on] of [[btnA, activeA], [btnB, activeB]]) {
    b.classList.toggle('bg-blue-500', on);
    b.classList.toggle('text-white', on);
    b.classList.toggle('text-gray-400', !on);
  }
}

function syncMarginUI() {
  const L = S().lines;
  paintDir(marginDirHome, marginDirAway, L.marginTeam === 'home', L.marginTeam === 'away');
  marginValSel.disabled = !L.marginTeam;
  marginValSel.value = L.marginL != null ? String(L.marginL) : '-0.5';
}
function setMarginTeam(team) {
  const L = S().lines;
  L.marginTeam = team;
  if (team && L.marginL == null) L.marginL = -0.5;
  if (!team) L.marginL = null;
  syncMarginUI();
  recalculate();
}
marginDirHome.addEventListener('click', () => setMarginTeam(S().lines.marginTeam === 'home' ? null : 'home'));
marginDirAway.addEventListener('click', () => setMarginTeam(S().lines.marginTeam === 'away' ? null : 'away'));
marginValSel.addEventListener('change', () => { S().lines.marginL = parseFloat(marginValSel.value); recalculate(); });
marginClearBtn.addEventListener('click', () => setMarginTeam(null));

// The three over/under groups share one wiring
const totalGroups = [
  { prefix: 'total',      dir: 'totalDir',     n: 'totalN',     max: 15 },
  { prefix: 'home-total', dir: 'homeTotalDir', n: 'homeTotalN', max: 9 },
  { prefix: 'away-total', dir: 'awayTotalDir', n: 'awayTotalN', max: 9 },
].map(g => ({ ...g, over: $(`${g.prefix}-dir-over`), under: $(`${g.prefix}-dir-under`),
              sel: $(`${g.prefix}-val`), clear: $(`${g.prefix}-clear`) }));

function syncTotalUI(g) {
  const L = S().lines;
  paintDir(g.over, g.under, L[g.dir] === 'over', L[g.dir] === 'under');
  g.sel.disabled = !L[g.dir];
  g.sel.value = L[g.n] != null ? String(L[g.n]) : '';
}
for (const g of totalGroups) {
  populateTotalDropdown(g.sel, g.max);
  const setDir = d => { const L = S().lines; L[g.dir] = L[g.dir] === d ? null : d; syncTotalUI(g); recalculate(); };
  g.over.addEventListener('click', () => setDir('over'));
  g.under.addEventListener('click', () => setDir('under'));
  g.sel.addEventListener('change', () => { S().lines[g.n] = parseInt(g.sel.value, 10); recalculate(); });
  g.clear.addEventListener('click', () => { const L = S().lines; L[g.dir] = null; L[g.n] = null; syncTotalUI(g); recalculate(); });
}

function syncLineUI() {
  syncMarginUI();
  totalGroups.forEach(syncTotalUI);
}

resetMatchBtn.addEventListener('click', () => {
  if (!currentGame) return;
  const gs = S();
  const hadOverrides = gs.out.size || gs.in.size;
  const keep = gs.playerData, dists = gs.teamDists;
  gameState[currentGame.game_id] = newGameState();
  Object.assign(S(), { playerData: keep, teamDists: dists });
  syncLineUI();
  if (hadOverrides) loadPlayerData(currentGame.game_id);
  renderTeams();
  recalculate();
});
resetAllBtn.addEventListener('click', () => {
  for (const gid of Object.keys(gameState)) {
    const { playerData, teamDists, out, in: inn } = gameState[gid];
    gameState[gid] = newGameState();
    if (!out.size && !inn.size) Object.assign(gameState[gid], { playerData, teamDists });
  }
  syncLineUI();
  if (currentGame) loadPlayerData(currentGame.game_id);
  renderTeams();
  recalculate();
});

// =============================================================================
// BETSLIP
// =============================================================================
function buildResults() {
  const results = [];
  for (const gid of Object.keys(gameState)) {
    if (!gameHasSelections(gid)) continue;
    const game = gameById(gid);
    if (!game) continue;
    const r = gameProbability(gid);
    if (!r) continue;
    const gs = S(gid);
    results.push({
      matchId: Number(gid),
      matchLabel: `${game.home_team} vs ${game.away_team}`,
      prob: r.prob,
      lineProb: r.lineProb,
      lineItems: lineLabels(game, gs.lines),
      picks: [...gs.picks.values()].map(p => {
        const pl = findPlayer(gs, p.side, p.playerId);
        return { ...p, label: legLabel(p.kind, p.name, p.n), indivProb: singleLegProb(gs, p.side, p.kind, pl, p.n) };
      }),
    });
  }
  return results;
}

function recalculate() {
  const results = buildResults();
  resetMatchBtn.disabled = !(currentGame && (gameHasSelections(currentGame.game_id)
    || S().out.size || S().in.size));
  resetAllBtn.disabled = !Object.keys(gameState).some(gameHasSelections);
  updateOptionBadges();
  renderBetslip(results);
  window.dispatchEvent(new Event('bsm:builder-updated'));
}

function renderBetslip(results) {
  if (!results.length) {
    resultDiv.innerHTML = '';
    resultDiv.classList.remove('betslip-open');
    betslipExpanded = false;
    return;
  }
  const combinedProb = results.reduce((acc, r) => acc * r.prob, 1);
  const combinedOdds = combinedProb > 0 ? (1 / combinedProb).toFixed(2) : '∞';
  const totalLegs = results.reduce((acc, r) => acc + r.picks.length + r.lineItems.length, 0);
  const isMulti = results.length > 1 || totalLegs > 1;

  const dotRow = (dot, text, italic, right) => `
    <div class="flex items-center justify-between gap-2 py-0.5">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="w-1.5 h-1.5 rounded-full ${dot} shrink-0 mt-0.5"></span>
        <span class="text-sm ${italic ? 'text-gray-300 italic' : 'text-white'} truncate">${esc(text)}</span>
      </div>
      ${right ? `<div class="text-right shrink-0"><div class="text-sm font-semibold text-gray-300">${pct(right)}</div>
                 <div class="text-xs text-gray-400">${odds(right)}</div></div>` : ''}
    </div>`;

  const legsHtml = results.map(r => {
    const lines = r.lineItems.map((l, i) => dotRow('bg-blue-400', l, true, i === r.lineItems.length - 1 ? r.lineProb : null)).join('');
    const picks = r.picks.map(p => dotRow('bg-green-400', p.label, false, p.indivProb)).join('');
    const gameOdds = results.length > 1 && (r.picks.length + r.lineItems.length) > 1
      ? `<div class="flex justify-between text-xs text-gray-400 mt-1"><span>Same game</span><span class="text-amber-400 font-semibold">${odds(r.prob)} · ${pct(r.prob)}</span></div>` : '';
    return `
      <div class="py-2.5 border-b border-gray-700/40 last:border-b-0">
        <div class="text-xs font-semibold text-gray-400 truncate mb-1.5">${esc(r.matchLabel)}</div>
        ${lines}${picks}${gameOdds}
      </div>`;
  }).join('');

  resultDiv.innerHTML = `
    <div id="betslip-toggle" class="flex items-center justify-between cursor-pointer select-none">
      <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Betslip</span>
      <div class="flex items-center gap-2">
        <span class="text-base font-bold text-amber-400">${totalLegs} leg${totalLegs !== 1 ? 's' : ''} · $${combinedOdds}</span>
        <span id="betslip-chevron" class="text-gray-400 text-xs">${betslipExpanded ? '▼' : '▲'}</span>
      </div>
    </div>
    <div id="betslip-body" class="${betslipExpanded ? '' : 'hidden'} mt-1">
      ${legsHtml}
      <div class="mt-3 pt-3 border-t border-gray-600">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-gray-300">${isMulti ? `Multi (${totalLegs} legs)` : 'Selection'}</span>
          <div class="text-right">
            <div class="text-2xl font-extrabold text-amber-400">${(combinedProb * 100).toFixed(2)}%</div>
            <div class="text-xs text-gray-400">$${combinedOdds}</div>
          </div>
        </div>
      </div>
      <div class="mt-3 pt-3 border-t border-gray-700/40">
        <div class="flex items-center gap-2">
          <label for="bookie-odds-input" class="text-xs font-semibold text-gray-400 uppercase tracking-wider shrink-0">Bookie Odds</label>
          <div class="flex items-center gap-1 flex-1">
            <span class="text-sm text-gray-400">$</span>
            <input id="bookie-odds-input" type="number" min="1.01" step="0.05" placeholder="e.g. 4.50"
                   value="${bookieOdds != null ? bookieOdds : ''}"
                   class="flex-1 min-w-0 bg-gray-800 border border-gray-600 text-white text-sm rounded px-2 py-1 focus:outline-none focus:border-amber-500/60">
          </div>
        </div>
        <p id="bookie-ev" class="text-xs mt-1 ${bookieOdds ? '' : 'text-gray-400'}">${evText(combinedProb)}</p>
      </div>
      <div class="text-xs mt-3 text-gray-400 text-center leading-tight">
        Find this useful? <a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" class="text-yellow-300 hover:underline">Buy me a coffee</a> to help pay server costs.
      </div>
    </div>`;
  resultDiv.classList.toggle('betslip-open', betslipExpanded);

  resultDiv.querySelector('#betslip-toggle').addEventListener('click', () => {
    betslipExpanded = !betslipExpanded;
    resultDiv.classList.toggle('betslip-open', betslipExpanded);
    resultDiv.querySelector('#betslip-body').classList.toggle('hidden', !betslipExpanded);
    resultDiv.querySelector('#betslip-chevron').textContent = betslipExpanded ? '▼' : '▲';
  });
  const input = resultDiv.querySelector('#bookie-odds-input');
  input.addEventListener('input', () => {
    bookieOdds = input.value ? parseFloat(input.value) : null;
    const ev = resultDiv.querySelector('#bookie-ev');
    ev.innerHTML = evText(combinedProb);
    ev.className = `text-xs mt-1 ${bookieOdds ? '' : 'text-gray-400'}`;
  });
}

function evText(prob) {
  if (!bookieOdds || !prob) return 'Optional · compare with the model';
  const ev = (bookieOdds * prob - 1) * 100;
  return `<span class="${ev >= 0 ? 'text-green-400' : 'text-red-400'} font-semibold">${ev >= 0 ? '+' : ''}${ev.toFixed(1)}% EV</span>`;
}

// =============================================================================
// LOADING
// =============================================================================
function formatPuckDrop(game) {
  if (!game?.date) return '';
  const d = new Date(game.date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const formatDay = iso => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

async function loadBinsForGame(gid) {
  if (binsCache[gid]) return binsCache[gid];
  try {
    const res = await fetch(apiUrl('nhl', `game_sgm_bins_range/${gid}?with_dists=1`));
    binsCache[gid] = res.ok ? ((await res.json()).bins || []) : [];
  } catch {
    binsCache[gid] = [];
  }
  return binsCache[gid];
}

async function loadPlayerData(gid) {
  const gs = S(gid);
  const seq = ++gs.loadSeq;
  const qs = new URLSearchParams();
  if (gs.out.size) qs.set('out', [...gs.out].join(','));
  if (gs.in.size)  qs.set('in',  [...gs.in].join(','));
  let data = null;
  try {
    const res = await fetch(apiUrl('nhl', `game_player_data/${gid}${qs.toString() ? '?' + qs : ''}`));
    data = res.ok ? await res.json() : null;
  } catch { /* leave null */ }
  if (seq !== gs.loadSeq) return;
  gs.playerData = data;
  // Drop legs on a player now ruled out
  for (const [k, p] of gs.picks) {
    const pl = findPlayer(gs, p.side, p.playerId);
    if (!pl || !pl.active) gs.picks.delete(k);
  }
  if (String(currentGame?.game_id) === String(gid)) renderTeams();
  recalculate();
}

function updateOptionBadges() {
  Array.from(gameSelect.options).forEach(opt => {
    const gs = gameState[opt.value];
    const n = gs ? gs.picks.size + lineLabels(gameById(opt.value) || {}, gs.lines).length : 0;
    const base = opt.dataset.label || opt.textContent;
    opt.dataset.label = base;
    opt.textContent = n > 0 ? `${base} (${n} leg${n !== 1 ? 's' : ''})` : base;
  });
}

async function selectGame(gid) {
  currentGame = gameById(gid);
  if (!currentGame) { builderSection.classList.add('hidden'); announceGame(null); return; }
  const gs = S();
  builderMatchup.textContent = `${currentGame.home_team} vs ${currentGame.away_team}`;
  builderKickoff.textContent = formatPuckDrop(currentGame);
  $('home-pts-label').textContent = `${currentGame.home_team} Goals`;
  $('away-pts-label').textContent = `${currentGame.away_team} Goals`;
  marginDirHome.textContent = currentGame.home_abbr || 'H';
  marginDirAway.textContent = currentGame.away_abbr || 'A';
  builderSection.classList.remove('hidden');
  syncLineUI();
  renderTeams();
  announceGame();

  const loadingId = currentGame.game_id;
  loadLogs(loadingId);   // history lines fill in when it lands; prices don't wait for it
  const [bins] = await Promise.all([loadBinsForGame(loadingId), gs.playerData ? null : loadPlayerData(loadingId)]);
  if (bins.length && !gs.teamDists) gs.teamDists = playerGoalDists(bins);
  if (currentGame?.game_id !== loadingId) return;
  renderTeams();
  recalculate();
}

gameSelect.addEventListener('change', () => selectGame(gameSelect.value));

// =============================================================================
// BEST BETS PANEL (match-best-bets.js): the selected game, and its best bets as legs
// =============================================================================
function announceGame(game = currentGame) {
  window.bsmSelectedMatch = { sport: 'nhl', gameId: game?.game_id ?? null };
  window.dispatchEvent(new CustomEvent('bsm:match-selected', { detail: window.bsmSelectedMatch }));
}

// Best Bets player props -> this builder's pick kinds (all "N or more")
const PROP_LEGS = { assists: 'assist', points: 'point' };

// The leg a best bet (an /api/best_bets row) becomes here: a scorer pick, a
// player prop's Over (N+ assists / points) or a margin / total line. null when
// this builder has no such leg: the 60-minute three-way market, a prop's
// Under, whole and quarter lines (the dropdowns are half-points), a line
// outside a dropdown, or a player not in this game's player data.
function bestBetLeg(r) {
  if (!currentGame || String(r.game_id) !== String(currentGame.game_id)) return null;
  const gs = S();
  const halfPoint = r.line != null && Math.abs(r.line * 2) % 2 === 1;
  if (PROP_LEGS[r.market_kind]) {
    const kind = PROP_LEGS[r.market_kind];
    if (r.side !== 'over' || !halfPoint) return null;
    const side = ['home', 'away'].find(sd => findPlayer(gs, sd, r.player_id));
    const pl = side && findPlayer(gs, side, r.player_id);
    const n = Math.floor(r.line) + 1;
    if (!pl || !pl.active || n > maxLegN(gs, side, kind)) return null;
    return { key: `${side}:${kind}:${pl.id}`,
             pick: { side, kind, n, playerId: pl.id, teamId: gs.playerData[side].team_id, name: pl.name } };
  }
  if (r.market_kind === 'anytime_scorer' || r.market_kind === 'multi_scorer') {
    const side = ['home', 'away'].find(sd => findPlayer(gs, sd, r.player_id));
    const pl = side && findPlayer(gs, side, r.player_id);
    const n = r.line || 1;
    if (!pl || !pl.active || n > maxLegN(gs, side, 'goal')) return null;
    return { key: `${side}:goal:${pl.id}`,
             pick: { side, kind: 'goal', n, playerId: pl.id, teamId: gs.playerData[side].team_id, name: pl.name } };
  }
  if (r.side !== 'home' && r.side !== 'away' && r.side !== 'over' && r.side !== 'under') return null;
  if (r.market_kind === 'match_odds' && !r.three_way) return { lines: { marginTeam: r.side, marginL: -0.5 } };
  if (r.market_kind === 'handicap' && halfPoint && Math.abs(r.line) <= 10.5) return { lines: { marginTeam: r.side, marginL: r.line } };
  // The builder's total is the final score: a bookie total settled on 60 minutes
  // (market_id ending ':reg') is a different bet, so it isn't offered as a leg
  if (r.market_kind === 'total' && /:reg$/.test(r.market_id || '')) return null;
  if (r.market_kind === 'total' && halfPoint && r.line > 0 && r.line + 0.5 <= 15) return { lines: { totalDir: r.side, totalN: r.line + 0.5 } };
  return null;
}

function hasBestBetLeg(r) {
  const leg = bestBetLeg(r);
  if (!leg) return false;
  const gs = S();
  return leg.pick ? gs.picks.get(leg.key)?.n === leg.pick.n : Object.entries(leg.lines).every(([k, v]) => gs.lines[k] === v);
}

window.bsmBuilder = {
  canAdd: r => !!bestBetLeg(r),
  has: hasBestBetLeg,
  // Adds the leg, or takes it off if it is already on the betslip
  toggle(r) {
    const leg = bestBetLeg(r);
    if (!leg) return;
    const gs = S(), on = hasBestBetLeg(r);
    if (leg.pick) {
      if (on) gs.picks.delete(leg.key); else gs.picks.set(leg.key, leg.pick);
    } else {
      for (const [k, v] of Object.entries(leg.lines)) gs.lines[k] = on ? null : v;
    }
    syncLineUI();
    renderTeams();
    recalculate();
  },
};

function renderCurrentDate(preferGameId = null) {
  const key = dateKeys[currentDateIdx];
  gameSelect.innerHTML = '';
  noGamesMsg.classList.add('hidden');
  builderSection.classList.add('hidden');
  datePrevBtn.disabled = currentDateIdx <= 0;
  dateNextBtn.disabled = currentDateIdx >= dateKeys.length - 1;

  if (!key) {
    dateBadge.textContent = 'No games';
    noGamesMsg.classList.remove('hidden');
    announceGame(null);
    return;
  }
  games = (gamesByDate[key] || []).filter(g => g.has_prediction);
  dateBadge.textContent = formatDay(gamesByDate[key]?.[0]?.date) || key;
  if (!games.length) {
    noGamesMsg.classList.remove('hidden');
    announceGame(null);
    recalculate();
    return;
  }
  gameSelect.innerHTML = games.map(g => `<option value="${g.game_id}">${esc(g.home_team)} vs ${esc(g.away_team)}</option>`).join('');
  const pick = (preferGameId && games.find(g => String(g.game_id) === String(preferGameId)))
    || games.find(g => !g.is_finished && new Date(g.date).getTime() > Date.now()) || games[0];
  gameSelect.value = pick.game_id;
  updateOptionBadges();
  selectGame(pick.game_id);
}

datePrevBtn.addEventListener('click', () => { if (currentDateIdx > 0) { currentDateIdx -= 1; renderCurrentDate(); } });
dateNextBtn.addEventListener('click', () => { if (currentDateIdx < dateKeys.length - 1) { currentDateIdx += 1; renderCurrentDate(); } });

async function init() {
  let preds = [];
  try {
    const res = await fetch(apiUrl('nhl', 'upcoming_predictions?days=14'));
    if (res.ok) preds = (await res.json()).predictions || [];
  } catch { /* empty */ }
  allGames = preds;
  gamesByDate = {};
  for (const g of allGames) {
    const d = new Date(g.date);
    if (isNaN(d.getTime())) continue;
    (gamesByDate[d.toDateString()] ||= []).push(g);
  }
  dateKeys = Object.keys(gamesByDate).sort((a, b) => new Date(a) - new Date(b));

  const gameIdParam = new URLSearchParams(window.location.search).get('game_id');
  const today = new Date(new Date().toDateString());
  const todayIdx = dateKeys.findIndex(k => new Date(k) >= today);
  currentDateIdx = todayIdx >= 0 ? todayIdx : Math.max(0, dateKeys.length - 1);
  if (gameIdParam) {
    const idx = dateKeys.findIndex(k => gamesByDate[k].some(g => String(g.game_id) === gameIdParam));
    if (idx >= 0) currentDateIdx = idx;
  }
  renderCurrentDate(gameIdParam);
}

init();
