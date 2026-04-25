// load-match-results.js

const BACKEND = 'https://bsmachine-backend.onrender.com/api';

const TEAM_SHORT = {
  'Brisbane Broncos':              'Broncos',
  'Canberra Raiders':              'Raiders',
  'Canterbury-Bankstown Bulldogs': 'Bulldogs',
  'Cronulla-Sutherland Sharks':    'Sharks',
  'Dolphins':                      'Dolphins',
  'Gold Coast Titans':             'Titans',
  'Manly-Warringah Sea Eagles':    'Manly',
  'Melbourne Storm':               'Storm',
  'Newcastle Knights':             'Knights',
  'North Queensland Cowboys':      'Cowboys',
  'Parramatta Eels':               'Eels',
  'Penrith Panthers':              'Panthers',
  'South Sydney Rabbitohs':        'Rabbitohs',
  'St George Illawarra Dragons':   'Dragons',
  'Sydney Roosters':               'Roosters',
  'New Zealand Warriors':          'Warriors',
  'Wests Tigers':                  'Tigers',
};

export async function loadMatchResults() {
  const res = await fetch(`${BACKEND}/season_matches/nrl`);
  const data = await res.json();

  const matchResults = {};

  for (const match of data.matches || []) {
    if (!match.is_finished) continue;

    const round     = match.round_number;
    const homeShort = TEAM_SHORT[match.home_team] || match.home_team;
    const awayShort = TEAM_SHORT[match.away_team] || match.away_team;
    const homeScore = match.home_score;
    const awayScore = match.away_score;

    const homePrefix = homeScore > awayScore ? 'W ' : homeScore < awayScore ? 'L ' : 'D ';
    const awayPrefix = awayScore > homeScore ? 'W ' : awayScore < homeScore ? 'L ' : 'D ';

    if (!matchResults[homeShort]) matchResults[homeShort] = {};
    if (!matchResults[awayShort]) matchResults[awayShort] = {};

    matchResults[homeShort][round] = `${homePrefix}vs ${awayShort} ${homeScore}-${awayScore}`;
    matchResults[awayShort][round] = `${awayPrefix}vs ${homeShort} ${awayScore}-${homeScore}`;
  }

  return matchResults;
}
