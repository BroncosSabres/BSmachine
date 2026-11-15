// check-slim.mjs — proof that the Best Bets page works out the same from the
// slim rows of the VM's model (build-model.mjs slimRows) as from all of the
// analysis data, on real data:
//
//   node tools/check-slim.mjs analysis.json
//
// For every price basis and judge (the model's edge, the best price's, the
// calibrated, the predicted close): the settled bets the stakes and track
// record read, the optimiser's rules, "since last change" and the outlier
// bets at each outlier setting. Exits 1 on any difference.
import { readFileSync } from 'node:fs';
import { decodeRows, settledBets, outlierBets } from '../js/safe-stake.js';
import { judgeEdgeOf, optimiseMarkets, rulesOverTime, optStage } from '../js/best-bets-optimise.js';
import { defaultPrefs, outlierFits, marketOf, BASES, OUTLIER_MODES } from '../js/best-bets-filters.js';
import { pageRows, slimRows, calibration } from './build-model.mjs';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const slimData = JSON.parse(JSON.stringify(slimRows(data)));   // as the page gets it
const full = pageRows(data);
const slim = decodeRows(slimData).filter(r => String(r.market_id).startsWith('oddsapi:'));
console.log(`rows: ${full.length} -> ${slim.length}`);
const fits = outlierFits(data.outliers);
const keys = [...new Set(full.map(marketOf))];

let bad = 0;
const drop = (k, v) => (k === 'row' || k === 'outWin' || k === 'mkt_sum' ? undefined : v);
const same = (what, a, b) => {
  const ja = JSON.stringify(a, drop), jb = JSON.stringify(b, drop);
  if (ja !== jb) { bad++; if (bad < 8) console.log(`DIFF ${what}\n  full: ${ja.slice(0, 240)}\n  slim: ${jb.slice(0, 240)}`); }
};

let t = Date.now();
const calib = JSON.parse(JSON.stringify(calibration(full)));
console.log(`calibration fitted (${((Date.now() - t) / 1000).toFixed(0)}s)`);

for (const basis of Object.keys(BASES)) {
  for (const stage of ['avg', 'bavg']) same(`settledBets ${basis} ${stage}`, settledBets(full, stage, basis), settledBets(slim, stage, basis));
  for (const judge of ['model', 'book', 'cal', 'close']) {
    const prefs = { ...defaultPrefs(), basis, judge };
    const ef = judgeEdgeOf(full, prefs, calib), es = judgeEdgeOf(slim, prefs, calib);
    same(`judge ${basis} ${judge} kind`, typeof ef, typeof es);
    if (ef) {
      // the same edge for every row the slim set keeps (matched by their order)
      const kept = full.filter(r => r.avg_back != null || r.bavg_back != null || r.disc_window || r.disc_ladder);
      same(`judge ${basis} ${judge} edges`, kept.map(ef), slim.map(es));
    }
    same(`optimise ${basis} ${judge}`, optimiseMarkets(full, prefs, keys, ef ?? null), optimiseMarkets(slim, prefs, keys, es ?? null));
    same(`overTime ${basis} ${judge}`, rulesOverTime(full, prefs, keys, ef ?? null), rulesOverTime(slim, prefs, keys, es ?? null));
    for (const outliers of OUTLIER_MODES) {
      const p = { ...prefs, outliers };
      same(`outliers ${basis} ${judge} ${outliers}`, outlierBets(full, p, fits, optStage(p)), outlierBets(slim, p, fits, optStage(p)));
    }
  }
}
console.log(`compared (${((Date.now() - t) / 1000).toFixed(0)}s)`);
console.log(bad ? `${bad} DIFFERENCES` : 'IDENTICAL');
process.exit(bad ? 1 : 0);
