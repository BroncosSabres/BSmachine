// homepage-predictions.js — drives the homepage: sport hub cards + the
// cross-sport "Next 7 Days" predictions feed.
import { SPORTS, sportUrl } from './sport-config.js';
import { fetchAllUpcoming } from './upcoming-matches.js';
import { renderPredictionTile } from './prediction-tile.js';

const HUB_LINKS = [
  { label: 'Rankings',      page: 'rankings.html' },
  { label: 'Predictions',   page: 'matchups.html' },
  { label: 'Multi Builder', page: 'tryscorer_predictions.html' },
];

function renderSportHub() {
  const hub = document.getElementById('sport-hub');
  if (!hub) return;
  hub.innerHTML = Object.entries(SPORTS).map(([key, cfg]) => `
    <div class="hub-card" style="--comp-color:${cfg.color}">
      <a href="${sportUrl(key)}" class="hub-card-main">
        <span class="hub-card-label"><img src="${cfg.logo}" alt="" class="hub-card-logo">${cfg.label}</span>
        <span class="hub-card-arrow" aria-hidden="true">→</span>
      </a>
      <div class="hub-card-links">
        ${HUB_LINKS.map(l => `<a href="${sportUrl(key, l.page)}">${l.label}</a>`).join('')}
      </div>
    </div>
  `).join('');
}

function dayLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

async function loadUpcomingFeed() {
  const feed = document.getElementById('upcoming-feed');
  if (!feed) return;

  // Shares its cache with the header match ticker, so this rarely re-fetches.
  const entries = await fetchAllUpcoming(7);

  if (!entries.length) {
    feed.innerHTML = `<p class="text-gray-500 text-sm">No matches scheduled in the next 7 days.</p>`;
    return;
  }

  const byDay = new Map();
  entries.forEach(e => {
    const key = new Date(e.date).toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  });

  feed.innerHTML = [...byDay.entries()].map(([key, dayEntries]) => `
    <div>
      <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">${dayLabel(dayEntries[0].date)}</h3>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${dayEntries.map(renderPredictionTile).join('')}
      </div>
    </div>
  `).join('');
}

renderSportHub();
loadUpcomingFeed();
