// prediction-tile.js
// Sport-agnostic match tile, generalized from nfl-matchups.js's gameCard/probBar
// for use in cross-sport feeds (e.g. the homepage's "Next 7 Days" widget).
// Expects entries already normalized to a common shape — see homepage-predictions.js.

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function probBar(entry) {
  const homeP = entry.homePerc ?? 0;
  const awayP = entry.awayPerc ?? 0;
  const tieP  = entry.tiePerc  ?? 0;
  const home  = homeP * 100;
  const away  = awayP * 100;
  const tie   = tieP  * 100;
  const homeWin  = homeP >= awayP;
  const homeOdds = homeP >= 1e-6 ? (1 / homeP).toFixed(2) : null;
  const awayOdds = awayP >= 1e-6 ? (1 / awayP).toFixed(2) : null;

  return `
    <div class="mt-3">
      <div class="flex justify-between items-end text-sm font-bold mb-1.5">
        <div class="flex flex-col items-start">
          <span class="${homeWin ? 'text-white' : 'text-gray-300'}">${home.toFixed(1)}%</span>
          ${homeOdds ? `<span class="text-xs font-semibold text-gray-400">$${homeOdds}</span>` : ''}
        </div>
        ${tie > 0.5 ? `<span class="text-xs font-normal text-gray-500 self-center">${tie.toFixed(1)}% tie</span>` : '<span></span>'}
        <div class="flex flex-col items-end">
          <span class="${!homeWin ? 'text-white' : 'text-gray-300'}">${away.toFixed(1)}%</span>
          ${awayOdds ? `<span class="text-xs font-semibold text-gray-400">$${awayOdds}</span>` : ''}
        </div>
      </div>
      <div class="flex h-1.5 rounded-full overflow-hidden bg-gray-700">
        <div style="width:${home}%; background:#4ade80; opacity:${homeWin ? '1' : '0.5'}"></div>
        ${tie > 0.5 ? `<div style="width:${tie}%; background:#6b7280"></div>` : ''}
        <div style="width:${away}%; background:#f87171; opacity:${!homeWin ? '1' : '0.5'}"></div>
      </div>
    </div>
  `;
}

function renderScore(entry) {
  if (entry.isFinished) {
    return `<div class="text-lg font-bold font-mono">${entry.homeScore} &ndash; ${entry.awayScore}</div>
            <div class="text-xs text-gray-500 mt-0.5">Final</div>`;
  }
  if (entry.hasPrediction) {
    return `<div class="text-lg font-bold font-mono text-gray-300">${entry.expHome} &ndash; ${entry.expAway}</div>
            <div class="text-xs text-gray-500 mt-0.5">Predicted</div>`;
  }
  return `<div class="text-sm text-gray-500">vs</div>`;
}

const SPORT_BADGE_STYLE = {
  nrl: 'background:rgba(251,191,36,0.12); color:#fbbf24;',
  nfl: 'background:rgba(96,165,250,0.12); color:#60a5fa;',
};

export function renderPredictionTile(entry) {
  const badgeStyle = SPORT_BADGE_STYLE[entry.sport] || 'background:rgba(255,255,255,0.08); color:#9ca3af;';
  return `
    <div class="card">
      <div class="flex items-center justify-between text-xs text-gray-500 mb-3">
        <span class="font-bold uppercase tracking-wide text-[0.65rem] px-1.5 py-0.5 rounded" style="${badgeStyle}">${entry.sport.toUpperCase()}</span>
        <span>${formatTime(entry.date)}</span>
      </div>
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <img src="${entry.logoUrl(entry.homeTeam)}" class="w-7 h-7 object-contain shrink-0" onerror="this.style.display='none'">
          <span class="font-semibold text-sm truncate">${entry.homeTeam}</span>
        </div>
        <div class="text-center px-2 shrink-0">
          ${renderScore(entry)}
        </div>
        <div class="flex items-center gap-2 flex-1 min-w-0 justify-end">
          <span class="font-semibold text-sm truncate">${entry.awayTeam}</span>
          <img src="${entry.logoUrl(entry.awayTeam)}" class="w-7 h-7 object-contain shrink-0" onerror="this.style.display='none'">
        </div>
      </div>
      ${entry.hasPrediction && !entry.isFinished ? probBar(entry) : ''}
      ${!entry.hasPrediction ? '<p class="text-center text-gray-500 text-xs mt-3">Prediction not yet available</p>' : ''}
    </div>
  `;
}
