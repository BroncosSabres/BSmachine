// tracker.js

// Chart is loaded via <script> in the HTML
// loadRoundData is still imported as a module
// loadRoundData is now loaded via <script type="module"> in the HTML

let matchResults = {};
const charts = {};

// Metrics and chart configuration
const metrics = [
  'Total Rating',
  'Top 8',
  'Top 4',
  'Minor Premiers',
  'Spoon'
];
const roundCount = 27; // Update as needed based on your current round

// Team colors mapping
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

// Load match results if available
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

// Create a Chart.js chart and store it
function createChart(containerId, chartData, yMax = null) {
  const ctx = document.getElementById(containerId);
  if (!ctx) return;

  const datasets = chartData.datasets.map((dataset) => {
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

  const chart = new Chart(ctx, config);
  charts[chartData.metric] = chart;
  return chart;
}

// Create team toggle controls (checkboxes + buttons)
function createControls(teamNames) {
  const container = document.createElement('div');
  container.id = 'team-toggle-controls';
  container.style.margin = '10px 0';
  container.style.color = 'white';
  container.style.display = 'flex';
  container.style.flexWrap = 'wrap';
  container.style.alignItems = 'center';

  // Team checkboxes wrapper
  const teamWrapper = document.createElement('div');
  teamWrapper.style.display = 'flex';
  teamWrapper.style.flexWrap = 'wrap';

  teamNames.forEach(team => {
    const label = document.createElement('label');
    label.style.margin = '6px 8px';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `toggle-${team}`;
    checkbox.value = team;
    checkbox.checked = true;
    checkbox.addEventListener('change', updateChartDatasets);
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(team));
    teamWrapper.appendChild(label);
  });

  // Select All button box
  const selectBox = document.createElement('div');
  selectBox.style.border = '2px solid white';
  selectBox.style.borderRadius = '6px';
  selectBox.style.padding = '6px 12px';
  selectBox.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
  selectBox.style.marginLeft = '20px';
  const selectBtn = document.createElement('button');
  selectBtn.textContent = 'Select All';
  selectBtn.style.background = 'none';
  selectBtn.style.border = 'none';
  selectBtn.style.color = 'white';
  selectBtn.style.cursor = 'pointer';
  selectBtn.addEventListener('click', () => {
    teamNames.forEach(team => document.getElementById(`toggle-${team}`).checked = true);
    updateChartDatasets();
  });
  selectBox.appendChild(selectBtn);

  // Unselect All button box
  const unselectBox = document.createElement('div');
  unselectBox.style.border = '2px solid white';
  unselectBox.style.borderRadius = '6px';
  unselectBox.style.padding = '6px 12px';
  unselectBox.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
  unselectBox.style.marginLeft = '10px';
  const unselectBtn = document.createElement('button');
  unselectBtn.textContent = 'Unselect All';
  unselectBtn.style.background = 'none';
  unselectBtn.style.border = 'none';
  unselectBtn.style.color = 'white';
  unselectBtn.style.cursor = 'pointer';
  unselectBtn.addEventListener('click', () => {
    teamNames.forEach(team => document.getElementById(`toggle-${team}`).checked = false);
    updateChartDatasets();
  });
  unselectBox.appendChild(unselectBtn);

  container.appendChild(teamWrapper);
  container.appendChild(selectBox);
  container.appendChild(unselectBox);

  // Insert container above the first chart section
  const ratingCanvas = document.getElementById('ratingChart');
  if (ratingCanvas && ratingCanvas.parentElement && ratingCanvas.parentElement.parentElement) {
    const section = ratingCanvas.parentElement;
    section.parentElement.insertBefore(container, section);
  } else {
    document.body.insertBefore(container, document.body.firstChild);
  }
}

// Update chart dataset visibility based on toggles
function updateChartDatasets() {
  Object.entries(charts).forEach(([metric, chart]) => {
    chart.data.datasets.forEach((dataset, idx) => {
      const checkbox = document.getElementById(`toggle-${dataset.label}`);
      const visible = checkbox ? checkbox.checked : true;
      const meta = chart.getDatasetMeta(idx);
      meta.hidden = !visible;
    });
    chart.update();
  });
}

// Render all charts and setup controls
async function renderAllCharts() {
  const metricData = await window.loadRoundData(roundCount, metrics);
  const labels = Array.from({ length: roundCount + 1 }, (_, i) => `Round ${i}`);

  // Determine team list from data
  const teamNames = Object.keys(metricData[metrics[0]]).sort();
  createControls(teamNames);

  // Generate charts per metric
  const metricConfigs = [
    { metric: 'Total Rating', container: 'ratingChart', yMax: null },
    { metric: 'Top 8', container: 'top8Chart', yMax: 100 },
    { metric: 'Top 4', container: 'top4Chart', yMax: 100 },
    { metric: 'Minor Premiers', container: 'minorChart', yMax: 100 },
    { metric: 'Spoon', container: 'spoonChart', yMax: 100 }
  ];

  metricConfigs.forEach(({ metric, container, yMax }) => {
    const teamData = metricData[metric];
    const datasets = Object.entries(teamData)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([team, values]) => ({
        label: team,
        data: values.map(v => yMax ? v.value * 100 : v.value),
        fill: false,
        tension: 0.2
      }));
    createChart(container, { metric, labels, datasets }, yMax);
  });
}

// Initialize everything once DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  await extractMatchResults();
  if (typeof window.loadRoundData === 'function') {
    renderAllCharts();
  } else {
    console.error('loadRoundData is not available.');
  }
});
