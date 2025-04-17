// predictions.js
import { getLatestRoundFolder, formatPercent } from './utils.js';

const tableBody = document.querySelector("#predictions-table tbody");

function getPredictedWinner(home, away, homePerc, awayPerc) {
  if (homePerc > awayPerc) return home;
  else if (awayPerc > homePerc) return away;
  return "Even";
}

async function loadPredictions() {
  const roundFolder = await getLatestRoundFolder();
  if (!roundFolder) {
    console.warn("No valid round folder found.");
    return;
  }

  const predictionsPath = `data/${roundFolder}/Predictions.txt`;
  console.log("Fetching predictions from:", predictionsPath);

  try {
    const response = await fetch(predictionsPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const text = await response.text();
    const lines = text.trim().split("\n");
    console.log(`Loaded ${lines.length} prediction lines.`);

    lines.forEach((line, idx) => {
      try {
        const jsonLine = line.replace(/'/g, '"');
        const data = JSON.parse(jsonLine);
        const {
          home_team, away_team, home_score, away_score,
          home_perc, away_perc
        } = data;

        const predictedWinner = getPredictedWinner(home_team, away_team, home_perc, away_perc);
        const winProb = predictedWinner === home_team ? home_perc : away_perc;
        const expectedScore = `${home_score}-${away_score}`;
        const expectedTotal = home_score + away_score;

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="border px-4 py-2">${home_team}</td>
          <td class="border px-4 py-2">${away_team}</td>
          <td class="border px-4 py-2">${predictedWinner}</td>
          <td class="border px-4 py-2">${formatPercent(winProb)}</td>
          <td class="border px-4 py-2">${expectedScore}</td>
          <td class="border px-4 py-2">${expectedTotal}</td>
        `;
        tableBody.appendChild(tr);
      } catch (err) {
        console.error(`Error parsing line ${idx}:`, line, err);
      }
    });
  } catch (err) {
    console.error("Failed to load predictions:", err);
  }
}

loadPredictions();
