// nfl-matchups.js — drives nfl/pages/matchups.html
import { apiUrl } from './api-config.js';
import { nflLogoUrl } from './nfl-logos.js';

const gamesList   = document.getElementById('games-list');
const noGamesMsg  = document.getElementById('no-games-msg');
const weekBadge   = document.getElementById('week-badge');
const prevBtn     = document.getElementById('week-prev');
const nextBtn     = document.getElementById('week-next');

let currentWeek = null;

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function probBar(g) {
  const home = (g.home_perc ?? 0) * 100;
  const away = (g.away_perc ?? 0) * 100;
  const tie  = (g.tie_perc  ?? 0) * 100;
  return `
    <div class="mt-3">
      <div class="flex justify-between text-xs text-gray-400 mb-1">
        <span>${home.toFixed(0)}%</span>
        ${tie > 0.5 ? `<span>${tie.toFixed(0)}% tie</span>` : '<span></span>'}
        <span>${away.toFixed(0)}%</span>
      </div>
      <div class="flex h-2 rounded-full overflow-hidden bg-gray-700">
        <div style="width:${home}%; background:#4ade80"></div>
        ${tie > 0.5 ? `<div style="width:${tie}%; background:#6b7280"></div>` : ''}
        <div style="width:${away}%; background:#f87171"></div>
      </div>
    </div>
  `;
}

function renderScore(g) {
  if (g.is_finished) {
    return `<div class="text-2xl font-bold font-mono">${g.home_score} &ndash; ${g.away_score}</div>
            <div class="text-xs text-gray-500 mt-1">Final</div>`;
  }
  if (g.has_prediction) {
    return `<div class="text-2xl font-bold font-mono text-gray-300">${g.exp_home_score} &ndash; ${g.exp_away_score}</div>
            <div class="text-xs text-gray-500 mt-1">Predicted</div>`;
  }
  return `<div class="text-sm text-gray-500">vs</div>`;
}

function gameCard(g) {
  return `
    <div class="card">
      <div class="flex items-center justify-between text-xs text-gray-500 mb-3">
        <span>${formatDate(g.date)}</span>
        <span>${g.venue || ''}</span>
      </div>
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <img src="${nflLogoUrl(g.home_team)}" class="w-8 h-8 object-contain shrink-0" onerror="this.style.display='none'">
          <span class="font-semibold truncate">${g.home_team}</span>
        </div>
        <div class="text-center px-4 shrink-0">
          ${renderScore(g)}
        </div>
        <div class="flex items-center gap-2 flex-1 min-w-0 justify-end">
          <span class="font-semibold truncate">${g.away_team}</span>
          <img src="${nflLogoUrl(g.away_team)}" class="w-8 h-8 object-contain shrink-0" onerror="this.style.display='none'">
        </div>
      </div>
      ${g.has_prediction && !g.is_finished ? probBar(g) : ''}
      ${!g.has_prediction ? '<p class="text-center text-gray-500 text-xs mt-3">Prediction not yet available</p>' : ''}
    </div>
  `;
}

async function loadWeek(week) {
  gamesList.innerHTML = '';
  noGamesMsg.classList.add('hidden');
  weekBadge.textContent = `Week ${week}`;

  const res = await fetch(apiUrl('nfl', `week_predictions/${week}`));
  if (!res.ok) return;
  const json = await res.json();
  currentWeek = json.week_number ?? week;
  weekBadge.textContent = `Week ${currentWeek}`;

  const games = json.predictions || [];
  if (!games.length) {
    noGamesMsg.classList.remove('hidden');
    return;
  }
  gamesList.innerHTML = games.map(gameCard).join('');
}

prevBtn.addEventListener('click', () => {
  if (currentWeek == null || currentWeek <= 1) return;
  loadWeek(currentWeek - 1);
});
nextBtn.addEventListener('click', () => {
  if (currentWeek == null) return;
  loadWeek(currentWeek + 1);
});

async function init() {
  const params = new URLSearchParams(window.location.search);
  const requestedWeek = params.get('week');
  if (requestedWeek) {
    loadWeek(parseInt(requestedWeek, 10));
    return;
  }
  const res = await fetch(apiUrl('nfl', 'current_week'));
  if (res.ok) {
    const json = await res.json();
    loadWeek(json.week_number);
  }
}

init();
