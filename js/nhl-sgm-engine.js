// nhl-sgm-engine.js — the NHL Multi Builder's probability engine, pure (no
// DOM): nhl_multi_builder.js prices its betslip with it, and the Best Bets
// Multi Generator (sgm-legs.js, in multi-gen-worker.js) its Same Game Multis.
// A game's bins (/api/nhl/game_sgm_bins_range: final margin m, total t,
// count c, shootout share so) pin the score; line legs filter them and player
// legs are priced against each team's goals in a bin. The backend's
// tests/test_nhl_js_mirror.py runs the part from SOG_MAX to the LINES marker
// under Node against nhl_player_model.py: keep both.

// No fixed caps: goals / assists / points go up to the most player goals the
// team scores in any bin (beyond that the model gives exactly 0); shots on goal
// have an open-ended tail, so the stepper just stops at SOG_MAX.
export const SOG_MAX = 20;
export const SCORER_KINDS = new Set(['goal', 'point', 'sog']);
export const ASSISTER_KINDS = new Set(['assist', 'point']);
export function lineToN(L) { return Math.floor(-L) + 1; }

// =============================================================================
// PROBABILITY ENGINE (mirrors nhl_player_model.build_atoms; DP as NFL)
// =============================================================================
// One team goal: a scorer s drawn by goal weight, then 0/1/2 assisters drawn
// without replacement from s's teammates by assist weight × affinity(s → j), with
// P(0/1/2 assists) = team.assist_dist. Only whether each PICKED assister is among
// them matters, so outcomes are exact over singles and pairs. Picked players are
// assumed to play (void otherwise); everyone else is weighted by p_play (goalies:
// start probability). Returns [{p, cred}] with cred = credited pick indices.
export function buildAtoms(team, teamPicks) {
  // A goal credits the scorer's goal / point / SOG picks and each assister's
  // assist / point picks.
  const goalIdx = new Map(), astIdx = new Map();
  const push = (m, id, i) => { if (!m.has(id)) m.set(id, []); m.get(id).push(i); };
  teamPicks.forEach((pk, i) => {
    if (SCORER_KINDS.has(pk.kind)) push(goalIdx, pk.playerId, i);
    if (ASSISTER_KINDS.has(pk.kind)) push(astIdx, pk.playerId, i);
  });
  const units = [];
  for (const pl of team.players) {
    if (!pl.active) continue;
    const part = goalIdx.has(pl.id) || astIdx.has(pl.id) ? 1 : (pl.p_play ?? 0);
    if (part > 0) units.push({ id: pl.id, part, g: pl.goal_w, a: pl.assist_w });
  }
  for (const r of team.replacement || []) units.push({ id: null, part: r.p, g: r.goal_w, a: r.assist_w });

  const gTot = units.reduce((s, u) => s + u.part * u.g, 0);
  if (gTot <= 0) return [{ p: 1, cred: [] }];
  const [, p1, p2] = team.assist_dist;
  const affinity = team.affinity || {};
  const atoms = new Map();
  const add = (cred, p) => {
    if (p <= 0) return;
    const c = [...cred].sort((x, y) => x - y);
    const key = c.join(',');
    const a = atoms.get(key) || { p: 0, cred: c };
    a.p += p;
    atoms.set(key, a);
  };

  units.forEach((s, si) => {
    if (s.g <= 0) return;
    const pScore = s.part * s.g / gTot;
    const base = s.id != null ? (goalIdx.get(s.id) || []) : [];
    const aff = s.id != null ? (affinity[String(s.id)] || {}) : {};
    const pool = [];
    units.forEach((u, ui) => { if (ui !== si) pool.push({ id: u.id, w: u.part * u.a * (u.id != null ? (aff[String(u.id)] ?? 1) : 1) }); });
    const W = pool.reduce((t, x) => t + x.w, 0);
    if (W <= 0) { add(base, pScore); return; }
    let Ssum = 0;
    for (const x of pool) if (W - x.w > 1e-15) Ssum += x.w / (W - x.w);
    const cand = pool.filter(x => x.id != null && astIdx.has(x.id) && x.w > 0);
    const singles = new Map();
    for (const x of cand) {
      const own = W - x.w > 1e-15 ? x.w / (W - x.w) : 0;
      const inTwo = Math.min(1, x.w / W * (1 + Ssum - own));
      singles.set(x.id, p1 * x.w / W + p2 * inTwo);
    }
    const pairs = [];
    for (let i = 0; i < cand.length; i++) {
      for (let k = i + 1; k < cand.length; k++) {
        const a = cand[i], b = cand[k];
        let pr = 0;
        if (W - a.w > 1e-15) pr += a.w / W * b.w / (W - a.w);
        if (W - b.w > 1e-15) pr += b.w / W * a.w / (W - b.w);
        pairs.push({ a: a.id, b: b.id, p: p2 * pr });
      }
    }
    let none = 1;
    for (const x of cand) {
      const only = singles.get(x.id) - pairs.reduce((t, pr) => t + (pr.a === x.id || pr.b === x.id ? pr.p : 0), 0);
      if (only > 0) { add([...base, ...astIdx.get(x.id)], pScore * only); none -= only; }
    }
    for (const pr of pairs) {
      if (pr.p > 0) { add([...base, ...astIdx.get(pr.a), ...astIdx.get(pr.b)], pScore * pr.p); none -= pr.p; }
    }
    if (none > 0) add(base, pScore * none);
  });
  return [...atoms.values()];
}

// S[n] = P(every pick reaches its min | team's players score n goals); DP with counts capped at mins.
// weights[i] (shots-on-goal picks): table w[n][c] = P(pick hits | n team goals, c credited to it).
export function pickSuccessByN(atoms, mins, maxN, weights = null) {
  const target = mins.join(',');
  const weighted = weights && weights.some(w => w);
  let state = new Map([[mins.map(() => 0).join(','), 1]]);
  const out = [];
  for (let n = 0; n <= maxN; n++) {
    if (!weighted) {
      out.push(state.get(target) || 0);
    } else {
      let tot = 0;
      for (const [key, sp] of state) {
        const st = key.split(',').map(Number);
        let f = sp;
        for (let i = 0; i < mins.length && f > 0; i++) {
          f *= weights[i] ? weights[i][n][st[i]] : (st[i] >= mins[i] ? 1 : 0);
        }
        tot += f;
      }
      out.push(tot);
    }
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

// --- shots on goal (mirrors nhl_player_model.negbin_sf / sog_tail_table) ---
// SOG = the player's goals (from the atoms) + saved shots X, X ~ negative
// binomial with mean sog_mu_x × (n / E[n])^gamma when his team scores n.
export function negbinSf(m, mu, r) {
  if (m <= 0) return 1;
  if (mu <= 0) return 0;
  let below = 0;
  if (r == null) {
    let p = Math.exp(-mu);
    for (let x = 0; x < m; x++) { below += p; p *= mu / (x + 1); }
  } else {
    const q = mu / (r + mu);
    let p = Math.pow(r / (r + mu), r);
    for (let x = 0; x < m; x++) { below += p; p *= (x + r) / (x + 1) * q; }
  }
  return Math.max(0, 1 - below);
}

export function sogParams(gs) { return gs.playerData?.sog_params || { dispersion: null, gamma: 0 }; }

export function sogTailTable(gs, side, pl, k, maxN) {
  const { dispersion, gamma } = sogParams(gs);
  const expN = gs.playerData?.[side]?.exp_skater_goals || 0;
  const out = [];
  for (let n = 0; n <= maxN; n++) {
    const mu = (pl.sog_mu_x || 0) * (gamma && expN > 0 ? Math.pow(n / expN, gamma) : 1);
    const row = [];
    for (let c = 0; c <= k; c++) row.push(negbinSf(k - c, mu, dispersion));
    out.push(row);
  }
  return out;
}

export function binomPmf(n, p, j) {
  let c = 1;
  for (let i = 0; i < j; i++) c = c * (n - i) / (i + 1);
  return c * Math.pow(p, j) * Math.pow(1 - p, n - j);
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

// A bin pins the final score; its shootout share (so) belongs one goal lower
// for the winner — that goal wasn't scored by a player.
export function binGoals(b) {
  const h = (b.t + b.m) / 2, a = (b.t - b.m) / 2;
  return { h, a, hSo: h - (b.m > 0 ? 1 : 0), aSo: a - (b.m < 0 ? 1 : 0), so: b.so || 0 };
}

export function playerGoalDists(bins) {
  const total = bins.reduce((s, b) => s + (b.c || 0), 0) || 1;
  const home = [], away = [];
  const put = (arr, n, p) => { arr[n] = (arr[n] || 0) + p; };
  for (const b of bins) {
    const g = binGoals(b), w = b.c / total;
    put(home, g.h, w * (1 - g.so)); put(home, g.hSo, w * g.so);
    put(away, g.a, w * (1 - g.so)); put(away, g.aSo, w * g.so);
  }
  for (const arr of [home, away]) for (let i = 0; i < arr.length; i++) arr[i] = arr[i] || 0;
  return { home, away };
}

// P(the player is credited with a given team goal | he plays) for this market
// (a point is a goal or an assist, never both on one goal).
export const legShare = (kind, pl) => (kind === 'goal' || kind === 'sog' ? pl.goal_share
  : kind === 'assist' ? pl.assist_share : pl.goal_share + pl.assist_share);

// Unconditional single-leg probability (whole game, no lines) — the table prices.
export function singleLegProb(gs, side, kind, pl, n) {
  if (!pl || !gs.playerData) return null;
  let dist = gs.teamDists?.[side];
  if (!dist?.length) {
    const d = gs.playerData[side]?.goal_dist;
    if (!d) return null;
    dist = [];
    for (const [k, p] of Object.entries(d)) dist[Number(k)] = p;
  }
  const share = legShare(kind, pl);
  let s = 0;
  if (kind === 'sog') {
    if (pl.sog_mu_x == null) return null;
    const tail = sogTailTable(gs, side, pl, n, dist.length - 1);
    dist.forEach((pn, k) => {
      if (!pn) return;
      for (let g = 0; g <= k; g++) s += pn * binomPmf(k, share, g) * tail[k][Math.min(g, n)];
    });
    return s;
  }
  dist.forEach((pn, k) => { if (pn) s += pn * binomAtLeast(k, share, n); });
  return s;
}

// Highest N worth offering for a market: goals / assists / points can't
// exceed the team's player goals in any bin; SOG has an open tail.
export function maxLegN(gs, side, kind) {
  if (kind === 'sog') return SOG_MAX;
  const dist = gs.teamDists?.[side];
  if (dist?.length) return Math.max(1, dist.length - 1);
  const d = gs.playerData?.[side]?.goal_dist;
  return d ? Math.max(1, ...Object.keys(d).map(Number)) : 10;
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

// Joint probability of one game's line filters + player legs, bin by bin.
// gs: { lines, picks: Map of picks, playerData, teamDists }; bins: the game's.
export function gameProbabilityOf(gs, bins) {
  if (!bins?.length) return null;
  const totalCount = bins.reduce((s, b) => s + (b.c || 0), 0) || 1;
  const filtered = filterBins(bins, buildConstraints(gs.lines));
  const lineProb = filtered.reduce((s, b) => s + b.c, 0) / totalCount;
  const Sn = {};
  for (const side of ['home', 'away']) {
    const team = gs.playerData?.[side];
    const sidePicks = [...gs.picks.values()].filter(p => p.side === side);
    Sn[side] = null;
    if (sidePicks.length && team) {
      const maxN = Math.max(0, ...filtered.map(b => (side === 'home' ? binGoals(b).h : binGoals(b).a)));
      const weights = sidePicks.map(p => (p.kind === 'sog'
        ? sogTailTable(gs, side, findPlayer(gs, side, p.playerId) || {}, p.n, maxN) : null));
      Sn[side] = pickSuccessByN(buildAtoms(team, sidePicks), sidePicks.map(p => p.n), maxN, weights);
    }
  }
  const at = (side, n) => (Sn[side] ? (n >= 0 ? (Sn[side][n] || 0) : 0) : 1);
  let num = 0;
  for (const b of filtered) {
    const g = binGoals(b);
    num += b.c * ((1 - g.so) * at('home', g.h) * at('away', g.a) + g.so * at('home', g.hSo) * at('away', g.aSo));
  }
  return { prob: num / totalCount, lineProb };
}
