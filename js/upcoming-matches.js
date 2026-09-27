// upcoming-matches.js — fetches and normalizes every competition's upcoming
// matches into one sorted list. Shared by the header match ticker (every page)
// and the homepage "Next 7 Days" feed, and cached in sessionStorage so page
// navigation doesn't re-hit the backend (which caches these for 300s anyway).
import { apiUrl } from './api-config.js';
import { teamSlug } from './utils.js';
import { nflLogoUrl } from './nfl-logos.js';
import { nhlLogoUrl } from './nhl-logos.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

const LOGO_URL = {
  nrl:  name => `/logos/${teamSlug(name)}.svg`,
  nrlw: name => `/logos/${teamSlug(name)}.svg`,
  nfl:  nflLogoUrl,
  nhl:  nhlLogoUrl,
};

function adapt(sport, p) {
  return {
    sport,
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
    matchId: p.match_id,
    gameId: p.game_id,
    weekNumber: p.week_number,
  };
}

// logoUrl is a function, so it can't survive the JSON cache — attach it after.
function withLogo(entry) {
  return { ...entry, logoUrl: LOGO_URL[entry.sport] };
}

async function fetchUpcoming(sport, apiSport, path) {
  try {
    const res = await fetch(apiUrl(apiSport, path));
    if (!res.ok) return [];
    const json = await res.json();
    return (json.predictions || []).map(p => adapt(sport, p));
  } catch {
    return [];
  }
}

function readCache(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { at, entries } = JSON.parse(raw);
    return Date.now() - at < CACHE_TTL_MS ? entries : null;
  } catch {
    return null;
  }
}

function writeCache(key, entries) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), entries }));
  } catch { /* storage full or blocked — just skip caching */ }
}

const inflight = {};

// All competitions' matches in the next `days` days, sorted by kickoff.
export function fetchAllUpcoming(days = 7) {
  const key = `bsm_upcoming_${days}`;
  const cached = readCache(key);
  if (cached) return Promise.resolve(cached.map(withLogo));

  // The ticker and homepage feed ask at the same time — share one request.
  inflight[key] ??= Promise.all([
    fetchUpcoming('nrl',  'nrl', `upcoming_predictions?days=${days}`),
    fetchUpcoming('nrlw', 'nrl', `upcoming_predictions/nrlw?days=${days}`),
    fetchUpcoming('nfl',  'nfl', `upcoming_predictions?days=${days}`),
    fetchUpcoming('nhl',  'nhl', `upcoming_predictions?days=${days}`),
  ]).then(lists => {
    const entries = lists.flat()
      .filter(e => e.date)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    // Don't cache an all-empty result — likely a cold/unreachable backend.
    if (entries.length) writeCache(key, entries);
    delete inflight[key];
    return entries;
  });

  return inflight[key].then(entries => entries.map(withLogo));
}
