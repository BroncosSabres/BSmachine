// pages/tryscorer_predictions.js

// Wait for DOM content to load before running code
document.addEventListener("DOMContentLoaded", function () {
  // Load header (as per your index.html)
  fetch('/components/header.html')
    .then(res => res.text())
    .then(html => {
      document.getElementById('site-header').innerHTML = html;
      // (Copy any header JS logic you use if needed)
    });

  // API Base URL (update to your Render backend URL)
  const API_BASE = 'https://bsmachine-backend.onrender.com/api'; // <-- update this!

  // Elements
  const matchSelect = document.getElementById('match-select');
  const teamsContainer = document.getElementById('teams-container');
  const resultDiv = document.getElementById('result');

  let matchList = [];
  let selectedMatch = null;
  let playerInputs = {}; // { home: {player_id: n}, away: {player_id: n} }

  // Fetch current round matches
  fetch(`${API_BASE}/current_round_matches`)
    .then(res => res.json())
    .then(matches => {
      matchList = matches;
      matchSelect.innerHTML = `<option value="">-- Select a Match --</option>`;
      matches.forEach(match => {
        const opt = document.createElement('option');
        opt.value = match.match_id;
        const dateString = formatDateString(match.date);
        opt.textContent = `${match.home_team} vs ${match.away_team} (${dateString})`;
        matchSelect.appendChild(opt);
      });
    });

  // When user selects a match, fetch team lists
  matchSelect.addEventListener('change', function () {
    const matchId = this.value;
    if (!matchId) {
      teamsContainer.innerHTML = '';
      resultDiv.textContent = '';
      return;
    }
    teamsContainer.innerHTML = '<div class="w-full text-center py-8">Loading team lists...</div>';
    fetch(`${API_BASE}/match_team_lists/${matchId}`)
      .then(res => res.json())
      .then(data => {
        selectedMatch = data;
        playerInputs = {};
        renderTeams(data);
        updateProbability(); // Reset result on match change
      });
  });

  // Render both teams and tryscorer selectors
function renderTeams(data) {
  teamsContainer.innerHTML = '';
  ['home', 'away'].forEach(side => {
    const teamName = data[`${side}_team`];
    const players = data[`${side}_players`];
    playerInputs[side] = {};
    const teamDiv = document.createElement('div');
    teamDiv.className = "bg-gray-700 rounded-xl p-4 w-full md:w-96 shadow-md";
    teamDiv.innerHTML = `
      <div class="font-bold text-xl mb-2 text-center">${teamName}</div>
      <div class="flex flex-col gap-y-2">
        <div class="flex items-center gap-2 font-semibold text-sm text-gray-200">
          <span class="flex-1 text-left">Player</span>
          <span class="w-16 text-center">N Tries</span>
          <span class="w-28 text-right text-yellow-400">Anytime</span>
        </div>
        ${players.map(p => `
          <div class="flex items-center gap-2">
            <label class="flex-1 truncate text-left" for="${side}-${p.id}">
              ${p.name} <span class="text-xs text-gray-400">(${p.position})</span>
            </label>
            <input id="${side}-${p.id}" type="number" min="0" max="5" value="0"
              class="w-16 rounded px-2 py-1 text-gray-900" />
            <span id="anytime-${side}-${p.id}" class="w-28 text-right text-yellow-400 font-semibold"></span>
          </div>
        `).join('')}
      </div>
    `;
    teamsContainer.appendChild(teamDiv);

    // Attach event listeners for each input
    players.forEach(p => {
      const input = teamDiv.querySelector(`#${side}-${p.id}`);
      input.addEventListener('input', (e) => {
        playerInputs[side][p.id] = parseInt(e.target.value) || 0;
        updateProbability(); // Live update
      });
    });

    // --- Fetch try probabilities and try distribution, then update "Anytime" column ---
    const matchId = matchSelect.value;
    const teamId = players[0]?.team_id; // assumes all players for this team have same team_id

    console.log('About to check matchId and teamId for', side);
    console.log('players:', players);
    console.log('matchId:', matchId, '| teamId:', teamId);


    if (matchId && teamId) {
      Promise.all([
        fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}`).then(res => res.json()),
        fetch(`${API_BASE}/match_try_distribution/${matchId}/${teamId}`).then(res => res.json())
      ]).then(([tryProbs, tryDist]) => {
        players.forEach((p, i) => {
          const playerProb = tryProbs[p.id];
          if (playerProb !== undefined && tryDist) {
            // You'll need to define anytimeTryscorerProbability(p, tryDist, 20) elsewhere
            const prob = anytimeTryscorerProbability(playerProb, tryDist, 20);
            document.getElementById(`anytime-${side}-${p.id}`).textContent =
              (prob * 100).toFixed(1) + "%";
          } else {
            document.getElementById(`anytime-${side}-${p.id}`).textContent = "-";
          }
        });
      }).catch(err => {
        players.forEach(p => {
          document.getElementById(`anytime-${side}-${p.id}`).textContent = "-";
        });
        // Optionally log error
        // console.error("Failed to load anytime tryscorer data:", err);
      });
    }
  });
}

  function formatDateString(dateStr) {
  if (!dateStr) return '';
  // Example: "Thu, 26 Jun 2025 00:00:00 GMT"
  // We want "26 Jun 2025"
  const match = dateStr.match(/\d{2} \w{3} \d{4}/);
  if (match) return match[0];
  // Fallback: show just the string
  return dateStr;
}

function anytimeTryscorerProbability(p, tryDist, maxN=20) {
  let prob = 0;
  for (let n = 1; n <= maxN; n++) {
    const pn = tryDist[n] || tryDist[n.toString()] || 0;
    prob += pn * (1 - Math.pow(1 - p, n));
  }
  return prob;
}

let tryProbCache = {};
let tryDistCache = {};

function updateProbability() {
  if (!selectedMatch) {
    resultDiv.textContent = "Select one or more tryscorers";
    return;
  }

  // Store the calculated SGM probability for each team
  let teamSGM = { home: 1, away: 1 };
  let pickedMap = { home: [], away: [] };
  let pending = 0; // Track pending API calls

  ["home", "away"].forEach(side => {
    const picks = playerInputs[side] || {};
    const players = (selectedMatch[`${side}_players`] || []);
    const teamId = players[0]?.team_id;
    const matchId = matchSelect.value;
    if (!teamId || !matchId) return;

    // Gather picked players for this team
    const pickedPlayers = players.filter(p => (picks[p.id] || 0) > 0);
    pickedMap[side] = pickedPlayers.map(p => ({
      name: p.name,
      n: picks[p.id] || 0
    }));

    if (!pickedPlayers.length) {
      teamSGM[side] = 1; // Neutral, won't affect combined
      return;
    }

    pending += 1;

    // Use cached API responses if possible
    const cacheKey = `${matchId}-${teamId}`;
    const afterFetch = (tryProbs, tryDist) => {
      const tryProbsArr = pickedPlayers.map(p => tryProbs[p.id] ?? tryProbs[String(p.id)]);
      const minTriesArr = pickedPlayers.map(p => picks[p.id] || 0);

      fetch(`${API_BASE}/sgm_probability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          try_dist: tryDist,
          player_probs: tryProbsArr,
          min_tries: minTriesArr
        }),
      })
      .then(res => res.json())
      .then(data => {
        let prob = data.probability ?? 1;
        teamSGM[side] = prob;
      })
      .catch(err => {
        teamSGM[side] = 1;
      })
      .finally(() => {
        pending -= 1;
        if (pending === 0) {
          // Combine picked players from both sides, home first, then away
          let pickedDisplay = [];
          ["home", "away"].forEach(side2 => {
            pickedMap[side2].forEach(pick => {
              if (pick.n === 1) {
                pickedDisplay.push(pick.name);
              } else if (pick.n > 1) {
                pickedDisplay.push(`${pick.name} (${pick.n})`);
              }
            });
          });

          const combined = teamSGM.home * teamSGM.away;
          let odds = combined > 0 ? (1 / combined).toFixed(2) : '∞';
          let probPct = (combined * 100).toFixed(2);

          if (pickedDisplay.length > 0) {
            resultDiv.innerHTML =
                `<div class="sgm-picks-list mb-2">
                ${pickedDisplay.map(n => `<div class="sgm-pick">${n}</div>`).join("")}
                </div>
                <div class="sgm-odds-row mt-1">SGM: <span class="sgm-odds">${probPct}% ($${odds})</span></div>`;
            } else {
            resultDiv.textContent = "Select one or more tryscorers";
            }
        }
      });
    };

    if (tryProbCache[cacheKey] && tryDistCache[cacheKey]) {
      afterFetch(tryProbCache[cacheKey], tryDistCache[cacheKey]);
    } else {
      Promise.all([
        fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}`).then(res => res.json()),
        fetch(`${API_BASE}/match_try_distribution/${matchId}/${teamId}`).then(res => res.json())
      ]).then(([tryProbs, tryDist]) => {
        tryProbCache[cacheKey] = tryProbs;
        tryDistCache[cacheKey] = tryDist;
        afterFetch(tryProbs, tryDist);
      });
    }
  });

  // If no picks at all, show message
  if (
    !Object.values(playerInputs.home || {}).some(v => v > 0) &&
    !Object.values(playerInputs.away || {}).some(v => v > 0)
  ) {
    resultDiv.textContent = "Select one or more tryscorers";
  }
}

function multinomialAtLeast(N, probs, minTries) {
  const K = probs.length;
  if (K === 1) {
    // Binomial: prob player gets at least minTries[0] in N
    let p = probs[0], minK = minTries[0], total = 0;
    for (let k = minK; k <= N; k++) {
      total += comb(N, k) * Math.pow(p, k) * Math.pow(1 - p, N - k);
    }
    return total;
  }
  const memo = {};
  function recurse(pos, left, acc) {
    if (pos === K) {
      if (left === 0 && acc.every((v, i) => v >= minTries[i])) {
        // Multinomial: N! / prod(k_i!) * prod(p_i^k_i)
        let multinom = 1;
        for (let i = 0; i < K; i++) {
          multinom *= Math.pow(probs[i], acc[i]) / factorial(acc[i]);
        }
        multinom *= factorial(N);
        return multinom;
      }
      return 0;
    }
    let key = `${pos}-${left}-${acc.join(",")}`;
    if (key in memo) return memo[key];
    let total = 0;
    for (let k = minTries[pos]; k <= left; k++) {
      acc[pos] = k;
      total += recurse(pos + 1, left - k, acc);
    }
    memo[key] = total;
    return total;
  }
  return recurse(0, N, Array(K).fill(0));
}
function factorial(n) {
  if (n === 0 || n === 1) return 1;
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}
function comb(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let res = 1;
  for (let i = 1; i <= k; i++) res *= (n - i + 1) / i;
  return res;
}

// SGM probability across all try distributions
function sgmProbability(tryProbs, tryDist, minTries, maxN=12) {
  let prob = 0;
  for (let n = 0; n <= maxN; n++) {
    const pn = tryDist[n] || tryDist[n.toString()] || 0;
    if (pn === 0) continue;
    const reqSum = minTries.reduce((a, b) => a + b, 0);
    if (n < reqSum) continue;
    const multiProb = multinomialAtLeast(n, tryProbs, minTries);
    prob += pn * multiProb;
  }
  return prob;
}

});
