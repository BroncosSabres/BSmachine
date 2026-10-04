// my-teams-modal.js — Ticker Settings: per competition, whether the header
// ticker shows every game, only My Teams' games, or nothing, plus the picker
// for the teams followed in that competition. Opened from the header, the
// ticker's settings button and the profile page; registers window.openMyTeams().
import { SPORTS, getCurrentSport } from './sport-config.js';
import {
  MY_TEAMS_SPORTS, TICKER_MODES, loadMyTeams, saveMyTeams, isSignedIn,
  fetchTeamList, teamKey, teamLogoUrl,
} from './my-teams.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let modal = null;
let activeSport = 'nrl';
// Working copy while the modal is open: sport -> Map(teamKey -> stored name),
// and sport -> ticker mode.
let draft = {};
let draftTicker = {};

const MODE_LABELS = { all: 'All games', mine: 'My Teams', off: 'Hidden' };

function ensureModal() {
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'my-teams-modal';
  modal.className = 'mt-overlay';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="mt-dialog" role="dialog" aria-modal="true" aria-labelledby="mt-title">
      <div class="mt-head">
        <h2 id="mt-title" class="mt-title">Ticker Settings</h2>
        <button type="button" class="mt-close" aria-label="Close">&times;</button>
      </div>
      <p class="mt-sub">Choose what each competition shows in the match ticker, and follow as many teams as you like. My Teams' games are also listed first on predictions pages.</p>
      <div class="mt-tabs" role="tablist"></div>
      <div class="mt-mode">
        <span class="mt-mode-label">In the ticker</span>
        <div class="mt-seg" role="radiogroup" aria-label="Show in the ticker">
          ${TICKER_MODES.map(m => `<button type="button" role="radio" data-mode="${m}">${MODE_LABELS[m]}</button>`).join('')}
        </div>
        <span class="mt-mode-hint"></span>
      </div>
      <div class="mt-grid" role="group" aria-label="Teams"></div>
      <div class="mt-foot">
        <span class="mt-note"></span>
        <button type="button" class="mt-btn mt-cancel">Cancel</button>
        <button type="button" class="mt-btn mt-btn--primary mt-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelector('.mt-close').addEventListener('click', close);
  modal.querySelector('.mt-cancel').addEventListener('click', close);
  modal.querySelector('.mt-save').addEventListener('click', save);
  modal.querySelector('.mt-tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-sport]');
    if (!tab) return;
    activeSport = tab.dataset.sport;
    renderTabs();
    renderMode();
    renderGrid();
  });
  modal.querySelector('.mt-seg').addEventListener('click', e => {
    const btn = e.target.closest('[data-mode]');
    if (!btn || btn.disabled) return;
    draftTicker[activeSport] = btn.dataset.mode;
    renderTabs();
    renderMode();
  });
  modal.querySelector('.mt-grid').addEventListener('click', e => {
    const btn = e.target.closest('[data-team]');
    if (!btn) return;
    const name = btn.dataset.team;
    const key = teamKey(activeSport, name);
    const sel = draft[activeSport];
    if (sel.has(key)) sel.delete(key); else sel.set(key, name);
    btn.setAttribute('aria-pressed', String(sel.has(key)));
    // "My Teams" with none picked would hide the whole competition.
    if (!sel.size && draftTicker[activeSport] === 'mine') draftTicker[activeSport] = 'all';
    renderTabs();
    renderMode();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal && !modal.hidden) close();
  });
  return modal;
}

function renderTabs() {
  modal.querySelector('.mt-tabs').innerHTML = MY_TEAMS_SPORTS.map(sport => {
    const cfg = SPORTS[sport];
    const count = draft[sport].size;
    const active = sport === activeSport;
    const hidden = draftTicker[sport] === 'off';
    return `<button type="button" role="tab" data-sport="${sport}" aria-selected="${active}"
              class="comp-tab${active ? ' is-active' : ''}${hidden ? ' is-hidden' : ''}" style="--comp-color:${cfg.color}"
              ${hidden ? 'title="Hidden from the ticker"' : ''}>
              <img src="${cfg.logo}" alt="" class="comp-logo">${cfg.label}${count ? `<span class="mt-count">${count}</span>` : ''}
            </button>`;
  }).join('');
}

function renderMode() {
  const mode = draftTicker[activeSport];
  const noTeams = draft[activeSport].size === 0;
  modal.querySelectorAll('.mt-seg [data-mode]').forEach(btn => {
    btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
    btn.disabled = btn.dataset.mode === 'mine' && noTeams;
    btn.title = btn.disabled ? 'Pick a team below first' : '';
  });
  const label = SPORTS[activeSport].label;
  modal.querySelector('.mt-mode-hint').textContent =
    mode === 'off'  ? `No ${label} games in the ticker.` :
    mode === 'mine' ? `Only games involving your ${label} teams.` :
    noTeams         ? `Pick teams to highlight their games.` :
                      `Your teams' games are highlighted.`;
}

async function renderGrid() {
  const grid = modal.querySelector('.mt-grid');
  const sport = activeSport;
  grid.innerHTML = '<p class="mt-empty">Loading teams…</p>';
  const names = await fetchTeamList(sport);
  if (sport !== activeSport) return; // user switched tab while loading
  if (!names.length) {
    grid.innerHTML = '<p class="mt-empty">Couldn\'t load teams right now — try again shortly.</p>';
    return;
  }
  const sel = draft[sport];
  grid.innerHTML = names.map(name => `
    <button type="button" class="mt-team" data-team="${esc(name)}" aria-pressed="${sel.has(teamKey(sport, name))}">
      <img src="${esc(teamLogoUrl(sport, name))}" alt="" onerror="this.style.visibility='hidden'">
      <span>${esc(name)}</span>
    </button>`).join('');
}

function loadDraft(prefs) {
  draft = {};
  MY_TEAMS_SPORTS.forEach(sport => {
    draft[sport] = new Map(prefs.teams[sport].map(name => [teamKey(sport, name), name]));
    draftTicker[sport] = prefs.ticker[sport];
  });
}

async function save() {
  const btn = modal.querySelector('.mt-save');
  const note = modal.querySelector('.mt-note');
  btn.disabled = true;
  const teams = {};
  MY_TEAMS_SPORTS.forEach(sport => { teams[sport] = [...draft[sport].values()]; });
  const { ok } = await saveMyTeams({ teams, ticker: { ...draftTicker } });
  btn.disabled = false;
  if (!ok) {
    note.textContent = 'Saved on this device, but couldn\'t save to your profile.';
    return;
  }
  close();
}

function close() {
  if (modal) modal.hidden = true;
  document.body.style.overflow = '';
}

// Opens on the given competition, else the one whose pages we're on, else NRL.
export async function openMyTeams(sport) {
  ensureModal();
  activeSport = MY_TEAMS_SPORTS.includes(sport) ? sport : (getCurrentSport() || 'nrl');
  modal.querySelector('.mt-note').textContent = '';
  modal.querySelector('.mt-grid').innerHTML = '<p class="mt-empty">Loading teams…</p>';
  modal.hidden = false;
  document.body.style.overflow = 'hidden';

  // Usually already resolved by the ticker; waiting means the profile copy is
  // shown rather than a stale local one.
  loadDraft(await loadMyTeams());
  renderTabs();
  renderMode();
  renderGrid();

  if (!(await isSignedIn()) && !modal.hidden) {
    modal.querySelector('.mt-note').innerHTML =
      '<a href="/pages/login.html">Sign in</a> to keep these on every device.';
  }
}

window.openMyTeams = openMyTeams;
