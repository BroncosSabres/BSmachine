// Shared component loader — footer injection & prize banner logic

// ---- Footer ----
(function () {
  var el = document.getElementById('site-footer');
  if (!el) return;
  fetch('/components/footer.html')
    .then(function (r) { return r.text(); })
    .then(function (html) { el.innerHTML = html; });
})();

// ---- Prize Banner ----

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
  localStorage.setItem('bsm_prize_banner_dismissed', '1');
}

// Show banner once the header has been injected (header fetch is async)
(function () {
  if (localStorage.getItem('bsm_prize_banner_dismissed')) return;

  function tryShow() {
    var banner = document.getElementById('prize-banner');
    if (banner) { banner.style.display = ''; return true; }
    return false;
  }

  if (!tryShow()) {
    var headerEl = document.getElementById('site-header');
    if (!headerEl) return;
    var obs = new MutationObserver(function () {
      if (tryShow()) obs.disconnect();
    });
    obs.observe(headerEl, { childList: true, subtree: true });
  }
})();
