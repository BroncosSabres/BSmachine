// sgm-legs.js — the Best Bets Multi Generator's Same Game Multi legs. A pool
// row (/api/best_bets/pool) becomes a Multi Builder leg by the builders' own
// rules (their bestBetLeg), and the chance a set of legs all win comes from
// the sport's engine (nhl-sgm-engine.js / nfl-sgm-engine.js), so legs keep
// their correlation: line legs filter the game's score bins, player legs are
// priced against their team's goals / TDs (and yards) in each bin. Pure (no
// DOM): the page maps rows here, multi-gen-worker.js prices the multis.
//
// Not legs: the NHL 60-minute three-way result and totals settled on 60
// minutes (the engines' scores are final), whole and quarter lines (the
// builders' are half points), an NHL prop's Under, NFL passing props for
// anyone but the starting QB, and players the game's player data doesn't
// list as active.
import * as NHL from './nhl-sgm-engine.js';
import * as NFL from './nfl-sgm-engine.js';

const ENGINES = { nhl: NHL, nfl: NFL };
const PROP_LEGS = { nhl: { assists: 'assist', points: 'point' },
                    nfl: { pass_yds: 'pass_yds', pass_tds: 'pass_td', rec_yds: 'rec_yds', rush_yds: 'rush_yds' } };
const SCORER_LEG = { nhl: 'goal', nfl: 'anytime' };
const NFL_UNDERS = new Set(['pass_td', 'pass_yds', 'rush_yds', 'rec_yds']);
const NFL_MAX_N = { anytime: 4, pass_td: 6 };   // nfl_multi_builder.js MAX_N
const LINE_CAPS = { nhl: { margin: 10.5, total: 15 }, nfl: { margin: 50.5, total: 100 } };

export const SGM_SPORTS = Object.keys(ENGINES);
const emptyLines = () => ({ marginTeam: null, marginL: null, totalDir: null, totalN: null,
                            homeTotalDir: null, homeTotalN: null, awayTotalDir: null, awayTotalN: null });

// A game's state as its engine reads it, from its bins and player data
// (/api/<sport>/game_sgm_bins_range/<id>?with_dists=1, game_player_data/<id>).
// sideMemo / binIndex: the NFL engine keeps each team's yards legs' value in
// each bin there (nfl-sgm-engine.js memoPricer), as the same legs come up
// again and again across the multis priced.
export function gameState(sport, { bins, playerData }) {
  const gs = { gameId: null, bins, playerData, lines: emptyLines(), picks: new Map(), yardsCache: new Map(), teamDists: null,
               sideMemo: new Map(), binIndex: new Map((bins || []).map((b, i) => [b, i])) };
  if (!bins?.length) return gs;
  gs.teamDists = sport === 'nhl' ? NHL.playerGoalDists(bins) : {
    home: { td: NFL.mixtureDist(bins, 'h_td'), fg: NFL.mixtureDist(bins, 'h_fg') },
    away: { td: NFL.mixtureDist(bins, 'a_td'), fg: NFL.mixtureDist(bins, 'a_fg') },
  };
  return gs;
}

// A pool row as a leg: { family, lines } (a margin or total line) or
// { family, side, pick } (a player leg), or null where the builder has no such
// leg. family: what one multi takes one leg of - the margin (head to head or
// line), the total, each player.
export function legOf(sport, gs, r) {
  const E = ENGINES[sport];
  if (!E || !gs.playerData) return null;
  const halfPoint = r.line != null && Math.abs(r.line * 2) % 2 === 1;
  const player = () => {
    const side = ['home', 'away'].find(sd => E.findPlayer(gs, sd, r.player_id));
    const pl = side && E.findPlayer(gs, side, r.player_id);
    return pl && pl.active ? { side, pl } : null;
  };
  const pickLeg = (side, pl, kind, n, under = false) => ({
    family: `player:${pl.id}`, side,
    pick: { side, kind, n, playerId: pl.id, teamId: gs.playerData[side].team_id, name: pl.name, ...(under ? { under: true } : {}) } });
  const propKind = PROP_LEGS[sport][r.market_kind];
  if (propKind) {
    const under = r.side === 'under';
    if (!halfPoint || !(r.side === 'over' || (under && sport === 'nfl' && NFL_UNDERS.has(propKind)))) return null;
    const who = player();
    if (!who) return null;
    const n = Math.floor(r.line) + 1;
    if (sport === 'nhl' && n > NHL.maxLegN(gs, who.side, propKind)) return null;
    if (sport === 'nfl') {
      if ((propKind === 'pass_td' || propKind === 'pass_yds') && !who.pl.is_starting_qb) return null;
      if (propKind === 'pass_td' ? n > NFL_MAX_N.pass_td : !NFL.yardsReady(gs)) return null;
    }
    return pickLeg(who.side, who.pl, propKind, n, under);
  }
  if (r.market_kind === 'anytime_scorer' || r.market_kind === 'multi_scorer') {
    const who = player();
    const n = r.line || 1;
    if (!who) return null;
    if (sport === 'nhl' ? n > NHL.maxLegN(gs, who.side, 'goal') : n > NFL_MAX_N.anytime) return null;
    return pickLeg(who.side, who.pl, SCORER_LEG[sport], n);
  }
  if (!['home', 'away', 'over', 'under'].includes(r.side)) return null;
  const caps = LINE_CAPS[sport];
  if (r.market_kind === 'match_odds' && !r.three_way) return { family: 'margin', lines: { marginTeam: r.side, marginL: -0.5 } };
  if (r.market_kind === 'handicap' && halfPoint && Math.abs(r.line) <= caps.margin) {
    return { family: 'margin', lines: { marginTeam: r.side, marginL: r.line } };
  }
  // The engines' total is the final score: a total settled on 60 minutes is another bet
  if (r.market_kind === 'total' && /:reg$/.test(r.market_id || '')) return null;
  if (r.market_kind === 'total' && halfPoint && r.line > 0 && r.line + 0.5 <= caps.total) {
    return { family: 'total', lines: { totalDir: r.side, totalN: r.line + 0.5 } };
  }
  return null;
}

// The chance every leg in `legs` (legOf's, one per family) wins, or null when
// the engine can't price them (no bins; yards legs without the yards model)
export function jointProb(sport, gs, legs) {
  const lines = emptyLines(), picks = new Map();
  for (const l of legs) {
    if (l.lines) Object.assign(lines, l.lines);
    else picks.set(`${l.pick.side}:${l.pick.kind}:${l.pick.playerId}`, l.pick);
  }
  const res = ENGINES[sport].gameProbabilityOf({ ...gs, lines, picks }, gs.bins);
  return res ? res.prob : null;
}
