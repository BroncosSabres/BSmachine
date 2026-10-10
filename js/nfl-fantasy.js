// nfl-fantasy.js — drives nfl/pages/fantasy.html.
//
// /api/nfl/fantasy serves every relevant player's EXPECTED STAT COMPONENTS
// (pass_yds, rec, rush_td, fg_40_49, sacks, ...) for this week and the rest of
// the season, plus recent actuals, usage trends, injury links and Sleeper
// trending (see nrl-flask-backend/nfl_fantasy.py). Everything that depends on
// the viewer's league — scoring format, league size, who's likely available,
// replacement level and the waiver ranking — is worked out here. The scoring
// rules come with the payload, so they can't drift from the backend's.
import { apiUrl } from './api-config.js';
import { deltaBadge } from './rankings-shared.js';
import { nflLogoUrl } from './nfl-logos.js';

// Typical players rostered per league team, by position: league size x this =
// the "likely rostered" cut-off (12 teams -> QB18 / RB48 / WR60 / TE18 / K12 / DST12).
const ROSTER_PER_TEAM = { QB: 1.5, RB: 4, WR: 5, TE: 1.5, K: 1, DST: 1 };
const FLEX = new Set(['RB', 'WR', 'TE']);
const VIEWS = [{ key: 'rankings', label: 'Rankings' }, { key: 'waivers', label: 'Waiver Wire' }];
const FORMATS = [{ key: 'ppr', label: 'PPR' }, { key: 'half', label: 'Half' }, { key: 'std', label: 'Std' }];
const HORIZONS = [{ key: 'week', label: 'This Week' }, { key: 'ros', label: 'Rest of Season' }];
const RANK_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'];
const WAIVER_POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'];
const LEAGUE_SIZES = [8, 10, 12, 14];
const STATUS_BADGE = {
  questionable: ['Q', '#facc15'], doubtful: ['D', '#fb923c'], out: ['OUT', '#f87171'],
  ir: ['IR', '#f87171'], inactive: ['INA', '#f87171'],
};
// Projected stat columns per position: [key, header, decimals]
const STAT_COLS = {
  QB: [['pass_yds', 'Pass Yds', 0], ['pass_td', 'Pass TD', 1], ['int', 'INT', 1], ['rush_yds', 'Rush Yds', 0]],
  RB: [['rush_yds', 'Rush Yds', 0], ['rec', 'Rec', 1], ['rec_yds', 'Rec Yds', 0], ['td', 'TD', 1]],
  WR: [['rec', 'Rec', 1], ['rec_yds', 'Rec Yds', 0], ['td', 'TD', 1]],
  TE: [['rec', 'Rec', 1], ['rec_yds', 'Rec Yds', 0], ['td', 'TD', 1]],
  FLEX: [['rush_yds', 'Rush Yds', 0], ['rec', 'Rec', 1], ['rec_yds', 'Rec Yds', 0], ['td', 'TD', 1]],
  K: [['fg', 'FG', 1], ['fg_50', '50+', 1], ['pat', 'PAT', 1]],
  DST: [['sacks', 'Sacks', 1], ['to', 'Takeaways', 1], ['d_td', 'TD', 2], ['pa_pts', 'PA pts', 1]],
};
const TREND_LABELS = { snap: ['Snap share', 0.10], target_share: ['Target share', 0.05],
                       carry_share: ['Carry share', 0.10], rz_share: ['Red-zone share', 0.10] };
const METHOD = 'Projections are expected stats, not medians. Team touchdowns per game come from the match '
  + 'simulation; they and the yardage model are split across each roster by the Multi Builder player '
  + 'model (usage shares, red-zone role, chance to play), with this week\'s injury report and estimated '
  + 'return dates for injured players (ESPN\'s where given). Kickers use expected field goals and the '
  + 'kicker\'s distance mix; defenses use sack / takeaway rates against this opponent and the points-allowed '
  + 'tiers. "Likely available" = outside the top N at the position by rest-of-season projection, N = league '
  + 'size × typical rostered per team. Sleeper has no roster % feed, so its trending adds are a demand '
  + 'signal only.';

const $ = id => document.getElementById(id);
const els = {
  view: $('view-tabs'), format: $('format-tabs'), league: $('league-size'), pos: $('pos-tabs'),
  horizon: $('horizon-tabs'), search: $('player-search'), head: $('rank-head'), body: $('rank-body'),
  rankings: $('rankings-view'), waivers: $('waiver-view'), list: $('waiver-list'),
  status: $('fan-status'), asOf: $('as-of'),
};

const state = { view: 'rankings', fmt: 'ppr', teams: 12, pos: 'QB', wpos: 'ALL', horizon: 'week',
                sortKey: 'proj', sortDir: -1 };
let data = null;
let byId = new Map();

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const num = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(d));
const pct = v => `${Math.round(v * 100)}%`;
const fmtK = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// --- settings persistence ---------------------------------------------------------

const PARAMS = { view: 'view', fmt: 'fmt', teams: 'teams', pos: 'pos', horizon: 'h' };
function readSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('bsm_nfl_fantasy') || '{}'); } catch { /* storage unavailable */ }
  const q = new URLSearchParams(location.search);
  for (const [k, p] of Object.entries(PARAMS)) {
    const v = q.get(p) ?? saved[k];
    if (v != null) state[k] = k === 'teams' ? Number(v) : v;
  }
  if (!VIEWS.some(v => v.key === state.view)) state.view = 'rankings';
  if (!FORMATS.some(f => f.key === state.fmt)) state.fmt = 'ppr';
  if (!LEAGUE_SIZES.includes(state.teams)) state.teams = 12;
  if (!RANK_POSITIONS.includes(state.pos)) state.pos = 'QB';
  if (!HORIZONS.some(h => h.key === state.horizon)) state.horizon = 'week';
}
function saveSettings() {
  const keep = Object.fromEntries(Object.keys(PARAMS).map(k => [k, state[k]]));
  try { localStorage.setItem('bsm_nfl_fantasy', JSON.stringify(keep)); } catch { /* storage unavailable */ }
  const url = new URL(location.href);
  for (const [k, p] of Object.entries(PARAMS)) url.searchParams.set(p, state[k]);
  history.replaceState(null, '', url);
}

// --- scoring ---------------------------------------------------------------------

function points(comp) {
  return pointsIn(comp, state.fmt);
}

function pointsIn(comp, fmt) {
  if (!comp) return 0;
  const { base, formats } = data.scoring;
  const rules = formats[fmt];
  let pts = 0;
  for (const [k, v] of Object.entries(comp)) pts += v * (rules[k] ?? base[k] ?? 0);
  return pts;
}

const statValue = (c, k) => {
  if (!c) return null;
  if (k === 'td') return (c.rush_td || 0) + (c.rec_td || 0);
  if (k === 'fg') return (c.fg_0_39 || 0) + (c.fg_40_49 || 0) + (c.fg_50 || 0);
  if (k === 'to') return (c.d_int || 0) + (c.fr || 0);
  return c[k] || 0;
};

const rosterCut = pos => Math.round(state.teams * ROSTER_PER_TEAM[pos]);

// Points under the current format, rest-of-season position ranks and the
// replacement level (the last "likely rostered" player) per position.
let repl = {};
function derive() {
  for (const p of data.players) {
    p.wk = p.week ? points(p.week) : null;
    p.rosPts = points(p.ros);
    p.rosPg = p.ros_games ? p.rosPts / p.ros_games : 0;
    p.l3Pts = p.gp ? points(p.l3) : null;
    p.avgPts = p.gp ? points(p.season) / p.gp : null;
  }
  repl = {};
  for (const pos of Object.keys(ROSTER_PER_TEAM)) {
    const list = data.players.filter(p => p.pos === pos).sort((a, b) => b.rosPts - a.rosPts);
    list.forEach((p, i) => { p.posRank = i + 1; });
    const cut = rosterCut(pos);
    const r = list[Math.min(cut, list.length) - 1];
    repl[pos] = { cut, pg: r ? r.rosPg : 0 };
  }
  for (const p of data.players) p.available = p.posRank > repl[p.pos].cut;
}

// --- shared bits -------------------------------------------------------------------

function segmented(el, items, current, attr) {
  el.innerHTML = items.map(it => `
    <button type="button" data-${attr}="${it.key}" aria-pressed="${it.key === current}"
            class="px-3 py-1.5 rounded-md text-sm transition-all ${it.key === current
              ? 'bg-amber-400 text-gray-900 font-bold' : 'text-gray-400 font-semibold hover:text-gray-200'}">${it.label}</button>`).join('');
}

function statusBadge(p) {
  const b = STATUS_BADGE[p.status];
  return b ? `<span class="text-[10px] font-bold px-1 rounded" style="color:${b[1]};border:1px solid ${b[1]}66" title="${esc(p.injury?.detail || p.status)}">${b[0]}</span>` : '';
}

function playerCell(p, extra = '') {
  return `
    <div class="flex items-center gap-2 min-w-0">
      <img src="${nflLogoUrl(p.team_name || '')}" alt="" class="w-6 h-6 object-contain shrink-0" onerror="this.style.visibility='hidden'">
      <div class="min-w-0">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="font-semibold text-gray-100 truncate">${esc(p.name)}</span>${statusBadge(p)}
        </div>
        <div class="text-[11px] text-gray-500">${esc(p.team)} · ${esc(p.pos)}${extra}</div>
      </div>
    </div>`;
}

function oppLabel(p) {
  if (p.week_state === 'bye') return '<span class="text-gray-500">BYE</span>';
  if (p.week_state === 'played') return '<span class="text-gray-500">Played</span>';
  return `${p.home ? 'vs' : '@'} ${esc(p.opp)}`;
}

function returnLabel(inj) {
  if (!inj) return '';
  if (inj.week == null) return 'out for season';
  return `est. back Wk ${inj.week}`;
}

// --- rankings ---------------------------------------------------------------------

function rankColumns() {
  const ros = state.horizon === 'ros';
  const cols = [
    { key: 'proj', label: ros ? 'ROS' : 'Proj', title: ros ? 'Projected points, rest of season' : 'Projected points this week',
      val: p => (ros ? p.rosPts : p.wk ?? -1), cell: p => `<span class="font-bold text-amber-400">${ros ? num(p.rosPts, 0) : (p.wk == null ? '–' : num(p.wk))}</span>` },
  ];
  if (ros) {
    cols.push({ key: 'pg', label: '/G', title: 'Projected points per remaining game', val: p => p.rosPg, cell: p => num(p.rosPg) });
    cols.push({ key: 'delta', label: 'Δ', title: 'Change in the PPR rest-of-season projection since the last update', wide: true,
                val: p => (p.ros_prev == null ? 0 : p.ros_ppr - p.ros_prev),
                cell: p => (p.ros_prev == null ? '' : deltaBadge(p.ros_ppr - p.ros_prev, { suffix: '', digits: 1, threshold: 0.5 })) });
  }
  for (const [k, label, d] of STAT_COLS[state.pos]) {
    cols.push({ key: `s_${k}`, label, title: `Projected ${label.toLowerCase()}${ros ? ' (rest of season)' : ''}`, wide: true, stat: true,
                val: p => statValue(ros ? p.ros : p.week, k) ?? -1,
                cell: p => { const v = statValue(ros ? p.ros : p.week, k); return v == null ? '–' : num(v, ros && d === 1 && v >= 10 ? 0 : d); } });
  }
  cols.push({ key: 'l3', label: 'L3', title: 'Average points over the last 3 games played', val: p => p.l3Pts ?? -1, cell: p => num(p.l3Pts) });
  cols.push({ key: 'avg', label: 'Avg', title: 'Average points per game this season', wide: true, val: p => p.avgPts ?? -1,
              cell: p => (p.avgPts == null ? '–' : `${num(p.avgPts)} <span class="text-gray-600 text-[10px]">${p.gp}g</span>`) });
  if (state.pos !== 'K' && state.pos !== 'DST') {
    cols.push({ key: 'trend', label: 'Trend', title: 'Usage trend: last 3 games vs earlier (snaps, target / carry / red-zone share, points)',
                val: p => p.trend?.score ?? -99, cell: p => trendCell(p.trend) });
  }
  return cols;
}

function trendCell(t) {
  if (!t) return '<span class="text-gray-600">–</span>';
  const s = t.score;
  const color = s >= 0.75 ? '#4ade80' : s >= 0.25 ? '#a3e635' : s <= -0.75 ? '#f87171' : s <= -0.25 ? '#fb923c' : '#9ca3af';
  const arrow = s >= 0.25 ? '▲' : s <= -0.25 ? '▼' : '•';
  return `<span style="color:${color}" class="font-semibold">${arrow} ${s > 0 ? '+' : ''}${s.toFixed(1)}</span>`;
}

function renderRankings() {
  const cols = rankColumns();
  const WIDE = 'hidden md:table-cell';
  const thCls = c => `${c.wide ? WIDE : ''} px-2 py-2 text-right font-semibold cursor-pointer select-none hover:text-gray-300`;
  const arrow = c => (state.sortKey === c.key ? (state.sortDir < 0 ? ' ↓' : ' ↑') : '');
  els.head.innerHTML = `
    <tr class="text-xs text-gray-500 uppercase tracking-wider">
      <th class="px-2 py-2 text-right font-semibold">#</th>
      <th class="px-2 py-2 text-left font-semibold">Player</th>
      <th class="px-2 py-2 text-left font-semibold">${state.horizon === 'ros' ? 'G' : 'Opp'}</th>
      ${cols.map(c => `<th class="${thCls(c)}" data-sort="${c.key}" title="${esc(c.title)}">${c.label}${arrow(c)}</th>`).join('')}
    </tr>`;

  const q = (els.search.value || '').trim().toLowerCase();
  const inPos = p => (state.pos === 'FLEX' ? FLEX.has(p.pos) : p.pos === state.pos);
  let rows = data.players.filter(inPos);
  const proj = cols[0].val;
  rows.sort((a, b) => proj(b) - proj(a));
  rows.forEach((p, i) => { p.viewRank = i + 1; });
  if (q) rows = rows.filter(p => `${p.name} ${p.team} ${p.team_name}`.toLowerCase().includes(q));
  const sortCol = cols.find(c => c.key === state.sortKey) || cols[0];
  if (sortCol !== cols[0] || state.sortDir > 0) rows.sort((a, b) => state.sortDir * (sortCol.val(a) - sortCol.val(b)));
  rows = rows.slice(0, q ? 200 : 150);

  if (!rows.length) {
    els.body.innerHTML = `<tr><td colspan="${cols.length + 3}" class="px-2 py-6 text-center text-sm text-gray-500">No players match.</td></tr>`;
    return;
  }
  const faTag = p => (p.pos in ROSTER_PER_TEAM && p.available
    ? ` · <span class="text-emerald-400" title="Outside the top ${repl[p.pos].cut} ${p.pos}s by rest-of-season projection — likely available in a ${state.teams}-team league">likely FA</span>` : '');
  els.body.innerHTML = rows.map(p => `
    <tr class="border-t border-gray-700/60 hover:bg-gray-700/20 ${p.available ? 'bg-emerald-900/5' : ''}">
      <td class="px-2 py-2 text-right tabular-nums text-gray-500">${p.viewRank}</td>
      <td class="px-2 py-2">${playerCell(p, faTag(p))}</td>
      <td class="px-2 py-2 text-left text-gray-400 whitespace-nowrap">${state.horizon === 'ros' ? p.ros_games : oppLabel(p)}</td>
      ${cols.map(c => `<td class="${c.wide ? WIDE : ''} px-2 py-2 text-right tabular-nums ${c.stat ? 'text-gray-400' : 'text-gray-300'}">${c.cell(p)}</td>`).join('')}
    </tr>`).join('');
}

// --- waiver wire -------------------------------------------------------------------

// Waiver score, in points per week: rest-of-season value vs the replacement
// level, this week's projection vs it, a usage-trend bump (the projection's
// usage weighting lags a sudden role change), extra weight on an opening
// created by an injured starter, and Sleeper demand.
function waiverScore(p) {
  const r = repl[p.pos].pg;
  const vor = p.rosPg - r;
  const wkTerm = p.wk != null ? p.wk - r : 0;
  const trend = p.trend ? Math.max(-2, Math.min(3, p.trend.score)) * 1.5 : 0;
  const inj = Math.max(0, ...p.links.map(l => points(l.uplift) * Math.min(l.weeks, 4) / 4)) * 0.5;
  const adds = p.sleeper?.adds ? Math.log10(1 + p.sleeper.adds) * 0.4 : 0;
  return 0.6 * vor + 0.4 * wkTerm + trend + inj + adds;
}

function waiverReasons(p) {
  const out = [];
  for (const l of p.links) {
    const s = byId.get(l.injured_id);
    const who = s ? `${esc(s.name)} (${esc(STATUS_BADGE[s.status]?.[0] || s.status || 'out')}, ${returnLabel(s.injury)})` : 'Injured starter';
    const weeks = l.return_week == null ? 'rest of season' : `~${l.weeks} wk${l.weeks === 1 ? '' : 's'}`;
    const src = l.source === 'espn' ? 'ESPN return date' : 'estimated';
    out.push(`<li><span class="text-gray-300">${who} out</span> → <span class="text-emerald-400 font-semibold">+${num(points(l.uplift))} pts/wk</span>
      <span class="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-300" title="${src}">${weeks}${l.source === 'espn' ? '' : ' (est.)'}</span></li>`);
  }
  const t = p.trend;
  if (t && t.score >= 0.25) {
    for (const [k, [label, min]] of Object.entries(TREND_LABELS)) {
      const a = t.base[k], b = t.recent[k];
      if (a != null && b != null && b - a >= min) out.push(`<li>${label} ${pct(a)} → <span class="text-emerald-400">${pct(b)}</span> <span class="text-gray-500">last ${t.n_recent}</span></li>`);
    }
    if (t.base.ppg != null && t.recent.ppg - t.base.ppg >= 4) out.push(`<li>PPR/game ${num(t.base.ppg)} → <span class="text-emerald-400">${num(t.recent.ppg)}</span> <span class="text-gray-500">last ${t.n_recent}</span></li>`);
  }
  if (p.sleeper?.adds >= 500) out.push(`<li><span class="text-sky-400">+${fmtK(p.sleeper.adds)}</span> Sleeper adds in 24h</li>`);
  if (p.ros_prev != null && p.ros_ppr - p.ros_prev >= 5) out.push(`<li>ROS projection up ${num(p.ros_ppr - p.ros_prev)} PPR since the last update</li>`);
  if ((p.pos === 'K' || p.pos === 'DST') && p.wk != null && p.wk - repl[p.pos].pg >= 1) out.push(`<li>Streamer: ${num(p.wk)} pts ${oppLabel(p)} this week</li>`);
  return out;
}

// Availability badge. "Likely": outside the projected rosters for this league
// size. "Potentially": projected to be rostered, but gaining fast enough that
// an inattentive league may not have picked him up yet. A gain is any of:
const GAIN = { link: 2.0, trend: 1.0, adds: 5000, rosJump: 10 };
// Week-one starters (league size x these) were drafted as such -- only a
// strong gain (an injury opening or a sharp role change) gets one listed.
const STARTER_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 };
const STRONG_GAIN = { link: 4.0, trend: 1.5 };
const SURGE_WEIGHT = 0.5;   // last-3 scoring is noisy: count half the jump
const SURGE_ROLE_KEPT = 0.5; // ...and only if ROS points/game are at least half the recent rate

function potentiallyAvailable(p) {
  const link = Math.max(0, ...p.links.map(l => points(l.uplift)));
  const trend = p.trend?.score ?? 0;
  const gain = link >= GAIN.link || trend >= GAIN.trend || (p.sleeper?.adds ?? 0) >= GAIN.adds
    || (p.ros_prev != null && p.ros_ppr - p.ros_prev >= GAIN.rosJump);
  if (!gain) return false;
  if (p.posRank > state.teams * STARTER_SLOTS[p.pos]) return true;
  return link >= STRONG_GAIN.link || trend >= STRONG_GAIN.trend;
}

// Increase in fantasy value, points per week under the current format: the
// largest of an injured starter's vacated role, the recent scoring surge
// (trend metrics are PPR, rescaled by the player's own format/PPR ratio), the
// rest-of-season projection jump per game, and -- for K / DST -- this week's
// streaming edge over the replacement level.
function valueGain(p) {
  const pprSeason = pointsIn(p.season, 'ppr');
  const scale = pprSeason > 0 ? points(p.season) / pprSeason : 1;
  const link = Math.max(0, ...p.links.map(l => points(l.uplift)));
  // A surge only counts while the projection still sees the bigger role (a
  // backup who filled in for a starter now back isn't a pickup).
  const t = p.trend;
  const surge = t && t.base.ppg != null && p.rosPg >= SURGE_ROLE_KEPT * t.recent.ppg * scale
    ? SURGE_WEIGHT * Math.max(0, t.recent.ppg - t.base.ppg) * scale : 0;
  const jump = p.ros_prev != null && p.ros_games ? Math.max(0, p.ros_ppr - p.ros_prev) / p.ros_games * scale : 0;
  const stream = (p.pos === 'K' || p.pos === 'DST') && p.wk != null ? Math.max(0, p.wk - repl[p.pos].pg) : 0;
  return Math.max(link, surge, jump, stream);
}

function renderWaivers() {
  const q = (els.search.value || '').trim().toLowerCase();
  let list = data.players.filter(p => p.pos in ROSTER_PER_TEAM && p.ros_games > 0
    && !['ir', 'out', 'inactive'].includes(p.status)
    && (state.wpos === 'ALL' || (state.wpos === 'FLEX' ? FLEX.has(p.pos) : p.pos === state.wpos))
    && (!q || `${p.name} ${p.team} ${p.team_name}`.toLowerCase().includes(q)));
  for (const p of list) {
    p.badge = p.available ? 'likely' : (potentiallyAvailable(p) ? 'potentially' : null);
    if (p.badge) { p.gain = valueGain(p); p.wScore = waiverScore(p); p.reasons = waiverReasons(p); }
  }
  list = list.filter(p => p.badge && p.gain > 0.05)
    .sort((a, b) => b.gain - a.gain || b.wScore - a.wScore).slice(0, 50);
  if (!list.length) {
    els.list.innerHTML = '<tr><td colspan="6" class="px-2 py-6 text-center text-sm text-gray-500">No waiver targets match.</td></tr>';
    return;
  }
  els.list.innerHTML = list.map((p, i) => `
    <tr class="border-t border-gray-700/60 hover:bg-gray-700/20 align-top">
      <td class="px-2 py-2 text-right tabular-nums text-gray-500">${i + 1}</td>
      <td class="px-2 py-2">
        ${playerCell(p, ` · ${p.pos}${p.posRank} ROS<span class="sm:hidden"> · ${oppLabel(p)}</span> ${availBadge(p)}`)}
        ${p.reasons.length ? `<ul class="mt-1 ml-8 space-y-0.5 text-xs text-gray-400 list-disc pl-4">${p.reasons.join('')}</ul>` : ''}
      </td>
      <td class="hidden sm:table-cell px-2 py-2 text-left text-gray-400 whitespace-nowrap">${oppLabel(p)}</td>
      <td class="px-2 py-2 text-right tabular-nums font-bold text-emerald-400">+${num(p.gain)}</td>
      <td class="px-2 py-2 text-right tabular-nums font-bold text-amber-400">${p.wk == null ? '–' : num(p.wk)}</td>
      <td class="hidden sm:table-cell px-2 py-2 text-right tabular-nums text-gray-300 whitespace-nowrap">${num(p.rosPg)}
        <div class="text-[10px] text-gray-600" title="Replacement level: the last likely-rostered ${p.pos} in a ${state.teams}-team league">repl. ${num(repl[p.pos].pg)}</div></td>
    </tr>`).join('');
}

function availBadge(p) {
  return p.badge === 'likely'
    ? `<span class="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-900/60 text-emerald-300" title="Outside the projected top ${repl[p.pos].cut} ${p.pos}s — likely on waivers in a ${state.teams}-team league">Likely available</span>`
    : `<span class="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-sky-900/60 text-sky-300" title="Projected to be rostered (${p.pos}${p.posRank}) but rising fast — check whether your league has picked him up">Potentially available</span>`;
}

// --- render / controls --------------------------------------------------------------

function render() {
  if (!data) return;
  segmented(els.view, VIEWS, state.view, 'view');
  segmented(els.format, FORMATS, state.fmt, 'fmt');
  els.league.value = String(state.teams);
  const waivers = state.view === 'waivers';
  segmented(els.pos, (waivers ? WAIVER_POSITIONS : RANK_POSITIONS).map(k => ({ key: k, label: k === 'ALL' ? 'All' : k })),
            waivers ? state.wpos : state.pos, 'pos');
  els.horizon.classList.toggle('hidden', waivers);
  if (!waivers) segmented(els.horizon, HORIZONS, state.horizon, 'horizon');
  els.rankings.classList.toggle('hidden', waivers);
  els.waivers.classList.toggle('hidden', !waivers);
  if (waivers) renderWaivers(); else renderRankings();
  saveSettings();
}

function onClick(attr, apply) {
  return e => {
    const b = e.target.closest(`[data-${attr}]`);
    if (b) { apply(b.dataset[attr]); render(); }
  };
}
els.view.addEventListener('click', onClick('view', v => { state.view = v; }));
els.format.addEventListener('click', onClick('fmt', v => { state.fmt = v; derive(); }));
els.horizon.addEventListener('click', onClick('horizon', v => { state.horizon = v; state.sortKey = 'proj'; state.sortDir = -1; }));
els.pos.addEventListener('click', onClick('pos', v => {
  if (state.view === 'waivers') state.wpos = v;
  else { state.pos = v; if (state.sortKey.startsWith('s_')) { state.sortKey = 'proj'; state.sortDir = -1; } }
}));
els.head.addEventListener('click', onClick('sort', k => {
  if (state.sortKey === k) state.sortDir = -state.sortDir;
  else { state.sortKey = k; state.sortDir = -1; }
}));
els.league.addEventListener('change', () => { state.teams = Number(els.league.value); derive(); render(); });
els.search.addEventListener('input', () => { if (data) (state.view === 'waivers' ? renderWaivers : renderRankings)(); });
$('method-note').textContent = METHOD;

function skeleton() {
  els.body.innerHTML = Array.from({ length: 12 }, () => `
    <tr class="border-t border-gray-700/60"><td colspan="10" class="px-2 py-2.5"><span class="bsm-skeleton h-4 w-full block"></span></td></tr>`).join('');
}

async function load() {
  readSettings();
  skeleton();
  els.status.textContent = 'Loading fantasy projections…';
  try {
    const res = await fetch(apiUrl('nfl', 'fantasy'));
    if (!res.ok) throw new Error(res.status === 404 ? 'No fantasy projections yet — they appear after the next model run.' : `HTTP ${res.status}`);
    data = await res.json();
    byId = new Map(data.players.map(p => [p.id, p]));
    derive();
    const gen = new Date(data.generated_at);
    els.asOf.textContent = `Week ${data.week}${isNaN(gen) ? '' : ` · updated ${gen.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}`;
    els.status.textContent = `${data.players.length} players and defenses · ${data.season} season`;
    render();
  } catch (e) {
    els.body.innerHTML = '';
    els.status.textContent = e.message.startsWith('No fantasy') ? e.message : 'Could not load fantasy projections. Try again in a moment.';
  }
}

load();
