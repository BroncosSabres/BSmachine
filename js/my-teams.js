// my-teams.js — the teams a user follows, per competition. Shared by the header
// match ticker, the My Teams picker modal and every predictions page.
//
// Signed-in users' picks live on profiles.my_teams / profiles.ticker_my_teams_only
// (see nrl-flask-backend/supabase_my_teams_schema.sql). A localStorage mirror
// gives an instant first paint and lets guests pick teams too; picks a guest
// made are copied onto their profile the first time they sign in.
import { teamSlug } from './utils.js';
import { apiUrl } from './api-config.js';
import { nflLogoUrl } from './nfl-logos.js';
import { nhlLogoUrl } from './nhl-logos.js';

export const MY_TEAMS_SPORTS = ['nrl', 'nrlw', 'nfl', 'nhl'];
export const MY_TEAMS_CHANGED = 'bsm:myteams-changed';

const LOCAL_KEY = 'bsm_my_teams';

// owner: the user id these picks were loaded from/saved to, or null for guest
// picks. Only guest picks are pushed to a profile on sign-in, so a shared
// browser never copies one account's teams into another's.
function normalize(raw) {
  const teams = {};
  MY_TEAMS_SPORTS.forEach(sport => {
    const list = raw?.teams?.[sport];
    teams[sport] = Array.isArray(list) ? [...new Set(list.filter(t => typeof t === 'string' && t))] : [];
  });
  return {
    teams,
    tickerMyTeamsOnly: !!raw?.tickerMyTeamsOnly,
    owner: raw?.owner ?? null,
  };
}

function readLocal() {
  try {
    return normalize(JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null'));
  } catch {
    return normalize(null);
  }
}

function writeLocal(prefs) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(prefs)); } catch { /* blocked — in-memory only */ }
}

let state = readLocal();

function sameTeams(a, b) {
  return JSON.stringify(a.teams) === JSON.stringify(b.teams) && a.tickerMyTeamsOnly === b.tickerMyTeamsOnly;
}

function setState(next) {
  const changed = !sameTeams(state, next);
  state = next;
  writeLocal(state);
  if (changed) window.dispatchEvent(new CustomEvent(MY_TEAMS_CHANGED, { detail: state }));
}

// NRL/NRLW names vary between sources ("Broncos" vs "Brisbane Broncos"), so they
// match on the logo slug; NFL/NHL names are consistent full names.
export function teamKey(sport, name) {
  if (!name) return '';
  return sport === 'nrl' || sport === 'nrlw' ? teamSlug(name) : String(name).trim().toLowerCase();
}

export function teamLogoUrl(sport, name) {
  if (sport === 'nfl') return nflLogoUrl(name);
  if (sport === 'nhl') return nhlLogoUrl(name);
  return `/logos/${teamSlug(name)}.svg`;
}

// Synchronous snapshot — whatever is known right now (local mirror until
// loadMyTeams() resolves).
export function getMyTeams() {
  return state;
}

export function hasAnyTeams(prefs = state) {
  return MY_TEAMS_SPORTS.some(s => prefs.teams[s].length > 0);
}

export function isMyTeam(sport, name) {
  const key = teamKey(sport, name);
  return !!key && (state.teams[sport] || []).some(t => teamKey(sport, t) === key);
}

export function involvesMyTeam(sport, home, away) {
  return isMyTeam(sport, home) || isMyTeam(sport, away);
}

// Comparator for predictions-page cards carrying data-home / data-away /
// data-order (kickoff order): My Teams' games first, kickoff order within each group.
export function myTeamsFirst(sport) {
  return (a, b) => {
    const ma = involvesMyTeam(sport, a.dataset.home, a.dataset.away) ? 0 : 1;
    const mb = involvesMyTeam(sport, b.dataset.home, b.dataset.away) ? 0 : 1;
    return ma - mb || Number(a.dataset.order ?? 0) - Number(b.dataset.order ?? 0);
  };
}

// supabase-client pulls the SDK from a CDN; load it lazily so a CDN hiccup
// only costs profile sync, not the ticker.
async function supabaseSession() {
  try {
    const mod = await import('./supabase-client.js');
    const session = await mod.getSession();
    return session ? { supabase: mod.supabase, userId: session.user.id } : null;
  } catch {
    return null;
  }
}

export async function isSignedIn() {
  return !!(await supabaseSession());
}

let loadPromise = null;

// Resolves once the signed-in user's profile has been merged in (or straight
// away for guests). Fires MY_TEAMS_CHANGED if the profile differed from the mirror.
export function loadMyTeams() {
  loadPromise ??= (async () => {
    const auth = await supabaseSession();
    if (!auth) return state;
    const { data, error } = await auth.supabase
      .from('profiles')
      .select('my_teams, ticker_my_teams_only')
      .eq('id', auth.userId)
      .maybeSingle();
    if (error || !data) return state;

    const remote = normalize({
      teams: data.my_teams,
      tickerMyTeamsOnly: data.ticker_my_teams_only,
      owner: auth.userId,
    });
    if (!hasAnyTeams(remote) && hasAnyTeams(state) && state.owner == null) {
      // First sign-in after picking teams as a guest — keep them.
      const next = { ...state, owner: auth.userId };
      await auth.supabase
        .from('profiles')
        .update({ my_teams: next.teams, ticker_my_teams_only: next.tickerMyTeamsOnly })
        .eq('id', auth.userId);
      setState(next);
    } else {
      setState(remote);
    }
    return state;
  })();
  return loadPromise;
}

// Saves to the local mirror immediately (so the UI updates at once), then to
// the profile when signed in. Returns { ok, signedIn }.
export async function saveMyTeams({ teams, tickerMyTeamsOnly }) {
  const auth = await supabaseSession();
  const next = normalize({ teams, tickerMyTeamsOnly, owner: auth?.userId ?? null });
  setState(next);
  if (!auth) return { ok: true, signedIn: false };
  const { error } = await auth.supabase
    .from('profiles')
    .update({ my_teams: next.teams, ticker_my_teams_only: next.tickerMyTeamsOnly })
    .eq('id', auth.userId);
  return { ok: !error, signedIn: true };
}

export function setTickerMyTeamsOnly(on) {
  return saveMyTeams({ teams: state.teams, tickerMyTeamsOnly: on });
}

// Every team in a competition, for the picker — taken from the latest power
// rankings (which always list the full league). Cached for the session.
const TEAM_LIST_PATH = {
  nrl:  ['nrl', 'power_rankings'],
  nrlw: ['nrl', 'power_rankings/nrlw'],
  nfl:  ['nfl', 'power_rankings'],
  nhl:  ['nhl', 'power_rankings'],
};

export async function fetchTeamList(sport) {
  const cacheKey = `bsm_team_list_${sport}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    if (Array.isArray(cached) && cached.length) return cached;
  } catch { /* ignore */ }

  try {
    const res = await fetch(apiUrl(...TEAM_LIST_PATH[sport]));
    if (!res.ok) return [];
    const json = await res.json();
    const names = [...new Set((json.rankings || []).map(r => r.team).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    try { sessionStorage.setItem(cacheKey, JSON.stringify(names)); } catch { /* ignore */ }
    return names;
  } catch {
    return [];
  }
}
