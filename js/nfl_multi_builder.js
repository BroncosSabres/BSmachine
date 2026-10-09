// nfl_multi_builder.js — drives nfl/pages/tryscorer_predictions.html ("Multi Builder")
// NFL counterpart to js/tryscorer_predictions.js (same layout: team cards with
// anytime prices + steppers, line selectors, betslip, community strip). No crowd
// blend (no crowd picks exist for NFL).
//
// Lines (margin / total / team points) filter nfl.game_sgm_bins joint score
// distributions (/api/nfl/game_sgm_bins_range). Player legs — anytime TD, QB
// passing TDs, kicker FGs, team D/ST TD, each any N+ — come from
// /api/nfl/game_player_data (per-player shares of team TDs, see
// nrl-flask-backend/nfl_player_model.py) and are combined with each bin's own
// TD/FG count distributions, so they stay correlated with the lines.
// Yards legs (QB passing, rushing, receiving — any N+ yards) are priced per
// bin too: team yards conditional on the bin's points / margin and the TD
// count, shared by every yards leg on that team, and each player's yards
// conditional on the TDs credited to him (see the yards engine below).
// Selections are kept per game; the betslip multiplies across games like NRL.
import { apiUrl, BACKEND } from './api-config.js';
import { nflLogoUrl } from './nfl-logos.js';
import { getSession } from './supabase-client.js';
import { nflWeatherLabel } from './nfl-weather.js';

const $ = id => document.getElementById(id);

const weekBadge      = $('week-badge');
const weekPrevBtn    = $('week-prev');
const weekNextBtn    = $('week-next');
const gameSelect     = $('game-select');
const noGamesMsg     = $('no-games-msg');
const builderSection = $('builder-section');
const builderMatchup = $('builder-matchup');
const builderKickoff = $('builder-kickoff');
const teamsContainer = $('teams-container');
const marketTabs     = $('market-tabs');
const resultDiv      = $('result');
const resetMatchBtn  = $('reset-match-btn');
const resetAllBtn    = $('reset-all-btn');

const marginDirHome  = $('margin-dir-home');
const marginDirAway  = $('margin-dir-away');
const marginValSel   = $('margin-val');
const marginClearBtn = $('margin-clear');

let currentWeek  = null;
let games        = [];
let currentGame  = null;
const binsCache  = {};   // game_id -> bins[] (with per-bin h_td/a_td/h_fg/a_fg)
const gameState  = {};   // game_id -> per-game selections, see newGameState()
let betslipExpanded = false;
let bookieOdds   = null;

const MAX_N = { anytime: 4, pass_td: 6, fg: 5, dst_td: 3 };
const TOP_N = 10;              // anytime options listed before "Show more" (D/ST always among them)
const EXCLUDED = ['out', 'inactive', 'ir'];

// Market tabs: the team cards show one market at a time. Picks in the other
// tabs stay on the betslip. yards: hidden when the yards model isn't available.
const MARKETS = [
  { id: 'td',      tab: 'TD Scorer',     kinds: ['anytime', 'dst_td'] },
  { id: 'pass',    tab: 'QB Passing',    kinds: ['pass_td', 'pass_yds'] },
  { id: 'rush',    tab: 'Rushing Yds',   kinds: ['rush_yds'], yards: true },
  { id: 'rec',     tab: 'Receiving Yds', kinds: ['rec_yds'], yards: true },
  { id: 'fg',      tab: 'Field Goals',   kinds: ['fg'] },
];
let market = 'td';

function newGameState(gid) {
  return {
    gameId: gid,
    lines: { marginTeam: null, marginL: null, totalDir: null, totalN: null,
             homeTotalDir: null, homeTotalN: null, awayTotalDir: null, awayTotalN: null },
    picks: new Map(),          // key -> { side, kind, playerId, teamId, name, n } (n = yardage line for yards legs)
    out: new Set(), in: new Set(),
    showAll: {},               // `${market}:${side}` -> "Show more" expanded
    playerData: null,          // /api/nfl/game_player_data for this game's overrides
    teamDists: null,           // { home: {td, fg}, away: {td, fg} } — whole-game mixtures
    yardsCache: new Map(),     // whole-game yards prices / expectations for this playerData
    loadSeq: 0,                // drops stale game_player_data responses
  };
}
const S = (gid = currentGame?.game_id) => (gameState[gid] ||= newGameState(gid));
const gameById = gid => games.find(g => String(g.game_id) === String(gid));

// --- FORMATTING ---
const pct  = p => (p == null ? '–' : `${(p * 100).toFixed(1)}%`);
const odds = p => (p > 1e-6 ? `$${(1 / p).toFixed(2)}` : '–');
const esc  = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function lineToN(L) { return Math.floor(-L) + 1; }

// =============================================================================
// PROBABILITY ENGINE (mirrors nfl_player_model.build_atoms / pick_success_by_n)
// =============================================================================
// Every team TD is exactly one of: a D/ST TD, a rush TD by player i, or a pass TD
// from the starting QB to receiver r. A pass TD credits the receiver's anytime
// pick AND the QB's pass-TD pick — never the QB's anytime pick. Shares are
// conditional on the player playing: picked players are assumed to play (bets on
// a player who sits out are void); everyone else is weighted by p_play.
function buildAtoms(team, teamPicks) {
  const dst = team.dst_frac, pf = team.pass_frac, qbId = team.starting_qb_id;
  const pickedIds = new Set(teamPicks.filter(p => p.playerId != null).map(p => p.playerId));
  const atoms = new Map();
  let used = 0;
  // Yards picks are credited with the TDs that carry yards for them: a QB's
  // passing-yards pick with his pass TDs, rushing / receiving yards with the
  // player's own rush / receiving TDs.
  const add = (scorerId, passerId, isDst, p, isPass = false) => {
    if (p <= 0) return;
    const cred = [];
    teamPicks.forEach((pk, i) => {
      const k = pk.kind;
      if (k === 'dst_td' && isDst) cred.push(i);
      else if (k === 'anytime' && scorerId != null && pk.playerId === scorerId) cred.push(i);
      else if ((k === 'pass_td' || k === 'pass_yds') && passerId != null && pk.playerId === passerId) cred.push(i);
      else if (k === 'rush_yds' && !isPass && scorerId != null && pk.playerId === scorerId) cred.push(i);
      else if (k === 'rec_yds' && isPass && scorerId != null && pk.playerId === scorerId) cred.push(i);
    });
    const key = cred.join(',');
    const a = atoms.get(key) || { p: 0, cred };
    a.p += p;
    atoms.set(key, a);
    used += p;
  };
  add(null, null, true, dst);
  for (const pl of team.players) {
    if (!pl.active) continue;
    const w = pickedIds.has(pl.id) ? 1 : (pl.p_play ?? 1);
    add(pl.id, null, false, (1 - dst) * (1 - pf) * pl.rush_share * w);
    add(pl.id, qbId, false, (1 - dst) * pf * pl.rec_share * w, true);
  }
  const list = [...atoms.values()];
  if (used < 1) list.push({ p: 1 - used, cred: [] });
  else if (used > 1) list.forEach(a => { a.p /= used; });
  return list;
}

// S[n] = P(every pick reaches its min | team scores n TDs); DP with counts capped at mins.
function pickSuccessByN(atoms, mins, maxN) {
  const target = mins.join(',');
  let state = new Map([[mins.map(() => 0).join(','), 1]]);
  const out = [];
  for (let n = 0; n <= maxN; n++) {
    out.push(state.get(target) || 0);
    if (n === maxN) break;
    const next = new Map();
    for (const [key, sp] of state) {
      const st = key.split(',').map(Number);
      for (const { p, cred } of atoms) {
        let k2 = key;
        if (cred.length) {
          const s2 = st.slice();
          for (const i of cred) if (s2[i] < mins[i]) s2[i]++;
          k2 = s2.join(',');
        }
        next.set(k2, (next.get(k2) || 0) + sp * p);
      }
    }
    state = next;
  }
  return out;
}

function atLeast(arr, k) {
  let s = 0;
  for (let n = k; n < arr.length; n++) s += arr[n] || 0;
  return s;
}

function binomAtLeast(n, p, k) {
  if (k <= 0) return 1;
  if (n < k) return 0;
  let below = 0, c = 1;
  for (let j = 0; j < k; j++) {
    below += c * Math.pow(p, j) * Math.pow(1 - p, n - j);
    c = c * (n - j) / (j + 1);
  }
  return Math.max(0, 1 - below);
}

function mixtureDist(bins, key) {
  const total = bins.reduce((s, b) => s + (b.c || 0), 0) || 1;
  const out = [];
  for (const b of bins) {
    (b[key] || [1]).forEach((p, n) => { out[n] = (out[n] || 0) + p * b.c / total; });
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i] || 0;
  return out;
}

// --- yards legs (mirrors nfl_player_model.py '--- yards', checked by
// nrl-flask-backend/tests/test_nfl_js_mirror.py) ---
// Conditional on each sim bin (team points + margin) and the team's TD count:
// team yards (log pass, log rush) ~ correlated normal with mean
// base(n, points - 7n, margin, weather) × exp(adj); player yards ~ gamma
// (fixed scale) with mean beta_share × share × team yards + beta_td × his
// credited TDs. Every yards pick on a team shares its team yards.
const YARDS_KINDS = new Set(['pass_yds', 'rush_yds', 'rec_yds']);
const YARDS_TEAM_KIND = { pass_yds: 'pass', rec_yds: 'pass', rush_yds: 'rush' };
const GH_X = [-4.1445471861258945, -2.8024858612875416, -1.636519042435108, -0.5390798113513751,
  0.5390798113513751, 1.636519042435108, 2.8024858612875416, 4.1445471861258945];
const GH_W = [0.00011261453837536762, 0.009635220120788256, 0.11723990766175904, 0.3730122576790773,
  0.3730122576790773, 0.11723990766175904, 0.009635220120788256, 0.00011261453837536762];
const LANCZOS = [76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];

function lgamma(x) {
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of LANCZOS) { y += 1; ser += c / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// Regularised upper incomplete gamma Q(a, x)
function gammaQ(a, x) {
  if (x <= 0) return 1;
  const gln = lgamma(a);
  if (x < a + 1) {
    let ap = a, s = 1 / a, d = s;
    for (let k = 0; k < 1000; k++) {
      ap += 1; d *= x / ap; s += d;
      if (Math.abs(d) < Math.abs(s) * 1e-12) break;
    }
    return Math.max(0, 1 - s * Math.exp(-x + a * Math.log(x) - gln));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-12) break;
  }
  return Math.min(1, Math.exp(-x + a * Math.log(x) - gln) * h);
}

function gammaSf(x, mean, shape) {
  if (x <= 0) return 1;
  if (mean <= 0) return 0;
  return gammaQ(shape, x * shape / mean);
}

function teamYardsBase(tp, kind, n, points, margin, terms) {
  const c = tp[kind].coef, clip = tp.margin_clip;
  const m = Math.min(Math.max(margin, -clip), clip);
  let mu = c.intercept + c.td * n + c.other_pts * (points - 7 * n)
    + c.trail * Math.min(m, 0) + c.lead * Math.max(m, 0);
  for (const t of terms) mu += c[t] || 0;
  return Math.max(mu, tp.floor);
}

function pickYardsShare(yp, kind, pl) {
  if (kind === 'pass_yds') return pl.is_starting_qb ? yp.player.pass_yds.share : 0;
  return kind === 'rush_yds' ? pl.rush_yds_share : pl.rec_yds_share;
}

function yardsPickSpec(yp, kind, pos, share) {
  const pp = yp.player[kind];
  return [pp.beta_share * share, pp.beta_td, pp.scale[pos] ?? pp.scale.default];
}

// w[c][y] = P(player yards >= line | team yards y, c credited TDs), y = 0..grid max
function yardsWeightTable(yp, kind, pos, share, line) {
  const [a, b, scale] = yardsPickSpec(yp, kind, pos, share);
  const yMax = yp.grid_max[YARDS_TEAM_KIND[kind]];
  const out = [];
  for (let c = 0; c <= yp.td_cap; c++) {
    const row = new Array(yMax + 1);
    for (let y = 0; y <= yMax; y++) {
      const mean = a * y + b * c;
      row[y] = gammaSf(line - 0.5, mean, mean / scale);
    }
    out.push(row);
  }
  return out;
}

function interp(row, y) {
  if (y <= 0) return row[0];
  const top = row.length - 1;
  if (y >= top) return row[top];
  const i = Math.floor(y), f = y - i;
  return row[i] + f * (row[i + 1] - row[i]);
}

// [[weight, Y_pass, Y_rush]] quadrature over the team's lognormal yards
function teamYardsNodes(yp, muPass, muRush, needPass, needRush) {
  const tp = yp.team, sp = tp.pass.sigma, sr = tp.rush.sigma, rho = tp.rho;
  const lp = needPass ? Math.log(muPass) - sp * sp / 2 : 0;
  const lr = needRush ? Math.log(muRush) - sr * sr / 2 : 0;
  const out = [];
  if (needPass && needRush) {
    const q = Math.sqrt(1 - rho * rho);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      out.push([GH_W[i] * GH_W[j], Math.exp(lp + sp * GH_X[i]), Math.exp(lr + sr * (rho * GH_X[i] + q * GH_X[j]))]);
    }
  } else if (needPass) {
    for (let i = 0; i < 8; i++) out.push([GH_W[i], Math.exp(lp + sp * GH_X[i]), 0]);
  } else {
    for (let i = 0; i < 8; i++) out.push([GH_W[i], 0, Math.exp(lr + sr * GH_X[i])]);
  }
  return out;
}

// pickSuccessByN's DP, keeping the states: for n = 0..maxN, Map(state -> p)
function pickStatesByN(atoms, mins, maxN) {
  let state = new Map([[mins.map(() => 0).join(','), 1]]);
  const out = [state];
  for (let n = 0; n < maxN; n++) {
    const next = new Map();
    for (const [key, sp] of state) {
      const st = key.split(',').map(Number);
      for (const { p, cred } of atoms) {
        let k2 = key;
        if (cred.length) {
          const s2 = st.slice();
          for (const i of cred) if (s2[i] < mins[i]) s2[i]++;
          k2 = s2.join(',');
        }
        next.set(k2, (next.get(k2) || 0) + sp * p);
      }
    }
    state = next;
    out.push(state);
  }
  return out;
}

// DP states -> per n, Map(c-vector of the yards picks -> p), only states
// where every other pick reached its minimum.
function yardsKeyDists(statesByN, picks, yardIdx) {
  const others = picks.map((_, i) => i).filter(i => !yardIdx.includes(i));
  return statesByN.map(state => {
    const d = new Map();
    for (const [key, sp] of state) {
      const st = key.split(',').map(Number);
      if (!others.every(i => st[i] >= picks[i].n)) continue;
      const k = yardIdx.map(i => st[i]);
      const ks = k.join(',');
      const e = d.get(ks) || { c: k, p: 0 };
      e.p += sp;
      d.set(ks, e);
    }
    return d;
  });
}

// One team's legs priced inside one sim bin (TD legs + yards legs).
function sideYardsFactor(yp, ctx, keyDists, tdDist, tables, kinds, points, margin) {
  const tp = yp.team;
  const needP = kinds.some(k => YARDS_TEAM_KIND[k] === 'pass');
  const needR = kinds.some(k => YARDS_TEAM_KIND[k] === 'rush');
  let total = 0;
  tdDist.forEach((pn, n) => {
    if (!pn || n >= keyDists.length || !keyDists[n].size) return;
    const muP = needP ? teamYardsBase(tp, 'pass', n, points, margin, ctx.terms) * Math.exp(ctx.adj_pass) : 0;
    const muR = needR ? teamYardsBase(tp, 'rush', n, points, margin, ctx.terms) * Math.exp(ctx.adj_rush) : 0;
    const nodes = teamYardsNodes(yp, muP, muR, needP, needR);
    let s = 0;
    for (const { c, p } of keyDists[n].values()) {
      let e = 0;
      for (const [w, yP, yR] of nodes) {
        let f = w;
        for (let i = 0; i < kinds.length; i++) f *= interp(tables[i][c[i]], YARDS_TEAM_KIND[kinds[i]] === 'pass' ? yP : yR);
        e += f;
      }
      s += p * e;
    }
    total += pn * s;
  });
  return total;
}

// Everything bin-independent for one team's legs: returns (bin, side) -> factor.
// teamPicks use { kind, playerId, n } (n = TD count, or the yardage line).
function sidePricer(yp, team, ctx, teamPicks, maxN) {
  const yardIdx = teamPicks.map((p, i) => (YARDS_KINDS.has(p.kind) ? i : -1)).filter(i => i >= 0);
  const mins = teamPicks.map((p, i) => (yardIdx.includes(i) ? yp.td_cap : p.n));
  const states = pickStatesByN(buildAtoms(team, teamPicks), mins, maxN);
  const byId = new Map(team.players.map(p => [p.id, p]));
  const kinds = yardIdx.map(i => teamPicks[i].kind);
  const tables = yardIdx.map(i => {
    const pl = byId.get(teamPicks[i].playerId);
    return yardsWeightTable(yp, teamPicks[i].kind, pl.pos, pickYardsShare(yp, teamPicks[i].kind, pl), teamPicks[i].n);
  });
  const keyDists = yardsKeyDists(states, teamPicks, yardIdx);
  return (b, side) => {
    const margin = side === 'home' ? b.m : -b.m;
    return sideYardsFactor(yp, ctx, keyDists, b[side === 'home' ? 'h_td' : 'a_td'] || [1], tables, kinds,
                           (b.t + margin) / 2, margin);
  };
}

// Count-weighted price of one team's legs over a set of bins (mirrors
// nfl_player_model.side_bin_probability).
function sideBinProbability(yp, team, ctx, teamPicks, bins, side) {
  const key = side === 'home' ? 'h_td' : 'a_td';
  const maxN = Math.max(0, ...bins.map(b => (b[key] || [1]).length - 1));
  const price = sidePricer(yp, team, ctx, teamPicks, maxN);
  let num = 0, den = 0;
  for (const b of bins) { num += b.c * price(b, side); den += b.c; }
  return den ? num / den : 0;
}

const yardsReady = gs => !!(gs.playerData?.yards_params && gs.playerData.home?.yards && gs.playerData.away?.yards);

// Whole-game price of one yards leg (no lines), cached per player data + bins.
function singleYardsProb(gs, side, kind, pl, line) {
  const bins = binsCache[gs.gameId];
  if (!bins?.length || !yardsReady(gs) || !pl) return null;
  const key = `${side}:${kind}:${pl.id}:${line}`;
  if (gs.yardsCache.has(key)) return gs.yardsCache.get(key);
  const team = gs.playerData[side];
  const p = sideBinProbability(gs.playerData.yards_params, team, team.yards,
                               [{ kind, playerId: pl.id, n: line }], bins, side);
  gs.yardsCache.set(key, p);
  return p;
}

// Expected yards if he plays: E[beta_share x share x Y + beta_td x credited TDs]
function expectedYards(gs, side, kind, pl) {
  const bins = binsCache[gs.gameId];
  if (!bins?.length || !yardsReady(gs) || !pl) return null;
  const key = `exp:${side}:${kind}:${pl.id}`;
  if (gs.yardsCache.has(key)) return gs.yardsCache.get(key);
  const yp = gs.playerData.yards_params, team = gs.playerData[side], ctx = team.yards;
  const [a, b] = yardsPickSpec(yp, kind, pl.pos, pickYardsShare(yp, kind, pl));
  const atom = kind === 'pass_yds' ? pl.pass_td_share
    : (1 - team.dst_frac) * (kind === 'rush_yds' ? (1 - team.pass_frac) * pl.rush_share : team.pass_frac * pl.rec_share);
  const tk = YARDS_TEAM_KIND[kind];
  let num = 0, den = 0;
  for (const bn of bins) {
    const margin = side === 'home' ? bn.m : -bn.m, points = (bn.t + margin) / 2;
    (bn[side === 'home' ? 'h_td' : 'a_td'] || [1]).forEach((pn, n) => {
      if (!pn) return;
      const mu = teamYardsBase(yp.team, tk, n, points, margin, ctx.terms) * Math.exp(tk === 'pass' ? ctx.adj_pass : ctx.adj_rush);
      num += bn.c * pn * (a * mu + b * Math.min(n * atom, yp.td_cap));
    });
    den += bn.c;
  }
  const e = den ? num / den : null;
  gs.yardsCache.set(key, e);
  return e;
}

// Default line: the multiple of 5 whose price is closest to even money.
function defaultYardsLine(gs, side, kind, pl) {
  const e = expectedYards(gs, side, kind, pl);
  if (e == null) return null;
  const p = L => singleYardsProb(gs, side, kind, pl, L);
  let lo = Math.max(5, Math.round(e / 5) * 5);
  if (p(lo) < 0.5) { while (lo > 5 && p(lo) < 0.5) lo -= 5; }
  else { while (p(lo + 5) >= 0.5) lo += 5; }
  // lo now has P >= 0.5 (or is 5); lo + 5 has P < 0.5
  return Math.abs(p(lo) - 0.5) <= Math.abs(p(lo + 5) - 0.5) ? lo : lo + 5;
}

// Median yards if he plays: the largest N with P(N+) >= 0.5. Yards are right-
// skewed (mean above median), so this — not the mean — is the even-money line.
// Bisects inside the 5-yard bracket defaultYardsLine already priced.
function medianYards(gs, side, kind, pl) {
  const d = defaultYardsLine(gs, side, kind, pl);
  if (d == null) return null;
  const p = L => singleYardsProb(gs, side, kind, pl, L);
  let lo = p(d) >= 0.5 ? d : d - 5, hi = lo + 5;   // p(lo) >= 0.5 > p(hi), lo may be 0
  if (lo <= 0) { lo = 0; hi = 5; }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p(mid) >= 0.5) lo = mid; else hi = mid;
  }
  return lo;
}

// Per-TD atom probability for a single leg (FG legs read the team FG dist instead).
function legAtomP(team, kind, player) {
  if (kind === 'anytime') return player.td_share;
  if (kind === 'pass_td') return player.pass_td_share;
  if (kind === 'dst_td')  return team.dst_frac;
  return 0;
}

// Unconditional single-leg probability (whole game, no lines) — the table prices.
function singleLegProb(gs, side, kind, player, n) {
  if (YARDS_KINDS.has(kind)) return singleYardsProb(gs, side, kind, player, n);
  if (!gs.teamDists || !gs.playerData) return null;
  const d = gs.teamDists[side];
  if (kind === 'fg') return atLeast(d.fg, n);
  const p = legAtomP(gs.playerData[side], kind, player);
  let s = 0;
  d.td.forEach((pn, k) => { s += pn * binomAtLeast(k, p, n); });
  return s;
}

// --- LINES ---
function buildConstraints(L) {
  let margin = null, total = null, homeTotal = null, awayTotal = null;
  if (L.marginTeam && L.marginL != null) {
    const N1 = lineToN(L.marginL);  // margin (home - away) >= N1 for home, <= -N1 for away
    margin = L.marginTeam === 'home' ? { type: 'over', val: N1 } : { type: 'under', val: 1 - N1 };
  }
  if (L.totalDir && L.totalN != null) total = { type: L.totalDir, val: L.totalN };
  if (L.homeTotalDir && L.homeTotalN != null) homeTotal = { type: L.homeTotalDir, val: L.homeTotalN };
  if (L.awayTotalDir && L.awayTotalN != null) awayTotal = { type: L.awayTotalDir, val: L.awayTotalN };
  return { margin, total, homeTotal, awayTotal };
}

function filterBins(bins, c) {
  return bins.filter(b => {
    if (c.margin?.type === 'over'  && b.m < c.margin.val)  return false;
    if (c.margin?.type === 'under' && b.m >= c.margin.val) return false;
    if (c.total?.type  === 'over'  && b.t < c.total.val)   return false;
    if (c.total?.type  === 'under' && b.t >= c.total.val)  return false;
    const hs = (b.m + b.t) / 2, as_ = (b.t - b.m) / 2;
    if (c.homeTotal?.type === 'over'  && hs  <  c.homeTotal.val) return false;
    if (c.homeTotal?.type === 'under' && hs  >= c.homeTotal.val) return false;
    if (c.awayTotal?.type === 'over'  && as_ <  c.awayTotal.val) return false;
    if (c.awayTotal?.type === 'under' && as_ >= c.awayTotal.val) return false;
    return true;
  });
}

function lineLabels(game, L) {
  const out = [];
  if (L.marginTeam && L.marginL != null) {
    const team = L.marginTeam === 'home' ? game.home_team : game.away_team;
    out.push(L.marginL === -0.5 ? `${team} To Win` : `${team} ${L.marginL < 0 ? '' : '+'}${L.marginL}`);
  }
  if (L.totalDir && L.totalN != null) out.push(`Total ${L.totalDir === 'over' ? 'Over' : 'Under'} ${L.totalN - 0.5}`);
  if (L.homeTotalDir && L.homeTotalN != null) out.push(`${game.home_team} ${L.homeTotalDir === 'over' ? 'Over' : 'Under'} ${L.homeTotalN - 0.5}`);
  if (L.awayTotalDir && L.awayTotalN != null) out.push(`${game.away_team} ${L.awayTotalDir === 'over' ? 'Over' : 'Under'} ${L.awayTotalN - 0.5}`);
  return out;
}

function legLabel(kind, name, n) {
  switch (kind) {
    case 'anytime': return n === 1 ? `${name} Anytime TD` : `${name} ${n}+ TDs`;
    case 'pass_td': return `${name} ${n}+ Pass TD${n > 1 ? 's' : ''}`;
    case 'dst_td':  return `${name} D/ST ${n}+ TD${n > 1 ? 's' : ''}`;
    case 'fg':      return `${name} ${n}+ FG${n > 1 ? 's' : ''} Made`;
    case 'pass_yds': return `${name} ${n}+ Passing Yds`;
    case 'rush_yds': return `${name} ${n}+ Rushing Yds`;
    case 'rec_yds':  return `${name} ${n}+ Receiving Yds`;
  }
  return name;
}

// Joint probability of one game's line filters + player legs, bin by bin.
function gameProbability(gid) {
  const gs = S(gid), bins = binsCache[gid];
  if (!bins?.length) return null;
  const totalCount = bins.reduce((s, b) => s + (b.c || 0), 0) || 1;
  const filtered = filterBins(bins, buildConstraints(gs.lines));
  const lineProb = filtered.reduce((s, b) => s + b.c, 0) / totalCount;
  const perSide = {};
  for (const side of ['home', 'away']) {
    const team = gs.playerData?.[side];
    const sidePicks = [...gs.picks.values()].filter(p => p.side === side);
    const tdPicks = sidePicks.filter(p => p.kind !== 'fg');
    const fgMin = Math.max(0, ...sidePicks.filter(p => p.kind === 'fg').map(p => p.n));
    let Sn = null, pricer = null;
    if (tdPicks.length && team) {
      const key = side === 'home' ? 'h_td' : 'a_td';
      const maxN = Math.max(0, ...filtered.map(b => (b[key] || [1]).length - 1));
      if (tdPicks.some(p => YARDS_KINDS.has(p.kind))) {
        // Yards legs depend on each bin's points / margin, so they're priced per bin
        if (!yardsReady(gs)) return null;
        pricer = sidePricer(gs.playerData.yards_params, team, team.yards, tdPicks, maxN);
      } else {
        Sn = pickSuccessByN(buildAtoms(team, tdPicks), tdPicks.map(p => p.n), maxN);
      }
    }
    perSide[side] = { Sn, pricer, fgMin };
  }
  let num = 0;
  for (const b of filtered) {
    let f = b.c || 0;
    for (const side of ['home', 'away']) {
      const { Sn, pricer, fgMin } = perSide[side];
      if (pricer) f *= pricer(b, side);
      if (Sn) {
        let s = 0;
        (b[side === 'home' ? 'h_td' : 'a_td'] || [1]).forEach((pn, n) => { s += pn * (Sn[n] || 0); });
        f *= s;
      }
      // Within a bin TD and FG counts are stored as marginals only; treated as
      // independent there (the bin already pins the team's points).
      if (fgMin > 0) f *= atLeast(b[side === 'home' ? 'h_fg' : 'a_fg'] || [1], fgMin);
    }
    num += f;
  }
  return { prob: num / totalCount, lineProb };
}

function gameHasSelections(gid) {
  const gs = gameState[gid];
  return !!gs && (gs.picks.size > 0 || lineLabels(gameById(gid) || {}, gs.lines).length > 0);
}

// =============================================================================
// TEAM CARDS
// =============================================================================
const STATUS_BADGE = {
  questionable: ['Q', 'text-yellow-300 border-yellow-500/40 bg-yellow-500/10', 'Questionable'],
  doubtful:     ['D', 'text-orange-300 border-orange-500/40 bg-orange-500/10', 'Doubtful'],
  out:          ['OUT', 'text-red-300 border-red-500/40 bg-red-500/10', 'Out'],
  inactive:     ['INA', 'text-red-300 border-red-500/40 bg-red-500/10', 'Inactive'],
  ir:           ['IR', 'text-red-300 border-red-500/40 bg-red-500/10', 'Injured reserve'],
};
function stepperHtml(key, val, max) {
  const base = 'w-6 h-6 border rounded flex items-center justify-center text-sm font-bold transition-colors';
  const minus = val > 0 ? `${base} border-red-500 text-red-400 hover:bg-red-500/20` : `${base} border-gray-700 text-gray-600`;
  const plus = val >= max ? `${base} border-gray-700 text-gray-600`
    : val > 0 ? `${base} border-green-500 text-green-400 hover:bg-green-500/20`
              : `${base} border-gray-600 text-gray-400 hover:border-green-400 hover:text-green-400`;
  return `
    <div class="flex items-center gap-1 shrink-0">
      <button type="button" class="${minus}" data-step="-1" data-key="${key}">−</button>
      <span class="w-6 text-center text-sm font-bold text-white select-none">${val}</span>
      <button type="button" class="${plus}" data-step="1" data-key="${key}">+</button>
    </div>`;
}

function priceHtml(p, loading) {
  if (p == null) return loading ? '<span class="bsm-skeleton h-3 w-14 ml-auto block"></span>'
                                : '<div class="text-xs font-semibold text-gray-400">–</div>';
  return `<div class="text-xs font-semibold text-gray-300">${pct(p)}</div><div class="text-xs text-gray-400">${odds(p)}</div>`;
}

// --- history under each row: per-game average (yards: median) over the last 10
// games played, the previous season and his career (D/ST: since 2020); with a
// pick, also how often he reached it. Values come as {window: [[value, games], ...]}.
const logsCache = {};   // game_id -> /api/nfl/game_player_logs (undefined = loading, null = failed)
const LOG_STAT = { anytime: 'td', dst_td: 'dst', pass_td: 'pass_td', fg: 'fg',
                   pass_yds: 'pass_yds', rush_yds: 'rush_yds', rec_yds: 'rec_yds' };

const histGames = h => h.reduce((s, [, n]) => s + n, 0);
const histAvg = h => h.reduce((s, [v, n]) => s + v * n, 0) / histGames(h);
const histHit = (h, line) => h.reduce((s, [v, n]) => s + (v >= line ? n : 0), 0) / histGames(h);
// Largest N reached in at least half his games — the same definition as the
// model's medianYards, so the two compare like for like.
function histMedian(h) {
  const half = histGames(h) / 2;
  let seen = 0;
  for (const [v, n] of [...h].sort((a, b) => b[0] - a[0])) {
    seen += n;
    if (seen >= half) return v;
  }
  return null;
}

// Model's per-game expectation for a scoring market if he plays — the
// yardstick the history averages are coloured against (yards rows use the
// model's median instead, see medianYards).
function modelMean(gs, side, kind, pl) {
  const team = gs.playerData?.[side];
  if (!team) return null;
  if (kind === 'fg') {
    const arr = gs.teamDists?.[side]?.fg;
    if (arr?.length) return arr.reduce((s, p, n) => s + n * p, 0);
    return team.fg_dist ? Object.entries(team.fg_dist).reduce((s, [n, p]) => s + Number(n) * p, 0) : null;
  }
  const tds = expectedTds(gs, side);
  return tds == null ? null : tds * legAtomP(team, kind, pl);
}

// Green / red: history above / below the model by more than a small neutral
// band (HIST_BAND), compared at the shown precision.
const HIST_BAND = { avg: 0.05, hit: 3 };   // averages / medians: ±5% of the model; hit rates: ±3 points
function vsModel(shown, model, tol) {
  if (model == null || Math.abs(shown - model) <= tol) return 'text-gray-200';
  return shown > model ? 'text-green-400' : 'text-red-400';
}

// model: { avg, hit } — the model's per-game mean (yards: median) and its chance for the picked line
function historyHtml(kind, id, line, model = {}) {
  const gid = currentGame?.game_id;
  const logs = logsCache[gid];
  if (logs === undefined) return '<span class="bsm-skeleton h-3 w-full block"></span>';
  const stat = LOG_STAT[kind];
  const hist = kind === 'dst_td' ? logs?.dst?.[id]?.[stat] : logs?.players?.[id]?.[stat];
  if (!hist) return '';
  const yards = YARDS_KINDS.has(kind);
  const wins = [
    ['l10', g => `L${g}`, 'Last games played (up to 10)'],
    ['prev', () => String(logs.prev_season), `${logs.prev_season} season, playoffs included`],
    kind === 'dst_td'
      ? ['car', () => `Since '${String(logs.dst_from).slice(2)}`, `Every game since ${logs.dst_from} (the start of our D/ST data)`]
      : ['car', () => 'Career', 'Every NFL game of his career, playoffs included'],
  ];
  // value(h) -> number at display precision; text(v) -> label
  const cell = (w, value, text, modelV, modelText, tol) => {
    const h = hist[w[0]] || [], g = histGames(h);
    const v = g ? value(h) : null;
    const body = g ? `<span class="${vsModel(v, modelV, tol)} font-semibold">${text(v)}</span>` : '–';
    const tip = `${w[2]}: ${g} game${g === 1 ? '' : 's'}${modelV != null ? ` · model ${modelText}` : ''}`;
    return `<span class="whitespace-nowrap truncate" title="${esc(tip)}">${w[1](Math.min(g, 10))} ${body}</span>`;
  };
  // Yards are skewed, so their centre is the median (whole yards); counts use the mean
  const centre = h => (yards ? histMedian(h) : Math.round(histAvg(h) * 100) / 100);
  const roundAvg = x => (yards ? Math.round(x) : Math.round(x * 100) / 100);
  const avgText = v => (yards ? String(v) : v.toFixed(2));
  const mAvg = model.avg != null ? roundAvg(model.avg) : null;
  const mHit = model.hit != null ? Math.round(model.hit * 100) : null;
  const what = `${line}+${yards ? '' : { fg: ' FG', pass_td: ' pass TD' }[kind] || ' TD'}`;
  return `
    <div class="grid grid-cols-[5.75rem_repeat(3,minmax(0,1fr))] gap-x-1.5 gap-y-1 text-[11px] text-gray-400 leading-none">
      <span>${yards ? 'Median yds' : 'Avg'}</span>${wins.map(w => cell(w, centre, avgText,
                                                     mAvg, mAvg != null ? avgText(mAvg) : '', Math.abs(mAvg) * HIST_BAND.avg)).join('')}
      ${line > 0 ? `<span class="text-green-300/90 whitespace-nowrap">${what} hit</span>${wins.map(w => cell(w,
        h => Math.round(histHit(h, line) * 100), v => `${v}%`, mHit, `${mHit}%`, HIST_BAND.hit)).join('')}` : ''}
    </div>`;
}

async function loadLogs(gid) {
  if (gid in logsCache) return;
  logsCache[gid] = undefined;
  let data = null;
  try {
    const res = await fetch(apiUrl('nfl', `game_player_logs/${gid}`));
    data = res.ok ? await res.json() : null;
  } catch { /* leave null */ }
  logsCache[gid] = data;
  if (String(currentGame?.game_id) === String(gid)) renderTeams();
}

// One selectable row: name / price / stepper on top, a full-width stats line
// underneath (full width so it never wraps, even on a phone). Clicking anywhere
// but a button opens the stats window. kind: anytime | pass_td | fg | dst_td
function marketRow(gs, side, kind, { key, name, sub = '', subTitle = '', meta = '', player = null, badge = '', availBtn = '' }) {
  const picked = gs.picks.get(key);
  const val = picked ? picked.n : 0;
  const p = singleLegProb(gs, side, kind, player, Math.max(1, val));
  return `
    <div class="group grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1.5 py-2 px-1 player-row cursor-pointer hover:bg-gray-700/25${val > 0 ? ' bg-gray-700/40' : ''}"
         data-detail="${key}">
      <div class="min-w-0 flex items-center gap-1">
        <span class="text-sm truncate group-hover:underline decoration-gray-500 decoration-dotted underline-offset-2">${esc(name)}</span>
        ${sub ? `<span class="text-xs text-gray-400 min-w-0 truncate shrink-[3]"${subTitle ? ` title="${esc(subTitle)}"` : ''}>${sub}</span>` : ''}${badge}
      </div>
      <div class="w-20 text-right">${priceHtml(p, binsCache[currentGame?.game_id] === undefined)}</div>
      ${stepperHtml(key, val, MAX_N[kind])}
      ${meta ? `<div class="col-span-3 flex items-center gap-3 text-[11px] text-gray-400 leading-none">
        ${meta}${availBtn ? `<span class="ml-auto">${availBtn}</span>` : ''}</div>` : ''}
      <div class="col-span-3">${historyHtml(kind, kind === 'dst_td' ? key.split(':')[2] : player?.id, val,
        { avg: modelMean(gs, side, kind, player), hit: val > 0 ? p : null })}</div>
    </div>`;
}

function statusBadge(pl) {
  const b = STATUS_BADGE[pl.status];
  if (!b) return '';
  const title = [b[2], pl.status_detail].filter(Boolean).join(' — ');
  return `<span class="shrink-0 px-1 rounded border text-[10px] font-bold ${b[1]}" title="${esc(title)}">${b[0]}</span>`;
}

// "WR1" by projected role (backend role_rank); the published depth-chart slot
// lags, so it's kept in the tooltip.
const slotLabel = pl => `${pl.pos}${pl.role_rank ?? pl.depth}`;
const slotTitle = pl => `Depth chart: ${pl.pos}${pl.depth}` + (pl.role_rank && pl.role_rank !== pl.depth ? ' (ranked by projected role)' : '');

// Last-5 form: one fixed-size box per game played, newest first, so the strips
// line up from row to row. Missing games (fewer than 5 played) are dashed.
function formStrip(counts = [], labels = [], unit = 'TD') {
  const base = 'inline-flex items-center justify-center w-4 h-4 rounded-sm text-[10px] font-semibold';
  const boxes = [];
  for (let i = 0; i < 5; i++) {
    const n = counts[i];
    if (n == null) { boxes.push(`<span class="${base} border border-dashed border-gray-700"></span>`); continue; }
    const tip = `${labels[i] || 'Game'}: ${n} ${unit}${n === 1 ? '' : 's'}`;
    boxes.push(`<span class="${base} ${n > 0 ? 'bg-green-500/20 text-green-300' : 'bg-gray-700/50 text-gray-400'}" title="${esc(tip)}">${n}</span>`);
  }
  return `<span class="flex items-center gap-1 shrink-0"><span title="Last 5 games played, newest first">L5</span>
    <span class="flex gap-0.5">${boxes.join('')}</span></span>`;
}

// Fixed-width lead cell so every row's form strip starts in the same place
const metaLead = html => `<span class="w-[5.75rem] shrink-0 whitespace-nowrap">${html}</span>`;

function playerMeta(pl) {
  const s = pl.stats || {};
  const snaps = pl.active && pl.snap_proj != null
    ? `<span class="text-gray-300 font-semibold">${Math.round(pl.snap_proj * 100)}%</span>` : '–';
  return metaLead(`<span title="Projected offensive snap share">Exp snaps</span> ${snaps}`)
    + formStrip(s.recent_tds, s.recent_games, 'TD');
}

const dstMeta = team => metaLead('Def / ST') + formStrip(team.dst_recent_tds, team.dst_recent_games, 'D/ST TD');

function availButton(pl) {
  return pl.active
    ? `<button type="button" data-avail="${pl.id}" data-make="out" title="Mark as not playing — redistributes their work"
               class="text-[10px] text-gray-400 hover:text-red-400">✕ out</button>`
    : `<button type="button" data-avail="${pl.id}" data-make="in" title="Mark as playing"
               class="text-[10px] text-blue-400 hover:text-blue-300">+ in</button>`;
}

// Mean of the team's TD count distribution: the sim-bin mixture the prices use,
// else the stored whole-game distribution from game_player_data.
function expectedTds(gs, side) {
  const arr = gs.teamDists?.[side]?.td;
  if (arr?.length) return arr.reduce((s, p, n) => s + n * p, 0);
  const d = gs.playerData?.[side]?.td_dist;
  if (d) return Object.entries(d).reduce((s, [n, p]) => s + Number(n) * p, 0);
  return null;
}

function renderTeamCard(game, side) {
  const gs = S(game.game_id);
  const team = gs.playerData?.[side];
  const teamName = side === 'home' ? game.home_team : game.away_team;
  const card = document.createElement('div');
  card.className = 'bg-gray-800 border border-gray-700 rounded-xl p-4 w-full md:w-96 shadow-md';

  let body;
  if (!gs.playerData) {
    body = '<div class="py-6 text-center"><span class="bsm-skeleton h-3 w-32 inline-block"></span></div>';
  } else if (!team?.players?.length) {
    body = '<p class="py-4 text-sm text-gray-400 text-center">No player data for this team yet.</p>';
  } else {
    body = MARKET_BODY[market](gs, side, team);
  }

  card.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2 min-w-0">
        <img src="${nflLogoUrl(teamName)}" class="w-8 h-8 object-contain shrink-0" alt="" onerror="this.style.display='none'">
        <div class="min-w-0">
          <div class="font-bold text-base truncate">${esc(teamName)}</div>
          <div class="text-xs text-gray-400">Expected touchdowns:
            <span class="font-semibold text-amber-400">${expectedTds(gs, side)?.toFixed(2) ?? '–'}</span></div>
        </div>
      </div>
      <button type="button" data-clear="${side}" class="text-xs text-gray-400 hover:text-white border border-gray-600 hover:border-gray-400 px-2 py-1 rounded transition-colors">Clear</button>
    </div>
    ${body}`;
  return card;
}

const colHead = (title, priceH, countH, { countW = 'w-20', first = true } = {}) => `
  <div class="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider ${first ? '' : 'mt-4 '}mb-1 px-1">
    <span class="flex-1">${title}</span>
    <span class="w-20 text-right">${priceH}</span>
    <span class="${countW} text-center">${countH}</span>
  </div>`;
const rowList = html => `<div class="flex flex-col divide-y divide-gray-700/50">${html}</div>`;
const cardNote = html => `<p class="mt-3 text-[11px] text-gray-400 leading-snug">${html} Tap a player for detailed stats.</p>`;
const VOID_NOTE = 'Prices assume the player plays (bets on players who sit out are void).';

// "Show N more" toggle + the extra rows (built only when expanded), kept per tab and side.
function moreBlock(gs, side, count, what, rowsHtml) {
  if (!count) return '';
  const key = `${market}:${side}`;
  const open = gs.showAll[key];
  return `
    <button type="button" data-showall="${key}"
            class="w-full mt-1 px-2 py-1.5 text-xs text-gray-400 hover:text-gray-300 text-left">
      ${open ? '▾ Hide' : '▸ Show'} ${count} more (${what})
    </button>
    ${open ? rowList(rowsHtml()) : ''}`;
}

const MARKET_BODY = {
  td: tdBody,
  pass: passBody,
  rush: (gs, side, team) => yardsBody(gs, side, team, 'rush_yds'),
  rec: (gs, side, team) => yardsBody(gs, side, team, 'rec_yds'),
  fg: fgBody,
};

function tdBody(gs, side, team) {
  const anyKey = pl => `${side}:anytime:${pl.id}`;
  // Anytime options — skill players plus the D/ST — by chance to score. Prices
  // are monotone in the per-TD share, so td_share / dst_frac rank them even
  // before the sim bins load. Shares are conditional on playing, so the default
  // top 10 is drawn from players expected to play, with the D/ST taking 10th if
  // it isn't there on merit; picked options always stay visible.
  const options = [
    ...team.players.filter(pl => pl.pos !== 'K' && pl.active)
      .map(pl => ({ pl, key: anyKey(pl), share: pl.td_share })),
    { pl: null, key: `${side}:dst_td:${team.team_id}`, share: team.dst_frac },
  ].sort((a, b) => b.share - a.share);
  const eligible = options.filter(o => !o.pl || o.pl.expected);
  let top = eligible.slice(0, TOP_N);
  if (!top.some(o => !o.pl)) top = [...eligible.slice(0, TOP_N - 1), eligible.find(o => !o.pl)];
  const shown  = options.filter(o => top.includes(o) || gs.picks.has(o.key));
  const hidden = options.filter(o => !shown.includes(o));
  const ruledOut = team.players.filter(pl => pl.pos !== 'K' && !pl.active);

  const row = o => o.pl
    ? marketRow(gs, side, 'anytime', {
        key: o.key, name: o.pl.name, player: o.pl, meta: playerMeta(o.pl),
        sub: `(${slotLabel(o.pl)})`, subTitle: slotTitle(o.pl),
        badge: statusBadge(o.pl) + (o.pl.overridden ? '<span class="shrink-0 text-[10px] text-blue-300">manual</span>' : '')
          + (o.pl.expected ? '' : `<span class="shrink-0 text-[10px] text-gray-400" title="Plays in about ${Math.round((o.pl.p_play ?? 0) * 100)}% of games — price assumes they play">unlikely</span>`),
        availBtn: availButton(o.pl),
      })
    : marketRow(gs, side, 'dst_td', { key: o.key, name: `${team.abbr} D/ST`, meta: dstMeta(team) });
  const ruledOutRow = pl => `
    <div class="flex items-center gap-1 py-2 px-1 opacity-60 cursor-pointer hover:bg-gray-700/25" data-detail="${anyKey(pl)}">
      <span class="text-sm line-through truncate">${esc(pl.name)}</span>
      <span class="text-xs text-gray-400 shrink-0" title="${esc(slotTitle(pl))}">(${slotLabel(pl)})</span>${statusBadge(pl)}
      <span class="ml-auto shrink-0">${availButton(pl)}</span>
    </div>`;

  return `
    ${colHead('Player', 'Anytime', 'TDs')}
    ${rowList(shown.map(row).join(''))}
    ${moreBlock(gs, side, hidden.length + ruledOut.length, 'lower chance, unlikely to play or ruled out',
                () => hidden.map(row).join('') + ruledOut.map(ruledOutRow).join(''))}
    ${cardNote(`${VOID_NOTE} Pass TD share ${pct(team.pass_frac)} · D/ST share ${pct(team.dst_frac)} of team TDs.`)}`;
}

// Starting QB: passing TDs (count stepper) and passing yards (line).
function passBody(gs, side, team) {
  const qb = team.players.find(pl => pl.id === team.starting_qb_id);
  if (!qb) return '<p class="py-4 text-sm text-gray-400 text-center">No projected starting QB.</p>';
  let yards = '';
  if (gs.playerData.yards_params && team.yards && qb.active) {
    yards = yardsHead('Passing yards', false)
      + (binsCache[gs.gameId] ? rowList(yardsRow(gs, side, 'pass_yds', qb)) : YARDS_LOADING);
  }
  return `
    ${colHead('Passing TDs', 'Price', 'Count')}
    ${rowList(marketRow(gs, side, 'pass_td', {
      key: `${side}:pass_td:${qb.id}`, name: qb.name, sub: `(${slotLabel(qb)})`, subTitle: slotTitle(qb), player: qb,
      badge: statusBadge(qb),
      meta: metaLead('Passing') + formStrip(qb.stats?.recent_pass_tds, qb.stats?.recent_games, 'pass TD'),
    }))}
    ${yards}
    ${cardNote(`${VOID_NOTE} ${pct(team.pass_frac)} of team TDs are passing TDs.`)}`;
}

function fgBody(gs, side, team) {
  const k = team.players.find(pl => pl.id === team.kicker_id);
  if (!k) return '<p class="py-4 text-sm text-gray-400 text-center">No projected kicker.</p>';
  return `
    ${colHead('Kicker', 'Price', 'FGs')}
    ${rowList(marketRow(gs, side, 'fg', {
      key: `${side}:fg:${k.id}`, name: k.name, sub: '(K)', player: k,
      meta: metaLead('Kicking') + formStrip(k.stats?.recent_fg_made, k.stats?.recent_games, 'FG'),
      badge: statusBadge(k), availBtn: availButton(k),
    }))}
    ${cardNote(VOID_NOTE)}`;
}

// --- yards rows: QB passing, rushers, receivers. Each row is an alt-line
// ladder: YARDS_RUNGS lines in round steps around the even-money line, each
// with its own price — tap one to add it, tap again to remove. The last cell
// takes any other line (a bookie's 66.5 becomes 67+).
const YARDS_ROWS = { rush_yds: 4, rec_yds: 7 };
const YARDS_MIN_SHARE = { rush_yds: 0.05, rec_yds: 0.04 };
const YARDS_RUNGS = 5;
const YARDS_MAX_LINE = 999;
const YARDS_LABEL = { pass_yds: 'Pass', rush_yds: 'Rush', rec_yds: 'Rec' };

function yardsStrip(values = [], labels = [], unit) {
  const base = 'inline-flex items-center justify-center w-7 h-4 rounded-sm text-[10px] font-semibold tabular-nums';
  const boxes = [];
  for (let i = 0; i < 5; i++) {
    const v = values[i];
    if (v == null) { boxes.push(`<span class="${base} border border-dashed border-gray-700"></span>`); continue; }
    boxes.push(`<span class="${base} bg-gray-700/50 text-gray-300" title="${esc(`${labels[i] || 'Game'}: ${v} ${unit}`)}">${v}</span>`);
  }
  return `<span class="flex items-center gap-1 shrink-0"><span title="Last 5 games played, newest first">L5</span>
    <span class="flex gap-0.5">${boxes.join('')}</span></span>`;
}

// Ladder lines: multiples of a step that suits the player's volume, centred on
// the even-money line and never below one step.
function yardsLadder(gs, side, kind, pl) {
  const d = defaultYardsLine(gs, side, kind, pl);
  if (d == null) return [];
  const exp = expectedYards(gs, side, kind, pl) ?? d;
  const step = kind === 'pass_yds' ? (exp >= 150 ? 25 : 10) : exp >= 40 ? 10 : 5;
  const lo = Math.max(step, Math.round(d / step) * step - Math.floor(YARDS_RUNGS / 2) * step);
  return Array.from({ length: YARDS_RUNGS }, (_, i) => lo + i * step);
}

const RUNG = 'flex flex-col items-center justify-center rounded-md border py-1 min-w-0 leading-tight transition-colors';
const rungTone = on => (on ? 'bg-green-500/15 border-green-500 ring-1 ring-green-500/40'
                           : 'bg-gray-900/40 border-gray-700 hover:border-green-400');

function yardsRow(gs, side, kind, pl) {
  const key = `${side}:${kind}:${pl.id}`;
  const picked = gs.picks.get(key);
  const ladder = yardsLadder(gs, side, kind, pl);
  const custom = picked && !ladder.includes(picked.n) ? picked.n : null;
  const med = medianYards(gs, side, kind, pl);
  const s = pl.stats || {};
  const recent = { pass_yds: s.recent_pass_yds, rush_yds: s.recent_rush_yds, rec_yds: s.recent_rec_yds }[kind];
  const unit = `${YARDS_LABEL[kind].toLowerCase()} yds`;
  const rungs = ladder.map(L => {
    const p = singleYardsProb(gs, side, kind, pl, L);
    const on = picked?.n === L;
    return `
      <button type="button" data-yline="${key}" data-line="${L}" aria-pressed="${on}"
              title="${on ? 'Remove' : 'Add'} ${esc(pl.name)} ${L}+ ${unit}" class="${RUNG} ${rungTone(on)}">
        <span class="text-xs font-bold tabular-nums ${on ? 'text-green-300' : 'text-white'}">${L}+</span>
        <span class="text-[10px] font-semibold text-gray-300">${pct(p)}</span>
        <span class="text-[10px] text-gray-400">${odds(p)}</span>
      </button>`;
  }).join('');
  const pc = custom != null ? singleYardsProb(gs, side, kind, pl, custom) : null;
  const other = `
    <label class="${RUNG} ${rungTone(custom != null)} cursor-text" title="Any other line, e.g. a bookie's 66.5">
      <input data-ycustom="${key}" type="number" inputmode="decimal" min="0.5" max="${YARDS_MAX_LINE}" step="0.5"
             value="${custom ?? ''}" placeholder="Other" aria-label="Other ${unit} line"
             class="w-full bg-transparent text-center text-xs font-bold tabular-nums text-white placeholder-gray-400 focus:outline-none
                    [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none">
      <span class="text-[10px] font-semibold text-gray-300">${custom != null ? pct(pc) : 'line'}</span>
      <span class="text-[10px] text-gray-400">${custom != null ? odds(pc) : '&nbsp;'}</span>
    </label>`;
  return `
    <div class="group py-2 px-1 player-row cursor-pointer hover:bg-gray-700/25${picked ? ' bg-gray-700/40' : ''}" data-detail="${key}">
      <div class="flex items-center gap-1 min-w-0">
        <span class="text-sm truncate group-hover:underline decoration-gray-500 decoration-dotted underline-offset-2">${esc(pl.name)}</span>
        <span class="text-xs text-gray-400 shrink-0" title="${esc(slotTitle(pl))}">(${slotLabel(pl)} · ${YARDS_LABEL[kind]})</span>
        <span class="ml-auto shrink-0 pl-1 text-xs text-gray-400" title="Median ${unit} if he plays — a 50/50 line">Median
          <span class="text-gray-200 font-semibold">${med ?? '–'}</span> yds</span>
      </div>
      <div class="grid grid-cols-6 gap-1 mt-1.5">${ladder.length ? rungs + other : '<span class="col-span-6 bsm-skeleton h-9 block"></span>'}</div>
      <div class="flex items-center gap-3 mt-1.5 text-[11px] text-gray-400 leading-none">${yardsStrip(recent, s.recent_games, unit)}</div>
      <div class="mt-1.5">${historyHtml(kind, pl.id, picked?.n || 0, {
        avg: med, hit: picked ? singleYardsProb(gs, side, kind, pl, picked.n) : null })}</div>
    </div>`;
}

// Section header for yards rows (no price / count columns — each rung carries its price)
const yardsHead = (title, first = true) => `
  <div class="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider ${first ? '' : 'mt-4 '}mb-1 px-1">
    <span class="flex-1">${title}</span>
    <span class="text-[10px] normal-case tracking-normal">tap a line to add it</span>
  </div>`;

const YARDS_LOADING = '<div class="py-3 text-center"><span class="bsm-skeleton h-3 w-32 inline-block"></span></div>';

// Rushing / receiving yards tab: players ranked by expected yards (yards shares
// before the bins load). The default list is the top YARDS_ROWS expected to play
// with a real share; the rest of the active skill players are under "Show more".
function yardsCandidates(gs, side, team, kind) {
  const shareKey = kind === 'rush_yds' ? 'rush_yds_share' : 'rec_yds_share';
  const isPicked = pl => gs.picks.has(`${side}:${kind}:${pl.id}`);
  const exp = new Map();
  const cands = team.players.filter(pl => pl.active && pl.pos !== 'K' && (pl[shareKey] > 0 || isPicked(pl)));
  for (const pl of cands) exp.set(pl, expectedYards(gs, side, kind, pl) ?? pl[shareKey]);
  cands.sort((a, b) => exp.get(b) - exp.get(a));
  const top = cands.filter(pl => pl.expected && pl[shareKey] >= YARDS_MIN_SHARE[kind]).slice(0, YARDS_ROWS[kind]);
  const shown = cands.filter(pl => top.includes(pl) || isPicked(pl));
  return { shown, hidden: cands.filter(pl => !shown.includes(pl)) };
}

// Each ladder rung is a bin-by-bin price (~100 per tab), so once a game's data
// lands the listed rows are priced in short idle slices — opening a yards tab
// then reads the cache instead of stalling.
function warmYardsLadders(gid) {
  const gs = S(gid), pd = gs.playerData;
  if (!binsCache[gid]?.length || !yardsReady(gs)) return;
  const jobs = [];
  for (const side of ['home', 'away']) {
    const team = pd[side];
    const qb = team.players.find(pl => pl.id === team.starting_qb_id);
    if (qb?.active) jobs.push([side, 'pass_yds', qb]);
    for (const kind of ['rush_yds', 'rec_yds']) {
      for (const pl of yardsCandidates(gs, side, team, kind).shown) jobs.push([side, kind, pl]);
    }
  }
  const run = () => {
    if (gs.playerData !== pd) return;   // reloaded (overrides): that load warms its own
    const t = performance.now();
    while (jobs.length && performance.now() - t < 12) {
      const [side, kind, pl] = jobs.shift();
      for (const L of yardsLadder(gs, side, kind, pl)) singleYardsProb(gs, side, kind, pl, L);
      medianYards(gs, side, kind, pl);
    }
    if (jobs.length) setTimeout(run, 0);
  };
  setTimeout(run, 0);
}

function yardsBody(gs, side, team, kind) {
  if (!gs.playerData.yards_params || !team.yards) {
    return '<p class="py-4 text-sm text-gray-400 text-center">Yards prices aren\'t available for this game yet.</p>';
  }
  if (!binsCache[gs.gameId]) return YARDS_LOADING;
  const { shown, hidden } = yardsCandidates(gs, side, team, kind);
  const what = kind === 'rush_yds' ? 'Rushing' : 'Receiving';
  return `
    ${yardsHead(`${what} yards`)}
    ${rowList(shown.map(pl => yardsRow(gs, side, kind, pl)).join(''))}
    ${moreBlock(gs, side, hidden.length, 'smaller roles or unlikely to play',
                () => hidden.map(pl => yardsRow(gs, side, kind, pl)).join(''))}
    ${cardNote(`${VOID_NOTE} Median = the 50/50 line (yards are skewed, so the average sits higher). Lines step around it; type any other line (66.5 = 67+) in the last box.`)}`;
}

// Tab bar; each tab counts this game's picks in its market, since those rows
// are hidden while another tab is open.
function renderTabs() {
  const gs = S();
  const picks = [...gs.picks.values()];
  const tabs = MARKETS.filter(m => !m.yards || !gs.playerData || gs.playerData.yards_params);
  if (!tabs.some(m => m.id === market)) market = 'td';
  marketTabs.innerHTML = tabs.map(m => {
    const on = m.id === market;
    const n = picks.filter(p => m.kinds.includes(p.kind)).length;
    return `
      <button type="button" role="tab" aria-selected="${on}" data-market="${m.id}"
              class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-semibold whitespace-nowrap transition-colors
                     ${on ? 'bg-blue-500 border-blue-500 text-white' : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-blue-400 hover:text-white'}">
        ${m.tab}${n ? `<span class="min-w-[1.25rem] px-1 rounded-full text-[11px] leading-5 text-center ${on ? 'bg-white/25 text-white' : 'bg-green-500/20 text-green-300'}">${n}</span>` : ''}
      </button>`;
  }).join('');
}

marketTabs.addEventListener('click', e => {
  const tab = e.target.closest('[data-market]');
  if (!tab || tab.dataset.market === market) return;
  market = tab.dataset.market;
  renderTeams();
});

function renderTeams() {
  if (!currentGame) return;
  renderTabs();
  teamsContainer.innerHTML = '';
  teamsContainer.appendChild(renderTeamCard(currentGame, 'home'));
  teamsContainer.appendChild(renderTeamCard(currentGame, 'away'));
}

function findPlayer(gs, side, id) {
  return gs.playerData?.[side]?.players.find(p => String(p.id) === String(id)) || null;
}

function setYardsPick(gs, key, n) {
  const [side, kind, id] = key.split(':');
  const pl = findPlayer(gs, side, id);
  if (pl) gs.picks.set(key, { side, kind, n, playerId: pl.id, teamId: gs.playerData[side].team_id, name: pl.name });
}

// "Other" line box: a half-point line is the next whole yard (66.5 -> 67+); empty removes it
teamsContainer.addEventListener('change', e => {
  const input = e.target.closest('[data-ycustom]');
  if (!input || !currentGame) return;
  const gs = S(), key = input.dataset.ycustom;
  const v = parseFloat(input.value);
  if (!Number.isFinite(v) || v <= 0) gs.picks.delete(key);
  else setYardsPick(gs, key, Math.min(YARDS_MAX_LINE, Math.ceil(v)));
  renderTeams();
  recalculate();
});

teamsContainer.addEventListener('click', e => {
  if (!currentGame) return;
  const gs = S();
  const rung = e.target.closest('[data-yline]');
  if (rung) {
    const key = rung.dataset.yline;
    const n = Number(rung.dataset.line);
    if (gs.picks.get(key)?.n === n) gs.picks.delete(key);
    else setYardsPick(gs, key, n);
    renderTeams();
    recalculate();
    return;
  }
  const step = e.target.closest('[data-step]');
  if (step) {
    const key = step.dataset.key;
    const [side, kind, id] = key.split(':');
    const cur = gs.picks.get(key)?.n || 0;
    const n = Math.max(0, Math.min(MAX_N[kind], cur + Number(step.dataset.step)));
    if (n === 0) {
      gs.picks.delete(key);
    } else {
      const team = gs.playerData[side];
      const pl = kind === 'dst_td' ? null : findPlayer(gs, side, id);
      gs.picks.set(key, {
        side, kind, n,
        playerId: pl ? pl.id : null,
        teamId: team.team_id,
        name: kind === 'dst_td' ? team.abbr : pl.name,
      });
    }
    renderTeams();
    recalculate();
    return;
  }
  const clear = e.target.closest('[data-clear]');
  if (clear) {
    for (const [k, p] of gs.picks) if (p.side === clear.dataset.clear) gs.picks.delete(k);
    renderTeams();
    recalculate();
    return;
  }
  const showAll = e.target.closest('[data-showall]');
  if (showAll) {
    gs.showAll[showAll.dataset.showall] = !gs.showAll[showAll.dataset.showall];   // key: `${market}:${side}`
    renderTeams();
    return;
  }
  const avail = e.target.closest('[data-avail]');
  if (avail) {
    const id = Number(avail.dataset.avail);
    const makeIn = avail.dataset.make === 'in';
    gs.out.delete(id); gs.in.delete(id);
    const pl = findPlayer(gs, 'home', id) || findPlayer(gs, 'away', id);
    const syncedActive = !EXCLUDED.includes(pl?.status);
    if (makeIn !== syncedActive) (makeIn ? gs.in : gs.out).add(id);
    loadPlayerData(currentGame.game_id);
    return;
  }
  const detail = e.target.closest('[data-detail]');
  if (detail && !e.target.closest('button, input, label')) {
    const [side, kind, id] = detail.dataset.detail.split(':');
    openDetail(side, kind, id);
  }
});

// =============================================================================
// STATS WINDOW (last 5 games + this/last season, from /api/nfl/player_detail
// or /api/nfl/dst_detail; the model numbers come from game_player_data)
// =============================================================================
const detailModal = document.createElement('div');
detailModal.className = 'fixed inset-0 hidden items-end sm:items-center justify-center bg-black/60 sm:p-4';
detailModal.style.zIndex = '1200';   // above the site header (1100) and betslip
detailModal.innerHTML = `
  <div role="dialog" aria-modal="true" aria-labelledby="nfl-detail-title"
       class="bg-gray-800 border border-gray-700 w-full sm:max-w-xl max-h-[88vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-2xl p-4"></div>`;
document.body.appendChild(detailModal);
const detailPanel = detailModal.firstElementChild;
const detailCache = new Map();   // url -> response
let detailSeq = 0;

function closeDetail() {
  detailSeq++;
  detailModal.classList.add('hidden');
  detailModal.classList.remove('flex');
  document.body.style.overflow = '';
}
detailModal.addEventListener('click', e => {
  if (e.target === detailModal || e.target.closest('[data-close-detail]')) closeDetail();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !detailModal.classList.contains('hidden')) closeDetail();
});

// Column groups for a player's game log / season lines. A group shows when it's
// the position's job or the player has any of those numbers (a WR's carries).
const STAT_GROUPS = [
  { label: 'Rushing',   pos: ['QB', 'RB'], cols: [{ k: 'carries', h: 'Car' }, { k: 'rz_carries', h: 'RZ' }, { k: 'rush_yds', h: 'Yds' }, { k: 'rush_tds', h: 'TD', td: true }] },
  { label: 'Receiving', pos: ['RB', 'WR', 'TE'], cols: [{ k: 'targets', h: 'Tgt' }, { k: 'rz_targets', h: 'RZ' }, { k: 'receptions', h: 'Rec' }, { k: 'rec_yds', h: 'Yds' }, { k: 'rec_tds', h: 'TD', td: true }] },
  { label: 'Passing',   pos: ['QB'], cols: [{ k: 'pass_att', h: 'Att' }, { k: 'pass_yds', h: 'Yds' }, { k: 'pass_tds', h: 'TD', td: true }] },
  { label: 'Kicking',   pos: ['K'], cols: [{ k: 'fg_made', h: 'Made', td: true }, { k: 'fg_att', h: 'Att' }] },
];
const DST_GROUP = { label: 'Team touchdowns', cols: [
  { k: 'dst_td', h: 'D/ST', td: true }, { k: 'off_rush_td', h: 'Rush' }, { k: 'off_pass_td', h: 'Pass' }, { k: 'team_tds', h: 'Total' }] };

const pctInt = v => (v == null ? '–' : `${Math.round(v * 100)}%`);

// Table with fixed lead columns (game / season ...) then grouped stat columns.
// flat: one header row, no group labels.
function groupedTable(lead, groups, rows, { flat = false } = {}) {
  const th = 'px-1.5 py-1 font-semibold text-gray-400 text-center whitespace-nowrap';
  const sep = 'border-l border-gray-700';
  const twoRows = !flat && groups.length > 0;
  const leadHead = lead.map(c => `<th ${twoRows ? 'rowspan="2"' : ''} class="${th} ${c.left ? 'text-left' : ''} align-bottom">${c.h}</th>`).join('');
  const groupHead = groups.map(g => `<th colspan="${g.cols.length}" class="${th} ${sep} text-[10px] uppercase tracking-wider">${g.label}</th>`).join('');
  const subHead = groups.map(g => g.cols.map((c, i) => `<th class="${th}${i ? '' : ` ${sep}`}">${c.h}</th>`).join('')).join('');
  const cell = (c, r, i) => {
    const v = r[c.k];
    const txt = c.fmt ? c.fmt(v, r) : (v ?? 0);
    const tone = c.td && v > 0 ? 'text-green-400 font-semibold' : v ? 'text-gray-200' : 'text-gray-400';
    return `<td class="px-1.5 py-1.5 text-center tabular-nums ${tone}${i ? '' : ' border-l border-gray-700/60'}">${txt}</td>`;
  };
  const body = rows.map(r => `
    <tr class="border-t border-gray-700/60">
      ${lead.map(c => `<td class="px-1.5 py-1.5 whitespace-nowrap ${c.left ? 'text-left' : 'text-center tabular-nums text-gray-200'}">${c.cell(r)}</td>`).join('')}
      ${groups.map(g => g.cols.map((c, i) => cell(c, r, i)).join('')).join('')}
    </tr>`).join('');
  return `
    <div class="overflow-x-auto -mx-1">
      <table class="w-full text-xs">
        <thead>${twoRows ? `<tr>${leadHead}${groupHead}</tr><tr>${subHead}</tr>` : `<tr>${leadHead}${subHead}</tr>`}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

const gameLead = season => ({ h: 'Game', left: true, cell: g => `
  <div class="leading-tight"><div class="text-gray-300">Wk ${g.week}${g.season !== season ? ` <span class="text-gray-400">’${String(g.season).slice(2)}</span>` : ''}</div>
  <div class="text-gray-400">${g.home ? 'vs' : '@'} ${esc(g.opp)}</div></div>` });
const seasonLead = [{ h: 'Season', left: true, cell: s => `<span class="text-gray-300">${s.season}</span>` }, { h: 'G', cell: s => s.games }];

const detailTile = (label, value, sub = '') => `
  <div class="bg-gray-900/60 border border-gray-700 rounded-lg px-2 py-2 text-center min-w-0">
    <div class="text-[10px] uppercase tracking-wider text-gray-400 leading-tight">${label}</div>
    <div class="text-base font-bold text-white mt-0.5">${value}</div>
    ${sub ? `<div class="text-[11px] text-gray-400">${sub}</div>` : ''}
  </div>`;
const tileGrid = tiles => `<div class="grid gap-2 ${tiles.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}">${tiles.join('')}</div>`;
const probTile = (label, p) => detailTile(label, p > 1e-6 ? pct(p) : '–', p > 1e-6 ? odds(p) : '');
const sectionHead = (title, note = '') => `
  <div class="flex items-baseline justify-between gap-2 mt-5 mb-1">
    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">${title}</h3>
    ${note ? `<span class="text-[11px] text-gray-400">${note}</span>` : ''}
  </div>`;

function playerDetailBody(pl, data) {
  const pos = pl.pos;
  const anyVal = k => [...data.games, ...data.seasons].some(r => r[k]);
  const groups = STAT_GROUPS.filter(g => g.pos.includes(pos) || g.cols.some(c => anyVal(c.k)));
  const snapCol = pos === 'K' ? [] : [{ h: 'Snap', cell: r => pctInt(r.snap_pct) }];
  let html = sectionHead('Last 5 games', 'newest first');
  html += data.games.length
    ? groupedTable([gameLead(data.season), ...snapCol], groups, data.games)
    : '<p class="text-xs text-gray-400 py-2">No games played yet.</p>';

  if (data.seasons.length) {
    html += sectionHead('Season totals', pos === 'K' ? '' : 'snap % is the per-game average');
    html += groupedTable([...seasonLead, ...snapCol], groups, data.seasons);
    if (pos !== 'K') {
      const rush = groups.some(g => g.label === 'Rushing'), recv = groups.some(g => g.label === 'Receiving');
      const shareCols = [
        rush && { k: 'carry_share', h: 'Carries', fmt: pctInt },
        rush && { k: 'rush_yds_share', h: 'Rush yds', fmt: pctInt },
        recv && { k: 'target_share', h: 'Targets', fmt: pctInt },
        recv && { k: 'rec_yds_share', h: 'Rec yds', fmt: pctInt },
        { k: 'rz_share', h: 'RZ opps', fmt: pctInt },
        { k: 'td_share', h: 'Rush + rec TDs', fmt: pctInt },
      ].filter(Boolean);
      html += sectionHead('Share of team');
      html += groupedTable([seasonLead[0]], [{ cols: shareCols }], data.seasons, { flat: true });
    }
  }
  html += `<p class="mt-3 text-[11px] text-gray-400 leading-snug">RZ = carries / targets inside the opponent's 10-yard line.
    Last 5 counts only games the player appeared in.</p>`;
  return html;
}

function dstDetailBody(data) {
  let html = sectionHead('Last 5 games', 'newest first');
  html += data.games.length
    ? groupedTable([gameLead(data.season)], [DST_GROUP], data.games)
    : '<p class="text-xs text-gray-400 py-2">No games played yet.</p>';
  if (data.seasons.length) {
    html += sectionHead('Season totals');
    html += groupedTable(seasonLead, [{ ...DST_GROUP, cols: [...DST_GROUP.cols, { k: 'dst_share', h: 'D/ST %', fmt: pctInt }] }], data.seasons);
  }
  html += `<p class="mt-3 text-[11px] text-gray-400 leading-snug">D/ST TDs are every TD the offense didn't score:
    interception and fumble returns, kick and punt returns, blocked kicks.</p>`;
  return html;
}

// data: undefined = loading, null = failed
function renderDetail({ gs, side, team, pl, data }) {
  const teamName = side === 'home' ? currentGame.home_team : currentGame.away_team;
  let title, subtitle, tiles;
  if (!pl) {
    title = `${team.abbr} D/ST`;
    subtitle = esc(teamName);
    tiles = [
      probTile('Anytime D/ST TD', singleLegProb(gs, side, 'dst_td', null, 1)),
      detailTile('Team TD share', pct(team.dst_frac), 'model'),
      detailTile('League average', data?.league_dst_frac != null ? pct(data.league_dst_frac) : '–', 'last 3 seasons'),
    ];
  } else {
    const status = STATUS_BADGE[pl.status];
    title = esc(pl.name);
    subtitle = `<span title="${esc(slotTitle(pl))}">${slotLabel(pl)}</span> · ${esc(teamName)}`
      + (status ? ` · <span class="${status[1].split(' ')[0]}">${status[2]}${pl.status_detail ? ` — ${esc(pl.status_detail)}` : ''}</span>` : '');
    if (pl.pos === 'K') {
      tiles = [1, 2, 3].map(n => probTile(`${n}+ FG${n > 1 ? 's' : ''}`, singleLegProb(gs, side, 'fg', pl, n)));
    } else {
      tiles = [
        probTile('Anytime TD', singleLegProb(gs, side, 'anytime', pl, 1)),
        detailTile('Exp. snaps', pl.active && pl.snap_proj != null ? pctInt(pl.snap_proj) : '–'),
        detailTile('Team TD share', pl.active ? pct(pl.td_share) : '–', 'model'),
      ];
      if (pl.is_starting_qb) tiles.push(probTile('1+ pass TD', singleLegProb(gs, side, 'pass_td', pl, 1)));
    }
  }

  let body;
  if (data === undefined) {
    body = `<div class="mt-5 space-y-2">${'<span class="bsm-skeleton h-4 w-full block"></span>'.repeat(6)}</div>`;
  } else if (data === null) {
    body = '<p class="mt-5 text-sm text-gray-400 text-center">Could not load stats. Try again in a moment.</p>';
  } else {
    body = pl ? playerDetailBody(pl, data) : dstDetailBody(data);
  }

  return `
    <div class="flex items-start gap-3">
      <img src="${nflLogoUrl(teamName)}" class="w-9 h-9 object-contain shrink-0" alt="" onerror="this.style.display='none'">
      <div class="min-w-0 flex-1">
        <h2 id="nfl-detail-title" class="text-lg font-bold leading-tight truncate">${title}</h2>
        <div class="text-xs text-gray-400 mt-0.5">${subtitle}</div>
      </div>
      <button type="button" data-close-detail aria-label="Close"
              class="shrink-0 w-8 h-8 -mr-1 -mt-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 text-lg leading-none">✕</button>
    </div>
    <div class="mt-4">${tileGrid(tiles)}</div>
    ${pl && pl.pos !== 'K' ? '<p class="mt-1.5 text-[11px] text-gray-400">Prices assume the player plays.</p>' : ''}
    ${body}`;
}

async function openDetail(side, kind, id) {
  const gs = S(), game = currentGame, team = gs.playerData?.[side];
  if (!game || !team) return;
  const pl = kind === 'dst_td' ? null : findPlayer(gs, side, id);
  if (kind !== 'dst_td' && !pl) return;
  const ctx = { gs, side, team, pl };
  const seq = ++detailSeq;
  const url = pl ? apiUrl('nfl', `player_detail/${game.game_id}/${pl.id}`)
                 : apiUrl('nfl', `dst_detail/${game.game_id}/${team.team_id}`);
  detailPanel.innerHTML = renderDetail({ ...ctx, data: detailCache.get(url) });
  detailPanel.scrollTop = 0;
  detailModal.classList.remove('hidden');
  detailModal.classList.add('flex');
  document.body.style.overflow = 'hidden';
  if (detailCache.has(url)) return;

  let data = null;
  try {
    const res = await fetch(url);
    data = res.ok ? await res.json() : null;
  } catch { /* leave null */ }
  if (data) detailCache.set(url, data);
  if (seq === detailSeq) detailPanel.innerHTML = renderDetail({ ...ctx, data });
}

// =============================================================================
// LINE CONTROLS (state lives in gameState[game].lines)
// =============================================================================
function populateMarginDropdown() {
  marginValSel.innerHTML = '';
  for (let v = -50.5; v <= 50.5; v += 1) {
    const label = v === -0.5 ? 'To Win' : `${v >= 0 ? '+' : ''}${v}`;
    marginValSel.innerHTML += `<option value="${v}"${v === -0.5 ? ' selected' : ''}>${label}</option>`;
  }
}
function populateTotalDropdown(sel, max) {
  sel.innerHTML = '<option value="" disabled selected>—</option>';
  for (let n = 1; n <= max; n++) sel.innerHTML += `<option value="${n}">${n - 0.5}</option>`;
}
populateMarginDropdown();

function paintDir(btnA, btnB, activeA, activeB) {
  for (const [b, on] of [[btnA, activeA], [btnB, activeB]]) {
    b.classList.toggle('bg-blue-500', on);
    b.classList.toggle('text-white', on);
    b.classList.toggle('text-gray-400', !on);
  }
}

function syncMarginUI() {
  const L = S().lines;
  paintDir(marginDirHome, marginDirAway, L.marginTeam === 'home', L.marginTeam === 'away');
  marginValSel.disabled = !L.marginTeam;
  marginValSel.value = L.marginL != null ? String(L.marginL) : '-0.5';
}
function setMarginTeam(team) {
  const L = S().lines;
  L.marginTeam = team;
  if (team && L.marginL == null) L.marginL = -0.5;
  if (!team) L.marginL = null;
  syncMarginUI();
  recalculate();
}
marginDirHome.addEventListener('click', () => setMarginTeam(S().lines.marginTeam === 'home' ? null : 'home'));
marginDirAway.addEventListener('click', () => setMarginTeam(S().lines.marginTeam === 'away' ? null : 'away'));
marginValSel.addEventListener('change', () => { S().lines.marginL = parseFloat(marginValSel.value); recalculate(); });
marginClearBtn.addEventListener('click', () => setMarginTeam(null));

// The three over/under groups share one wiring
const totalGroups = [
  { prefix: 'total',      dir: 'totalDir',     n: 'totalN',     max: 100 },
  { prefix: 'home-total', dir: 'homeTotalDir', n: 'homeTotalN', max: 70 },
  { prefix: 'away-total', dir: 'awayTotalDir', n: 'awayTotalN', max: 70 },
].map(g => ({ ...g, over: $(`${g.prefix}-dir-over`), under: $(`${g.prefix}-dir-under`),
              sel: $(`${g.prefix}-val`), clear: $(`${g.prefix}-clear`) }));

function syncTotalUI(g) {
  const L = S().lines;
  paintDir(g.over, g.under, L[g.dir] === 'over', L[g.dir] === 'under');
  g.sel.disabled = !L[g.dir];
  g.sel.value = L[g.n] != null ? String(L[g.n]) : '';
}
for (const g of totalGroups) {
  populateTotalDropdown(g.sel, g.max);
  const setDir = d => { const L = S().lines; L[g.dir] = L[g.dir] === d ? null : d; syncTotalUI(g); recalculate(); };
  g.over.addEventListener('click', () => setDir('over'));
  g.under.addEventListener('click', () => setDir('under'));
  g.sel.addEventListener('change', () => { S().lines[g.n] = parseInt(g.sel.value, 10); recalculate(); });
  g.clear.addEventListener('click', () => { const L = S().lines; L[g.dir] = null; L[g.n] = null; syncTotalUI(g); recalculate(); });
}

function syncLineUI() {
  syncMarginUI();
  totalGroups.forEach(syncTotalUI);
}

resetMatchBtn.addEventListener('click', () => {
  if (!currentGame) return;
  const gs = S();
  const hadOverrides = gs.out.size || gs.in.size;
  const keep = gs.playerData, dists = gs.teamDists, ycache = gs.yardsCache;
  gameState[currentGame.game_id] = newGameState(currentGame.game_id);
  Object.assign(S(), { playerData: keep, teamDists: dists, yardsCache: ycache });
  syncLineUI();
  if (hadOverrides) loadPlayerData(currentGame.game_id);
  renderTeams();
  recalculate();
});
resetAllBtn.addEventListener('click', () => {
  for (const gid of Object.keys(gameState)) {
    const { playerData, teamDists, yardsCache, out, in: inn, gameId } = gameState[gid];
    gameState[gid] = newGameState(gameId);
    // keep loaded data unless overrides changed it
    if (!out.size && !inn.size) Object.assign(gameState[gid], { playerData, teamDists, yardsCache });
  }
  syncLineUI();
  if (currentGame) loadPlayerData(currentGame.game_id);
  recalculate();
});

// =============================================================================
// BETSLIP
// =============================================================================
function buildResults() {
  const results = [];
  for (const gid of Object.keys(gameState)) {
    if (!gameHasSelections(gid)) continue;
    const game = gameById(gid);
    if (!game) continue;
    const r = gameProbability(gid);
    if (!r) continue;
    const gs = S(gid);
    results.push({
      matchId: Number(gid),
      matchLabel: `${game.home_team} vs ${game.away_team}`,
      prob: r.prob,
      lineProb: r.lineProb,
      lineItems: lineLabels(game, gs.lines),
      picks: [...gs.picks.values()].map(p => {
        const pl = p.playerId != null ? findPlayer(gs, p.side, p.playerId) : null;
        return { ...p, label: legLabel(p.kind, p.name, p.n), indivProb: singleLegProb(gs, p.side, p.kind, pl, p.n) };
      }),
    });
  }
  return results;
}

function recalculate() {
  const results = buildResults();
  resetMatchBtn.disabled = !(currentGame && (gameHasSelections(currentGame.game_id)
    || S().out.size || S().in.size));
  resetAllBtn.disabled = !Object.keys(gameState).some(gameHasSelections);
  updateOptionBadges();
  renderBetslip(results);
}

function isGameStarted(gid) {
  const g = gameById(gid);
  return !!g?.date && g.has_kickoff_time && new Date(g.date).getTime() <= Date.now();
}

function renderBetslip(results) {
  if (!results.length) {
    resultDiv.innerHTML = '';
    resultDiv.classList.remove('betslip-open');
    betslipExpanded = false;
    return;
  }
  const combinedProb = results.reduce((acc, r) => acc * r.prob, 1);
  const combinedOdds = combinedProb > 0 ? (1 / combinedProb).toFixed(2) : '∞';
  const totalLegs = results.reduce((acc, r) => acc + r.picks.length + r.lineItems.length, 0);
  const isMulti = results.length > 1 || totalLegs > 1;

  const dotRow = (dot, text, italic, right) => `
    <div class="flex items-center justify-between gap-2 py-0.5">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="w-1.5 h-1.5 rounded-full ${dot} shrink-0 mt-0.5"></span>
        <span class="text-sm ${italic ? 'text-gray-300 italic' : 'text-white'} truncate">${esc(text)}</span>
      </div>
      ${right ? `<div class="text-right shrink-0"><div class="text-sm font-semibold text-gray-300">${pct(right)}</div>
                 <div class="text-xs text-gray-400">${odds(right)}</div></div>` : ''}
    </div>`;

  const legsHtml = results.map(r => {
    const lines = r.lineItems.map((l, i) => dotRow('bg-blue-400', l, true, i === r.lineItems.length - 1 ? r.lineProb : null)).join('');
    const picks = r.picks.map(p => dotRow('bg-green-400', p.label, false, p.indivProb)).join('');
    const gameOdds = results.length > 1 && (r.picks.length + r.lineItems.length) > 1
      ? `<div class="flex justify-between text-xs text-gray-400 mt-1"><span>Same game</span><span class="text-amber-400 font-semibold">${odds(r.prob)} · ${pct(r.prob)}</span></div>` : '';
    return `
      <div class="py-2.5 border-b border-gray-700/40 last:border-b-0">
        <div class="text-xs font-semibold text-gray-400 truncate mb-1.5">${esc(r.matchLabel)}</div>
        ${lines}${picks}${gameOdds}
      </div>`;
  }).join('');

  const anyStarted = results.some(r => isGameStarted(r.matchId));
  resultDiv.innerHTML = `
    <div id="betslip-toggle" class="flex items-center justify-between cursor-pointer select-none">
      <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Betslip</span>
      <div class="flex items-center gap-2">
        <span class="text-base font-bold text-amber-400">${totalLegs} leg${totalLegs !== 1 ? 's' : ''} · $${combinedOdds}</span>
        <span id="betslip-chevron" class="text-gray-400 text-xs">${betslipExpanded ? '▼' : '▲'}</span>
      </div>
    </div>
    <div id="betslip-body" class="${betslipExpanded ? '' : 'hidden'} mt-1">
      ${legsHtml}
      <div class="mt-3 pt-3 border-t border-gray-600">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-gray-300">${isMulti ? `Multi (${totalLegs} legs)` : 'Selection'}</span>
          <div class="text-right">
            <div class="text-2xl font-extrabold text-amber-400">${(combinedProb * 100).toFixed(2)}%</div>
            <div class="text-xs text-gray-400">$${combinedOdds}</div>
          </div>
        </div>
      </div>
      <div class="mt-3 pt-3 border-t border-gray-700/40">
        <div class="flex items-center gap-2">
          <label for="bookie-odds-input" class="text-xs font-semibold text-gray-400 uppercase tracking-wider shrink-0">Bookie Odds</label>
          <div class="flex items-center gap-1 flex-1">
            <span class="text-sm text-gray-400">$</span>
            <input id="bookie-odds-input" type="number" min="1.01" step="0.05" placeholder="e.g. 4.50"
                   value="${bookieOdds != null ? bookieOdds : ''}"
                   class="flex-1 min-w-0 bg-gray-800 border border-gray-600 text-white text-sm rounded px-2 py-1 focus:outline-none focus:border-amber-500/60">
          </div>
        </div>
        <p id="bookie-ev" class="text-xs mt-1 ${bookieOdds ? '' : 'text-gray-400'}">${evText(combinedProb)}</p>
      </div>
      <div class="text-xs mt-3 text-gray-400 text-center leading-tight">
        Find this useful? <a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" class="text-yellow-300 hover:underline">Buy me a coffee</a> to help pay server costs.
      </div>
    </div>
    <div class="mt-2 flex justify-center">
      <button id="save-betslip-btn" type="button" ${anyStarted ? 'disabled title="Game has started — bets are locked"' : ''}
              class="px-4 py-1.5 rounded-lg border font-semibold text-sm transition-colors ${anyStarted
                ? 'border-gray-600 text-gray-400 opacity-50 cursor-not-allowed'
                : 'border-blue-500/40 text-blue-400 hover:bg-blue-500/10'}">
        ${anyStarted ? 'Locked' : '☆ Save Betslip'}
      </button>
    </div>`;
  resultDiv.classList.toggle('betslip-open', betslipExpanded);

  resultDiv.querySelector('#betslip-toggle').addEventListener('click', () => {
    betslipExpanded = !betslipExpanded;
    resultDiv.classList.toggle('betslip-open', betslipExpanded);
    resultDiv.querySelector('#betslip-body').classList.toggle('hidden', !betslipExpanded);
    resultDiv.querySelector('#betslip-chevron').textContent = betslipExpanded ? '▼' : '▲';
  });
  const input = resultDiv.querySelector('#bookie-odds-input');
  input.addEventListener('input', () => {
    bookieOdds = input.value ? parseFloat(input.value) : null;
    const ev = resultDiv.querySelector('#bookie-ev');
    ev.innerHTML = evText(combinedProb);
    ev.className = `text-xs mt-1 ${bookieOdds ? '' : 'text-gray-400'}`;
  });
  resultDiv.querySelector('#save-betslip-btn').addEventListener('click', e => saveBetslip(e.currentTarget, results));
}

function evText(prob) {
  if (!bookieOdds || !prob) return 'Optional · compare with the model';
  const ev = (bookieOdds * prob - 1) * 100;
  return `<span class="${ev >= 0 ? 'text-green-400' : 'text-red-400'} font-semibold">${ev >= 0 ? '+' : ''}${ev.toFixed(1)}% EV</span>`;
}

function showToast(msg, linkHref, linkText) {
  let c = $('_bs-toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = '_bs-toast-container';
    c.style.cssText = 'position:fixed;bottom:5rem;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
    document.body.appendChild(c);
  }
  const t = document.createElement('div');
  t.style.cssText = 'background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:10px 16px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,0.5);pointer-events:auto;white-space:nowrap;opacity:1;transition:opacity 0.35s';
  t.innerHTML = linkHref ? `${msg} <a href="${linkHref}" style="color:#60a5fa;text-decoration:underline">${linkText || 'here'}</a>` : msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 360); }, 3000);
}

function seasonOf(game) {
  const d = new Date(game?.date || Date.now());
  return d.getMonth() < 2 ? d.getFullYear() - 1 : d.getFullYear();   // Jan/Feb games belong to last season
}

async function saveBetslip(btn, results) {
  const session = await getSession();
  if (!session) {
    showToast('Sign in to save betslips', '/pages/login.html?next=' + encodeURIComponent(window.location.pathname), 'Sign in');
    return;
  }
  if (!results.length) return;
  if (results.some(r => isGameStarted(r.matchId))) {
    showToast('Game has already started — bets are locked');
    return;
  }
  const first = gameById(results[0].matchId);

  // Picks carry everything the NFL scorer needs (kind, n, player/team) plus a
  // display label, since "name ×n" doesn't describe a pass-TD or FG leg.
  const picks = results.flatMap(r => r.picks.map(p => ({
    match_id:  r.matchId,
    id:        p.kind === 'dst_td' ? `dst-${p.teamId}` : p.playerId,
    player_id: p.playerId,
    team_id:   p.teamId,
    side:      p.side,
    kind:      p.kind,
    n:         p.n,
    name:      p.name,
    label:     p.label,
  })));
  const LEG_TYPE = { margin: 'margin1', total: 'total1', homeTotal: 'home_total', awayTotal: 'away_total' };
  const line_legs = results.flatMap(r => {
    const game = gameById(r.matchId);
    const L = S(r.matchId).lines;
    const c = buildConstraints(L);
    const labels = lineLabels(game, L);
    let i = 0;
    return Object.entries(LEG_TYPE).filter(([k]) => c[k]).map(([k, legType]) => ({
      match_id: r.matchId, leg_type: legType, ...c[k], label: labels[i++],
    }));
  });

  const combinedProb = results.reduce((acc, r) => acc * r.prob, 1);
  const payload = {
    match_ids:       results.map(r => r.matchId),
    round_number:    first?.week_number ?? currentWeek,
    season:          seasonOf(first),
    competition:     'nfl',
    match_label:     results.length === 1 ? results[0].matchLabel : `Multi (${results.length} games)`,
    picks,
    line_legs,
    calculated_prob: combinedProb > 0 ? parseFloat(combinedProb.toFixed(5)) : null,
    combined_odds:   combinedProb > 0 ? parseFloat((1 / combinedProb).toFixed(2)) : null,
    bookie_odds:     bookieOdds || null,
    is_public:       true,
  };

  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    const res = await fetch(`${BACKEND}/betslips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      btn.textContent = '★ Saved';
      btn.style.borderColor = '#22c55e';
      btn.style.color = '#4ade80';
      showToast('Betslip saved! View it on the', '/nfl/pages/betslips.html', 'community page');
      setTimeout(() => renderCommunityBetslips(currentGame?.game_id), 500);
    } else {
      const err = await res.json().catch(() => ({}));
      btn.textContent = '☆ Save Betslip';
      btn.disabled = false;
      showToast(err.error || 'Failed to save betslip');
    }
  } catch {
    btn.textContent = '☆ Save Betslip';
    btn.disabled = false;
    showToast('Failed to save betslip');
  }
}

// =============================================================================
// COMMUNITY BETSLIPS STRIP
// =============================================================================
let communityGameId = null;

function communityTile(b) {
  const items = [
    ...(b.picks || []).map(p => ({ dot: 'bg-green-400', text: p.label || (p.name + (p.n > 1 ? ` ×${p.n}` : '')) })),
    ...(b.line_legs || []).map(l => ({ dot: 'bg-blue-400', text: l.label || '' })),
  ];
  const visible = items.slice(0, 3);
  const extra = items.length - visible.length;
  const score = b.is_scored
    ? (b.won === true ? '<span class="text-green-400 text-xs font-bold" title="Won">✓</span>'
      : b.won === false ? '<span class="text-red-400 text-xs font-bold" title="Lost">✗</span>'
      : '<span class="text-gray-400 text-xs font-bold" title="Void">–</span>')
    : '<span class="text-gray-400 text-xs" title="Pending">·</span>';
  const net = b.net_votes || 0;
  const voteColor = net > 0 ? '#4ade80' : net < 0 ? '#f87171' : '#6b7280';
  return `
    <div class="shrink-0 bg-gray-800 border border-gray-700 rounded-xl p-3 flex flex-col gap-1.5" style="width:172px;scroll-snap-align:start;">
      <div class="flex items-center justify-between gap-1">
        <span class="text-xs font-semibold text-gray-200 truncate min-w-0">${esc(b.username || 'Unknown')}</span>
        <div class="flex items-center gap-1.5 shrink-0">
          ${score}
          <button data-vote-betslip="${b.id}" data-v="1" class="text-gray-400 hover:text-green-400 font-bold leading-none" style="font-size:10px;">▲</button>
          <span style="font-size:10px;font-weight:700;color:${voteColor};min-width:1rem;text-align:center;" data-community-votes="${b.id}">${net}</span>
          <button data-vote-betslip="${b.id}" data-v="-1" class="text-gray-400 hover:text-red-400 font-bold leading-none" style="font-size:10px;">▼</button>
        </div>
      </div>
      <div class="flex flex-col gap-0.5 text-xs text-gray-400 min-w-0">
        ${visible.map(it => `<span class="flex items-center gap-1 min-w-0"><span class="w-1.5 h-1.5 rounded-full ${it.dot} shrink-0"></span><span class="truncate">${esc(it.text)}</span></span>`).join('')}
        ${extra > 0 ? `<span class="text-gray-400">+${extra}</span>` : ''}
      </div>
      <div class="flex items-baseline justify-between mt-auto pt-1 border-t border-gray-700/50">
        <span class="text-sm font-extrabold text-amber-400">${b.combined_odds ? `$${b.combined_odds}` : '–'}</span>
        ${b.calculated_prob ? `<span class="text-xs text-gray-400">${(b.calculated_prob * 100).toFixed(1)}%</span>` : ''}
      </div>
    </div>`;
}

async function renderCommunityBetslips(gameId) {
  const section = $('community-betslips-section');
  const list = $('community-betslips-list');
  const link = $('community-betslips-link');
  if (!gameId) { section.classList.add('hidden'); return; }
  communityGameId = gameId;
  const sort = $('community-sort').value || 'recent';
  link.href = `/nfl/pages/betslips.html?match=${gameId}`;
  section.classList.remove('hidden');
  list.innerHTML = '<div class="text-xs text-gray-400 py-2 px-1">Loading…</div>';
  try {
    const res = await fetch(`${BACKEND}/betslips/match/${gameId}?competition=nfl&sort=${sort}&limit=5`);
    const betslips = res.ok ? await res.json() : [];
    if (communityGameId !== gameId) return;
    list.innerHTML = betslips.length
      ? betslips.map(communityTile).join('')
      : '<div class="text-xs text-gray-400 py-2 px-1 italic">No betslips saved yet — be the first!</div>';
  } catch {
    list.innerHTML = '<div class="text-xs text-gray-400 py-2 px-1">Could not load betslips.</div>';
  }
}

$('community-betslips-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-vote-betslip]');
  if (!btn) return;
  const session = await getSession();
  if (!session) {
    showToast('Sign in to vote on betslips', '/pages/login.html?next=' + encodeURIComponent(window.location.pathname), 'Sign in');
    return;
  }
  const id = btn.dataset.voteBetslip;
  try {
    const res = await fetch(`${BACKEND}/betslips/${id}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ vote: parseInt(btn.dataset.v, 10) }),
    });
    if (!res.ok) { showToast((await res.json().catch(() => ({}))).error || 'Could not vote'); return; }
    const net = (await res.json()).net_votes ?? 0;
    const el = document.querySelector(`[data-community-votes="${id}"]`);
    if (el) { el.textContent = net; el.style.color = net > 0 ? '#4ade80' : net < 0 ? '#f87171' : '#6b7280'; }
  } catch { showToast('Could not vote'); }
});
$('community-sort').addEventListener('change', () => renderCommunityBetslips(currentGame?.game_id));

// =============================================================================
// LOADING
// =============================================================================
function formatKickoff(game) {
  if (!game?.date) return '';
  const d = new Date(game.date);
  if (isNaN(d.getTime())) return '';
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (game.has_kickoff_time) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString(undefined, opts);
}

async function loadBinsForGame(gid) {
  if (binsCache[gid]) return binsCache[gid];
  try {
    const res = await fetch(apiUrl('nfl', `game_sgm_bins_range/${gid}?with_dists=1`));
    binsCache[gid] = res.ok ? ((await res.json()).bins || []) : [];
  } catch {
    binsCache[gid] = [];
  }
  return binsCache[gid];
}

async function loadPlayerData(gid) {
  const gs = S(gid);
  const seq = ++gs.loadSeq;
  const qs = new URLSearchParams();
  if (gs.out.size) qs.set('out', [...gs.out].join(','));
  if (gs.in.size)  qs.set('in',  [...gs.in].join(','));
  let data = null;
  try {
    const res = await fetch(apiUrl('nfl', `game_player_data/${gid}${qs.toString() ? '?' + qs : ''}`));
    data = res.ok ? await res.json() : null;
  } catch { /* leave null */ }
  if (seq !== gs.loadSeq) return;
  gs.playerData = data;
  gs.yardsCache = new Map();
  // Drop legs that no longer apply: a player now ruled out, a pass-TD / passing-
  // yards / FG leg whose player is no longer the projected starting QB / kicker,
  // or a yards leg when the yards model isn't available.
  for (const [k, p] of gs.picks) {
    if (p.playerId == null) continue;
    const pl = findPlayer(gs, p.side, p.playerId);
    if (!pl || !pl.active || ((p.kind === 'pass_td' || p.kind === 'pass_yds') && !pl.is_starting_qb)
        || (p.kind === 'fg' && !pl.is_kicker) || (YARDS_KINDS.has(p.kind) && !yardsReady(gs))) gs.picks.delete(k);
  }
  if (String(currentGame?.game_id) === String(gid)) renderTeams();
  recalculate();
  warmYardsLadders(gid);
}

function updateOptionBadges() {
  Array.from(gameSelect.options).forEach(opt => {
    const gs = gameState[opt.value];
    const n = gs ? gs.picks.size + lineLabels(gameById(opt.value) || {}, gs.lines).length : 0;
    const base = opt.dataset.label || opt.textContent;
    opt.dataset.label = base;
    opt.textContent = n > 0 ? `${base} (${n} leg${n !== 1 ? 's' : ''})` : base;
  });
}

async function selectGame(gid) {
  currentGame = gameById(gid);
  if (!currentGame) { builderSection.classList.add('hidden'); return; }
  const gs = S();
  builderMatchup.textContent = `${currentGame.home_team} vs ${currentGame.away_team}`;
  const wx = currentGame?.is_finished ? null : nflWeatherLabel(currentGame?.weather);
  builderKickoff.textContent = formatKickoff(currentGame) + (wx ? ` · ${wx.text}` : '');
  builderKickoff.title = wx ? wx.title : '';
  $('home-pts-label').textContent = `${currentGame.home_team} Pts`;
  $('away-pts-label').textContent = `${currentGame.away_team} Pts`;
  marginDirHome.textContent = currentGame.home_abbr || 'H';
  marginDirAway.textContent = currentGame.away_abbr || 'A';
  builderSection.classList.remove('hidden');
  syncLineUI();
  renderTeams();
  renderCommunityBetslips(currentGame.game_id);

  const loadingId = currentGame.game_id;
  loadLogs(loadingId);   // history lines fill in when it lands; prices don't wait for it
  const [bins] = await Promise.all([loadBinsForGame(loadingId), gs.playerData ? null : loadPlayerData(loadingId)]);
  if (bins.length && !gs.teamDists) {
    gs.teamDists = {
      home: { td: mixtureDist(bins, 'h_td'), fg: mixtureDist(bins, 'h_fg') },
      away: { td: mixtureDist(bins, 'a_td'), fg: mixtureDist(bins, 'a_fg') },
    };
  }
  if (currentGame?.game_id !== loadingId) return;
  renderTeams();
  recalculate();
  warmYardsLadders(loadingId);
}

gameSelect.addEventListener('change', () => selectGame(gameSelect.value));

async function loadWeek(week) {
  gameSelect.innerHTML = '';
  noGamesMsg.classList.add('hidden');
  builderSection.classList.add('hidden');
  weekBadge.textContent = `Week ${week}`;

  const res = await fetch(apiUrl('nfl', `week_predictions/${week}`));
  if (!res.ok) return;
  const json = await res.json();
  currentWeek = json.week_number ?? week;
  weekBadge.textContent = `Week ${currentWeek}`;

  // Selections from other weeks can't share a betslip (one round per betslip)
  for (const gid of Object.keys(gameState)) {
    if (!json.predictions?.some(g => String(g.game_id) === gid)) delete gameState[gid];
  }
  games = (json.predictions || []).filter(g => g.has_prediction);
  if (!games.length) {
    noGamesMsg.classList.remove('hidden');
    renderCommunityBetslips(null);
    recalculate();
    return;
  }
  gameSelect.innerHTML = games.map(g => `<option value="${g.game_id}">${esc(g.home_team)} vs ${esc(g.away_team)}</option>`).join('');
  // Default to the next game that hasn't kicked off
  const upcoming = games.find(g => !g.is_finished && !isGameStarted(g.game_id)) || games[0];
  gameSelect.value = upcoming.game_id;
  await selectGame(upcoming.game_id);
}

weekPrevBtn.addEventListener('click', () => { if (currentWeek > 1) loadWeek(currentWeek - 1); });
weekNextBtn.addEventListener('click', () => { if (currentWeek != null) loadWeek(currentWeek + 1); });

async function init() {
  const params = new URLSearchParams(window.location.search);
  const weekParam = params.get('week');
  const gameIdParam = params.get('game_id');
  if (weekParam) {
    await loadWeek(Number(weekParam));
    if (gameIdParam && gameById(gameIdParam)) {
      gameSelect.value = gameIdParam;
      selectGame(gameIdParam);
    }
    return;
  }
  const res = await fetch(apiUrl('nfl', 'current_week'));
  if (res.ok) loadWeek((await res.json()).week_number);
}

init();
