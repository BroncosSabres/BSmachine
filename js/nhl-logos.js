// nhl-logos.js
// Unlike logos/nfl/ (full-team-name-slug filenames), the supplied logos/nhl/
// set is keyed by the team's 3-letter abbreviation: "{ABBR}_dark.svg" (e.g.
// "TOR_dark.svg"). Map every team name to its abbreviation exactly as seeded
// in Database/nhl_import/insert_teams.py, so a name mismatch here surfaces as
// a wrong/missing logo rather than a silent typo.
const NAME_TO_ABBR = {
  'Boston Bruins': 'BOS', 'Buffalo Sabres': 'BUF', 'Detroit Red Wings': 'DET',
  'Florida Panthers': 'FLA', 'Montreal Canadiens': 'MTL', 'Ottawa Senators': 'OTT',
  'Tampa Bay Lightning': 'TBL', 'Toronto Maple Leafs': 'TOR',
  'Carolina Hurricanes': 'CAR', 'Columbus Blue Jackets': 'CBJ', 'New Jersey Devils': 'NJD',
  'New York Islanders': 'NYI', 'New York Rangers': 'NYR', 'Philadelphia Flyers': 'PHI',
  'Pittsburgh Penguins': 'PIT', 'Washington Capitals': 'WSH',
  'Chicago Blackhawks': 'CHI', 'Colorado Avalanche': 'COL', 'Dallas Stars': 'DAL',
  'Minnesota Wild': 'MIN', 'Nashville Predators': 'NSH', 'St. Louis Blues': 'STL',
  'Utah Mammoth': 'UTA', 'Winnipeg Jets': 'WPG',
  'Anaheim Ducks': 'ANA', 'Calgary Flames': 'CGY', 'Edmonton Oilers': 'EDM',
  'Los Angeles Kings': 'LAK', 'San Jose Sharks': 'SJS', 'Seattle Kraken': 'SEA',
  'Vancouver Canucks': 'VAN', 'Vegas Golden Knights': 'VGK',
};

// Overrides for any name variant that doesn't match NAME_TO_ABBR exactly
// (e.g. an older "Utah Hockey Club" row from before the 2025-26 rebrand).
const LOGO_FILENAME_OVERRIDES = {
  'Utah Hockey Club': 'UTA_dark.svg',
};

export function nhlLogoFilename(teamName) {
  if (LOGO_FILENAME_OVERRIDES[teamName]) return LOGO_FILENAME_OVERRIDES[teamName];
  const abbr = NAME_TO_ABBR[teamName];
  return abbr ? `${abbr}_dark.svg` : null;
}

export function nhlLogoUrl(teamName) {
  // A deliberately non-existent filename (never a bare '' src, which some
  // browsers resolve against the current page URL instead of failing
  // immediately) for any unmapped name - triggers the same onerror fallback
  // callers already use everywhere else.
  const filename = nhlLogoFilename(teamName) || '_unknown.svg';
  return `/logos/nhl/${filename}`;
}
