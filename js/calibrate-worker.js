// calibrate-worker.js — calibrate.js's fitting, off the page's main thread
// (calibrate-client.js starts it). Gets the decoded settled rows, the price
// basis and the viewer's filter settings; answers with the fitted hierarchy
// (coefficients and covariances only) and each market's out-of-sample record.
import { observations, chooseN0, fitHierarchy, walkForward, ruleReturns, clvByKey, lossGap, weights,
         verdict } from './calibrate.js';
import { passesMarket } from './best-bets-filters.js';

const slim = f => ({ beta: f.beta, V: f.V, n: f.n, games: f.games, own: f.own });

self.onmessage = e => {
  const { rows, basis, prefs, version } = e.data;
  try {
    const obs = observations(rows);
    const pick = chooseN0(obs);
    const h = fitHierarchy(obs, { n0: pick.n0 });
    const wf = walkForward(obs, { n0: pick.n0 });
    // "Your filters": the Best Bets page's market switches, edge ranges (the
    // model's edge) and odds range, at the average price while it showed value
    const passes = prefs ? r => passesMarket(prefs, r.group, r.avg_edge, r.avg_back) : null;
    const returns = ruleReturns(rows, wf.fits, { basis, passes });
    const clv = clvByKey(rows, basis);
    const markets = Object.entries(h.leaves).map(([key, fit]) => {
      const gap = lossGap(wf.oos.filter(x => x.o.key === key));
      return { key, n: fit.n, games: fit.games, own: fit.own, weights: weights(fit), gap,
               verdict: verdict(fit, gap), returns: returns.byKey[key] || null, clv: clv[key] || null };
    });
    self.postMessage({
      version, basis, n0: pick.n0, n0Scores: pick.scores, days: wf.days,
      hierarchy: { root: slim(h.root), n0: h.n0,
                   sports: Object.fromEntries(Object.entries(h.sports).map(([k, f]) => [k, slim(f)])),
                   leaves: Object.fromEntries(Object.entries(h.leaves).map(([k, f]) => [k, slim(f)])) },
      markets, all: returns.all, overall: lossGap(wf.oos), rootWeights: weights(h.root),
      sportWeights: Object.fromEntries(Object.entries(h.sports).map(([k, f]) => [k, weights(f)])),
    });
  } catch (err) {
    self.postMessage({ version, error: String(err && err.message || err) });
  }
};
