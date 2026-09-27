// prediction-tile.js
// Sport-agnostic match tiles, generalized from nfl-matchups.js's gameCard/probBar
// for use in cross-sport feeds: the full tile for the homepage's "Next 7 Days"
// widget and a compact one for the header match ticker.
// Expects entries already normalized to a common shape — see upcoming-matches.js.
import { SPORTS } from './sport-config.js';

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

// NHL is low-scoring enough that 2 d.p. carries real signal (2.7 vs 2.5
// expected goals is a meaningfully different prediction); NRL/NFL keep
// their existing whole/1-d.p. backend-rounded display.
function formatExpScore(entry, value) {
  if (value == null) return '';
  return entry.sport === 'nhl' ? Number(value).toFixed(2) : value;
}

function renderScore(entry) {
  if (entry.isFinished) {
    return `<div class="text-lg font-bold font-mono">${entry.homeScore} &ndash; ${entry.awayScore}</div>
            <div class="text-xs text-gray-500 mt-0.5">Final</div>`;
  }
  if (entry.hasPrediction) {
    const expHome = formatExpScore(entry, entry.expHome);
    const expAway = formatExpScore(entry, entry.expAway);
    return `<div class="text-lg font-bold font-mono text-gray-300">${expHome} &ndash; ${expAway}</div>
            <div class="text-xs text-gray-500 mt-0.5">Predicted</div>`;
  }
  return `<div class="text-sm text-gray-500">vs</div>`;
}

export const SPORT_BADGE_STYLE = {
  nrl:  'background:rgba(251,191,36,0.12); color:#fbbf24;',
  nrlw: 'background:rgba(232,121,249,0.12); color:#e879f9;',
  nfl:  'background:rgba(96,165,250,0.12); color:#60a5fa;',
  nhl:  'background:rgba(129,140,248,0.12); color:#818cf8;',
};

const FALLBACK_BADGE_STYLE = 'background:rgba(255,255,255,0.08); color:#9ca3af;';

// Competition badge: logo + label, tinted in the competition's colour.
function compBadge(entry, className) {
  const style = SPORT_BADGE_STYLE[entry.sport] || FALLBACK_BADGE_STYLE;
  const logo = SPORTS[entry.sport]?.logo;
  const img = logo ? `<img src="${logo}" alt="" class="badge-logo">` : '';
  return `<span class="${className}" style="${style}">${img}${entry.sport.toUpperCase()}</span>`;
}

export function builderUrl(entry) {
  if (entry.sport === 'nrl' && entry.matchId != null) {
    return `/nrl/pages/tryscorer_predictions.html?match_id=${entry.matchId}`;
  }
  if (entry.sport === 'nrlw' && entry.matchId != null) {
    return `/nrl/pages/tryscorer_predictions.html?match_id=${entry.matchId}&comp=nrlw`;
  }
  if (entry.sport === 'nfl' && entry.gameId != null && entry.weekNumber != null) {
    return `/nfl/pages/tryscorer_predictions.html?week=${entry.weekNumber}&game_id=${entry.gameId}`;
  }
  if (entry.sport === 'nhl' && entry.gameId != null) {
    return `/nhl/pages/tryscorer_predictions.html?game_id=${entry.gameId}`;
  }
  return null;
}

export function renderPredictionTile(entry) {
  const href = builderUrl(entry);
  const tag = href ? 'a' : 'div';
  const hrefAttr = href ? `href="${href}"` : '';
  return `
    <${tag} class="card" ${hrefAttr} style="text-decoration:none;">
      <div class="flex items-center justify-between text-xs text-gray-500 mb-3">
        ${compBadge(entry, 'tile-badge')}
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
    </${tag}>
  `;
}

// ---- Compact tile for the header match ticker ----

// Two-word nicknames that the "last word" rule below would mangle.
const TWO_WORD_NICKNAMES = [
  'Sea Eagles', 'Wests Tigers', 'Maple Leafs', 'Red Wings', 'Blue Jackets',
  'Golden Knights', 'Red Sox', 'White Sox',
];

export function shortTeamName(name) {
  if (!name) return '';
  // NRLW sides are named "<club> Women" — the badge already says NRLW.
  const base = name.replace(/\s+Women$/i, '');
  const nick = TWO_WORD_NICKNAMES.find(n => base.endsWith(n));
  if (nick) return nick === 'Wests Tigers' ? 'Tigers' : nick;
  return base.split(' ').pop();
}

function tickerTime(entry) {
  if (entry.isFinished) return 'FT';
  const d = new Date(entry.date);
  if (isNaN(d.getTime())) return '';
  return formatTime(entry.date);
}

function tickerRow(entry, side) {
  const team   = side === 'home' ? entry.homeTeam : entry.awayTeam;
  const score  = side === 'home' ? entry.homeScore : entry.awayScore;
  const other  = side === 'home' ? entry.awayScore : entry.homeScore;
  const perc   = side === 'home' ? entry.homePerc  : entry.awayPerc;
  const oPerc  = side === 'home' ? entry.awayPerc  : entry.homePerc;
  const exp    = side === 'home' ? entry.expHome   : entry.expAway;

  // Finished: the final score. Upcoming: projected score + win probability.
  let scoreCell = '';
  let pctCell   = '';
  let lead      = false;
  if (entry.isFinished && score != null) {
    scoreCell = score;
    lead      = Number(score) > Number(other);
  } else if (entry.hasPrediction && perc != null) {
    scoreCell = formatExpScore(entry, exp);
    pctCell   = `${Math.round(perc * 100)}%`;
    lead      = perc > (oPerc ?? 0);
  }

  return `
    <div class="ticker-row${lead ? ' is-lead' : ''}">
      <img src="${entry.logoUrl(team)}" alt="" class="ticker-logo" onerror="this.style.visibility='hidden'">
      <span class="ticker-team" title="${team}">${shortTeamName(team)}</span>
      <span class="ticker-score${entry.isFinished ? ' is-final' : ''}">${scoreCell}</span>
      ${pctCell ? `<span class="ticker-pct">${pctCell}</span>` : ''}
    </div>`;
}

export function renderTickerTile(entry) {
  const href = builderUrl(entry);
  const tag = href ? 'a' : 'div';
  const hrefAttr = href ? `href="${href}"` : '';
  const label = `${entry.homeTeam} vs ${entry.awayTeam}`;
  return `
    <${tag} class="ticker-tile${entry.isFinished ? ' is-finished' : ''}" ${hrefAttr} aria-label="${label}">
      <div class="ticker-meta">
        ${compBadge(entry, 'ticker-badge')}
        <span>${tickerTime(entry)}</span>
      </div>
      ${tickerRow(entry, 'home')}
      ${tickerRow(entry, 'away')}
    </${tag}>`;
}
