// betslips.js — User Predictions page
document.addEventListener('DOMContentLoaded', function () {
  const API_BASE = 'https://bsmachine-backend.onrender.com/api';

  let competition   = 'nrl';
  let activeTab     = 'community';
  let currentSort   = 'recent';
  let selectedRound = null;
  let offset        = 0;
  const LIMIT       = 20;
  let loading       = false;

  const listEl       = document.getElementById('betslips-list');
  const loadMoreBtn  = document.getElementById('load-more-btn');
  const sortSel      = document.getElementById('sort-select');
  const roundSel     = document.getElementById('round-select');
  const roundWrap    = document.getElementById('round-filter-wrap');
  const matchNotice  = document.getElementById('match-filter-notice');
  const tabCommunity = document.getElementById('tab-community');
  const tabMine      = document.getElementById('tab-mine');

  // ?match= query param — when set, show betslips for one specific match
  const urlParams  = new URLSearchParams(window.location.search);
  const preMatchId = urlParams.get('match');

  // Show the match-filter notice and hide round picker when filtering by match
  if (preMatchId && matchNotice && roundWrap) {
    matchNotice.classList.remove('hidden');
    roundWrap.classList.add('hidden');
  }

  // --- COMPETITION TOGGLE ---
  document.querySelectorAll('.comp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (preMatchId) return; // competition locked when filtering by match
      competition = btn.id === 'btn-nrl' ? 'nrl' : 'nrlw';
      document.querySelectorAll('.comp-btn').forEach(b => {
        const active = b.id === `btn-${competition}`;
        b.className = active
          ? 'comp-btn px-5 py-1.5 rounded-md bg-amber-400 text-gray-900 font-bold text-sm transition-all'
          : 'comp-btn px-5 py-1.5 rounded-md text-gray-400 font-semibold text-sm transition-all';
      });
      selectedRound = null;
      initRoundDropdown().then(reload);
    });
  });

  // --- ROUND DROPDOWN ---
  roundSel?.addEventListener('change', () => {
    selectedRound = parseInt(roundSel.value, 10);
    reload();
  });

  async function initRoundDropdown() {
    if (!roundSel) return;
    if (preMatchId) return; // no round filter when showing a specific match

    roundSel.disabled = true;
    roundSel.innerHTML = '<option value="">Loading…</option>';

    try {
      const res = await fetch(`${API_BASE}/current_round_matches/${competition}`);
      if (!res.ok) throw new Error();
      const matches = await res.json();
      const currentRound = matches[0]?.round_number;
      if (!currentRound) throw new Error();

      if (selectedRound === null) selectedRound = currentRound;

      roundSel.innerHTML = '';
      for (let r = currentRound; r >= 1; r--) {
        const opt = document.createElement('option');
        opt.value       = r;
        opt.textContent = `Round ${r}`;
        if (r === selectedRound) opt.selected = true;
        roundSel.appendChild(opt);
      }
      roundSel.disabled = false;
    } catch {
      roundSel.innerHTML = '<option value="">–</option>';
      roundSel.disabled  = true;
    }
  }

  // --- SORT ---
  sortSel?.addEventListener('change', () => {
    currentSort = sortSel.value;
    reload();
  });

  // --- TABS ---
  function setTab(tab) {
    activeTab = tab;
    [tabCommunity, tabMine].forEach(t => {
      const active = t.id === `tab-${tab}`;
      t.className = active
        ? 'betslips-tab px-4 py-2 text-sm font-semibold border-b-2 border-amber-400 text-amber-400 -mb-px transition-colors'
        : 'betslips-tab px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-gray-400 -mb-px hover:text-white transition-colors';
    });
    // Round filter only applies to community tab
    if (roundWrap && !preMatchId) {
      roundWrap.classList.toggle('hidden', tab === 'mine');
    }
    reload();
  }

  tabCommunity?.addEventListener('click', () => setTab('community'));
  tabMine?.addEventListener('click',      () => setTab('mine'));

  // --- LOAD MORE ---
  loadMoreBtn?.addEventListener('click', () => loadPage(false));

  // --- DATA LOADING ---
  function reload() {
    offset = 0;
    listEl.innerHTML = '';
    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
    loadPage(true);
  }

  async function loadPage(isFirst) {
    if (loading) return;
    loading = true;
    if (isFirst) listEl.innerHTML = '<div class="text-xs text-gray-500 py-4 text-center">Loading…</div>';
    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');

    try {
      let betslips;

      if (activeTab === 'mine') {
        betslips = await loadMine();
      } else if (preMatchId) {
        betslips = await loadByMatch(preMatchId);
      } else {
        betslips = await loadByRound();
      }

      if (betslips === null) {
        // loadMine already rendered an auth error message
        loading = false;
        return;
      }

      renderCards(betslips, isFirst, activeTab === 'mine');
    } catch {
      if (isFirst) listEl.innerHTML = '<div class="text-sm text-gray-400 py-6 text-center">Could not load betslips.</div>';
    }
    loading = false;
  }

  async function loadMine() {
    const session = await (window._getSupabaseSession?.() ?? Promise.resolve(null));
    if (!session) {
      listEl.innerHTML = '<div class="text-sm text-gray-400 py-6 text-center">Sign in to see your saved betslips.</div>';
      return null;
    }
    const res = await fetch(
      `${API_BASE}/betslips/me?sort=${currentSort}&limit=${LIMIT}&offset=${offset}`,
      { headers: { 'Authorization': `Bearer ${session.access_token}` } }
    );
    if (!res.ok) throw new Error();
    return res.json();
  }

  async function loadByMatch(matchId) {
    const res = await fetch(
      `${API_BASE}/betslips/match/${matchId}?sort=${currentSort}&limit=${LIMIT}&offset=${offset}`
    );
    if (!res.ok) throw new Error();
    return res.json();
  }

  async function loadByRound() {
    if (!selectedRound) return [];
    const res = await fetch(
      `${API_BASE}/betslips/round/${selectedRound}/${competition}?sort=${currentSort}&limit=${LIMIT}&offset=${offset}`
    );
    if (!res.ok) throw new Error();
    return res.json();
  }

  function renderCards(betslips, isFirst, isMine) {
    if (isFirst) listEl.innerHTML = '';
    if (!betslips.length) {
      if (isFirst) listEl.innerHTML = '<div class="text-sm text-gray-400 py-6 text-center">No betslips found for this round.</div>';
      return;
    }

    betslips.forEach(b => {
      const el  = document.createElement('div');
      el.innerHTML = buildCard(b, isMine);
      const card = el.firstElementChild;
      listEl.appendChild(card);
      wireCard(card, b, isMine);
    });

    const hasMore = betslips.length === LIMIT;
    offset += betslips.length;
    if (loadMoreBtn) loadMoreBtn.classList.toggle('hidden', !hasMore);
  }

  function buildCard(b, isMine) {
    const picks = (b.picks || []).map(p =>
      `<span class="inline-flex items-center gap-1">
        <span class="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0 inline-block"></span>
        ${p.name}${p.n > 1 ? ` <span class="text-gray-400">×${p.n}</span>` : ''}
      </span>`
    ).join('<span class="text-gray-600 mx-1">·</span>');

    const legs = (b.line_legs || []).map(l =>
      `<span class="inline-flex items-center gap-1">
        <span class="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0 inline-block"></span>
        ${l.label || ''}
      </span>`
    ).join('<span class="text-gray-600 mx-1">·</span>');

    const oddsText = b.combined_odds ? `$${b.combined_odds}` : '–';
    const probText = b.calculated_prob ? `${(b.calculated_prob * 100).toFixed(1)}%` : '';
    const evText   = (b.bookie_odds && b.calculated_prob)
      ? (() => {
          const ev  = (b.bookie_odds * b.calculated_prob - 1) * 100;
          const col = ev >= 0 ? 'text-green-400' : 'text-red-400';
          return `<span class="${col} text-xs font-semibold">${ev >= 0 ? '+' : ''}${ev.toFixed(1)}% EV</span>`;
        })()
      : '';

    const scoreTag = b.is_scored
      ? (b.won
          ? '<span class="text-xs font-bold text-green-400 bg-green-400/10 border border-green-400/30 rounded px-2 py-0.5">Won ✓</span>'
          : '<span class="text-xs font-bold text-red-400 bg-red-400/10 border border-red-400/30 rounded px-2 py-0.5">Lost ✗</span>')
      : '<span class="text-xs text-gray-500 bg-gray-700/50 border border-gray-600/40 rounded px-2 py-0.5">Pending</span>';

    const netVotes  = b.net_votes || 0;
    const voteColor = netVotes > 0 ? 'text-green-400' : netVotes < 0 ? 'text-red-400' : 'text-gray-500';

    const matchLabel = b.match_label || '';
    const roundLabel = b.round_number ? `Rd ${b.round_number}` : '';

    const byLine = isMine
      ? `<span class="text-xs text-gray-500">${matchLabel}${matchLabel && roundLabel ? ' · ' : ''}${roundLabel}</span>`
      : `<div class="flex items-center gap-2 flex-wrap">
           <span class="text-xs font-semibold text-gray-300">${b.username || 'Unknown'}</span>
           <span class="text-xs text-gray-500">${matchLabel}${matchLabel && roundLabel ? ' · ' : ''}${roundLabel}</span>
         </div>`;

    const ownerControls = isMine ? `
      <div class="flex items-center gap-2 mt-3 pt-3 border-t border-gray-700/40">
        <button data-toggle-public="${b.id}" data-is-public="${b.is_public}"
                class="text-xs px-3 py-1 rounded border ${b.is_public ? 'border-blue-500/40 text-blue-400' : 'border-gray-600 text-gray-500'} hover:opacity-80 transition-colors font-semibold">
          ${b.is_public ? 'Public' : 'Private'}
        </button>
        <button data-delete-betslip="${b.id}"
                class="text-xs px-3 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors font-semibold">
          Delete
        </button>
      </div>` : '';

    return `
      <div class="card py-3 px-4" data-betslip-id="${b.id}">
        <div class="flex items-start justify-between gap-2 mb-2">
          <div class="flex flex-col gap-0.5 min-w-0 flex-1">
            ${byLine}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${scoreTag}
            ${!isMine ? `
            <div class="flex items-center gap-1">
              <button data-vote-betslip="${b.id}" data-v="1"
                      class="text-xs text-gray-500 hover:text-green-400 transition-colors font-bold px-1">▲</button>
              <span class="text-xs font-bold ${voteColor} min-w-[1.5rem] text-center" data-net-votes="${b.id}">${netVotes}</span>
              <button data-vote-betslip="${b.id}" data-v="-1"
                      class="text-xs text-gray-500 hover:text-red-400 transition-colors font-bold px-1">▼</button>
            </div>` : ''}
          </div>
        </div>

        ${(picks || legs) ? `
        <div class="text-xs text-gray-400 flex flex-wrap items-center gap-x-1.5 gap-y-1 mb-3 leading-relaxed">
          ${picks}${picks && legs ? '<span class="text-gray-600 mx-1">+</span>' : ''}${legs}
        </div>` : ''}

        <div class="flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-3">
            <div>
              <span class="text-xl font-extrabold text-amber-400">${oddsText}</span>
              ${probText ? `<span class="text-xs text-gray-500 ml-1">${probText}</span>` : ''}
            </div>
            ${b.bookie_odds ? `<div class="text-xs text-gray-400">Bookie <span class="font-bold text-white">$${b.bookie_odds}</span> ${evText}</div>` : ''}
          </div>
          <a href="../pages/tryscorer_predictions.html" class="text-xs text-blue-400 hover:underline">Build your own →</a>
        </div>
        ${ownerControls}
      </div>`;
  }

  function wireCard(card, b, isMine) {
    card.querySelectorAll('[data-vote-betslip]').forEach(btn => {
      btn.addEventListener('click', () => handleVote(btn, b.id));
    });

    card.querySelector('[data-toggle-public]')?.addEventListener('click', async function () {
      const session = await (window._getSupabaseSession?.() ?? Promise.resolve(null));
      if (!session) return;
      const newPublic = this.dataset.isPublic !== 'true';
      try {
        const res = await fetch(`${API_BASE}/betslips/${b.id}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
          body:    JSON.stringify({ is_public: newPublic }),
        });
        if (res.ok) {
          this.dataset.isPublic = String(newPublic);
          this.textContent      = newPublic ? 'Public' : 'Private';
          this.className        = `text-xs px-3 py-1 rounded border ${newPublic ? 'border-blue-500/40 text-blue-400' : 'border-gray-600 text-gray-500'} hover:opacity-80 transition-colors font-semibold`;
        }
      } catch { /* non-fatal */ }
    });

    card.querySelector('[data-delete-betslip]')?.addEventListener('click', async function () {
      if (!confirm('Delete this betslip?')) return;
      const session = await (window._getSupabaseSession?.() ?? Promise.resolve(null));
      if (!session) return;
      try {
        const res = await fetch(`${API_BASE}/betslips/${b.id}`, {
          method:  'DELETE',
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        });
        if (res.ok) card.remove();
      } catch { /* non-fatal */ }
    });
  }

  async function handleVote(btn, betslipId) {
    const session = await (window._getSupabaseSession?.() ?? Promise.resolve(null));
    if (!session) { showToast('Sign in to vote on betslips'); return; }
    const vote = parseInt(btn.dataset.v, 10);
    try {
      const res = await fetch(`${API_BASE}/betslips/${betslipId}/vote`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body:    JSON.stringify({ vote }),
      });
      if (res.ok) {
        const data  = await res.json();
        const netEl = document.querySelector(`[data-net-votes="${betslipId}"]`);
        const net   = data.net_votes ?? 0;
        if (netEl) {
          netEl.textContent = net;
          netEl.className   = `text-xs font-bold ${net > 0 ? 'text-green-400' : net < 0 ? 'text-red-400' : 'text-gray-500'} min-w-[1.5rem] text-center`;
        }
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Could not vote');
      }
    } catch { showToast('Could not vote'); }
  }

  function showToast(msg) {
    let container = document.getElementById('_bs-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = '_bs-toast-container';
      container.style.cssText = 'position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.style.cssText = 'background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:10px 16px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,0.5);white-space:nowrap;opacity:1;transition:opacity 0.35s';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 360); }, 3000);
  }

  // --- INIT ---
  if (preMatchId) {
    // Skip round init and go straight to match-specific view
    reload();
  } else {
    initRoundDropdown().then(reload);
  }
});
