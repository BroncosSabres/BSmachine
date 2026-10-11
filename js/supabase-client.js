// supabase-client.js — shared Supabase client for all tipping pages
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm'
import { initAchievementToasts } from './achievements.js'
import { BACKEND } from './api-config.js'

const SUPABASE_URL     = 'https://xjqpyyhqzatzlmlojcxv.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_5HgdhAE4ePEAF103sINpqQ_qL3a2E9W'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:   true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  }
})

// Returns the current session or null
export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

// Returns profile row for a user id
export async function getProfile(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  return data
}

// Redirects to login if not authenticated, or onboarding if no profile exists.
// Preserves the return URL in both cases.
export async function requireAuth() {
  const session = await getSession()
  if (!session) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search)
    window.location.href = `/pages/login.html?next=${returnTo}`
    return null
  }

  // Check profile exists and onboarding is complete
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, onboarding_complete')
    .eq('id', session.user.id)
    .maybeSingle()

  if (!profile || !profile.onboarding_complete) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search)
    window.location.href = `/pages/onboarding.html?next=${returnTo}`
    return null
  }

  return session
}

// Waits for #auth-nav to appear in the DOM (header may load after this is called)
function waitForAuthNav() {
  return new Promise(resolve => {
    const el = document.getElementById('auth-nav')
    if (el) return resolve(el)
    const observer = new MutationObserver(() => {
      const found = document.getElementById('auth-nav')
      if (found) { observer.disconnect(); resolve(found) }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => { observer.disconnect(); resolve(null) }, 3000)
  })
}

// Best Bets is restricted to accounts that have been granted access, and its
// link only shows for those. Asked once per browser session (the page itself
// is enforced by the backend, so this only decides whether to show the link).
const bestBetsKey = userId => `bsm_best_bets_${userId}`

export async function hasBestBetsAccess(session) {
  const key = bestBetsKey(session.user.id)
  try {
    const cached = sessionStorage.getItem(key)
    if (cached !== null) return cached === '1'
  } catch { /* storage unavailable */ }
  try {
    const res = await fetch(`${BACKEND}/best_bets/access`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (!res.ok) return false
    const access = (await res.json()).access === true
    try { sessionStorage.setItem(key, access ? '1' : '0') } catch { /* storage unavailable */ }
    return access
  } catch {
    return false
  }
}

async function addBestBetsLink(navEl, session) {
  if (!await hasBestBetsAccess(session)) return
  const href = '/pages/best_bets.html'
  const active = window.location.pathname === href ? ' is-active' : ''
  // Wide screens: a link with the others. Phones: a pill beside Sign Out, on
  // show without opening the menu (css/style.css .best-bets-pill).
  if (!navEl.querySelector('#best-bets-link')) {
    navEl.firstElementChild?.insertAdjacentHTML('afterbegin',
      `<a id="best-bets-link" href="${href}" class="site-nav-link hidden md:inline-block${active}">Best Bets</a>`
      + `<a id="best-bets-pill" href="${href}" class="best-bets-pill md:hidden${active}">Best Bets</a>`)
  }
  const mobileBtn = document.getElementById('mobile-my-teams-btn')
  if (mobileBtn && !document.getElementById('mobile-best-bets-link')) {
    mobileBtn.insertAdjacentHTML('afterend',
      `<a id="mobile-best-bets-link" href="${href}" class="mobile-nav-link${active}">Best Bets</a>`)
  }
}

// Populates the #auth-nav element in the header with sign-in or user info
export async function updateAuthNav() {
  const navEl = await waitForAuthNav()
  if (!navEl) return

  const session = await getSession()

  if (session) {
    const profile = await getProfile(session.user.id)
    const username = String(profile?.username || session.user.email?.split('@')[0] || 'User')
      .replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
    navEl.innerHTML = `
      <div class="flex items-center gap-2">
        <a href="/nrl/pages/tipping.html"
           class="site-nav-link hidden md:inline-block">My Tips</a>
        <button id="my-stats-btn"
                class="site-nav-link hidden md:inline-block"
                style="background:none;border:none;cursor:pointer;">My Stats</button>
        <a href="/nrl/pages/profile.html"
           class="text-xs hidden md:block"
           style="color:#8892a4; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-decoration:none;"
           title="${username}">
          ${username}
        </a>
        <button id="sign-out-btn"
                class="text-xs px-2.5 py-1 rounded-md border transition-colors font-medium"
                style="border-color:#2e3a4e; color:#8892a4;">
          Sign Out
        </button>
      </div>
    `
    navEl.querySelector('#my-stats-btn').addEventListener('click', () => {
      window.openMyStats?.()
    })

    // Fire achievement toasts for newly earned badges (non-blocking)
    initAchievementToasts(session.user.id)
    addBestBetsLink(navEl, session)   // non-blocking
    navEl.querySelector('#sign-out-btn').addEventListener('click', async () => {
      try { sessionStorage.removeItem(bestBetsKey(session.user.id)) } catch { /* storage unavailable */ }
      await supabase.auth.signOut()
      window.location.href = '/index.html'
    })

    const btn = navEl.querySelector('#sign-out-btn')
    btn.addEventListener('mouseover', () => {
      btn.style.borderColor = '#f59e0b'
      btn.style.color = '#fbbf24'
    })
    btn.addEventListener('mouseout', () => {
      btn.style.borderColor = '#2e3a4e'
      btn.style.color = '#8892a4'
    })
  } else {
    navEl.innerHTML = `
      <a href="/pages/login.html"
         class="text-xs px-2.5 py-1 rounded-md font-semibold transition-colors"
         style="background:rgba(245,158,11,0.12); color:#fbbf24; border:1px solid rgba(245,158,11,0.3);">
        Sign In
      </a>
    `
  }
}
