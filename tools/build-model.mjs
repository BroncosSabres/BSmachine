// build-model.mjs — the Best Bets page's model worked out ahead of time, on
// the VM (betfair-api build_best_bets.py --model runs it), with the page's
// own code: what the page would otherwise work out itself once the
// /api/best_bets/analysis data lands.
//
//   node tools/build-model.mjs < analysis.json > model.json
//
// In: the analysis endpoint's JSON. Out: { model_version, version, calib:
// { hierarchy, close: { moves, fair } }, stakes: { 'basis|stage|risk|detail':
// compactModel } } -
//   calib   calibrate-worker.js's fit of the parts the Best Bets page uses
//           (the calibrated chance, the predicted close). They depend on the
//           settled rows alone, not the price basis or the viewer's filters.
//   stakes  the stake model (safe-stake.js stakeModel) at every price basis,
//           stage, Risk level and detail, every band's bootstrap done.
// The page takes them only for the same data version and MODEL_VERSION.
import { decodeRows, settledBets, stakeModel, compactModel, RISK_LEVELS, BIN_DETAIL } from '../js/safe-stake.js';
import { observations, chooseN0, fitHierarchy } from '../js/calibrate.js';
import { slimTree, closeModel } from '../js/calibrate-fit.js';
import { BASES } from '../js/best-bets-filters.js';
import { MODEL_VERSION } from '../js/bb-model-version.js';

export const STAGES = ['avg', 'bavg'];   // best-bets-optimise.js optStage

// The settled rows as the Best Bets page decodes them (loadStakes)
export const pageRows = data => decodeRows(data).filter(r => String(r.market_id).startsWith('oddsapi:'));

export function calibration(rows) {
  const obs = observations(rows);
  const pick = chooseN0(obs);
  const close = closeModel(rows, pick.n0.market);
  return { hierarchy: slimTree(fitHierarchy(obs, { n0: pick.n0 })),
           close: close && { moves: close.moves, fair: close.fair } };
}

export function stakeTables(rows) {
  const out = {};
  for (const basis of Object.keys(BASES)) {
    for (const stage of STAGES) {
      const settled = settledBets(rows, stage, basis);
      for (const risk of Object.keys(RISK_LEVELS)) {
        for (const detail of Object.keys(BIN_DETAIL)) {
          out[[basis, stage, risk, detail].join('|')] = compactModel(stakeModel(settled, risk, detail), risk, detail);
        }
      }
    }
  }
  return out;
}

export function buildModel(data) {
  const rows = pageRows(data);
  return { model_version: MODEL_VERSION, version: data.version ?? null, calib: calibration(rows),
           stakes: stakeTables(rows) };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-model.mjs')) {
  const t = Date.now();
  const model = buildModel(JSON.parse(await readStdin()));
  process.stdout.write(JSON.stringify(model));
  process.stderr.write(`build-model: ${Object.keys(model.stakes).length} stake tables, `
    + `calibration ${model.calib.close ? 'with' : 'without'} close model, ${((Date.now() - t) / 1000).toFixed(1)}s\n`);
}
