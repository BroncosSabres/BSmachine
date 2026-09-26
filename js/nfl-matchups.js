// nfl-matchups.js — drives nfl/pages/matchups.html
import { apiUrl } from './api-config.js';
import { nflLogoUrl } from './nfl-logos.js';
import { openDistModal } from './nfl-distribution-chart.js';
import { createMatchLinesController } from './match-lines.js';

const gamesList   = document.getElementById('games-list');
const noGamesMsg  = document.getElementById('no-games-msg');
const weekBadge   = document.getElementById('week-badge');
const prevBtn     = document.getElementById('week-prev');
const nextBtn     = document.getElementById('week-next');
const sortBtn     = document.getElementById('sort-lines-btn');
const resetBtn    = document.getElementById('reset-lines-btn');

let currentWeek = null;
let gamesById   = {};

const gameDistCache = {};
async function fetchGameDistribution(gameId) {
  if (gameDistCache[gameId]) return gameDistCache[gameId];
  try {
    const res  = await fetch(apiUrl('nfl', `game_score_distributions/${gameId}`));
    const data = await res.json();
    if (data.error) return null;
    gameDistCache[gameId] = data;
    return data;
  } catch {
    return null;
  }
}

const matchLines = createMatchLinesController({
  storageKey: 'bsmachine_match_lines_nfl',
  fetchDistribution: fetchGameDistribution,
});
let lineSortMode = 'default'; // 'default' (schedule order) | 'discrepant'

// --- RESULT COMPARISON (finished games): actual score vs. predicted, plus how likely
// the BS Machine thought that exact result was, ranked against every other final score
// this season. Mirrors the NRL predictions page's "Result" treatment.

// Interpolates red→amber→green based on a 0–1 position (0 = red, 1 = green)
function bucketColor(fraction) {
  const stops = [
    { r: 244, g: 63,  b: 94  }, // 0%   rose-500
    { r: 251, g: 146, b: 60  }, // 25%  orange-400
    { r: 250, g: 204, b: 21  }, // 50%  yellow-400
    { r: 163, g: 230, b: 53  }, // 75%  lime-400
    { r: 74,  g: 222, b: 128 }, // 100% green-400
  ];
  const scaled = Math.max(0, Math.min(1, fraction)) * (stops.length - 1);
  const lo = Math.floor(scaled), hi = Math.min(lo + 1, stops.length - 1);
  const t  = scaled - lo;
  const a  = stops[lo], b = stops[hi];
  const r  = Math.round(a.r + (b.r - a.r) * t);
  const g  = Math.round(a.g + (b.g - a.g) * t);
  const bv = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bv})`;
}

const lineProbCache = {};

async function fetchResultLineProb(gameId, homeScore, awayScore) {
  const margin = homeScore - awayScore;
  if (margin === 0) return null;
  const cacheKey = `${gameId}_${margin}`;
  if (cacheKey in lineProbCache) return lineProbCache[cacheKey];
  const params = margin > 0 ? `margin_gte=${margin}` : `margin_lte=${margin}`;
  try {
    const res = await fetch(apiUrl('nfl', `game_sgm_bins_range/${gameId}?${params}`));
    const data = await res.json();
    const prob = typeof data.prob === 'number' ? data.prob : null;
    lineProbCache[cacheKey] = prob;
    return prob;
  } catch {
    lineProbCache[cacheKey] = null;
    return null;
  }
}

// Over X.5 = total_gte of the actual total; complement is under
async function fetchTotalProb(gameId, total) {
  const cacheKey = `total_${gameId}_${total}`;
  if (cacheKey in lineProbCache) return lineProbCache[cacheKey];
  try {
    const res = await fetch(apiUrl('nfl', `game_sgm_bins_range/${gameId}?total_gte=${total}`));
    const data = await res.json();
    const prob = typeof data.prob === 'number' ? data.prob : null;
    lineProbCache[cacheKey] = prob;
    return prob;
  } catch {
    lineProbCache[cacheKey] = null;
    return null;
  }
}

const weekPredictionsCache = {};
async function fetchWeekPredictions(week) {
  if (weekPredictionsCache[week]) return weekPredictionsCache[week];
  try {
    const res = await fetch(apiUrl('nfl', `week_predictions/${week}`));
    const json = await res.json();
    const preds = (json.predictions || []).filter(p => p.has_prediction);
    weekPredictionsCache[week] = preds;
    return preds;
  } catch {
    return [];
  }
}

// Season-wide ranked list of result-margin probabilities (least likely first).
// Rebuilt whenever the visible week changes — see loadWeek() — since the pool of
// finished games it draws from grows as the season progresses.
let seasonRankingCache = null;
async function buildSeasonRanking() {
  if (seasonRankingCache) return seasonRankingCache;
  const weekNums = [];
  for (let w = 1; w <= currentWeek; w++) weekNums.push(w);
  const allGames = (await Promise.all(weekNums.map(fetchWeekPredictions))).flat();

  const entries = await Promise.all(
    allGames
      .filter(g => typeof g.home_score === 'number' && typeof g.away_score === 'number' && g.home_score !== g.away_score)
      .map(async g => {
        const prob = await fetchResultLineProb(g.game_id, g.home_score, g.away_score);
        if (prob === null) return null;
        return { game_id: g.game_id, prob };
      })
  );

  seasonRankingCache = entries.filter(Boolean).sort((a, b) => a.prob - b.prob);
  return seasonRankingCache;
}

// Season-wide ranked list of total-points probabilities (least likely first)
let totalRankingCache = null;
async function buildTotalRanking() {
  if (totalRankingCache) return totalRankingCache;
  const weekNums = [];
  for (let w = 1; w <= currentWeek; w++) weekNums.push(w);
  const allGames = (await Promise.all(weekNums.map(fetchWeekPredictions))).flat();

  const entries = await Promise.all(
    allGames
      .filter(g => typeof g.home_score === 'number' && typeof g.away_score === 'number')
      .map(async g => {
        const actualTotal = g.home_score + g.away_score;
        const prob = await fetchTotalProb(g.game_id, actualTotal);
        if (prob === null) return null;
        return { game_id: g.game_id, prob };
      })
  );

  totalRankingCache = entries.filter(Boolean).sort((a, b) => a.prob - b.prob);
  return totalRankingCache;
}

async function updateResultOverlays(games) {
  const renderedIds = [];

  for (const g of games) {
    if (!g.is_finished || !g.has_prediction) continue;
    const homeScore = g.home_score, awayScore = g.away_score;
    if (typeof homeScore !== 'number' || typeof awayScore !== 'number') continue;

    const margin = homeScore - awayScore;
    if (margin === 0) continue; // no result line for a tie

    const winner    = margin > 0 ? g.home_team : g.away_team;
    const winMargin = Math.abs(margin);
    const lineLabel = `${winner} -${winMargin - 1}.5`;
    const actualTotal = homeScore + awayScore;

    const [prob, overProb] = await Promise.all([
      fetchResultLineProb(g.game_id, homeScore, awayScore),
      fetchTotalProb(g.game_id, actualTotal),
    ]);

    const card = gamesList.querySelector(`.card[data-game-id="${g.game_id}"]`);
    if (!card) continue;
    const slot = card.querySelector('.js-result-prob');
    if (!slot) continue;
    slot.querySelector('.js-result-loading')?.remove();

    const winnerColor = margin > 0 ? '#4ade80' : '#f87171';
    const probPct = prob !== null ? prob * 100 : null;

    let probColor = 'text-gray-400';
    if (probPct !== null) {
      if (probPct >= 50)      probColor = 'text-green-400';
      else if (probPct >= 25) probColor = 'text-amber-400';
      else                    probColor = 'text-rose-400';
    }

    const overPct  = overProb !== null ? overProb * 100 : null;
    const underPct = overPct !== null ? 100 - overPct : null;
    const totalsHtml = overPct !== null ? `
      <div class="mt-3 pt-2.5 border-t border-gray-700/50">
        <div class="flex items-center justify-between text-xs mb-1.5">
          <span class="text-gray-500 font-semibold uppercase tracking-wider">Total · ${actualTotal} pts</span>
          <span class="js-total-rank text-right"></span>
        </div>
        <div class="flex items-center justify-between text-xs mb-1">
          <span class="font-semibold" style="color:${bucketColor(overPct / 100)}">Over ${actualTotal - 0.5} &nbsp;${overPct.toFixed(1)}%</span>
          <span class="font-semibold" style="color:${bucketColor(underPct / 100)}">${underPct.toFixed(1)}% &nbsp;Under ${actualTotal + 0.5}</span>
        </div>
        <div class="flex w-full" style="height:6px; border-radius:4px; border:1px solid rgba(255,255,255,0.15); overflow:hidden; gap:1px; background:rgba(255,255,255,0.15);">
          <div style="width:${overPct.toFixed(1)}%; background:${bucketColor(overPct / 100)}; height:100%; transition:width 0.8s ease;"></div>
          <div style="width:${underPct.toFixed(1)}%; background:${bucketColor(underPct / 100)}; height:100%; transition:width 0.8s ease;"></div>
        </div>
      </div>` : '';

    slot.innerHTML = `
      <div class="mt-3 rounded-lg overflow-hidden" style="border:1px solid rgba(255,255,255,0.07); background:rgba(255,255,255,0.03);">
        <div class="px-3 pt-2.5 pb-2.5">
          <div class="flex items-center justify-between gap-3 mb-2">
            <div class="flex flex-col gap-0.5 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-xs font-semibold uppercase tracking-wider text-gray-500">Result</span>
                <span class="text-gray-600">·</span>
                <span class="font-mono font-bold text-white">${homeScore}–${awayScore}</span>
              </div>
              <span class="text-sm font-semibold text-white truncate">${lineLabel}</span>
            </div>
            ${probPct !== null ? `
            <div class="shrink-0 flex items-center gap-3">
              <span class="js-season-rank text-right"></span>
              <div class="text-right leading-none">
                <div class="text-xl font-bold ${probColor}">${probPct.toFixed(1)}%</div>
                ${prob >= 1e-6 ? `<div class="text-xs text-gray-500 mt-0.5">$${(1 / prob).toFixed(2)}</div>` : ''}
              </div>
            </div>` : ''}
          </div>
          ${probPct !== null ? `
          <div class="w-full rounded-full" style="height:4px; background:rgba(255,255,255,0.08);">
            <div style="width:${Math.min(probPct, 100)}%; height:100%; background:${winnerColor}; border-radius:9999px; transition:width 0.8s ease;"></div>
          </div>` : ''}
          ${totalsHtml}
        </div>
      </div>
    `;

    renderedIds.push(g.game_id);
  }

  gamesList.querySelectorAll('.js-result-loading').forEach(el => el.remove());

  // Phase 2: fill margin likelihood badges
  buildSeasonRanking().then(ranking => {
    renderedIds.forEach(gameId => {
      const idx = ranking.findIndex(r => r.game_id === gameId);
      if (idx === -1) return;
      const rank  = idx + 1;
      const total = ranking.length;
      const card   = gamesList.querySelector(`.card[data-game-id="${gameId}"]`);
      const rankEl = card?.querySelector('.js-season-rank');
      if (rankEl) rankEl.innerHTML = `<div class="text-gray-500 text-xs uppercase tracking-wider leading-none mb-0.5">Likelihood</div><div class="text-gray-300 text-sm font-semibold leading-none">${total - rank + 1}/${total}</div>`;
    });
  });

  // Phase 2: fill total points likelihood badges
  buildTotalRanking().then(ranking => {
    renderedIds.forEach(gameId => {
      const idx = ranking.findIndex(r => r.game_id === gameId);
      if (idx === -1) return;
      const rank  = idx + 1;
      const total = ranking.length;
      const card    = gamesList.querySelector(`.card[data-game-id="${gameId}"]`);
      const rankEl  = card?.querySelector('.js-total-rank');
      if (rankEl) rankEl.innerHTML = `<div class="text-gray-500 text-xs uppercase tracking-wider leading-none mb-0.5">Likelihood</div><div class="text-gray-300 text-sm font-semibold leading-none">${total - rank + 1}/${total}</div>`;
    });
  });
}

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
    const hasExpected = typeof g.exp_home_score === 'number' && typeof g.exp_away_score === 'number';
    return `<div class="text-2xl font-bold font-mono">${g.home_score} &ndash; ${g.away_score}</div>
            <div class="text-xs text-gray-500 mt-1">Final</div>
            ${hasExpected ? `<div class="text-xs text-gray-600 mt-0.5">Predicted ${g.exp_home_score}&ndash;${g.exp_away_score}</div>` : ''}`;
  }
  if (g.has_prediction) {
    return `<div class="text-2xl font-bold font-mono text-gray-300">${g.exp_home_score} &ndash; ${g.exp_away_score}</div>
            <div class="text-xs text-gray-500 mt-1">Predicted</div>`;
  }
  return `<div class="text-sm text-gray-500">vs</div>`;
}

function gameCard(g, index) {
  return `
    <div class="card" data-game-id="${g.game_id}" data-order="${index}">
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
      ${g.has_prediction && !g.is_finished ? `<div class="js-line-bar" data-game-id="${g.game_id}"></div>` : ''}
      ${!g.has_prediction ? '<p class="text-center text-gray-500 text-xs mt-3">Prediction not yet available</p>' : ''}
      ${g.has_prediction ? distButton(g) : ''}
      ${g.is_finished && g.has_prediction ? `
      <div class="js-result-prob">
        <div class="js-result-loading mt-3 flex items-center gap-2 text-xs text-gray-600 animate-pulse">
          <div class="w-2 h-2 rounded-full bg-gray-700"></div>
          <span>Checking results…</span>
        </div>
      </div>` : ''}
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
  lineSortMode = 'default';
  updateSortBtnLabel();
  // The pool of finished games these draw from grows as the season progresses.
  seasonRankingCache = null;
  totalRankingCache  = null;
  if (!games.length) {
    noGamesMsg.classList.remove('hidden');
    return;
  }
  gamesList.innerHTML = games.map((g, i) => gameCard(g, i)).join('');
  mountLineControls(games);
  updateResultOverlays(games);
}

function mountLineControls(games) {
  games.forEach(g => {
    if (!g.has_prediction || g.is_finished) return;
    const slot = gamesList.querySelector(`.js-line-bar[data-game-id="${g.game_id}"]`);
    if (!slot) return;
    const expectedMargin = (typeof g.exp_home_score === 'number' && typeof g.exp_away_score === 'number')
      ? g.exp_home_score - g.exp_away_score
      : null;
    matchLines.mountControl(slot, {
      id: String(g.game_id),
      homeTeam: g.home_team,
      awayTeam: g.away_team,
      homeColor: '#4ade80',
      awayColor: '#f87171',
      expectedMargin,
      onChange: () => { if (lineSortMode === 'discrepant') applyLineSort(); },
    });
  });
}

function applyLineSort() {
  const cards = Array.from(gamesList.querySelectorAll('.card'));
  if (!cards.length) return;
  if (lineSortMode === 'discrepant') {
    cards.sort((a, b) => {
      const da = matchLines.getDiscrepancy(a.dataset.gameId) ?? -1;
      const db = matchLines.getDiscrepancy(b.dataset.gameId) ?? -1;
      return db - da;
    });
  } else {
    cards.sort((a, b) => Number(a.dataset.order ?? 0) - Number(b.dataset.order ?? 0));
  }
  cards.forEach(c => gamesList.appendChild(c));
}

function updateSortBtnLabel() {
  if (sortBtn) sortBtn.textContent = lineSortMode === 'discrepant' ? 'Sort: Most Discrepant' : 'Sort: Schedule';
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

sortBtn?.addEventListener('click', () => {
  lineSortMode = lineSortMode === 'discrepant' ? 'default' : 'discrepant';
  updateSortBtnLabel();
  applyLineSort();
});
updateSortBtnLabel();

resetBtn?.addEventListener('click', () => {
  if (!confirm('Reset all custom lines back to the BS Machine\'s default for every game?')) return;
  matchLines.resetAll();
  mountLineControls(Object.values(gamesById));
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
