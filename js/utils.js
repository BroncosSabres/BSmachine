// utils.js

/**
 * Finds the latest round folder that contains a results.csv file
 * Example: "Round6"
 */
export async function getLatestRoundFolder() {
    const roundCount = 30; // Check up to 30 rounds
    for (let i = roundCount; i >= 0; i--) {
      const res = await fetch(`data/Round${i}/results.csv`);
      if (res.ok) return `Round${i}`;
    }
    return null;
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
  