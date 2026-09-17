// nhl_multi_builder.js — drives nhl/pages/tryscorer_predictions.html ("Multi Builder")
// Port of nfl_multi_builder.js: no player scorer picks and no crowd-blend
// slider, just the margin / total-goals / team-goals line builder, wired to
// real nhl.game_sgm_bins joint score distributions via
// /api/nhl/game_sgm_bins_range. Games are paged by calendar date (like
// nhl-matchups.js) rather than by week, since NHL has no week concept.
import { apiUrl } from './api-config.js';

const dateBadge        = document.getElementById('week-badge');
const datePrevBtn      = document.getElementById('week-prev');
const dateNextBtn      = document.getElementById('week-next');
const gameSelect       = document.getElementById('game-select');
const noGamesMsg       = document.getElementById('no-games-msg');
const builderSection   = document.getElementById('builder-section');
const builderMatchup   = document.getElementById('builder-matchup');
const builderKickoff   = document.getElementById('builder-kickoff');
const resetBuilderBtn  = document.getElementById('reset-builder-btn');

const marginDirHome  = document.getElementById('margin-dir-home');
const marginDirAway  = document.getElementById('margin-dir-away');
const marginValSel   = document.getElementById('margin-val');
const marginClearBtn = document.getElementById('margin-clear');

const totalDirOver  = document.getElementById('total-dir-over');
const totalDirUnder = document.getElementById('total-dir-under');
const totalValSel    = document.getElementById('total-val');
const totalClearBtn  = document.getElementById('total-clear');

const homePtsLabel     = document.getElementById('home-pts-label');
const homeTotalDirOver  = document.getElementById('home-total-dir-over');
const homeTotalDirUnder = document.getElementById('home-total-dir-under');
const homeTotalValSel   = document.getElementById('home-total-val');
const homeTotalClearBtn = document.getElementById('home-total-clear');

const awayPtsLabel     = document.getElementById('away-pts-label');
const awayTotalDirOver  = document.getElementById('away-total-dir-over');
const awayTotalDirUnder = document.getElementById('away-total-dir-under');
const awayTotalValSel   = document.getElementById('away-total-val');
const awayTotalClearBtn = document.getElementById('away-total-clear');

const resultCard  = document.getElementById('result-card');
const resultLegs  = document.getElementById('result-legs');
const resultProb  = document.getElementById('result-prob');
const resultOdds  = document.getElementById('result-odds');

const WINDOW_DAYS = 14;

let dateKeys      = [];
let gamesByDate    = {};
let currentDateIdx = 0;
let games         = [];
let currentGame   = null;
let binsCache     = {}; // { game_id: bins[] }

// --- STATE ---
let marginTeam = null;   // 'home' | 'away' | null
let marginL    = null;   // dropdown value, e.g. -0.5, -6.5, +3.5
let totalDir   = null;   // 'over' | 'under' | null
let totalN     = null;
let homeTotalDir = null;
let homeTotalN   = null;
let awayTotalDir = null;
let awayTotalN   = null;

function lineToN(L) { return Math.floor(-L) + 1; }

function populateMarginDropdown() {
  marginValSel.innerHTML = '';
  for (let v = -20.5; v <= 20.5; v += 1) {
    const sign  = v >= 0 ? '+' : '';
    const label = v === -0.5 ? 'To Win' : `${sign}${v}`;
    marginValSel.innerHTML += `<option value="${v}"${v === -0.5 ? ' selected' : ''}>${label}</option>`;
  }
}

function populateTotalDropdown(sel, max) {
  sel.innerHTML = '<option value="" disabled selected>—</option>';
  for (let n = 1; n <= max; n++) {
    sel.innerHTML += `<option value="${n}">${n - 0.5}</option>`;
  }
}

populateMarginDropdown();
populateTotalDropdown(totalValSel, 20);
populateTotalDropdown(homeTotalValSel, 12);
populateTotalDropdown(awayTotalValSel, 12);

// --- CONSTRAINT BUILDING (mirrors js/tryscorer_predictions.js buildConstraints) ---
function buildConstraints() {
  let margin = null, total = null, homeTotal = null, awayTotal = null;

  if (marginTeam && marginL != null) {
    const N1 = lineToN(marginL); // margin (home - away) >= N1 for home, <= -N1 for away
    margin = marginTeam === 'home'
      ? { type: 'over',  val: N1 }
      : { type: 'under', val: 1 - N1 };
  }
  if (totalDir && totalN != null) {
    total = { type: totalDir, val: totalN };
  }
  if (homeTotalDir && homeTotalN != null) homeTotal = { type: homeTotalDir, val: homeTotalN };
  if (awayTotalDir && awayTotalN != null) awayTotal = { type: awayTotalDir, val: awayTotalN };

  return { margin, total, homeTotal, awayTotal };
}

function filterBins(bins, c) {
  let filtered = bins.filter(b => {
    if (c.margin?.type === 'over'  && b.m < c.margin.val)  return false;
    if (c.margin?.type === 'under' && b.m >= c.margin.val) return false;
    if (c.total?.type  === 'over'  && b.t < c.total.val)   return false;
    if (c.total?.type  === 'under' && b.t >= c.total.val)  return false;
    return true;
  });
  if (c.homeTotal || c.awayTotal) {
    filtered = filtered.filter(b => {
      const hs  = (b.m + b.t) / 2;
      const as_ = (b.t - b.m) / 2;
      if (c.homeTotal?.type === 'over'  && hs  <  c.homeTotal.val) return false;
      if (c.homeTotal?.type === 'under' && hs  >= c.homeTotal.val) return false;
      if (c.awayTotal?.type === 'over'  && as_ <  c.awayTotal.val) return false;
      if (c.awayTotal?.type === 'under' && as_ >= c.awayTotal.val) return false;
      return true;
    });
  }
  return filtered;
}

function hasAnyConstraint(c) {
  return !!(c.margin || c.total || c.homeTotal || c.awayTotal);
}

function marginLabel() {
  if (!marginTeam || marginL == null) return null;
  const teamName = marginTeam === 'home' ? currentGame?.home_team : currentGame?.away_team;
  if (marginL === -0.5) return `${teamName} To Win`;
  const sign = marginL < 0 ? '' : '+';
  return `${teamName} ${sign}${marginL}`;
}
function totalLabel() {
  if (!totalDir || totalN == null) return null;
  return `Total ${totalDir === 'over' ? 'Over' : 'Under'} ${totalN - 0.5}`;
}
function homeTotalLabel() {
  if (!homeTotalDir || homeTotalN == null) return null;
  return `${currentGame?.home_team} ${homeTotalDir === 'over' ? 'Over' : 'Under'} ${homeTotalN - 0.5}`;
}
function awayTotalLabel() {
  if (!awayTotalDir || awayTotalN == null) return null;
  return `${currentGame?.away_team} ${awayTotalDir === 'over' ? 'Over' : 'Under'} ${awayTotalN - 0.5}`;
}

function recalculate() {
  if (!currentGame) return;
  const bins = binsCache[currentGame.game_id];
  const c = buildConstraints();

  if (!bins || !hasAnyConstraint(c)) {
    resultCard.classList.add('hidden');
    return;
  }

  const totalCount = bins.reduce((s, b) => s + (b.c || 0), 0) || 1;
  const filtered   = filterBins(bins, c);
  const filtCount  = filtered.reduce((s, b) => s + (b.c || 0), 0);
  const prob       = filtCount / totalCount;

  const legs = [marginLabel(), totalLabel(), homeTotalLabel(), awayTotalLabel()].filter(Boolean);
  resultLegs.textContent = legs.join(' + ');
  resultProb.textContent = `${(prob * 100).toFixed(1)}%`;
  resultOdds.textContent = prob >= 1e-6 ? `$${(1 / prob).toFixed(2)}` : '—';
  resultCard.classList.remove('hidden');
}

function updateResetState() {
  const active = !!(marginTeam || totalDir || homeTotalDir || awayTotalDir);
  resetBuilderBtn.disabled = !active;
}

// --- MARGIN CONTROLS ---
function setMarginTeam(team) {
  marginTeam = team;
  marginValSel.disabled = false;
  marginDirHome.classList.toggle('bg-blue-500', team === 'home');
  marginDirHome.classList.toggle('text-white', team === 'home');
  marginDirHome.classList.toggle('text-gray-400', team !== 'home');
  marginDirAway.classList.toggle('bg-blue-500', team === 'away');
  marginDirAway.classList.toggle('text-white', team === 'away');
  marginDirAway.classList.toggle('text-gray-400', team !== 'away');
  if (marginL == null) marginL = -0.5;
  marginValSel.value = String(marginL);
  updateResetState();
  recalculate();
}
marginDirHome.addEventListener('click', () => setMarginTeam(marginTeam === 'home' ? null : 'home'));
marginDirAway.addEventListener('click', () => setMarginTeam(marginTeam === 'away' ? null : 'away'));
marginValSel.addEventListener('change', () => { marginL = parseFloat(marginValSel.value); recalculate(); });
marginClearBtn.addEventListener('click', () => {
  marginTeam = null; marginL = null;
  marginValSel.disabled = true;
  [marginDirHome, marginDirAway].forEach(b => { b.classList.remove('bg-blue-500', 'text-white'); b.classList.add('text-gray-400'); });
  updateResetState();
  recalculate();
});

// --- TOTAL GOALS CONTROLS (factory for the 3 identical over/under groups) ---
function wireTotalGroup(dirOverBtn, dirUnderBtn, valSel, clearBtn, setDir, setVal, getDir) {
  function paint() {
    const dir = getDir();
    dirOverBtn.classList.toggle('bg-blue-500', dir === 'over');
    dirOverBtn.classList.toggle('text-white', dir === 'over');
    dirOverBtn.classList.toggle('text-gray-400', dir !== 'over');
    dirUnderBtn.classList.toggle('bg-blue-500', dir === 'under');
    dirUnderBtn.classList.toggle('text-white', dir === 'under');
    dirUnderBtn.classList.toggle('text-gray-400', dir !== 'under');
    valSel.disabled = !dir;
  }
  dirOverBtn.addEventListener('click', () => { setDir(getDir() === 'over' ? null : 'over'); paint(); recalculate(); updateResetState(); });
  dirUnderBtn.addEventListener('click', () => { setDir(getDir() === 'under' ? null : 'under'); paint(); recalculate(); updateResetState(); });
  valSel.addEventListener('change', () => { setVal(parseInt(valSel.value, 10)); recalculate(); });
  clearBtn.addEventListener('click', () => {
    setDir(null); setVal(null); valSel.value = '';
    paint(); recalculate(); updateResetState();
  });
  return paint;
}

wireTotalGroup(totalDirOver, totalDirUnder, totalValSel, totalClearBtn,
  d => { totalDir = d; }, n => { totalN = n; }, () => totalDir);
wireTotalGroup(homeTotalDirOver, homeTotalDirUnder, homeTotalValSel, homeTotalClearBtn,
  d => { homeTotalDir = d; }, n => { homeTotalN = n; }, () => homeTotalDir);
wireTotalGroup(awayTotalDirOver, awayTotalDirUnder, awayTotalValSel, awayTotalClearBtn,
  d => { awayTotalDir = d; }, n => { awayTotalN = n; }, () => awayTotalDir);

function resetBuilder() {
  marginTeam = null; marginL = null;
  totalDir = null; totalN = null;
  homeTotalDir = null; homeTotalN = null;
  awayTotalDir = null; awayTotalN = null;

  marginValSel.value = ''; marginValSel.disabled = true;
  totalValSel.value = ''; totalValSel.disabled = true;
  homeTotalValSel.value = ''; homeTotalValSel.disabled = true;
  awayTotalValSel.value = ''; awayTotalValSel.disabled = true;

  [marginDirHome, marginDirAway, totalDirOver, totalDirUnder,
   homeTotalDirOver, homeTotalDirUnder, awayTotalDirOver, awayTotalDirUnder].forEach(b => {
    b.classList.remove('bg-blue-500', 'text-white');
    b.classList.add('text-gray-400');
  });

  resultCard.classList.add('hidden');
  updateResetState();
}
resetBuilderBtn.addEventListener('click', resetBuilder);

// --- GAME LOADING ---
function formatKickoff(iso) {
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

async function loadBinsForGame(gameId) {
  if (binsCache[gameId]) return binsCache[gameId];
  try {
    const res = await fetch(apiUrl('nhl', `game_sgm_bins_range/${gameId}`));
    if (!res.ok) { binsCache[gameId] = []; return []; }
    const json = await res.json();
    binsCache[gameId] = json.bins || [];
    return binsCache[gameId];
  } catch (e) {
    binsCache[gameId] = [];
    return [];
  }
}

async function selectGame(gameId) {
  currentGame = games.find(g => String(g.game_id) === String(gameId));
  resetBuilder();
  if (!currentGame) { builderSection.classList.add('hidden'); return; }

  builderMatchup.textContent = `${currentGame.home_team} vs ${currentGame.away_team}`;
  builderKickoff.textContent = formatKickoff(currentGame.date);
  homePtsLabel.textContent = `${currentGame.home_team} Goals`;
  awayPtsLabel.textContent = `${currentGame.away_team} Goals`;
  marginDirHome.textContent = currentGame.home_abbr || currentGame.home_team;
  marginDirAway.textContent = currentGame.away_abbr || currentGame.away_team;
  builderSection.classList.remove('hidden');

  await loadBinsForGame(currentGame.game_id);
}

gameSelect.addEventListener('change', () => selectGame(gameSelect.value));

function renderCurrentDate() {
  const key = dateKeys[currentDateIdx];
  gameSelect.innerHTML = '';
  noGamesMsg.classList.add('hidden');
  builderSection.classList.add('hidden');

  if (!key) {
    dateBadge.textContent = 'No games';
    noGamesMsg.classList.remove('hidden');
    datePrevBtn.disabled = true;
    dateNextBtn.disabled = true;
    return;
  }

  games = (gamesByDate[key] || []).filter(g => g.has_prediction);
  dateBadge.textContent = formatKickoff(gamesByDate[key]?.[0]?.date) || key;

  if (!games.length) {
    noGamesMsg.classList.remove('hidden');
  } else {
    gameSelect.innerHTML = games.map(g =>
      `<option value="${g.game_id}">${g.home_team} vs ${g.away_team}</option>`
    ).join('');
    selectGame(games[0].game_id);
  }

  datePrevBtn.disabled = currentDateIdx <= 0;
  dateNextBtn.disabled = currentDateIdx >= dateKeys.length - 1;
}

datePrevBtn.addEventListener('click', () => {
  if (currentDateIdx <= 0) return;
  currentDateIdx -= 1;
  renderCurrentDate();
});
dateNextBtn.addEventListener('click', () => {
  if (currentDateIdx >= dateKeys.length - 1) return;
  currentDateIdx += 1;
  renderCurrentDate();
});

async function init() {
  const res = await fetch(apiUrl('nhl', 'upcoming_predictions?days=14'));
  if (!res.ok) { renderCurrentDate(); return; }
  const json = await res.json();
  const allGames = json.predictions || [];

  gamesByDate = {};
  allGames.forEach(g => {
    const key = dateKeyOf(g.date);
    if (!key) return;
    (gamesByDate[key] = gamesByDate[key] || []).push(g);
  });
  dateKeys = Object.keys(gamesByDate).sort((a, b) => new Date(a) - new Date(b));

  const params = new URLSearchParams(window.location.search);
  const gameIdParam = params.get('game_id');

  const todayKey = new Date().toDateString();
  const todayIdx = dateKeys.findIndex(k => new Date(k) >= new Date(todayKey));
  currentDateIdx = todayIdx >= 0 ? todayIdx : 0;

  if (gameIdParam) {
    const targetIdx = dateKeys.findIndex(k => (gamesByDate[k] || []).some(g => String(g.game_id) === gameIdParam));
    if (targetIdx >= 0) currentDateIdx = targetIdx;
  }

  renderCurrentDate();

  if (gameIdParam && games.some(g => String(g.game_id) === gameIdParam)) {
    selectGame(gameIdParam);
  }
}

init();
