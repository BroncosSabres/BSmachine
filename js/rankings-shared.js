// rankings-shared.js
// Sport-agnostic rendering helpers shared by the NRL and NFL rankings pages.

// Colour a probability cell from red -> yellow -> green
export function probColor(val) {
  const p = parseFloat(val);
  if (isNaN(p)) return '';
  if (p >= 0.8)  return 'color:#4ade80';  // green
  if (p >= 0.5)  return 'color:#a3e635';  // lime
  if (p >= 0.2)  return 'color:#facc15';  // yellow
  if (p > 0)     return 'color:#fb923c';  // orange
  return 'color:#6b7280';                 // gray (0%)
}

// Spoon/inverse metrics: high prob is bad
export function spoonColor(val) {
  const p = parseFloat(val);
  if (isNaN(p)) return '';
  if (p >= 0.2)  return 'color:#f87171';  // red
  if (p > 0)     return 'color:#fb923c';  // orange
  return 'color:#6b7280';
}

// Form badge: coloured arrow + value
export function formBadge(form) {
  const f = parseFloat(form ?? 0);
  const sign  = f > 0 ? '▲' : f < 0 ? '▼' : '—';
  const color = f > 0 ? '#4ade80' : f < 0 ? '#f87171' : '#6b7280';
  return `<span style="color:${color};font-weight:600">${sign} ${Math.abs(f).toFixed(2)}</span>`;
}

// Rank change badge: positive delta = moved up (smaller rank number)
export function rankChangeBadge(current, prev) {
  if (prev == null) return '';
  const delta = prev - current;
  if (delta > 0) return `<span style="color:#4ade80;font-size:0.7rem;font-weight:600;margin-left:3px">▲${delta}</span>`;
  if (delta < 0) return `<span style="color:#f87171;font-size:0.7rem;font-weight:600;margin-left:3px">▼${Math.abs(delta)}</span>`;
  return `<span style="color:#6b7280;font-size:0.7rem;margin-left:3px">—</span>`;
}

// Colored inline delta badge, e.g. "+3.2%" (green) or "-1.1%" (red).
// invert=true flips which sign counts as "good" - use for metrics where a
// lower number is better (avg_division_rank, avg_conf_seed, avg_league_rank).
export function deltaBadge(delta, { invert = false, suffix = '%', digits = 1, threshold = 0.05 } = {}) {
  if (delta == null || Math.abs(delta) < threshold) return '';
  const sign = delta > 0 ? '+' : '';
  const good = invert ? delta < 0 : delta > 0;
  const color = good ? '#4ade80' : '#f87171';
  return `<span style="color:${color};font-size:0.75rem;margin-left:4px;font-weight:600">${sign}${delta.toFixed(digits)}${suffix}</span>`;
}
