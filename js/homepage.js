// homepage.js — loads latest round snapshot for the homepage

const BACKEND = 'https://bsmachine-backend.onrender.com/api';

function teamSlug(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('broncos'))                           return 'broncos';
  if (n.includes('raiders'))                           return 'raiders';
  if (n.includes('bulldogs'))                          return 'bulldogs';
  if (n.includes('sharks'))                            return 'sharks';
  if (n.includes('dolphins'))                          return 'dolphins';
  if (n.includes('titans'))                            return 'titans';
  if (n.includes('sea eagles') || n.includes('manly')) return 'manly';
  if (n.includes('storm'))                             return 'storm';
  if (n.includes('knights'))                           return 'knights';
  if (n.includes('cowboys'))                           return 'cowboys';
  if (n.includes('eels') || n.includes('parramatta'))  return 'eels';
  if (n.includes('panthers'))                          return 'panthers';
  if (n.includes('rabbitohs'))                         return 'rabbitohs';
  if (n.includes('dragons'))                           return 'dragons';
  if (n.includes('roosters'))                          return 'roosters';
  if (n.includes('warriors'))                          return 'warriors';
  if (n.includes('tigers'))                            return 'tigers';
  return n.replace(/\s+/g, '_');
}

async function loadSnapshot() {
  let rankings, roundNumber;
  try {
    const res = await fetch(`${BACKEND}/power_rankings/nrl`);
    const json = await res.json();
    rankings    = json.rankings || [];
    roundNumber = json.round_number;
  } catch {
    return;
  }

  if (roundNumber != null) {
    const badge = document.getElementById('round-badge');
    if (badge) badge.textContent = `Round ${roundNumber}`;
  }

  // --- Who's Hot / Who's Not ---
  const sorted    = [...rankings].sort((a, b) => (b.form ?? 0) - (a.form ?? 0));
  const hotThree  = sorted.slice(0, 3);
  const coldThree = sorted.slice(-3).reverse();

  function renderFormList(containerId, teams, isHot) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = teams.map((r, i) => {
      const totalChange = (r.form ?? 0) * 3;
      const sign = totalChange >= 0 ? '+' : '';
      const isTop = i === 0;
      return `
        <div class="flex items-center gap-3 ${isTop ? '' : 'mt-2 pt-2 border-t border-gray-700/50'}">
          <img src="./logos/${teamSlug(r.team)}.svg" alt="${r.team}"
               class="${isTop ? 'w-10 h-10' : 'w-7 h-7'} object-contain shrink-0"
               onerror="this.style.display='none'">
          <div>
            <div class="${isTop ? 'text-base font-bold text-white' : 'text-sm font-semibold text-gray-200'} leading-tight">
              ${r.team}
            </div>
            <div class="text-xs font-medium mt-0.5 ${isHot ? 'text-green-400' : 'text-red-400'}">
              ${sign}${totalChange.toFixed(2)} over last 3
            </div>
          </div>
        </div>`;
    }).join('');
  }

  renderFormList('snap-hot-list',  hotThree,  true);
  renderFormList('snap-cold-list', coldThree, false);

  // --- Finals Bubble buckets ---
  const buckets = { clinched: [], cusp: [], hunt: [], unlikely: [], faded: [] };

  rankings.forEach(r => {
    const p = r.percent_top8 ?? 0;
    if (p >= 1.0)       buckets.clinched.push(r.team);
    else if (p > 0.80)  buckets.cusp.push(r.team);
    else if (p >= 0.20) buckets.hunt.push(r.team);
    else if (p > 0.0)   buckets.unlikely.push(r.team);
    else                buckets.faded.push(r.team);
  });

  function renderBucket(id, teams) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!teams.length) {
      el.closest('.snap-bucket')?.style.setProperty('display', 'none');
      return;
    }
    el.innerHTML = teams.map(t =>
      `<span class="inline-flex items-center gap-1">
        <img src="./logos/${teamSlug(t)}.svg" alt="${t}"
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
