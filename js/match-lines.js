// match-lines.js
// Shared "Custom Line" feature for the NRL and NFL predictions pages. Every
// match tile gets an inline slider (home team spread), defaulted to the line
// the BS Machine's margin distribution says is closest to a 50/50 cover, with
// a live cover-probability bar underneath. Manual overrides are personal to
// this browser (localStorage only) — there is no server-side persistence.
// Pages can also read each match's current cover-probability discrepancy from
// 50/50 to offer a "sort by most discrepant" view once lines have been moved.
console.info('[match-lines] loaded rev5 (half-point defaults, no push by default)');

function loadLines(storageKey) {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || '{}');
  } catch {
    return {};
  }
}

function saveLines(storageKey, lines) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(lines));
  } catch {
    // Storage unavailable (private browsing, quota, etc.) — overrides just won't persist.
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// rawBins: [{x, prob}] home margin (home - away) distribution; prob need not sum to 1.
// lineForHome: signed spread applied to the home team (negative = home favoured to win by
// more than |line|, positive = home getting that many points).
// Returns { homeCoverProb, awayCoverProb, pushProb } or null if there's no usable distribution.
export function computeCoverProbabilities(rawBins, lineForHome) {
  if (!rawBins?.length) return null;
  const total = rawBins.reduce((s, b) => s + b.prob, 0);
  if (!total) return null;
  let home = 0, away = 0, push = 0;
  for (const { x, prob } of rawBins) {
    const p = prob / total;
    const adjusted = x + lineForHome;
    if (adjusted > 0) home += p;
    else if (adjusted < 0) away += p;
    else push += p;
  }
  return { homeCoverProb: home, awayCoverProb: away, pushProb: push };
}

// Rounds to the nearest half point, and — since margins are integer-valued — nudges off
// a whole-number result to whichever neighbouring half point (±0.5) sits closer to a
// 50/50 cover split, so defaults never land on a line that admits a push. Falls back to
// rounding away from zero (extending the favourite's task slightly) when there's no
// distribution to compare candidates against.
function nearestHalfLine(rawLine, rawBins) {
  const rounded = Math.round(rawLine * 2) / 2;
  if (rounded % 1 !== 0) return rounded; // already a half point, e.g. -6.5
  const down = rounded - 0.5;
  const up   = rounded + 0.5;
  if (rawBins?.length) {
    const coverDown = computeCoverProbabilities(rawBins, down);
    const coverUp   = computeCoverProbabilities(rawBins, up);
    if (coverDown && coverUp) {
      const devDown = Math.abs(coverDown.homeCoverProb - 0.5);
      const devUp   = Math.abs(coverUp.homeCoverProb - 0.5);
      return devDown <= devUp ? down : up;
    }
  }
  return rawLine >= 0 ? up : down;
}

// The default home spread. Prefers -(expected margin) — the BS Machine's own predicted
// home-minus-away score, i.e. the same number already shown as the tile's "Predicted"
// score — so the custom line starts out consistent with what the tile already says and
// its cover probability starts close to 50/50, rather than duplicating the win/loss bar
// at a line of 0. Falls back to -median(margin) from the simulated distribution when no
// expected margin is available. Always resolves to a half point (never a push).
export function suggestedHomeLine(rawBins, expectedMargin) {
  if (typeof expectedMargin === 'number' && Number.isFinite(expectedMargin)) {
    return nearestHalfLine(-expectedMargin, rawBins);
  }
  if (!rawBins?.length) return 0.5;
  const total = rawBins.reduce((s, b) => s + b.prob, 0);
  if (!total) return 0.5;
  const sorted = [...rawBins].sort((a, b) => a.x - b.x);
  let cum = 0;
  for (const b of sorted) {
    cum += b.prob / total;
    if (cum >= 0.5) return nearestHalfLine(-b.x, rawBins);
  }
  return 0.5;
}

// A slider range wide enough to cover ~99% of the probability mass plus headroom
// around the default line, so the draggable range stays meaningfully fine-grained.
function sliderRange(rawBins, defaultLine) {
  const total = rawBins.reduce((s, b) => s + b.prob, 0) || 1;
  const byAbs = [...rawBins].filter(b => b.prob > 0).sort((a, b) => Math.abs(a.x) - Math.abs(b.x));
  let cum = 0, r = 0;
  for (const b of byAbs) {
    cum += b.prob / total;
    r = Math.max(r, Math.abs(b.x));
    if (cum >= 0.99) break;
  }
  r = Math.max(r + 4, Math.abs(defaultLine) + 6, 10);
  return { min: -r, max: r };
}

function fmtLine(v) {
  return v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
}

const LINE_STEP = 0.5;

function controlHtml({ homeTeam, awayTeam, min, max, value }) {
  const btnStyle = 'background:transparent;border:1px solid #4b5563;color:#9ca3af;cursor:pointer;';
  return `
    <div class="mt-3 pt-3 border-t border-gray-700/50">
      <div class="flex items-center justify-between text-xs text-gray-500 font-semibold uppercase tracking-wider mb-1.5">
        <span>Custom Line</span>
        <button type="button" class="js-line-reset" title="Reset to BS Machine line"
                style="background:none;border:none;cursor:pointer;color:#6b7280;font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">&#8634; Reset</button>
      </div>
      <div class="flex justify-between items-end text-sm font-bold mb-1.5">
        <div class="flex flex-col items-start">
          <span class="js-line-home-label">${escapeHtml(homeTeam)}</span>
          <span class="js-line-home-pct text-xs font-semibold text-gray-400"></span>
        </div>
        <span class="js-line-push text-xs font-normal text-gray-500 self-center"></span>
        <div class="flex flex-col items-end">
          <span class="js-line-away-label">${escapeHtml(awayTeam)}</span>
          <span class="js-line-away-pct text-xs font-semibold text-gray-400"></span>
        </div>
      </div>
      <div class="flex h-1.5 rounded-full overflow-hidden bg-gray-700 mb-2">
        <div class="js-line-home-fill" style="height:100%;"></div>
        <div class="js-line-push-fill" style="height:100%;background:#6b7280;width:0%;"></div>
        <div class="js-line-away-fill" style="height:100%;"></div>
      </div>
      <div class="flex items-center gap-2">
        <button type="button" class="js-line-dec w-6 h-6 rounded flex items-center justify-center text-sm font-bold shrink-0" style="${btnStyle}" aria-label="Decrease ${escapeHtml(homeTeam)} line by half a point">&minus;</button>
        <input type="range" class="js-line-slider flex-1 min-w-0" min="${min}" max="${max}" step="${LINE_STEP}" value="${value}"
               aria-label="Custom line for ${escapeHtml(homeTeam)} versus ${escapeHtml(awayTeam)}" style="accent-color:#f59e0b;cursor:pointer;">
        <button type="button" class="js-line-inc w-6 h-6 rounded flex items-center justify-center text-sm font-bold shrink-0" style="${btnStyle}" aria-label="Increase ${escapeHtml(homeTeam)} line by half a point">&plus;</button>
      </div>
    </div>`;
}

function updateDisplay(slot, { homeTeam, awayTeam, homeColor, awayColor, homeLine, awayLine, cover }) {
  const { homeCoverProb, awayCoverProb, pushProb } = cover;
  const homePct = homeCoverProb * 100;
  const awayPct = awayCoverProb * 100;
  const pushPct = pushProb * 100;
  const homeCovers = homeCoverProb >= awayCoverProb;
  const homeOdds = homeCoverProb >= 1e-6 ? (1 / homeCoverProb).toFixed(2) : null;
  const awayOdds = awayCoverProb >= 1e-6 ? (1 / awayCoverProb).toFixed(2) : null;

  const homeLabel = slot.querySelector('.js-line-home-label');
  const awayLabel = slot.querySelector('.js-line-away-label');
  const homePctEl = slot.querySelector('.js-line-home-pct');
  const awayPctEl = slot.querySelector('.js-line-away-pct');
  const pushEl    = slot.querySelector('.js-line-push');
  const homeFill  = slot.querySelector('.js-line-home-fill');
  const pushFill  = slot.querySelector('.js-line-push-fill');
  const awayFill  = slot.querySelector('.js-line-away-fill');

  if (homeLabel) { homeLabel.textContent = `${homeTeam} ${fmtLine(homeLine)}`; homeLabel.className = `js-line-home-label ${homeCovers ? 'text-white' : 'text-gray-300'}`; }
  if (awayLabel) { awayLabel.textContent = `${awayTeam} ${fmtLine(awayLine)}`; awayLabel.className = `js-line-away-label ${!homeCovers ? 'text-white' : 'text-gray-300'}`; }
  if (homePctEl) homePctEl.textContent = `${homePct.toFixed(1)}%${homeOdds ? ` · $${homeOdds}` : ''}`;
  if (awayPctEl) awayPctEl.textContent = `${awayPct.toFixed(1)}%${awayOdds ? ` · $${awayOdds}` : ''}`;
  if (pushEl) pushEl.textContent = pushPct > 0.5 ? `${pushPct.toFixed(1)}% push` : '';
  if (homeFill) homeFill.style.cssText = `width:${homePct}%; background:${homeColor || '#4ade80'}; opacity:${homeCovers ? '1' : '0.5'}`;
  if (pushFill) pushFill.style.width = `${pushPct > 0.5 ? pushPct : 0}%`;
  if (awayFill) awayFill.style.cssText = `width:${awayPct}%; background:${awayColor || '#f87171'}; opacity:${!homeCovers ? '1' : '0.5'}`;
}

// Creates one controller. Call once per page.
//   storageKey:       localStorage key manual overrides are saved under.
//   fetchDistribution(id): async → {margins: [{x, prob}], ...} | null, ideally memoized by the caller.
export function createMatchLinesController({ storageKey, fetchDistribution }) {
  const overrides = loadLines(storageKey); // { [id]: homeLine } — explicit user overrides only
  const state = {};                        // id → { homeCoverProb, awayCoverProb, pushProb }

  function persistOverride(id, value, defaultValue) {
    if (value === defaultValue) delete overrides[id];
    else overrides[id] = value;
    saveLines(storageKey, overrides);
  }

  // Distance of the current line's cover probability from a 50/50 split, 0–0.5.
  // Returns null until the match's distribution/slider has loaded.
  function getDiscrepancy(id) {
    const s = state[id];
    return s ? Math.abs(s.homeCoverProb - 0.5) : null;
  }

  function hasAnyOverrides() {
    return Object.keys(overrides).length > 0;
  }

  // Clears every manual override (e.g. stray 0s saved before the default-line logic
  // existed). Does not re-render already-mounted controls — the caller should re-mount
  // (or reload) the currently visible matches afterwards to pick up the real defaults.
  function resetAll() {
    Object.keys(overrides).forEach(k => delete overrides[k]);
    saveLines(storageKey, overrides);
  }

  // Mounts a slider + live cover-probability bar into `slot` for one match.
  // expectedMargin: the BS Machine's predicted home-minus-away score (same number as the
  // tile's "Predicted" score), used to seed the default line — see suggestedHomeLine().
  // onChange(id) fires after the line settles (initial mount, slider release/±, reset) —
  // not on every drag tick — so callers can re-sort without the list jumping mid-drag.
  async function mountControl(slot, { id, homeTeam, awayTeam, homeColor, awayColor, expectedMargin, onChange }) {
    if (!slot) return;
    slot.innerHTML = `<div class="mt-3 pt-3 border-t border-gray-700/50 text-xs text-gray-600">Loading line…</div>`;

    let dist;
    try {
      dist = await fetchDistribution(id);
    } catch (err) {
      console.error('[match-lines] fetchDistribution failed for', id, err);
      slot.innerHTML = '';
      return;
    }
    const bins = dist?.margins;
    if (!bins?.length) {
      console.warn('[match-lines] no margin bins for', id, '— hiding custom line control');
      slot.innerHTML = '';
      return;
    }

    const defaultLine = suggestedHomeLine(bins, expectedMargin);
    const { min, max } = sliderRange(bins, defaultLine);
    const startLine = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : defaultLine;

    slot.innerHTML = controlHtml({ homeTeam, awayTeam, min, max, value: startLine });
    const slider  = slot.querySelector('.js-line-slider');
    const resetBtn = slot.querySelector('.js-line-reset');
    const decBtn  = slot.querySelector('.js-line-dec');
    const incBtn  = slot.querySelector('.js-line-inc');
    if (!slider || !resetBtn || !decBtn || !incBtn) {
      console.error('[match-lines] control markup missing expected elements for', id);
      return;
    }

    function apply(value) {
      try {
        const cover = computeCoverProbabilities(bins, value);
        if (!cover) { console.error('[match-lines] computeCoverProbabilities returned null for', id, value); return; }
        state[id] = cover;
        updateDisplay(slot, { homeTeam, awayTeam, homeColor, awayColor, homeLine: value, awayLine: -value, cover });
      } catch (err) {
        console.error('[match-lines] failed to render line for', id, err);
      }
    }

    // Applies a value, persists it as the user's override (or clears the override if it
    // matches the default), and notifies the page. Used by every "settled" interaction —
    // slider release, the ± buttons, and reset — as opposed to the live drag preview.
    function commit(value) {
      apply(value);
      persistOverride(id, value, defaultLine);
      onChange?.(id);
    }

    function step(delta) {
      const value = Math.min(max, Math.max(min, parseFloat(slider.value) + delta));
      slider.value = value;
      commit(value);
    }

    // Wire events before the first apply() so a bad first computation can't leave the
    // slider inert — dragging/reset still work even if that one render attempt failed.
    slider.addEventListener('input', () => apply(parseFloat(slider.value)));
    slider.addEventListener('change', () => commit(parseFloat(slider.value)));
    decBtn.addEventListener('click', () => step(-LINE_STEP));
    incBtn.addEventListener('click', () => step(LINE_STEP));
    resetBtn.addEventListener('click', () => {
      slider.value = defaultLine;
      commit(defaultLine);
    });

    apply(startLine);
    onChange?.(id);

    // Safety net: confirm the initial render actually took. If the percentage span is
    // still empty shortly after, the first apply() didn't stick for some reason (a data
    // hiccup, a timing quirk we haven't pinned down) — retry once and log it loudly so
    // it's visible in devtools, rather than silently leaving the control blank until
    // the user happens to drag the slider themselves.
    setTimeout(() => {
      const pctEl = slot.querySelector('.js-line-home-pct');
      if (pctEl && !pctEl.textContent) {
        console.warn('[match-lines] initial render for', id, 'did not populate on first attempt — retrying now');
        apply(parseFloat(slider.value));
      }
    }, 300);
  }

  return { mountControl, getDiscrepancy, hasAnyOverrides, resetAll };
}
