// nhl_multi_builder.js — drives nhl/pages/tryscorer_predictions.html ("Multi Builder")
// NHL counterpart to js/nfl_multi_builder.js (same layout: team cards with
// prices + steppers, line selectors, betslip). Games are paged by calendar date
// (NHL has no weeks).
//
// Lines (margin / total / team goals) filter nhl.game_sgm_bins joint score
// distributions (/api/nhl/game_sgm_bins_range). Player legs — N+ goals, N+
// assists and N+ points for any player, goalies included, and N+ shots on goal
// for skaters — come from /api/nhl/game_player_data (per-player goal / assist
// weights and shot inputs, see nrl-flask-backend/nhl_player_model.py) and are
// priced bin by bin against each team's goals, so they stay correlated with the
// lines (a goal is always a shot on goal; saved shots scale with team goals). A shootout winner's extra goal isn't scored by any player, so
// it is removed per bin (bin.so = share of the bin's sims decided by shootout).
// Selections are kept per game; the betslip multiplies across games.
import { apiUrl } from './api-config.js';
import { nhlLogoUrl } from './nhl-logos.js';

const $ = id => document.getElementById(id);

const dateBadge      = $('week-badge');
const datePrevBtn    = $('week-prev');
const dateNextBtn    = $('week-next');
const gameSelect     = $('game-select');
const noGamesMsg     = $('no-games-msg');
const builderSection = $('builder-section');
const builderMatchup = $('builder-matchup');
const builderKickoff = $('builder-kickoff');
const teamsContainer = $('teams-container');
const resultDiv      = $('result');
const resetMatchBtn  = $('reset-match-btn');
const resetAllBtn    = $('reset-all-btn');

const marginDirHome  = $('margin-dir-home');
const marginDirAway  = $('margin-dir-away');
const marginValSel   = $('margin-val');
const marginClearBtn = $('margin-clear');

let allGames       = [];   // every game in the window (selections can span dates)
let games          = [];   // games on the selected date
let dateKeys       = [];
let gamesByDate    = {};
let currentDateIdx = 0;
let currentGame    = null;
const binsCache    = {};   // game_id -> bins[] ({m, t, c, so})
const gameState    = {};   // game_id -> per-game selections, see newGameState()
let betslipExpanded = false;
let bookieOdds     = null;

// No fixed caps: goals / assists / points go up to the most player goals the
// team scores in any bin (beyond that the model gives exactly 0); shots on goal
// have an open-ended tail, so the stepper just stops at SOG_MAX.
const SOG_MAX = 20;
const KINDS = ['goal', 'assist', 'point', 'sog'];
const SCORER_KINDS = new Set(['goal', 'point', 'sog']);
const ASSISTER_KINDS = new Set(['assist', 'point']);
const TOP_N = { F: 9, D: 4 };   // listed before "Show more" (all expected goalies always shown)
const EXCLUDED = ['out', 'ir', 'ltir', 'suspended'];

function newGameState() {
  return {
    lines: { marginTeam: null, marginL: null, totalDir: null, totalN: null,
             homeTotalDir: null, homeTotalN: null, awayTotalDir: null, awayTotalN: null },
    picks: new Map(),          // key -> { side, kind, playerId, teamId, name, n }
    out: new Set(), in: new Set(),
    showAll: { home: false, away: false },
    playerData: null,          // /api/nhl/game_player_data for this game's overrides
    teamDists: null,           // { home: [P(n player goals)], away: [...] } — from the bins
    loadSeq: 0,
  };
}
const S = (gid = currentGame?.game_id) => (gameState[gid] ||= newGameState());
const gameById = gid => allGames.find(g => String(g.game_id) === String(gid));

// --- FORMATTING ---
const pct  = p => (p == null ? '–' : `${(p * 100).toFixed(1)}%`);
const odds = p => (p > 1e-6 ? (p < 0.001 ? '$1000+' : `$${(1 / p).toFixed(2)}`) : '–');   // goalie goals are ~1 in 1500
const esc  = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const mmss = sec => (sec == null ? '–' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);
const minFmt = min => (min == null ? '–' : mmss(Math.round(min * 60)));
const pctInt = v => (v == null ? '–' : `${Math.round(v * 100)}%`);
const pct1 = v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
const POS_LABEL = { C: 'C', L: 'LW', R: 'RW', D: 'D', G: 'G' };
function lineToN(L) { return Math.floor(-L) + 1; }

// =============================================================================
// PROBABILITY ENGINE (mirrors nhl_player_model.build_atoms; DP as NFL)
// =============================================================================
// One team goal: a scorer s drawn by goal weight, then 0/1/2 assisters drawn
// without replacement from s's teammates by assist weight × affinity(s → j), with
// P(0/1/2 assists) = team.assist_dist. Only whether each PICKED assister is among
// them matters, so outcomes are exact over singles and pairs. Picked players are
// assumed to play (void otherwise); everyone else is weighted by p_play (goalies:
// start probability). Returns [{p, cred}] with cred = credited pick indices.
function buildAtoms(team, teamPicks) {
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
function pickSuccessByN(atoms, mins, maxN, weights = null) {
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
function negbinSf(m, mu, r) {
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

function sogParams(gs) { return gs.playerData?.sog_params || { dispersion: null, gamma: 0 }; }

function sogTailTable(gs, side, pl, k, maxN) {
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

function binomPmf(n, p, j) {
  let c = 1;
  for (let i = 0; i < j; i++) c = c * (n - i) / (i + 1);
  return c * Math.pow(p, j) * Math.pow(1 - p, n - j);
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

// A bin pins the final score; its shootout share (so) belongs one goal lower
// for the winner — that goal wasn't scored by a player.
function binGoals(b) {
  const h = (b.t + b.m) / 2, a = (b.t - b.m) / 2;
  return { h, a, hSo: h - (b.m > 0 ? 1 : 0), aSo: a - (b.m < 0 ? 1 : 0), so: b.so || 0 };
}

function playerGoalDists(bins) {
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
const legShare = (kind, pl) => (kind === 'goal' || kind === 'sog' ? pl.goal_share
  : kind === 'assist' ? pl.assist_share : pl.goal_share + pl.assist_share);

// Unconditional single-leg probability (whole game, no lines) — the table prices.
function singleLegProb(gs, side, kind, pl, n) {
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
function maxLegN(gs, side, kind) {
  if (kind === 'sog') return SOG_MAX;
  const dist = gs.teamDists?.[side];
  if (dist?.length) return Math.max(1, dist.length - 1);
  const d = gs.playerData?.[side]?.goal_dist;
  return d ? Math.max(1, ...Object.keys(d).map(Number)) : 10;
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
  if (L.totalDir && L.totalN != null) out.push(`Total Goals ${L.totalDir === 'over' ? 'Over' : 'Under'} ${L.totalN - 0.5}`);
  if (L.homeTotalDir && L.homeTotalN != null) out.push(`${game.home_team} ${L.homeTotalDir === 'over' ? 'Over' : 'Under'} ${L.homeTotalN - 0.5}`);
  if (L.awayTotalDir && L.awayTotalN != null) out.push(`${game.away_team} ${L.awayTotalDir === 'over' ? 'Over' : 'Under'} ${L.awayTotalN - 0.5}`);
  return out;
}

function legLabel(kind, name, n) {
  if (kind === 'goal') return n === 1 ? `${name} Anytime Goal` : `${name} ${n}+ Goals`;
  if (kind === 'point') return `${name} ${n}+ Point${n > 1 ? 's' : ''}`;
  if (kind === 'sog') return `${name} ${n}+ Shot${n > 1 ? 's' : ''} on Goal`;
  return `${name} ${n}+ Assist${n > 1 ? 's' : ''}`;
}

// Joint probability of one game's line filters + player legs, bin by bin.
function gameProbability(gid) {
  const gs = S(gid), bins = binsCache[gid];
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

function gameHasSelections(gid) {
  const gs = gameState[gid];
  return !!gs && (gs.picks.size > 0 || lineLabels(gameById(gid) || {}, gs.lines).length > 0);
}

// =============================================================================
// TEAM CARDS
// =============================================================================
const STATUS_BADGE = {
  'day-to-day': ['DTD', 'text-yellow-300 border-yellow-500/40 bg-yellow-500/10', 'Day-to-day'],
  out:          ['OUT', 'text-red-300 border-red-500/40 bg-red-500/10', 'Out'],
  ir:           ['IR', 'text-red-300 border-red-500/40 bg-red-500/10', 'Injured reserve'],
  ltir:         ['LTIR', 'text-red-300 border-red-500/40 bg-red-500/10', 'Long-term injured reserve'],
  suspended:    ['SUSP', 'text-red-300 border-red-500/40 bg-red-500/10', 'Suspended'],
};

function stepperHtml(key, val, max) {
  const base = 'w-6 h-6 border rounded flex items-center justify-center text-sm font-bold transition-colors';
  const minus = val > 0 ? `${base} border-red-500 text-red-400 hover:bg-red-500/20` : `${base} border-gray-700 text-gray-600`;
  const plus = val >= max ? `${base} border-gray-700 text-gray-600`
    : val > 0 ? `${base} border-green-500 text-green-400 hover:bg-green-500/20`
              : `${base} border-gray-600 text-gray-400 hover:border-green-400 hover:text-green-400`;
  return `
    <div class="flex items-center gap-0.5 shrink-0">
      <button type="button" class="${minus}" data-step="-1" data-key="${key}">−</button>
      <span class="w-5 text-center text-sm font-bold text-white select-none">${val}</span>
      <button type="button" class="${plus}" data-step="1" data-key="${key}">+</button>
    </div>`;
}

// One market (goals or assists) inside a player row: label, price, stepper.
function marketCell(gs, side, kind, pl) {
  const key = `${side}:${kind}:${pl.id}`;
  const picked = gs.picks.get(key);
  const val = picked ? picked.n : 0;
  const n = Math.max(1, val);
  const p = singleLegProb(gs, side, kind, pl, n);
  const loading = binsCache[currentGame?.game_id] === undefined;
  const noun = { goal: 'Goal', assist: 'Assist', point: 'Point', sog: 'SOG' }[kind];
  const label = kind === 'sog' ? `${n}+ SOG` : `${n > 1 ? `${n}+ ` : ''}${noun}${n > 1 ? 's' : ''}`;
  const price = p == null
    ? (loading ? '<span class="bsm-skeleton h-3 w-12 block mt-0.5"></span>' : '<span class="text-gray-400">–</span>')
    : `<span class="text-gray-200 font-semibold">${odds(p)}</span> <span class="text-gray-400">${pct(p)}</span>`;
  return `
    <div class="flex items-center justify-between gap-1 rounded-md px-1.5 py-1 min-w-0
                ${val > 0 ? 'bg-green-500/10 ring-1 ring-green-500/40' : 'bg-gray-900/40'}">
      <div class="leading-tight min-w-0">
        <div class="text-[10px] uppercase tracking-wider text-gray-400">${label}</div>
        <div class="text-xs whitespace-nowrap">${price}</div>
      </div>
      ${stepperHtml(key, val, maxLegN(gs, side, kind))}
    </div>`;
}

function statusBadge(pl) {
  const b = STATUS_BADGE[pl.status];
  if (!b) return '';
  const title = [b[2], pl.status_detail].filter(Boolean).join(' — ');
  return `<span class="shrink-0 px-1 rounded border text-[10px] font-bold ${b[1]}" title="${esc(title)}">${b[0]}</span>`;
}

// "C · L1 · PP1": position (flagging a recent move) and deployment read off the
// last game's ice time — the NHL publishes no line combinations.
function roleLabel(pl) {
  const pos = POS_LABEL[pl.pos] || pl.pos;
  const recent = POS_LABEL[pl.recent_pos] || pl.recent_pos;
  const parts = [recent && recent !== pos ? `${pos}→${recent}` : pos];
  if (pl.pos !== 'G' && pl.line) parts.push(`${pl.pos === 'D' ? 'P' : 'L'}${pl.line}`);
  if (pl.pp_unit) parts.push(`PP${pl.pp_unit}`);
  return parts.join(' · ');
}
const roleTitle = pl => {
  const bits = [];
  if (pl.recent_pos && pl.recent_pos !== pl.pos) bits.push(`Listed ${POS_LABEL[pl.pos] || pl.pos}, mostly played ${POS_LABEL[pl.recent_pos] || pl.recent_pos} over the last 5`);
  if (pl.line) bits.push(`${pl.pos === 'D' ? 'Pair' : 'Line'} ${pl.line} by even-strength ice time last game`);
  if (pl.pp_unit) bits.push(`PP unit ${pl.pp_unit} by power-play ice time last game`);
  return bits.join('. ');
};

// Last-5 form: one box per game played, newest first. Missing games (fewer than
// 5 played) are dashed. Boxes stretch to fill a grid column (capped at 16px) so
// G / A / S always fit on one line and line up from row to row.
function formStrip(counts = [], labels = [], unit = 'goal', tag = 'G') {
  const base = 'flex items-center justify-center h-4 rounded-sm text-[10px] font-semibold';
  const boxes = [];
  for (let i = 0; i < 5; i++) {
    const n = counts?.[i];
    if (n == null) { boxes.push(`<span class="${base} border border-dashed border-gray-700"></span>`); continue; }
    const tip = `${labels?.[i] || 'Game'}: ${n} ${unit}${n === 1 ? '' : 's'}`;
    boxes.push(`<span class="${base} ${n > 0 ? 'bg-green-500/20 text-green-300' : 'bg-gray-700/50 text-gray-400'}" title="${esc(tip)}">${n}</span>`);
  }
  return `<span class="flex items-center gap-[3px] min-w-0"><span class="w-2 shrink-0 text-center" title="${unit[0].toUpperCase() + unit.slice(1)}s in the last 5 games played, newest first">${tag}</span>
    <span class="grid grid-cols-5 gap-px flex-1 max-w-[5.25rem]">${boxes.join('')}</span></span>`;
}

// Lead cell (TOI / start chance) sits in the meta grid's fixed first column
const metaLead = html => `<span class="whitespace-nowrap overflow-hidden">${html}</span>`;

function playerMeta(pl) {
  const s = pl.stats || {};
  let lead;
  if (pl.pos === 'G') {
    lead = `<span title="Chance to start, from recent starts (and back-to-backs). Prices assume he starts.">Start</span> <span class="text-gray-300 font-semibold">${pctInt(pl.start_prob)}</span>`;
  } else {
    const tip = pl.active && pl.toi_proj != null
      ? `Projected ice time: ${minFmt(pl.ev_toi_proj)} even strength, ${minFmt(pl.pp_toi_proj)} power play, ${minFmt(pl.sh_toi_proj)} short-handed`
      : 'Projected ice time';
    lead = `<span title="${esc(tip)}">TOI <span class="text-gray-300 font-semibold">${pl.active ? minFmt(pl.toi_proj) : '–'}</span></span>`;
  }
  return metaLead(lead)
    + formStrip(s.recent_goals, s.recent_games, 'goal', 'G')
    + formStrip(s.recent_assists, s.recent_games, 'assist', 'A')
    + (pl.pos !== 'G' ? formStrip(s.recent_sog, s.recent_games, 'shot', 'S') : '');
}

function availButton(pl, forcedStarter = false) {
  if (pl.pos === 'G' && pl.active) {
    return forcedStarter
      ? `<button type="button" data-avail="${pl.id}" data-make="auto" title="Back to the model's start chances"
                 class="text-[10px] text-gray-400 hover:text-gray-300">↺ auto</button>`
      : `<button type="button" data-avail="${pl.id}" data-make="start" title="Set as tonight's starter"
                 class="text-[10px] text-blue-400 hover:text-blue-300">★ starts</button>`;
  }
  return pl.active
    ? `<button type="button" data-avail="${pl.id}" data-make="out" title="Mark as not playing — redistributes their ice time"
               class="text-[10px] text-gray-400 hover:text-red-400">✕ out</button>`
    : `<button type="button" data-avail="${pl.id}" data-make="in" title="Mark as playing"
               class="text-[10px] text-blue-400 hover:text-blue-300">+ in</button>`;
}

const hasPick = (gs, side, pl) => KINDS.some(k => gs.picks.has(`${side}:${k}:${pl.id}`));

function playerRow(gs, side, pl) {
  const picked = hasPick(gs, side, pl);
  const badges = statusBadge(pl)
    + (pl.overridden ? '<span class="shrink-0 text-[10px] text-blue-300">manual</span>' : '')
    + (pl.pos !== 'G' && !pl.expected
      ? `<span class="shrink-0 text-[10px] text-gray-400" title="Dresses in about ${Math.round((pl.p_play ?? 0) * 100)}% of games on recent form — price assumes he plays">unlikely</span>` : '');
  return `
    <div class="group py-2 px-1 player-row cursor-pointer hover:bg-gray-700/25${picked ? ' bg-gray-700/40' : ''}" data-detail="${side}:${pl.id}">
      <div class="flex items-center gap-1 min-w-0">
        <span class="text-sm truncate group-hover:underline decoration-gray-500 decoration-dotted underline-offset-2">${esc(pl.name)}</span>
        <span class="text-xs text-gray-400 min-w-0 truncate shrink-[3]" title="${esc(roleTitle(pl))}">(${roleLabel(pl)})</span>${badges}
        <span class="ml-auto shrink-0 pl-1">${availButton(pl, gs.in.has(pl.id))}</span>
      </div>
      <div class="grid grid-cols-2 gap-1.5 mt-1.5">
        ${marketCell(gs, side, 'goal', pl)}${marketCell(gs, side, 'assist', pl)}
        ${marketCell(gs, side, 'point', pl)}${pl.pos !== 'G' ? marketCell(gs, side, 'sog', pl) : ''}
      </div>
      <div class="grid grid-cols-[3.75rem_repeat(3,minmax(0,1fr))] items-center gap-x-1.5 mt-1.5 text-[11px] text-gray-400 leading-none">${playerMeta(pl)}</div>
    </div>`;
}

function ruledOutRow(side, pl) {
  return `
    <div class="flex items-center gap-1 py-2 px-1 opacity-60 cursor-pointer hover:bg-gray-700/25" data-detail="${side}:${pl.id}">
      <span class="text-sm line-through truncate">${esc(pl.name)}</span>
      <span class="text-xs text-gray-400 shrink-0">(${POS_LABEL[pl.pos] || pl.pos})</span>${statusBadge(pl)}
      <span class="ml-auto shrink-0">${availButton(pl)}</span>
    </div>`;
}

// Mean of the team's player-goal distribution (shootout winner's goal excluded)
function expectedGoals(gs, side) {
  const arr = gs.teamDists?.[side];
  if (arr?.length) return arr.reduce((s, p, n) => s + n * p, 0);
  const d = gs.playerData?.[side]?.goal_dist;
  if (d) return Object.entries(d).reduce((s, [n, p]) => s + Number(n) * p, 0);
  return null;
}

const sectionLabel = (title, right = true) => `
  <div class="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider mt-3 mb-0.5 px-1">
    <span class="flex-1">${title}</span>${right ? '<span class="text-[10px] normal-case tracking-normal text-gray-400">tap a player for stats</span>' : ''}
  </div>`;

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
    const isPicked = pl => hasPick(gs, side, pl);
    const shown = [], hidden = [];
    for (const grp of ['F', 'D']) {
      const list = team.players.filter(pl => pl.group === grp && pl.active)
        .sort((a, b) => (b.goal_share + 0.5 * b.assist_share) - (a.goal_share + 0.5 * a.assist_share));
      const top = list.filter(pl => pl.expected).slice(0, TOP_N[grp]);
      shown.push(...list.filter(pl => top.includes(pl) || isPicked(pl)));
      hidden.push(...list.filter(pl => !top.includes(pl) && !isPicked(pl)));
    }
    const goalies = team.players.filter(pl => pl.group === 'G' && pl.active)
      .sort((a, b) => (b.start_prob ?? 0) - (a.start_prob ?? 0));
    const shownG = goalies.filter(pl => pl.expected || isPicked(pl));
    hidden.push(...goalies.filter(pl => !shownG.includes(pl)));
    const ruledOut = team.players.filter(pl => !pl.active);

    const rows = list => `<div class="flex flex-col divide-y divide-gray-700/50">${list.map(pl => playerRow(gs, side, pl)).join('')}</div>`;
    const showAll = gs.showAll[side];
    const moreCount = hidden.length + ruledOut.length;
    const ast = team.assist_dist || [];
    body = `
      ${sectionLabel('Forwards')}${rows(shown.filter(pl => pl.group === 'F'))}
      ${sectionLabel('Defence', false)}${rows(shown.filter(pl => pl.group === 'D'))}
      ${shownG.length ? `${sectionLabel('Goalies', false)}${rows(shownG)}` : ''}
      ${moreCount ? `
        <button type="button" data-showall="${side}"
                class="w-full mt-1 px-2 py-1.5 text-xs text-gray-400 hover:text-gray-300 text-left">
          ${showAll ? '▾ Hide' : '▸ Show'} ${moreCount} more (depth players, unlikely to dress or ruled out)
        </button>
        ${showAll ? `<div class="flex flex-col divide-y divide-gray-700/50">
          ${hidden.map(pl => playerRow(gs, side, pl)).join('')}${ruledOut.map(pl => ruledOutRow(side, pl)).join('')}</div>` : ''}` : ''}
      <p class="mt-3 text-[11px] text-gray-400 leading-snug">
        Prices assume the player dresses (goalies: starts) — bets on players who don't are void.
        Team goals are split by projected ice time × goal / assist rates per 60; a point is a goal or an assist.
        Shots on goal = his goals plus saved shots around expected goals ÷ shooting %.
        ${ast.length ? `Assists per goal: ${pctInt(ast[2])} two, ${pctInt(ast[1])} one, ${pctInt(ast[0])} none.` : ''}
        ${team.played_yesterday ? ' <span class="text-amber-400/80">Played last night (back-to-back).</span>' : ''}
      </p>`;
  }

  const xg = expectedGoals(gs, side);
  card.innerHTML = `
    <div class="flex items-center justify-between mb-1">
      <div class="flex items-center gap-2 min-w-0">
        <img src="${nhlLogoUrl(teamName)}" class="w-8 h-8 object-contain shrink-0" alt="" onerror="this.style.display='none'">
        <div class="min-w-0">
          <div class="font-bold text-base truncate">${esc(teamName)}</div>
          <div class="text-xs text-gray-400" title="Mean goals scored by players (excludes a shootout winner's extra goal)">Expected goals:
            <span class="font-semibold text-amber-400">${xg != null ? xg.toFixed(2) : '–'}</span></div>
        </div>
      </div>
      <button type="button" data-clear="${side}" class="text-xs text-gray-400 hover:text-white border border-gray-600 hover:border-gray-400 px-2 py-1 rounded transition-colors">Clear</button>
    </div>
    ${body}`;
  return card;
}

function renderTeams() {
  if (!currentGame) return;
  teamsContainer.innerHTML = '';
  teamsContainer.appendChild(renderTeamCard(currentGame, 'home'));
  teamsContainer.appendChild(renderTeamCard(currentGame, 'away'));
}

function findPlayer(gs, side, id) {
  return gs.playerData?.[side]?.players.find(p => String(p.id) === String(id)) || null;
}

teamsContainer.addEventListener('click', e => {
  if (!currentGame) return;
  const gs = S();
  const step = e.target.closest('[data-step]');
  if (step) {
    const key = step.dataset.key;
    const [side, kind, id] = key.split(':');
    const cur = gs.picks.get(key)?.n || 0;
    const n = Math.max(0, Math.min(maxLegN(gs, side, kind), cur + Number(step.dataset.step)));
    if (n === 0) {
      gs.picks.delete(key);
    } else {
      const pl = findPlayer(gs, side, id);
      if (!pl) return;
      gs.picks.set(key, { side, kind, n, playerId: pl.id, teamId: gs.playerData[side].team_id, name: pl.name });
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
    gs.showAll[showAll.dataset.showall] = !gs.showAll[showAll.dataset.showall];
    renderTeams();
    return;
  }
  const avail = e.target.closest('[data-avail]');
  if (avail) {
    const id = Number(avail.dataset.avail);
    const make = avail.dataset.make;
    const side = findPlayer(gs, 'home', id) ? 'home' : 'away';
    const pl = findPlayer(gs, side, id);
    gs.out.delete(id); gs.in.delete(id);
    if (make === 'auto') {
      // overrides already cleared above
    } else if (make === 'start') {
      // One starter per team: clear any other forced goalie on this side
      for (const g of gs.playerData[side].players.filter(p => p.pos === 'G')) gs.in.delete(g.id);
      gs.in.add(id);
    } else {
      const syncedActive = !EXCLUDED.includes(pl?.status);
      const makeIn = make === 'in';
      if (makeIn !== syncedActive) (makeIn ? gs.in : gs.out).add(id);
    }
    loadPlayerData(currentGame.game_id);
    return;
  }
  const detail = e.target.closest('[data-detail]');
  if (detail && !e.target.closest('button')) {
    const [side, id] = detail.dataset.detail.split(':');
    openDetail(side, id);
  }
});

// =============================================================================
// STATS WINDOW (last 5 games, recent / season averages, season totals and
// shares of team scoring from /api/nhl/player_detail; model numbers come from
// game_player_data)
// =============================================================================
const detailModal = document.createElement('div');
detailModal.className = 'fixed inset-0 hidden items-end sm:items-center justify-center bg-black/60 sm:p-4';
detailModal.style.zIndex = '1200';   // above the site header (1100) and betslip
detailModal.innerHTML = `
  <div role="dialog" aria-modal="true" aria-labelledby="nhl-detail-title"
       class="bg-gray-800 border border-gray-700 w-full sm:max-w-2xl max-h-[88vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-2xl p-4"></div>`;
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

// Table with fixed lead columns (game / season ...) then grouped stat columns.
// flat: one header row, no group labels.
function groupedTable(lead, groups, rows, { flat = false } = {}) {
  const th = 'px-1.5 py-1 font-semibold text-gray-400 text-center whitespace-nowrap';
  const sep = 'border-l border-gray-700';
  const twoRows = !flat && groups.length > 0;
  const leadHead = lead.map(c => `<th ${twoRows ? 'rowspan="2"' : ''} class="${th} ${c.left ? 'text-left' : ''} align-bottom">${c.h}</th>`).join('');
  const groupHead = groups.map(g => `<th colspan="${g.cols.length}" class="${th} ${sep} text-[10px] uppercase tracking-wider">${g.label || ''}</th>`).join('');
  const subHead = groups.map(g => g.cols.map((c, i) => `<th class="${th}${i ? '' : ` ${sep}`}"${c.title ? ` title="${esc(c.title)}"` : ''}>${c.h}</th>`).join('')).join('');
  const cell = (c, r, i) => {
    const v = r[c.k];
    const txt = c.fmt ? c.fmt(v, r) : (v ?? 0);
    const tone = c.hi && v > 0 ? 'text-green-400 font-semibold' : v ? 'text-gray-200' : 'text-gray-400';
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

const detailTile = (label, value, sub = '') => `
  <div class="bg-gray-900/60 border border-gray-700 rounded-lg px-2 py-2 text-center min-w-0">
    <div class="text-[10px] uppercase tracking-wider text-gray-400 leading-tight">${label}</div>
    <div class="text-base font-bold text-white mt-0.5">${value}</div>
    ${sub ? `<div class="text-[11px] text-gray-400">${sub}</div>` : ''}
  </div>`;
const tileGrid = tiles => `<div class="grid gap-2 grid-cols-2 sm:grid-cols-4">${tiles.join('')}</div>`;
const probTile = (label, p) => detailTile(label, p > 1e-6 ? odds(p) : '–', p > 1e-6 ? pct(p) : '');
const sectionHead = (title, note = '') => `
  <div class="flex items-baseline justify-between gap-2 mt-5 mb-1">
    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">${title}</h3>
    ${note ? `<span class="text-[11px] text-gray-400">${note}</span>` : ''}
  </div>`;

const num2 = v => (v == null ? '–' : Number(v).toFixed(2));
const signed = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${Number.isInteger(v) ? v : Number(v).toFixed(2)}`);
const svp = v => (v == null ? '–' : Number(v).toFixed(3).replace(/^0/, ''));

const gameLead = { h: 'Game', left: true, cell: g => `<span class="text-gray-300">${esc(g.label)}</span>` };
const roleLead = { h: 'Pos', cell: g => {
  const pos = POS_LABEL[g.pos] || g.pos || '–';
  return g.role ? `<span title="Position · line (by EV ice time) · PP unit">${pos} <span class="text-gray-400">${esc(g.role)}</span></span>` : pos;
} };
const seasonName = s => `${s}-${String(s + 1).slice(2)}`;

// Skater column groups
const SK_GAME_GROUPS = [
  { label: 'Ice time', cols: [{ k: 'toi_s', h: 'TOI', fmt: mmss }, { k: 'pp_toi_s', h: 'PP', fmt: mmss, title: 'Power-play ice time' }] },
  { label: 'Scoring', cols: [{ k: 'sog', h: 'SOG', title: 'Shots on goal' }, { k: 'goals', h: 'G', hi: true }, { k: 'assists', h: 'A', hi: true },
                             { k: 'plus_minus', h: '+/-', fmt: signed }] },
  { label: 'Power play', cols: [{ k: 'pp_goals', h: 'PPG', hi: true }, { k: 'pp_assists', h: 'PPA', hi: true }] },
];
const SK_AVG_GROUPS = [
  { label: 'Per game', cols: [{ k: 'toi_s', h: 'TOI', fmt: mmss }, { k: 'pp_toi_s', h: 'PP', fmt: mmss },
                              { k: 'sog', h: 'SOG', fmt: num2 }, { k: 'goals', h: 'G', fmt: num2 }, { k: 'assists', h: 'A', fmt: num2 },
                              { k: 'pp_points', h: 'PPP', fmt: num2, title: 'Power-play points' }, { k: 'plus_minus', h: '+/-', fmt: signed }] },
  { label: 'Rates', cols: [{ k: 'sh_pct', h: 'Sh%', fmt: pct1, title: 'Shooting % (goals / shots on goal)' },
                           { k: 'g60', h: 'G/60', fmt: num2 }, { k: 'a60', h: 'A/60', fmt: num2 }] },
];
const SK_SEASON_GROUPS = [
  { label: 'Totals', cols: [{ k: 'goals', h: 'G', hi: true }, { k: 'assists', h: 'A', hi: true }, { k: 'points', h: 'P' },
                            { k: 'sog', h: 'SOG' }, { k: 'sh_pct', h: 'Sh%', fmt: pct1 }, { k: 'plus_minus', h: '+/-', fmt: signed }] },
  { label: 'Power play', cols: [{ k: 'pp_goals', h: 'PPG' }, { k: 'pp_assists', h: 'PPA' }] },
];
const SK_SHARE_COLS = [
  { k: 'goal_share', h: 'Goals', fmt: pct1, title: 'Share of the team\'s goals in games he played' },
  { k: 'assist_share', h: 'Assists', fmt: pct1, title: 'Share of the team\'s goals he assisted' },
  { k: 'point_share', h: 'Points', fmt: pct1, title: 'Share of the team\'s goals he scored or assisted' },
  { k: 'pp_goal_share', h: 'PP goals', fmt: pct1 },
  { k: 'pp_point_share', h: 'PP pts', fmt: pct1, title: 'Share of the team\'s power-play goals he scored or assisted' },
  { k: 'pp_toi_share', h: 'PP time', fmt: pctInt, title: 'Share of the team\'s power-play time he was on the ice' },
];
// Goalie column groups
const G_GAME_GROUPS = [{ label: 'Goaltending', cols: [
  { k: 'decision', h: 'Dec', fmt: v => v || '–' }, { k: 'shots_against', h: 'SA' }, { k: 'saves', h: 'SV' },
  { k: 'goals_against', h: 'GA' }, { k: 'sv', h: 'SV%', fmt: (v, r) => svp(r.shots_against ? r.saves / r.shots_against : null) },
  { k: 'goals', h: 'G', hi: true }, { k: 'assists', h: 'A', hi: true }] }];
const G_AVG_GROUPS = [{ label: 'Per game', cols: [
  { k: 'starts', h: 'GS' }, { k: 'shots_against', h: 'SA', fmt: num2 }, { k: 'saves', h: 'SV', fmt: num2 },
  { k: 'goals_against', h: 'GA', fmt: num2 }, { k: 'sv_pct', h: 'SV%', fmt: svp }, { k: 'gaa', h: 'GAA', fmt: num2 }] }];
const G_SEASON_GROUPS = [{ label: 'Totals', cols: [
  { k: 'starts', h: 'GS' }, { k: 'wins', h: 'W' }, { k: 'shots_against', h: 'SA' }, { k: 'saves', h: 'SV' },
  { k: 'goals_against', h: 'GA' }, { k: 'sv_pct', h: 'SV%', fmt: svp }, { k: 'gaa', h: 'GAA', fmt: num2 },
  { k: 'goals', h: 'G', hi: true }, { k: 'assists', h: 'A', hi: true }] }];

function playerDetailBody(pl, data) {
  const g = data.is_goalie;
  let html = sectionHead('Last 5 games', 'newest first');
  html += data.games.length
    ? groupedTable(g ? [gameLead] : [gameLead, roleLead], g ? G_GAME_GROUPS : SK_GAME_GROUPS, data.games)
    : '<p class="text-xs text-gray-400 py-2">No NHL games played yet.</p>';
  if (data.averages?.length) {
    html += sectionHead('Recent vs season averages');
    html += groupedTable([{ h: '', left: true, cell: a => `<span class="text-gray-300">${a.label}</span>` }, { h: 'GP', cell: a => a.games }],
                         g ? G_AVG_GROUPS : SK_AVG_GROUPS, data.averages);
  }
  if (data.seasons.length) {
    const lead = [{ h: 'Season', left: true, cell: s => `<span class="text-gray-300">${seasonName(s.season)}</span>` },
                  { h: 'GP', cell: s => s.games }];
    html += sectionHead('Season totals');
    html += groupedTable(lead, g ? G_SEASON_GROUPS : SK_SEASON_GROUPS, data.seasons);
    html += sectionHead('Share of team', 'in games he played');
    html += groupedTable([lead[0]], [{ cols: g ? [SK_SHARE_COLS[1]] : SK_SHARE_COLS }], data.seasons, { flat: true });
  }
  html += `<p class="mt-3 text-[11px] text-gray-400 leading-snug">${g
    ? 'Last 5 counts only games he dressed for.'
    : 'Line / pair (L1–L4, P1–P3) and PP unit are read off each game\'s even-strength and power-play ice time — the NHL publishes no line combinations. Last 5 counts only games he played.'}</p>`;
  return html;
}

// data: undefined = loading, null = failed
function renderDetail({ gs, side, pl, data }) {
  const teamName = side === 'home' ? currentGame.home_team : currentGame.away_team;
  const status = STATUS_BADGE[pl.status];
  const subtitle = `<span title="${esc(roleTitle(pl))}">${roleLabel(pl)}</span> · ${esc(teamName)}`
    + (status ? ` · <span class="${status[1].split(' ')[0]}">${status[2]}${pl.status_detail ? ` — ${esc(pl.status_detail)}` : ''}</span>` : '');
  const tiles = [
    probTile('Anytime goal', singleLegProb(gs, side, 'goal', pl, 1)),
    probTile('1+ assist', singleLegProb(gs, side, 'assist', pl, 1)),
    probTile('1+ point', singleLegProb(gs, side, 'point', pl, 1)),
    probTile('2+ points', singleLegProb(gs, side, 'point', pl, 2)),
  ];
  if (pl.pos === 'G') {
    tiles.push(detailTile('Start chance', pctInt(pl.start_prob), gs.playerData[side].played_yesterday ? 'back-to-back' : 'recent starts'));
    tiles.push(detailTile('Team assist share', pl.active ? pct(pl.assist_share) : '–', 'model, per goal'));
  } else {
    tiles.push(detailTile('Proj. TOI', pl.active ? minFmt(pl.toi_proj) : '–',
                          pl.active ? `${minFmt(pl.ev_toi_proj)} EV · ${minFmt(pl.pp_toi_proj)} PP` : ''));
    tiles.push(detailTile('Model G / A per 60', pl.active ? `${num2(pl.g60)} / ${num2(pl.a60)}` : '–', 'at projected TOI'));
    tiles.push(detailTile('Team goal share', pl.active ? pct(pl.goal_share) : '–', 'model, per goal'));
    tiles.push(detailTile('Team assist share', pl.active ? pct(pl.assist_share) : '–', 'model, per goal'));
    tiles.push(probTile('2+ goals', singleLegProb(gs, side, 'goal', pl, 2)));
    tiles.push(probTile('2+ assists', singleLegProb(gs, side, 'assist', pl, 2)));
    tiles.push(detailTile('Proj. shots on goal', pl.active && pl.sog_mean != null ? num2(pl.sog_mean) : '–',
                          pl.sh_pct_est != null ? `model sh% ${pct1(pl.sh_pct_est)}` : ''));
    tiles.push(probTile('3+ SOG', singleLegProb(gs, side, 'sog', pl, 3)));
  }

  let body;
  if (data === undefined) {
    body = `<div class="mt-5 space-y-2">${'<span class="bsm-skeleton h-4 w-full block"></span>'.repeat(6)}</div>`;
  } else if (data === null) {
    body = '<p class="mt-5 text-sm text-gray-400 text-center">Could not load stats. Try again in a moment.</p>';
  } else {
    body = playerDetailBody(pl, data);
  }

  return `
    <div class="flex items-start gap-3">
      <img src="${nhlLogoUrl(teamName)}" class="w-9 h-9 object-contain shrink-0" alt="" onerror="this.style.display='none'">
      <div class="min-w-0 flex-1">
        <h2 id="nhl-detail-title" class="text-lg font-bold leading-tight truncate">${esc(pl.name)}</h2>
        <div class="text-xs text-gray-400 mt-0.5">${subtitle}</div>
      </div>
      <button type="button" data-close-detail aria-label="Close"
              class="shrink-0 w-8 h-8 -mr-1 -mt-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 text-lg leading-none">✕</button>
    </div>
    <div class="mt-4">${tileGrid(tiles)}</div>
    <p class="mt-1.5 text-[11px] text-gray-400">Prices assume he ${pl.pos === 'G' ? 'starts' : 'plays'}. Shares are of team goals, split by projected ice time × per-60 rates.</p>
    ${body}`;
}

async function openDetail(side, id) {
  const gs = S(), game = currentGame;
  const pl = findPlayer(gs, side, id);
  if (!game || !pl) return;
  const ctx = { gs, side, pl };
  const seq = ++detailSeq;
  const url = apiUrl('nhl', `player_detail/${game.game_id}/${pl.id}`);
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
  for (let v = -10.5; v <= 10.5; v += 1) {
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
  { prefix: 'total',      dir: 'totalDir',     n: 'totalN',     max: 15 },
  { prefix: 'home-total', dir: 'homeTotalDir', n: 'homeTotalN', max: 9 },
  { prefix: 'away-total', dir: 'awayTotalDir', n: 'awayTotalN', max: 9 },
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
  const keep = gs.playerData, dists = gs.teamDists;
  gameState[currentGame.game_id] = newGameState();
  Object.assign(S(), { playerData: keep, teamDists: dists });
  syncLineUI();
  if (hadOverrides) loadPlayerData(currentGame.game_id);
  renderTeams();
  recalculate();
});
resetAllBtn.addEventListener('click', () => {
  for (const gid of Object.keys(gameState)) {
    const { playerData, teamDists, out, in: inn } = gameState[gid];
    gameState[gid] = newGameState();
    if (!out.size && !inn.size) Object.assign(gameState[gid], { playerData, teamDists });
  }
  syncLineUI();
  if (currentGame) loadPlayerData(currentGame.game_id);
  renderTeams();
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
        const pl = findPlayer(gs, p.side, p.playerId);
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
}

function evText(prob) {
  if (!bookieOdds || !prob) return 'Optional · compare with the model';
  const ev = (bookieOdds * prob - 1) * 100;
  return `<span class="${ev >= 0 ? 'text-green-400' : 'text-red-400'} font-semibold">${ev >= 0 ? '+' : ''}${ev.toFixed(1)}% EV</span>`;
}

// =============================================================================
// LOADING
// =============================================================================
function formatPuckDrop(game) {
  if (!game?.date) return '';
  const d = new Date(game.date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const formatDay = iso => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

async function loadBinsForGame(gid) {
  if (binsCache[gid]) return binsCache[gid];
  try {
    const res = await fetch(apiUrl('nhl', `game_sgm_bins_range/${gid}?with_dists=1`));
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
    const res = await fetch(apiUrl('nhl', `game_player_data/${gid}${qs.toString() ? '?' + qs : ''}`));
    data = res.ok ? await res.json() : null;
  } catch { /* leave null */ }
  if (seq !== gs.loadSeq) return;
  gs.playerData = data;
  // Drop legs on a player now ruled out
  for (const [k, p] of gs.picks) {
    const pl = findPlayer(gs, p.side, p.playerId);
    if (!pl || !pl.active) gs.picks.delete(k);
  }
  if (String(currentGame?.game_id) === String(gid)) renderTeams();
  recalculate();
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
  builderKickoff.textContent = formatPuckDrop(currentGame);
  $('home-pts-label').textContent = `${currentGame.home_team} Goals`;
  $('away-pts-label').textContent = `${currentGame.away_team} Goals`;
  marginDirHome.textContent = currentGame.home_abbr || 'H';
  marginDirAway.textContent = currentGame.away_abbr || 'A';
  builderSection.classList.remove('hidden');
  syncLineUI();
  renderTeams();

  const loadingId = currentGame.game_id;
  const [bins] = await Promise.all([loadBinsForGame(loadingId), gs.playerData ? null : loadPlayerData(loadingId)]);
  if (bins.length && !gs.teamDists) gs.teamDists = playerGoalDists(bins);
  if (currentGame?.game_id !== loadingId) return;
  renderTeams();
  recalculate();
}

gameSelect.addEventListener('change', () => selectGame(gameSelect.value));

function renderCurrentDate(preferGameId = null) {
  const key = dateKeys[currentDateIdx];
  gameSelect.innerHTML = '';
  noGamesMsg.classList.add('hidden');
  builderSection.classList.add('hidden');
  datePrevBtn.disabled = currentDateIdx <= 0;
  dateNextBtn.disabled = currentDateIdx >= dateKeys.length - 1;

  if (!key) {
    dateBadge.textContent = 'No games';
    noGamesMsg.classList.remove('hidden');
    return;
  }
  games = (gamesByDate[key] || []).filter(g => g.has_prediction);
  dateBadge.textContent = formatDay(gamesByDate[key]?.[0]?.date) || key;
  if (!games.length) {
    noGamesMsg.classList.remove('hidden');
    recalculate();
    return;
  }
  gameSelect.innerHTML = games.map(g => `<option value="${g.game_id}">${esc(g.home_team)} vs ${esc(g.away_team)}</option>`).join('');
  const pick = (preferGameId && games.find(g => String(g.game_id) === String(preferGameId)))
    || games.find(g => !g.is_finished && new Date(g.date).getTime() > Date.now()) || games[0];
  gameSelect.value = pick.game_id;
  updateOptionBadges();
  selectGame(pick.game_id);
}

datePrevBtn.addEventListener('click', () => { if (currentDateIdx > 0) { currentDateIdx -= 1; renderCurrentDate(); } });
dateNextBtn.addEventListener('click', () => { if (currentDateIdx < dateKeys.length - 1) { currentDateIdx += 1; renderCurrentDate(); } });

async function init() {
  let preds = [];
  try {
    const res = await fetch(apiUrl('nhl', 'upcoming_predictions?days=14'));
    if (res.ok) preds = (await res.json()).predictions || [];
  } catch { /* empty */ }
  allGames = preds;
  gamesByDate = {};
  for (const g of allGames) {
    const d = new Date(g.date);
    if (isNaN(d.getTime())) continue;
    (gamesByDate[d.toDateString()] ||= []).push(g);
  }
  dateKeys = Object.keys(gamesByDate).sort((a, b) => new Date(a) - new Date(b));

  const gameIdParam = new URLSearchParams(window.location.search).get('game_id');
  const today = new Date(new Date().toDateString());
  const todayIdx = dateKeys.findIndex(k => new Date(k) >= today);
  currentDateIdx = todayIdx >= 0 ? todayIdx : Math.max(0, dateKeys.length - 1);
  if (gameIdParam) {
    const idx = dateKeys.findIndex(k => gamesByDate[k].some(g => String(g.game_id) === gameIdParam));
    if (idx >= 0) currentDateIdx = idx;
  }
  renderCurrentDate(gameIdParam);
}

init();
