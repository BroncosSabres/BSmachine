// sport-config.js
// Registry of sports the site serves. Adding a new sport means adding one
// entry here (plus its pages/API routes) — the header nav and switcher are
// driven entirely from this table.
export const SPORTS = {
  nrl: {
    label: 'NRL',
    basePath: '/nrl/pages/',
    landingPage: 'rankings.html',
    hasCompetitionToggle: true,
    nav: [
      { label: 'Rankings',       href: 'rankings.html' },
      { label: 'Predictions',    href: 'matchups.html' },
      { label: 'Tipping',        href: 'tipping.html' },
      { label: 'Leaderboard',    href: 'leaderboard.html' },
      { label: 'Simulator',      href: 'simulator.html' },
      { label: 'Tracker',        href: 'tracker.html' },
      { label: 'Magic Numbers',  href: 'magic_numbers.html' },
      { label: 'Tryscorers',     href: 'tryscorer_predictions.html' },
      { label: 'Community',      href: 'betslips.html' },
    ],
  },
  nfl: {
    label: 'NFL',
    basePath: '/nfl/pages/',
    landingPage: 'rankings.html',
    hasCompetitionToggle: false,
    nav: [
      { label: 'Rankings',       href: 'rankings.html' },
      { label: 'Predictions',    href: 'matchups.html' },
      { label: 'Tipping',        href: 'tipping.html',               disabled: true },
      { label: 'Leaderboard',    href: 'leaderboard.html',           disabled: true },
      { label: 'Simulator',      href: 'simulator.html',             disabled: true },
      { label: 'Tracker',        href: 'tracker.html',               disabled: true },
      { label: 'Magic Numbers',  href: 'magic_numbers.html',         disabled: true },
      { label: 'Tryscorers',     href: 'tryscorer_predictions.html', disabled: true },
      { label: 'Community',      href: 'betslips.html',              disabled: true },
    ],
  },
};

export function getCurrentSport() {
  const s = localStorage.getItem('bsmachine_sport');
  return SPORTS[s] ? s : 'nrl';
}

export function setCurrentSport(sport) {
  localStorage.setItem('bsmachine_sport', sport);
}

// Renders the <a> tags for a sport's nav using the given CSS class for each link.
// Disabled items still render as real, clickable links (to their "coming soon"
// page) with a visual badge — never hidden, per product requirement.
export function renderNav(sport, linkClass) {
  const cfg = SPORTS[sport] || SPORTS.nrl;
  return cfg.nav.map(item => {
    const href = cfg.basePath + item.href;
    const cls  = item.disabled ? `${linkClass} ${linkClass}--disabled` : linkClass;
    const badge = item.disabled ? '<span class="nav-soon-badge">Soon</span>' : '';
    return `<a href="${href}" class="${cls}">${item.label}${badge}</a>`;
  }).join('');
}
