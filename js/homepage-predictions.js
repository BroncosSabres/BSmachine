// homepage-predictions.js — drives the homepage: sport hub tiles + the
// cross-sport "Next 7 Days" predictions feed.
import { apiUrl } from './api-config.js';
import { SPORTS } from './sport-config.js';
import { teamSlug } from './utils.js';
import { nflLogoUrl } from './nfl-logos.js';
import { renderPredictionTile } from './prediction-tile.js';

function nrlLogoUrl(teamName) {
  return `/logos/${teamSlug(teamName)}.svg`;
}

function renderSportHub() {
  const hub = document.getElementById('sport-hub');
  if (!hub) return;
  hub.innerHTML = Object.entries(SPORTS).map(([key, cfg]) => `
    <a href="${cfg.basePath}${cfg.landingPage}" class="card flex items-center justify-between hover:border-amber-500/50 transition-colors" style="text-decoration:none;">
      <div>
        <div class="text-xs text-gray-500 uppercase tracking-widest mb-1">${cfg.label}</div>
        <div class="text-xl font-bold text-white">Rankings &amp; Predictions</div>
      </div>
      <span class="text-sm font-medium" style="color:#fbbf24;">View →</span>
    </a>
  `).join('');
}

function adaptNrl(p) {
  return {
    sport: 'nrl',
    date: p.date,
    homeTeam: p.home_team,
    awayTeam: p.away_team,
    homeScore: p.home_score,
    awayScore: p.away_score,
    homePerc: p.home_perc,
    awayPerc: p.away_perc,
    expHome: p.exp_home_score,
    expAway: p.exp_away_score,
    isFinished: p.is_finished,
    hasPrediction: p.has_prediction,
    logoUrl: nrlLogoUrl,
  };
}

function adaptNfl(p) {
  return {
    sport: 'nfl',
    date: p.date,
    homeTeam: p.home_team,
    awayTeam: p.away_team,
    homeScore: p.home_score,
    awayScore: p.away_score,
    homePerc: p.home_perc,
    awayPerc: p.away_perc,
    tiePerc: p.tie_perc,
    expHome: p.exp_home_score,
    expAway: p.exp_away_score,
    isFinished: p.is_finished,
    hasPrediction: p.has_prediction,
    logoUrl: nflLogoUrl,
  };
}

function dayLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

async function fetchUpcoming(sport, path, adapter) {
  try {
    const res = await fetch(apiUrl(sport, path));
    if (!res.ok) return [];
    const json = await res.json();
    return (json.predictions || []).map(adapter);
  } catch {
    return [];
  }
}

async function loadUpcomingFeed() {
  const feed = document.getElementById('upcoming-feed');
  if (!feed) return;

  const [nrlEntries, nflEntries] = await Promise.all([
    fetchUpcoming('nrl', 'upcoming_predictions?days=7', adaptNrl),
    fetchUpcoming('nfl', 'upcoming_predictions?days=7', adaptNfl),
  ]);

  const entries = [...nrlEntries, ...nflEntries]
    .filter(e => e.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

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
