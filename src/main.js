import '@fontsource-variable/geist';
import './styles.css';
import { initHero } from './hero/hero.js';
import { initSmoothScroll } from './smooth-scroll.js';
import { PROJECTS } from './projects.js';

// ---------- work: one drawing sheet per project (from src/projects.js) ----------
// A sheet = the view, the plan with its two overall dimensions, and a title block.
// Sheet numbers (A-01, A-02…) come from the order in projects.js.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
document.getElementById('workSheets').innerHTML = PROJECTS.map((p, i) => {
  const no = `A-${String(i + 1).padStart(2, '0')}`;
  const view = `<div class="sheet-view" role="img" aria-label="${esc(p.title)}, interior" style="background-image:url(${esc(p.view)});${esc(p.viewStyle || '')}"></div>`;
  // plan: cropped to the drawing's own bounding box (planBox, % of the image) so the
  // dimension lines sit exactly on the outer walls, not on the image edge
  let plan = '';
  if (p.plan) {
    const [l, t, r, b] = p.planBox || [0, 0, 100, 100];
    const w = r - l, h = b - t;
    const [pw, ph] = p.planPx || [1, 1];
    const pos = (a, s) => (s >= 100 ? 0 : (a / (100 - s)) * 100);
    const img = `background-image:url(${esc(p.plan)});background-size:${(10000 / w).toFixed(3)}% auto;` +
      `background-position:${pos(l, w).toFixed(3)}% ${pos(t, h).toFixed(3)}%;aspect-ratio:${((w * pw) / (h * ph)).toFixed(4)}`;
    const dims = p.size
      ? `<span class="dim dim-h"><i>${Math.max(...p.size).toFixed(2)}</i></span><span class="dim dim-v"><i>${Math.min(...p.size).toFixed(2)}</i></span>`
      : '';
    plan = `<figure class="sheet-plan" id="plan-${i + 1}"><div class="plan-in"><div class="plan" role="img" aria-label="Floor plan" style="${img}">${dims}</div></div></figure>`;
  }
  const row = (k, v) => (v == null || v === '' ? '' : `<div><dt>${k}</dt><dd>${v}</dd></div>`);
  const block = `<div class="tb">` +
    `<div class="tb-head"><span class="tb-no num">${no}</span><h3>${esc(p.title)}</h3>` +
    // phones only (hidden on desktop, where the plan is always on the sheet)
    (p.plan ? `<button type="button" class="tb-toggle" aria-expanded="false" aria-controls="plan-${i + 1}">Plan<i aria-hidden="true"></i></button>` : '') +
    `${p.note ? `<p>${esc(p.note)}</p>` : ''}</div>` +
    `<dl class="tb-grid num">${row('Location', p.place && esc(p.place))}${row('Area', p.area && `${p.area} m²`)}${row('Year', p.year)}${row('Rooms', p.rooms)}</dl>` +
    `</div>`;
  const tag = p.href ? 'a' : 'article';
  return `<${tag} class="sheet${p.plan ? ' has-plan' : ''}"${p.href ? ` href="${esc(p.href)}"` : ''} data-reveal>${view}<div class="sheet-side">${plan}${block}</div></${tag}>`;
}).join('');

// ---------- work (phones): the plan folds out from under the title block ----------
// The whole title block is the tap target; the "Plan +" pill is what tells you so.
const PHONE = matchMedia('(max-width:860px)');
// Slide, don't drop: the box grows to the plan's real height while the drawing
// fades in and settles 16px down; closing is the same motion, shorter.
const EASE = 'cubic-bezier(.22,1,.36,1)';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
document.getElementById('workSheets').addEventListener('click', (e) => {
  const tb = e.target.closest('.tb');
  const btn = tb?.querySelector('.tb-toggle');
  if (!btn || !PHONE.matches) return;
  const sheet = tb.closest('.sheet');
  const box = sheet.querySelector('.sheet-plan'), inner = box.firstElementChild;
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  const from = box.getBoundingClientRect().height;      // mid-animation taps start from here
  box.getAnimations().forEach((a) => a.cancel());
  inner.getAnimations().forEach((a) => a.cancel());
  sheet.classList.toggle('plan-open', open);
  if (REDUCED.matches) return;
  const to = open ? box.getBoundingClientRect().height : 0;
  const dur = open ? 640 : 420;
  box.animate({ height: [`${from}px`, `${to}px`] }, { duration: dur, easing: EASE });
  inner.animate(open
    ? { opacity: [0, 1], transform: ['translateY(-16px)', 'none'] }
    : { opacity: [1, 0], transform: ['none', 'translateY(-8px)'] },
  { duration: open ? 560 : 260, delay: open ? 90 : 0, easing: EASE, fill: 'backwards' });
});

// ---------- process: tick positions for the looping fill (styles.css .chain) ----------
// Desktop columns are equal (1/3, 2/3), but on phones the steps stack with different
// text heights, so the stops are measured, not assumed.
const chain = document.querySelector('.chain');
if (chain) {
  const TICK_Y = 9;   // .chain li::before top on phones
  const syncChain = () => {
    const [, b, c] = chain.children;
    const vertical = getComputedStyle(chain).gridTemplateColumns.split(' ').length === 1;
    const len = vertical ? chain.clientHeight : chain.clientWidth;
    if (!len || !b || !c) return;
    const at = (li) => (vertical ? li.offsetTop + TICK_Y : li.offsetLeft) / len;
    chain.style.setProperty('--s2', at(b).toFixed(4));
    chain.style.setProperty('--s3', at(c).toFixed(4));
  };
  new ResizeObserver(syncChain).observe(chain);
}

// ---------- scroll + hero ----------
// Smooth scroll first: its loop task must run before the hero's in each frame,
// so the camera reads this frame's scroll position, not last frame's.
initSmoothScroll();
initHero();

// ---------- reveal (defers to the hero; document-order stagger; failsafe) ----------
const AFTER_HERO = 0.52, STAGGER = 0.08;
let batch = [];
const flush = () => {
  const els = batch.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  batch = [];
  els.forEach((el, i) => { el.style.setProperty('--reveal-delay', `${i * STAGGER}s`); el.classList.add('in'); });
};
const io = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) { batch.push(e.target); io.unobserve(e.target); }
  if (batch.length) queueMicrotask(flush);
}, { rootMargin: '0px 0px -12% 0px' });
setTimeout(() => document.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el)), AFTER_HERO * 1000);
setTimeout(() => document.documentElement.classList.add('reveal-failsafe'), 4000);

// ---------- signature (footer logo) + floating CTA ----------
// No header any more: the logo is the last thing on the page and draws itself in,
// and the single CTA pill appears only once the hero is behind you.
const sign = document.getElementById('sign');
new IntersectionObserver((es, o) => {
  for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); o.unobserve(e.target); }
}, { rootMargin: '0px 0px -18% 0px' }).observe(sign);

const jump = document.getElementById('jump');
const hero = document.getElementById('hero');
const contact = document.getElementById('contact');
// visible between "hero scrolled past" and "contact on screen" — it would be noise there
let heroGone = false, atContact = false;
const syncJump = () => jump.classList.toggle('on', heroGone && !atContact);
new IntersectionObserver(([e]) => { heroGone = !e.isIntersecting; syncJump(); },
  { threshold: 0, rootMargin: '-40% 0px 0px 0px' }).observe(hero);
new IntersectionObserver(([e]) => { atContact = e.isIntersecting; syncJump(); },
  { rootMargin: '0px 0px -20% 0px' }).observe(contact);

// ---------- tweaks (dev panel, hidden unless ?tweaks=1) ----------
const tweaks = document.getElementById('tweaks');
if (new URLSearchParams(location.search).has('tweaks')) tweaks.hidden = false;
document.getElementById('tw-grid').addEventListener('change', (e) =>
  document.body.style.setProperty('--border', e.target.checked ? '#08090c' : '#e3e3e3'));

// anchors: smooth unless reduced motion
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  const id = a.getAttribute('href');
  if (id === '#') { e.preventDefault(); return; }
  const el = document.querySelector(id);
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  history.replaceState(null, '', id);
});
