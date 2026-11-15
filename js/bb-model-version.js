// bb-model-version.js — the version of the Best Bets page's model code that
// a model built ahead of time on the VM (tools/build-model.mjs, served by
// /api/best_bets/model) must have been built with for the page to use it.
// Bump it whenever a change to the code it runs (safe-stake.js, roi-stats.js,
// calibrate.js, calibrate-fit.js, close-model.js, best-bets-filters.js,
// best-bets-shared.js) would change a stake or a calibration for the same
// data: until the VM has built one with the new number, the page works them
// out itself, as before.
export const MODEL_VERSION = 2;   // 2: the model carries the slim analysis rows
