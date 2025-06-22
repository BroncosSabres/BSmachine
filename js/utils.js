// utils.js

/**
 * Finds the latest round folder that contains a results.csv file
 * Example: "Round6"
 */
export async function getLatestRoundFolder() {
  try {
    const res = await fetch('../data/latestRound.json');
    if (!res.ok) throw new Error('latestRound.json not found');
    const data = await res.json();
    if (typeof data.latest === 'number' && data.latest > 0) {
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
  