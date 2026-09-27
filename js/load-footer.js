// Shared component loader — footer injection, prize banner, My Stats modal
// Eagerly load the My Stats modal so the header button works on every page.
import('/js/my-stats.js').catch(function () {});

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

// ---- Header ----
// Every page just needs <div id="site-header"></div> + this script. The header
// markup is fetched here, then its empty containers (competition tabs, section
// nav, match ticker) are filled from js/sport-config.js. Scripts injected via
// innerHTML don't execute, so none of this can live inside header.html.
// Add data-no-bmc to #site-header to leave out the Buy Me a Coffee button.
var BMC_HTML =
  '<a href="https://www.buymeacoffee.com/BroncosSabres" target="_blank" rel="noopener">' +
    '<img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" style="height:40px; width:145px;">' +
  '</a>';

(function () {
  var headerEl = document.getElementById('site-header');
  if (!headerEl) return;

  function populate(mod) {
    var sport = mod.getCurrentSport();

    document.getElementById('comp-tabs').innerHTML = mod.renderCompTabs(sport);

    if (sport) {
      var cfg = mod.SPORTS[sport];
      // NRL/NRLW share pages - label which one this is, since the URL decides.
      document.querySelectorAll('[data-comp-label]').forEach(function (el) {
        el.innerHTML = '<img src="' + cfg.logo + '" alt="" class="comp-logo">' + cfg.label;
        el.style.setProperty('--comp-color', cfg.color);
      });
      if (sport === 'nrlw') {
        document.title = /\bNRL\b/.test(document.title)
          ? document.title.replace(/\bNRL\b/, 'NRLW')
          : 'NRLW ' + document.title;
      }

      document.getElementById('section-nav-bar').classList.remove('hidden');
      document.getElementById('desktop-nav').innerHTML = mod.renderNav(sport, 'site-nav-link');
      document.getElementById('mobile-nav-links').innerHTML =
        '<div class="mobile-nav-heading">' + cfg.label + '</div>' +
        mod.renderNav(sport, 'mobile-nav-link');
    } else {
      // No section nav on general pages, so the hamburger has nothing extra to show.
      document.getElementById('menu-toggle').classList.add('sm:hidden');
    }

    // Keep the active tab in view when the tab row scrolls on small screens
    // (set scrollLeft directly - scrollIntoView could also scroll the page).
    var tabs = document.getElementById('comp-tabs');
    var activeTab = tabs.querySelector('.is-active');
    if (activeTab && activeTab.offsetLeft + activeTab.offsetWidth > tabs.clientWidth) {
      tabs.scrollLeft = activeTab.offsetLeft - tabs.offsetLeft;
    }
  }

  function wire() {
    if (!headerEl.hasAttribute('data-no-bmc')) {
      document.getElementById('bmc-button').innerHTML = BMC_HTML;
      document.getElementById('mobile-bmc').innerHTML = BMC_HTML;
    }

    var menuToggle = document.getElementById('menu-toggle');
    var mobileMenu = document.getElementById('mobile-menu');
    menuToggle.addEventListener('click', function () {
      var open = mobileMenu.classList.toggle('hidden') === false;
      menuToggle.setAttribute('aria-expanded', String(open));
    });

    import('/js/sport-config.js').then(populate);
    import('/js/match-ticker.js').then(function (mod) {
      mod.initMatchTicker(document.getElementById('match-ticker'));
    });
  }

  fetch('/components/header.html')
    .then(function (r) { return r.text(); })
    .then(function (html) {
      headerEl.innerHTML = html;
      wire();
    });
})();

// ---- Prize Banner ----

var BACKEND_ROOT = 'https://bsmachine-backend.onrender.com';

// Returns the display label for a given cup round number within a bracket.
function _cupRoundLabel(currentRound, bracketSize) {
  var totalRounds = Math.log2(bracketSize);
  var fromEnd = totalRounds - currentRound;
  if (fromEnd === 0) return 'Grand Final';
  if (fromEnd === 1) return 'Semi Finals';
  if (fromEnd === 2) return 'Quarter Finals';
  return 'Round ' + currentRound;
}

// Global dismiss function — called from onclick in the injected header HTML.
// The dismiss key is stored on the banner element so it survives without a global var.
function dismissPrizeBanner() {
  var banner = document.getElementById('prize-banner');
  if (banner) {
    banner.style.transition = 'opacity 0.25s ease, max-height 0.3s ease';
    banner.style.opacity = '0';
    banner.style.maxHeight = '0';
    banner.style.overflow = 'hidden';
    setTimeout(function () { banner.style.display = 'none'; }, 320);
    var key = banner.dataset.dismissKey;
    if (key) localStorage.setItem(key, '1');
  }
}

// Show the banner for the given active cup, populating the text dynamically.
// Dismissed state is tracked per cup round so new rounds re-surface the banner.
(function () {
  var CACHE_KEY = 'bsm_cup_banner';

  // BS Cup is an NRL-only competition - only surface it on NRL pages and on
  // general pages (home, about, ...), never while browsing NRLW/NFL/NHL.
  var path = window.location.pathname;
  var onNrlPage = path.indexOf('/nrl/') === 0 && !/[?&](comp|competition)=nrlw/.test(window.location.search);
  var onSportPage = /^\/(nrl|nfl|nhl)\//.test(path);
  if (onSportPage && !onNrlPage) return;

  function applyBanner(cup) {
    var label      = _cupRoundLabel(cup.current_cup_round, cup.bracket_size);
    var nrlRound   = cup.seeding_round + cup.current_cup_round;
    var dismissKey = 'bsm_prize_banner_dismissed_cup_r' + cup.current_cup_round;

    if (localStorage.getItem(dismissKey)) return;

    function tryShow() {
      var banner = document.getElementById('prize-banner');
      if (!banner) return false;
      var textEl = document.getElementById('prize-banner-text');
      if (textEl) {
        textEl.innerHTML =
          'BS Cup <strong>' + label + '</strong> plays in Round ' + nrlRound +
          ' &mdash; The cup winner gets a <strong>$50 gift card!</strong>';
      }
      banner.dataset.dismissKey = dismissKey;
      banner.style.display = '';
      return true;
    }

    if (!tryShow()) {
      var headerEl = document.getElementById('site-header');
      if (!headerEl) return;
      var obs = new MutationObserver(function () {
        if (tryShow()) obs.disconnect();
      });
      obs.observe(headerEl, { childList: true, subtree: true });
    }
  }

  // Use sessionStorage to avoid fetching on every page navigation.
  var cached = sessionStorage.getItem(CACHE_KEY);
  if (cached !== null) {
    try {
      var cup = JSON.parse(cached);
      if (cup && cup.status === 'active') applyBanner(cup);
    } catch (e) {}
    return;
  }

  fetch(BACKEND_ROOT + '/api/cups?season=' + new Date().getFullYear())
    .then(function (r) { return r.json(); })
    .then(function (cups) {
      var activeCup = Array.isArray(cups) && cups.find(function (c) { return c.status === 'active'; });
      sessionStorage.setItem(CACHE_KEY, activeCup ? JSON.stringify(activeCup) : 'null');
      if (activeCup) applyBanner(activeCup);
    })
    .catch(function () {
      // Fail silently — banner stays hidden if API is unreachable
    });
})();
