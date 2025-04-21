// tracker.js

// Chart is loaded via <script> in the HTML
// loadRoundData is still imported as a module
// loadRoundData is now loaded via <script type="module"> in the HTML

let matchResults = {};

// Function to extract match data into matchResults
async function extractMatchResults() {
  if (typeof window.loadMatchResults === 'function') {
    try {
      matchResults = await window.loadMatchResults();
      console.log('Match results loaded:', matchResults);
    } catch (e) {
      console.error('Failed to load match results:', e);
    }
  } else {
    console.error('window.loadMatchResults is not defined');
  }
}

const metrics = [
    'Total Rating',
    'Top 8',
    'Top 4',
    'Minor Premiers',
    'Spoon'
  ];
  
  const roundCount = 27; // Update as needed based on your current round
  
  const teamColors = {
    "Broncos": "#760135",
    "Raiders": "#32CD32",
    "Bulldogs": "#00539F",
    "Sharks": "#00A9D8",
    "Dolphins": "#E0121A",
    "Titans": "#009DDC",
    "Manly": "#6F163D",
    "Storm": "#632390",
    "Knights": "#EE3524",
    "Cowboys": "#002B5C",
    "Eels": "#006EB5",
    "Panthers": "#000000",
    "Rabbitohs": "#025D17",
    "Dragons": "#E2231B",
    "Roosters": "#E82C2E",
    "Warriors": "#231F20",
    "Tigers": "#F57600"
  };
  
  function createChart(containerId, chartData, yMax = null) {
    const ctx = document.getElementById(containerId);
    if (!ctx) return;
  
    const datasets = chartData.datasets.map((dataset, i) => {
      const teamName = dataset.label;
      const image = new Image();
      image.src = `../logos/${teamName.toLowerCase()}.svg`;
      image.width = 20;
      image.height = 20;
  
      return {
        ...dataset,
        borderColor: teamColors[teamName] || '#cccccc',
        pointRadius: dataset.data.map((_, j) => j === dataset.data.length - 1 ? 10 : 2),
        pointStyle: dataset.data.map((_, j) => j === dataset.data.length - 1 ? image : 'circle'),
        pointHoverRadius: dataset.data.map((_, j) => j === dataset.data.length - 1 ? 10 : 6),
        borderWidth: 3
      };
    });
  
    const config = {
      type: 'line',
      data: {
        labels: chartData.labels,
        datasets
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: 'white',
              usePointStyle: true
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const team = context.dataset.label;
                const roundLabel = context.label;
                const roundNumber = parseInt(roundLabel.replace('Round ', ''), 10);
                const stat = `${context.formattedValue}${yMax ? '%' : ''}`;
                const result = matchResults?.[team]?.[roundNumber] || 'Bye';
                return [`${team}: ${stat}`, `${result}`];
              }
            }
          }
        },
        scales: yMax ? {
          y: {
            max: yMax,
            min: 0
          }
        } : {}
      }
    };
  
    new Chart(ctx, config);
  }
  
  async function renderAllCharts() {
    const metricData = await window.loadRoundData(roundCount, metrics);
    const labels = Array.from({ length: roundCount + 1 }, (_, i) => `Round ${i}`);
  
    const metricConfigs = [
      { metric: 'Total Rating', container: 'ratingChart', yMax: null },
      { metric: 'Top 8', container: 'top8Chart', yMax: 100 },
      { metric: 'Top 4', container: 'top4Chart', yMax: 100 },
      { metric: 'Minor Premiers', container: 'minorChart', yMax: 100 },
      { metric: 'Spoon', container: 'spoonChart', yMax: 100 }
    ];
  
    for (const { metric, container, yMax } of metricConfigs) {
      const teamData = metricData[metric];
      const datasets = Object.entries(teamData)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([team, values]) => ({
          label: team,
          data: values.map(v => yMax ? v.value * 100 : v.value),
          fill: false,
          tension: 0.2
        }));
  
      createChart(container, { labels, datasets }, yMax);
    }
  }
  
  document.addEventListener('DOMContentLoaded', async () => {
    await extractMatchResults();
    if (typeof window.loadRoundData === 'function') {
      renderAllCharts();
    } else {
      console.error('loadRoundData is not available.');
    }
  });
  
