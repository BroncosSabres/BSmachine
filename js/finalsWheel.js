// js/finalsWheel.js

import { getLatestRoundFolder } from './utils.js';

// 1. Define your team→colour mapping
const yourColourMap = {
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

  const logoPath = name => `./logos/${name.toLowerCase()}.svg`;
  
  // 2. Simple CSV parser
  function parseCSV(text) {
    const [headerLine, ...lines] = text.trim().split('\n');
    const headers = headerLine.split(',');
    return lines.map(line => {
      const cols = line.split(',');
      return headers.reduce((obj, h, i) => {
        obj[h] = cols[i];
        return obj;
      }, {});
    });
  }
  
  // 3. Main drawing function
  async function drawFinalsWheel() {
    // Enlarge container and canvas for a bigger chart
    const canvas = document.getElementById('finalsWheel');
    const container = canvas.parentElement;
    container.style.maxWidth = '600px';
    container.style.maxHeight = '600px';
    canvas.style.height = '600px';
  
    const roundFolder = await getLatestRoundFolder();
    if (!roundFolder) {
        console.warn("No valid round folder found.");
        return;
    }

    const resultsFile = `../data/${roundFolder}/results.csv`;

    const resp = await fetch(resultsFile);
    const text = await resp.text();
    const rows = parseCSV(text);

    // After parsing rows
    rows.sort((a, b) => a.Team.localeCompare(b.Team));

    // Filter to only teams that have any nonzero odds
    const filtered = rows.filter(r =>
        (+r['Top 8']    > 0)
    );

    // Now build arrays from filtered
    const teamNames   = filtered.map(r => r.Team);
    const finalsOdds  = filtered.map(r => +r['Top 8']    * 100);
    const semiOdds    = filtered.map(r => +r['Week 2']   * 100);
    const prelimOdds  = filtered.map(r => +r['Week 3']   * 100);
    const gfOdds      = filtered.map(r => +r['Make GF']  * 100);
    const premierOdds = filtered.map(r => +r['Premiers'] * 100);

    const teamColours = teamNames.map(name => yourColourMap[name] || '#CCCCCC');

    // preload logo images
    const logos = teamNames.map(name => {
        const img = new Image();
        img.onload  = () => console.log(`Loaded logo for ${name}`);
        img.onerror = () => console.error(`Failed loading logo for ${name} at ${logoPath(name)}`);
        img.src = logoPath(name);
        return img;
      });
      await Promise.all(logos.map(img => new Promise(resolve => {
        if (img.complete) resolve();
        else { img.onload = resolve; img.onerror = resolve; }
      })));
  
    const ctx = canvas.getContext('2d');
    new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: teamNames,
        datasets: [
          { label: 'Top 8',      data: finalsOdds,  backgroundColor: teamColours,  weight: 1 , borderColor: '#ccc', borderWidth: 1},
          { label: 'Semi Finals',      data: semiOdds,    backgroundColor: teamColours,  weight: 1 , borderColor: '#ccc', borderWidth: 1},
          { label: 'Preliminary Finals',   data: prelimOdds,  backgroundColor: teamColours,  weight: 1 , borderColor: '#ccc', borderWidth: 1},
          { label: 'GF',         data: gfOdds,      backgroundColor: teamColours,  weight: 1 , borderColor: '#ccc', borderWidth: 1},
          { label: 'Premiers',   data: premierOdds, backgroundColor: teamColours,  weight: 1  , borderColor: '#ccc', borderWidth: 1}
        ]
      },
      options: {
        cutout: '15%',          // inner hole for the smallest ring
        radius:  '100%',        // max outer radius
        maintainAspectRatio: false,
        layout: {
            padding: {
              top: 40,
              bottom: 40,
              left: 40,
              right: 40
            }
          },
        plugins: {
            legend: {display: false},
            tooltip: {
                callbacks: {
                    label(ctx) {
                        // Include the outcome (dataset label) in the tooltip
                        const outcome = ctx.dataset.label;
                        const team    = ctx.label;
                        const value   = ctx.formattedValue;
                        return `${outcome} – ${team}: ${value}%`;
                    }
                }
            }
        }
      },
      plugins: [
        {
            id: 'ringLabels',
            afterDatasetsDraw(chart) {
              const { ctx, chartArea } = chart;
              const centerX = chartArea.left + chartArea.width / 2;
              const centerY = chartArea.top + chartArea.height / 2;
              const labels = ['Qualifying Finals', 'Semi Finals', 'Preliminary Finals', 'Grand Final', 'Premiers'];
              // 20° clockwise from vertical
              const baseAngle = -Math.PI/2 + (0 * Math.PI/180);
              labels.forEach((text, i) => {
                const arc = chart.getDatasetMeta(i).data[0];
                const r = arc.outerRadius - 5;
                // position below ring along rotated angle
                const angle = baseAngle;
                const x = centerX + Math.cos(angle) * r;
                const y = centerY + Math.sin(angle) * r;
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(angle + Math.PI/2); // align text tangentially
                ctx.font = 'bold 12px sans-serif';
                ctx.fillStyle = '#fff';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top'; // below the ring
                ctx.fillText(text, 0, 4);
                ctx.restore();
              });
            }
          },
        {
            // draw logos outside the outer ring
            id: 'outerLogos',
            afterDatasetsDraw(chart) {
              const { ctx } = chart;
              const meta = chart.getDatasetMeta(0);
              const arcs = meta.data;
              if (!arcs.length) return;
              const offset = 20;
              arcs.forEach((arcElem, i) => {
                const angle = (arcElem.startAngle + arcElem.endAngle) / 2;
                const centerX = arcElem.x;
                const centerY = arcElem.y;
                const outerRadius = arcElem.outerRadius;
                const x = centerX + Math.cos(angle) * (outerRadius + offset);
                const y = centerY + Math.sin(angle) * (outerRadius + offset);
                const img = logos[i];
                const size = 24;
                if (img.complete) {
                  ctx.drawImage(img, x - size/2, y - size/2, size, size);
                }
              });
            }
          },
        {
            id: 'centerImage',
            beforeDraw(chart) {
              const { ctx, chartArea } = chart;
              const img = document.getElementById('trophy');
              if (!img.complete) return;
    
              // calculate max size (10% of chart area)
              const maxDim = Math.min(chartArea.width, chartArea.height) * 0.10;
              // maintain aspect ratio
              const ratio = img.naturalWidth / img.naturalHeight;
              let drawWidth, drawHeight;
              if (ratio >= 1) {
                drawWidth = maxDim;
                drawHeight = maxDim / ratio;
              } else {
                drawHeight = maxDim;
                drawWidth = maxDim * ratio;
              }
    
              // center the image
              const x = chartArea.left + (chartArea.width  - drawWidth)  / 2;
              const y = chartArea.top  + (chartArea.height - drawHeight) / 2;
              ctx.drawImage(img, x, y, drawWidth, drawHeight);
          }
        }
      ]
    });
  }
  
  // 4. Initialize on DOM ready
  window.addEventListener('DOMContentLoaded', drawFinalsWheel);
  