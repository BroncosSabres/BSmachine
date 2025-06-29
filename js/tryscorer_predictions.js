// pages/tryscorer_predictions.js

document.addEventListener("DOMContentLoaded", function () {
  // Load header and handle header-dependent logic
  fetch('/components/header.html')
    .then(res => res.text())
    .then(html => {
      document.getElementById('site-header').innerHTML = html;

      // Insert Buy Me a Coffee button (in header!)
      const bmcDiv = document.getElementById("bmc-button");
      if (bmcDiv) {
        bmcDiv.innerHTML = `
          <a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" rel="noopener">
            <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
                 alt="Buy Me a Coffee"
                 style="height: 45px; width: 162px;">
          </a>
        `;
      }
      // Hamburger menu logic
      const menuToggle = document.getElementById("menu-toggle");
      const mobileMenu = document.getElementById("mobile-menu");
      if (menuToggle && mobileMenu) {
        menuToggle.addEventListener("click", () => {
          mobileMenu.classList.toggle("hidden");
        });
      }
    });

  // API Base URL (update to your Render backend URL)
  const API_BASE = 'https://bsmachine-backend.onrender.com/api';

  // Elements
  const matchSelect = document.getElementById('match-select');
  const teamsContainer = document.getElementById('teams-container');
  const resultDiv = document.getElementById('result');
  const marginSelect = document.getElementById('margin-select');
  const totalSelect = document.getElementById('total-select');

  let matchList = [];
  let selectedMatch = null;
  let playerInputs = {}; // { home: {player_id: n}, away: {player_id: n} }

  // --- Fixed lines ---
  // Margin lines: every integer from -36 to 36
  const marginLines = [];
  for (let i = -36; i <= 36; i++) marginLines.push(i);

  // Total points lines: every integer from 0 to 80
  const totalLines = [];
  for (let i = 1; i <= 80; i++) totalLines.push(i);


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

  // When user selects a match, fetch team lists and populate fixed lines
  matchSelect.addEventListener('change', function () {
    const matchId = this.value;
    if (!matchId) {
      teamsContainer.innerHTML = '';
      resultDiv.textContent = '';
      populateFixedLines(); // also resets margin/total selectors
      return;
    }
    teamsContainer.innerHTML = '<div class="w-full text-center py-8">Loading team lists...</div>';
    fetch(`${API_BASE}/match_team_lists/${matchId}`)
      .then(res => res.json())
      .then(data => {
        selectedMatch = data;
        playerInputs = {};
        renderTeams(data);
        populateFixedLines(data.home_team, data.away_team);
        updateProbability(); // Reset result on match change
      });
  });

  // React to line changes
  marginSelect.addEventListener('change', updateProbability);
  totalSelect.addEventListener('change', updateProbability);

  // --- Populate fixed selectors with intuitive text
  function populateFixedLines(homeTeam = "Home", awayTeam = "Away") {
    marginSelect.innerHTML = `<option value="">Any Margin</option>`;
    for (let m = -36; m <= 36; m++) {
      // Home: wins by >m.5 (margin over m)
      marginSelect.innerHTML += `<option value="over_${-m+1}">${homeTeam} ${m > 0 ? "+" : ""}${m - 0.5}</option>`;
      // Away: wins by <m.5 (margin under m)
      marginSelect.innerHTML += `<option value="under_${m}">${awayTeam} ${m > 0 ? "+" : ""}${m - 0.5}</option>`;
    }
    totalSelect.innerHTML = `<option value="">Any Total</option>`;
    for (let t = 0; t <= 80; t++) {
      totalSelect.innerHTML += `<option value="over_${t}">Over ${t - 0.5}</option>`;
      totalSelect.innerHTML += `<option value="under_${t}">Under ${t - 0.5}</option>`;
    }
  }

  // --- Teams rendering (unchanged) ---
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
            <span class="w-24 text-right text-yellow-400">Anytime</span>
            <span class="w-24 text-center">Tries</span>
          </div>
          ${players.map(p => `
            <div class="flex items-center gap-2">
              <label class="flex-1 truncate text-left text-sm md:text-base" for="${side}-${p.id}">
                ${p.name} <span class="text-xs text-gray-400">(${p.position})</span>
              </label>
              <span id="anytime-${side}-${p.id}" class="w-20 text-right text-yellow-400 font-semibold"></span>
              <div class="flex items-center gap-1 ml-2">
                <button type="button"
                  class="sgm-minus-btn w-7 h-7 bg-red-300 hover:bg-red-400 text-black rounded flex items-center justify-center text-lg font-bold"
                  data-side="${side}" data-id="${p.id}" tabindex="0">−</button>
                <input id="${side}-${p.id}" type="text"
                  value="0"
                  readonly
                  class="w-7 h-7 text-center rounded text-lg bg-gray-200 text-gray-900 font-bold mx-0.5 shadow-inner select-none border-none outline-none pointer-events-none" />
                <button type="button"
                  class="sgm-plus-btn w-7 h-7 bg-green-300 hover:bg-green-400 text-black rounded flex items-center justify-center text-lg font-bold"
                  data-side="${side}" data-id="${p.id}" tabindex="0">+</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
      teamsContainer.appendChild(teamDiv);

      // --- Add listeners for +/− buttons ---
      players.forEach(p => {
        const input = teamDiv.querySelector(`#${side}-${p.id}`);
        playerInputs[side][p.id] = 0;

        // Minus button
        teamDiv.querySelector(`.sgm-minus-btn[data-side="${side}"][data-id="${p.id}"]`).addEventListener('click', () => {
          let val = playerInputs[side][p.id] || 0;
          if (val > 0) val--;
          playerInputs[side][p.id] = val;
          input.value = val;
          updateProbability();
        });

        // Plus button
        teamDiv.querySelector(`.sgm-plus-btn[data-side="${side}"][data-id="${p.id}"]`).addEventListener('click', () => {
          let val = playerInputs[side][p.id] || 0;
          if (val < 5) val++;
          playerInputs[side][p.id] = val;
          input.value = val;
          updateProbability();
        });
      });

      // --- Fetch try probabilities and try distribution, then update "Anytime" column ---
      const matchId = matchSelect.value;
      const teamId = players[0]?.team_id;

      if (matchId && teamId) {
        Promise.all([
          fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}`).then(res => res.json()),
          fetch(`${API_BASE}/match_try_distribution/${matchId}/${teamId}`).then(res => res.json())
        ]).then(([tryProbs, tryDist]) => {
          players.forEach((p, i) => {
            const playerProb = tryProbs[p.id];
            if (playerProb !== undefined && tryDist) {
              const prob = anytimeTryscorerProbability(playerProb, tryDist, 20);
              document.getElementById(`anytime-${side}-${p.id}`).textContent =
                (prob * 100).toFixed(1) + "%";
            } else {
              document.getElementById(`anytime-${side}-${p.id}`).textContent = "-";
            }
          });
        }).catch(() => {
          players.forEach(p => {
            document.getElementById(`anytime-${side}-${p.id}`).textContent = "-";
          });
        });
      }
    });
  }

  function formatDateString(dateStr) {
    if (!dateStr) return '';
    const match = dateStr.match(/\d{2} \w{3} \d{4}/);
    if (match) return match[0];
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

  // Helper to call the new backend SGM bins API for the right range
  function getSgmDist(matchId, marginType, marginVal, totalType, totalVal) {
    let params = [];
    if (marginType === "over") params.push(`margin_gte=${marginVal + 1}`);
    if (marginType === "under") params.push(`margin_lte=${marginVal}`);
    if (totalType === "over") params.push(`total_gte=${totalVal + 1}`);
    if (totalType === "under") params.push(`total_lte=${totalVal}`);
    const paramString = params.length ? `?${params.join("&")}` : "";
    return fetch(`${API_BASE}/match_sgm_bins_range/${matchId}${paramString}`)
      .then(res => res.json());
  }

  function fetchLineOnlyProb(matchId, margin_type, margin_val, total_type, total_val, cb) {
    getSgmDist(matchId, margin_type, margin_val, total_type, total_val)
      .then(sgmDist => {
        // Just take 'prob' from response, fallback to 0
        let comboProb = typeof sgmDist.prob === "number" ? sgmDist.prob : 0;
        cb(comboProb);
      })
      .catch(() => {
        cb(0);
      });
  }

  function updateProbability() {
    if (!selectedMatch) {
      resultDiv.textContent = "Select one or more tryscorers";
      return;
    }

    // Get selected margin/total line
    const marginLineVal = marginSelect.value;
    const totalLineVal = totalSelect.value;
    const matchId = matchSelect.value;

    let margin_type = null, margin_val = null, total_type = null, total_val = null;
    if (marginLineVal) [margin_type, margin_val] = marginLineVal.split('_'), margin_val = Number(margin_val);
    if (totalLineVal) [total_type, total_val] = totalLineVal.split('_'), total_val = Number(total_val);

    // Check if any picks at all
    const anyHome = Object.values(playerInputs.home || {}).some(v => v > 0);
    const anyAway = Object.values(playerInputs.away || {}).some(v => v > 0);
    const anyTries = anyHome || anyAway;

    // If no tryscorer picks, but a margin/total line is selected, fetch and show just the line probability
    if (!anyTries && (marginLineVal || totalLineVal)) {
      resultDiv.textContent = "Loading odds...";
      fetchLineOnlyProb(matchId, margin_type, margin_val, total_type, total_val, (comboProb) => {
        console.log("Fetched comboProb for line:", comboProb);
        if (comboProb && comboProb > 0 && comboProb < 1) {
          let lineOdds = (1 / comboProb).toFixed(2);
          let linePct = (comboProb * 100).toFixed(2);
          let label = "for this margin/total";
          if (marginLineVal && totalLineVal) label = "for this margin & total";
          else if (marginLineVal) label = "for this margin line";
          else if (totalLineVal) label = "for this total line";
          resultDiv.innerHTML =
            `<div class="sgm-odds-row mt-1">Line: <span class="sgm-odds">${linePct}% ($${lineOdds})</span> <span class="ml-2 text-xs text-gray-300">${label}</span></div>
              <div class="text-xs mt-4 text-gray-300 text-center leading-tight">
                If you like this feature, please consider <a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" class="text-yellow-300 hover:underline">buying me a coffee</a>.<br>
                Just a dollar a month will help pay my server costs.
              </div>`;
        } else {
          resultDiv.textContent = "No probability available for this line.";
        }
      });
      return;
    }

    // If no picks and no line, show prompt
    if (!anyTries && !(marginLineVal || totalLineVal)) {
      resultDiv.textContent = "Select one or more tryscorers";
      return;
    }

    // --- Otherwise: full SGM calculation ---
    let teamSGM = { home: 1, away: 1 };
    let pickedMap = { home: [], away: [] };
    let pending = 0;
    let comboProb = null;

    ["home", "away"].forEach(side => {
      const picks = playerInputs[side] || {};
      const players = (selectedMatch[`${side}_players`] || []);
      const teamId = players[0]?.team_id;
      if (!teamId || !matchId) return;

      const pickedPlayers = players.filter(p => (picks[p.id] || 0) > 0);
      pickedMap[side] = pickedPlayers.map(p => ({
        name: p.name,
        n: picks[p.id] || 0
      }));

      if (!pickedPlayers.length) {
        teamSGM[side] = 1;
        return;
      }

      pending += 1;

      Promise.all([
        fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}`).then(res => res.json()),
        getSgmDist(matchId, margin_type, margin_val, total_type, total_val)
      ]).then(([tryProbs, sgmDist]) => {
        if (!sgmDist || !sgmDist[side + "_try_dist"]) {
          teamSGM[side] = 0;
          return;
        }
        const tryDist = sgmDist[side + "_try_dist"];
        const sgmProb = sgmDist.prob ?? 1;
        if (comboProb === null && typeof sgmProb === "number") comboProb = sgmProb;

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
            let prob = (data.probability ?? 1) * (sgmProb ?? 1);
            teamSGM[side] = prob;
          })
          .catch(() => {
            teamSGM[side] = 1;
          })
          .finally(() => {
            pending -= 1;
            if (pending === 0) {
              let pickedDisplay = [];
              ["home", "away"].forEach(side2 => {
                pickedMap[side2].forEach(pick => {
                  if (pick.n === 1) pickedDisplay.push(pick.name);
                  else if (pick.n > 1) pickedDisplay.push(`${pick.name} (${pick.n})`);
                });
              });
              const combined = teamSGM.home * teamSGM.away;
              let odds = combined > 0 ? (1 / combined).toFixed(2) : "∞";
              let probPct = (combined * 100).toFixed(2);

              if (pickedDisplay.length > 0) {
                // Show SGM result
                resultDiv.innerHTML =
                  `<div class="sgm-picks-list mb-2">
                    ${pickedDisplay.map(n => `<div class="sgm-pick">${n}</div>`).join("")}
                  </div>
                  <div class="sgm-odds-row mt-1">SGM: <span class="sgm-odds">${probPct}% ($${odds})</span></div>
                  <div class="text-xs mt-4 text-gray-300 text-center leading-tight">
                    If you like this feature, please consider <a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" class="text-yellow-300 hover:underline">buying me a coffee</a>.<br>
                    Just a dollar a month will help pay my server costs.
                  </div>`;
              } else if (comboProb !== null && comboProb !== 1) {
                // Show just the margin/total probability/odds
                let lineOdds = comboProb > 0 ? (1 / comboProb).toFixed(2) : "∞";
                let linePct = (comboProb * 100).toFixed(2);
                let label = "for this margin/total";
                if (marginLineVal && totalLineVal) label = "for this margin & total";
                else if (marginLineVal) label = "for this margin line";
                else if (totalLineVal) label = "for this total line";
                resultDiv.innerHTML =
                  `<div class="sgm-odds-row mt-1">Line: <span class="sgm-odds">${linePct}% ($${lineOdds})</span> <span class="ml-2 text-xs text-gray-300">${label}</span></div>
                  <div class="text-xs mt-4 text-gray-300 text-center leading-tight">
                      If you like this feature, please consider <a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" class="text-yellow-300 hover:underline">buying me a coffee</a>.<br>
                      Just a dollar a month will help pay my server costs.
                  </div>`;
              } else {
                resultDiv.textContent = "Select one or more tryscorers";
              }
            }
          });
      });
    });
  }

  // Utility multinomial math functions (unchanged)
  function multinomialAtLeast(N, probs, minTries) {
    const K = probs.length;
    if (K === 1) {
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

  // Initialize with empty selectors
  populateFixedLines();
});
