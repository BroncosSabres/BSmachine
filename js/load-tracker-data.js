// load-tracker-data.js

const BACKEND = 'https://bsmachine-backend.onrender.com/api';

// Map full DB team names to the short names used everywhere on the site
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

// Map from the metric keys tracker.js requests to the API history field names
const METRIC_KEY_MAP = {
  'Total Rating':   'total_rating',
  'Top 8':          'percent_top8',
  'Top 4':          'percent_top4',
  'Minor Premiers': 'percent_minor_premiers',
  'Spoon':          'percent_wooden_spoon',
};

/**
 * Fetches power-rankings history from the backend and returns data in the
 * same format that tracker.js already expects:
 *   { [metricKey]: { [teamShortName]: [{round, value}, ...] } }
 *
 * roundCount and metricKeys are accepted for backward compatibility but
 * roundCount is now determined from the API response.
 */
export async function loadRoundData(_roundCount, metricKeys) {
  const res = await fetch(`${BACKEND}/power_rankings_history/nrl`);
  const data = await res.json();
  const history = data.history || {};

  const allMetrics = {};
  metricKeys.forEach(key => { allMetrics[key] = {}; });

  for (const [fullName, rounds] of Object.entries(history)) {
    const shortName = TEAM_SHORT[fullName] || fullName;

    for (const key of metricKeys) {
      const apiField = METRIC_KEY_MAP[key];
      if (!apiField) continue;
      if (!allMetrics[key][shortName]) allMetrics[key][shortName] = [];

      for (const entry of rounds) {
        const value = entry[apiField];
        if (value !== null && value !== undefined) {
          allMetrics[key][shortName].push({ round: entry.round, value });
        }
      }
    }
  }

  return allMetrics;
}
