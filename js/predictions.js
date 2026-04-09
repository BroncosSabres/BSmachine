// predictions.js
import { getLatestRoundFolder } from './utils.js';

const container = document.getElementById("predictions-container");
const TRYSCORER_API = 'https://bsmachine-backend.onrender.com/api';
const MIN_ROUND = 0; // folder Round0 = Round 1 predictions

// --- STATE ---
let latestRound = 0;
let currentRound = 0;
const tips = {};
let betslipExpanded = false;
let tryscorerMatchCache = null;

const teamColors = {
  "Broncos":   "#760135",
  "Raiders":   "#32CD32",
  "Bulldogs":  "#00539F",
  "Sharks":    "#00A9D8",
  "Dolphins":  "#E0121A",
  "Titans":    "#009DDC",
  "Manly":     "#6F163D",
  "Storm":     "#632390",
  "Knights":   "#EE3524",
  "Cowboys":   "#002B5C",
  "Eels":      "#006EB5",
  "Panthers":  "#000000",
  "Rabbitohs": "#025D17",
  "Dragons":   "#E2231B",
  "Roosters":  "#E82C2E",
  "Warriors":  "#231F20",
  "Tigers":    "#F57600",
};

function teamColor(name) {
  return teamColors[name] ?? "#6b7280";
}

function logoUrl(teamName) {
  return `../logos/${teamName.toLowerCase()}.svg`;
}

// --- ROUND NAVIGATION ---
function renderRoundNav() {
  const nav = document.getElementById('round-nav');
  if (!nav || latestRound === 0) return;

  const options = [];
  for (let r = latestRound; r >= MIN_ROUND; r--) {
    const displayRound = r + 1;
    const label = r === latestRound ? `Round ${displayRound} (Current)` : `Round ${displayRound}`;
    options.push(`<option value="${r}" ${r === currentRound ? 'selected' : ''}>${label}</option>`);
  }

  nav.innerHTML = `
    <select id="round-select"
      class="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-gray-500 cursor-pointer">
      ${options.join('')}
    </select>
  `;

  nav.querySelector('#round-select').addEventListener('change', function () {
    currentRound = Number(this.value);
    loadRound();
  });
}

// --- TRYSCORER MATCH CACHE ---
// Fuzzy match: short names ("Roosters") vs API full names ("Sydney Roosters")
function teamsMatch(shortName, fullName) {
  const s = shortName.toLowerCase();
  const f = fullName.toLowerCase();
  return f.includes(s) || s.includes(f);
}

async function getTryscorerMatches() {
  if (tryscorerMatchCache) return tryscorerMatchCache;
  try {
    const res = await fetch(`${TRYSCORER_API}/current_round_matches/nrl`);
    tryscorerMatchCache = await res.json();
  } catch {
    tryscorerMatchCache = [];
  }
  return tryscorerMatchCache;
}

async function checkTryscorerAvailable(homeTeam, awayTeam) {
  const matches = await getTryscorerMatches();
  const match = matches.find(m =>
    teamsMatch(homeTeam, m.home_team) && teamsMatch(awayTeam, m.away_team)
  );
  if (!match) return { available: false, matchId: null };
  try {
    const res = await fetch(`${TRYSCORER_API}/match_team_lists/${match.match_id}/nrl`);
    const data = await res.json();
    const hasPlayers = data?.home_players?.length > 0 || data?.away_players?.length > 0;
    return { available: hasPlayers, matchId: match.match_id };
  } catch {
    return { available: false, matchId: null };
  }
}

function tryscorerButtonDisabled() {
  return `<span title="Team lists not yet available"
               class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-800 border border-gray-700 text-xs font-medium text-gray-600 cursor-not-allowed select-none">
            <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>
            Tryscorer Predictions
          </span>`;
}

function tryscorerButtonEnabled(matchId) {
  const url = `tryscorer_predictions.html?match_id=${matchId}`;
  return `<a href="${url}"
             class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 border border-gray-600 hover:border-gray-500 text-xs font-medium text-gray-200 transition-colors">
            <svg class="w-3.5 h-3.5 text-green-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
            Tryscorer Predictions
          </a>`;
}

// --- LIVE SCORE / RESULT LINE PROBABILITY ---

const BACKEND_BASE = 'https://bsmachine-backend.onrender.com';
let liveResultsCache = null;

async function getLiveResults() {
  if (liveResultsCache) return liveResultsCache;
  try {
    const res = await fetch(`${BACKEND_BASE}/latest-results`);
    liveResultsCache = await res.json();
  } catch {
    liveResultsCache = [];
  }
  return liveResultsCache;
}

const lineProbCache = {};

async function fetchResultLineProb(matchId, homeScore, awayScore) {
  const margin = homeScore - awayScore;
  if (margin === 0) return null;

  const cacheKey = `${matchId}_${margin}`;
  if (cacheKey in lineProbCache) return lineProbCache[cacheKey];

  const params = margin > 0 ? `?margin_gte=${margin}` : `?margin_lte=${margin}`;

  try {
    const res = await fetch(`${TRYSCORER_API}/match_sgm_bins_range/${matchId}${params}`);
    const data = await res.json();
    const prob = typeof data.prob === 'number' ? data.prob : null;
    lineProbCache[cacheKey] = prob;
    return prob;
  } catch {
    lineProbCache[cacheKey] = null;
    return null;
  }
}

// Build a season-wide ranked list of all result probabilities (least likely first)
let seasonRankingCache = null;

async function buildSeasonRanking() {
  if (seasonRankingCache) return seasonRankingCache;

  // Fetch all rounds' match data in parallel
  const roundFetches = [];
  for (let r = MIN_ROUND; r <= latestRound; r++) {
    if (r === latestRound) {
      roundFetches.push(
        Promise.all([getLiveResults(), getTryscorerMatches()]).then(([live, curr]) =>
          curr.map(m => {
            const l = live.find(lv => teamsMatch(m.home_team, lv.home) && teamsMatch(m.away_team, lv.away));
            return l ? { ...m, home_score: l.home_score, away_score: l.away_score } : m;
          })
        )
      );
    } else {
      roundFetches.push(getRoundMatches(r + 1));
    }
  }

  const allMatches = (await Promise.all(roundFetches)).flat();

  // Compute probabilities for all completed matches in parallel (cache means no double-fetch)
  const entries = await Promise.all(
    allMatches
      .filter(m => typeof m.home_score === 'number' && typeof m.away_score === 'number' && m.home_score !== m.away_score)
      .map(async m => {
        const prob = await fetchResultLineProb(m.match_id, m.home_score, m.away_score);
        return prob !== null ? { match_id: m.match_id, prob } : null;
      })
  );

  seasonRankingCache = entries.filter(Boolean).sort((a, b) => a.prob - b.prob);
  return seasonRankingCache;
}

async function getRoundMatches(roundNumber) {
  try {
    const res = await fetch(`${TRYSCORER_API}/round_results/${roundNumber}/nrl`);
    const data = await res.json();
    console.log(`[round_results] Round ${roundNumber}:`, data);
    return data;
  } catch (e) {
    console.error(`[round_results] Failed for Round ${roundNumber}:`, e);
    return [];
  }
}

async function updateLiveScoreOverlays(predictions) {
  let matches;

  if (currentRound === latestRound) {
    // Current round: scores from NRL live API, match IDs from current_round_matches
    const [liveResults, currentMatches] = await Promise.all([getLiveResults(), getTryscorerMatches()]);
    // Merge: attach live scores onto the match objects that have IDs
    matches = currentMatches.map(m => {
      const live = liveResults.find(r =>
        teamsMatch(m.home_team, r.home) && teamsMatch(m.away_team, r.away)
      );
      return live
        ? { ...m, home_score: live.home_score, away_score: live.away_score }
        : m;
    });
  } else {
    // Previous rounds: scores and match IDs from DB — use display round (folder + 1)
    matches = await getRoundMatches(currentRound + 1);
  }

  const renderedMatchIds = [];

  for (const pred of predictions) {
    const match = matches.find(m =>
      teamsMatch(pred.home_team, m.home_team) && teamsMatch(pred.away_team, m.away_team)
    );
    if (!match) { console.log(`[overlay] No match found for ${pred.home_team} v ${pred.away_team}`); continue; }

    const homeScore = match.home_score;
    const awayScore = match.away_score;
    console.log(`[overlay] ${pred.home_team} v ${pred.away_team} → scores:`, homeScore, awayScore);
    if (homeScore === null || homeScore === undefined) continue;
    if (awayScore === null || awayScore === undefined) continue;
    if (typeof homeScore !== 'number' || typeof awayScore !== 'number') continue;

    const margin = homeScore - awayScore;
    if (margin === 0) continue;

    const winner    = margin > 0 ? pred.home_team : pred.away_team;
    const winMargin = Math.abs(margin);
    const lineLabel = `${winner} -${winMargin - 1}.5`;

    const prob = await fetchResultLineProb(match.match_id, homeScore, awayScore);

    const matchKey = `${pred.home_team}_v_${pred.away_team}`;
    const card = container.querySelector(`.match-card[data-match-key="${matchKey}"]`);
    if (!card) continue;

    const slot = card.querySelector('.js-result-prob');
    if (!slot) continue;

    const winnerColor = teamColor(winner);
    const probPct     = prob !== null ? (prob * 100) : null;

    // Colour the percentage text by how likely the outcome was
    let probColor = 'text-gray-400';
    if (probPct !== null) {
      if (probPct >= 50)      probColor = 'text-green-400';
      else if (probPct >= 25) probColor = 'text-amber-400';
      else                    probColor = 'text-rose-400';
    }

    const stateBadge = `<span class="text-xs font-semibold uppercase tracking-wider text-gray-500">Result</span>`;

    const scoreDisplay = `<span class="font-mono font-bold text-white">${homeScore}–${awayScore}</span>`;

    slot.innerHTML = `
      <div class="mt-3 rounded-lg overflow-hidden" style="border:1px solid rgba(255,255,255,0.07); background:rgba(255,255,255,0.03);">
        <div class="px-3 pt-2.5 pb-2">
          <div class="flex items-center justify-between gap-3 mb-2">
            <div class="flex items-center gap-2 min-w-0">
              ${stateBadge}
              <span class="text-gray-600">·</span>
              ${scoreDisplay}
              <span class="text-gray-600">·</span>
              <span class="text-sm font-semibold text-white truncate">${lineLabel}</span>
            </div>
            ${probPct !== null ? `
            <div class="shrink-0 flex items-center gap-3">
              <span class="js-season-rank text-right"></span>
              <div class="text-right leading-none">
                <div class="text-xl font-bold ${probColor}">${probPct.toFixed(1)}%</div>
                <div class="text-xs text-gray-500 mt-0.5">$${(1 / prob).toFixed(2)}</div>
              </div>
            </div>` : ''}
          </div>
          ${probPct !== null ? `
          <div class="w-full rounded-full" style="height:4px; background:rgba(255,255,255,0.08);">
            <div style="width:${Math.min(probPct, 100)}%; height:100%; background:${winnerColor}; border-radius:9999px; transition:width 0.8s ease;"></div>
          </div>` : ''}
        </div>
      </div>
    `;

    renderedMatchIds.push({ matchId: match.match_id, matchKey });
  }

  // Phase 2: build season ranking in background, then fill in rank badges
  buildSeasonRanking().then(ranking => {
    renderedMatchIds.forEach(({ matchId, matchKey }) => {
      const idx = ranking.findIndex(r => r.match_id === matchId);
      if (idx === -1) return;
      const rank = idx + 1;
      const total = ranking.length;
      const card = container.querySelector(`.match-card[data-match-key="${matchKey}"]`);
      const rankEl = card?.querySelector('.js-season-rank');
      if (rankEl) rankEl.innerHTML = `<div class="text-gray-500 text-xs uppercase tracking-wider leading-none mb-0.5">Likeliness</div><div class="text-gray-300 text-sm font-semibold leading-none">${total - rank + 1}/${total}</div>`;
    });
  });
}

// --- MATCH CARD ---
function createMatchCard(data) {
  const { home_team, away_team, home_score, away_score, home_perc, away_perc } = data;
  const matchKey = `${home_team}_v_${away_team}`;

  const homeWin = home_perc >= away_perc;
  const homePercValue   = home_perc * 100;
  const awayPercValue   = away_perc * 100;
  const homePercDisplay = homePercValue.toFixed(1);
  const awayPercDisplay = awayPercValue.toFixed(1);
  const homeFairOdds    = (1 / home_perc).toFixed(2);
  const awayFairOdds    = (1 / away_perc).toFixed(2);
  const expectedTotal   = home_score + away_score;
  const homeColor       = teamColor(home_team);
  const awayColor       = teamColor(away_team);

  const card = document.createElement("div");
  card.className = "match-card";
  card.dataset.matchKey = matchKey;

  const bar = `
    <div class="flex w-full items-center" style="border:1px solid rgba(255,255,255,0.25); border-radius:5px; overflow:hidden;">
      <div class="prob-bar-home" style="width:${homePercValue}%; background:${homeColor}; height:8px; opacity:${homeWin ? '1' : '0.4'}; border-right:1px solid rgba(255,255,255,0.6)"></div>
      <div class="prob-bar-away" style="width:${awayPercValue}%; background:${awayColor}; height:8px; opacity:${homeWin ? '0.4' : '1'}"></div>
    </div>`;

  card.innerHTML = `

    <!-- DESKTOP layout (md+) -->
    <div class="hidden md:flex items-center justify-between gap-4">
      <div class="team-tip-area flex-1 flex items-center gap-3 min-w-0 p-2 -m-2"
           data-match-key="${matchKey}" data-team-name="${home_team}">
        <img src="${logoUrl(home_team)}" alt="${home_team} logo"
             class="w-12 h-12 object-contain shrink-0" onerror="this.style.display='none'">
        <div class="min-w-0">
          <div class="text-base font-semibold leading-tight ${homeWin ? 'text-white' : 'text-gray-400'}">${home_team}</div>
          <div class="text-xs text-gray-500 mt-0.5">Home</div>
        </div>
      </div>
      <div class="flex flex-col items-center gap-1.5 w-64">
        <div class="flex items-center justify-between w-full text-sm font-bold">
          <div class="flex flex-col items-start">
            <span class="${homeWin ? 'text-white' : 'text-gray-500'}">${homePercDisplay}%</span>
            <span class="text-xs font-normal text-gray-500">$${homeFairOdds}</span>
          </div>
          <span class="text-gray-600 text-xs font-normal px-2">vs</span>
          <div class="flex flex-col items-end">
            <span class="${!homeWin ? 'text-white' : 'text-gray-500'}">${awayPercDisplay}%</span>
            <span class="text-xs font-normal text-gray-500">$${awayFairOdds}</span>
          </div>
        </div>
        ${bar}
        <div class="text-2xl font-bold font-mono text-white tracking-wide mt-1">${home_score} – ${away_score}</div>
      </div>
      <div class="team-tip-area flex-1 flex items-center justify-end gap-3 min-w-0 p-2 -m-2"
           data-match-key="${matchKey}" data-team-name="${away_team}">
        <div class="min-w-0 text-right">
          <div class="text-base font-semibold leading-tight ${!homeWin ? 'text-white' : 'text-gray-400'}">${away_team}</div>
          <div class="text-xs text-gray-500 mt-0.5">Away</div>
        </div>
        <img src="${logoUrl(away_team)}" alt="${away_team} logo"
             class="w-12 h-12 object-contain shrink-0" onerror="this.style.display='none'">
      </div>
    </div>

    <!-- MOBILE layout (<md) -->
    <div class="flex flex-col gap-2 md:hidden">
      <!-- Teams side by side -->
      <div class="flex items-center justify-between gap-2">
        <!-- Home -->
        <div class="team-tip-area flex items-center gap-2 flex-1 min-w-0 p-1 -m-1"
             data-match-key="${matchKey}" data-team-name="${home_team}">
          <img src="${logoUrl(home_team)}" alt="${home_team} logo"
               class="w-9 h-9 object-contain shrink-0" onerror="this.style.display='none'">
          <div class="min-w-0">
            <div class="text-sm font-semibold leading-tight truncate ${homeWin ? 'text-white' : 'text-gray-400'}">${home_team}</div>
            <div class="text-xs text-gray-500">Home · <span class="font-bold ${homeWin ? 'text-white' : 'text-gray-500'}">${homePercDisplay}%</span> · <span class="text-gray-500">$${homeFairOdds}</span></div>
          </div>
        </div>
        <!-- Score -->
        <div class="text-lg font-bold font-mono text-white tracking-wide shrink-0 px-2">${home_score}–${away_score}</div>
        <!-- Away -->
        <div class="team-tip-area flex items-center gap-2 flex-1 min-w-0 justify-end p-1 -m-1"
             data-match-key="${matchKey}" data-team-name="${away_team}">
          <div class="min-w-0 text-right">
            <div class="text-sm font-semibold leading-tight truncate ${!homeWin ? 'text-white' : 'text-gray-400'}">${away_team}</div>
            <div class="text-xs text-gray-500">Away · <span class="font-bold ${!homeWin ? 'text-white' : 'text-gray-500'}">${awayPercDisplay}%</span> · <span class="text-gray-500">$${awayFairOdds}</span></div>
          </div>
          <img src="${logoUrl(away_team)}" alt="${away_team} logo"
               class="w-9 h-9 object-contain shrink-0" onerror="this.style.display='none'">
        </div>
      </div>
      <!-- Bar -->
      ${bar}
    </div>

    <!-- Footer row (shared) -->
    <div class="mt-3 pt-3 border-t border-gray-700 text-xs text-gray-500">
      <!-- Desktop footer: single row -->
      <div class="hidden md:flex items-center justify-between">
        <span>${homeWin ? home_team : away_team} favoured</span>
        <span class="js-tryscorer-btn">${tryscorerButtonDisabled()}</span>
        <span>Expected total: <span class="text-gray-300 font-medium">${expectedTotal} pts</span></span>
      </div>
      <!-- Mobile footer: two rows -->
      <div class="flex flex-col gap-2 md:hidden">
        <div class="flex items-center justify-between">
          <span>${homeWin ? home_team : away_team} favoured</span>
          <span>Total: <span class="text-gray-300 font-medium">${expectedTotal} pts</span></span>
        </div>
        <div class="js-tryscorer-btn flex justify-center"></div>
      </div>
    </div>

    <!-- Result line probability (populated async for current round) -->
    <div class="js-result-prob"></div>
  `;

  card.querySelectorAll('.team-tip-area').forEach(area => {
    area.addEventListener('click', () => {
      handleTip(matchKey, area.dataset.teamName, area.dataset.teamName === home_team ? home_perc : away_perc);
    });
  });

  return card;
}

// --- TIP / BETSLIP ---
function handleTip(matchKey, team, perc) {
  if (tips[matchKey]?.team === team) {
    delete tips[matchKey];
  } else {
    tips[matchKey] = { team, perc };
  }
  updateTipAreas(matchKey);
  renderBetslip();
}

function updateTipAreas(matchKey) {
  const selected = tips[matchKey]?.team;
  document.querySelectorAll(`.team-tip-area[data-match-key="${matchKey}"]`).forEach(area => {
    area.classList.toggle('tip-area-selected', selected === area.dataset.teamName);
  });
}

function renderBetslip() {
  const betslip = document.getElementById('betslip');
  const selections = Object.values(tips);

  if (selections.length === 0) {
    betslip.classList.remove('betslip-open');
    betslipExpanded = false;
    betslip.innerHTML = `
      <div class="flex items-center justify-between md:cursor-default select-none">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Your Tips</span>
        <span class="text-xs text-gray-600 md:hidden">tap a team ↑</span>
      </div>
      <div class="hidden md:block mt-2 text-sm text-gray-600">Tap a team to start tipping</div>
    `;
    return;
  }

  const combinedProb        = selections.reduce((acc, s) => acc * s.perc, 1);
  const combinedOdds        = (1 / combinedProb).toFixed(2);
  const combinedPercDisplay = (combinedProb * 100).toFixed(1);
  const legLabel            = selections.length === 1 ? 'Single' : `${selections.length}-leg multi`;

  const legsHtml = selections.map(s => `
    <div class="sgm-pick flex items-center justify-between">
      <span>${s.team}</span>
      <div class="text-right">
        <div class="font-bold text-white">${(s.perc * 100).toFixed(1)}%</div>
        <div class="text-xs text-gray-500">$${(1 / s.perc).toFixed(2)}</div>
      </div>
    </div>
  `).join('');

  betslip.innerHTML = `
    <div id="betslip-toggle" class="flex items-center justify-between md:cursor-default select-none">
      <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Your Tips</span>
      <div class="flex items-center gap-2 md:hidden">
        <span class="text-base font-bold text-amber-400">${combinedPercDisplay}%</span>
        <span id="betslip-chevron" class="text-gray-400 text-xs">${betslipExpanded ? '▼' : '▲'}</span>
      </div>
    </div>
    <div id="betslip-body" class="${betslipExpanded ? '' : 'hidden'} md:block mt-1">
      <div class="sgm-picks-list">${legsHtml}</div>
      <div class="sgm-odds-row flex justify-between items-center">
        <span class="text-sm font-semibold text-gray-300">${legLabel}</span>
        <div class="text-right">
          <div class="font-bold text-amber-400">${combinedPercDisplay}%</div>
          <div class="text-xs text-gray-500">$${combinedOdds}</div>
        </div>
      </div>
      <button id="clear-tips-btn" class="mt-3 w-full px-3 py-1.5 rounded-lg bg-gray-700 border border-gray-600 text-gray-300 text-sm hover:border-red-500 hover:text-red-400 transition-colors">
        ↺ Clear Tips
      </button>
    </div>
  `;

  betslip.querySelector('#betslip-toggle').addEventListener('click', () => {
    if (window.innerWidth >= 768) return;
    betslipExpanded = !betslipExpanded;
    betslip.classList.toggle('betslip-open', betslipExpanded);
    betslip.querySelector('#betslip-body').classList.toggle('hidden', !betslipExpanded);
    betslip.querySelector('#betslip-chevron').textContent = betslipExpanded ? '▼' : '▲';
  });

  betslip.querySelector('#clear-tips-btn').addEventListener('click', () => {
    Object.keys(tips).forEach(k => delete tips[k]);
    document.querySelectorAll('.team-tip-area').forEach(area => {
      area.classList.remove('tip-area-selected');
    });
    betslipExpanded = false;
    renderBetslip();
  });
}

// --- LOAD ROUND ---
async function loadRound() {
  container.innerHTML = '<p class="text-gray-500 text-sm animate-pulse">Loading...</p>';

  // Reset tips when changing rounds
  Object.keys(tips).forEach(k => delete tips[k]);
  renderBetslip();

  const predictionsPath = `../data/Round${currentRound}/Predictions.txt`;

  try {
    const response = await fetch(predictionsPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const text        = await response.text();
    const lines       = text.trim().split("\n");
    const predictions = [];

    container.innerHTML = '';

    lines.forEach((line, idx) => {
      try {
        const data = JSON.parse(line.replace(/'/g, '"'));
        predictions.push(data);
        const card = createMatchCard(data);
        container.appendChild(card);

        if (currentRound === latestRound) {
          // Async: update tryscorer button once we know if team lists are available
          checkTryscorerAvailable(data.home_team, data.away_team).then(({ available, matchId }) => {
            card.querySelectorAll('.js-tryscorer-btn').forEach(slot => {
              slot.innerHTML = available
                ? tryscorerButtonEnabled(matchId)
                : tryscorerButtonDisabled();
            });
          });
        } else {
          // Previous rounds: no tryscorer button
          card.querySelectorAll('.js-tryscorer-btn').forEach(slot => {
            slot.innerHTML = '';
          });
        }
      } catch (err) {
        console.error(`Error parsing line ${idx}:`, line, err);
      }
    });

    // Async: overlay result line probability for all rounds
    updateLiveScoreOverlays(predictions);
  } catch (err) {
    console.error("Failed to load predictions:", err);
    container.innerHTML = `<p class="text-gray-400">Predictions unavailable for Round ${currentRound}.</p>`;
  }
}

// --- INIT ---
async function init() {
  try {
    const res  = await fetch('../data/latestRound.json');
    const data = await res.json();
    latestRound  = data.latest;
    currentRound = latestRound;
  } catch {
    latestRound  = 1;
    currentRound = 1;
  }

  renderRoundNav();
  renderBetslip();
  loadRound();
}

init();
