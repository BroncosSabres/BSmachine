// homepage.js — loads latest round snapshot for the homepage

async function getLatestRound() {
  const res = await fetch('./data/latestRound.json');
  const data = await res.json();
  return data.latest;
}

async function loadSnapshot() {
  const roundNum = await getLatestRound();
  const roundFolder = `Round${roundNum}`;

  document.getElementById('round-badge').textContent = `Round ${roundNum}`;

  const res = await fetch(`./data/${roundFolder}/results.csv`);
  const text = await res.text();
  const rows = Papa.parse(text, { header: true }).data.filter(r => r.Team);

  // --- Who's Hot / Who's Not ---
  // form = average rating change over last 3 games, so *3 = total change over 3 games
  const sorted = [...rows].sort((a, b) => parseFloat(b.form) - parseFloat(a.form));
  const hotThree  = sorted.slice(0, 3);
  const coldThree = sorted.slice(-3).reverse(); // coldest first

  function renderFormList(containerId, teams, isHot) {
    const container = document.getElementById(containerId);
    container.innerHTML = teams.map((row, i) => {
      const totalChange = parseFloat(row.form) * 3;
      const sign = totalChange >= 0 ? '+' : '';
      const isTop = i === 0;
      return `
        <div class="flex items-center gap-3 ${isTop ? '' : 'mt-2 pt-2 border-t border-gray-700/50'}">
          <img src="./logos/${row.Team.toLowerCase()}.svg" alt="${row.Team}"
               class="${isTop ? 'w-10 h-10' : 'w-7 h-7'} object-contain shrink-0"
               onerror="this.style.display='none'">
          <div>
            <div class="${isTop ? 'text-base font-bold text-white' : 'text-sm font-semibold text-gray-200'} leading-tight">
              ${row.Team}
            </div>
            <div class="${isTop ? 'text-xs' : 'text-xs'} font-medium mt-0.5 ${isHot ? 'text-green-400' : 'text-red-400'}">
              ${sign}${totalChange.toFixed(2)} over last 3
            </div>
          </div>
        </div>`;
    }).join('');
  }

  renderFormList('snap-hot-list',  hotThree,  true);
  renderFormList('snap-cold-list', coldThree, false);

  // --- Biggest Mover ---
  // (kept from before - may still be used)

  // --- Finals Bubble buckets ---
  const buckets = {
    clinched:  [],
    cusp:      [],
    hunt:      [],
    unlikely:  [],
    faded:     [],
  };

  rows.forEach(row => {
    const p = parseFloat(row["Top 8"]);
    if (p >= 1.0)       buckets.clinched.push(row.Team);
    else if (p > 0.80)  buckets.cusp.push(row.Team);
    else if (p >= 0.20) buckets.hunt.push(row.Team);
    else if (p > 0.0)   buckets.unlikely.push(row.Team);
    else                buckets.faded.push(row.Team);
  });

  function renderBucket(id, teams) {
    const el = document.getElementById(id);
    if (!teams.length) {
      el.closest('.snap-bucket').style.display = 'none';
      return;
    }
    el.innerHTML = teams.map(t =>
      `<span class="inline-flex items-center gap-1">
        <img src="./logos/${t.toLowerCase()}.svg" alt="${t}"
             class="w-4 h-4 object-contain inline-block"
             onerror="this.style.display='none'">
        ${t}
      </span>`
    ).join('<span class="text-gray-600 mx-0.5">·</span>');
  }

  renderBucket('bucket-clinched', buckets.clinched);
  renderBucket('bucket-cusp',     buckets.cusp);
  renderBucket('bucket-hunt',     buckets.hunt);
  renderBucket('bucket-unlikely', buckets.unlikely);
  renderBucket('bucket-faded',    buckets.faded);
}

loadSnapshot();
