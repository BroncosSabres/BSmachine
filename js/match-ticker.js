// match-ticker.js — the NRL.com-style strip of match tiles at the top of every
// page. Shows every competition's games in kickoff order, with a day label
// wherever the day changes, and scrolls to the next unplayed game on load.
import { fetchAllUpcoming } from './upcoming-matches.js';
import { renderTickerTile } from './prediction-tile.js';

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function renderStrip(entries) {
  let lastDay = null;
  return entries.map(e => {
    const day = new Date(e.date).toDateString();
    const divider = day !== lastDay
      ? `<div class="ticker-day"><span>${dayLabel(e.date)}</span></div>`
      : '';
    lastDay = day;
    return divider + renderTickerTile(e);
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
      <button type="button" class="ticker-arrow ticker-arrow--prev" aria-label="Scroll matches left" disabled>&#8249;</button>
      <div class="ticker-track" role="list" aria-label="Upcoming matches">
        ${'<div class="ticker-tile ticker-tile--skeleton"></div>'.repeat(8)}
      </div>
      <button type="button" class="ticker-arrow ticker-arrow--next" aria-label="Scroll matches right" disabled>&#8250;</button>
    </div>`;

  const track = root.querySelector('.ticker-track');
  const prev  = root.querySelector('.ticker-arrow--prev');
  const next  = root.querySelector('.ticker-arrow--next');

  const entries = await fetchAllUpcoming(7);
  if (!entries.length) {
    root.classList.add('is-empty');
    return;
  }

  track.innerHTML = renderStrip(entries);

  // Start at the first game that hasn't finished yet (NRL.com-style).
  const firstLive = track.querySelector('.ticker-tile:not(.is-finished)');
  if (firstLive) {
    const divider = firstLive.previousElementSibling;
    const anchor = divider?.classList.contains('ticker-day') ? divider : firstLive;
    // .ticker-track is position:relative, so offsetLeft is measured from it.
    track.scrollLeft = anchor.offsetLeft;
  }

  const step = () => Math.max(track.clientWidth * 0.8, 200);
  prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
  next.addEventListener('click', () => track.scrollBy({ left:  step(), behavior: 'smooth' }));
  track.addEventListener('scroll', () => updateArrows(track, prev, next), { passive: true });
  window.addEventListener('resize', () => updateArrows(track, prev, next));
  updateArrows(track, prev, next);
}
