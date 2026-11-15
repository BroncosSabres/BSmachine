// build-model.mjs — the Best Bets page's model worked out ahead of time, on
// the VM (betfair-api build_best_bets.py --model runs it), with the page's
// own code: what the page would otherwise work out itself once the
// /api/best_bets/analysis data lands.
//
//   node tools/build-model.mjs < analysis.json > model.json
//
// In: the analysis endpoint's JSON. Out: { model_version, version, calib:
// { hierarchy, close: { moves, fair } }, stakes: { 'basis|stage|risk|detail':
// compactModel }, columns, rows, outliers, mkt_sum } -
//   calib   calibrate-worker.js's fit of the parts the Best Bets page uses
//           (the calibrated chance, the predicted close). They depend on the
//           settled rows alone, not the price basis or the viewer's filters.
//   stakes  the stake model (safe-stake.js stakeModel) at every price basis,
//           stage, Risk level and detail, every band's bootstrap done.
//   columns / rows / outliers   the analysis data the page reads (slimRows),
//           so it needn't download all of it: every row with a price while
//           it showed value ('avg' / 'bavg') or an outlier window, every
//           column, plus mkt_sum (its market's closing overround, from all
//           of the rows: what judgeEdgeOf would work out over them).
// The page takes it only for its own MODEL_VERSION; /api/best_bets/model
// sends it only while it is the current analysis data's.
import { decodeRows, settledBets, stakeModel, compactModel, RISK_LEVELS, BIN_DETAIL } from '../js/safe-stake.js';
import { observations, chooseN0, fitHierarchy, overrounds } from '../js/calibrate.js';
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

// The rows of the analysis data the Best Bets page reads once the model is
// in (loadStakes -> settledRows): those with a price while they showed value
// (settledBets, the optimiser, the track record, the judges) or an outlier
// window (outlierBets), in the data's order, every column and mkt_sum - the
// overround judgeEdgeOf takes from overrounds over all the rows, which the
// slim rows alone can't give (a market's other sides may not be among them).
export const keepRow = r => r.avg_back != null || r.bavg_back != null || !!r.disc_window || !!r.disc_ladder;
export function slimRows(data) {
  const decoded = decodeRows(data);
  const page = decoded.filter(r => String(r.market_id).startsWith('oddsapi:'));
  const sums = overrounds(page, 'close');
  const rows = [];
  decoded.forEach((r, i) => {
    if (String(r.market_id).startsWith('oddsapi:') && keepRow(r)) rows.push([...data.rows[i], sums.get(r) ?? null]);
  });
  return { columns: [...data.columns, 'mkt_sum'], rows, outliers: data.outliers ?? [] };
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
  const slim = slimRows(data);   // first: before anything below touches the decoded rows
  const rows = pageRows(data);
  return { model_version: MODEL_VERSION, version: data.version ?? null, calib: calibration(rows),
           stakes: stakeTables(rows), ...slim };
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
