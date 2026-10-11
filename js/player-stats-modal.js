// player-stats-modal.js — a player's stats window for pages outside the multi
// builders (Best Bets). Same history tables as the builders' stats windows
// (last 5 games, averages, season totals, share of team), from
// /api/nfl/player_detail and /api/nhl/player_detail. The caller supplies the
// first row of header tiles; a second row shows the model's projection for
// this game (snap share / ice time, chance to play, share of team scoring)
// from the builders' game_player_data.
import { apiUrl } from './api-config.js';
import { nflLogoUrl } from './nfl-logos.js';
import { nhlLogoUrl } from './nhl-logos.js';

export const STATS_SPORTS = ['nfl', 'nhl'];

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const mmss = sec => (sec == null ? '–' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);
const pctInt = v => (v == null ? '–' : `${Math.round(v * 100)}%`);
const pct1 = v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
const num2 = v => (v == null ? '–' : Number(v).toFixed(2));
const signed = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${Number.isInteger(v) ? v : Number(v).toFixed(2)}`);
const svp = v => (v == null ? '–' : Number(v).toFixed(3).replace(/^0/, ''));

const modal = document.createElement('div');
modal.className = 'fixed inset-0 hidden items-end sm:items-center justify-center bg-black/60 sm:p-4';
modal.style.zIndex = '1200';   // above the site header (1100)
modal.innerHTML = `
  <div role="dialog" aria-modal="true" aria-labelledby="player-stats-title"
       class="bg-gray-800 border border-gray-700 w-full sm:max-w-2xl max-h-[88vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-2xl p-4"></div>`;
document.body.appendChild(modal);
const panel = modal.firstElementChild;
const cache = new Map();   // url -> response
const projCache = new Map();   // game_player_data url -> promise of the response (null = failed)
let seq = 0;

function close() {
  seq++;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  document.body.style.overflow = '';
}
modal.addEventListener('click', e => {
  if (e.target === modal || e.target.closest('[data-close-detail]')) close();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
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

const sectionHead = (title, note = '') => `
  <div class="flex items-baseline justify-between gap-2 mt-5 mb-1">
    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">${title}</h3>
    ${note ? `<span class="text-[11px] text-gray-400">${note}</span>` : ''}
  </div>`;

// --- NFL ----------------------------------------------------------------------

const NFL_GROUPS = [
  { label: 'Rushing',   cols: [{ k: 'carries', h: 'Car' }, { k: 'rz_carries', h: 'RZ' }, { k: 'rush_yds', h: 'Yds' }, { k: 'rush_tds', h: 'TD', hi: true }] },
  { label: 'Receiving', cols: [{ k: 'targets', h: 'Tgt' }, { k: 'rz_targets', h: 'RZ' }, { k: 'receptions', h: 'Rec' }, { k: 'rec_yds', h: 'Yds' }, { k: 'rec_tds', h: 'TD', hi: true }] },
  { label: 'Passing',   cols: [{ k: 'pass_att', h: 'Att' }, { k: 'pass_yds', h: 'Yds' }, { k: 'pass_tds', h: 'TD', hi: true }] },
];

function nflBody(data) {
  // A group shows when the player has any of those numbers (a WR's carries).
  const anyVal = k => [...data.games, ...data.seasons].some(r => r[k]);
  const groups = NFL_GROUPS.filter(g => g.cols.some(c => anyVal(c.k)));
  const snapCol = { h: 'Snap', cell: r => pctInt(r.snap_pct) };
  const gameLead = { h: 'Game', left: true, cell: g => `
    <div class="leading-tight"><div class="text-gray-300">Wk ${g.week}${g.season !== data.season ? ` <span class="text-gray-400">’${String(g.season).slice(2)}</span>` : ''}</div>
    <div class="text-gray-400">${g.home ? 'vs' : '@'} ${esc(g.opp)}</div></div>` };
  const seasonLead = [{ h: 'Season', left: true, cell: s => `<span class="text-gray-300">${s.season}</span>` }, { h: 'G', cell: s => s.games }];

  let html = sectionHead('Last 5 games', 'newest first');
  html += data.games.length
    ? groupedTable([gameLead, snapCol], groups, data.games)
    : '<p class="text-xs text-gray-400 py-2">No games played yet.</p>';
  if (data.seasons.length) {
    html += sectionHead('Season totals', 'snap % is the per-game average');
    html += groupedTable([...seasonLead, snapCol], groups, data.seasons);
    const rush = groups.some(g => g.label === 'Rushing'), recv = groups.some(g => g.label === 'Receiving');
    const shareCols = [
      rush && { k: 'carry_share', h: 'Carries', fmt: pctInt },
      rush && { k: 'rush_yds_share', h: 'Rush yds', fmt: pctInt },
      recv && { k: 'target_share', h: 'Targets', fmt: pctInt },
      recv && { k: 'rec_yds_share', h: 'Rec yds', fmt: pctInt },
      { k: 'rz_share', h: 'RZ opps', fmt: pctInt },
      { k: 'td_share', h: 'Rush + rec TDs', fmt: pctInt },
    ].filter(Boolean);
    html += sectionHead('Share of team');
    html += groupedTable([seasonLead[0]], [{ cols: shareCols }], data.seasons, { flat: true });
  }
  html += `<p class="mt-3 text-[11px] text-gray-400 leading-snug">RZ = carries / targets inside the opponent's 10-yard line.
    Last 5 counts only games the player appeared in.</p>`;
  return html;
}

// --- NHL ----------------------------------------------------------------------

const POS_LABEL = { C: 'C', L: 'LW', R: 'RW', D: 'D', G: 'G' };
const nhlGameLead = { h: 'Game', left: true, cell: g => `<span class="text-gray-300">${esc(g.label)}</span>` };
const nhlRoleLead = { h: 'Pos', cell: g => {
  const pos = POS_LABEL[g.pos] || g.pos || '–';
  return g.role ? `<span title="Position · line (by EV ice time) · PP unit">${pos} <span class="text-gray-400">${esc(g.role)}</span></span>` : pos;
} };
const seasonName = s => `${s}-${String(s + 1).slice(2)}`;

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

function nhlBody(data) {
  const g = data.is_goalie;
  let html = sectionHead('Last 5 games', 'newest first');
  html += data.games.length
    ? groupedTable(g ? [nhlGameLead] : [nhlGameLead, nhlRoleLead], g ? G_GAME_GROUPS : SK_GAME_GROUPS, data.games)
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

// --- model projection for this game ---------------------------------------------

function loadProjection(sport, gameId) {
  const url = apiUrl(sport, `game_player_data/${gameId}`);
  if (!projCache.has(url)) {
    const req = fetch(url).then(res => (res.ok ? res.json() : null)).catch(() => null);
    projCache.set(url, req);
    req.then(data => { if (!data) projCache.delete(url); });   // retry next time
  }
  return projCache.get(url);
}

function findPlayer(data, playerId) {
  for (const side of ['home', 'away']) {
    const pl = (data?.[side]?.players || []).find(p => String(p.id) === String(playerId));
    if (pl) return { ...pl, side };
  }
  return null;
}

const playChance = pl => ({
  label: 'Chance to play', value: pl.active ? pctInt(pl.p_play) : 'Out',
  sub: !pl.active ? '' : pl.status && pl.status !== 'active' ? pl.status : 'on recent games' });

// The projection tiles: what the price rests on.
function projTiles(sport, pl) {
  if (sport === 'nfl') {
    return [
      { label: 'Proj. snaps', value: pl.active && pl.snap_proj != null ? pctInt(pl.snap_proj) : '–', sub: 'of offensive snaps' },
      playChance(pl),
      { label: 'Team TD share', value: pl.active ? pct1(pl.td_share) : '–', sub: 'model, if he plays' },
      { label: 'Role', value: `${pl.pos}${pl.role_rank ?? ''}`, sub: `depth chart ${pl.pos}${pl.depth}` },
    ];
  }
  const role = [POS_LABEL[pl.pos] || pl.pos];
  if (pl.pos !== 'G' && pl.line) role.push(`${pl.pos === 'D' ? 'P' : 'L'}${pl.line}`);
  return [
    { label: 'Proj. ice time', value: pl.active && pl.toi_proj != null ? mmss(Math.round(pl.toi_proj * 60)) : '–',
      sub: pl.active && pl.pp_toi_proj != null ? `${mmss(Math.round(pl.pp_toi_proj * 60))} on the power play` : '' },
    playChance(pl),
    { label: 'Team goal share', value: pl.active ? pct1(pl.goal_share) : '–', sub: 'model, if he plays' },
    { label: 'Role', value: role.join(' · '), sub: pl.pp_unit ? `PP${pl.pp_unit}` : 'no power-play unit' },
  ];
}

const tileGrid = tiles => `<div class="grid gap-2 grid-cols-2 sm:grid-cols-4">${tiles.map(t => `
  <div class="bg-gray-900/60 border border-gray-700 rounded-lg px-2 py-2 text-center min-w-0">
    <div class="text-[10px] uppercase tracking-wider text-gray-400 leading-tight">${esc(t.label)}</div>
    <div class="text-base font-bold mt-0.5 ${t.cls || 'text-white'}">${esc(t.value)}</div>
    ${t.sub ? `<div class="text-[11px] text-gray-400">${esc(t.sub)}</div>` : ''}
  </div>`).join('')}</div>`;

// proj: undefined = loading, null = failed or player not in the model
function projRow(sport, proj) {
  if (proj === undefined) return `<div class="mt-2 grid gap-2 grid-cols-2 sm:grid-cols-4">${'<span class="bsm-skeleton h-14 w-full block rounded-lg"></span>'.repeat(4)}</div>`;
  if (!proj) return '';
  return `<div class="mt-2">${tileGrid(projTiles(sport, proj))}</div>`;
}

// --- window -------------------------------------------------------------------

const BODY = { nfl: nflBody, nhl: nhlBody };
const LOGO = { nfl: nflLogoUrl, nhl: nhlLogoUrl };

// data: undefined = loading, null = failed
function render({ sport, name, subtitle, team, teams, tiles, note }, data, proj) {
  team = team || teams?.[proj?.side] || null;   // his side of the game, from the projection
  let body;
  if (data === undefined) {
    body = `<div class="mt-5 space-y-2">${'<span class="bsm-skeleton h-4 w-full block"></span>'.repeat(6)}</div>`;
  } else if (data === null) {
    body = '<p class="mt-5 text-sm text-gray-400 text-center">Could not load stats. Try again in a moment.</p>';
  } else {
    body = BODY[sport](data);
  }
  return `
    <div class="flex items-start gap-3">
      ${team ? `<img src="${LOGO[sport](team)}" class="w-9 h-9 object-contain shrink-0" alt="" onerror="this.style.display='none'">` : ''}
      <div class="min-w-0 flex-1">
        <h2 id="player-stats-title" class="text-lg font-bold leading-tight truncate">${esc(name)}</h2>
        ${team ? `<div class="text-sm font-semibold text-gray-200 mt-0.5">${esc(team)}</div>` : ''}
        <div class="text-xs text-gray-400 mt-0.5">${esc(subtitle)}</div>
      </div>
      <button type="button" data-close-detail aria-label="Close"
              class="shrink-0 w-8 h-8 -mr-1 -mt-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 text-lg leading-none">✕</button>
    </div>
    ${tiles?.length ? `<div class="mt-4">${tileGrid(tiles)}</div>` : ''}
    ${projRow(sport, proj)}
    ${note ? `<p class="mt-1.5 text-[11px] text-gray-400">${esc(note)}</p>` : ''}
    ${body}`;
}

// opts: { sport ('nfl' | 'nhl'), gameId, playerId, name, subtitle, team (his
// team's name, shown with its logo) or teams: { home, away } to work it out, tiles: [{ label, value, sub, cls }], note }
export async function openPlayerStats(opts) {
  if (!STATS_SPORTS.includes(opts.sport)) return;
  const mine = ++seq;
  const url = apiUrl(opts.sport, `player_detail/${opts.gameId}/${opts.playerId}`);
  let data = cache.get(url), proj;
  const paint = () => { if (mine === seq) panel.innerHTML = render(opts, data, proj); };
  paint();
  panel.scrollTop = 0;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.style.overflow = 'hidden';

  loadProjection(opts.sport, opts.gameId).then(res => { proj = findPlayer(res, opts.playerId); paint(); });
  if (data) return;
  let fetched = null;
  try {
    const res = await fetch(url);
    fetched = res.ok ? await res.json() : null;
  } catch { /* leave null */ }
  if (fetched) cache.set(url, fetched);
  data = fetched;
  paint();
}
