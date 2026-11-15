// check-model.mjs — proof that a model built ahead (build-model.mjs) gives
// the Best Bets page exactly what it would work out itself, on real data.
//
//   node tools/check-model.mjs analysis.json [best_bets.json]
//
// calib   build-model's calibration against calibrate-worker.js itself (run
//         here as the browser would: its onmessage, the decoded rows)
// stakes  stakeFor at every price basis / stage / Risk / detail, the model
//         built here against hydrateModel(JSON round trip of compactModel),
//         for every current bet (best_bets.json, as liveBet makes them) and a
//         grid of edges and odds over every market (and one with none)
// Exits 1 on any difference.
import { readFileSync } from 'node:fs';
import { settledBets, stakeModel, compactModel, hydrateModel, stakeFor, liveBet, tierLows, RISK_LEVELS, BIN_DETAIL }
  from '../js/safe-stake.js';
import { BASES } from '../js/best-bets-filters.js';
import { pageRows, calibration, STAGES } from './build-model.mjs';

const [analysisPath, betsPath] = process.argv.slice(2);
const data = JSON.parse(readFileSync(analysisPath, 'utf8'));
const rows = pageRows(data);
let bad = 0;
const same = (what, a, b) => {
  const ja = JSON.stringify(a, noBets), jb = JSON.stringify(b, noBets);
  if (ja !== jb) { bad++; if (bad < 10) console.log(`DIFF ${what}\n  full: ${ja.slice(0, 300)}\n  ahead: ${jb.slice(0, 300)}`); }
};
// bets: not sent. tiers: a full model keeps them on a band only once
// tierLows has been asked (lazily); they are compared band by band below.
function noBets(k, v) { return k === 'bets' || k === 'row' || k === 'tiers' ? undefined : v; }

// --- calibration: the worker as the page runs it ---------------------------
let t = Date.now();
const posted = await new Promise(resolve => {
  globalThis.self = { postMessage: resolve };
  import('../js/calibrate-worker.js').then(() =>
    self.onmessage({ data: { rows: rows.map(({ row, ...r }) => r), basis: 'book', prefs: null, version: data.version } }));
});
if (posted.error) { console.log('worker failed:', posted.error); process.exit(1); }
const ahead = JSON.parse(JSON.stringify(calibration(rows)));
same('calib.hierarchy', JSON.parse(JSON.stringify(posted.hierarchy)), ahead.hierarchy);
same('calib.close', posted.close && JSON.parse(JSON.stringify({ moves: posted.close.moves, fair: posted.close.fair })),
     ahead.close);
console.log(`calibration compared (${((Date.now() - t) / 1000).toFixed(0)}s)`);

// --- stakes -----------------------------------------------------------------
t = Date.now();
const current = betsPath ? JSON.parse(readFileSync(betsPath, 'utf8')).rows.map(r => liveBet(r)) : [];
const EDGES = Array.from({ length: 171 }, (_, i) => -0.05 + i * 0.01);
const ODDS = [1.01, 1.2, 1.5, 1.75, 1.95, 2, 2.4, 3, 3.5, 4.5, 5, 6.5, 9, 10, 14, 21, 41, 101];
let calls = 0;
for (const basis of Object.keys(BASES)) {
  for (const stage of STAGES) {
    const settled = settledBets(rows, stage, basis);
    for (const risk of Object.keys(RISK_LEVELS)) {
      for (const detail of Object.keys(BIN_DETAIL)) {
        const full = stakeModel(settled, risk, detail);
        const hyd = hydrateModel(JSON.parse(JSON.stringify(compactModel(stakeModel(settled, risk, detail), risk, detail))));
        const groups = [...full.grids.keys(), 'nfl|no_such_market'];
        const bets = [...current];
        for (const group of groups) for (const edge of EDGES) for (const back of ODDS) {
          bets.push({ group, edge, back, taken: back, commission: 0 });
          if (back > 1.5) bets.push({ group, edge, back, taken: +(back * 1.04).toFixed(2), commission: 0.02 });
        }
        for (const b of bets) {
          calls++;
          same(`stake ${basis}|${stage}|${risk}|${detail} ${JSON.stringify(b)}`, stakeFor(b, full, 1000), stakeFor(b, hyd, 1000));
        }
        same(`k ${risk}`, full.k, hyd.k);
        // Every band the stakes above asked of the full model: its tiers as
        // tierLows gives them (stakeTitle's lines, ladderStake's stake)
        for (const [key, st] of full.bands) {
          same(`tiers ${basis}|${stage}|${risk}|${detail} ${key}`, tierLows(st, full.risk), hyd.bands.get(key)?.tiers);
        }
        same(`bands ${basis}|${stage}|${risk}|${detail}`, [...full.bands.keys()].every(k => hyd.bands.has(k)), true);
      }
    }
  }
}
console.log(`stakes compared: ${calls.toLocaleString()} stakeFor calls (${((Date.now() - t) / 1000).toFixed(0)}s)`);
console.log(bad ? `${bad} DIFFERENCES` : 'IDENTICAL');
process.exit(bad ? 1 : 0);
