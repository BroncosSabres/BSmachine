// my-stats.js — "My Stats" modal overlay
// Registers window.openMyStats(). Load this module on any page to enable the modal.

import { supabase, getSession } from './supabase-client.js'

const BACKEND = 'https://bsmachine-backend.onrender.com/api'

// ── Utilities ─────────────────────────────────────────────────────────────────

function bell(err) { return 5.0 * Math.exp(-(err * err) / 72.0) }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function slug(name) {
  const n = (name || '').toLowerCase()
  if (n.includes('broncos'))                         return 'broncos'
  if (n.includes('bulldogs'))                        return 'bulldogs'
  if (n.includes('cowboys'))                         return 'cowboys'
  if (n.includes('dolphins'))                        return 'dolphins'
  if (n.includes('dragons'))                         return 'dragons'
  if (n.includes('eels'))                            return 'eels'
  if (n.includes('knights'))                         return 'knights'
  if (n.includes('sea eagles') || n.includes('manly')) return 'manly'
  if (n.includes('panthers'))                        return 'panthers'
  if (n.includes('rabbitohs'))                       return 'rabbitohs'
  if (n.includes('raiders'))                         return 'raiders'
  if (n.includes('roosters'))                        return 'roosters'
  if (n.includes('sharks'))                          return 'sharks'
  if (n.includes('storm'))                           return 'storm'
  if (n.includes('tigers'))                          return 'tigers'
  if (n.includes('titans'))                          return 'titans'
  if (n.includes('warriors'))                        return 'warriors'
  return (name || '').toLowerCase().replace(/\s+/g, '_')
}

function fmt(n, dp = 2) { return Number(n).toFixed(dp) }

// Higher = better (wins, avg scores)
function betterClr(a, b) { return a > b ? '#4ade80' : a < b ? '#f87171' : '#94a3b8' }
// Lower = better (losses)
function fewerClr(a, b)  { return a < b ? '#4ade80' : a > b ? '#f87171' : '#94a3b8' }

// ── Modal DOM ─────────────────────────────────────────────────────────────────

function ensureModal() {
  if (document.getElementById('my-stats-modal')) return
  const div = document.createElement('div')
  div.id = 'my-stats-modal'
  div.setAttribute('role', 'dialog')
  div.setAttribute('aria-modal', 'true')
  div.style.cssText = 'display:none;position:fixed;inset:0;z-index:1100;align-items:center;justify-content:center;padding:1rem;background:rgba(0,0,0,0.78);backdrop-filter:blur(4px);'
  div.innerHTML = `
    <div style="background:#161b24;border:1px solid #2e3a4e;border-radius:16px;width:100%;max-width:560px;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 28px 56px rgba(0,0,0,0.65);">
      <div style="padding:1rem 1.25rem;border-bottom:1px solid #1e2a3a;display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:0.625rem;">
          <img src="/assets/BS_Logo.png" style="width:1.75rem;height:1.75rem;object-fit:contain;border-radius:4px;opacity:0.9;" alt="">
          <div>
            <div style="font-family:'Barlow Condensed',system-ui,sans-serif;font-size:1.125rem;font-weight:700;color:#e2e8f0;letter-spacing:0.02em;">My Stats</div>
            <div id="msc-sub" style="font-size:0.65rem;color:#4a5568;margin-top:1px;line-height:1.3;">Loading…</div>
          </div>
        </div>
        <button id="msc-close" aria-label="Close"
          style="background:none;border:1px solid #2e3a4e;border-radius:6px;color:#4a5568;font-size:0.875rem;width:2rem;height:2rem;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:all 0.12s;"
          onmouseover="this.style.borderColor='#4a5568';this.style.color='#e2e8f0';"
          onmouseout="this.style.borderColor='#2e3a4e';this.style.color='#4a5568';">✕</button>
      </div>
      <div id="msc-body" style="overflow-y:auto;flex:1;min-height:0;padding-bottom:0.5rem;">
        <div style="padding:3rem;text-align:center;color:#4a5568;" class="animate-pulse">Loading stats…</div>
      </div>
    </div>`
  document.body.appendChild(div)
  div.addEventListener('click', e => { if (e.target === div) closeMyStats() })
  document.getElementById('msc-close').addEventListener('click', closeMyStats)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('my-stats-modal')?.style.display !== 'none')
      closeMyStats()
  })
}

function closeMyStats() {
  const el = document.getElementById('my-stats-modal')
  if (el) el.style.display = 'none'
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchMachinePreds(roundNums) {
  const map = {}
  const resps = await Promise.all(
    [...new Set(roundNums)].map(rn =>
      fetch(`${BACKEND}/round_predictions/${rn}`).then(r => r.ok ? r.json() : null).catch(() => null)
    )
  )
  resps.forEach(data => {
    ;(data?.predictions || []).forEach(p => {
      if (p.exp_home_score != null && p.exp_away_score != null)
        map[p.match_id] = { home: p.exp_home_score, away: p.exp_away_score, homePerc: p.home_perc, awayPerc: p.away_perc }
    })
  })
  return map
}

async function fetchAllData(userId) {
  const [
    { data: scores },
    { data: picks },
    { data: games },
    { data: profile },
  ] = await Promise.all([
    supabase.from('scores')
      .select('game_id, points, margin_score, total_score, round_number')
      .eq('user_id', userId),
    supabase.from('picks')
      .select('game_id, home_score_pick, away_score_pick')
      .eq('user_id', userId),
    supabase.from('games')
      .select('game_id, home_team, away_team, home_score, away_score, round_number, kickoff_time')
      .eq('is_complete', true)
      .not('home_score', 'is', null),
    supabase.from('profiles')
      .select('username, favourite_team')
      .eq('id', userId)
      .single(),
  ])

  const roundNums = [...new Set((games || []).map(g => g.round_number))]
  const machinePreds = await fetchMachinePreds(roundNums)
  return compute(scores || [], picks || [], games || [], machinePreds, profile)
}

// ── Computation ───────────────────────────────────────────────────────────────

function compute(scores, picks, games, machinePreds, profile) {
  const gameMap = {}; games.forEach(g => { gameMap[g.game_id] = g })
  const pickMap = {}; picks.forEach(p => { pickMap[p.game_id] = p })
  const scoredIds = new Set(scores.map(s => s.game_id))

  // ---- H2H: games where user has a bell score AND machine has a prediction ----
  const h2hList = scores
    .map(s => ({ s, g: gameMap[s.game_id], mp: machinePreds[s.game_id] }))
    .filter(x => x.g && x.mp)

  let uWins = 0, draws = 0, uLosses = 0
  let uMarginSum = 0, uTotalSum = 0, mMarginSum = 0, mTotalSum = 0
  let uMarginErrSum = 0, uTotalErrSum = 0, mMarginErrSum = 0, mTotalErrSum = 0

  h2hList.forEach(({ s, g, mp }) => {
    const am = g.home_score - g.away_score
    const at = g.home_score + g.away_score
    const mMargin = bell(am - (mp.home - mp.away))
    const mTotal  = bell(at - (mp.home + mp.away))
    const mPts    = mMargin + mTotal
    if      (s.points > mPts + 1e-4) uWins++
    else if (s.points < mPts - 1e-4) uLosses++
    else                              draws++
    uMarginSum += s.margin_score ?? 0
    uTotalSum  += s.total_score  ?? 0
    mMarginSum += mMargin
    mTotalSum  += mTotal
    // Absolute errors (pts)
    const up = pickMap[s.game_id]
    if (up) {
      uMarginErrSum += Math.abs(am - (up.home_score_pick - up.away_score_pick))
      uTotalErrSum  += Math.abs(at - (up.home_score_pick + up.away_score_pick))
    }
    mMarginErrSum += Math.abs(am - (mp.home - mp.away))
    mTotalErrSum  += Math.abs(at - (mp.home + mp.away))
  })
  const h2hN = h2hList.length || 1

  // ---- Exact scores picked ------------------------------------------------
  const exactPicks = picks.filter(p => {
    const g = gameMap[p.game_id]
    return g && p.home_score_pick === g.home_score && p.away_score_pick === g.away_score
  })

  // ---- Correct winner tips (for scored games only) ------------------------
  const scoredPicks = picks.filter(p => scoredIds.has(p.game_id))
  const correctWins = scoredPicks.filter(p => {
    const g = gameMap[p.game_id]; if (!g) return false
    const am = g.home_score - g.away_score
    if (am === 0) return p.home_score_pick === p.away_score_pick
    return am > 0 ? p.home_score_pick > p.away_score_pick : p.home_score_pick < p.away_score_pick
  })

  // ---- Best round (by total points) ---------------------------------------
  const roundTotals = {}
  scores.forEach(s => { roundTotals[s.round_number] = (roundTotals[s.round_number] || 0) + s.points })
  const bestRoundEntry = Object.entries(roundTotals).sort((a, b) => b[1] - a[1])[0]

  // ---- Best single game ---------------------------------------------------
  const sortedScores = scores.slice().sort((a, b) => b.points - a.points)
  const topScore = sortedScores[0] || null

  // ---- Boldest correct upset: user tipped winner machine had < 50% for ----
  const upsets = picks.flatMap(p => {
    const g  = gameMap[p.game_id]
    const mp = machinePreds[p.game_id]
    if (!g || !mp || mp.homePerc == null || !scoredIds.has(p.game_id)) return []
    const am = g.home_score - g.away_score
    if (am === 0) return []
    const userTippedHome = p.home_score_pick > p.away_score_pick
    const actuallyHome   = am > 0
    if (userTippedHome !== actuallyHome) return []          // user got winner wrong
    const winnerProb = actuallyHome ? mp.homePerc : mp.awayPerc
    if (winnerProb >= 0.5) return []                        // not an upset
    return [{ game: g, prob: winnerProb, winner: actuallyHome ? g.home_team : g.away_team }]
  }).sort((a, b) => a.prob - b.prob)

  // ---- Streaks vs machine (chronological order) ---------------------------
  const h2hChron = h2hList.slice().sort((a, b) => {
    const ta = a.g.kickoff_time || '', tb = b.g.kickoff_time || ''
    return ta < tb ? -1 : ta > tb ? 1 : a.g.game_id - b.g.game_id
  })
  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0
  h2hChron.forEach(({ s, g, mp }) => {
    const am = g.home_score - g.away_score, at = g.home_score + g.away_score
    const mPts = bell(am - (mp.home - mp.away)) + bell(at - (mp.home + mp.away))
    if (s.points > mPts + 1e-4) { curWin++;  maxWinStreak  = Math.max(maxWinStreak,  curWin);  curLoss = 0 }
    else                        { curLoss++; maxLossStreak = Math.max(maxLossStreak, curLoss); curWin  = 0 }
  })
  // Derive current streak from whichever counter is still running
  const currentStreakVal  = curWin > 0 ? curWin : curLoss
  const currentStreakType = curWin > 0 ? 'win' : curLoss > 0 ? 'loss' : h2hChron.length ? 'draw' : 'none'

  // ---- Best / worst team to tip (by avg score in games involving that team) -
  const teamScoreMap = {}   // team -> { sum, count }
  scores.forEach(s => {
    const g = gameMap[s.game_id]; if (!g) return
    ;[g.home_team, g.away_team].forEach(team => {
      if (!team) return
      if (!teamScoreMap[team]) teamScoreMap[team] = { sum: 0, count: 0 }
      teamScoreMap[team].sum   += s.points
      teamScoreMap[team].count += 1
    })
  })
  const MIN_GAMES_FOR_TEAM = 1
  const teamAvgs = Object.entries(teamScoreMap)
    .filter(([, v]) => v.count >= MIN_GAMES_FOR_TEAM)
    .map(([team, v]) => ({ team, avg: v.sum / v.count, count: v.count }))
    .sort((a, b) => b.avg - a.avg)
  const bestTeam  = teamAvgs[0]                    || null
  const worstTeam = teamAvgs[teamAvgs.length - 1]  || null

  return {
    profile,
    h2h: {
      n:          h2hList.length,
      uWins, draws, uLosses,
      mWins:      uLosses,
      mLosses:    uWins,
      uAvgMargin:    uMarginSum    / h2hN,
      uAvgTotal:     uTotalSum     / h2hN,
      mAvgMargin:    mMarginSum    / h2hN,
      mAvgTotal:     mTotalSum     / h2hN,
      uAvgMarginErr: uMarginErrSum / h2hN,
      uAvgTotalErr:  uTotalErrSum  / h2hN,
      mAvgMarginErr: mMarginErrSum / h2hN,
      mAvgTotalErr:  mTotalErrSum  / h2hN,
    },
    exact:   { count: exactPicks.length,  pct: picks.length       ? exactPicks.length  / picks.length        * 100 : 0 },
    correct: { count: correctWins.length, total: scoredPicks.length, pct: scoredPicks.length ? correctWins.length / scoredPicks.length * 100 : 0 },
    bestRound:    bestRoundEntry ? { round: Number(bestRoundEntry[0]), pts: bestRoundEntry[1] } : null,
    bestGame:     topScore       ? { ...topScore, game: gameMap[topScore.game_id] } : null,
    boldestUpset: upsets[0]      || null,
    upsetCount:   upsets.length,
    maxWinStreak, maxLossStreak,
    currentStreakVal, currentStreakType,
    bestTeam, worstTeam,
    gamesScored:  scores.length,
    picksSubmitted: picks.length,
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderStats(stats, { bodyEl = null, subEl = null } = {}) {
  bodyEl = bodyEl || document.getElementById('msc-body')
  subEl  = subEl  || document.getElementById('msc-sub')

  const { profile, h2h, exact, correct, bestRound, bestGame, boldestUpset,
          maxWinStreak, maxLossStreak, currentStreakVal, currentStreakType,
          bestTeam, worstTeam, gamesScored, upsetCount } = stats

  const username = esc(profile?.username || 'You')
  const favTeam  = profile?.favourite_team || null

  if (subEl) subEl.textContent =
    `Full Season · ${gamesScored} game${gamesScored !== 1 ? 's' : ''} scored`

  // ---- H2H row template --------------------------------------------------
  // u/m columns each 40% wide, label 20% centred
  const h2hRow = (uVal, label, mVal, uClr, mClr) => `
    <div style="display:grid;grid-template-columns:1fr 8rem 1fr;align-items:center;padding:0.55rem 1.5rem;">
      <div style="text-align:right;font-family:'Barlow Condensed',system-ui,sans-serif;font-size:1.5rem;font-weight:700;color:${uClr};line-height:1;">${uVal}</div>
      <div style="text-align:center;font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#4a5568;">${label}</div>
      <div style="text-align:left;font-family:'Barlow Condensed',system-ui,sans-serif;font-size:1.5rem;font-weight:700;color:${mClr};line-height:1;">${mVal}</div>
    </div>`

  const divider = (thick = false) =>
    `<div style="height:1px;background:${thick ? '#2e3a4e' : '#1e2a3a'};margin:0 1.5rem;"></div>`

  // ---- Stat tile template ------------------------------------------------
  const tile = (label, value, sub = '', valueClr = '#e2e8f0') => `
    <div style="background:#0f1117;border:1px solid #1e2a3a;border-radius:10px;padding:0.875rem 1rem;">
      <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#4a5568;margin-bottom:0.375rem;">${label}</div>
      <div style="font-family:'Barlow Condensed',system-ui,sans-serif;font-size:1.375rem;font-weight:700;color:${valueClr};line-height:1.15;">${value}</div>
      ${sub ? `<div style="font-size:0.7rem;color:#4a5568;margin-top:0.3rem;line-height:1.4;">${sub}</div>` : ''}
    </div>`

  // ---- User logo ----------------------------------------------------------
  const uLogoHtml = favTeam
    ? `<img src="/logos/${slug(favTeam)}.svg" style="width:1.375rem;height:1.375rem;object-fit:contain;opacity:0.75;flex-shrink:0;" onerror="this.style.display='none'">`
    : ''

  // ---- H2H body -----------------------------------------------------------
  const h2hBody = h2h.n === 0
    ? `<div style="padding:1.5rem;text-align:center;font-size:0.8125rem;color:#4a5568;">No scored games yet — check back once some rounds are complete!</div>`
    : `
      ${h2hRow(h2h.uWins,                      'Wins',             h2h.mWins,
               betterClr(h2h.uWins, h2h.mWins), betterClr(h2h.mWins, h2h.uWins))}
      ${divider()}
      ${h2hRow(h2h.draws,   'Draws', h2h.draws, '#94a3b8', '#94a3b8')}
      ${divider()}
      ${h2hRow(h2h.uLosses,                      'Losses',          h2h.mLosses,
               fewerClr(h2h.uLosses, h2h.mLosses), fewerClr(h2h.mLosses, h2h.uLosses))}
      ${divider(true)}
      ${h2hRow(
          `${fmt(h2h.uAvgMargin)} <span style="font-size:0.9rem;opacity:0.55;">(±${fmt(h2h.uAvgMarginErr, 1)})</span>`,
          'Avg Margin Score /game',
          `${fmt(h2h.mAvgMargin)} <span style="font-size:0.9rem;opacity:0.55;">(±${fmt(h2h.mAvgMarginErr, 1)})</span>`,
          betterClr(h2h.uAvgMargin, h2h.mAvgMargin), betterClr(h2h.mAvgMargin, h2h.uAvgMargin))}
      ${divider()}
      ${h2hRow(
          `${fmt(h2h.uAvgTotal)} <span style="font-size:0.9rem;opacity:0.55;">(±${fmt(h2h.uAvgTotalErr, 1)})</span>`,
          'Avg Total Score /game',
          `${fmt(h2h.mAvgTotal)} <span style="font-size:0.9rem;opacity:0.55;">(±${fmt(h2h.mAvgTotalErr, 1)})</span>`,
          betterClr(h2h.uAvgTotal, h2h.mAvgTotal), betterClr(h2h.mAvgTotal, h2h.uAvgTotal))}
      <div style="padding:0.5rem 1.5rem 0.125rem;">
        <div style="font-size:0.65rem;color:#4a5568;text-align:center;">Based on ${h2h.n} scored game${h2h.n !== 1 ? 's' : ''} · scores out of 5 per component (max 10/game)</div>
      </div>`

  // ---- Fun stats tiles ----------------------------------------------------
  const correctPctStr = correct.total > 0 ? `${fmt(correct.pct, 0)}% win rate` : ''
  const bestRoundVal  = bestRound ? `${fmt(bestRound.pts, 1)} pts` : '—'
  const bestRoundSub  = bestRound ? `Round ${bestRound.round}` : ''
  const bestGameVal   = bestGame  ? `${fmt(bestGame.points, 1)} pts` : '—'
  const bestGameSub   = bestGame?.game
    ? `${esc(bestGame.game.home_team)} v ${esc(bestGame.game.away_team)}, Rd ${bestGame.round_number}`
    : ''

  let upsetVal = '—', upsetSub = 'None yet'
  if (boldestUpset) {
    upsetVal = esc(boldestUpset.winner)
    upsetSub = `Machine gave ${Math.round(boldestUpset.prob * 100)}% — Rd ${boldestUpset.game.round_number}`
  }

  // Streaks
  const gStr = n => `game${n !== 1 ? 's' : ''}`
  const winStreakSub  = maxWinStreak  >= 5 ? 'impressive run!' : maxWinStreak  >= 3 ? 'solid run' : ''
  const lossStreakSub = maxLossStreak >= 5 ? 'rough patch'     : maxLossStreak >= 3 ? 'tough run'  : ''
  let curStreakVal = '—', curStreakSub = '', curStreakClr = '#4a5568'
  if (currentStreakType === 'win') {
    curStreakVal = `${currentStreakVal}W`
    curStreakSub = `${currentStreakVal} win${currentStreakVal !== 1 ? 's' : ''} in a row`
    curStreakClr = currentStreakVal >= 3 ? '#4ade80' : '#e2e8f0'
  } else if (currentStreakType === 'loss') {
    curStreakVal = `${currentStreakVal}L`
    curStreakSub = `${currentStreakVal} loss${currentStreakVal !== 1 ? 'es' : ''} in a row`
    curStreakClr = currentStreakVal >= 3 ? '#f87171' : '#e2e8f0'
  } else if (currentStreakType === 'draw') {
    curStreakVal = 'D'; curStreakSub = 'last game was a draw'; curStreakClr = '#94a3b8'
  }

  // Best / worst team
  const bestTeamLogoHtml = bestTeam
    ? `<img src="/logos/${slug(bestTeam.team)}.svg" style="width:1rem;height:1rem;object-fit:contain;vertical-align:middle;margin-right:3px;opacity:0.8;" onerror="this.style.display='none'"> `
    : ''
  const worstTeamLogoHtml = worstTeam
    ? `<img src="/logos/${slug(worstTeam.team)}.svg" style="width:1rem;height:1rem;object-fit:contain;vertical-align:middle;margin-right:3px;opacity:0.8;" onerror="this.style.display='none'"> `
    : ''

  bodyEl.innerHTML = `

    <!-- H2H section -->
    <div style="padding:1.125rem 1.5rem 0.75rem;">
      <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#4a5568;margin-bottom:0.75rem;">Head to Head vs BS Machine</div>
      <!-- Name row -->
      <div style="display:grid;grid-template-columns:1fr 8rem 1fr;align-items:center;gap:0.25rem;margin-bottom:0.375rem;">
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:0.375rem;min-width:0;overflow:hidden;">
          ${uLogoHtml}
          <span style="font-size:0.875rem;font-weight:700;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${username}</span>
        </div>
        <div style="text-align:center;font-size:0.65rem;font-weight:700;color:#2e3a4e;text-transform:uppercase;letter-spacing:0.05em;">vs</div>
        <div style="display:flex;align-items:center;gap:0.375rem;min-width:0;">
          <img src="/assets/BS_Logo.png" style="width:1.25rem;height:1.25rem;object-fit:contain;border-radius:3px;opacity:0.85;flex-shrink:0;" alt="">
          <span style="font-size:0.875rem;font-weight:700;color:#f59e0b;white-space:nowrap;">BS Machine</span>
        </div>
      </div>
    </div>

    <div style="border-top:1px solid #1e2a3a;border-bottom:1px solid #1e2a3a;">
      ${h2hBody}
    </div>

    <!-- Fun stats section -->
    <div style="padding:1.125rem 1.5rem 1rem;">
      <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#4a5568;margin-bottom:0.75rem;">Your Season</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.625rem;">
        ${tile('Exact Scores',
          exact.count > 0 ? String(exact.count) : '0',
          exact.count > 0 ? `${fmt(exact.pct, 1)}% of scored picks` : 'none yet — keep going!',
          exact.count > 0 ? '#fbbf24' : '#4a5568'
        )}
        ${tile('Correct Winning Team',
          correct.total > 0 ? `${correct.count}/${correct.total}` : '—',
          correctPctStr,
          correct.pct >= 60 ? '#4ade80' : correct.pct >= 50 ? '#e2e8f0' : correct.total > 0 ? '#f87171' : '#4a5568'
        )}
        ${tile('Best Round', bestRoundVal, bestRoundSub)}
        ${tile('Best Game', bestGameVal, bestGameSub)}
        ${tile('Boldest Correct Upset',
          upsetVal,
          upsetSub,
          boldestUpset ? '#f59e0b' : '#4a5568'
        )}
        ${tile('Current Streak vs Machine',
          curStreakVal,
          curStreakSub,
          curStreakClr
        )}
        ${tile('Best Win Streak vs Machine',
          maxWinStreak > 0 ? `${maxWinStreak} ${gStr(maxWinStreak)}` : '0',
          winStreakSub,
          maxWinStreak >= 3 ? '#4ade80' : maxWinStreak > 0 ? '#e2e8f0' : '#4a5568'
        )}
        ${tile('Worst Loss Streak vs Machine',
          maxLossStreak > 0 ? `${maxLossStreak} ${gStr(maxLossStreak)}` : '0',
          lossStreakSub,
          maxLossStreak >= 5 ? '#f87171' : maxLossStreak >= 3 ? '#fb923c' : '#e2e8f0'
        )}
        ${bestTeam
          ? tile('Best Team to Tip',
              `${bestTeamLogoHtml}${esc(bestTeam.team)}`,
              `avg ${fmt(bestTeam.avg, 2)} pts · ${bestTeam.count} ${gStr(bestTeam.count)}`,
              '#4ade80'
            )
          : tile('Best Team to Tip', '—', 'not enough data yet', '#4a5568')
        }
        ${worstTeam && worstTeam.team !== bestTeam?.team
          ? tile('Worst Team to Tip',
              `${worstTeamLogoHtml}${esc(worstTeam.team)}`,
              `avg ${fmt(worstTeam.avg, 2)} pts · ${worstTeam.count} ${gStr(worstTeam.count)}`,
              '#f87171'
            )
          : tile('Worst Team to Tip', '—', 'not enough data yet', '#4a5568')
        }
      </div>
    </div>

    <!-- Achievements section (populated async) -->
    <div id="msc-achievements" style="padding:0 1.5rem 1.25rem;">
      <div style="height:1px;background:#1e2a3a;margin-bottom:1.125rem;"></div>
      <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#4a5568;margin-bottom:0.625rem;">Achievements</div>
      <div id="msc-badge-list" style="display:flex;flex-wrap:wrap;gap:0.4rem;min-height:1.75rem;">
        <div style="font-size:0.75rem;color:#2e3a4e;">Loading…</div>
      </div>
    </div>

    <!-- Full stats link -->
    <div style="padding:0 1.5rem 1.25rem;">
      <a href="/pages/my-stats.html" style="display:flex;align-items:center;justify-content:center;gap:0.375rem;padding:0.625rem;border:1px solid #2e3a4e;border-radius:8px;font-size:0.8125rem;font-weight:600;color:#94a3b8;text-decoration:none;transition:all 0.12s;"
         onmouseover="this.style.borderColor='#4a5568';this.style.color='#e2e8f0';"
         onmouseout="this.style.borderColor='#2e3a4e';this.style.color='#94a3b8';">
        View full stats →
      </a>
    </div>`
}

// ── Public entry point ────────────────────────────────────────────────────────

async function openMyStats() {
  ensureModal()
  const modal = document.getElementById('my-stats-modal')
  modal.style.display = 'flex'

  // Reset to loading state
  const subEl  = document.getElementById('msc-sub')
  const bodyEl = document.getElementById('msc-body')
  if (subEl)  subEl.textContent = 'Loading…'
  if (bodyEl) bodyEl.innerHTML  = `<div style="padding:3rem;text-align:center;color:#4a5568;" class="animate-pulse">Loading stats…</div>`

  const session = await getSession()
  if (!session) {
    if (bodyEl) bodyEl.innerHTML = `<div style="padding:2rem;text-align:center;font-size:0.875rem;color:#4a5568;">Sign in to view your stats.</div>`
    return
  }

  try {
    const [stats] = await Promise.all([
      fetchAllData(session.user.id),
    ])
    renderStats(stats)
    // Load badges async after main stats render
    loadModalBadges(session.user.id)
  } catch (err) {
    console.error('[my-stats] failed to load stats:', err)
    if (bodyEl) bodyEl.innerHTML = `<div style="padding:2rem;text-align:center;font-size:0.875rem;color:#f87171;">Failed to load stats. Please try again.</div>`
  }
}

async function loadModalBadges(userId) {
  const listEl = document.getElementById('msc-badge-list')
  if (!listEl) return
  try {
    const [defs, earned] = await Promise.all([
      fetch(`${BACKEND}/achievements`).then(r => r.ok ? r.json() : []),
      fetch(`${BACKEND}/user_achievements/${userId}`).then(r => r.ok ? r.json() : []),
    ])
    const earnedMap = {}
    for (const e of earned) earnedMap[e.badge_id] = e
    const earnedDefs = defs.filter(d => earnedMap[d.id])

    if (!earnedDefs.length) {
      listEl.innerHTML = `<div style="font-size:0.75rem;color:#2e3a4e;">No badges yet — keep tipping!</div>`
      return
    }
    const tierClass = { gold: 'gold', silver: 'silver', bronze: 'bronze' }
    const tierStyle = {
      gold:   'background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.35);color:#fbbf24;',
      silver: 'background:rgba(148,163,184,0.12);border:1px solid rgba(148,163,184,0.3);color:#cbd5e1;',
      bronze: 'background:rgba(180,83,9,0.15);border:1px solid rgba(180,83,9,0.35);color:#fb923c;',
    }
    listEl.innerHTML = earnedDefs.map(d => {
      const e = earnedMap[d.id]
      const style = tierStyle[d.tier] || tierStyle.bronze
      const countBadge = e.count > 1
        ? `<span style="background:rgba(0,0,0,0.3);border-radius:9999px;padding:0 0.3rem;font-size:0.65rem;font-weight:700;">×${e.count}</span>`
        : ''
      return `<span title="${d.description}" style="display:inline-flex;align-items:center;gap:0.3rem;padding:0.25rem 0.55rem;border-radius:9999px;font-size:0.7rem;font-weight:600;cursor:default;${style}">
        ${d.emoji} ${d.name}${countBadge}
      </span>`
    }).join('')
  } catch (e) {
    if (listEl) listEl.innerHTML = ''
  }
}

window.openMyStats  = openMyStats
window.closeMyStats = closeMyStats

export { fetchAllData, renderStats }
