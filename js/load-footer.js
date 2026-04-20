// Shared component loader — footer injection & prize banner logic

// ---- Backend keep-warm ping ----
// Fire-and-forget: wakes the Render backend early so it's ready by the time
// the page's real API calls land. Runs at most once per 10-minute window
// (sessionStorage guards against hammering on rapid navigations).
(function () {
  var PING_KEY = 'bsm_backend_pinged';
  var PING_TTL = 10 * 60 * 1000; // 10 minutes in ms
  var last = Number(sessionStorage.getItem(PING_KEY) || 0);
  if (Date.now() - last < PING_TTL) return;
  sessionStorage.setItem(PING_KEY, String(Date.now()));
  fetch('https://bsmachine-backend.onrender.com/health', { method: 'GET', cache: 'no-store' })
    .catch(function () { /* silent — backend may be cold but will wake */ });
})();

// ---- Footer ----
(function () {
  var el = document.getElementById('site-footer');
  if (!el) return;
  fetch('/components/footer.html')
    .then(function (r) { return r.text(); })
    .then(function (html) { el.innerHTML = html; });
})();

// ---- Prize Banner ----

// Set to the active prize round number to show the banner, or null to hide it entirely.
// Changing this number also resets the dismiss state for all users (round-specific key).
var PRIZE_ROUND = 8;

// Global dismiss function — called from onclick in the injected header HTML
function dismissPrizeBanner() {
  var banner = document.getElementById('prize-banner');
  if (banner) {
    banner.style.transition = 'opacity 0.25s ease, max-height 0.3s ease';
    banner.style.opacity = '0';
    banner.style.maxHeight = '0';
    banner.style.overflow = 'hidden';
    setTimeout(function () { banner.style.display = 'none'; }, 320);
  }
  if (PRIZE_ROUND) localStorage.setItem('bsm_prize_banner_dismissed_r' + PRIZE_ROUND, '1');
}

// Show banner only if PRIZE_ROUND matches the actual upcoming round from the API.
// Result is cached in sessionStorage so we only fetch once per browser session.
(function () {
  if (!PRIZE_ROUND) return;
  if (localStorage.getItem('bsm_prize_banner_dismissed_r' + PRIZE_ROUND)) return;

  function tryShow() {
    var banner = document.getElementById('prize-banner');
    if (banner) {
      var roundSpan = document.getElementById('prize-banner-round');
      if (roundSpan) roundSpan.textContent = PRIZE_ROUND;
      banner.style.display = '';
      return true;
    }
    return false;
  }

  function showWhenReady() {
    if (!tryShow()) {
      var headerEl = document.getElementById('site-header');
      if (!headerEl) return;
      var obs = new MutationObserver(function () {
        if (tryShow()) obs.disconnect();
      });
      obs.observe(headerEl, { childList: true, subtree: true });
    }
  }

  // Check upcoming round — use sessionStorage cache to avoid an API call on every page
  var CACHE_KEY = 'bsm_upcoming_round';
  var cached = sessionStorage.getItem(CACHE_KEY);
  if (cached !== null) {
    if (Number(cached) === PRIZE_ROUND) showWhenReady();
    return;
  }

  fetch('https://bsmachine-backend.onrender.com/api/upcoming_matches/nrl')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var upcomingRound = (data && data.length > 0) ? data[0].round_number : null;
      if (upcomingRound !== null) sessionStorage.setItem(CACHE_KEY, String(upcomingRound));
      if (upcomingRound === PRIZE_ROUND) showWhenReady();
    })
    .catch(function () {
      // If the API is unreachable, fail silently — banner stays hidden
    });
})();
