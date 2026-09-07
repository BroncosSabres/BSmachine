// utils.js

export function teamSlug(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('broncos'))                              return 'broncos';
  if (n.includes('raiders'))                              return 'raiders';
  if (n.includes('bulldogs'))                             return 'bulldogs';
  if (n.includes('sharks'))                               return 'sharks';
  if (n.includes('dolphins'))                             return 'dolphins';
  if (n.includes('titans'))                               return 'titans';
  if (n.includes('sea eagles') || n.includes('manly'))    return 'manly';
  if (n.includes('storm'))                                return 'storm';
  if (n.includes('knights'))                              return 'knights';
  if (n.includes('cowboys'))                              return 'cowboys';
  if (n.includes('eels') || n.includes('parramatta'))     return 'eels';
  if (n.includes('panthers'))                             return 'panthers';
  if (n.includes('rabbitohs'))                            return 'rabbitohs';
  if (n.includes('dragons'))                              return 'dragons';
  if (n.includes('roosters'))                             return 'roosters';
  if (n.includes('warriors'))                             return 'warriors';
  if (n.includes('tigers'))                               return 'tigers';
  return n.replace(/\s+/g, '_');
}

const ROUND_TYPE_LABELS = {
  qualifying_final:   'Qualifying Final',
  elimination_final:  'Elimination Final',
  semi_final:         'Semi Final',
  preliminary_final:  'Preliminary Final',
  grand_final:        'Grand Final',
};

/**
 * Friendly round label for a round number + round_type (from /api/round_types),
 * e.g. roundLabel(28, 'semi_final') -> "Semi Final". Falls back to "Round N"
 * for regular-season rounds or when round_type is unknown.
 */
export function roundLabel(roundNumber, roundType) {
  return ROUND_TYPE_LABELS[roundType] || `Round ${roundNumber}`;
}

/**
 * Finds the latest round folder that contains a results.csv file
 * Example: "Round6"
 */
export async function getLatestRoundFolder() {
  try {
    const res = await fetch('/data/latestRound.json');
    if (!res.ok) throw new Error('latestRound.json not found');
    const data = await res.json();
    if (typeof data.latest === 'number' && data.latest >= 0) {
      return `Round${data.latest}`;
    }
    return null;
  } catch (e) {
    console.error('Failed to get latest round:', e);
    return null;
  }
}
  
  /**
   * Format a decimal as a percentage string
   * @param {number} val
   * @returns {string}
   */
  export const formatPercent = (val) => `${(parseFloat(val) * 100).toFixed(1)}%`;
  
  /**
   * Format a number to 2 decimal places
   * @param {number} val
   * @returns {string}
   */
  export const formatDecimal = (val) => `${parseFloat(val).toFixed(2)}`;
  