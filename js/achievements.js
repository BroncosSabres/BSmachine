// achievements.js — shared badge helper for toast notifications and rendering
// Import and call initAchievementToasts(userId) on any authenticated page.

const BACKEND = 'https://bsmachine-backend.onrender.com/api'
const LS_KEY  = 'bsm_achievements_last_check'

// Tier colour styles (inline, no Tailwind dependency)
const TIER_STYLE = {
  gold:   'background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);color:#fbbf24;',
  silver: 'background:rgba(148,163,184,0.12);border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;',
  bronze: 'background:rgba(180,83,9,0.15);border:1px solid rgba(180,83,9,0.4);color:#fb923c;',
}

// ── Fetching ──────────────────────────────────────────────────────────────────

let _defsCache = null

export async function fetchBadgeDefs() {
  if (_defsCache) return _defsCache
  try {
    const res = await fetch(`${BACKEND}/achievements`)
    _defsCache = res.ok ? await res.json() : []
  } catch { _defsCache = [] }
  return _defsCache
}

export async function fetchUserAchievements(userId) {
  try {
    const res = await fetch(`${BACKEND}/user_achievements/${userId}`)
    return res.ok ? await res.json() : []
  } catch { return [] }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Render a single badge chip element.
 * @param {object} def - badge definition { id, name, emoji, tier, description }
 * @param {number} count - times earned (0 = locked/greyed)
 * @param {number[]} rounds - array of round numbers earned
 */
export function renderBadgeChip(def, count = 0, rounds = []) {
  const span = document.createElement('span')
  const style = count > 0 ? (TIER_STYLE[def.tier] || TIER_STYLE.bronze) : 'background:rgba(30,42,58,0.5);border:1px solid #1e2a3a;color:#2e3a4e;'
  const countBadge = count > 1
    ? `<span style="background:rgba(0,0,0,0.3);border-radius:9999px;padding:0 0.35rem;font-size:0.65rem;font-weight:700;">×${count}</span>`
    : ''
  const roundText = count > 0
    ? (count > 1 ? `Earned ${count}× — last Rd ${rounds[rounds.length - 1]}` : `Earned Rd ${rounds[0]}`)
    : 'Not yet earned'
  span.style.cssText = `display:inline-flex;align-items:center;gap:0.35rem;padding:0.3rem 0.6rem;border-radius:9999px;font-size:0.75rem;font-weight:600;cursor:default;position:relative;${style}`
  span.title = `${def.description} — ${roundText}`
  span.innerHTML = `${count > 0 ? def.emoji : '🔒'}<span>${def.name}</span>${countBadge}`
  return span
}

// ── Toast notifications ───────────────────────────────────────────────────────

function ensureToastContainer() {
  let el = document.getElementById('ach-toast-container')
  if (!el) {
    el = document.createElement('div')
    el.id = 'ach-toast-container'
    el.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;display:flex;flex-direction:column-reverse;gap:0.5rem;pointer-events:none;'
    document.body.appendChild(el)
  }
  return el
}

function showToast(def, count = 1, roundNum = null) {
  const container = ensureToastContainer()
  const toast = document.createElement('div')
  const style  = TIER_STYLE[def.tier] || TIER_STYLE.bronze
  toast.style.cssText = `
    pointer-events:auto;
    padding:0.75rem 1rem;
    border-radius:12px;
    ${style}
    box-shadow:0 8px 24px rgba(0,0,0,0.5);
    max-width:280px;
    display:flex;
    align-items:flex-start;
    gap:0.625rem;
    animation:ach-slide-in 0.25s ease;
    font-family:system-ui,sans-serif;
  `
  toast.innerHTML = `
    <div style="font-size:1.5rem;line-height:1;flex-shrink:0;margin-top:1px;">${def.emoji}</div>
    <div>
      <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;opacity:0.7;margin-bottom:0.125rem;">Badge Earned!</div>
      <div style="font-size:0.875rem;font-weight:700;">${def.name}${count > 1 ? ` ×${count}` : ''}</div>
      <div style="font-size:0.7rem;opacity:0.75;margin-top:0.2rem;">${def.description}</div>
      ${roundNum ? `<div style="font-size:0.65rem;opacity:0.5;margin-top:0.2rem;">Round ${roundNum}</div>` : ''}
    </div>
  `

  // Ensure animation keyframes are injected once
  if (!document.getElementById('ach-keyframes')) {
    const s = document.createElement('style')
    s.id = 'ach-keyframes'
    s.textContent = '@keyframes ach-slide-in{from{opacity:0;transform:translateX(1rem)}to{opacity:1;transform:none}}'
    document.head.appendChild(s)
  }

  container.appendChild(toast)
  setTimeout(() => {
    toast.style.transition = 'opacity 0.4s, transform 0.4s'
    toast.style.opacity = '0'
    toast.style.transform = 'translateX(1rem)'
    setTimeout(() => toast.remove(), 420)
  }, 4500)
}

// ── Main init (call once per page after session resolves) ────────────────────

/**
 * Check for newly earned badges and show toast notifications.
 * Compares against a localStorage timestamp so toasts only fire once per earn.
 */
export async function initAchievementToasts(userId) {
  if (!userId) return
  try {
    const lastCheck = Number(localStorage.getItem(LS_KEY) || 0)
    const now = Date.now()

    // Always update the check timestamp before fetching to avoid race conditions
    localStorage.setItem(LS_KEY, String(now))

    const [defs, earned] = await Promise.all([
      fetchBadgeDefs(),
      fetchUserAchievements(userId),
    ])
    if (!defs.length || !earned.length) return

    const defMap = {}
    for (const d of defs) defMap[d.id] = d

    // Parse ISO timestamps; show toast for badges earned after last check
    const newBadges = earned.filter(e => {
      if (!e.last_earned_at) return false
      const ts = new Date(e.last_earned_at).getTime()
      return ts > lastCheck
    })

    // Show one toast per badge type (could be earned multiple times)
    for (const e of newBadges) {
      const def = defMap[e.badge_id]
      if (!def) continue
      const latestRound = e.rounds ? e.rounds[e.rounds.length - 1] : null
      showToast(def, e.count, latestRound)
    }
  } catch (err) {
    // Non-critical — silently ignore
  }
}
