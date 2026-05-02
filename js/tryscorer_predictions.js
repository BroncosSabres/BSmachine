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
// Sigma of a machine distribution from [{x, prob}] bins.
// Mirrors predictions.js: clamp to [xMin, xMax] and renormalise before computing sigma
// so extreme outlier bins don't inflate the bandwidth.
function _machineSigmaFromBins(bins, xMin = -Infinity, xMax = Infinity) {
  if (!bins?.length) return null;
  const clamped = bins.filter(b => b.x >= xMin && b.x <= xMax);
  const total = clamped.reduce((s, b) => s + b.prob, 0);
  if (!total) return null;
  const mu = clamped.reduce((s, b) => s + b.x * b.prob, 0) / total;
  const variance = clamped.reduce((s, b) => s + b.prob * (b.x - mu) ** 2, 0) / total;
  return Math.sqrt(variance);
}
// P(X >= threshold) from a Gaussian KDE over `values`, evaluated on the integer grid [xMin, xMax].
// When reflect=true, applies boundary reflection at xMin: for each data point v, a mirror at
// 2*xMin-v is added. This cancels the density that would leak below xMin without affecting
// the spread, preventing the truncation from right-shifting the effective distribution.
// Use reflect=true whenever xMin is a hard boundary (e.g. team scores bounded at 0).
function _kdeLineProbGte(values, xMin, xMax, threshold, modelSigma, reflect = false) {
  if (!values.length) return null;
  const h = _calibratedBw(values, modelSigma);
  const kernelPts = reflect ? [...values, ...values.map(v => 2 * xMin - v)] : values;
  let total = 0, above = 0;
  for (let x = xMin; x <= xMax; x++) {
    const y = kernelPts.reduce((s, v) => s + _normPdf(x, v, h), 0);
    total += y;
    if (x >= threshold) above += y;
  }
  return total > 0 ? above / total : null;
}
// Joint 2D crowd probability: P(all constraints in c) from crowd's paired (home, away) score KDE.
// Uses a product kernel (2D Gaussian at each paired pick) with boundary reflection at 0 for both
// dimensions. Evaluates all constraints — margin, total, homeTotal, awayTotal — at each (h, a)
// grid point jointly, so redundant constraints (e.g. team totals that imply the match total)
// don't compound and self-inconsistencies can't arise.
// hBw/aBw are the calibrated bandwidths for home/away scores respectively.
function _joint2dCrowdProb(homeScores, awayScores, c, hBw, aBw) {
  if (!homeScores.length) return null;
  const n = homeScores.length;

  // Pre-compute constraint bounds (mirrors computeUserLineProb logic for margin/total)
  let mGte = null, mLte = null;
  if (c?.margin1?.type === 'over')  mGte = c.margin1.val;
  if (c?.margin1?.type === 'under') mLte = c.margin1.val - 1;
  if (c?.margin2?.type === 'over')  mGte = mGte !== null ? Math.max(mGte, c.margin2.val) : c.margin2.val;
  if (c?.margin2?.type === 'under') mLte = mLte !== null ? Math.min(mLte, c.margin2.val - 1) : c.margin2.val - 1;
  let tGte = null, tLte = null;
  if (c?.total1?.type === 'over')  tGte = c.total1.val;
  if (c?.total1?.type === 'under') tLte = c.total1.val - 1;
  if (c?.total2?.type === 'over')  tGte = tGte !== null ? Math.max(tGte, c.total2.val) : c.total2.val;
  if (c?.total2?.type === 'under') tLte = tLte !== null ? Math.min(tLte, c.total2.val - 1) : c.total2.val - 1;

  let total = 0, satisfying = 0;
  for (let h = 0; h <= 80; h++) {
    for (let a = 0; a <= 80; a++) {
      // Product kernel density at (h, a) with boundary reflection at 0 for both scores
      let w = 0;
      for (let i = 0; i < n; i++) {
        const wh = _normPdf(h, homeScores[i], hBw) + _normPdf(h, -homeScores[i], hBw);
        const wa = _normPdf(a, awayScores[i], aBw) + _normPdf(a, -awayScores[i], aBw);
        w += wh * wa;
      }
      total += w;

      // Check all constraints jointly at this (h, a) point
      const m = h - a, t = h + a;
      let ok = true;
      if (mGte !== null && m < mGte) ok = false;
      if (ok && mLte !== null && m > mLte) ok = false;
      if (ok && tGte !== null && t < tGte) ok = false;
      if (ok && tLte !== null && t > tLte) ok = false;
      if (ok && c.homeTotal?.type === 'over'  && h <  c.homeTotal.val) ok = false;
      if (ok && c.homeTotal?.type === 'under' && h >= c.homeTotal.val) ok = false;
      if (ok && c.awayTotal?.type === 'over'  && a <  c.awayTotal.val) ok = false;
      if (ok && c.awayTotal?.type === 'under' && a >= c.awayTotal.val) ok = false;

      if (ok) satisfying += w;
    }
  }
  return total > 0 ? satisfying / total : null;
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
  const btnNrl         = document.getElementById('btn-nrl');
  const btnNrlw        = document.getElementById('btn-nrlw');
  const downloadCsvBtn  = document.getElementById('download-tryscorer-csv');
  const resetMatchBtn   = document.getElementById('reset-match-btn');
  const resetAllBtn     = document.getElementById('reset-all-btn');

  // Match Outcome line selectors
  const line1Row         = document.getElementById('line1-row');
  const line1DirHome     = document.getElementById('line1-dir-home');
  const line1DirAway     = document.getElementById('line1-dir-away');
  const line1ValSel      = document.getElementById('line1-val');
  const line1ClearBtn    = document.getElementById('line1-clear');
  const addLine2Btn      = document.getElementById('add-line2-btn');
  const line2Row         = document.getElementById('line2-row');
  const line2TeamLabel   = document.getElementById('line2-team-label');
  const line2ValSel      = document.getElementById('line2-val');
  const line2ClearBtn    = document.getElementById('line2-clear');
  // Total Pts / Team Pts selectors
  const totalDirOver     = document.getElementById('total-dir-over');
  const totalDirUnder    = document.getElementById('total-dir-under');
  const totalValSel      = document.getElementById('total-val');
  const totalClearBtn    = document.getElementById('total-clear');
  const addTotalCapBtn   = document.getElementById('add-total-cap-btn');
  const totalCapRow      = document.getElementById('total-cap-row');
  const totalCapDirLabel = document.getElementById('total-cap-dir-label');
  const totalCapValSel   = document.getElementById('total-cap-val');
  const totalCapClearBtn = document.getElementById('total-cap-clear');
  const homeTotalDirOver  = document.getElementById('home-total-dir-over');
  const homeTotalDirUnder = document.getElementById('home-total-dir-under');
  const homeTotalValSel   = document.getElementById('home-total-val');
  const homeTotalClearBtn = document.getElementById('home-total-clear');
  const awayTotalDirOver  = document.getElementById('away-total-dir-over');
  const awayTotalDirUnder = document.getElementById('away-total-dir-under');
  const awayTotalValSel   = document.getElementById('away-total-val');
  const awayTotalClearBtn = document.getElementById('away-total-clear');

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
  let matchLineTeam1    = {};  // { matchId: 'home'|'away'|null }
  let matchLineL1       = {};  // { matchId: float|null } — line value e.g. -6.5, +3.5
  let matchLineL2       = {};  // { matchId: float|null } — second line (opposite team)
  let matchTotalDir     = {};  // { matchId: 'over'|'under'|null }
  let matchTotalN       = {};  // { matchId: number|null }
  let matchTotalCapN    = {};  // { matchId: number|null }
  let matchHomeTotalDir = {};  // { matchId: 'over'|'under'|null }
  let matchHomeTotalN   = {};  // { matchId: number|null }
  let matchAwayTotalDir = {};  // { matchId: 'over'|'under'|null }
  let matchAwayTotalN   = {};  // { matchId: number|null }
  let betslipExpanded   = false;
  let _bookieOdds       = null;   // user-entered bookie odds for share card
  let blendT               = 0;        // 0 = pure machine, 1 = pure crowd
  let userPicksCache       = {};       // { matchId: { margins: [], totals: [] } }
  let machineScoreDistCache = {};      // { matchId: { margins: [{x,prob}], totals: [{x,prob}] } }
  let roundSigmaScale      = { margin: null, total: null }; // round-level σ ratio (machine/crowd)
  let currentBlendedDists  = null;     // most recent blended try distributions { home_try_dist, away_try_dist }

  // --- BLEND SLIDER ELEMENTS ---
  const blendSlider   = document.getElementById('model-blend-slider');
  const blendPctLabel = document.getElementById('blend-pct-label');
  const blendInfoEl   = document.getElementById('blend-info');

  // --- CONTROLS ENABLE/DISABLE ---
  function setControlsEnabled(enabled) {
    if (downloadCsvBtn) downloadCsvBtn.disabled = !enabled;
    if (resetMatchBtn)  resetMatchBtn.disabled  = !enabled;
    updateResetAllState();
  }

  function matchHasLine(matchId) {
    return !!(matchLineTeam1[matchId] && matchLineL1[matchId] != null) ||
           !!(matchTotalDir[matchId]  && matchTotalN[matchId]  != null) ||
           !!(matchHomeTotalDir[matchId] && matchHomeTotalN[matchId] != null) ||
           !!(matchAwayTotalDir[matchId] && matchAwayTotalN[matchId] != null);
  }

  // All match IDs that have any active state (tryscorer picks or any line constraint).
  // Used by resetAll, updateResetAllState, and recalculateAllOdds.
  function allActiveMatchIds() {
    return new Set([
      ...Object.keys(allPlayerInputs),
      ...Object.keys(matchLineTeam1),
      ...Object.keys(matchTotalDir),
      ...Object.keys(matchHomeTotalDir),
      ...Object.keys(matchAwayTotalDir),
    ]);
  }

  function updateResetAllState() {
    if (!resetAllBtn) return;
    const anyActive = [...allActiveMatchIds()].some(mid => {
      const inputs = allPlayerInputs[mid] || {};
      return Object.values(inputs.home || {}).some(v => v > 0) ||
             Object.values(inputs.away || {}).some(v => v > 0) ||
             matchHasLine(mid);
    });
    resetAllBtn.disabled = !anyActive;
  }

  // --- LINE LABEL HELPERS ---
  // L (float, e.g. -6.5) → constraint threshold N (integer): margin >= N for home, <= -N for away
  function lineToN(L) { return Math.floor(-L) + 1; }

  function getMarginLabel(matchId) {
    const team = matchLineTeam1[matchId], L1 = matchLineL1[matchId], L2 = matchLineL2[matchId];
    if (!team || L1 == null) return '';
    const ht = teamListCache[matchId]?.home_team || 'Home';
    const at = teamListCache[matchId]?.away_team || 'Away';
    const team1Name = team === 'home' ? ht : at;
    const team2Name = team === 'home' ? at : ht;
    const N1 = lineToN(L1);
    const L1Label = L1 === -0.5 ? 'To Win' : `${L1 < 0 ? '' : '+'}${L1}`;
    if (L2 != null) {
      if (team === 'home') {
        const hi = Math.floor(L2);
        return `${team1Name} ${L1Label} / ${team2Name} +${L2} (${N1}–${hi} pts)`;
      } else {
        const hi = -lineToN(L2) + 1;
        return `${team1Name} ${L1Label} / ${team2Name} +${L2} (${N1}–${hi} pts)`;
      }
    }
    return `${team1Name} ${L1Label}`;
  }

  // --- INDIVIDUAL LINE LABEL HELPERS ---
  function getLine1Label(matchId) {
    const team = matchLineTeam1[matchId], L1 = matchLineL1[matchId];
    if (!team || L1 == null) return null;
    const ht = teamListCache[matchId]?.home_team || 'Home';
    const at = teamListCache[matchId]?.away_team || 'Away';
    const team1Name = team === 'home' ? ht : at;
    if (L1 === -0.5) return `${team1Name} To Win`;
    const sign = L1 < 0 ? '' : '+';
    return `${team1Name} ${sign}${L1}`;
  }
  function getLine2Label(matchId) {
    const team = matchLineTeam1[matchId], L2 = matchLineL2[matchId];
    if (!team || L2 == null) return null;
    const ht = teamListCache[matchId]?.home_team || 'Home';
    const at = teamListCache[matchId]?.away_team || 'Away';
    const team2Name = team === 'home' ? at : ht;
    return `${team2Name} +${L2}`;
  }
  function getTotal1Label(matchId) {
    const dir = matchTotalDir[matchId], n = matchTotalN[matchId];
    if (!dir || n == null) return null;
    return `${dir === 'over' ? 'Over' : 'Under'} ${n - 0.5}`;
  }
  function getTotalCapLabel(matchId) {
    const dir = matchTotalDir[matchId], cap = matchTotalCapN[matchId];
    if (!dir || cap == null) return null;
    const capDir = dir === 'over' ? 'Under' : 'Over';
    return `${capDir} ${cap - 0.5}`;
  }

  function getTotalLabel(matchId) {
    const dir = matchTotalDir[matchId], n = matchTotalN[matchId], cap = matchTotalCapN[matchId];
    if (!dir || n == null) return '';
    if (cap != null) {
      const lo = dir === 'over' ? n - 0.5 : cap - 0.5;
      const hi = dir === 'over' ? cap - 0.5 : n - 0.5;
      return `Total ${lo}–${hi}`;
    }
    return `${dir === 'over' ? 'Over' : 'Under'} ${n - 0.5}`;
  }
  function getHomeTotalLabel(matchId) {
    const dir = matchHomeTotalDir[matchId], n = matchHomeTotalN[matchId];
    if (!dir || n == null) return '';
    const ht = teamListCache[matchId]?.home_team || 'Home';
    return `${ht} ${dir === 'over' ? 'Over' : 'Under'} ${n - 0.5}`;
  }
  function getAwayTotalLabel(matchId) {
    const dir = matchAwayTotalDir[matchId], n = matchAwayTotalN[matchId];
    if (!dir || n == null) return '';
    const at = teamListCache[matchId]?.away_team || 'Away';
    return `${at} ${dir === 'over' ? 'Over' : 'Under'} ${n - 0.5}`;
  }

  // --- POPULATE VALUE DROPDOWNS ---
  // line1: -36.5 to +36.5 in steps of 1
  function populateLine1ValDropdown() {
    if (!line1ValSel) return;
    line1ValSel.innerHTML = '';
    for (let v = -36.5; v <= 36.5; v += 1) {
      const sign = v >= 0 ? '+' : '';
      const label = v === -0.5 ? 'To Win' : `${sign}${v}`;
      line1ValSel.innerHTML += `<option value="${v}"${v === -0.5 ? ' selected' : ''}>${label}</option>`;
    }
  }
  populateLine1ValDropdown();

  // line2: valid range options given team1 + L1
  function populateLine2ValDropdown(team1, L1) {
    if (!line2ValSel) return;
    line2ValSel.innerHTML = '';
    if (!team1 || L1 == null) return;
    const N1 = lineToN(L1);
    // Valid L2 >= N1 + 0.5 (ensures non-empty range)
    const minL2 = N1 + 0.5;
    const team2Name = team1 === 'home'
      ? (teamListCache[currentMatchId]?.away_team || 'Away')
      : (teamListCache[currentMatchId]?.home_team || 'Home');
    if (line2TeamLabel) {
      line2TeamLabel.textContent = team2Name;
      line2TeamLabel.classList.remove('hidden');
    }
    for (let v = minL2; v <= 36.5; v += 1) {
      line2ValSel.innerHTML += `<option value="${v}">+${v}</option>`;
    }
  }

  function populateValueDropdowns() {
    const placeholder = '<option value="" disabled>—</option>';
    if (totalValSel) {
      totalValSel.innerHTML = placeholder;
      for (let n = 1; n <= 80; n++)
        totalValSel.innerHTML += `<option value="${n}">${n - 0.5}</option>`;
    }
    if (homeTotalValSel) {
      homeTotalValSel.innerHTML = placeholder;
      for (let n = 1; n <= 70; n++)
        homeTotalValSel.innerHTML += `<option value="${n}">${n - 0.5}</option>`;
    }
    if (awayTotalValSel) {
      awayTotalValSel.innerHTML = placeholder;
      for (let n = 1; n <= 70; n++)
        awayTotalValSel.innerHTML += `<option value="${n}">${n - 0.5}</option>`;
    }
  }
  populateValueDropdowns();

  function updateTotalCapDropdown(dir, n) {
    if (!totalCapValSel) return;
    totalCapValSel.innerHTML = '';
    // Second line is opposite direction to first
    const capDir = dir === 'over' ? 'under' : 'over';
    if (totalCapDirLabel) totalCapDirLabel.textContent = capDir === 'under' ? 'Under' : 'Over';
    if (dir === 'over') {
      // First is Over X, second is Under Y where Y > X
      for (let m = n + 1; m <= 81; m++)
        totalCapValSel.innerHTML += `<option value="${m}">${m - 0.5}</option>`;
    } else {
      // First is Under X, second is Over Y where Y < X
      for (let m = 1; m < n; m++)
        totalCapValSel.innerHTML += `<option value="${m}">${m - 0.5}</option>`;
    }
  }

  // Update dir-button visual state (highlight active)
  function setDirBtnActive(btn, active) {
    if (!btn) return;
    if (active) {
      btn.classList.add('bg-blue-600', 'border-blue-500', 'text-white');
      btn.classList.remove('border-gray-600', 'text-gray-400');
    } else {
      btn.classList.remove('bg-blue-600', 'border-blue-500', 'text-white');
      btn.classList.add('border-gray-600', 'text-gray-400');
    }
  }

  // Sync all line UI to current state for a match
  function syncLineUI(matchId) {
    const team1 = matchLineTeam1[matchId], L1 = matchLineL1[matchId], L2 = matchLineL2[matchId];
    const tDir = matchTotalDir[matchId], tN = matchTotalN[matchId], tCap = matchTotalCapN[matchId];
    const htDir = matchHomeTotalDir[matchId], htN = matchHomeTotalN[matchId];
    const atDir = matchAwayTotalDir[matchId], atN = matchAwayTotalN[matchId];

    // Match Outcome / Line 1 — always visible
    const lineActive = !!(team1 && L1 != null);
    if (line1ClearBtn) line1ClearBtn.classList.toggle('hidden', !lineActive);
    if (line1ValSel) {
      line1ValSel.disabled = !team1;
      if (L1 != null) line1ValSel.value = L1;
    }
    setDirBtnActive(line1DirHome, team1 === 'home');
    setDirBtnActive(line1DirAway, team1 === 'away');

    // Line 2
    if (lineActive) {
      populateLine2ValDropdown(team1, L1);
      if (L2 != null) {
        // Second line is set — show the row, hide the add button
        if (addLine2Btn) addLine2Btn.classList.add('hidden');
        if (line2Row) line2Row.classList.remove('hidden');
        if (line2ValSel) line2ValSel.value = L2;
        if (line2ClearBtn) line2ClearBtn.classList.remove('hidden');
      } else {
        // No second line yet — show the "Add second line" button, hide the row
        if (addLine2Btn) addLine2Btn.classList.remove('hidden');
        if (line2Row) line2Row.classList.add('hidden');
        if (line2ClearBtn) line2ClearBtn.classList.add('hidden');
      }
    } else {
      if (addLine2Btn) addLine2Btn.classList.add('hidden');
      if (line2Row) line2Row.classList.add('hidden');
    }

    // Total
    setDirBtnActive(totalDirOver,  tDir === 'over');
    setDirBtnActive(totalDirUnder, tDir === 'under');
    if (totalValSel) {
      totalValSel.disabled = !tDir;
      totalValSel.value = tN != null ? tN : '';
    }
    if (totalClearBtn) totalClearBtn.classList.toggle('hidden', !tDir);
    if (tDir && tN != null) {
      updateTotalCapDropdown(tDir, tN);
      if (tCap != null) {
        if (addTotalCapBtn) addTotalCapBtn.classList.add('hidden');
        if (totalCapRow) totalCapRow.classList.remove('hidden');
        if (totalCapValSel) totalCapValSel.value = tCap;
      } else {
        if (addTotalCapBtn) addTotalCapBtn.classList.remove('hidden');
        if (totalCapRow) totalCapRow.classList.add('hidden');
      }
    } else {
      if (addTotalCapBtn) addTotalCapBtn.classList.add('hidden');
      if (totalCapRow) totalCapRow.classList.add('hidden');
    }

    // Home total
    setDirBtnActive(homeTotalDirOver,  htDir === 'over');
    setDirBtnActive(homeTotalDirUnder, htDir === 'under');
    if (homeTotalValSel) {
      homeTotalValSel.disabled = !htDir;
      homeTotalValSel.value = htN != null ? htN : '';
    }
    if (homeTotalClearBtn) homeTotalClearBtn.classList.toggle('hidden', !htDir);

    // Away total
    setDirBtnActive(awayTotalDirOver,  atDir === 'over');
    setDirBtnActive(awayTotalDirUnder, atDir === 'under');
    if (awayTotalValSel) {
      awayTotalValSel.disabled = !atDir;
      awayTotalValSel.value = atN != null ? atN : '';
    }
    if (awayTotalClearBtn) awayTotalClearBtn.classList.toggle('hidden', !atDir);
  }

  // Update team name labels (To Win buttons + Team Pts section labels)
  function updateTeamLabels(homeTeam = 'Home', awayTeam = 'Away') {
    if (line1DirHome) line1DirHome.textContent = homeTeam;
    if (line1DirAway) line1DirAway.textContent = awayTeam;
    const homeLbl = document.getElementById('home-pts-label');
    const awayLbl = document.getElementById('away-pts-label');
    if (homeLbl) homeLbl.textContent = (homeTeam + ' Pts').toUpperCase();
    if (awayLbl) awayLbl.textContent = (awayTeam + ' Pts').toUpperCase();
  }

  // --- FETCH MATCHES ---
  async function fetchMatchesAndPopulate() {
    matchSelect.innerHTML = `<option value="">Loading...</option>`;
    teamsContainer.innerHTML = '';
    resultDiv.innerHTML = '';
    matchList = []; currentMatchId = null; selectedMatch = null;
    currentBlendedDists = null;
    teamListCache = {}; allPlayerInputs = {}; allTryscorerData = {};
    matchLineTeam1 = {}; matchLineL1 = {}; matchLineL2 = {};
    matchTotalDir  = {}; matchTotalN  = {}; matchTotalCapN  = {};
    matchHomeTotalDir = {}; matchHomeTotalN = {};
    matchAwayTotalDir = {}; matchAwayTotalN = {};
    userPicksCache = {};
    machineScoreDistCache = {};
    roundSigmaScale = { margin: null, total: null };
    betslipExpanded = false;
    setControlsEnabled(false);
    syncLineUI(null);
    updateTeamLabels();

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

    // Background-warm team lists for all matches so loadMatch() renders instantly from cache.
    // For the first (soonest) match, also prefetch tryscorer data — most likely selection.
    sorted.forEach((m, idx) => {
      if (!teamListCache[m.match_id]) {
        fetch(`${API_BASE}/match_team_lists/${m.match_id}/${competition}`)
          .then(r => r.json())
          .then(data => {
            teamListCache[m.match_id] = data;
            if (idx === 0) prefetchTryscorerDataForMatch(m.match_id, data);
          })
          .catch(() => {});
      } else if (idx === 0) {
        // Team list already cached — still prefetch tryscorer if needed
        prefetchTryscorerDataForMatch(m.match_id, teamListCache[m.match_id]);
      }
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
      currentBlendedDists = null;
      teamsContainer.innerHTML = '';
      syncLineUI(null);
      updateTeamLabels();
      setControlsEnabled(false);
      recalculateAllOdds();
      return;
    }
    loadMatch(matchId);
  });

  // Background-warm tryscorer data for a match (pure cache fill, no DOM changes).
  // Called after team list is already loaded so player/teamId info is available.
  function prefetchTryscorerDataForMatch(matchId, teamListData) {
    if (!allTryscorerData[matchId]) {
      allTryscorerData[matchId] = { home: null, away: null, _loadingCount: 0 };
    }
    ['home', 'away'].forEach(side => {
      if (allTryscorerData[matchId][side]) return; // already cached
      const players = teamListData[`${side}_players`];
      const teamId  = players?.[0]?.team_id;
      if (!teamId) return;

      allTryscorerData[matchId]._loadingCount++;
      Promise.all([
        fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}/${competition}`).then(r => r.json()),
        fetch(`${API_BASE}/match_try_distribution/${matchId}/${teamId}`).then(r => r.json()),
        fetch(`${API_BASE}/player_try_stats/${matchId}/${teamId}/${competition}`).then(r => r.json()).catch(() => ({})),
        fetch(`${API_BASE}/opponent_try_concession/${matchId}/${teamId}/${competition}`).then(r => r.json()).catch(() => ({}))
      ]).then(([tryProbs, tryDist, tryStats, oppConcession]) => {
        allTryscorerData[matchId][side] = {
          teamName: teamListData[`${side}_team`], teamId, players, tryProbs, tryDist, tryStats, oppConcession
        };
        allTryscorerData[matchId]._loadingCount--;
      }).catch(() => {
        allTryscorerData[matchId]._loadingCount--;
      });
    });
  }

  function loadMatch(matchId) {
    currentMatchId = matchId;
    currentBlendedDists = null;
    updateBlendInfo(matchId);

    if (teamListCache[matchId]) {
      // Render from cache — no loading spinner
      selectedMatch = teamListCache[matchId];
      renderTeams(selectedMatch, matchId);
      updateTeamLabels(selectedMatch.home_team, selectedMatch.away_team);
      syncLineUI(matchId);
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
        updateTeamLabels(data.home_team, data.away_team);
        syncLineUI(matchId);
        if (resetMatchBtn) resetMatchBtn.disabled = false;
        if (resetAllBtn)   resetAllBtn.disabled   = false;
        updateOptionBadges();
        recalculateAllOdds();
      });
  }

  // --- LINE SELECTOR EVENT HANDLERS ---

  // Set line1 team + value; resets line2
  function setLine1(team, L1) {
    if (!currentMatchId) return;
    matchLineTeam1[currentMatchId] = team;
    matchLineL1[currentMatchId]    = L1;
    matchLineL2[currentMatchId]    = null; // reset second line when first changes
    syncLineUI(currentMatchId);
    recalculateAllOdds();
  }

  // To Win quick-picks: set team, default line to -0.5
  // Line1 team toggle buttons (switch team, keep value; set default -0.5 if no value yet)
  if (line1DirHome) line1DirHome.addEventListener('click', () => {
    if (!currentMatchId) return;
    // Toggle off if already selected
    if (matchLineTeam1[currentMatchId] === 'home') {
      matchLineTeam1[currentMatchId] = null;
      matchLineL1[currentMatchId]    = null;
      matchLineL2[currentMatchId]    = null;
    } else {
      matchLineTeam1[currentMatchId] = 'home';
      if (matchLineL1[currentMatchId] == null) matchLineL1[currentMatchId] = -0.5;
      matchLineL2[currentMatchId] = null;
    }
    syncLineUI(currentMatchId);
    recalculateAllOdds();
  });
  if (line1DirAway) line1DirAway.addEventListener('click', () => {
    if (!currentMatchId) return;
    if (matchLineTeam1[currentMatchId] === 'away') {
      matchLineTeam1[currentMatchId] = null;
      matchLineL1[currentMatchId]    = null;
      matchLineL2[currentMatchId]    = null;
    } else {
      matchLineTeam1[currentMatchId] = 'away';
      if (matchLineL1[currentMatchId] == null) matchLineL1[currentMatchId] = -0.5;
      matchLineL2[currentMatchId] = null;
    }
    syncLineUI(currentMatchId);
    recalculateAllOdds();
  });

  // Line1 value change
  if (line1ValSel) line1ValSel.addEventListener('change', function () {
    if (!currentMatchId) return;
    matchLineL1[currentMatchId] = Number(this.value);
    matchLineL2[currentMatchId] = null; // reset cap when main line changes
    syncLineUI(currentMatchId);
    recalculateAllOdds();
  });

  // Line1 clear (clears entire margin section)
  if (line1ClearBtn) line1ClearBtn.addEventListener('click', () => {
    if (!currentMatchId) return;
    matchLineTeam1[currentMatchId] = null;
    matchLineL1[currentMatchId]    = null;
    matchLineL2[currentMatchId]    = null;
    syncLineUI(currentMatchId);
    recalculateAllOdds();
  });

  // Add second line button — reveal line2 row
  if (addLine2Btn) addLine2Btn.addEventListener('click', () => {
    if (!currentMatchId) return;
    addLine2Btn.classList.add('hidden');
    if (line2Row) line2Row.classList.remove('hidden');
    // Default to first option in dropdown
    if (line2ValSel && line2ValSel.options.length) {
      matchLineL2[currentMatchId] = Number(line2ValSel.value);
      if (line2ClearBtn) line2ClearBtn.classList.remove('hidden');
      recalculateAllOdds();
    }
  });

  // Line2 value change
  if (line2ValSel) line2ValSel.addEventListener('change', function () {
    if (!currentMatchId) return;
    matchLineL2[currentMatchId] = Number(this.value);
    if (line2ClearBtn) line2ClearBtn.classList.remove('hidden');
    recalculateAllOdds();
  });

  // Line2 clear (clears second line only, goes back to "Add second line" button)
  if (line2ClearBtn) line2ClearBtn.addEventListener('click', () => {
    if (!currentMatchId) return;
    matchLineL2[currentMatchId] = null;
    if (line2Row) line2Row.classList.add('hidden');
    if (line2ClearBtn) line2ClearBtn.classList.add('hidden');
    if (addLine2Btn) addLine2Btn.classList.remove('hidden');
    recalculateAllOdds();
  });

  // Total
  function handleTotalDir(dir) {
    if (!currentMatchId) return;
    const prev = matchTotalDir[currentMatchId];
    if (prev === dir) return;
    matchTotalDir[currentMatchId]  = dir;
    matchTotalCapN[currentMatchId] = null;
    syncLineUI(currentMatchId);
    recalculateAllOdds();
  }
  if (totalDirOver)  totalDirOver.addEventListener('click',  () => handleTotalDir('over'));
  if (totalDirUnder) totalDirUnder.addEventListener('click', () => handleTotalDir('under'));

  if (totalValSel) totalValSel.addEventListener('change', function () {
    if (!currentMatchId || !this.value) return;
    matchTotalN[currentMatchId]    = Number(this.value);
    matchTotalCapN[currentMatchId] = null;
    updateTotalCapDropdown(matchTotalDir[currentMatchId], Number(this.value));
    // Show "Add second line" button, hide cap row
    if (addTotalCapBtn) addTotalCapBtn.classList.remove('hidden');
    if (totalCapRow) totalCapRow.classList.add('hidden');
    recalculateAllOdds();
  });

  if (addTotalCapBtn) addTotalCapBtn.addEventListener('click', () => {
    if (!currentMatchId) return;
    addTotalCapBtn.classList.add('hidden');
    if (totalCapRow) totalCapRow.classList.remove('hidden');
    // Default to first option in cap dropdown
    if (totalCapValSel && totalCapValSel.options.length) {
      matchTotalCapN[currentMatchId] = Number(totalCapValSel.value);
      recalculateAllOdds();
    }
  });

  if (totalCapValSel) totalCapValSel.addEventListener('change', function () {
    if (!currentMatchId) return;
    matchTotalCapN[currentMatchId] = Number(this.value);
    recalculateAllOdds();
  });

  if (totalCapClearBtn) totalCapClearBtn.addEventListener('click', () => {
    if (!currentMatchId) return;
    matchTotalCapN[currentMatchId] = null;
    if (totalCapRow) totalCapRow.classList.add('hidden');
    if (addTotalCapBtn) addTotalCapBtn.classList.remove('hidden');
    recalculateAllOdds();
  });

  if (totalClearBtn) totalClearBtn.addEventListener('click', () => {
    if (!currentMatchId) return;
    matchTotalDir[currentMatchId]  = null;
    matchTotalN[currentMatchId]    = null;
    matchTotalCapN[currentMatchId] = null;
    syncLineUI(currentMatchId);
    recalculateAllOdds();
  });

  // Home total
  function handleHomeTotalDir(dir) {
    if (!currentMatchId) return;
    const prev = matchHomeTotalDir[currentMatchId];
    if (prev === dir) return;
    matchHomeTotalDir[currentMatchId] = dir;
    syncLineUI(currentMatchId);
    recalculateAllOdds();
  }
  if (homeTotalDirOver)  homeTotalDirOver.addEventListener('click',  () => handleHomeTotalDir('over'));
  if (homeTotalDirUnder) homeTotalDirUnder.addEventListener('click', () => handleHomeTotalDir('under'));

  if (homeTotalValSel) homeTotalValSel.addEventListener('change', function () {
    if (!currentMatchId || !this.value) return;
    matchHomeTotalN[currentMatchId] = Number(this.value);
    recalculateAllOdds();
  });

  if (homeTotalClearBtn) homeTotalClearBtn.addEventListener('click', () => {
    if (!currentMatchId) return;
    matchHomeTotalDir[currentMatchId] = null;
    matchHomeTotalN[currentMatchId]   = null;
    syncLineUI(currentMatchId);
    recalculateAllOdds();
  });

  // Away total
  function handleAwayTotalDir(dir) {
    if (!currentMatchId) return;
    const prev = matchAwayTotalDir[currentMatchId];
    if (prev === dir) return;
    matchAwayTotalDir[currentMatchId] = dir;
    syncLineUI(currentMatchId);
    recalculateAllOdds();
  }
  if (awayTotalDirOver)  awayTotalDirOver.addEventListener('click',  () => handleAwayTotalDir('over'));
  if (awayTotalDirUnder) awayTotalDirUnder.addEventListener('click', () => handleAwayTotalDir('under'));

  if (awayTotalValSel) awayTotalValSel.addEventListener('change', function () {
    if (!currentMatchId || !this.value) return;
    matchAwayTotalN[currentMatchId] = Number(this.value);
    recalculateAllOdds();
  });

  if (awayTotalClearBtn) awayTotalClearBtn.addEventListener('click', () => {
    if (!currentMatchId) return;
    matchAwayTotalDir[currentMatchId] = null;
    matchAwayTotalN[currentMatchId]   = null;
    syncLineUI(currentMatchId);
    recalculateAllOdds();
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
    matchLineTeam1[matchId] = null;
    matchLineL1[matchId]    = null;
    matchLineL2[matchId]    = null;
    matchTotalDir[matchId]     = null;
    matchTotalN[matchId]       = null;
    matchTotalCapN[matchId]    = null;
    matchHomeTotalDir[matchId] = null;
    matchHomeTotalN[matchId]   = null;
    matchAwayTotalDir[matchId] = null;
    matchAwayTotalN[matchId]   = null;
    if (matchId === currentMatchId) {
      syncLineUI(matchId);
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
      allActiveMatchIds().forEach(mid => resetMatch(mid));
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

    // Probability slots start as shimmer skeletons; removeOverlay() is a no-op kept for compat
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
                <span id="badge-${side}-${p.id}" class="inline-flex gap-0.5 ml-1"></span>
              </div>
              <div id="anytime-${side}-${p.id}" class="w-20 text-right shrink-0"><span class="bsm-skeleton h-3 w-14 ml-auto block"></span></div>
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
          const { tryProbs, tryDist, tryStats, oppConcession } = allTryscorerData[matchId][side];
          populateAnytime(tryProbs, tryDist);
          if (tryStats) applyPlayerBadges(matchId, side, tryStats, oppConcession);
          if (downloadCsvBtn && allTryscorerData[matchId].home && allTryscorerData[matchId].away && currentMatchId === matchId) {
            downloadCsvBtn.disabled = false;
          }
          removeOverlay();
        } else {
          allTryscorerData[matchId]._loadingCount = (allTryscorerData[matchId]._loadingCount || 0) + 1;
          Promise.all([
            fetch(`${API_BASE}/player_try_probabilities/${matchId}/${teamId}/${competition}`).then(r => r.json()),
            fetch(`${API_BASE}/match_try_distribution/${matchId}/${teamId}`).then(r => r.json()),
            fetch(`${API_BASE}/player_try_stats/${matchId}/${teamId}/${competition}`).then(r => r.json()).catch(() => ({})),
            fetch(`${API_BASE}/opponent_try_concession/${matchId}/${teamId}/${competition}`).then(r => r.json()).catch(() => ({}))
          ]).then(([tryProbs, tryDist, tryStats, oppConcession]) => {
            allTryscorerData[matchId][side] = { teamName, teamId, players, tryProbs, tryDist, tryStats, oppConcession };
            allTryscorerData[matchId]._loadingCount--;
            if (downloadCsvBtn && allTryscorerData[matchId].home && allTryscorerData[matchId].away && currentMatchId === matchId) {
              downloadCsvBtn.disabled = false;
            }
            populateAnytime(tryProbs, tryDist);
            applyPlayerBadges(matchId, side, tryStats, oppConcession);
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

  // --- PLAYER STAT BADGES ---
  const BADGE_THRESHOLD   = 1.05;  // star: player vs league average
  const HOT_THRESHOLD     = 1.20;  // flame: recent vs own career (20% above)
  const COLD_THRESHOLD    = 0.80;  // snowflake: recent vs own career (20% below)

  function computePlayerBadges(pid, tryStats) {
    const s = tryStats?.[pid] ?? tryStats?.[String(pid)];
    if (!s) return { star: null, flame: null, cold: null };

    // Star: career rate vs position league average (career window only)
    let starBest = null;
    if (s.career_rate != null && s.pos_career_avg) {
      const ratio = s.career_rate / s.pos_career_avg;
      if (ratio > BADGE_THRESHOLD) starBest = { ratio, window: 'career' };
    }

    // Flame (hot) / Snowflake (cold): season or last-10 vs own career rate
    let flameBest = null;
    let coldWorst = null;
    if (s.career_rate != null) {
      const candidates = [
        s.season_rate  != null ? { ratio: s.season_rate  / s.career_rate, window: 'this season'   } : null,
        s.last10_rate  != null ? { ratio: s.last10_rate  / s.career_rate, window: 'last 10 games' } : null,
      ].filter(Boolean);
      for (const c of candidates) {
        if (c.ratio > HOT_THRESHOLD  && (!flameBest || c.ratio > flameBest.ratio)) flameBest = c;
        if (c.ratio < COLD_THRESHOLD && (!coldWorst || c.ratio < coldWorst.ratio)) coldWorst = c;
      }
    }

    return { star: starBest, flame: flameBest, cold: coldWorst };
  }

  function applyPlayerBadges(matchId, side, tryStats, oppConcession) {
    if (!tryStats || matchId !== currentMatchId) return;
    const data = teamListCache[matchId];
    if (!data) return;
    (data[`${side}_players`] || []).forEach(p => {
      const el = document.getElementById(`badge-${side}-${p.id}`);
      if (!el) return;
      const { star, flame, cold } = computePlayerBadges(p.id, tryStats);

      // Sword: opponent concedes significantly more tries to this position
      // Pick the better ratio across last-10 and season windows
      let swordData = null;
      const posWindows = oppConcession?.[p.position];
      if (posWindows) {
        const candidates = [
          posWindows.last10 ? { ...posWindows.last10, window: 'last 10 games' } : null,
          posWindows.season ? { ...posWindows.season, window: 'this season'   } : null,
        ].filter(d => d && d.ratio > BADGE_THRESHOLD && d.games >= 3);
        if (candidates.length) {
          swordData = candidates.reduce((best, c) => c.ratio > best.ratio ? c : best);
        }
      }

      // Anchor tooltips to prevent overflow: away panel gets right-anchored on all sizes
      const tooltipClass = side === 'away' ? ' tooltip-right' : ' tooltip-left';
      let html = '';
      if (star) {
        const pct = Math.round((star.ratio - 1) * 100);
        html += `<span class="player-badge star-badge${tooltipClass}" data-tooltip="${pct}% above avg ${p.position} scorer (${star.window})">★</span>`;
      }
      if (flame) {
        const pct = Math.round((flame.ratio - 1) * 100);
        html += `<span class="player-badge flame-badge${tooltipClass}" data-tooltip="${pct}% above own career avg as ${p.position} (${flame.window})">🔥</span>`;
      }
      if (cold) {
        const pct = Math.round((1 - cold.ratio) * 100);
        html += `<span class="player-badge cold-badge${tooltipClass}" data-tooltip="${pct}% below own career avg as ${p.position} (${cold.window})">❄️</span>`;
      }
      if (swordData) {
        const pct = Math.round((swordData.ratio - 1) * 100);
        html += `<span class="player-badge sword-badge${tooltipClass}" data-tooltip="Opp concedes ${pct}% more tries to ${p.position} (${swordData.window})">⚔️</span>`;
      }
      el.innerHTML = html;
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

      const σM  = _machineSigmaFromBins(dist.margins, -100, 100);
      const σT  = _machineSigmaFromBins(dist.totals,    0, 100);
      const σUm = _stddev(margins);
      const σUt = _stddev(totals);

      if (σM && σUm > 0) { machMargSigmas.push(σM); userMargSigmas.push(σUm); }
      if (σT && σUt > 0) { machTotSigmas.push(σT);  userTotSigmas.push(σUt); }
    });

    const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
    roundSigmaScale = {
      margin: machMargSigmas.length >= 1 ? avg(machMargSigmas) / avg(userMargSigmas) : null,
      total:  machTotSigmas.length  >= 1 ? avg(machTotSigmas)  / avg(userTotSigmas)  : null,
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

  // P(crowd satisfies all line constraints) using Gaussian KDE — matches predictions.js crowd model.
  // c: constraints object from buildConstraints(); marginSigma/totalSigma for calibrated bandwidth.
  // Computes crowd P(margin constraints AND total constraints) from marginal KDEs.
  // Does NOT handle homeTotal/awayTotal — those require the joint bins (see blendedLineProb).
  function computeUserLineProb(picks, c, marginSigma, totalSigma) {
    const { margins, totals } = picks;
    if (!margins.length) return null;
    let prob = 1;

    // Effective margin bounds (combine margin1 + margin2 for range)
    let mGte = null, mLte = null;
    if (c?.margin1?.type === 'over')  mGte = c.margin1.val;
    if (c?.margin1?.type === 'under') mLte = c.margin1.val - 1;
    if (c?.margin2?.type === 'over')  mGte = mGte !== null ? Math.max(mGte, c.margin2.val) : c.margin2.val;
    if (c?.margin2?.type === 'under') mLte = mLte !== null ? Math.min(mLte, c.margin2.val - 1) : c.margin2.val - 1;

    if (mGte !== null && mLte !== null) {
      const pA = _kdeLineProbGte(margins, -100, 100, mGte, marginSigma);
      const pB = _kdeLineProbGte(margins, -100, 100, mLte + 1, marginSigma);
      if (pA === null) return null;
      prob *= Math.max(0, pA - (pB || 0));
    } else if (mGte !== null) {
      const p = _kdeLineProbGte(margins, -100, 100, mGte, marginSigma);
      if (p === null) return null;
      prob *= p;
    } else if (mLte !== null) {
      const p = _kdeLineProbGte(margins, -100, 100, mLte + 1, marginSigma);
      if (p === null) return null;
      prob *= (1 - p);
    }

    // Effective total bounds (combine total1 + total2 for range)
    let tGte = null, tLte = null;
    if (c?.total1?.type === 'over')  tGte = c.total1.val;
    if (c?.total1?.type === 'under') tLte = c.total1.val - 1;
    if (c?.total2?.type === 'over')  tGte = tGte !== null ? Math.max(tGte, c.total2.val) : c.total2.val;
    if (c?.total2?.type === 'under') tLte = tLte !== null ? Math.min(tLte, c.total2.val - 1) : c.total2.val - 1;

    if (tGte !== null && tLte !== null) {
      const pA = _kdeLineProbGte(totals, 0, 120, tGte, totalSigma);
      const pB = _kdeLineProbGte(totals, 0, 120, tLte + 1, totalSigma);
      if (pA === null) return null;
      prob *= Math.max(0, pA - (pB || 0));
    } else if (tGte !== null) {
      const p = _kdeLineProbGte(totals, 0, 120, tGte, totalSigma);
      if (p === null) return null;
      prob *= p;
    } else if (tLte !== null) {
      const p = _kdeLineProbGte(totals, 0, 120, tLte + 1, totalSigma);
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

    const c = buildConstraints(matchId);

    try {
      const [userPicks, machineScoreDist, sgmDist] = await Promise.all([
        fetchUserPicksForMatch(matchId),
        fetchMachineScoreDist(matchId),
        getSgmDist(matchId, c),
      ]);
      if (currentMatchId !== matchId) return; // stale — match changed while fetching
      const userPickCount = userPicks.margins.length;
      const marginSigma = (userPickCount >= 2 && roundSigmaScale.margin)
        ? _stddev(userPicks.margins) * roundSigmaScale.margin
        : (machineScoreDist ? _machineSigmaFromBins(machineScoreDist.margins, -100, 100) : null);
      const totalSigma = (userPickCount >= 2 && roundSigmaScale.total)
        ? _stddev(userPicks.totals) * roundSigmaScale.total
        : (machineScoreDist ? _machineSigmaFromBins(machineScoreDist.totals, 0, 100) : null);
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
    currentBlendedDists = blendedDists;
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

  function buildConstraints(matchId) {
    const team1 = matchLineTeam1[matchId], L1 = matchLineL1[matchId], L2 = matchLineL2[matchId];
    const tDir = matchTotalDir[matchId],  tN = matchTotalN[matchId],  tCap = matchTotalCapN[matchId];
    const htDir = matchHomeTotalDir[matchId], htN = matchHomeTotalN[matchId];
    const atDir = matchAwayTotalDir[matchId], atN = matchAwayTotalN[matchId];
    let margin1 = null, margin2 = null, total1 = null, total2 = null, homeTotal = null, awayTotal = null;

    if (team1 && L1 != null) {
      const N1 = lineToN(L1); // margin >= N1 for home, <= -N1 for away
      if (team1 === 'home') {
        margin1 = { type: 'over',  val: N1 };
        // Line2 is on Away team: Away +L2 → margin <= floor(L2)
        if (L2 != null) margin2 = { type: 'under', val: Math.floor(L2) + 1 };
      } else {
        margin1 = { type: 'under', val: 1 - N1 }; // margin <= -N1
        // Line2 is on Home team: Home +L2 → margin >= lineToN(L2)
        if (L2 != null) margin2 = { type: 'over', val: lineToN(L2) };
      }
    }
    if (tDir && tN != null) {
      if (tDir === 'over') {
        total1 = { type: 'over',  val: tN };
        if (tCap != null) total2 = { type: 'under', val: tCap };
      } else {
        total1 = { type: 'under', val: tN };
        if (tCap != null) total2 = { type: 'over',  val: tCap };
      }
    }
    if (htDir && htN != null) homeTotal = { type: htDir, val: htN };
    if (atDir && atN != null) awayTotal = { type: atDir, val: atN };
    return { margin1, margin2, total1, total2, homeTotal, awayTotal };
  }

  async function getSgmDist(matchId, c) {
    const params = [];
    if (c?.margin1?.type === 'over')  params.push(`margin_gte=${c.margin1.val}`);
    if (c?.margin1?.type === 'under') params.push(`margin_lte=${c.margin1.val - 1}`);
    if (c?.margin2?.type === 'over')  params.push(`margin_gte=${c.margin2.val}`);
    if (c?.margin2?.type === 'under') params.push(`margin_lte=${c.margin2.val - 1}`);
    if (c?.total1?.type === 'over')   params.push(`total_gte=${c.total1.val}`);
    if (c?.total1?.type === 'under')  params.push(`total_lte=${c.total1.val - 1}`);
    if (c?.total2?.type === 'over')   params.push(`total_gte=${c.total2.val}`);
    if (c?.total2?.type === 'under')  params.push(`total_lte=${c.total2.val - 1}`);
    const paramString = params.length ? `?${params.join('&')}` : '';
    const result = await fetch(`${API_BASE}/match_sgm_bins_range/${matchId}${paramString}`).then(r => r.json());
    // Apply team total filtering client-side using the raw bins.
    // preFiltBins = bins matching margin/total only (before team total filter) — used by blendedLineProb
    // for crowd team score probability via crowd-weighted joint distribution.
    if ((c?.homeTotal || c?.awayTotal) && Array.isArray(result.bins) && result.bins.length) {
      const preFiltBins = result.bins;
      const bins = result.bins.filter(b => {
        const hs = (b.m + b.t) / 2;
        const as_ = (b.t - b.m) / 2;
        if (c.homeTotal?.type === 'over'  && hs <  c.homeTotal.val) return false;
        if (c.homeTotal?.type === 'under' && hs >= c.homeTotal.val) return false;
        if (c.awayTotal?.type === 'over'  && as_ <  c.awayTotal.val) return false;
        if (c.awayTotal?.type === 'under' && as_ >= c.awayTotal.val) return false;
        return true;
      });
      const totalC = result.bins.reduce((s, b) => s + (b.c || 0), 0);
      const filtC  = bins.reduce((s, b) => s + (b.c || 0), 0);
      // Always return a result with team-total filter applied.
      // filtC == 0 means the combination is impossible — return prob 0, not the unfiltered result.
      if (totalC > 0) {
        if (filtC === 0) {
          return { ...result, preFiltBins, bins: [], prob: 0, home_try_dist: {}, away_try_dist: {} };
        }
        const scale = filtC / totalC;
        const aggHome = {}, aggAway = {};
        bins.forEach(b => {
          const w = (b.c || 0) / filtC;
          for (const [k, v] of Object.entries(b.h || {})) aggHome[k] = (aggHome[k] || 0) + v * w;
          for (const [k, v] of Object.entries(b.a || {})) aggAway[k] = (aggAway[k] || 0) + v * w;
        });
        return { ...result, preFiltBins, bins, prob: (result.prob || 0) * scale, home_try_dist: aggHome, away_try_dist: aggAway };
      }
    }
    return { ...result, preFiltBins: result.bins };
  }

  // Calculate SGM for one match — returns Promise<result|null>
  async function calculateMatchSGM(matchId) {
    const data = teamListCache[matchId];
    if (!data) return null;

    const inputs = allPlayerInputs[matchId] || { home: {}, away: {} };

    const c = buildConstraints(matchId);
    const matchLabel       = `${data.home_team} vs ${data.away_team}`;
    const hasMarginOrTotal = matchHasLine(matchId);
    const lineItems = [
      getLine1Label(matchId),
      getLine2Label(matchId),
      getTotal1Label(matchId),
      getTotalCapLabel(matchId),
      getHomeTotalLabel(matchId),
      getAwayTotalLabel(matchId),
    ].filter(Boolean);
    const lineLegs =
      (matchLineTeam1[matchId] && matchLineL1[matchId] != null ? 1 : 0) +
      (matchLineL2[matchId] != null ? 1 : 0) +
      (matchTotalDir[matchId]  && matchTotalN[matchId]  != null ? 1 : 0) +
      (matchTotalCapN[matchId]  != null ? 1 : 0) +
      (matchHomeTotalDir[matchId] && matchHomeTotalN[matchId] != null ? 1 : 0) +
      (matchAwayTotalDir[matchId] && matchAwayTotalN[matchId] != null ? 1 : 0);

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
      : (machineScoreDist ? _machineSigmaFromBins(machineScoreDist.margins, -100, 100) : null);
    const totalSigma  = (userPickCount >= 2 && roundSigmaScale.total)
      ? _stddev(userPicks.totals) * roundSigmaScale.total
      : (machineScoreDist ? _machineSigmaFromBins(machineScoreDist.totals, 0, 100)  : null);

    // Crowd team score distributions derived from paired picks.
    // margins[i] and totals[i] come from the same tipper, so home/away scores are exact.
    const _paired = userPicks.totals.length === userPicks.margins.length && userPickCount > 0;
    const _homeScores = _paired ? userPicks.margins.map((m, i) => (userPicks.totals[i] + m) / 2) : [];
    const _awayScores = _paired ? userPicks.margins.map((m, i) => (userPicks.totals[i] - m) / 2) : [];
    // Machine sigma for team scores (used as modelSigma target by _kdeLineProbGte,
    // which internally computes bandwidth as sqrt(max(0, modelSigma² - crowd_std²))).
    // Approximation: Var(home) = (Var(margin) + Var(total)) / 4 (ignoring covariance).
    const _machineTeamSigma = (marginSigma != null && totalSigma != null)
      ? Math.sqrt((marginSigma ** 2 + totalSigma ** 2) / 4)
      : null;

    // Blend machine line probability with crowd probability.
    function blendedLineProb(machineProb) {
      if (blendT === 0 || !hasMarginOrTotal || !userPickCount) return machineProb;

      const hasTeamTotal = !!(c.homeTotal || c.awayTotal);

      if (hasTeamTotal) {
        if (!_paired) return machineProb; // can't derive team scores — fall back to machine

        // Compute all crowd constraints jointly from the 2D (home, away) score distribution.
        // This avoids the self-inconsistency of multiplying independent 1D KDE probabilities:
        // e.g. Dragons Under 0.5 + Roosters Under 19.5 already implies Total Under 19.5,
        // so adding that constraint must not further reduce the probability.
        // The 2D joint approach evaluates every constraint at the same (h, a) point, so
        // redundant constraints are automatically handled.
        const hBw = _calibratedBw(_homeScores, _machineTeamSigma);
        const aBw = _calibratedBw(_awayScores, _machineTeamSigma);
        const crowdProb = _joint2dCrowdProb(_homeScores, _awayScores, c, hBw, aBw);
        if (crowdProb === null) return machineProb;
        return (1 - blendT) * machineProb + blendT * crowdProb;
      }

      // No team total constraints — use marginal KDE for margin/total only
      const crowdProb = computeUserLineProb(userPicks, c, marginSigma, totalSigma);
      if (crowdProb === null) return machineProb;
      return (1 - blendT) * machineProb + blendT * crowdProb;
    }

    // Line-only (no tryscorer picks)
    if (!hasAnyPicks) {
      try {
        const sgmDist    = await getSgmDist(matchId, c);
        const machProb   = typeof sgmDist.prob === 'number' ? sgmDist.prob : 0;
        // Update anytime column with blended distributions for this margin/total filter
        if (matchId === currentMatchId) {
          updateAnytimeDisplay(matchId, _blendedTryDists(sgmDist, userPicks, marginSigma, totalSigma, blendT));
        }
        return { matchId, matchLabel, picks: [], prob: blendedLineProb(machProb), lineOnly: true, lineItems, userPickCount, lineLegs };
      } catch { return null; }
    }

    // Tryscorer picks (± margin/total)
    // Fetch SGM dist once; both sides share it
    let sgmDist;
    try { sgmDist = await getSgmDist(matchId, c); }
    catch { return null; }

    const machLineProb     = typeof sgmDist.prob === 'number' ? sgmDist.prob : 1;
    const effectiveLineProb = hasMarginOrTotal ? blendedLineProb(machLineProb, sgmDist) : 1;

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
    return { matchId, matchLabel, picks: allPicks, prob: combined, lineOnly: false, lineItems, hasMarginOrTotal, lineProb, userPickCount, lineLegs };
  }

  // --- RECALCULATE ALL & RENDER BETSLIP ---
  let _recalcTimer = null;

  function recalculateAllOdds() {
    updateResetAllState();

    // Gather active match IDs immediately to decide whether to show loading
    const allIds = allActiveMatchIds();
    const activeIds = [...allIds].filter(mid => {
      const inputs = allPlayerInputs[mid] || {};
      const hasPicks = Object.values(inputs.home || {}).some(v => v > 0) ||
                       Object.values(inputs.away || {}).some(v => v > 0);
      return hasPicks || matchHasLine(mid);
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

  // --- INSURANCE ODDS HELPERS ---
  // Elementary symmetric polynomials e[0..n] for array x, via DP.
  // e[k] = sum of all k-element products of x.
  function _elemSymPoly(x) {
    const e = new Array(x.length + 1).fill(0);
    e[0] = 1;
    for (let i = 0; i < x.length; i++) {
      for (let k = Math.min(i + 1, x.length); k >= 1; k--) {
        e[k] += e[k - 1] * x[i];
      }
    }
    return e;
  }
  // Approximate P(exactly k legs fail, rest win) using independence.
  // Under independence: P(exactly k legs fail) = allCombinedProb * e_k(failOdds)
  // where failOdds_i = (1-p_i)/p_i.
  // P(at least X legs succeed) = allCombinedProb * sum_{k=0}^{N-X} esp[k]
  // Returns [{X, N, prob, odds}] for X = 2 .. N-1.
  function _computeInsurance(results, allCombinedProb) {
    const clamp = p => Math.min(Math.max(p, 1e-4), 1 - 1e-4);
    const legProbs = [];
    for (const r of results) {
      if (r.lineOnly) {
        // Split the joint line probability across individual constraints (geometric mean approx)
        const n = r.lineLegs || 1;
        if (r.prob > 0) {
          const indivProb = Math.pow(r.prob, 1 / n);
          for (let i = 0; i < n; i++) legProbs.push(clamp(indivProb));
        }
        continue;
      }
      for (const p of (r.picks || [])) {
        if (p.indivProb != null && p.indivProb > 0) legProbs.push(clamp(p.indivProb));
      }
      // Split the joint line probability across individual constraints (geometric mean approx)
      if (r.lineProb > 0) {
        const n = r.lineLegs || 1;
        const indivLineProb = Math.pow(r.lineProb, 1 / n);
        for (let i = 0; i < n; i++) legProbs.push(clamp(indivLineProb));
      }
    }
    const N = legProbs.length;
    if (N < 2 || allCombinedProb <= 0) return [];
    const failOdds = legProbs.map(p => (1 - p) / p);
    const esp = _elemSymPoly(failOdds);
    // Build cumulative prefix sums of esp to efficiently compute P(at least X succeed)
    const prefixEsp = [0];
    for (let k = 0; k <= N; k++) prefixEsp[k + 1] = prefixEsp[k] + (esp[k] || 0);
    const combinations = [];
    for (let X = 2; X <= N - 1; X++) {
      const cumSum = prefixEsp[N - X + 1]; // sum of esp[0..N-X]
      const prob = Math.min(Math.max(allCombinedProb * cumSum, 0), 1);
      const odds = prob > 0 ? (1 / prob).toFixed(2) : '∞';
      combinations.push({ X, N, prob, odds });
    }
    return combinations;
  }

  // --- RENDER BETSLIP ---
  function renderBetslip(results) {
    if (results.length === 0) {
      resultDiv.innerHTML = '';
      resultDiv.classList.remove('betslip-open');
      betslipExpanded = false;
      return;
    }

    // Combined odds across all tryscorer picks (excludes line-only)
    const pickResults = results.filter(r => !r.lineOnly && r.picks && r.picks.length > 0);
    const combinedProb = pickResults.reduce((acc, r) => acc * r.prob, 1);
    const combinedOdds = combinedProb > 0 ? (1 / combinedProb).toFixed(2) : '∞';
    const combinedPct  = (combinedProb * 100).toFixed(2);
    const totalLegs    = results.reduce((acc, r) => acc + (r.picks?.length || 0) + (r.lineLegs || 0), 0);
    const isMulti      = pickResults.length > 1 || totalLegs > (pickResults[0]?.picks?.length ?? 0);

    // Per-game leg rows
    const legsHtml = results.map(r => {
      const gameOdds = r.prob > 0 ? `$${(1 / r.prob).toFixed(2)}` : '–';
      const gamePct  = r.prob > 0 ? `${(r.prob * 100).toFixed(1)}%` : '–';

      if (r.lineOnly) {
        const items = r.lineItems || [];
        const itemsHtml = items.map((label, i) => {
          const isLast = i === items.length - 1;
          return `
            <div class="flex items-center justify-between gap-2 py-0.5">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0 mt-0.5"></span>
                <span class="text-sm text-gray-300 italic">${label}</span>
              </div>
              ${isLast ? `<span class="text-sm font-bold text-amber-400 shrink-0">${gameOdds} <span class="text-xs font-normal text-gray-500">${gamePct}</span></span>` : ''}
            </div>`;
        }).join('');
        return `
          <div class="py-2.5 border-b border-gray-700/40 last:border-b-0">
            <div class="text-xs font-semibold text-gray-400 truncate mb-1">${r.matchLabel}</div>
            ${itemsHtml}
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

      // Line items rendered first (one row per selection), above tryscorer picks
      // Combined line odds shown on last line item row
      const linePct  = r.lineProb ? `${(r.lineProb * 100).toFixed(1)}%` : null;
      const lineOdds = r.lineProb ? `$${(1 / r.lineProb).toFixed(2)}` : null;
      const lineItemsArr = r.lineItems || [];
      const lineItemsHtml = lineItemsArr.map((label, i) => {
        const isLast = i === lineItemsArr.length - 1;
        return `
          <div class="flex items-center justify-between gap-2 py-0.5">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0 mt-0.5"></span>
              <span class="text-sm text-gray-300 italic">${label}</span>
            </div>
            ${isLast && linePct ? `<div class="text-right shrink-0">
              <div class="text-sm font-semibold text-gray-300">${linePct}</div>
              <div class="text-xs text-gray-500">${lineOdds}</div>
            </div>` : ''}
          </div>`;
      }).join('');

      return `
        <div class="py-2.5 border-b border-gray-700/40 last:border-b-0">
          <div class="text-xs font-semibold text-gray-400 truncate mb-1.5">${r.matchLabel}</div>
          ${lineItemsHtml}
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

    const allCombinedProb = results.reduce((acc, r) => acc * r.prob, 1);
    const insurance = totalLegs >= 2 ? _computeInsurance(results, allCombinedProb) : [];
    const insuranceHtml = insurance.length > 0 ? `
      <div class="mt-3 pt-3 border-t border-gray-700/40">
        <div class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Combinations</div>
        <div class="flex flex-col gap-1">
          ${insurance.map(ins => `
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-gray-400">${ins.X}+ legs win</span>
              <div class="text-right">
                <div class="text-sm font-semibold text-gray-300">${(ins.prob * 100).toFixed(1)}%</div>
                <div class="text-xs text-gray-500">$${ins.odds}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>` : '';

    const bmcHtml = `
      <div class="text-xs mt-3 text-gray-400 text-center leading-tight">
        Find this useful? <a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" class="text-yellow-300 hover:underline">Buy me a coffee</a> to help pay server costs.
      </div>`;

    const bookieOddsHtml = hasPicks ? `
      <div class="mt-3 pt-3 border-t border-gray-700/40">
        <div class="flex items-center gap-2">
          <label for="bookie-odds-input" class="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0">Bookie Odds</label>
          <div class="flex items-center gap-1 flex-1">
            <span class="text-sm text-gray-400">$</span>
            <input id="bookie-odds-input" type="number" min="1.01" step="0.05"
                   placeholder="e.g. 4.50" value="${_bookieOdds != null ? _bookieOdds : ''}"
                   class="flex-1 min-w-0 bg-gray-800 border border-gray-600 text-white text-sm rounded px-2 py-1 focus:outline-none focus:border-amber-500/60">
          </div>
        </div>
        <p class="text-xs text-gray-600 mt-1">Optional · shown on your share card</p>
      </div>` : '';

    const shareHtml = hasPicks ? `
      <div class="mt-2 flex justify-center">
        <button id="share-card-btn" type="button"
                class="px-4 py-1.5 rounded-lg border border-amber-500/40 text-amber-400 font-semibold text-sm hover:bg-amber-500/10 transition-colors">
          ↗ Share Card
        </button>
      </div>` : '';

    // Mobile collapsed summary
    const summaryOdds = hasPicks ? `$${combinedOdds}` : results[0]?.prob > 0 ? `$${(1 / results[0].prob).toFixed(2)}` : '–';
    const summaryLegs = totalLegs > 0 ? `${totalLegs} leg${totalLegs !== 1 ? 's' : ''} · ` : '';
    const summaryText = `${summaryLegs}${summaryOdds}`;

    const maxPickCount = results.reduce((mx, r) => Math.max(mx, r.userPickCount || 0), 0);
    const blendBadge = blendT > 0 && maxPickCount > 0
      ? `<span class="text-xs text-blue-400 font-medium">⚡ ${Math.round(blendT * 100)}% crowd · ${maxPickCount} pick${maxPickCount !== 1 ? 's' : ''}</span>`
      : '';

    resultDiv.innerHTML = `
      <div id="betslip-toggle" class="flex items-center justify-between cursor-pointer select-none">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Betslip</span>
          ${blendBadge}
        </div>
        <div class="flex items-center gap-2">
          <span class="text-base font-bold text-amber-400">${summaryText}</span>
          <span id="betslip-chevron" class="text-gray-400 text-xs">▲</span>
        </div>
      </div>
      <div id="betslip-body" class="hidden mt-1">
        ${legsHtml}
        ${finalOddsHtml}
        ${insuranceHtml}
        ${bookieOddsHtml}
        ${bmcHtml}
        ${shareHtml}
      </div>
    `;

    // Restore expanded state after re-render
    if (betslipExpanded) {
      resultDiv.classList.add('betslip-open');
      const body    = resultDiv.querySelector('#betslip-body');
      const chevron = resultDiv.querySelector('#betslip-chevron');
      if (body)    body.classList.remove('hidden');
      if (chevron) chevron.textContent = '▼';
    }

    resultDiv.querySelector('#betslip-toggle').addEventListener('click', () => {
      betslipExpanded = !betslipExpanded;
      resultDiv.classList.toggle('betslip-open', betslipExpanded);
      const body    = resultDiv.querySelector('#betslip-body');
      const chevron = resultDiv.querySelector('#betslip-chevron');
      if (body)    body.classList.toggle('hidden', !betslipExpanded);
      if (chevron) chevron.textContent = betslipExpanded ? '▼' : '▲';
    });

    const bookieInput = resultDiv.querySelector('#bookie-odds-input');
    if (bookieInput) {
      bookieInput.addEventListener('input', () => {
        _bookieOdds = bookieInput.value ? parseFloat(bookieInput.value) : null;
      });
    }

    const shareBtn = resultDiv.querySelector('#share-card-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', () => generateAndShowShareCard(results, combinedPct, combinedOdds, _bookieOdds, Math.round(blendT * 100)));
    }
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
      const blendedTryDist = currentBlendedDists?.[side + '_try_dist'];
      const effectiveTryDist = blendedTryDist || tryDist;
      players.forEach(player => {
        const perTryProb = tryProbs[player.id] ?? tryProbs[String(player.id)];
        const anytimeProb = perTryProb !== undefined && effectiveTryDist
          ? anytimeTryscorerProbability(perTryProb, effectiveTryDist, 20) : null;
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

  // --- SHARE CARD ---
  function _drawRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y,     x + w, y + r,     r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x,     y + h, x,     y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x,     y,     x + r, y,         r);
    ctx.closePath();
  }

  function _drawDot(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function _loadAndDrawImage(ctx, src, x, y, w, h) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, x, y, w, h); resolve(); };
      img.onerror = () => resolve();
      img.src = src;
    });
  }

  async function generateShareCard(results, combinedPct, combinedOdds, bookieOdds, blendPct) {
    const W            = 600;
    const HEADER_H     = 60;
    const MATCH_H      = 72;
    const PICK_H       = 40;
    const LINE_H       = 36;
    const COMBINED_H   = bookieOdds != null ? 104 : 68;
    const FOOTER_H     = 34;
    const PAD          = 24;

    const pickResults = results.filter(r => !r.lineOnly && r.picks && r.picks.length > 0);
    const hasPicks    = pickResults.length > 0;

    let picksH = 0;
    results.forEach(r => {
      const nLineItems = r.lineItems?.length || 0;
      if (r.lineOnly) { picksH += nLineItems * LINE_H; }
      else {
        picksH += nLineItems * LINE_H;  // line items rendered first
        picksH += r.picks.length * PICK_H;
      }
    });
    const H = HEADER_H + MATCH_H + 1 + picksH + (hasPicks ? 1 + COMBINED_H : 0) + FOOTER_H;

    const DPR = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width  = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width  = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    const BG      = '#0f1117';
    const BG2     = '#161b27';
    const BG3     = '#1a1f2e';
    const AMBER   = '#fbbf24';
    const GREEN   = '#4ade80';
    const BLUE    = '#60a5fa';
    const WHITE   = '#f9fafb';
    const GRAY300 = '#d1d5db';
    const GRAY400 = '#9ca3af';
    const GRAY500 = '#6b7280';
    const DIVIDER = '#2d3748';

    // Background
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // Header bar
    ctx.fillStyle = BG3;
    ctx.fillRect(0, 0, W, HEADER_H);

    ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px "Barlow Condensed", sans-serif';
    ctx.fillStyle = AMBER;
    ctx.textAlign = 'left';
    ctx.fillText('THE BS MACHINE', PAD, HEADER_H / 2);

    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = GRAY500;
    ctx.textAlign = 'right';
    ctx.fillText('SGM BUILDER', W - PAD, HEADER_H / 2 - 7);
    ctx.font = '10px sans-serif';
    ctx.fillText('bsmachine.dev', W - PAD, HEADER_H / 2 + 7);

    ctx.fillStyle = DIVIDER;
    ctx.fillRect(0, HEADER_H, W, 1);

    let y = HEADER_H;

    // Match row
    ctx.fillStyle = BG2;
    ctx.fillRect(0, y, W, MATCH_H);

    const matchLabel = results[0]?.matchLabel || '';
    const parts      = matchLabel.split(' vs ');
    const homeTeam   = parts[0]?.trim() || '';
    const awayTeam   = parts[1]?.trim() || '';

    const logoSize  = 40;
    const logoY     = y + (MATCH_H - logoSize) / 2;
    const homeLogoX = PAD;
    const awayLogoX = W - PAD - logoSize;
    const midY      = y + MATCH_H / 2;

    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = WHITE;
    ctx.textAlign = 'left';
    ctx.fillText(homeTeam, homeLogoX + logoSize + 10, midY - 9);

    ctx.textAlign = 'right';
    ctx.fillText(awayTeam, awayLogoX - 10, midY - 9);

    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = GRAY500;
    ctx.textAlign = 'center';
    ctx.fillText('vs', W / 2, midY - 9);

    const dateStr   = selectedMatch ? formatDateString(selectedMatch.date) : '';
    const roundStr  = selectedMatch?.round_number ? `Rd ${selectedMatch.round_number}` : '';
    const dateLabel = [roundStr, dateStr].filter(Boolean).join(' · ');
    ctx.font = '11px sans-serif';
    ctx.fillStyle = GRAY500;
    ctx.textAlign = 'center';
    ctx.fillText(dateLabel, W / 2, midY + 9);

    y += MATCH_H;
    ctx.fillStyle = DIVIDER;
    ctx.fillRect(0, y, W, 1);
    y += 1;

    // Picks — line items always rendered first (above tryscorer picks)
    results.forEach(r => {
      const items = r.lineItems || [];
      if (r.lineOnly) {
        // Line-only result: each item is its own row; show combined odds on last item
        items.forEach((label, i) => {
          const isLast = i === items.length - 1;
          _drawDot(ctx, PAD + 4, y + LINE_H / 2, 4, BLUE);
          ctx.font = 'italic 13px sans-serif';
          ctx.fillStyle = GRAY400;
          ctx.textAlign = 'left';
          ctx.fillText(label, PAD + 14, y + LINE_H / 2);
          if (isLast && r.prob > 0) {
            ctx.font = 'bold 13px sans-serif';
            ctx.fillStyle = GRAY300;
            ctx.textAlign = 'right';
            ctx.fillText(`${(r.prob * 100).toFixed(1)}%`, W - PAD, y + LINE_H / 2 - 6);
            ctx.font = '11px sans-serif';
            ctx.fillStyle = GRAY500;
            ctx.fillText(`$${(1 / r.prob).toFixed(2)}`, W - PAD, y + LINE_H / 2 + 8);
          }
          if (!isLast) {
            ctx.fillStyle = DIVIDER;
            ctx.globalAlpha = 0.5;
            ctx.fillRect(PAD, y + LINE_H - 1, W - PAD * 2, 1);
            ctx.globalAlpha = 1;
          }
          y += LINE_H;
        });
      } else {
        // Mixed result: line items first (combined odds on last item), then tryscorer picks
        items.forEach((label, idx) => {
          const isLastItem = idx === items.length - 1;
          _drawDot(ctx, PAD + 4, y + LINE_H / 2, 4, BLUE);
          ctx.font = 'italic 13px sans-serif';
          ctx.fillStyle = GRAY400;
          ctx.textAlign = 'left';
          ctx.fillText(label, PAD + 14, y + LINE_H / 2);
          if (isLastItem && r.lineProb) {
            ctx.font = 'bold 13px sans-serif';
            ctx.fillStyle = GRAY300;
            ctx.textAlign = 'right';
            ctx.fillText(`${(r.lineProb * 100).toFixed(1)}%`, W - PAD, y + LINE_H / 2 - 6);
            ctx.font = '11px sans-serif';
            ctx.fillStyle = GRAY500;
            ctx.fillText(`$${(1 / r.lineProb).toFixed(2)}`, W - PAD, y + LINE_H / 2 + 8);
          }
          ctx.fillStyle = DIVIDER;
          ctx.globalAlpha = 0.5;
          ctx.fillRect(PAD, y + LINE_H - 1, W - PAD * 2, 1);
          ctx.globalAlpha = 1;
          y += LINE_H;
        });
        r.picks.forEach((p, i) => {
          const rowY = y + i * PICK_H;
          _drawDot(ctx, PAD + 4, rowY + PICK_H / 2, 4, GREEN);
          const triesText = p.n > 1 ? ` (${p.n} tries)` : '';
          ctx.font = '14px sans-serif';
          ctx.fillStyle = WHITE;
          ctx.textAlign = 'left';
          ctx.fillText(p.name + triesText, PAD + 14, rowY + PICK_H / 2 - 6);
          if (p.indivProb != null) {
            ctx.font = 'bold 13px sans-serif';
            ctx.fillStyle = GRAY300;
            ctx.textAlign = 'right';
            ctx.fillText(`${(p.indivProb * 100).toFixed(1)}%`, W - PAD, rowY + PICK_H / 2 - 6);
            ctx.font = '11px sans-serif';
            ctx.fillStyle = GRAY500;
            ctx.fillText(`$${(1 / p.indivProb).toFixed(2)}`, W - PAD, rowY + PICK_H / 2 + 8);
          }
          if (i < r.picks.length - 1) {
            ctx.fillStyle = DIVIDER;
            ctx.globalAlpha = 0.5;
            ctx.fillRect(PAD, rowY + PICK_H - 1, W - PAD * 2, 1);
            ctx.globalAlpha = 1;
          }
        });
        y += r.picks.length * PICK_H;
      }
    });

    // Combined result
    if (hasPicks) {
      ctx.fillStyle = DIVIDER;
      ctx.fillRect(0, y, W, 1);
      y += 1;

      ctx.fillStyle = BG3;
      ctx.fillRect(0, y, W, COMBINED_H);

      const isMulti    = pickResults.length > 1;
      const totalLegs  = results.reduce((acc, r) => acc + (r.picks?.length || 0) + (r.lineLegs || 0), 0);
      const finalLabel = isMulti ? `Multi (${totalLegs} legs)` : 'SGM';

      if (bookieOdds != null) {
        // Two-panel layout: BS Machine | Bookie
        const modelProb = parseFloat(combinedPct) / 100;
        const ev        = (bookieOdds * modelProb - 1) * 100;
        const isValue   = ev > 0;

        // Row label + blend badge
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = GRAY500;
        ctx.textAlign = 'left';
        ctx.fillText(finalLabel.toUpperCase(), PAD, y + 16);
        if (blendPct > 0) {
          ctx.font = '10px sans-serif';
          ctx.fillStyle = BLUE;
          ctx.textAlign = 'right';
          ctx.fillText(`⚡ ${blendPct}% crowd`, W - PAD, y + 16);
        }

        // Panel geometry
        const PANEL_Y = y + 24;
        const PANEL_H = COMBINED_H - 30;
        const GAP     = 8;
        const PW      = (W - PAD * 2 - GAP) / 2;
        const P_PAD   = 12;
        const leftX   = PAD;
        const rightX  = PAD + PW + GAP;

        // Left panel — BS Machine (dark bg, amber border tint)
        ctx.fillStyle = '#111827';
        _drawRoundRect(ctx, leftX, PANEL_Y, PW, PANEL_H, 8);
        ctx.fill();
        ctx.strokeStyle = '#fbbf2440';
        ctx.lineWidth = 1;
        _drawRoundRect(ctx, leftX, PANEL_Y, PW, PANEL_H, 8);
        ctx.stroke();

        // Right panel — Bookie (tinted bg based on value)
        ctx.fillStyle = isValue ? '#052010' : '#111827';
        _drawRoundRect(ctx, rightX, PANEL_Y, PW, PANEL_H, 8);
        ctx.fill();
        ctx.strokeStyle = isValue ? '#4ade8040' : '#37415180';
        ctx.lineWidth = 1;
        _drawRoundRect(ctx, rightX, PANEL_Y, PW, PANEL_H, 8);
        ctx.stroke();
        ctx.lineWidth = 1;

        // Left panel content
        const midL = PANEL_Y + PANEL_H / 2;
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = AMBER;
        ctx.textAlign = 'left';
        ctx.fillText('BS MACHINE', leftX + P_PAD, PANEL_Y + 14);

        ctx.font = 'bold 26px "Barlow Condensed", sans-serif';
        ctx.fillStyle = AMBER;
        ctx.fillText(`${combinedPct}%`, leftX + P_PAD, midL + 8);

        ctx.font = '13px sans-serif';
        ctx.fillStyle = GRAY400;
        ctx.fillText(`$${combinedOdds}`, leftX + P_PAD, PANEL_Y + PANEL_H - 10);

        // Right panel content
        const midR = PANEL_Y + PANEL_H / 2;
        const bookieColor = isValue ? '#4ade80' : GRAY400;
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = isValue ? '#4ade80' : GRAY500;
        ctx.textAlign = 'left';
        ctx.fillText('BOOKIE', rightX + P_PAD, PANEL_Y + 14);

        ctx.font = 'bold 26px "Barlow Condensed", sans-serif';
        ctx.fillStyle = bookieColor;
        ctx.fillText(`$${parseFloat(bookieOdds).toFixed(2)}`, rightX + P_PAD, midR + 8);

        const evSign  = ev >= 0 ? '+' : '';
        const evLabel = `${evSign}${ev.toFixed(1)}% EV`;
        ctx.font = 'bold 12px sans-serif';
        ctx.fillStyle = isValue ? '#4ade80' : GRAY500;
        ctx.fillText(evLabel, rightX + P_PAD, PANEL_Y + PANEL_H - 10);

      } else {
        // Single-panel layout (no bookie odds)
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = AMBER;
        ctx.textAlign = 'left';
        ctx.fillText('BS MACHINE', PAD, y + 16);

        if (blendPct > 0) {
          ctx.font = '10px sans-serif';
          ctx.fillStyle = BLUE;
          ctx.textAlign = 'right';
          ctx.fillText(`⚡ ${blendPct}% crowd`, W - PAD, y + 16);
        }

        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = GRAY500;
        ctx.textAlign = 'left';
        ctx.fillText(finalLabel, PAD, y + COMBINED_H - 12);

        ctx.font = 'bold 32px "Barlow Condensed", sans-serif';
        ctx.fillStyle = AMBER;
        ctx.textAlign = 'right';
        ctx.fillText(`${combinedPct}%`, W - PAD - 80, y + COMBINED_H / 2 + 8);

        ctx.font = 'bold 20px "Barlow Condensed", sans-serif';
        ctx.fillStyle = GRAY300;
        ctx.fillText(`$${combinedOdds}`, W - PAD, y + COMBINED_H / 2 + 8);
      }

      y += COMBINED_H;
    }

    // Footer
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, y, W, FOOTER_H);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = GRAY500;
    ctx.textAlign = 'center';
    ctx.fillText('The BS Machine · bsmachine.dev', W / 2, y + FOOTER_H / 2);

    // Draw team logos on top (async)
    const homeSlug = teamLogoSlug(homeTeam);
    const awaySlug = teamLogoSlug(awayTeam);
    await Promise.all([
      homeSlug ? _loadAndDrawImage(ctx, `../logos/${homeSlug}.svg`, homeLogoX, logoY, logoSize, logoSize) : Promise.resolve(),
      awaySlug ? _loadAndDrawImage(ctx, `../logos/${awaySlug}.svg`, awayLogoX, logoY, logoSize, logoSize) : Promise.resolve(),
    ]);

    return canvas;
  }

  async function generateAndShowShareCard(results, combinedPct, combinedOdds, bookieOdds, blendPct) {
    const btn = document.getElementById('share-card-btn');
    if (btn) { btn.textContent = 'Generating…'; btn.disabled = true; }
    try {
      await document.fonts.ready;
      const canvas = await generateShareCard(results, combinedPct, combinedOdds, bookieOdds, blendPct);
      showShareModal(canvas);
    } finally {
      if (btn) { btn.textContent = '↗ Share Card'; btn.disabled = false; }
    }
  }

  function _trackShare(method) {
    if (typeof gtag === 'function') {
      gtag('event', 'share', { method, content_type: 'sgm_card', item_id: 'tryscorer_sgm' });
    }
  }

  async function showShareModal(canvas) {
    const existing = document.getElementById('share-card-modal');
    if (existing) existing.remove();

    const dataUrl = canvas.toDataURL('image/png');

    // Pre-generate blob before showing modal — both share and clipboard.write()
    // must be called with no awaits before them to preserve the iOS gesture token.
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const shareFile = new File([blob], 'bsmachine-sgm.png', { type: 'image/png' });
    const canNativeShare = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [shareFile] }));

    const nativeShareBtn = canNativeShare ? `
      <button id="share-native-btn"
         style="flex:1;padding:10px;border-radius:8px;background:#fbbf24;color:#111;font-weight:700;font-size:14px;cursor:pointer;border:none;font-family:sans-serif;">
        ↗ Share
      </button>` : '';

    const downloadBtn = `
      <a id="share-download-btn" href="${dataUrl}" download="bsmachine-sgm.png"
         style="flex:1;padding:10px;border-radius:8px;${canNativeShare ? 'background:#1a2a3a;border:1px solid #374151;color:#9ca3af;' : 'background:#fbbf24;color:#111;'}font-weight:700;font-size:14px;text-align:center;text-decoration:none;font-family:sans-serif;">
        ↓ Download
      </a>`;

    const copyBtn = `
      <button id="share-copy-btn"
         style="flex:1;padding:10px;border-radius:8px;background:#1e3a5f;border:1px solid #60a5fa;color:#60a5fa;font-weight:700;font-size:14px;cursor:pointer;font-family:sans-serif;">
        Copy
      </button>`;

    const modal = document.createElement('div');
    modal.id = 'share-card-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML = `
      <div style="background:#1a1f2e;border:1px solid #374151;border-radius:16px;padding:20px;max-width:640px;width:100%;position:relative;">
        <button id="share-modal-close" style="position:absolute;top:12px;right:14px;background:transparent;border:none;color:#6b7280;font-size:20px;cursor:pointer;line-height:1;">✕</button>
        <p style="font-family:sans-serif;font-size:15px;font-weight:700;color:#f9fafb;margin:0 0 14px 0;">Share Your SGM</p>
        <img src="${dataUrl}" style="width:100%;border-radius:8px;display:block;margin-bottom:14px;" alt="SGM Card">
        <div style="display:flex;gap:10px;">
          ${nativeShareBtn}
          ${downloadBtn}
          ${copyBtn}
        </div>
      </div>`;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#share-modal-close').addEventListener('click', () => modal.remove());

    if (canNativeShare) {
      modal.querySelector('#share-native-btn').addEventListener('click', () => {
        // No awaits before navigator.share() — preserves iOS Safari gesture token
        navigator.share({ files: [shareFile], title: 'My SGM · The BS Machine' })
          .then(() => _trackShare('native_share'))
          .catch(e => { if (e.name !== 'AbortError') console.warn('Share failed:', e); });
      });
    }

    modal.querySelector('#share-download-btn').addEventListener('click', () => _trackShare('download'));

    modal.querySelector('#share-copy-btn').addEventListener('click', () => {
      const btn = modal.querySelector('#share-copy-btn');
      // No awaits before clipboard.write() — preserves iOS Safari gesture token
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        .then(() => {
          _trackShare('clipboard');
          btn.textContent = '✓ Copied!';
          btn.style.color = '#4ade80';
          btn.style.borderColor = '#4ade80';
          setTimeout(() => { btn.textContent = 'Copy'; btn.style.color = '#60a5fa'; btn.style.borderColor = '#60a5fa'; }, 2000);
        })
        .catch(() => {
          btn.textContent = 'Right-click to copy';
          setTimeout(() => { btn.textContent = 'Copy'; }, 2500);
        });
    });
  }

  // --- INIT ---
  syncLineUI(null);
  updateTeamLabels();
});
