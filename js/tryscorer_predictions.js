// pages/tryscorer_predictions.js
const _SB_URL = 'https://xjqpyyhqzatzlmlojcxv.supabase.co';
const _SB_KEY = 'sb_publishable_5HgdhAE4ePEAF103sINpqQ_qL3a2E9W';

// --- KDE helpers (mirrors predictions.js) ---
function _normPdf(x, mu, sigma) {
  return Math.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
}
function _stddev(arr) {
  if (arr.length < 2) return 6;
  const mu = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length;
  return Math.max(Math.sqrt(variance), 1);
}
// Silverman's rule-of-thumb bandwidth
function _silvermanBw(values) {
  if (values.length < 2) return 6;
  return Math.max(1.06 * _stddev(values) * Math.pow(values.length, -0.2), 1);
}
// Calibrated bandwidth: matches machine spread — same formula as predictions.js calibratedBandwidth()
function _calibratedBw(values, modelSigma) {
  if (!modelSigma) return _silvermanBw(values);
  const sigmaU = _stddev(values);
  return Math.max(1, Math.sqrt(Math.max(0, modelSigma ** 2 - sigmaU ** 2)));
}
// Sigma of a machine distribution from [{x, prob}] bins
function _machineSigmaFromBins(bins) {
  if (!bins?.length) return null;
  const total = bins.reduce((s, b) => s + b.prob, 0);
  if (!total) return null;
  const mu = bins.reduce((s, b) => s + b.x * b.prob, 0) / total;
  const variance = bins.reduce((s, b) => s + b.prob * (b.x - mu) ** 2, 0) / total;
  return Math.sqrt(variance);
}
// P(X >= threshold) from a Gaussian KDE over `values`, evaluated on the integer grid [xMin, xMax]
function _kdeLineProbGte(values, xMin, xMax, threshold, modelSigma) {
  if (!values.length) return null;
  const h = _calibratedBw(values, modelSigma);
  let total = 0, above = 0;
  for (let x = xMin; x <= xMax; x++) {
    const y = values.reduce((s, v) => s + _normPdf(x, v, h), 0) / values.length;
    total += y;
    if (x >= threshold) above += y;
  }
  return total > 0 ? above / total : null;
}
// KDE density at a single point x — used for per-bin crowd weighting
function _kdeDensityAt(values, x, modelSigma) {
  if (!values.length) return 0;
  const h = _calibratedBw(values, modelSigma);
  return values.reduce((s, v) => s + _normPdf(x, v, h), 0) / values.length;
}
// Blend machine-weighted and crowd-weighted try distributions from raw sgmDist bins.
// bins: [{m, t, h, a, c}] — from sgmDist.bins (margin, total, home_try_dist, away_try_dist, count)
// Returns { home_try_dist, away_try_dist } — blended distributions ready for sgm_probability
function _blendedTryDists(sgmDist, userPicks, marginSigma, totalSigma, blendT) {
  const bins = sgmDist.bins;
  // Fall back to machine aggregate if no blending needed or no raw bins available
  if (!blendT || !bins?.length || !userPicks.margins.length) {
    return { home_try_dist: sgmDist.home_try_dist, away_try_dist: sgmDist.away_try_dist };
  }

  const totalMachine = bins.reduce((s, b) => s + b.c, 0) || 1;

  // Crowd weight for each bin = joint density approximated as product of marginal KDE densities
  const crowdW = bins.map(b =>
    _kdeDensityAt(userPicks.margins, b.m, marginSigma) *
    _kdeDensityAt(userPicks.totals,  b.t, totalSigma)
  );
  const totalCrowd = crowdW.reduce((s, w) => s + w, 0) || null;

  // If crowd has no density near any bin (picks wildly outside model range), fall back
  if (!totalCrowd) {
    return { home_try_dist: sgmDist.home_try_dist, away_try_dist: sgmDist.away_try_dist };
  }

  const aggHome = {}, aggAway = {};
  bins.forEach((bin, i) => {
    const wMachine = bin.c / totalMachine;
    const wCrowd   = crowdW[i] / totalCrowd;
    const w = (1 - blendT) * wMachine + blendT * wCrowd;
    for (const [k, v] of Object.entries(bin.h)) aggHome[k] = (aggHome[k] || 0) + v * w;
    for (const [k, v] of Object.entries(bin.a)) aggAway[k] = (aggAway[k] || 0) + v * w;
  });

  return { home_try_dist: aggHome, away_try_dist: aggAway };
}

document.addEventListener("DOMContentLoaded", function () {
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
  let blendT               = 0;        // 0 = pure machine, 1 = pure crowd
  let userPicksCache       = {};       // { matchId: { margins: [], totals: [] } }
  let machineScoreDistCache = {};      // { matchId: { margins: [{x,prob}], totals: [{x,prob}] } }
  let roundSigmaScale      = { margin: null, total: null }; // round-level σ ratio (machine/crowd)

  // --- BLEND SLIDER ELEMENTS ---
  const blendSlider   = document.getElementById('model-blend-slider');
  const blendPctLabel = document.getElementById('blend-pct-label');
  const blendInfoEl   = document.getElementById('blend-info');

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
  async function fetchMatchesAndPopulate() {
    matchSelect.innerHTML = `<option value="">Loading...</option>`;
    teamsContainer.innerHTML = '';
    resultDiv.innerHTML = '';
    matchList = []; currentMatchId = null; selectedMatch = null;
    teamListCache = {}; allPlayerInputs = {}; allTryscorerData = {};
    matchMargins = {}; matchTotals = {}; matchMarginLabels = {}; matchTotalLabels = {};
    userPicksCache = {};
    machineScoreDistCache = {};
    roundSigmaScale = { margin: null, total: null };
    betslipExpanded = false;
    setControlsEnabled(false);
    populateFixedLines();

    const res     = await fetch(`${API_BASE}/current_round_matches/${competition}`);
    const matches = await res.json();
    const matchIds = (matches || []).map(m => m.match_id).filter(Boolean);

    // Fetch kickoff times from Supabase games table (match_id === game_id)
    let kickoffMap = {};
    if (matchIds.length) {
      try {
        const sbRes = await fetch(
          `${_SB_URL}/rest/v1/games?select=game_id,kickoff_time&game_id=in.(${matchIds.join(',')})`,
          { headers: { apikey: _SB_KEY, Authorization: `Bearer ${_SB_KEY}` } }
        );
        const gamesData = await sbRes.json();
        if (Array.isArray(gamesData)) {
          gamesData.forEach(g => { kickoffMap[g.game_id] = g.kickoff_time; });
        }
      } catch {}
    }

    const sorted = (matches || []).slice().sort((a, b) => {
      const ka = kickoffMap[a.match_id] ?? a.date ?? '';
      const kb = kickoffMap[b.match_id] ?? b.date ?? '';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    matchList = sorted;
    matchSelect.innerHTML = `<option value="">-- Select a Match --</option>`;
    sorted.forEach(match => {
      const opt = document.createElement('option');
      opt.value = match.match_id;
      const label = `${match.home_team} vs ${match.away_team} (${formatDateString(match.date)})`;
      opt.textContent = label;
      opt.dataset.label = label;
      matchSelect.appendChild(opt);
    });

    // Compute round sigma scale in background so KDE bandwidth matches predictions page
    computeRoundSigmaScale();
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
    updateBlendInfo(matchId);

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

    // Show loading overlay unless both sides already cached
    const cached = allTryscorerData[matchId];
    if (!cached || !cached.home || !cached.away) {
      const overlay = document.createElement('div');
      overlay.id = 'prob-loading-overlay';
      overlay.style.cssText = 'position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.75rem;background:rgba(15,17,23,0.85);border-radius:12px;';
      overlay.innerHTML = `
        <style>@keyframes bsm-spin{to{transform:rotate(360deg)}}</style>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style="animation:bsm-spin 0.8s linear infinite;">
          <circle cx="12" cy="12" r="10" stroke="rgba(245,158,11,0.2)" stroke-width="3"/>
          <path d="M12 2a10 10 0 0 1 10 10" stroke="#f59e0b" stroke-width="3" stroke-linecap="round"/>
        </svg>
        <span style="font-family:'Barlow Condensed',system-ui,sans-serif;font-size:0.9375rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#8892a4;">Loading Probabilities…</span>
      `;
      // teamsContainer needs position:relative for the overlay to anchor correctly
      teamsContainer.style.position = 'relative';
      teamsContainer.appendChild(overlay);
    }
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
          <span class="w-20 text-right">Anytime</span>
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
              <div id="anytime-${side}-${p.id}" class="w-20 text-right shrink-0"><div class="text-xs font-semibold text-gray-600">·</div></div>
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
        if (!allTryscorerData[matchId]) allTryscorerData[matchId] = { home: null, away: null, _loadingCount: 0 };

        const populateAnytime = (tryProbs, tryDist) => {
          players.forEach(p => {
            const el = document.getElementById(`anytime-${side}-${p.id}`);
            if (!el) return;
            const playerProb = tryProbs[p.id] ?? tryProbs[String(p.id)];
            if (playerProb !== undefined && tryDist) {
              const prob = anytimeTryscorerProbability(playerProb, tryDist, 20);
              el.innerHTML = `<div class="text-xs font-semibold text-gray-300">${(prob * 100).toFixed(1)}%</div><div class="text-xs text-gray-500">$${(1 / prob).toFixed(2)}</div>`;
            } else {
              el.innerHTML = '<div class="text-xs font-semibold text-gray-500">–</div>';
            }
          });
        };

        const removeOverlay = () => {
          if (currentMatchId === matchId) {
            const overlay = document.getElementById('prob-loading-overlay');
            if (overlay) overlay.remove();
          }
        };

        if (allTryscorerData[matchId][side]) {
          // Already cached — repopulate display
          const { tryProbs, tryDist } = allTryscorerData[matchId][side];
          populateAnytime(tryProbs, tryDist);
          if (downloadCsvBtn && allTryscorerData[matchId].home && allTryscorerData[matchId].away && currentMatchId === matchId) {
            downloadCsvBtn.disabled = false;
          }
          removeOverlay();
        } else {
          allTryscorerData[matchId]._loadingCount = (allTryscorerData[matchId]._loadingCount || 0) + 1;
          Promise.all([
            fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}/${competition}`).then(r => r.json()),
            fetch(`${API_BASE}/match_try_distribution/${matchId}/${teamId}`).then(r => r.json())
          ]).then(([tryProbs, tryDist]) => {
            allTryscorerData[matchId][side] = { teamName, teamId, players, tryProbs, tryDist };
            allTryscorerData[matchId]._loadingCount--;
            if (downloadCsvBtn && allTryscorerData[matchId].home && allTryscorerData[matchId].away && currentMatchId === matchId) {
              downloadCsvBtn.disabled = false;
            }
            populateAnytime(tryProbs, tryDist);
            if (allTryscorerData[matchId]._loadingCount === 0) removeOverlay();
          }).catch(() => {
            allTryscorerData[matchId][side] = null;
            allTryscorerData[matchId]._loadingCount--;
            players.forEach(p => {
              const el = document.getElementById(`anytime-${side}-${p.id}`);
              if (el) el.innerHTML = '<div class="text-xs font-semibold text-gray-500">–</div>';
            });
            if (allTryscorerData[matchId]._loadingCount === 0) removeOverlay();
          });
        }
      }
    });
  }

  // --- BLEND SLIDER ---
  function updateBlendLabel() {
    const pct = Math.round(blendT * 100);
    if (!blendPctLabel) return;
    if (pct === 0)   blendPctLabel.textContent = '100% Machine Model';
    else if (pct === 100) blendPctLabel.textContent = '100% Crowd Model';
    else blendPctLabel.textContent = `${100 - pct}% Machine · ${pct}% Crowd`;
  }

  if (blendSlider) {
    blendSlider.addEventListener('input', () => {
      blendT = blendSlider.valueAsNumber / 100;
      updateBlendLabel();
      recalculateAllOdds();
    });
  }

  const blendDecBtn = document.getElementById('blend-dec');
  const blendIncBtn = document.getElementById('blend-inc');
  if (blendDecBtn) {
    blendDecBtn.addEventListener('click', () => {
      if (!blendSlider) return;
      blendSlider.value = Math.max(0, blendSlider.valueAsNumber - 5);
      blendSlider.dispatchEvent(new Event('input'));
    });
  }
  if (blendIncBtn) {
    blendIncBtn.addEventListener('click', () => {
      if (!blendSlider) return;
      blendSlider.value = Math.min(100, blendSlider.valueAsNumber + 5);
      blendSlider.dispatchEvent(new Event('input'));
    });
  }

  // Compute round-level sigma scale R = mean(σ_machine) / mean(σ_crowd) across all matches —
  // mirrors predictions.js updateUserModelOverlays(). Runs in background after matchList loads.
  async function computeRoundSigmaScale() {
    if (!matchList.length) return;
    const roundNumber = matchList[0]?.round_number;
    if (!roundNumber) return;

    // Fetch all round picks and all machine dists in parallel
    let roundPicksByGame = {};
    try {
      const res  = await fetch(`${API_BASE}/round_picks/${roundNumber}/${competition}`);
      const data = await res.json();
      roundPicksByGame = data.byGame || {};
      // Warm the picks cache for all matches in this round
      Object.entries(roundPicksByGame).forEach(([gameId, game]) => {
        if (userPicksCache[gameId] === undefined) {
          userPicksCache[gameId] = { margins: game.margins || [], totals: game.totals || [] };
        }
      });
    } catch { return; }

    const matchDists = await Promise.all(matchList.map(m => fetchMachineScoreDist(m.match_id)));

    const machMargSigmas = [], machTotSigmas = [];
    const userMargSigmas = [], userTotSigmas = [];

    matchList.forEach((match, i) => {
      const game = roundPicksByGame[String(match.match_id)];
      const dist = matchDists[i];
      if (!game || !dist) return;
      const margins = game.margins || [];
      const totals  = game.totals  || [];
      if (margins.length < 2) return;

      const σM  = _machineSigmaFromBins(dist.margins);
      const σT  = _machineSigmaFromBins(dist.totals);
      const σUm = _stddev(margins);
      const σUt = _stddev(totals);

      if (σM && σUm > 0) { machMargSigmas.push(σM); userMargSigmas.push(σUm); }
      if (σT && σUt > 0) { machTotSigmas.push(σT);  userTotSigmas.push(σUt); }
    });

    const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
    roundSigmaScale = {
      margin: machMargSigmas.length >= 2 ? avg(machMargSigmas) / avg(userMargSigmas) : null,
      total:  machTotSigmas.length  >= 2 ? avg(machTotSigmas)  / avg(userTotSigmas)  : null,
    };
  }

  // Fetch crowd pick distributions for a match via the backend round_picks endpoint.
  // Returns { margins: [...], totals: [...] } — parallel arrays (index i = same pick).
  async function fetchUserPicksForMatch(matchId) {
    if (userPicksCache[matchId] !== undefined) return userPicksCache[matchId];
    const empty = { margins: [], totals: [] };
    const match = matchList.find(m => String(m.match_id) === String(matchId));
    if (!match || !match.round_number) { userPicksCache[matchId] = empty; return empty; }
    try {
      const res  = await fetch(`${API_BASE}/round_picks/${match.round_number}/${competition}`);
      const data = await res.json();
      const game = (data.byGame || {})[String(matchId)];
      userPicksCache[matchId] = game
        ? { margins: game.margins || [], totals: game.totals || [] }
        : empty;
    } catch {
      userPicksCache[matchId] = empty;
    }
    return userPicksCache[matchId];
  }

  // Fetch machine score distributions (margins + totals) for calibrated KDE bandwidth
  async function fetchMachineScoreDist(matchId) {
    if (machineScoreDistCache[matchId] !== undefined) return machineScoreDistCache[matchId];
    try {
      const res  = await fetch(`${API_BASE}/match_score_distributions/${matchId}`);
      const data = await res.json();
      machineScoreDistCache[matchId] = data.error ? null : data;
    } catch {
      machineScoreDistCache[matchId] = null;
    }
    return machineScoreDistCache[matchId];
  }

  // P(crowd satisfies margin/total line) using Gaussian KDE — matches predictions.js crowd model.
  // marginSigma / totalSigma: machine distribution sigma for calibrated bandwidth (may be null).
  function computeUserLineProb(picks, marginType, marginVal, totalType, totalVal, marginSigma, totalSigma) {
    const { margins, totals } = picks;
    if (!margins.length) return null;

    let prob = 1;

    if (marginType === 'over') {
      // P(home margin >= marginVal)
      const p = _kdeLineProbGte(margins, -80, 80, marginVal, marginSigma);
      if (p === null) return null;
      prob *= p;
    } else if (marginType === 'under') {
      // P(home margin <= marginVal - 1)  =  1 - P(>= marginVal)
      const p = _kdeLineProbGte(margins, -80, 80, marginVal, marginSigma);
      if (p === null) return null;
      prob *= (1 - p);
    }

    if (totalType === 'over') {
      const p = _kdeLineProbGte(totals, 0, 120, totalVal, totalSigma);
      if (p === null) return null;
      prob *= p;
    } else if (totalType === 'under') {
      const p = _kdeLineProbGte(totals, 0, 120, totalVal, totalSigma);
      if (p === null) return null;
      prob *= (1 - p);
    }

    return prob;
  }

  // Update pick-count label near blend slider (called when match changes)
  async function updateBlendInfo(matchId) {
    if (!blendInfoEl || !matchId) return;
    blendInfoEl.textContent = '...';
    const picks = await fetchUserPicksForMatch(matchId);
    const n = picks.margins.length;
    blendInfoEl.textContent = n
      ? `${n} crowd pick${n !== 1 ? 's' : ''}`
      : 'No crowd picks';
  }

  // Background anytime update when slider moves but no bets are active for the current match
  let _anytimeTimer = null;
  function _scheduleAnytimeUpdate() {
    clearTimeout(_anytimeTimer);
    _anytimeTimer = setTimeout(updateAnytimeForCurrentMatch, 300);
  }

  async function updateAnytimeForCurrentMatch() {
    const matchId = currentMatchId;
    if (!matchId) return;
    // Only proceed if tryscorer data is loaded (we need tryProbs)
    const cached = allTryscorerData[matchId];
    if (!cached?.home || !cached?.away) return;

    const marginVal = matchMargins[matchId] || '';
    const totalVal  = matchTotals[matchId]  || '';
    let margin_type = null, margin_val = null, total_type = null, total_val = null;
    if (marginVal) { [margin_type, margin_val] = marginVal.split('_'); margin_val = Number(margin_val); }
    if (totalVal)  { [total_type,  total_val]  = totalVal.split('_');  total_val  = Number(total_val); }

    try {
      const [userPicks, machineScoreDist, sgmDist] = await Promise.all([
        fetchUserPicksForMatch(matchId),
        fetchMachineScoreDist(matchId),
        getSgmDist(matchId, margin_type, margin_val, total_type, total_val),
      ]);
      if (currentMatchId !== matchId) return; // stale — match changed while fetching
      const userPickCount = userPicks.margins.length;
      const marginSigma = (userPickCount >= 2 && roundSigmaScale.margin)
        ? _stddev(userPicks.margins) * roundSigmaScale.margin
        : (machineScoreDist ? _machineSigmaFromBins(machineScoreDist.margins) : null);
      const totalSigma = (userPickCount >= 2 && roundSigmaScale.total)
        ? _stddev(userPicks.totals) * roundSigmaScale.total
        : (machineScoreDist ? _machineSigmaFromBins(machineScoreDist.totals) : null);
      updateAnytimeDisplay(matchId, _blendedTryDists(sgmDist, userPicks, marginSigma, totalSigma, blendT));
    } catch { /* silently fail */ }
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

  // Update the Anytime column for all players in the current match using blended try distributions.
  // blendedDists: { home_try_dist, away_try_dist } — as returned by _blendedTryDists()
  function updateAnytimeDisplay(matchId, blendedDists) {
    if (!matchId || matchId !== currentMatchId) return;
    const data = teamListCache[matchId];
    if (!data) return;
    ['home', 'away'].forEach(side => {
      const tryDist = blendedDists[side + '_try_dist'];
      if (!tryDist) return;
      const cached = allTryscorerData[matchId]?.[side];
      if (!cached?.tryProbs) return;
      cached.players.forEach(p => {
        const el = document.getElementById(`anytime-${side}-${p.id}`);
        if (!el) return;
        const playerProb = cached.tryProbs[p.id] ?? cached.tryProbs[String(p.id)];
        if (playerProb !== undefined) {
          const prob = anytimeTryscorerProbability(playerProb, tryDist, 20);
          el.innerHTML = `<div class="text-xs font-semibold text-gray-300">${(prob * 100).toFixed(1)}%</div><div class="text-xs text-gray-500">$${(1 / prob).toFixed(2)}</div>`;
        }
      });
    });
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
  async function calculateMatchSGM(matchId) {
    const data = teamListCache[matchId];
    if (!data) return null;

    const inputs      = allPlayerInputs[matchId] || { home: {}, away: {} };
    const marginVal   = matchMargins[matchId] || '';
    const totalVal    = matchTotals[matchId]  || '';
    const marginLabel = matchMarginLabels[matchId] || '';
    const totalLabel  = matchTotalLabels[matchId]  || '';

    let margin_type = null, margin_val = null, total_type = null, total_val = null;
    if (marginVal) { [margin_type, margin_val] = marginVal.split('_'); margin_val = Number(margin_val); }
    if (totalVal)  { [total_type,  total_val]  = totalVal.split('_');  total_val  = Number(total_val); }

    const matchLabel       = `${data.home_team} vs ${data.away_team}`;
    const hasMarginOrTotal = !!(marginVal || totalVal);
    const lineLabel        = [marginLabel, totalLabel].filter(Boolean).join(' + ');

    // Collect per-side picks
    const pickedBySide = {};
    let hasAnyPicks = false;
    ['home', 'away'].forEach(side => {
      const players = data[`${side}_players`] || [];
      const picks   = inputs[side] || {};
      pickedBySide[side] = players
        .filter(p => (picks[p.id] || 0) > 0)
        .map(p => ({ ...p, n: picks[p.id] || 0 }));
      if (pickedBySide[side].length) hasAnyPicks = true;
    });

    if (!hasAnyPicks && !hasMarginOrTotal) return null;

    // Fetch crowd picks + machine score distributions in parallel (for calibrated KDE bandwidth)
    const [userPicks, machineScoreDist] = await Promise.all([
      fetchUserPicksForMatch(matchId),
      fetchMachineScoreDist(matchId),
    ]);
    const userPickCount = userPicks.margins.length;
    // Mirror predictions.js: use round sigma scale when available (n >= 2), else per-match machine sigma
    const marginSigma = (userPickCount >= 2 && roundSigmaScale.margin)
      ? _stddev(userPicks.margins) * roundSigmaScale.margin
      : (machineScoreDist ? _machineSigmaFromBins(machineScoreDist.margins) : null);
    const totalSigma  = (userPickCount >= 2 && roundSigmaScale.total)
      ? _stddev(userPicks.totals) * roundSigmaScale.total
      : (machineScoreDist ? _machineSigmaFromBins(machineScoreDist.totals)  : null);

    // Blend machine line probability with crowd KDE probability
    function blendedLineProb(machineProb) {
      if (blendT === 0 || !hasMarginOrTotal || !userPickCount) return machineProb;
      const crowdProb = computeUserLineProb(userPicks, margin_type, margin_val, total_type, total_val, marginSigma, totalSigma);
      if (crowdProb === null) return machineProb;
      return (1 - blendT) * machineProb + blendT * crowdProb;
    }

    // Line-only (no tryscorer picks)
    if (!hasAnyPicks) {
      try {
        const sgmDist    = await getSgmDist(matchId, margin_type, margin_val, total_type, total_val);
        const machProb   = typeof sgmDist.prob === 'number' ? sgmDist.prob : 0;
        // Update anytime column with blended distributions for this margin/total filter
        if (matchId === currentMatchId) {
          updateAnytimeDisplay(matchId, _blendedTryDists(sgmDist, userPicks, marginSigma, totalSigma, blendT));
        }
        return { matchId, matchLabel, picks: [], prob: blendedLineProb(machProb), lineOnly: true, lineLabel, userPickCount };
      } catch { return null; }
    }

    // Tryscorer picks (± margin/total)
    // Fetch SGM dist once; both sides share it
    let sgmDist;
    try { sgmDist = await getSgmDist(matchId, margin_type, margin_val, total_type, total_val); }
    catch { return null; }

    const machLineProb     = typeof sgmDist.prob === 'number' ? sgmDist.prob : 1;
    const effectiveLineProb = hasMarginOrTotal ? blendedLineProb(machLineProb) : 1;

    // Blend try distributions using crowd KDE density at each (margin, total) bin
    const blendedDists = _blendedTryDists(sgmDist, userPicks, marginSigma, totalSigma, blendT);

    // Update anytime column with blended distributions (does nothing if different match is showing)
    if (matchId === currentMatchId) {
      updateAnytimeDisplay(matchId, blendedDists);
    }

    const sideResults = await Promise.all(['home', 'away'].map(async side => {
      const picked = pickedBySide[side];
      if (!picked.length) return { side, prob: 1, indivProbs: [], lineProb: null };

      const players = data[`${side}_players`] || [];
      const teamId  = players[0]?.team_id;
      if (!teamId)  return { side, prob: 1, indivProbs: [], lineProb: null };

      const cachedProbs = allTryscorerData[matchId]?.[side]?.tryProbs;
      let tryProbs;
      try {
        tryProbs = cachedProbs
          ?? await fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}/${competition}`).then(r => r.json());
      } catch { return { side, prob: 1, indivProbs: picked.map(() => null), lineProb: null }; }

      const tryDist = blendedDists[side + '_try_dist'];
      if (!tryDist) return { side, prob: 0, indivProbs: [], lineProb: null };
      const tryProbsArr = picked.map(p => tryProbs[p.id] ?? tryProbs[String(p.id)]);
      const minTriesArr = picked.map(p => p.n);
      const indivProbs  = tryProbsArr.map(p => p != null ? anytimeTryscorerProbability(p, tryDist, 20) : null);
      const lineProb    = hasMarginOrTotal ? effectiveLineProb : null;

      try {
        const d = await fetch(`${API_BASE}/sgm_probability`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ try_dist: tryDist, player_probs: tryProbsArr, min_tries: minTriesArr }),
        }).then(r => r.json());
        return { side, prob: (d.probability ?? 1) * effectiveLineProb, indivProbs, lineProb };
      } catch {
        return { side, prob: 1, indivProbs: picked.map(() => null), lineProb: null };
      }
    }));

    const combined = sideResults.reduce((acc, r) => acc * r.prob, 1);
    const allPicks = [];
    ['home', 'away'].forEach(side => {
      const sr = sideResults.find(r => r.side === side);
      pickedBySide[side].forEach((p, i) => {
        allPicks.push({ name: p.name, n: p.n, indivProb: sr?.indivProbs?.[i] ?? null });
      });
    });
    const lineProb = sideResults.find(r => r.lineProb != null)?.lineProb ?? null;
    return { matchId, matchLabel, picks: allPicks, prob: combined, lineOnly: false, lineLabel, hasMarginOrTotal, lineProb, userPickCount };
  }

  // --- RECALCULATE ALL & RENDER BETSLIP ---
  let _recalcTimer = null;

  function recalculateAllOdds() {
    updateResetAllState();

    // Gather active match IDs immediately to decide whether to show loading
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
      clearTimeout(_recalcTimer);
      renderBetslip([]);
      // No active bets — still update anytime column if match is loaded
      _scheduleAnytimeUpdate();
      return;
    }

    // Show loading state immediately, then debounce the actual API call
    renderBetslipLoading();
    clearTimeout(_recalcTimer);
    _recalcTimer = setTimeout(() => {
      Promise.all(activeIds.map(mid => calculateMatchSGM(mid)))
        .then(results => {
          renderBetslip(results.filter(Boolean));
          // If current match has no active bets (different match selected), update its anytime
          if (currentMatchId && !activeIds.includes(currentMatchId)) {
            _scheduleAnytimeUpdate();
          }
        });
    }, 250);
  }

  function renderBetslipLoading() {
    resultDiv.classList.remove('betslip-open');
    betslipExpanded = false;
    resultDiv.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Betslip</span>
        <div class="flex items-center gap-2">
          <svg class="animate-spin h-3.5 w-3.5 text-amber-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span class="text-xs text-amber-400 font-medium">Calculating…</span>
        </div>
      </div>
    `;
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

    const maxPickCount = results.reduce((mx, r) => Math.max(mx, r.userPickCount || 0), 0);
    const blendBadge = blendT > 0 && maxPickCount > 0
      ? `<span class="text-xs text-blue-400 font-medium">⚡ ${Math.round(blendT * 100)}% crowd · ${maxPickCount} pick${maxPickCount !== 1 ? 's' : ''}</span>`
      : '';

    resultDiv.innerHTML = `
      <div id="betslip-toggle" class="flex items-center justify-between md:cursor-default select-none">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Betslip</span>
          ${blendBadge}
        </div>
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
