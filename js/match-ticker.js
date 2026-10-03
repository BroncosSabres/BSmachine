// match-ticker.js — the NRL.com-style strip of match tiles at the top of every
// page. Shows every competition's games in kickoff order, with a day label
// wherever the day changes, and scrolls to the next unplayed game on load.
// Games involving the viewer's My Teams are highlighted, and once they follow
// a team an All / My Teams toggle can narrow the strip to just those games.
import { fetchAllUpcoming } from './upcoming-matches.js';
import { renderTickerTile } from './prediction-tile.js';
import {
  getMyTeams, hasAnyTeams, involvesMyTeam, loadMyTeams,
  setTickerMyTeamsOnly, MY_TEAMS_CHANGED,
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
      <div class="ticker-filter" role="group" aria-label="Ticker games" hidden>
        <button type="button" data-mine="0">All</button>
        <button type="button" data-mine="1">My Teams</button>
      </div>
      <button type="button" class="ticker-arrow ticker-arrow--prev" aria-label="Scroll matches left" disabled>&#8249;</button>
      <div class="ticker-track" role="list" aria-label="Upcoming matches">
        ${'<div class="ticker-tile ticker-tile--skeleton"></div>'.repeat(8)}
      </div>
      <button type="button" class="ticker-arrow ticker-arrow--next" aria-label="Scroll matches right" disabled>&#8250;</button>
    </div>`;

  const track  = root.querySelector('.ticker-track');
  const prev   = root.querySelector('.ticker-arrow--prev');
  const next   = root.querySelector('.ticker-arrow--next');
  const filter = root.querySelector('.ticker-filter');

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
    const mineOnly = following && prefs.tickerMyTeamsOnly;

    filter.hidden = !following;
    filter.querySelectorAll('button').forEach(b => {
      b.setAttribute('aria-pressed', String((b.dataset.mine === '1') === mineOnly));
    });

    let items = entries.map(entry => ({
      entry,
      myTeam: following && involvesMyTeam(entry.sport, entry.homeTeam, entry.awayTeam),
    }));
    if (mineOnly) items = items.filter(i => i.myTeam);

    if (!items.length) {
      track.innerHTML = `<div class="ticker-empty">None of your teams play in the next ${DAYS} days.</div>`;
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

  filter.addEventListener('click', e => {
    const btn = e.target.closest('button[data-mine]');
    if (!btn) return;
    const mineOnly = btn.dataset.mine === '1';
    if (mineOnly !== getMyTeams().tickerMyTeamsOnly) setTickerMyTeamsOnly(mineOnly);
  });

  const step = () => Math.max(track.clientWidth * 0.8, 200);
  prev.addEventListener('click', () => { userScrolled = true; track.scrollBy({ left: -step(), behavior: 'smooth' }); });
  next.addEventListener('click', () => { userScrolled = true; track.scrollBy({ left:  step(), behavior: 'smooth' }); });
  track.addEventListener('scroll', () => updateArrows(track, prev, next), { passive: true });
  window.addEventListener('resize', () => updateArrows(track, prev, next));
}
