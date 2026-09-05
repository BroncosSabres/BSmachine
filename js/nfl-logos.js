// nfl-logos.js
// Logo filenames follow the source convention used in logos/nfl/:
// "{Team_Name_With_Underscores}_logo.svg", keyed off the team's full name
// exactly as returned by the API. A few teams don't use their full official
// name in the sourced file - add overrides here as they're found (e.g. the
// Rams file is "LA_Rams_logo.svg", not "Los_Angeles_Rams_logo.svg").
const LOGO_FILENAME_OVERRIDES = {
  'Los Angeles Rams': 'LA_Rams_logo.svg',
};

export function nflLogoFilename(teamName) {
  if (LOGO_FILENAME_OVERRIDES[teamName]) return LOGO_FILENAME_OVERRIDES[teamName];
  return `${(teamName || '').replace(/\s+/g, '_')}_logo.svg`;
}

export function nflLogoUrl(teamName) {
  return `/logos/nfl/${nflLogoFilename(teamName)}`;
}
