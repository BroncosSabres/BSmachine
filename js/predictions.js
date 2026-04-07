// predictions.js
import { getLatestRoundFolder } from './utils.js';

const container = document.getElementById("predictions-container");

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

const TRYSCORER_API = 'https://bsmachine-backend.onrender.com/api';

// Fuzzy match: short names ("Roosters") vs API full names ("Sydney Roosters")
function teamsMatch(shortName, fullName) {
  const s = shortName.toLowerCase();
  const f = fullName.toLowerCase();
  return f.includes(s) || s.includes(f);
}

// Fetch the match list once and cache it
let tryscorerMatchCache = null;
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
    // Available if either team has at least one player listed
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

function createMatchCard(data) {
  const { home_team, away_team, home_score, away_score, home_perc, away_perc } = data;

  const homeWin = home_perc >= away_perc;
  const homePercValue = home_perc * 100;
  const awayPercValue = away_perc * 100;
  const homePercDisplay = homePercValue.toFixed(1);
  const awayPercDisplay = awayPercValue.toFixed(1);
  const homeFairOdds = (1 / home_perc).toFixed(2);
  const awayFairOdds = (1 / away_perc).toFixed(2);
  const expectedTotal = home_score + away_score;
  const homeColor = teamColor(home_team);
  const awayColor = teamColor(away_team);

  const card = document.createElement("div");
  card.className = "match-card";

  const bar = `
    <div class="flex w-full items-center" style="border:1px solid rgba(255,255,255,0.25); border-radius:5px; overflow:hidden;">
      <div class="prob-bar-home" style="width:${homePercValue}%; background:${homeColor}; height:8px; opacity:${homeWin ? '1' : '0.4'}; border-right:1px solid rgba(255,255,255,0.6)"></div>
      <div class="prob-bar-away" style="width:${awayPercValue}%; background:${awayColor}; height:8px; opacity:${homeWin ? '0.4' : '1'}"></div>
    </div>`;

  card.innerHTML = `

    <!-- DESKTOP layout (md+) -->
    <div class="hidden md:flex items-center justify-between gap-4">
      <div class="flex-1 flex items-center gap-3 min-w-0">
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
      <div class="flex-1 flex items-center justify-end gap-3 min-w-0">
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
        <div class="flex items-center gap-2 flex-1 min-w-0">
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
        <div class="flex items-center gap-2 flex-1 min-w-0 justify-end">
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
  `;

  return card;
}

async function loadPredictions() {
  const roundFolder = await getLatestRoundFolder();
  if (!roundFolder) {
    container.innerHTML = `<p class="text-gray-400">No predictions available yet.</p>`;
    return;
  }

  const predictionsPath = `../data/${roundFolder}/Predictions.txt`;

  try {
    const response = await fetch(predictionsPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const text = await response.text();
    const lines = text.trim().split("\n");

    lines.forEach((line, idx) => {
      try {
        const data = JSON.parse(line.replace(/'/g, '"'));
        const card = createMatchCard(data);
        container.appendChild(card);

        // Async: update button once we know if team lists are available
        checkTryscorerAvailable(data.home_team, data.away_team).then(({ available, matchId }) => {
          card.querySelectorAll('.js-tryscorer-btn').forEach(slot => {
            slot.innerHTML = available
              ? tryscorerButtonEnabled(matchId)
              : tryscorerButtonDisabled();
          });
        });
      } catch (err) {
        console.error(`Error parsing line ${idx}:`, line, err);
      }
    });
  } catch (err) {
    console.error("Failed to load predictions:", err);
    container.innerHTML = `<p class="text-gray-400">Predictions unavailable — check back after the next round update.</p>`;
  }
}

loadPredictions();
