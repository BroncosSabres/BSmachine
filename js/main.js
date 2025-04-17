// main.js
import { updateChart, updateScatter, formatDecimal, formatPercent } from './charts.js';

const ladderTable = document.querySelector("#ladder-table tbody");
const rankingsTable = document.querySelector("#rankings-table tbody");
const chartDropdown = document.getElementById("chart-select");

let resultsData = [];

async function getLatestRoundFolder() {
  const roundCount = 30;
  for (let i = roundCount; i >= 0; i--) {
    const response = await fetch(`data/Round${i}/results.csv`);
    if (response.ok) return `Round${i}`;
  }
  return null;
}

(async () => {
  const roundFolder = await getLatestRoundFolder();
  if (!roundFolder) return;
  const currentRoundNum = parseInt(roundFolder.replace("Round", ""));
  const prevRoundFolder = `Round${currentRoundNum - 1}`;

  let prevDataMap = {};
  try {
    const prevRes = await fetch(`data/${prevRoundFolder}/results.csv`);
    if (prevRes.ok) {
      const prevText = await prevRes.text();
      const prevParsed = Papa.parse(prevText, { header: true });
      prevParsed.data.forEach(row => {
        if (row["Team"]) prevDataMap[row["Team"]] = row;
      });
    }
  } catch (err) {
    console.warn("Previous round data not available");
  }

  const res = await fetch(`data/${roundFolder}/results.csv`);
  const resultsText = await res.text();
  const parsedResults = Papa.parse(resultsText, { header: true });
  resultsData = parsedResults.data;

  resultsData.forEach(row => {
    if (!row["Team"]) return;
    const prev = prevDataMap[row["Team"]];
    const change = prev ? (parseFloat(row["Total Rating"]) - parseFloat(prev["Total Rating"])).toFixed(2) : "";
    const changeArrow = change > 0 ? `<span style='color:green'>▲</span>${Math.abs(change)}` : change < 0 ? `<span style='color:red'>▼</span>${Math.abs(change)}` : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="border px-4 py-2 text-center">${row["Rank"]}</td>
      <td class="border px-4 py-2">${row["Team"]}</td>
      <td class="border px-4 py-2 text-center">${formatDecimal(row["Total Rating"])} ${changeArrow}</td>
      <td class="border px-4 py-2 text-center">${formatDecimal(row["form"] ?? 0)}</td>
      <td class="border px-4 py-2 text-center">${formatPercent(row["Top 8"])}</td>
      <td class="border px-4 py-2 text-center">${formatPercent(row["Top 4"])}</td>
      <td class="border px-4 py-2 text-center">${formatPercent(row["Minor Premiers"])}</td>
      <td class="border px-4 py-2 text-center">${formatPercent(row["Premiers"])}</td>
      <td class="border px-4 py-2 text-center">${formatPercent(row["Spoon"])}</td>
    `;
    rankingsTable.appendChild(tr);
  });

  updateChart(resultsData, "Top 8", prevDataMap);
  updateScatter(resultsData);

  chartDropdown.addEventListener("change", (e) => {
    updateChart(resultsData, e.target.value, prevDataMap);
  });

  const ladderRes = await fetch(`data/${roundFolder}/projected_ladder.csv`);
  const ladderText = await ladderRes.text();
  const parsedLadder = Papa.parse(ladderText, { header: true });

  parsedLadder.data.forEach(row => {
    if (!row["Team"]) return;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="border px-4 py-2 text-center">${row["Rank"]}</td>
      <td class="border px-4 py-2">${row["Team"]}</td>
      <td class="border px-4 py-2 text-center">${row["Wins"]}</td>
      <td class="border px-4 py-2 text-center">${row["Losses"]}</td>
      <td class="border px-4 py-2 text-center">${row["PD"]}</td>
      <td class="border px-4 py-2 text-center">${row["Points For"]}</td>
      <td class="border px-4 py-2 text-center">${row["Points Against"]}</td>
    `;
    ladderTable.appendChild(tr);
  });
})();