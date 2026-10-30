// nfl-sgm-engine.js — the NFL Multi Builder's probability engine, pure (no
// DOM): nfl_multi_builder.js prices its betslip with it, and the Best Bets
// Multi Generator (sgm-legs.js, in multi-gen-worker.js) its Same Game Multis.
// A game's bins (/api/nfl/game_sgm_bins_range?with_dists=1: final margin m,
// total t, count c, each team's TD and FG count distributions) pin the score;
// line legs filter them, TD legs are priced against each team's TDs in a bin
// and yards legs against its yards there. A game state gs carries the bins as
// gs.bins. The backend's tests/test_nfl_js_mirror.py runs the part between
// the PROBABILITY ENGINE and LINES markers under Node against
// nfl_player_model.py: keep both.

export function lineToN(L) { return Math.floor(-L) + 1; }

// =============================================================================
// PROBABILITY ENGINE (mirrors nfl_player_model.build_atoms / pick_success_by_n)
// =============================================================================
// Every team TD is exactly one of: a D/ST TD, a rush TD by player i, or a pass TD
// from the starting QB to receiver r. A pass TD credits the receiver's anytime
// pick AND the QB's pass-TD pick — never the QB's anytime pick. Shares are
// conditional on the player playing: picked players are assumed to play (bets on
// a player who sits out are void); everyone else is weighted by p_play.
export function buildAtoms(team, teamPicks) {
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

// Does DP state st (counts capped at mins) win every pick? An Under pick wins
// while its count stays below its min (Under 1.5 pass TDs: min 2, count < 2).
export function legsHit(st, mins, unders, idx) {
  return idx.every(i => (st[i] >= mins[i]) !== !!unders?.[i]);
}

// S[n] = P(every pick wins | team scores n TDs); DP with counts capped at mins.
export function pickSuccessByN(atoms, mins, maxN, unders = null) {
  const target = mins.join(','), all = mins.map((_, i) => i);
  return pickStatesByN(atoms, mins, maxN).map(state => {
    if (!unders?.some(Boolean)) return state.get(target) || 0;
    let s = 0;
    for (const [key, sp] of state) if (legsHit(key.split(',').map(Number), mins, unders, all)) s += sp;
    return s;
  });
}

export function atLeast(arr, k) {
  let s = 0;
  for (let n = k; n < arr.length; n++) s += arr[n] || 0;
  return s;
}

export function binomAtLeast(n, p, k) {
  if (k <= 0) return 1;
  if (n < k) return 0;
  let below = 0, c = 1;
  for (let j = 0; j < k; j++) {
    below += c * Math.pow(p, j) * Math.pow(1 - p, n - j);
    c = c * (n - j) / (j + 1);
  }
  return Math.max(0, 1 - below);
}

export function mixtureDist(bins, key) {
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
export const YARDS_KINDS = new Set(['pass_yds', 'rush_yds', 'rec_yds']);
export const YARDS_TEAM_KIND = { pass_yds: 'pass', rec_yds: 'pass', rush_yds: 'rush' };
export const GH_X = [-4.1445471861258945, -2.8024858612875416, -1.636519042435108, -0.5390798113513751,
  0.5390798113513751, 1.636519042435108, 2.8024858612875416, 4.1445471861258945];
export const GH_W = [0.00011261453837536762, 0.009635220120788256, 0.11723990766175904, 0.3730122576790773,
  0.3730122576790773, 0.11723990766175904, 0.009635220120788256, 0.00011261453837536762];
export const LANCZOS = [76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];

export function lgamma(x) {
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of LANCZOS) { y += 1; ser += c / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// Regularised upper incomplete gamma Q(a, x)
export function gammaQ(a, x) {
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

export function gammaSf(x, mean, shape) {
  if (x <= 0) return 1;
  if (mean <= 0) return 0;
  return gammaQ(shape, x * shape / mean);
}

export function teamYardsBase(tp, kind, n, points, margin, terms) {
  const c = tp[kind].coef, clip = tp.margin_clip;
  const m = Math.min(Math.max(margin, -clip), clip);
  let mu = c.intercept + c.td * n + c.other_pts * (points - 7 * n)
    + c.trail * Math.min(m, 0) + c.lead * Math.max(m, 0);
  for (const t of terms) mu += c[t] || 0;
  return Math.max(mu, tp.floor);
}

export function pickYardsShare(yp, kind, pl) {
  if (kind === 'pass_yds') return pl.is_starting_qb ? yp.player.pass_yds.share : 0;
  return kind === 'rush_yds' ? pl.rush_yds_share : pl.rec_yds_share;
}

export function yardsPickSpec(yp, kind, pos, share) {
  const pp = yp.player[kind];
  return [pp.beta_share * share, pp.beta_td, pp.scale[pos] ?? pp.scale.default];
}

// w[c][y] = P(player yards >= line | team yards y, c credited TDs), y = 0..grid max
// (under: P(yards < line), its complement). An incomplete gamma a cell, so
// the tables are kept per yards params (the last YARDS_TABLES_MAX built):
// every price of a multi with the leg in it reads the same one.
const yardsTables = new WeakMap();
const YARDS_TABLES_MAX = 400;
export function yardsWeightTable(yp, kind, pos, share, line, under = false) {
  let cache = yardsTables.get(yp);
  if (!cache) yardsTables.set(yp, (cache = new Map()));
  const key = `${kind}|${pos}|${share}|${line}|${under ? 1 : 0}`;
  let table = cache.get(key);
  if (!table) {
    if (cache.size >= YARDS_TABLES_MAX) cache.clear();
    table = buildYardsWeightTable(yp, kind, pos, share, line, under);
    cache.set(key, table);
  }
  return table;
}

function buildYardsWeightTable(yp, kind, pos, share, line, under) {
  const [a, b, scale] = yardsPickSpec(yp, kind, pos, share);
  const yMax = yp.grid_max[YARDS_TEAM_KIND[kind]];
  const out = [];
  for (let c = 0; c <= yp.td_cap; c++) {
    const row = new Array(yMax + 1);
    for (let y = 0; y <= yMax; y++) {
      const mean = a * y + b * c;
      const sf = gammaSf(line - 0.5, mean, mean / scale);
      row[y] = under ? 1 - sf : sf;
    }
    out.push(row);
  }
  return out;
}

export function interp(row, y) {
  if (y <= 0) return row[0];
  const top = row.length - 1;
  if (y >= top) return row[top];
  const i = Math.floor(y), f = y - i;
  return row[i] + f * (row[i + 1] - row[i]);
}

// [[weight, Y_pass, Y_rush]] quadrature over the team's lognormal yards
export function teamYardsNodes(yp, muPass, muRush, needPass, needRush) {
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
export function pickStatesByN(atoms, mins, maxN) {
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
// where every other pick won (reached its minimum, or stayed under it).
export function yardsKeyDists(statesByN, picks, yardIdx) {
  const others = picks.map((_, i) => i).filter(i => !yardIdx.includes(i));
  const mins = picks.map(p => p.n), unders = picks.map(p => !!p.under);
  return statesByN.map(state => {
    const d = new Map();
    for (const [key, sp] of state) {
      const st = key.split(',').map(Number);
      if (!legsHit(st, mins, unders, others)) continue;
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
// A pick's chance at a node depends only on its credited TDs (c), so each is
// read off its table once per c (into scratch: sidePricer's, reused bin to
// bin), not once per DP state.
export function sideYardsFactor(yp, ctx, keyDists, tdDist, tables, kinds, points, margin, scratch = yardsScratch(yp, kinds)) {
  const tp = yp.team;
  const needP = kinds.some(k => YARDS_TEAM_KIND[k] === 'pass');
  const needR = kinds.some(k => YARDS_TEAM_KIND[k] === 'rush');
  const K = kinds.length, C = yp.td_cap + 1, { vals, done, pass } = scratch;
  let total = 0;
  tdDist.forEach((pn, n) => {
    if (!pn || n >= keyDists.length || !keyDists[n].size) return;
    const muP = needP ? teamYardsBase(tp, 'pass', n, points, margin, ctx.terms) * Math.exp(ctx.adj_pass) : 0;
    const muR = needR ? teamYardsBase(tp, 'rush', n, points, margin, ctx.terms) * Math.exp(ctx.adj_rush) : 0;
    const nodes = teamYardsNodes(yp, muP, muR, needP, needR);
    const N = nodes.length;
    done.fill(0);
    let s = 0;
    for (const { c, p } of keyDists[n].values()) {
      for (let i = 0; i < K; i++) {
        const row = i * C + c[i];
        if (done[row]) continue;
        done[row] = 1;
        for (let j = 0; j < N; j++) vals[row * 64 + j] = interp(tables[i][c[i]], pass[i] ? nodes[j][1] : nodes[j][2]);
      }
      let e = 0;
      for (let j = 0; j < N; j++) {
        let f = nodes[j][0];
        for (let i = 0; i < K; i++) f *= vals[(i * C + c[i]) * 64 + j];
        e += f;
      }
      s += p * e;
    }
    total += pn * s;
  });
  return total;
}

// sideYardsFactor's working space for one team's yards picks (64: the most
// quadrature nodes, teamYardsNodes)
function yardsScratch(yp, kinds) {
  const rows = kinds.length * (yp.td_cap + 1);
  return { vals: new Float64Array(rows * 64), done: new Uint8Array(rows), pass: kinds.map(k => YARDS_TEAM_KIND[k] === 'pass') };
}

// Everything bin-independent for one team's legs: returns (bin, side) -> factor.
// teamPicks use { kind, playerId, n, under } (n = TD count, or the yardage line;
// under: the leg wins below n instead of at n or more).
export function sidePricer(yp, team, ctx, teamPicks, maxN) {
  const yardIdx = teamPicks.map((p, i) => (YARDS_KINDS.has(p.kind) ? i : -1)).filter(i => i >= 0);
  const mins = teamPicks.map((p, i) => (yardIdx.includes(i) ? yp.td_cap : p.n));
  const states = pickStatesByN(buildAtoms(team, teamPicks), mins, maxN);
  const byId = new Map(team.players.map(p => [p.id, p]));
  const kinds = yardIdx.map(i => teamPicks[i].kind);
  const tables = yardIdx.map(i => {
    const pl = byId.get(teamPicks[i].playerId);
    return yardsWeightTable(yp, teamPicks[i].kind, pl.pos, pickYardsShare(yp, teamPicks[i].kind, pl), teamPicks[i].n,
                            !!teamPicks[i].under);
  });
  const keyDists = yardsKeyDists(states, teamPicks, yardIdx);
  const scratch = yardsScratch(yp, kinds);
  return (b, side) => {
    const margin = side === 'home' ? b.m : -b.m;
    return sideYardsFactor(yp, ctx, keyDists, b[side === 'home' ? 'h_td' : 'a_td'] || [1], tables, kinds,
                           (b.t + margin) / 2, margin, scratch);
  };
}

// Count-weighted price of one team's legs over a set of bins (mirrors
// nfl_player_model.side_bin_probability).
export function sideBinProbability(yp, team, ctx, teamPicks, bins, side) {
  const key = side === 'home' ? 'h_td' : 'a_td';
  const maxN = Math.max(0, ...bins.map(b => (b[key] || [1]).length - 1));
  const price = sidePricer(yp, team, ctx, teamPicks, maxN);
  let num = 0, den = 0;
  for (const b of bins) { num += b.c * price(b, side); den += b.c; }
  return den ? num / den : 0;
}

export const yardsReady = gs => !!(gs.playerData?.yards_params && gs.playerData.home?.yards && gs.playerData.away?.yards);

// Whole-game price of one yards leg (no lines), cached per player data + bins.
// On its own an Under is exactly the Over's complement (both assume he plays).
export function singleYardsProb(gs, side, kind, pl, line, under = false) {
  if (under) {
    const p = singleYardsProb(gs, side, kind, pl, line);
    return p == null ? null : 1 - p;
  }
  const bins = gs.bins;
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
export function expectedYards(gs, side, kind, pl) {
  const bins = gs.bins;
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
export function defaultYardsLine(gs, side, kind, pl) {
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
export function medianYards(gs, side, kind, pl) {
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
export function legAtomP(team, kind, player) {
  if (kind === 'anytime') return player.td_share;
  if (kind === 'pass_td') return player.pass_td_share;
  if (kind === 'dst_td')  return team.dst_frac;
  return 0;
}

// Unconditional single-leg probability (whole game, no lines) — the table prices.
export function singleLegProb(gs, side, kind, player, n, under = false) {
  if (YARDS_KINDS.has(kind)) return singleYardsProb(gs, side, kind, player, n, under);
  if (!gs.teamDists || !gs.playerData) return null;
  const d = gs.teamDists[side];
  let s;
  if (kind === 'fg') s = atLeast(d.fg, n);
  else {
    const p = legAtomP(gs.playerData[side], kind, player);
    s = 0;
    d.td.forEach((pn, k) => { s += pn * binomAtLeast(k, p, n); });
  }
  return under ? 1 - s : s;
}

// --- LINES ---
export function buildConstraints(L) {
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

export function filterBins(bins, c) {
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

export function findPlayer(gs, side, id) {
  return gs.playerData?.[side]?.players.find(p => String(p.id) === String(id)) || null;
}

// A team's legs priced per bin like sidePricer, each bin's value kept in
// gs.sideMemo (a Map, the Multi Generator's) by the legs, so pricing many
// multis prices each set of a team's legs in each bin once. Built for every
// bin of the game, so any line filter reads the same values.
function memoPricer(gs, side, team, picks) {
  const key = `${side}|${picks.map(p => `${p.kind}:${p.playerId}:${p.n}:${p.under ? 1 : 0}`).sort().join(';')}`;
  let m = gs.sideMemo.get(key);
  if (!m) {
    const tdKey = side === 'home' ? 'h_td' : 'a_td';
    const maxN = Math.max(0, ...gs.bins.map(b => (b[tdKey] || [1]).length - 1));
    m = { price: sidePricer(gs.playerData.yards_params, team, team.yards, picks, maxN),
          at: new Float64Array(gs.bins.length).fill(NaN) };
    gs.sideMemo.set(key, m);
  }
  return (b, sd) => {
    const i = gs.binIndex.get(b);
    if (Number.isNaN(m.at[i])) m.at[i] = m.price(b, sd);
    return m.at[i];
  };
}

// Joint probability of one game's line filters + player legs, bin by bin.
// gs: { lines, picks: Map of picks, playerData, bins, yardsCache, and
// optionally sideMemo + binIndex (Map bin -> its index in gs.bins): see
// memoPricer }; bins: the game's.
export function gameProbabilityOf(gs, bins) {
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
        pricer = gs.sideMemo ? memoPricer(gs, side, team, tdPicks)
          : sidePricer(gs.playerData.yards_params, team, team.yards, tdPicks, maxN);
      } else {
        Sn = pickSuccessByN(buildAtoms(team, tdPicks), tdPicks.map(p => p.n), maxN, tdPicks.map(p => !!p.under));
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
