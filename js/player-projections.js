// player-projections.js — drives nhl/pages/player_projections.html and
// nfl/pages/player_projections.html (sport from the page's data-sport).
//
// Projected regular-season leaders from /api/<sport>/player_projections:
// season-to-date + projected remaining = projected total, plus each player's
// chance to finish first / top 5 / top 10. Team scoring in every remaining
// game comes from the model runs; the split across players reuses the Multi
// Builder player models (see nrl-flask-backend/player_projections.py).
import { apiUrl } from './api-config.js';
import { probColor } from './rankings-shared.js';
import { nhlLogoUrl } from './nhl-logos.js';
import { nflLogoUrl } from './nfl-logos.js';

const SPORTS = {
  nhl: {
    logo: nhlLogoUrl,
    stats: [
      { key: 'points', label: 'Points', unit: 'PTS', note: 'goals + assists' },
      { key: 'goals', label: 'Goals', unit: 'G' },
      { key: 'assists', label: 'Assists', unit: 'A' },
    ],
    method: 'Team goals in every remaining game come from the season simulation (opponent, venue and '
      + 'in-season rating changes included; shootout winners excluded). Each goal is split across the roster '
      + 'by projected ice time × goal / assist rates per 60 — the Multi Builder model — weighted by each '
      + "player's chance to dress. Current injuries apply for the next 5 games; short-term absences are assumed "
      + 'back after that, IR / LTIR players stay out.',
  },
  nfl: {
    logo: nflLogoUrl,
    stats: [
      { key: 'pass_td', label: 'Passing TDs', unit: 'TD' },
      { key: 'rush_td', label: 'Rushing TDs', unit: 'TD' },
      { key: 'rec_td', label: 'Receiving TDs', unit: 'TD' },
    ],
    method: 'Team touchdowns in every remaining game come from the match simulation (weather by venue / month '
      + 'climatology, or the forecast once one exists). Each TD is split by the Multi Builder model — rushing '
      + 'vs passing mix, red-zone and overall usage shares, the starting QB for passing TDs — weighted by each '
      + "player's chance to play. This week's injury report applies to the next game; short-term absences are "
      + 'assumed back after that, IR players stay out.',
  },
};

const sport = document.body.dataset.sport;
const cfg = SPORTS[sport];
const $ = id => document.getElementById(id);
const tabs = $('stat-tabs');
const tbody = $('proj-body');
const statusEl = $('proj-status');
const asOfEl = $('as-of');
const searchEl = $('player-search');
const unitHead = $('unit-head');

const cache = {};          // stat -> response
let currentStat = null;
let loadSeq = 0;

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// Columns hidden on phones (GP, remaining, top 5) so the totals and lead odds fit.
const WIDE = 'hidden sm:table-cell';
const pctCell = (p, cls = '') => {
  if (p == null) return `<td class="${cls} px-2 py-2 text-right tabular-nums text-gray-600">–</td>`;
  const txt = p >= 0.995 ? '>99%' : p > 0 && p < 0.001 ? '<0.1%' : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
  return `<td class="${cls} px-2 py-2 text-right tabular-nums" style="${probColor(p)}">${txt}</td>`;
};

function readTab() {
  try { return new URLSearchParams(location.search).get('stat') || localStorage.getItem(`bsm_proj_${sport}`); } catch { return null; }
}
function saveTab(stat) {
  try { localStorage.setItem(`bsm_proj_${sport}`, stat); } catch { /* storage unavailable */ }
  const url = new URL(location.href);
  url.searchParams.set('stat', stat);
  history.replaceState(null, '', url);
}

function renderTabs() {
  tabs.innerHTML = cfg.stats.map(s => `
    <button type="button" data-stat="${s.key}" role="tab" aria-selected="${s.key === currentStat}"
            class="px-4 py-1.5 rounded-md text-sm transition-all ${s.key === currentStat
              ? 'bg-amber-400 text-gray-900 font-bold' : 'text-gray-400 font-semibold hover:text-gray-200'}">${s.label}</button>`).join('');
}

function skeleton() {
  tbody.innerHTML = Array.from({ length: 12 }, () => `
    <tr class="border-t border-gray-700/60"><td colspan="9" class="px-2 py-2.5"><span class="bsm-skeleton h-4 w-full block"></span></td></tr>`).join('');
}

function renderRows() {
  const data = cache[currentStat];
  if (!data) return;
  const q = (searchEl.value || '').trim().toLowerCase();
  const rows = data.rows.map((r, i) => ({ ...r, rank: i + 1 }))
    .filter(r => !q || `${r.name} ${r.team} ${r.team_name}`.toLowerCase().includes(q));
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="px-2 py-6 text-center text-sm text-gray-500">No players match.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr class="border-t border-gray-700/60 hover:bg-gray-700/20">
      <td class="px-2 py-2 text-right tabular-nums text-gray-500">${r.rank}</td>
      <td class="px-2 py-2">
        <div class="flex items-center gap-2 min-w-0">
          <img src="${cfg.logo(r.team_name || '')}" alt="" class="w-6 h-6 object-contain shrink-0" onerror="this.style.visibility='hidden'">
          <div class="min-w-0">
            <div class="font-semibold text-gray-100 truncate">${esc(r.name)}</div>
            <div class="text-[11px] text-gray-500">${esc(r.team || '–')} · ${esc(r.pos || '–')}</div>
          </div>
        </div>
      </td>
      <td class="${WIDE} px-2 py-2 text-right tabular-nums text-gray-400">${r.gp}</td>
      <td class="px-2 py-2 text-right tabular-nums text-gray-300">${r.to_date}</td>
      <td class="${WIDE} px-2 py-2 text-right tabular-nums text-gray-400">+${r.proj_remaining.toFixed(1)}</td>
      <td class="px-2 py-2 text-right tabular-nums font-bold text-amber-400">${r.proj_total.toFixed(1)}</td>
      ${pctCell(r.p_lead)}${pctCell(r.p_top5, WIDE)}${pctCell(r.p_top10)}
    </tr>`).join('');
}

async function load(stat) {
  currentStat = stat;
  saveTab(stat);
  renderTabs();
  const meta = cfg.stats.find(s => s.key === stat);
  unitHead.textContent = meta.unit;
  unitHead.title = meta.note || '';
  if (cache[stat]) { renderRows(); return; }
  const seq = ++loadSeq;
  skeleton();
  statusEl.textContent = 'Loading projections…';
  try {
    const res = await fetch(apiUrl(sport, `player_projections?stat=${stat}&limit=100`));
    if (!res.ok) throw new Error(res.status === 404 ? 'No projections yet — they appear after the next model run.' : `HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== loadSeq) return;
    cache[stat] = data;
    const asOf = new Date(data.as_of);
    asOfEl.textContent = isNaN(asOf) ? `Model run ${data.as_of}` : `Model run ${asOf.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    statusEl.textContent = `${data.n_sims.toLocaleString()} simulated seasons · ties for a place share it evenly`;
    renderRows();
  } catch (e) {
    if (seq !== loadSeq) return;
    tbody.innerHTML = '';
    statusEl.textContent = e.message.startsWith('No projections') ? e.message : 'Could not load projections. Try again in a moment.';
  }
}

tabs.addEventListener('click', e => {
  const b = e.target.closest('[data-stat]');
  if (b && b.dataset.stat !== currentStat) load(b.dataset.stat);
});
searchEl.addEventListener('input', renderRows);
$('method-note').textContent = cfg.method;

const initial = readTab();
load(cfg.stats.some(s => s.key === initial) ? initial : cfg.stats[0].key);
