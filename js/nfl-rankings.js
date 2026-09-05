// nfl-rankings.js — drives nfl/pages/rankings.html
import { apiUrl } from './api-config.js';
import { formBadge, rankChangeBadge, probColor } from './rankings-shared.js';
import { nflLogoUrl } from './nfl-logos.js';

const rankingsTable = document.querySelector("#rankings-table tbody");
const weekBadge     = document.getElementById("week-badge");

let prevRankByTeam = {};

async function loadRankings() {
  rankingsTable.innerHTML = '';

  const res = await fetch(apiUrl('nfl', 'power_rankings'));
  if (!res.ok) return;
  const json = await res.json();

  const rankings   = json.rankings || [];
  const weekNumber = json.week_number;

  if (weekBadge && weekNumber != null) weekBadge.textContent = `Week ${weekNumber}`;

  // Fetch the previous week's rankings (if any) purely for the rank-change arrow
  prevRankByTeam = {};
  if (weekNumber > 1) {
    try {
      const prevRes = await fetch(apiUrl('nfl', `power_rankings?week=${weekNumber - 1}`));
      if (prevRes.ok) {
        const prevJson = await prevRes.json();
        (prevJson.rankings || []).forEach(r => { prevRankByTeam[r.team] = r.rank; });
      }
    } catch (e) { /* previous week may not exist yet, non-fatal */ }
  }

  rankings.forEach(r => {
    const wc = r.weekly_change;
    const formArrow = wc != null
      ? (wc > 0
          ? `<span style='color:#4ade80'>▲</span>${Math.abs(wc).toFixed(2)}`
          : wc < 0
            ? `<span style='color:#f87171'>▼</span>${Math.abs(wc).toFixed(2)}`
            : '')
      : '';
    const record = `${r.wins ?? 0}-${r.losses ?? 0}${r.ties ? `-${r.ties}` : ''}`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-center text-gray-400 font-medium">
        ${r.rank}${rankChangeBadge(r.rank, prevRankByTeam[r.team])}
      </td>
      <td>
        <div class="flex items-center gap-2">
          <img src="${nflLogoUrl(r.team)}"
               alt="${r.team}" class="w-6 h-6 object-contain shrink-0"
               onerror="this.style.display='none'">
          <span>${r.team}</span>
        </div>
      </td>
      <td class="text-center font-mono">${Number(r.total_rating).toFixed(2)} ${formArrow}</td>
      <td class="text-center">${formBadge(r.form)}</td>
      <td class="text-center font-mono">${record}</td>
      <td class="text-center font-medium" style="${probColor(r.percent_playoffs)}">${formatPercent(r.percent_playoffs)}</td>
      <td class="text-center font-medium" style="${probColor(r.percent_division_winner)}">${formatPercent(r.percent_division_winner)}</td>
      <td class="text-center font-medium" style="${probColor(r.percent_first_round_bye)}">${formatPercent(r.percent_first_round_bye)}</td>
      <td class="text-center font-medium" style="${probColor(r.percent_conf_championship)}">${formatPercent(r.percent_conf_championship)}</td>
      <td class="text-center font-medium" style="${probColor(r.percent_super_bowl_champion)}">${formatPercent(r.percent_super_bowl_champion)}</td>
    `;
    rankingsTable.appendChild(tr);
  });
}

function formatPercent(val) {
  if (val == null || isNaN(parseFloat(val))) return '—';
  return `${(parseFloat(val) * 100).toFixed(1)}%`;
}

loadRankings();
