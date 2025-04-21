// load-match-results.js

export async function loadMatchResults() {
    const matchResults = {};
    // Fetch the raw match results CSV
    const res = await fetch("../data/nrl-25.csv");
    const text = await res.text();
  
    // Split into lines and parse CSV cells
    const lines = text.trim().split(/\r?\n/);
    const rows = lines.map(line => line.split(","));
    
    // Expect header: ["Match Number","Round Number","Location","Home Team","Away Team","Home Score","Away Score"]
    // Data rows follow in the same order.
    rows.slice(1).forEach(row => {
      const round = parseInt(row[1], 10);
      const homeTeam = row[3].trim();
      const awayTeam = row[4].trim();
      const homeScore = row[5].trim();
      const awayScore = row[6].trim();
  
      // Initialize per-team objects
      if (!matchResults[homeTeam]) matchResults[homeTeam] = {};
      if (!matchResults[awayTeam]) matchResults[awayTeam] = {};
  
          // Assign result strings for each team with W/L/D prefixes
      const homeScoreNum = parseInt(homeScore, 10);
      const awayScoreNum = parseInt(awayScore, 10);
      const homePrefix = homeScoreNum > awayScoreNum ? 'W ' : homeScoreNum < awayScoreNum ? 'L ' : 'D ';
      const awayPrefix = awayScoreNum > homeScoreNum ? 'W ' : awayScoreNum < homeScoreNum ? 'L ' : 'D ';
      matchResults[homeTeam][round] = `${homePrefix}vs ${awayTeam} ${homeScore}-${awayScore}`;
      matchResults[awayTeam][round] = `${awayPrefix}vs ${homeTeam} ${awayScore}-${homeScore}`;
    });
  
    return matchResults;
  }
  