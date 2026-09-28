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

function dayLabel(iso) {
  const d = new Date(iso);
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
    const day = new Date(entry.date).toDateString();
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
  const entries = await fetchAllUpcoming(DAYS);
  if (!entries.length) {
    root.classList.add('is-empty');
    return;
  }

  function render() {
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

    track.innerHTML = renderStrip(items);

    // Start at the first game that hasn't finished yet (NRL.com-style).
    const firstLive = track.querySelector('.ticker-tile:not(.is-finished)');
    if (firstLive) {
      const divider = firstLive.previousElementSibling;
      const anchor = divider?.classList.contains('ticker-day') ? divider : firstLive;
      // .ticker-track is position:relative, so offsetLeft is measured from it.
      track.scrollLeft = anchor.offsetLeft;
    }
    updateArrows(track, prev, next);
  }

  render();
  window.addEventListener(MY_TEAMS_CHANGED, render);

  filter.addEventListener('click', e => {
    const btn = e.target.closest('button[data-mine]');
    if (!btn) return;
    const mineOnly = btn.dataset.mine === '1';
    if (mineOnly !== getMyTeams().tickerMyTeamsOnly) setTickerMyTeamsOnly(mineOnly);
  });

  const step = () => Math.max(track.clientWidth * 0.8, 200);
  prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
  next.addEventListener('click', () => track.scrollBy({ left:  step(), behavior: 'smooth' }));
  track.addEventListener('scroll', () => updateArrows(track, prev, next), { passive: true });
  window.addEventListener('resize', () => updateArrows(track, prev, next));
}
