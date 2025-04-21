// load-tracker-data.js

export async function loadRoundData(roundCount, metricKeys) {
    const allMetrics = {};
    metricKeys.forEach(key => {
      allMetrics[key] = {};
    });
  
    for (let round = 0; round <= roundCount; round++) {
      const path = `../data/Round${round}/results.csv`;
      try {
        const res = await fetch(path);
        const text = await res.text();
        const rows = text.trim().split('\n').map(line => line.split(','));
  
        const headers = rows[0];
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const team = row[1];
          metricKeys.forEach(metric => {
            const colIndex = headers.indexOf(metric);
            if (colIndex >= 0) {
              if (!allMetrics[metric][team]) allMetrics[metric][team] = [];
              allMetrics[metric][team].push({ round, value: parseFloat(row[colIndex]) });
            }
          });
        }
      } catch (err) {
        console.warn(`Missing or unreadable: ${path}`);
      }
    }
  
    return allMetrics;
  }
  