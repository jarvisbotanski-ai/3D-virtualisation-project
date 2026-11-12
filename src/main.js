import '@fontsource-variable/geist';
import './styles.css';
import { initHero } from './hero/hero.js';
import { initSmoothScroll } from './smooth-scroll.js';
import { PROJECTS } from './projects.js';

// ---------- work grid (from src/projects.js) ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
document.getElementById('workGrid').innerHTML = PROJECTS.map((p) => {
  const thumb = p.thumb
    ? `<div class="thumb${p.clay ? ' clay' : ''}" style="background-image:url(${esc(p.thumb)});${esc(p.thumbStyle || '')}"></div>`
    : `<div class="thumb"><div class="ph">${esc(p.placeholder || '')}</div></div>`;
  const right = p.area ? `<span class="num">${p.area} m² · ${p.year}</span>` : `<span class="arrow">→</span>`;
  return `<a class="cell" href="${esc(p.href || '#')}">${thumb}<div class="row"><b${p.draft ? ' class="draft"' : ''}>${esc(p.title)}</b>${right}</div></a>`;
}).join('');

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
