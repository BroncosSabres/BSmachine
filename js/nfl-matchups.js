// nfl-matchups.js — drives nfl/pages/matchups.html
import { apiUrl } from './api-config.js';
import { nflLogoUrl } from './nfl-logos.js';
import { openDistModal } from './nfl-distribution-chart.js';

const gamesList   = document.getElementById('games-list');
const noGamesMsg  = document.getElementById('no-games-msg');
const weekBadge   = document.getElementById('week-badge');
const prevBtn     = document.getElementById('week-prev');
const nextBtn     = document.getElementById('week-next');

let currentWeek = null;
let gamesById   = {};

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function probBar(g) {
  const homeP = g.home_perc ?? 0;
  const awayP = g.away_perc ?? 0;
  const tieP  = g.tie_perc  ?? 0;
  const home  = homeP * 100;
  const away  = awayP * 100;
  const tie   = tieP  * 100;
  const homeWin   = homeP >= awayP;
  const homeOdds  = homeP >= 1e-6 ? (1 / homeP).toFixed(2) : null;
  const awayOdds  = awayP >= 1e-6 ? (1 / awayP).toFixed(2) : null;

  return `
    <div class="mt-3">
      <div class="flex justify-between items-end text-base font-bold mb-1.5">
        <div class="flex flex-col items-start">
          <span class="${homeWin ? 'text-white' : 'text-gray-300'}">${home.toFixed(1)}%</span>
          ${homeOdds ? `<span class="text-xs font-semibold text-gray-400">$${homeOdds}</span>` : ''}
        </div>
        ${tie > 0.5 ? `<span class="text-xs font-normal text-gray-500 self-center">${tie.toFixed(1)}% tie</span>` : '<span></span>'}
        <div class="flex flex-col items-end">
          <span class="${!homeWin ? 'text-white' : 'text-gray-300'}">${away.toFixed(1)}%</span>
          ${awayOdds ? `<span class="text-xs font-semibold text-gray-400">$${awayOdds}</span>` : ''}
        </div>
      </div>
      <div class="flex h-2 rounded-full overflow-hidden bg-gray-700">
        <div style="width:${home}%; background:#4ade80; opacity:${homeWin ? '1' : '0.5'}"></div>
        ${tie > 0.5 ? `<div style="width:${tie}%; background:#6b7280"></div>` : ''}
        <div style="width:${away}%; background:#f87171; opacity:${!homeWin ? '1' : '0.5'}"></div>
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
      ${g.has_prediction ? distButton(g) : ''}
    </div>
  `;
}

function distButton(g) {
  return `
    <button class="js-nfl-dist-btn w-full flex items-center justify-center gap-1.5 mt-3 px-2.5 py-1 rounded-lg border border-gray-600 hover:border-amber-500 hover:text-amber-400 transition-colors text-xs text-gray-400 font-medium"
            style="background:rgba(255,255,255,0.04);cursor:pointer;" data-game-id="${g.game_id}">
      <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" style="flex-shrink:0;opacity:0.85"><rect x="1" y="10" width="3" height="9" rx="1"/><rect x="6" y="6" width="3" height="13" rx="1"/><rect x="11" y="3" width="3" height="16" rx="1"/><rect x="16" y="7" width="3" height="12" rx="1"/></svg>
      Show Probability Distributions
    </button>`;
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
  gamesById = Object.fromEntries(games.map(g => [g.game_id, g]));
  if (!games.length) {
    noGamesMsg.classList.remove('hidden');
    return;
  }
  gamesList.innerHTML = games.map(gameCard).join('');
}

gamesList.addEventListener('click', e => {
  const btn = e.target.closest('.js-nfl-dist-btn');
  if (!btn) return;
  const g = gamesById[Number(btn.dataset.gameId)];
  if (!g) return;
  const hasResult = g.is_finished && g.home_score != null && g.away_score != null;
  openDistModal(
    `${g.home_team} vs ${g.away_team}`,
    g.game_id,
    hasResult ? g.home_score - g.away_score : null,
    hasResult ? g.home_score + g.away_score : null,
  );
});

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
