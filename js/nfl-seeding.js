// nfl-seeding.js — projected playoff seeding shared by the power rankings page
// (nfl-rankings.js) and the simulator (nfl-impact-simulator.js), so both
// order teams identically.
//
// Teams are ranked by projected record — the rounded W-L-T each page displays,
// so the projected wins/losses (usually whole numbers already) tie often.
// Ties are broken NFL-style: within a division by Div Title %; across
// divisions only each division's top tied team is compared, by 1st seed %,
// then playoff %. (Comparing every pair directly would mix two different
// tiebreakers and could give an order that depends on input order.)
//
// Each entry: { team, division, m: { wins, losses, ties, divPct, seed1Pct, playoffPct } }
// Percentages may be 0-1 or 0-100; they're only compared within one call.

function recordOf(m) {
  const w = Math.round(m.wins ?? 0), l = Math.round(m.losses ?? 0), t = Math.round(m.ties ?? 0);
  const games = w + l + t;
  return { pct: games > 0 ? (w + 0.5 * t) / games : -1, w };
}

const desc = (a, b) => (b ?? -1) - (a ?? -1);
const withinDivision = (a, b) =>
  desc(a.m.divPct, b.m.divPct) || desc(a.m.seed1Pct, b.m.seed1Pct) || desc(a.m.playoffPct, b.m.playoffPct)
  || a.team.localeCompare(b.team);
const acrossDivisions = (a, b) =>
  desc(a.m.seed1Pct, b.m.seed1Pct) || desc(a.m.playoffPct, b.m.playoffPct) || desc(a.m.divPct, b.m.divPct)
  || a.team.localeCompare(b.team);

// Orders teams that share a projected record.
function breakTie(group) {
  const byDivision = {};
  group.forEach(t => (byDivision[t.division] ||= []).push(t));
  const queues = Object.values(byDivision).map(q => q.sort(withinDivision));
  const out = [];
  while (out.length < group.length) {
    const best = queues.filter(q => q.length).map(q => q[0]).sort(acrossDivisions)[0];
    out.push(queues.find(q => q[0] === best).shift());
  }
  return out;
}

// Best projected finish first.
export function rankNflTeams(teams) {
  const groups = new Map();
  teams.forEach(t => {
    const r = recordOf(t.m);
    const key = `${r.pct}|${r.w}`;
    if (!groups.has(key)) groups.set(key, { r, teams: [] });
    groups.get(key).teams.push(t);
  });
  return [...groups.values()]
    .sort((a, b) => (b.r.pct - a.r.pct) || (b.r.w - a.r.w))
    .flatMap(g => breakTie(g.teams));
}

// One conference's projected seeds: seeds 1-4 are the division leaders, 5-7
// the best of the rest; inTheHunt is the next (up to 3) teams with any
// playoff chance left.
export function seedNflConference(teams) {
  const leaders = [];
  const byDivision = {};
  teams.forEach(t => (byDivision[t.division] ||= []).push(t));
  Object.values(byDivision).forEach(div => leaders.push(rankNflTeams(div)[0]));
  const leaderNames = new Set(leaders.map(t => t.team));
  const rest = rankNflTeams(teams.filter(t => !leaderNames.has(t.team)));
  return {
    seeded: [...rankNflTeams(leaders), ...rest.slice(0, 3)],
    inTheHunt: rest.slice(3).filter(t => (t.m.playoffPct ?? 0) > 0).slice(0, 3),
  };
}
