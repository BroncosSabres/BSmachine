// nhl-matchups.js — drives nhl/pages/matchups.html
// Unlike nfl-matchups.js (which pages through individual weeks via a
// week-number route), NHL has no week concept - bs_machine_nhl.py only ever
// predicts a rolling forward window of games (MATCH_PREDICTION_WINDOW_DAYS),
// so this fetches that window once via /api/nhl/upcoming_predictions, groups
// it by calendar date client-side, and pages prev/next through those dates.
import { apiUrl } from './api-config.js';
import { nhlLogoUrl } from './nhl-logos.js';
import { openDistModal } from './nhl-distribution-chart.js';

const gamesList   = document.getElementById('games-list');
const noGamesMsg  = document.getElementById('no-games-msg');
const dateBadge   = document.getElementById('week-badge');
const prevBtn     = document.getElementById('week-prev');
const nextBtn     = document.getElementById('week-next');

const WINDOW_DAYS = 14; // comfortably covers bs_machine_nhl.py's forward prediction window plus buffer

let dateKeys    = [];
let gamesByDate = {};
let currentIdx  = 0;
let gamesById   = {};

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function dateKeyOf(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toDateString();
}

function probBar(g) {
  const homeP = g.home_perc ?? 0;
  const awayP = g.away_perc ?? 0;
  const otP   = g.overtime_perc ?? 0;
  const soP   = g.shootout_perc ?? 0;
  const home  = homeP * 100;
  const away  = awayP * 100;
  const homeWin   = homeP >= awayP;
  const homeOdds  = homeP >= 1e-6 ? (1 / homeP).toFixed(2) : null;
  const awayOdds  = awayP >= 1e-6 ? (1 / awayP).toFixed(2) : null;
  const extraPct  = ((otP + soP) * 100).toFixed(0);

  return `
    <div class="mt-3">
      <div class="flex justify-between items-end text-base font-bold mb-1.5">
        <div class="flex flex-col items-start">
          <span class="${homeWin ? 'text-white' : 'text-gray-300'}">${home.toFixed(1)}%</span>
          ${homeOdds ? `<span class="text-xs font-semibold text-gray-400">$${homeOdds}</span>` : ''}
        </div>
        ${(otP + soP) > 0.005 ? `<span class="text-xs font-normal text-gray-500 self-center">${extraPct}% to OT/SO</span>` : '<span></span>'}
        <div class="flex flex-col items-end">
          <span class="${!homeWin ? 'text-white' : 'text-gray-300'}">${away.toFixed(1)}%</span>
          ${awayOdds ? `<span class="text-xs font-semibold text-gray-400">$${awayOdds}</span>` : ''}
        </div>
      </div>
      <div class="flex h-2 rounded-full overflow-hidden bg-gray-700">
        <div style="width:${home}%; background:#4ade80; opacity:${homeWin ? '1' : '0.5'}"></div>
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
    return `<div class="text-2xl font-bold font-mono text-gray-300">${g.exp_home_score.toFixed(2)} &ndash; ${g.exp_away_score.toFixed(2)}</div>
            <div class="text-xs text-gray-500 mt-1">Predicted</div>`;
  }
  return `<div class="text-sm text-gray-500">vs</div>`;
}

function distButton(g) {
  return `
    <button class="js-nhl-dist-btn w-full flex items-center justify-center gap-1.5 mt-3 px-2.5 py-1 rounded-lg border border-gray-600 hover:border-amber-500 hover:text-amber-400 transition-colors text-xs text-gray-400 font-medium"
            style="background:rgba(255,255,255,0.04);cursor:pointer;" data-game-id="${g.game_id}">
      <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" style="flex-shrink:0;opacity:0.85"><rect x="1" y="10" width="3" height="9" rx="1"/><rect x="6" y="6" width="3" height="13" rx="1"/><rect x="11" y="3" width="3" height="16" rx="1"/><rect x="16" y="7" width="3" height="12" rx="1"/></svg>
      Show Probability Distributions
    </button>`;
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
          <img src="${nhlLogoUrl(g.home_team)}" class="w-8 h-8 object-contain shrink-0" onerror="this.style.display='none'">
          <span class="font-semibold truncate">${g.home_team}</span>
        </div>
        <div class="text-center px-4 shrink-0">
          ${renderScore(g)}
        </div>
        <div class="flex items-center gap-2 flex-1 min-w-0 justify-end">
          <span class="font-semibold truncate">${g.away_team}</span>
          <img src="${nhlLogoUrl(g.away_team)}" class="w-8 h-8 object-contain shrink-0" onerror="this.style.display='none'">
        </div>
      </div>
      ${g.has_prediction && !g.is_finished ? probBar(g) : ''}
      ${!g.has_prediction ? '<p class="text-center text-gray-500 text-xs mt-3">Prediction not yet available</p>' : ''}
      ${g.has_prediction ? distButton(g) : ''}
    </div>
  `;
}

function renderCurrentDate() {
  const key = dateKeys[currentIdx];
  gamesList.innerHTML = '';
  noGamesMsg.classList.add('hidden');

  if (!key) {
    dateBadge.textContent = 'No games';
    noGamesMsg.classList.remove('hidden');
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  const games = gamesByDate[key] || [];
  dateBadge.textContent = formatDate(games[0]?.date) || key;
  gamesById = Object.fromEntries(games.map(g => [g.game_id, g]));

  if (!games.length) {
    noGamesMsg.classList.remove('hidden');
  } else {
    gamesList.innerHTML = games.map(gameCard).join('');
  }

  prevBtn.disabled = currentIdx <= 0;
  nextBtn.disabled = currentIdx >= dateKeys.length - 1;
}

gamesList.addEventListener('click', e => {
  const btn = e.target.closest('.js-nhl-dist-btn');
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
  if (currentIdx <= 0) return;
  currentIdx -= 1;
  renderCurrentDate();
});
nextBtn.addEventListener('click', () => {
  if (currentIdx >= dateKeys.length - 1) return;
  currentIdx += 1;
  renderCurrentDate();
});

async function init() {
  const res = await fetch(apiUrl('nhl', `upcoming_predictions?days=${WINDOW_DAYS}`));
  if (!res.ok) { renderCurrentDate(); return; }
  const json = await res.json();
  const games = json.predictions || [];

  gamesByDate = {};
  games.forEach(g => {
    const key = dateKeyOf(g.date);
    if (!key) return;
    (gamesByDate[key] = gamesByDate[key] || []).push(g);
  });
  dateKeys = Object.keys(gamesByDate).sort((a, b) => new Date(a) - new Date(b));

  // Default to today (or the next date with games, if today has none).
  const todayKey = new Date().toDateString();
  const todayIdx = dateKeys.findIndex(k => new Date(k) >= new Date(todayKey));
  currentIdx = todayIdx >= 0 ? todayIdx : 0;

  renderCurrentDate();
}

init();
