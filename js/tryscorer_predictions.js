// pages/tryscorer_predictions.js

document.addEventListener("DOMContentLoaded", function () {
  // --- HEADER LOADING (unchanged) ---
  fetch('/components/header.html')
    .then(res => res.text())
    .then(html => {
      document.getElementById('site-header').innerHTML = html;
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
      const menuToggle = document.getElementById("menu-toggle");
      const mobileMenu = document.getElementById("mobile-menu");
      if (menuToggle && mobileMenu) {
        menuToggle.addEventListener("click", () => {
          mobileMenu.classList.toggle("hidden");
        });
      }
    });

  // --- CONFIG ---
  const API_BASE = 'https://bsmachine-backend.onrender.com/api';

  // --- ELEMENTS ---
  const matchSelect = document.getElementById('match-select');
  const teamsContainer = document.getElementById('teams-container');
  const resultDiv = document.getElementById('result');
  const marginSelect = document.getElementById('margin-select');
  const totalSelect = document.getElementById('total-select');
  const btnNrl = document.getElementById('btn-nrl');
  const btnNrlw = document.getElementById('btn-nrlw');
  const downloadCsvBtn = document.getElementById('download-tryscorer-csv');
  const resetAllBtn = document.getElementById('reset-all-btn');
  const homeWinBtn = document.getElementById('home-win-btn');
  const awayWinBtn = document.getElementById('away-win-btn');

  // --- COMPETITION TOGGLE LOGIC ---
  let competition = localStorage.getItem('bsmachine_competition') || 'nrl';

  function updateCompetitionButtons() {
    if (competition === 'nrl') {
      btnNrl.classList.add('bg-amber-400', 'text-gray-900');
      btnNrl.classList.remove('text-gray-400');
      btnNrlw.classList.remove('bg-amber-400', 'text-gray-900');
      btnNrlw.classList.add('text-gray-400');
    } else {
      btnNrlw.classList.add('bg-amber-400', 'text-gray-900');
      btnNrlw.classList.remove('text-gray-400');
      btnNrl.classList.remove('bg-amber-400', 'text-gray-900');
      btnNrl.classList.add('text-gray-400');
    }
  }
  btnNrl.addEventListener('click', function () {
    if (competition !== 'nrl') {
      competition = 'nrl';
      localStorage.setItem('bsmachine_competition', competition);
      updateCompetitionButtons();
      fetchMatchesAndPopulate();
    }
  });
  btnNrlw.addEventListener('click', function () {
    if (competition !== 'nrlw') {
      competition = 'nrlw';
      localStorage.setItem('bsmachine_competition', competition);
      updateCompetitionButtons();
      fetchMatchesAndPopulate();
    }
  });
  updateCompetitionButtons();

  // --- STATE ---
  let matchList = [];
  let selectedMatch = null;
  let playerInputs = {}; // { home: {player_id: n}, away: {player_id: n} }
  let tryscorerDataCache = {
    home: null,
    away: null
  };

  // --- CACHE HELPER FUNCTION ---
  function resetTryscorerCache() {
    tryscorerDataCache = {
      home: null,
      away: null
    };

    if (downloadCsvBtn) downloadCsvBtn.disabled = true;
    if (resetAllBtn) resetAllBtn.disabled = true;
    if (homeWinBtn) { homeWinBtn.disabled = true; homeWinBtn.textContent = 'Home'; }
    if (awayWinBtn) { awayWinBtn.disabled = true; awayWinBtn.textContent = 'Away'; }
  }

  // --- FIXED LINES ---
  function populateFixedLines(homeTeam = "Home", awayTeam = "Away") {
    marginSelect.innerHTML = `<option value="">Any Margin</option>`;
    for (let m = -36; m <= 36; m++) {
      marginSelect.innerHTML += `<option value="over_${-m+1}">${homeTeam} ${m > 0 ? "+" : ""}${m - 0.5}</option>`;
      marginSelect.innerHTML += `<option value="under_${m}">${awayTeam} ${m > 0 ? "+" : ""}${m - 0.5}</option>`;
    }
    totalSelect.innerHTML = `<option value="">Any Total</option>`;
    for (let t = 0; t <= 80; t++) {
      totalSelect.innerHTML += `<option value="over_${t}">Over ${t - 0.5}</option>`;
      totalSelect.innerHTML += `<option value="under_${t}">Under ${t - 0.5}</option>`;
    }
  }

  // --- MATCHES ---
  function fetchMatchesAndPopulate() {
    matchSelect.innerHTML = `<option value="">Loading...</option>`;
    teamsContainer.innerHTML = '';
    resultDiv.textContent = '';
    return fetch(`${API_BASE}/current_round_matches/${competition}`)
      .then(res => res.json())
      .then(matches => {
        matchList = matches;
        matchSelect.innerHTML = `<option value="">-- Select a Match --</option>`;
        (matches || []).forEach(match => {
          const opt = document.createElement('option');
          opt.value = match.match_id;
          const dateString = formatDateString(match.date);
          opt.textContent = `${match.home_team} vs ${match.away_team} (${dateString})`;
          matchSelect.appendChild(opt);
        });
        selectedMatch = null;
        playerInputs = {};
        resetTryscorerCache();
        populateFixedLines();
      });
  }
  fetchMatchesAndPopulate().then(() => {
    const params = new URLSearchParams(window.location.search);
    let option = null;

    const matchId = params.get('match_id');
    if (matchId) {
      option = matchSelect.querySelector(`option[value="${matchId}"]`);
    }

    // Fallback: match by home/away team name substrings in the option text
    if (!option) {
      const home = params.get('home');
      const away = params.get('away');
      if (home && away) {
        const h = home.toLowerCase();
        const a = away.toLowerCase();
        option = Array.from(matchSelect.options).find(o => {
          const t = o.textContent.toLowerCase();
          return t.includes(h) && t.includes(a);
        });
      }
    }

    if (option) {
      matchSelect.value = option.value;
      matchSelect.dispatchEvent(new Event('change'));
    }
  });

  // --- WHEN MATCH CHANGES ---
  matchSelect.addEventListener('change', function () {
    const matchId = this.value;
    if (!matchId) {
      teamsContainer.innerHTML = '';
      resultDiv.textContent = '';
      populateFixedLines();
      selectedMatch = null;
      playerInputs = {};
      resetTryscorerCache();
      return;
    }
    teamsContainer.innerHTML = '<div class="w-full text-center py-8">Loading team lists...</div>';
    fetch(`${API_BASE}/match_team_lists/${matchId}/${competition}`)
      .then(res => res.json())
      .then(data => {
        selectedMatch = data;
        playerInputs = {};
        resetTryscorerCache();
        renderTeams(data);
        populateFixedLines(data.home_team, data.away_team);
        if (resetAllBtn) resetAllBtn.disabled = false;
        if (homeWinBtn) { homeWinBtn.textContent = data.home_team; homeWinBtn.disabled = false; }
        if (awayWinBtn) { awayWinBtn.textContent = data.away_team; awayWinBtn.disabled = false; }
        updateProbability();
      });
  });

  // --- TEAM WIN BUTTONS ---
  // Home wins = "HomeTeam -0.5" = over_1 in margin select (m=0 loop iteration)
  // Away wins = "AwayTeam -0.5" = under_0 in margin select (m=0 loop iteration)
  if (homeWinBtn) {
    homeWinBtn.addEventListener('click', () => {
      marginSelect.value = 'over_1';
      marginSelect.dispatchEvent(new Event('change'));
    });
  }
  if (awayWinBtn) {
    awayWinBtn.addEventListener('click', () => {
      marginSelect.value = 'under_0';
      marginSelect.dispatchEvent(new Event('change'));
    });
  }

  // --- RESET ALL ---
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
      // Reset all player try counts
      ['home', 'away'].forEach(side => {
        Object.keys(playerInputs[side] || {}).forEach(id => {
          playerInputs[side][id] = 0;
          const countEl = document.getElementById(`${side}-${id}`);
          if (countEl) countEl.textContent = '0';
          const row = teamsContainer.querySelector(`.player-row[data-side="${side}"][data-id="${id}"]`);
          if (row) row.classList.remove('bg-gray-700/40');
          // Find the parent team card to update button states
          const btn = teamsContainer.querySelector(`.sgm-minus-btn[data-side="${side}"][data-id="${id}"]`);
          if (btn) setButtonStates(btn.closest('.bg-gray-800'), side, id, 0);
        });
      });
      // Reset margin and total selects
      marginSelect.value = '';
      totalSelect.value = '';
      updateProbability();
    });
  }

  // --- MARGIN/TOTAL SELECT CHANGES ---
  marginSelect.addEventListener('change', updateProbability);
  totalSelect.addEventListener('change', updateProbability);

  // -- Download CSV Listeners
  if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener('click', function () {
      if (!selectedMatch || !matchSelect.value) {
        alert('Please select a match first.');
        return;
      }

      if (!tryscorerDataCache.home || !tryscorerDataCache.away) {
        alert('Tryscorer data is still loading. Please wait a moment and try again.');
        return;
      }

      const rows = buildTryscorerRowsFromCache();
      if (!rows.length) {
        alert('No tryscorer data available to export.');
        return;
      }

      const safeHome = (selectedMatch.home_team || 'home').replace(/[^a-z0-9]+/gi, '_');
      const safeAway = (selectedMatch.away_team || 'away').replace(/[^a-z0-9]+/gi, '_');
      const filename = `tryscorer_probs_${safeHome}_vs_${safeAway}.csv`;

      const csv = rowsToCsv(rows);
      downloadTextFile(csv, filename);
    });
  }

  // --- BUTTON STATE HELPER ---
  function setButtonStates(teamDiv, side, id, val) {
    const base = 'w-6 h-6 border rounded flex items-center justify-center text-sm font-bold transition-colors';
    const minusBtn = teamDiv.querySelector(`.sgm-minus-btn[data-side="${side}"][data-id="${id}"]`);
    const plusBtn  = teamDiv.querySelector(`.sgm-plus-btn[data-side="${side}"][data-id="${id}"]`);
    if (minusBtn) {
      minusBtn.className = val > 0
        ? `sgm-minus-btn ${base} border-red-500 text-red-400 hover:bg-red-500/20`
        : `sgm-minus-btn ${base} border-gray-700 text-gray-600`;
    }
    if (plusBtn) {
      plusBtn.className = val >= 5
        ? `sgm-plus-btn ${base} border-gray-700 text-gray-600`
        : val > 0
          ? `sgm-plus-btn ${base} border-green-500 text-green-400 hover:bg-green-500/20`
          : `sgm-plus-btn ${base} border-gray-600 text-gray-400 hover:border-green-400 hover:text-green-400`;
    }
  }

  // --- HELPERS ---
  function teamLogoSlug(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('broncos'))   return 'broncos';
    if (n.includes('bulldogs'))  return 'bulldogs';
    if (n.includes('cowboys'))   return 'cowboys';
    if (n.includes('dolphins'))  return 'dolphins';
    if (n.includes('dragons'))   return 'dragons';
    if (n.includes('eels'))      return 'eels';
    if (n.includes('knights'))   return 'knights';
    if (n.includes('sea eagles') || n.includes('manly')) return 'manly';
    if (n.includes('panthers'))  return 'panthers';
    if (n.includes('rabbitohs')) return 'rabbitohs';
    if (n.includes('raiders'))   return 'raiders';
    if (n.includes('roosters'))  return 'roosters';
    if (n.includes('sharks'))    return 'sharks';
    if (n.includes('storm'))     return 'storm';
    if (n.includes('tigers'))    return 'tigers';
    if (n.includes('titans'))    return 'titans';
    if (n.includes('warriors'))  return 'warriors';
    return null;
  }

// --- RENDER TEAMS ---
  function renderTeams(data) {
    teamsContainer.innerHTML = '';
    ['home', 'away'].forEach(side => {
      const teamName = data[`${side}_team`];
      const players = data[`${side}_players`];
      playerInputs[side] = {};

      const slug = teamLogoSlug(teamName);
      const logoHtml = slug
        ? `<img src="../logos/${slug}.svg" class="w-8 h-8 object-contain shrink-0" alt="">`
        : '';

      const teamDiv = document.createElement('div');
      teamDiv.className = 'bg-gray-800 border border-gray-700 rounded-xl p-4 w-full md:w-96 shadow-md';
      teamDiv.innerHTML = `
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            ${logoHtml}
            <span class="font-bold text-base">${teamName}</span>
          </div>
          <button type="button" class="clear-team-btn text-xs text-gray-400 hover:text-white border border-gray-600 hover:border-gray-400 px-2 py-1 rounded transition-colors">Clear</button>
        </div>
        <div class="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 px-1">
          <span class="flex-1">Player</span>
          <span class="w-14 text-right">Anytime</span>
          <span class="w-20 text-center">Tries</span>
        </div>
        <div class="flex flex-col divide-y divide-gray-700/50">
          ${players.map(p => `
            <div class="flex items-center gap-2 py-2 px-1 player-row" data-side="${side}" data-id="${p.id}">
              <div class="flex-1 min-w-0">
                <span class="text-sm">${p.name}</span>
                <span class="text-xs text-gray-500 ml-1">(${p.position})</span>
              </div>
              <span id="anytime-${side}-${p.id}" class="w-14 text-right text-xs font-semibold text-gray-600">·</span>
              <div class="flex items-center gap-1">
                <button type="button"
                  class="sgm-minus-btn w-6 h-6 border border-gray-700 text-gray-600 rounded flex items-center justify-center text-sm font-bold transition-colors"
                  data-side="${side}" data-id="${p.id}" tabindex="0">−</button>
                <span id="${side}-${p.id}" class="w-6 text-center text-sm font-bold text-white select-none">0</span>
                <button type="button"
                  class="sgm-plus-btn w-6 h-6 border border-gray-600 text-gray-400 hover:border-green-400 hover:text-green-400 rounded flex items-center justify-center text-sm font-bold transition-colors"
                  data-side="${side}" data-id="${p.id}" tabindex="0">+</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
      teamsContainer.appendChild(teamDiv);

      // --- Clear button ---
      teamDiv.querySelector('.clear-team-btn').addEventListener('click', () => {
        players.forEach(p => {
          playerInputs[side][p.id] = 0;
          const countEl = teamDiv.querySelector(`#${side}-${p.id}`);
          if (countEl) countEl.textContent = '0';
          const row = teamDiv.querySelector(`.player-row[data-side="${side}"][data-id="${p.id}"]`);
          if (row) row.classList.remove('bg-gray-700/40');
          setButtonStates(teamDiv, side, p.id, 0);
        });
        updateProbability();
      });

      // --- Add +/− listeners ---
      players.forEach(p => {
        const countEl = teamDiv.querySelector(`#${side}-${p.id}`);
        const row = teamDiv.querySelector(`.player-row[data-side="${side}"][data-id="${p.id}"]`);
        playerInputs[side][p.id] = 0;
        teamDiv.querySelector(`.sgm-minus-btn[data-side="${side}"][data-id="${p.id}"]`).addEventListener('click', () => {
          let val = playerInputs[side][p.id] || 0;
          if (val > 0) val--;
          playerInputs[side][p.id] = val;
          countEl.textContent = val;
          if (row) row.classList.toggle('bg-gray-700/40', val > 0);
          setButtonStates(teamDiv, side, p.id, val);
          updateProbability();
        });
        teamDiv.querySelector(`.sgm-plus-btn[data-side="${side}"][data-id="${p.id}"]`).addEventListener('click', () => {
          let val = playerInputs[side][p.id] || 0;
          if (val < 5) val++;
          playerInputs[side][p.id] = val;
          countEl.textContent = val;
          if (row) row.classList.toggle('bg-gray-700/40', val > 0);
          setButtonStates(teamDiv, side, p.id, val);
          updateProbability();
        });
      });

      // --- Fetch try probabilities and try distribution, then update "Anytime" column ---
      const matchId = matchSelect.value;
      const teamId = players[0]?.team_id;
      if (matchId && teamId) {
        Promise.all([
          fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}/${competition}`).then(res => res.json()),
          fetch(`${API_BASE}/match_try_distribution/${matchId}/${teamId}`).then(res => res.json())
        ]).then(([tryProbs, tryDist]) => {
          tryscorerDataCache[side] = { teamName, teamId, players, tryProbs, tryDist };

          if (downloadCsvBtn && tryscorerDataCache.home && tryscorerDataCache.away) {
            downloadCsvBtn.disabled = false;
          }

          players.forEach((p) => {
            const el = document.getElementById(`anytime-${side}-${p.id}`);
            if (!el) return;
            const playerProb = tryProbs[p.id] ?? tryProbs[String(p.id)];
            if (playerProb !== undefined && tryDist) {
              const prob = anytimeTryscorerProbability(playerProb, tryDist, 20);
              el.textContent = (prob * 100).toFixed(1) + '%';
              el.className = 'w-14 text-right text-xs font-semibold text-gray-300';
            } else {
              el.textContent = '–';
              el.className = 'w-14 text-right text-xs font-semibold text-gray-500';
            }
          });
        }).catch(() => {
          tryscorerDataCache[side] = null;
          players.forEach(p => {
            const el = document.getElementById(`anytime-${side}-${p.id}`);
            if (el) { el.textContent = '–'; el.className = 'w-14 text-right text-xs font-semibold text-gray-500'; }
          });
        });
      }
    });
  }

  // --- FORMATTING ---
  function formatDateString(dateStr) {
    if (!dateStr) return '';
    const match = dateStr.match(/\d{2} \w{3} \d{4}/);
    if (match) return match[0];
    return dateStr;
  }

  function anytimeTryscorerProbability(p, tryDist, maxN = 20) {
    let prob = 0;
    for (let n = 1; n <= maxN; n++) {
      const pn = tryDist[n] || tryDist[n.toString()] || 0;
      prob += pn * (1 - Math.pow(1 - p, n));
    }
    return prob;
  }

// --- CSV Populating Helper Functions

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function downloadTextFile(content, filename, mimeType = 'text/csv;charset=utf-8;') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
  }

  function buildTryscorerRowsFromCache() {
    const rows = [];

    ['home', 'away'].forEach((side) => {
      const cached = tryscorerDataCache[side];
      if (!cached) return;

      const { teamName, players, tryProbs, tryDist } = cached;

      players.forEach((player) => {
        const perTryProb = tryProbs[player.id] ?? tryProbs[String(player.id)];
        const anytimeProb =
          perTryProb !== undefined && tryDist
            ? anytimeTryscorerProbability(perTryProb, tryDist, 20)
            : null;

        rows.push({
          team: teamName,
          side,
          player_id: player.id,
          player_name: player.name,
          position: player.position,
          per_try_prob: perTryProb,
          anytime_prob: anytimeProb
        });
      });
    });

    return rows;
  }

  function rowsToCsv(rows) {
    const headers = [
      'team',
      'side',
      'player_id',
      'player_name',
      'position',
      'per_try_prob',
      'per_try_prob_pct',
      'anytime_prob',
      'anytime_prob_pct'
    ];

    const lines = [headers.join(',')];

    rows.forEach((row) => {
      lines.push([
        csvEscape(row.team),
        csvEscape(row.side),
        csvEscape(row.player_id),
        csvEscape(row.player_name),
        csvEscape(row.position),
        csvEscape(row.per_try_prob ?? ''),
        csvEscape(row.per_try_prob != null ? (row.per_try_prob * 100).toFixed(2) : ''),
        csvEscape(row.anytime_prob ?? ''),
        csvEscape(row.anytime_prob != null ? (row.anytime_prob * 100).toFixed(2) : '')
      ].join(','));
    });

    return lines.join('\n');
  }

  // --- SGM DIST HELPERS ---
  function getSgmDist(matchId, marginType, marginVal, totalType, totalVal) {
    let params = [];
    if (marginType === "over") params.push(`margin_gte=${marginVal}`);
    if (marginType === "under") params.push(`margin_lte=${marginVal - 1}`);
    if (totalType === "over") params.push(`total_gte=${totalVal}`);
    if (totalType === "under") params.push(`total_lte=${totalVal-1}`);
    const paramString = params.length ? `?${params.join("&")}` : "";
    return fetch(`${API_BASE}/match_sgm_bins_range/${matchId}${paramString}`)
      .then(res => res.json());
  }

  function fetchLineOnlyProb(matchId, margin_type, margin_val, total_type, total_val, cb) {
    getSgmDist(matchId, margin_type, margin_val, total_type, total_val)
      .then(sgmDist => {
        let comboProb = typeof sgmDist.prob === "number" ? sgmDist.prob : 0;
        cb(comboProb);
      })
      .catch(() => {
        cb(0);
      });
  }

  // --- PROBABILITY CALC ---
  function updateProbability() {
    if (!selectedMatch) {
      resultDiv.textContent = "Select one or more tryscorers";
      return;
    }
    const marginLineVal = marginSelect.value;
    const totalLineVal = totalSelect.value;
    const matchId = matchSelect.value;
    let margin_type = null, margin_val = null, total_type = null, total_val = null;
    if (marginLineVal) [margin_type, margin_val] = marginLineVal.split('_'), margin_val = Number(margin_val);
    if (totalLineVal) [total_type, total_val] = totalLineVal.split('_'), total_val = Number(total_val);

    const anyHome = Object.values(playerInputs.home || {}).some(v => v > 0);
    const anyAway = Object.values(playerInputs.away || {}).some(v => v > 0);
    const anyTries = anyHome || anyAway;

    if (!anyTries && (marginLineVal || totalLineVal)) {
      resultDiv.textContent = "Loading odds...";
      fetchLineOnlyProb(matchId, margin_type, margin_val, total_type, total_val, (comboProb) => {
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
    if (!anyTries && !(marginLineVal || totalLineVal)) {
      resultDiv.textContent = "Select one or more tryscorers";
      return;
    }

    // --- SGM Calculation ---
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
        fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}/${competition}`).then(res => res.json()),
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

  // --- INIT ---
  populateFixedLines();
});
