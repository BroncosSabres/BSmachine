// tap-tips.js — tooltips that also work on touch screens.
//
// A title attribute only shows on hover, so phones never see it. Once
// installed on a root element:
//   - an element with data-tip shows its text in a popover when tapped or
//     clicked, on any device (the outlier chip). Use a <button> for it, so it
//     is reachable by keyboard.
//   - on a device without hover, tapping any other element with a title shows
//     that title the same way, unless the tap lands on a link, button or form
//     control inside it (those keep doing what they do).
// The tap that opens a tip goes no further, so a tip inside a clickable row
// doesn't also open the row. Another tap, a scroll or Escape closes it.

const INTERACTIVE = 'a, button, input, select, textarea, summary, label, [role="button"]';
const canHover = () => window.matchMedia('(hover: hover)').matches;

let tip = null;       // the popover element
let anchor = null;    // the element it is showing for
let installed = false;
const roots = new Set();

function hide() {
  tip?.remove();
  tip = null;
  anchor = null;
}

function show(el, text) {
  hide();
  anchor = el;
  tip = document.createElement('div');
  tip.setAttribute('role', 'tooltip');
  tip.textContent = text;
  Object.assign(tip.style, {
    position: 'fixed', zIndex: '1000', maxWidth: 'min(320px, calc(100vw - 16px))', padding: '6px 9px',
    background: '#111827', color: '#e5e7eb', border: '1px solid #4b5563', borderRadius: '6px',
    fontSize: '12px', lineHeight: '1.4', whiteSpace: 'pre-line', boxShadow: '0 6px 18px rgba(0,0,0,.45)',
    top: '0', left: '0', visibility: 'hidden',
  });
  document.body.appendChild(tip);
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  const below = r.bottom + 6 + h <= window.innerHeight - 8 || r.top - 6 - h < 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? r.bottom + 6 : r.top - 6 - h}px`;
  tip.style.visibility = 'visible';
}

// The element a tap should show a tip for, and its text, or null.
function tipFor(target) {
  if (![...roots].some(root => root.contains(target))) return null;
  const forced = target.closest('[data-tip]');
  if (forced) return [forced, forced.dataset.tip];
  if (canHover()) return null;
  const titled = target.closest('[title]');
  if (!titled || !titled.title) return null;
  const control = target.closest(INTERACTIVE);
  if (control && titled.contains(control)) return null;
  return [titled, titled.title];
}

export function installTapTips(root = document.body) {
  if (!root) return;
  roots.add(root);
  if (installed) return;
  installed = true;
  document.addEventListener('click', e => {
    if (tip && tip.contains(e.target)) return;
    const found = tipFor(e.target);
    if (!found) {
      hide();
      return;
    }
    const [el, text] = found;
    e.preventDefault();
    e.stopPropagation();
    if (el === anchor) hide();
    else show(el, text);
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, { passive: true, capture: true });
  // A phone's address bar showing or hiding resizes the height only: keep the tip then
  let width = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth !== width) hide();
    width = window.innerWidth;
  });
}
