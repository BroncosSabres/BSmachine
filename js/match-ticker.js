// match-ticker.js — the NRL.com-style strip of match tiles at the top of every
// page. Shows every competition's games in kickoff order, with a day label
// wherever the day changes, and scrolls to the next unplayed game on load.
// Games involving the viewer's My Teams are highlighted, and Ticker Settings
// (the cog at the left) can hide a competition or narrow it to My Teams' games.
import { fetchAllUpcoming } from './upcoming-matches.js';
import { renderTickerTile } from './prediction-tile.js';
import {
  getMyTeams, hasAnyTeams, involvesMyTeam, showInTicker, loadMyTeams,
  MY_TEAMS_SPORTS, MY_TEAMS_CHANGED,
} from './my-teams.js';

const DAYS = 7;
// A game that kicked off within this window and isn't marked finished is
// treated as in progress; older unfinished games are just awaiting results.
const LIVE_WINDOW_MS = 3 * 60 * 60 * 1000;
const REFRESH_MS = 5 * 60 * 1000;

// Date-only strings (NRL games with no scraped kickoff time) would parse as
// UTC midnight — read them as a local calendar day instead.
function parseKickoff(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(+m[1], m[2] - 1, +m[3]) : new Date(iso);
}

// The next game to start (or one still in progress) in the viewer's clock,
// regardless of whether earlier games have had their results recorded yet.
function isUpcoming(entry, now) {
  if (entry.isFinished) return false;
  const d = parseKickoff(entry.date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return d >= today;
  }
  return d.getTime() > now - LIVE_WINDOW_MS;
}

function dayLabel(iso) {
  const d = parseKickoff(iso);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function renderStrip(items) {
  let lastDay = null;
  return items.map(({ entry, myTeam }) => {
    const day = parseKickoff(entry.date).toDateString();
    const divider = day !== lastDay
      ? `<div class="ticker-day"><span>${dayLabel(entry.date)}</span></div>`
      : '';
    lastDay = day;
    return divider + renderTickerTile(entry, { myTeam });
  }).join('');
}

function updateArrows(track, prev, next) {
  const max = track.scrollWidth - track.clientWidth;
  prev.disabled = track.scrollLeft <= 4;
  next.disabled = track.scrollLeft >= max - 4;
}

export async function initMatchTicker(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="ticker-inner">
      <button type="button" class="ticker-settings" aria-label="Ticker settings" title="Ticker settings">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 0 1-2.29.95c-1.37-.84-2.94.73-2.1 2.1.54.89.06 2.04-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.01.25 1.49 1.4.95 2.29-.84 1.37.73 2.94 2.1 2.1a1.53 1.53 0 0 1 2.29.95c.38 1.56 2.6 1.56 2.98 0a1.53 1.53 0 0 1 2.29-.95c1.37.84 2.94-.73 2.1-2.1a1.53 1.53 0 0 1 .95-2.29c1.56-.38 1.56-2.6 0-2.98a1.53 1.53 0 0 1-.95-2.29c.84-1.37-.73-2.94-2.1-2.1a1.53 1.53 0 0 1-2.29-.95ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clip-rule="evenodd"/></svg>
      </button>
      <button type="button" class="ticker-arrow ticker-arrow--prev" aria-label="Scroll matches left" disabled>&#8249;</button>
      <div class="ticker-track" role="list" aria-label="Upcoming matches">
        ${'<div class="ticker-tile ticker-tile--skeleton"></div>'.repeat(8)}
      </div>
      <button type="button" class="ticker-arrow ticker-arrow--next" aria-label="Scroll matches right" disabled>&#8250;</button>
    </div>`;

  const track  = root.querySelector('.ticker-track');
  const prev   = root.querySelector('.ticker-arrow--prev');
  const next   = root.querySelector('.ticker-arrow--next');
  const settings = root.querySelector('.ticker-settings');

  // Profile teams may arrive after the games; MY_TEAMS_CHANGED re-renders then.
  loadMyTeams();
  let entries = await fetchAllUpcoming(DAYS);
  // Set once the viewer scrolls the strip themselves, so a background refresh
  // doesn't yank them back to the next game.
  let userScrolled = false;

  function render({ keepScroll = false } = {}) {
    root.classList.toggle('is-empty', !entries.length);
    if (!entries.length) return;

    const prefs = getMyTeams();
    const following = hasAnyTeams(prefs);
    const filtered = MY_TEAMS_SPORTS.some(s => prefs.ticker[s] !== 'all');
    settings.classList.toggle('is-filtered', filtered);
    settings.title = filtered ? 'Ticker settings (filtered)' : 'Ticker settings';

    const items = entries
      .filter(entry => showInTicker(entry.sport, entry.homeTeam, entry.awayTeam, prefs))
      .map(entry => ({
        entry,
        myTeam: following && involvesMyTeam(entry.sport, entry.homeTeam, entry.awayTeam),
      }));

    if (!items.length) {
      const allOff = MY_TEAMS_SPORTS.every(s => prefs.ticker[s] === 'off');
      track.innerHTML = `<div class="ticker-empty">${allOff
        ? 'Every competition is hidden.'
        : `No games for your ticker settings in the next ${DAYS} days.`}
        <button type="button" class="ticker-empty-link">Change settings</button></div>`;
      updateArrows(track, prev, next);
      return;
    }

    const scrollLeft = track.scrollLeft;
    track.innerHTML = renderStrip(items);

    if (keepScroll) {
      track.scrollLeft = scrollLeft;
    } else {
      // Start at the next game to start in the viewer's time zone
      // (NRL.com-style); earlier games stay scrollable to the left.
      const now = Date.now();
      const idx = items.findIndex(i => isUpcoming(i.entry, now));
      const tiles = track.querySelectorAll('.ticker-tile');
      const target = tiles[idx === -1 ? tiles.length - 1 : idx];
      if (target) {
        const divider = target.previousElementSibling;
        const anchor = divider?.classList.contains('ticker-day') ? divider : target;
        // .ticker-track is position:relative, so offsetLeft is measured from it.
        track.scrollLeft = anchor.offsetLeft;
      }
    }
    updateArrows(track, prev, next);
  }

  render();
  window.addEventListener(MY_TEAMS_CHANGED, () => render());

  // Keep scores, "Today"/"Tomorrow" labels and the starting game current on
  // pages left open. fetchAllUpcoming serves its cache until it expires.
  async function refresh({ reanchor }) {
    const fresh = await fetchAllUpcoming(DAYS);
    if (!fresh.length) return; // keep what we have if the backend blips
    entries = fresh;
    if (reanchor) userScrolled = false;
    render({ keepScroll: userScrolled });
  }
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh({ reanchor: false });
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh({ reanchor: true });
  });
  for (const evt of ['wheel', 'pointerdown', 'keydown']) {
    track.addEventListener(evt, () => { userScrolled = true; }, { passive: true });
  }

  const openSettings = () => import('./my-teams-modal.js').then(mod => mod.openMyTeams());
  settings.addEventListener('click', openSettings);
  track.addEventListener('click', e => {
    if (e.target.closest('.ticker-empty-link')) openSettings();
  });

  const step = () => Math.max(track.clientWidth * 0.8, 200);
  prev.addEventListener('click', () => { userScrolled = true; track.scrollBy({ left: -step(), behavior: 'smooth' }); });
  next.addEventListener('click', () => { userScrolled = true; track.scrollBy({ left:  step(), behavior: 'smooth' }); });
  track.addEventListener('scroll', () => updateArrows(track, prev, next), { passive: true });
  window.addEventListener('resize', () => updateArrows(track, prev, next));
}
