// pages/tryscorer_predictions.js

document.addEventListener("DOMContentLoaded", function () {
  // --- HEADER ---
  fetch('/components/header.html')
    .then(res => res.text())
    .then(html => {
      document.getElementById('site-header').innerHTML = html;
      const bmcDiv = document.getElementById("bmc-button");
      if (bmcDiv) {
        bmcDiv.innerHTML = `
          <a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" rel="noopener">
            <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
                 alt="Buy Me a Coffee" style="height: 45px; width: 162px;">
          </a>`;
      }
      const menuToggle = document.getElementById("menu-toggle");
      const mobileMenu = document.getElementById("mobile-menu");
      if (menuToggle && mobileMenu) {
        menuToggle.addEventListener("click", () => mobileMenu.classList.toggle("hidden"));
      }
    });

  // --- CONFIG ---
  const API_BASE = 'https://bsmachine-backend.onrender.com/api';

  // --- ELEMENTS ---
  const matchSelect    = document.getElementById('match-select');
  const teamsContainer = document.getElementById('teams-container');
  const resultDiv      = document.getElementById('result');
  const marginSelect   = document.getElementById('margin-select');
  const totalSelect    = document.getElementById('total-select');
  const btnNrl         = document.getElementById('btn-nrl');
  const btnNrlw        = document.getElementById('btn-nrlw');
  const downloadCsvBtn  = document.getElementById('download-tryscorer-csv');
  const resetMatchBtn   = document.getElementById('reset-match-btn');
  const resetAllBtn     = document.getElementById('reset-all-btn');
  const homeWinBtn      = document.getElementById('home-win-btn');
  const awayWinBtn      = document.getElementById('away-win-btn');

  // --- COMPETITION TOGGLE ---
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
  btnNrl.addEventListener('click', () => {
    if (competition !== 'nrl') {
      competition = 'nrl';
      localStorage.setItem('bsmachine_competition', competition);
      updateCompetitionButtons();
      fetchMatchesAndPopulate();
    }
  });
  btnNrlw.addEventListener('click', () => {
    if (competition !== 'nrlw') {
      competition = 'nrlw';
      localStorage.setItem('bsmachine_competition', competition);
      updateCompetitionButtons();
      fetchMatchesAndPopulate();
    }
  });
  updateCompetitionButtons();

  // --- STATE ---
  let matchList         = [];
  let currentMatchId    = null;
  let selectedMatch     = null;       // team list data for current match
  let teamListCache     = {};         // { matchId: data }
  let allPlayerInputs   = {};         // { matchId: { home: {id: n}, away: {id: n} } }
  let allTryscorerData  = {};         // { matchId: { home: cacheObj, away: cacheObj } }
  let matchMargins      = {};         // { matchId: select value string }
  let matchTotals       = {};         // { matchId: select value string }
  let matchMarginLabels = {};         // { matchId: display label string }
  let matchTotalLabels  = {};         // { matchId: display label string }
  let betslipExpanded   = false;

  // --- CONTROLS ENABLE/DISABLE ---
  function setControlsEnabled(enabled) {
    if (downloadCsvBtn) downloadCsvBtn.disabled = !enabled;
    if (resetMatchBtn)  resetMatchBtn.disabled  = !enabled;
    if (homeWinBtn) { homeWinBtn.disabled = !enabled; if (!enabled) homeWinBtn.textContent = 'Home'; }
    if (awayWinBtn) { awayWinBtn.disabled = !enabled; if (!enabled) awayWinBtn.textContent = 'Away'; }
    updateResetAllState();
  }

  function updateResetAllState() {
    if (!resetAllBtn) return;
    const anyActive = Object.keys(allPlayerInputs).some(mid => {
      const inputs = allPlayerInputs[mid] || {};
      return Object.values(inputs.home || {}).some(v => v > 0) ||
             Object.values(inputs.away || {}).some(v => v > 0);
    }) || Object.keys(matchMargins).some(mid => matchMargins[mid]) ||
         Object.keys(matchTotals).some(mid => matchTotals[mid]);
    resetAllBtn.disabled = !anyActive;
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

  // --- FETCH MATCHES ---
  function fetchMatchesAndPopulate() {
    matchSelect.innerHTML = `<option value="">Loading...</option>`;
    teamsContainer.innerHTML = '';
    resultDiv.innerHTML = '';
    matchList = []; currentMatchId = null; selectedMatch = null;
    teamListCache = {}; allPlayerInputs = {}; allTryscorerData = {};
    matchMargins = {}; matchTotals = {}; matchMarginLabels = {}; matchTotalLabels = {};
    betslipExpanded = false;
    setControlsEnabled(false);
    populateFixedLines();

    return fetch(`${API_BASE}/current_round_matches/${competition}`)
      .then(res => res.json())
      .then(matches => {
        matchList = matches;
        matchSelect.innerHTML = `<option value="">-- Select a Match --</option>`;
        (matches || []).forEach(match => {
          const opt = document.createElement('option');
          opt.value = match.match_id;
          const label = `${match.home_team} vs ${match.away_team} (${formatDateString(match.date)})`;
          opt.textContent = label;
          opt.dataset.label = label;
          matchSelect.appendChild(opt);
        });
      });
  }

  fetchMatchesAndPopulate().then(() => {
    const params = new URLSearchParams(window.location.search);
    let option = null;
    const matchId = params.get('match_id');
    if (matchId) option = matchSelect.querySelector(`option[value="${matchId}"]`);
    if (!option) {
      const home = params.get('home');
      const away = params.get('away');
      if (home && away) {
        const h = home.toLowerCase(), a = away.toLowerCase();
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

  // --- MATCH CHANGE ---
  matchSelect.addEventListener('change', function () {
    const matchId = this.value;
    if (!matchId) {
      currentMatchId = null;
      selectedMatch = null;
      teamsContainer.innerHTML = '';
      populateFixedLines();
      setControlsEnabled(false);
      recalculateAllOdds();
      return;
    }
    loadMatch(matchId);
  });

  function loadMatch(matchId) {
    currentMatchId = matchId;

    // Restore margin/total selects for this match
    marginSelect.value = matchMargins[matchId] || '';
    totalSelect.value  = matchTotals[matchId]  || '';

    if (teamListCache[matchId]) {
      // Render from cache — no loading spinner
      selectedMatch = teamListCache[matchId];
      renderTeams(selectedMatch, matchId);
      populateFixedLines(selectedMatch.home_team, selectedMatch.away_team);
      // Re-apply stored margin/total (needs repopulated options)
      marginSelect.value = matchMargins[matchId] || '';
      totalSelect.value  = matchTotals[matchId]  || '';
      if (homeWinBtn) { homeWinBtn.textContent = selectedMatch.home_team; homeWinBtn.disabled = false; }
      if (awayWinBtn) { awayWinBtn.textContent = selectedMatch.away_team; awayWinBtn.disabled = false; }
      if (resetMatchBtn) resetMatchBtn.disabled = false;
      if (resetAllBtn)   resetAllBtn.disabled   = false;
      updateOptionBadges();
      recalculateAllOdds();
      return;
    }

    teamsContainer.innerHTML = '<div class="w-full text-center py-8 text-gray-400">Loading team lists...</div>';
    setControlsEnabled(false);

    fetch(`${API_BASE}/match_team_lists/${matchId}/${competition}`)
      .then(res => res.json())
      .then(data => {
        teamListCache[matchId] = data;
        selectedMatch = data;
        if (!allPlayerInputs[matchId]) allPlayerInputs[matchId] = { home: {}, away: {} };
        renderTeams(data, matchId);
        populateFixedLines(data.home_team, data.away_team);
        marginSelect.value = matchMargins[matchId] || '';
        totalSelect.value  = matchTotals[matchId]  || '';
        if (homeWinBtn)    { homeWinBtn.textContent = data.home_team; homeWinBtn.disabled = false; }
        if (awayWinBtn)    { awayWinBtn.textContent = data.away_team; awayWinBtn.disabled = false; }
        if (resetMatchBtn) resetMatchBtn.disabled = false;
        if (resetAllBtn)   resetAllBtn.disabled   = false;
        updateOptionBadges();
        recalculateAllOdds();
      });
  }

  // --- MARGIN/TOTAL CHANGE ---
  marginSelect.addEventListener('change', function () {
    if (currentMatchId) {
      matchMargins[currentMatchId] = this.value;
      const opt = this.options[this.selectedIndex];
      matchMarginLabels[currentMatchId] = opt ? opt.textContent : '';
    }
    recalculateAllOdds();
  });
  totalSelect.addEventListener('change', function () {
    if (currentMatchId) {
      matchTotals[currentMatchId] = this.value;
      const opt = this.options[this.selectedIndex];
      matchTotalLabels[currentMatchId] = opt ? opt.textContent : '';
    }
    recalculateAllOdds();
  });

  // --- TEAM WIN BUTTONS ---
  if (homeWinBtn) homeWinBtn.addEventListener('click', () => {
    marginSelect.value = 'over_1';
    marginSelect.dispatchEvent(new Event('change'));
  });
  if (awayWinBtn) awayWinBtn.addEventListener('click', () => {
    marginSelect.value = 'under_0';
    marginSelect.dispatchEvent(new Event('change'));
  });

  // --- RESET CURRENT MATCH ---
  function resetMatch(matchId) {
    if (!matchId) return;
    const inputs = allPlayerInputs[matchId] || {};
    ['home', 'away'].forEach(side => {
      Object.keys(inputs[side] || {}).forEach(id => {
        inputs[side][id] = 0;
        if (matchId === currentMatchId) {
          const countEl = document.getElementById(`${side}-${id}`);
          if (countEl) countEl.textContent = '0';
          const row = teamsContainer.querySelector(`.player-row[data-side="${side}"][data-id="${id}"]`);
          if (row) row.classList.remove('bg-gray-700/40');
          const btn = teamsContainer.querySelector(`.sgm-minus-btn[data-side="${side}"][data-id="${id}"]`);
          if (btn) setButtonStates(btn.closest('.bg-gray-800'), side, id, 0);
        }
      });
    });
    matchMargins[matchId] = '';
    matchTotals[matchId]  = '';
    matchMarginLabels[matchId] = '';
    matchTotalLabels[matchId]  = '';
    if (matchId === currentMatchId) {
      marginSelect.value = '';
      totalSelect.value  = '';
    }
  }

  if (resetMatchBtn) {
    resetMatchBtn.addEventListener('click', () => {
      resetMatch(currentMatchId);
      updateOptionBadges();
      recalculateAllOdds();
    });
  }

  // --- RESET ALL MATCHES ---
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
      Object.keys(allPlayerInputs).forEach(mid => resetMatch(mid));
      // Also clear any matches that only had margin/total but no player picks
      Object.keys(matchMargins).forEach(mid => resetMatch(mid));
      updateOptionBadges();
      recalculateAllOdds();
    });
  }

  // --- DOWNLOAD CSV ---
  if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener('click', function () {
      if (!selectedMatch || !currentMatchId) { alert('Please select a match first.'); return; }
      const cache = allTryscorerData[currentMatchId];
      if (!cache || !cache.home || !cache.away) {
        alert('Tryscorer data is still loading. Please wait a moment and try again.');
        return;
      }
      const rows = buildTryscorerRowsFromCache(currentMatchId);
      if (!rows.length) { alert('No tryscorer data available to export.'); return; }
      const safeHome = (selectedMatch.home_team || 'home').replace(/[^a-z0-9]+/gi, '_');
      const safeAway = (selectedMatch.away_team || 'away').replace(/[^a-z0-9]+/gi, '_');
      downloadTextFile(rowsToCsv(rows), `tryscorer_probs_${safeHome}_vs_${safeAway}.csv`);
    });
  }

  // --- OPTION BADGES ---
  function updateOptionBadges() {
    Array.from(matchSelect.options).forEach(opt => {
      if (!opt.value) return;
      const mid = opt.value;
      const inputs = allPlayerInputs[mid] || {};
      const count = Object.values(inputs.home || {}).filter(v => v > 0).length
                  + Object.values(inputs.away || {}).filter(v => v > 0).length;
      const base = opt.dataset.label || opt.textContent.replace(/ \(\d+ pick[s]?\)$/, '');
      opt.dataset.label = base;
      opt.textContent = count > 0 ? `${base} (${count} pick${count !== 1 ? 's' : ''})` : base;
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

  // --- TEAM LOGO SLUG ---
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
  function renderTeams(data, matchId) {
    teamsContainer.innerHTML = '';
    if (!allPlayerInputs[matchId]) allPlayerInputs[matchId] = { home: {}, away: {} };
    const inputs = allPlayerInputs[matchId];

    ['home', 'away'].forEach(side => {
      const teamName = data[`${side}_team`];
      const players  = data[`${side}_players`];

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
          ${players.map(p => {
            const val = inputs[side][p.id] || 0;
            return `
            <div class="flex items-center gap-2 py-2 px-1 player-row${val > 0 ? ' bg-gray-700/40' : ''}" data-side="${side}" data-id="${p.id}">
              <div class="flex-1 min-w-0">
                <span class="text-sm">${p.name}</span>
                <span class="text-xs text-gray-500 ml-1">(${p.position})</span>
              </div>
              <span id="anytime-${side}-${p.id}" class="w-14 text-right text-xs font-semibold text-gray-600">·</span>
              <div class="flex items-center gap-1">
                <button type="button"
                  class="sgm-minus-btn w-6 h-6 border border-gray-700 text-gray-600 rounded flex items-center justify-center text-sm font-bold transition-colors"
                  data-side="${side}" data-id="${p.id}" tabindex="0">−</button>
                <span id="${side}-${p.id}" class="w-6 text-center text-sm font-bold text-white select-none">${val}</span>
                <button type="button"
                  class="sgm-plus-btn w-6 h-6 border border-gray-600 text-gray-400 hover:border-green-400 hover:text-green-400 rounded flex items-center justify-center text-sm font-bold transition-colors"
                  data-side="${side}" data-id="${p.id}" tabindex="0">+</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      `;
      teamsContainer.appendChild(teamDiv);

      // Restore button states for existing picks
      players.forEach(p => {
        const val = inputs[side][p.id] || 0;
        if (val > 0) setButtonStates(teamDiv, side, p.id, val);
      });

      // Clear button
      teamDiv.querySelector('.clear-team-btn').addEventListener('click', () => {
        players.forEach(p => {
          inputs[side][p.id] = 0;
          const countEl = teamDiv.querySelector(`#${side}-${p.id}`);
          if (countEl) countEl.textContent = '0';
          const row = teamDiv.querySelector(`.player-row[data-side="${side}"][data-id="${p.id}"]`);
          if (row) row.classList.remove('bg-gray-700/40');
          setButtonStates(teamDiv, side, p.id, 0);
        });
        updateOptionBadges();
        recalculateAllOdds();
      });

      // +/- listeners
      players.forEach(p => {
        if (!inputs[side][p.id]) inputs[side][p.id] = 0;
        const countEl = teamDiv.querySelector(`#${side}-${p.id}`);
        const row     = teamDiv.querySelector(`.player-row[data-side="${side}"][data-id="${p.id}"]`);

        teamDiv.querySelector(`.sgm-minus-btn[data-side="${side}"][data-id="${p.id}"]`).addEventListener('click', () => {
          let val = inputs[side][p.id] || 0;
          if (val > 0) val--;
          inputs[side][p.id] = val;
          countEl.textContent = val;
          if (row) row.classList.toggle('bg-gray-700/40', val > 0);
          setButtonStates(teamDiv, side, p.id, val);
          updateOptionBadges();
          recalculateAllOdds();
        });
        teamDiv.querySelector(`.sgm-plus-btn[data-side="${side}"][data-id="${p.id}"]`).addEventListener('click', () => {
          let val = inputs[side][p.id] || 0;
          if (val < 5) val++;
          inputs[side][p.id] = val;
          countEl.textContent = val;
          if (row) row.classList.toggle('bg-gray-700/40', val > 0);
          setButtonStates(teamDiv, side, p.id, val);
          updateOptionBadges();
          recalculateAllOdds();
        });
      });

      // Fetch try probabilities (use cache if already loaded)
      const teamId = players[0]?.team_id;
      if (matchId && teamId) {
        if (!allTryscorerData[matchId]) allTryscorerData[matchId] = { home: null, away: null };

        const populateAnytime = (tryProbs, tryDist) => {
          players.forEach(p => {
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
        };

        if (allTryscorerData[matchId][side]) {
          // Already cached — repopulate display
          const { tryProbs, tryDist } = allTryscorerData[matchId][side];
          populateAnytime(tryProbs, tryDist);
          if (downloadCsvBtn && allTryscorerData[matchId].home && allTryscorerData[matchId].away && currentMatchId === matchId) {
            downloadCsvBtn.disabled = false;
          }
        } else {
          Promise.all([
            fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}/${competition}`).then(r => r.json()),
            fetch(`${API_BASE}/match_try_distribution/${matchId}/${teamId}`).then(r => r.json())
          ]).then(([tryProbs, tryDist]) => {
            allTryscorerData[matchId][side] = { teamName, teamId, players, tryProbs, tryDist };
            if (downloadCsvBtn && allTryscorerData[matchId].home && allTryscorerData[matchId].away && currentMatchId === matchId) {
              downloadCsvBtn.disabled = false;
            }
            populateAnytime(tryProbs, tryDist);
          }).catch(() => {
            allTryscorerData[matchId][side] = null;
            players.forEach(p => {
              const el = document.getElementById(`anytime-${side}-${p.id}`);
              if (el) { el.textContent = '–'; el.className = 'w-14 text-right text-xs font-semibold text-gray-500'; }
            });
          });
        }
      }
    });
  }

  // --- PROBABILITY HELPERS ---
  function anytimeTryscorerProbability(p, tryDist, maxN = 20) {
    let prob = 0;
    for (let n = 1; n <= maxN; n++) {
      const pn = tryDist[n] || tryDist[n.toString()] || 0;
      prob += pn * (1 - Math.pow(1 - p, n));
    }
    return prob;
  }

  function getSgmDist(matchId, marginType, marginVal, totalType, totalVal) {
    let params = [];
    if (marginType === "over")  params.push(`margin_gte=${marginVal}`);
    if (marginType === "under") params.push(`margin_lte=${marginVal - 1}`);
    if (totalType  === "over")  params.push(`total_gte=${totalVal}`);
    if (totalType  === "under") params.push(`total_lte=${totalVal - 1}`);
    const paramString = params.length ? `?${params.join("&")}` : "";
    return fetch(`${API_BASE}/match_sgm_bins_range/${matchId}${paramString}`).then(r => r.json());
  }

  // Calculate SGM for one match — returns Promise<result|null>
  function calculateMatchSGM(matchId) {
    const data = teamListCache[matchId];
    if (!data) return Promise.resolve(null);

    const inputs     = allPlayerInputs[matchId] || { home: {}, away: {} };
    const marginVal  = matchMargins[matchId] || '';
    const totalVal   = matchTotals[matchId]  || '';
    const marginLabel = matchMarginLabels[matchId] || '';
    const totalLabel  = matchTotalLabels[matchId]  || '';

    let margin_type = null, margin_val = null, total_type = null, total_val = null;
    if (marginVal) { [margin_type, margin_val] = marginVal.split('_'); margin_val = Number(margin_val); }
    if (totalVal)  { [total_type,  total_val]  = totalVal.split('_');  total_val  = Number(total_val); }

    const matchLabel = `${data.home_team} vs ${data.away_team}`;
    const hasMarginOrTotal = !!(marginVal || totalVal);
    const lineLabel = [marginLabel, totalLabel].filter(Boolean).join(' + ');

    // Collect per-side picks
    const pickedBySide = {};
    let hasAnyPicks = false;
    ['home', 'away'].forEach(side => {
      const players = data[`${side}_players`] || [];
      const picks = inputs[side] || {};
      pickedBySide[side] = players
        .filter(p => (picks[p.id] || 0) > 0)
        .map(p => ({ ...p, n: picks[p.id] || 0 }));
      if (pickedBySide[side].length) hasAnyPicks = true;
    });

    if (!hasAnyPicks && !hasMarginOrTotal) return Promise.resolve(null);

    // Line-only (no tryscorer picks)
    if (!hasAnyPicks) {
      return getSgmDist(matchId, margin_type, margin_val, total_type, total_val)
        .then(sgmDist => ({
          matchId, matchLabel,
          picks: [],
          prob: typeof sgmDist.prob === 'number' ? sgmDist.prob : 0,
          lineOnly: true,
          lineLabel
        }))
        .catch(() => null);
    }

    // Tryscorer picks (± margin/total)
    const sidePromises = ['home', 'away'].map(side => {
      const picked = pickedBySide[side];
      if (!picked.length) return Promise.resolve({ side, prob: 1, indivProbs: [], lineProb: null });

      const players = data[`${side}_players`] || [];
      const teamId  = players[0]?.team_id;
      if (!teamId) return Promise.resolve({ side, prob: 1, indivProbs: [], lineProb: null });

      return Promise.all([
        fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}/${competition}`).then(r => r.json()),
        getSgmDist(matchId, margin_type, margin_val, total_type, total_val)
      ]).then(([tryProbs, sgmDist]) => {
        if (!sgmDist || !sgmDist[side + "_try_dist"]) return { side, prob: 0, indivProbs: [], lineProb: null };
        const tryDist     = sgmDist[side + "_try_dist"];
        const sgmProb     = typeof sgmDist.prob === 'number' ? sgmDist.prob : 1;
        const tryProbsArr = picked.map(p => tryProbs[p.id] ?? tryProbs[String(p.id)]);
        const minTriesArr = picked.map(p => p.n);
        const indivProbs  = tryProbsArr.map(p => p != null ? anytimeTryscorerProbability(p, tryDist, 20) : null);
        const lineProb    = hasMarginOrTotal ? sgmProb : null;

        return fetch(`${API_BASE}/sgm_probability`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ try_dist: tryDist, player_probs: tryProbsArr, min_tries: minTriesArr })
        })
          .then(r => r.json())
          .then(d => ({ side, prob: (d.probability ?? 1) * sgmProb, indivProbs, lineProb }))
          .catch(() => ({ side, prob: 1, indivProbs: picked.map(() => null), lineProb: null }));
      }).catch(() => ({ side, prob: 1, indivProbs: picked.map(() => null), lineProb: null }));
    });

    return Promise.all(sidePromises).then(sideResults => {
      const combined = sideResults.reduce((acc, r) => acc * r.prob, 1);
      const allPicks = [];
      ['home', 'away'].forEach(side => {
        const sr = sideResults.find(r => r.side === side);
        pickedBySide[side].forEach((p, i) => {
          allPicks.push({ name: p.name, n: p.n, indivProb: sr?.indivProbs?.[i] ?? null });
        });
      });
      const lineProb = sideResults.find(r => r.lineProb != null)?.lineProb ?? null;
      return { matchId, matchLabel, picks: allPicks, prob: combined, lineOnly: false, lineLabel, hasMarginOrTotal, lineProb };
    });
  }

  // --- RECALCULATE ALL & RENDER BETSLIP ---
  function recalculateAllOdds() {
    updateResetAllState();
    // Gather all matchIds that have anything to show
    const allIds = new Set([
      ...Object.keys(allPlayerInputs),
      ...Object.keys(matchMargins).filter(mid => matchMargins[mid]),
      ...Object.keys(matchTotals).filter(mid => matchTotals[mid])
    ]);

    const activeIds = [...allIds].filter(mid => {
      const inputs = allPlayerInputs[mid] || {};
      const hasPicks = Object.values(inputs.home || {}).some(v => v > 0) ||
                       Object.values(inputs.away || {}).some(v => v > 0);
      const hasLine  = !!(matchMargins[mid] || matchTotals[mid]);
      return hasPicks || hasLine;
    });

    if (activeIds.length === 0) {
      renderBetslip([]);
      return;
    }

    Promise.all(activeIds.map(mid => calculateMatchSGM(mid)))
      .then(results => renderBetslip(results.filter(Boolean)));
  }

  // --- RENDER BETSLIP ---
  function renderBetslip(results) {
    betslipExpanded = false;

    if (results.length === 0) {
      resultDiv.innerHTML = '';
      resultDiv.classList.remove('betslip-open');
      return;
    }

    // Combined odds across all tryscorer picks (excludes line-only)
    const pickResults = results.filter(r => !r.lineOnly && r.picks && r.picks.length > 0);
    const combinedProb = pickResults.reduce((acc, r) => acc * r.prob, 1);
    const combinedOdds = combinedProb > 0 ? (1 / combinedProb).toFixed(2) : '∞';
    const combinedPct  = (combinedProb * 100).toFixed(2);
    const isMulti      = pickResults.length > 1;
    const totalLegs    = pickResults.reduce((acc, r) => acc + r.picks.length, 0);

    // Per-game leg rows
    const legsHtml = results.map(r => {
      const gameOdds = r.prob > 0 ? `$${(1 / r.prob).toFixed(2)}` : '–';
      const gamePct  = r.prob > 0 ? `${(r.prob * 100).toFixed(1)}%` : '–';

      if (r.lineOnly) {
        return `
          <div class="py-2.5 border-b border-gray-700/40 last:border-b-0">
            <div class="text-xs font-semibold text-gray-400 truncate mb-1">${r.matchLabel}</div>
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm text-gray-300 italic">${r.lineLabel}</span>
              <span class="text-sm font-bold text-amber-400 shrink-0">${gameOdds} <span class="text-xs font-normal text-gray-500">${gamePct}</span></span>
            </div>
          </div>`;
      }

      const pickLines = r.picks.map(p => {
        const indivPct  = p.indivProb != null ? `${(p.indivProb * 100).toFixed(1)}%` : null;
        const indivOdds = p.indivProb != null ? `$${(1 / p.indivProb).toFixed(2)}` : null;
        const triesLabel = p.n > 1 ? ` <span class="text-xs text-gray-400">(${p.n} tries)</span>` : '';
        return `
          <div class="flex items-center justify-between gap-2 py-0.5">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0 mt-0.5"></span>
              <span class="text-sm text-white truncate">${p.name}${triesLabel}</span>
            </div>
            ${indivPct ? `<div class="text-right shrink-0">
              <div class="text-sm font-semibold text-gray-300">${indivPct}</div>
              <div class="text-xs text-gray-500">${indivOdds}</div>
            </div>` : ''}
          </div>`;
      }).join('');

      const linePct  = r.lineProb ? `${(r.lineProb * 100).toFixed(1)}%` : null;
      const lineOdds = r.lineProb ? `$${(1 / r.lineProb).toFixed(2)}` : null;
      const lineHtml = r.hasMarginOrTotal
        ? `<div class="flex items-start justify-between gap-2 py-0.5">
             <div class="flex items-start gap-1.5 min-w-0">
               <span class="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0 mt-1.5"></span>
               <span class="text-sm text-gray-400 italic">${r.lineLabel}</span>
             </div>
             ${linePct ? `<div class="text-right shrink-0">
               <div class="text-sm font-semibold text-gray-300">${linePct}</div>
               <div class="text-xs text-gray-500">${lineOdds}</div>
             </div>` : ''}
           </div>` : '';

      return `
        <div class="py-2.5 border-b border-gray-700/40 last:border-b-0">
          <div class="text-xs font-semibold text-gray-400 truncate mb-1.5">${r.matchLabel}</div>
          ${lineHtml}
          ${pickLines}
        </div>`;
    }).join('');

    // Prominent combined odds block (always shown when there are picks)
    const hasPicks = pickResults.length > 0;
    const finalLabel = isMulti ? `Multi (${totalLegs} legs)` : pickResults.length === 1 ? 'SGM' : '';
    const finalOddsHtml = hasPicks ? `
      <div class="mt-3 pt-3 border-t border-gray-600">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-gray-300">${finalLabel}</span>
          <div class="text-right">
            <div class="text-2xl font-extrabold text-amber-400">${combinedPct}%</div>
            <div class="text-xs text-gray-500">$${combinedOdds}</div>
          </div>
        </div>
      </div>` : '';

    const bmcHtml = `
      <div class="text-xs mt-3 text-gray-400 text-center leading-tight">
        Find this useful? <a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" class="text-yellow-300 hover:underline">Buy me a coffee</a> to help pay server costs.
      </div>`;

    // Mobile collapsed summary
    const summaryOdds = hasPicks ? `$${combinedOdds}` : results[0]?.prob > 0 ? `$${(1 / results[0].prob).toFixed(2)}` : '–';
    const summaryLegs = totalLegs > 0 ? `${totalLegs} leg${totalLegs !== 1 ? 's' : ''} · ` : '';
    const summaryText = `${summaryLegs}${summaryOdds}`;

    resultDiv.innerHTML = `
      <div id="betslip-toggle" class="flex items-center justify-between md:cursor-default select-none">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Betslip</span>
        <div class="flex items-center gap-2 md:hidden">
          <span class="text-base font-bold text-amber-400">${summaryText}</span>
          <span id="betslip-chevron" class="text-gray-400 text-xs">▲</span>
        </div>
      </div>
      <div id="betslip-body" class="hidden md:block mt-1">
        ${legsHtml}
        ${finalOddsHtml}
        ${bmcHtml}
      </div>
    `;

    resultDiv.querySelector('#betslip-toggle').addEventListener('click', () => {
      if (window.innerWidth >= 768) return;
      betslipExpanded = !betslipExpanded;
      resultDiv.classList.toggle('betslip-open', betslipExpanded);
      const body    = resultDiv.querySelector('#betslip-body');
      const chevron = resultDiv.querySelector('#betslip-chevron');
      if (body)    body.classList.toggle('hidden', !betslipExpanded);
      if (chevron) chevron.textContent = betslipExpanded ? '▼' : '▲';
    });
  }

  // --- FORMATTING ---
  function formatDateString(dateStr) {
    if (!dateStr) return '';
    const m = dateStr.match(/\d{2} \w{3} \d{4}/);
    return m ? m[0] : dateStr;
  }

  // --- CSV HELPERS ---
  function buildTryscorerRowsFromCache(matchId) {
    const rows  = [];
    const cache = allTryscorerData[matchId];
    if (!cache) return rows;
    ['home', 'away'].forEach(side => {
      const cached = cache[side];
      if (!cached) return;
      const { teamName, players, tryProbs, tryDist } = cached;
      players.forEach(player => {
        const perTryProb = tryProbs[player.id] ?? tryProbs[String(player.id)];
        const anytimeProb = perTryProb !== undefined && tryDist
          ? anytimeTryscorerProbability(perTryProb, tryDist, 20) : null;
        rows.push({ team: teamName, side, player_id: player.id, player_name: player.name, position: player.position, per_try_prob: perTryProb, anytime_prob: anytimeProb });
      });
    });
    return rows;
  }

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  function rowsToCsv(rows) {
    const headers = ['team','side','player_id','player_name','position','per_try_prob','per_try_prob_pct','anytime_prob','anytime_prob_pct'];
    const lines = [headers.join(',')];
    rows.forEach(row => {
      lines.push([
        csvEscape(row.team), csvEscape(row.side), csvEscape(row.player_id), csvEscape(row.player_name),
        csvEscape(row.position),
        csvEscape(row.per_try_prob ?? ''),
        csvEscape(row.per_try_prob != null ? (row.per_try_prob * 100).toFixed(2) : ''),
        csvEscape(row.anytime_prob ?? ''),
        csvEscape(row.anytime_prob != null ? (row.anytime_prob * 100).toFixed(2) : '')
      ].join(','));
    });
    return lines.join('\n');
  }

  function downloadTextFile(content, filename, mimeType = 'text/csv;charset=utf-8;') {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- INIT ---
  populateFixedLines();
});
