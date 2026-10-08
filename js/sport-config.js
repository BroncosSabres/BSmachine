// sport-config.js
// Registry of competitions the site serves. Adding a new one means adding one
// entry here (plus its pages/API routes) — the header tabs and nav are
// driven entirely from this table.
import { getCompetition } from './competition.js';

export const SPORTS = {
  nrl: {
    label: 'NRL',
    basePath: '/nrl/pages/',
    query: '',
    landingPage: 'rankings.html',
    color: '#fbbf24',
    logo: '/logos/Competitions/nrl-light.svg',
    nav: [
      { label: 'Rankings',       href: 'rankings.html' },
      { label: 'Predictions',    href: 'matchups.html' },
      { label: 'Multi Builder',  href: 'tryscorer_predictions.html' },
      { label: 'Tipping',        href: 'tipping.html' },
      { label: 'Leaderboard',    href: 'leaderboard.html' },
      { label: 'Simulator',      href: 'simulator.html' },
      { label: 'Tracker',        href: 'tracker.html' },
      { label: 'Magic Numbers',  href: 'magic_numbers.html' },
      { label: 'Community',      href: 'betslips.html' },
    ],
  },
  // NRLW reuses the NRL pages; ?comp=nrlw switches their data source.
  nrlw: {
    label: 'NRLW',
    basePath: '/nrl/pages/',
    query: '?comp=nrlw',
    landingPage: 'rankings.html',
    color: '#e879f9',
    logo: '/logos/Competitions/nrlw-light.svg',
    nav: [
      { label: 'Rankings',       href: 'rankings.html' },
      { label: 'Predictions',    href: 'matchups.html' },
      { label: 'Multi Builder',  href: 'tryscorer_predictions.html' },
      { label: 'Tipping',        href: 'tipping.html' },
      { label: 'Leaderboard',    href: 'leaderboard.html' },
      { label: 'Simulator',      href: 'simulator.html' },
      { label: 'Community',      href: 'betslips.html' },
    ],
  },
  nfl: {
    label: 'NFL',
    basePath: '/nfl/pages/',
    query: '',
    landingPage: 'rankings.html',
    color: '#60a5fa',
    logo: '/logos/Competitions/NFL.svg',
    nav: [
      { label: 'Rankings',       href: 'rankings.html' },
      { label: 'Predictions',    href: 'matchups.html' },
      { label: 'Multi Builder',  href: 'tryscorer_predictions.html' },
      { label: 'Simulator',      href: 'simulator.html' },
      { label: 'Player Projections', href: 'player_projections.html' },
      { label: 'Tipping',        href: 'tipping.html',               disabled: true },
      { label: 'Leaderboard',    href: 'leaderboard.html',           disabled: true },
      { label: 'Tracker',        href: 'tracker.html',               disabled: true },
      { label: 'Magic Numbers',  href: 'magic_numbers.html',         disabled: true },
      { label: 'Community',      href: 'betslips.html' },
    ],
  },
  nhl: {
    label: 'NHL',
    basePath: '/nhl/pages/',
    query: '',
    landingPage: 'rankings.html',
    color: '#818cf8',
    logo: '/logos/Competitions/NHL.svg',
    nav: [
      { label: 'Rankings',       href: 'rankings.html' },
      { label: 'Predictions',    href: 'matchups.html' },
      { label: 'Multi Builder',  href: 'tryscorer_predictions.html' },
      { label: 'Simulator',      href: 'simulator.html' },
      { label: 'Player Projections', href: 'player_projections.html' },
      { label: 'Tipping',        href: 'tipping.html',               disabled: true },
      { label: 'Leaderboard',    href: 'leaderboard.html',           disabled: true },
      { label: 'Tracker',        href: 'tracker.html',               disabled: true },
      { label: 'Magic Numbers',  href: 'magic_numbers.html',         disabled: true },
      { label: 'Community',      href: 'betslips.html',              disabled: true },
    ],
  },
};

export function sportUrl(sport, page) {
  const cfg = SPORTS[sport];
  return cfg.basePath + (page || cfg.landingPage) + cfg.query;
}

// Derived from the URL only: the competition whose pages we're on, or null
// for general pages (home, about, login, ...).
export function getCurrentSport() {
  const path = window.location.pathname;
  if (path.startsWith('/nfl/')) return 'nfl';
  if (path.startsWith('/nhl/')) return 'nhl';
  if (path.startsWith('/nrl/')) return getCompetition();
  return null;
}

// Renders the <a> tags for a sport's nav using the given CSS class for each link.
// Disabled items still render as real, clickable links (to their "coming soon"
// page) with a visual badge — never hidden, per product requirement.
export function renderNav(sport, linkClass) {
  const cfg = SPORTS[sport];
  if (!cfg) return '';
  const currentPage = window.location.pathname.split('/').pop();
  return cfg.nav.map(item => {
    const href = cfg.basePath + item.href + cfg.query;
    const classes = [linkClass];
    if (item.disabled) classes.push(`${linkClass}--disabled`);
    if (item.href === currentPage) classes.push('is-active');
    const current = item.href === currentPage ? ' aria-current="page"' : '';
    const badge = item.disabled ? '<span class="nav-soon-badge">Soon</span>' : '';
    return `<a href="${href}" class="${classes.join(' ')}"${current}>${item.label}${badge}</a>`;
  }).join('');
}

// Competition tabs for the header — plain links, so nothing changes until clicked.
export function renderCompTabs(activeSport) {
  return Object.entries(SPORTS).map(([key, cfg]) => {
    const active = key === activeSport;
    return `<a href="${sportUrl(key)}" class="comp-tab${active ? ' is-active' : ''}" style="--comp-color:${cfg.color}"${active ? ' aria-current="true"' : ''}>`
      + `<img src="${cfg.logo}" alt="" class="comp-logo">${cfg.label}</a>`;
  }).join('');
}
