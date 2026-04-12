// supabase-client.js — shared Supabase client for all tipping pages
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const SUPABASE_URL     = 'https://xjqpyyhqzatzlmlojcxv.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_5HgdhAE4ePEAF103sINpqQ_qL3a2E9W'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

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

  // Check profile exists (Google OAuth users may have skipped onboarding)
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', session.user.id)
    .maybeSingle()

  if (!profile) {
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

// Populates the #auth-nav element in the header with sign-in or user info
export async function updateAuthNav() {
  const navEl = await waitForAuthNav()
  if (!navEl) return

  const session = await getSession()

  if (session) {
    const profile = await getProfile(session.user.id)
    const username = profile?.username || session.user.email?.split('@')[0] || 'User'
    navEl.innerHTML = `
      <div class="flex items-center gap-2">
        <a href="/pages/tipping.html"
           class="site-nav-link hidden md:inline-block">My Tips</a>
        <a href="/pages/profile.html"
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
    navEl.querySelector('#sign-out-btn').addEventListener('click', async () => {
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
