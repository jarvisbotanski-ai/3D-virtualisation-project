// Unified wheel scrolling: a mouse wheel, a Windows laptop touchpad and a MacBook
// trackpad all end up moving the page the same way.
//
// Why: each device delivers `wheel` events completely differently —
//   mouse wheel      ~100 px steps, browser animates each step (~150 ms)
//   Windows touchpad dense stream of small fractional deltas, no browser easing
//   Mac trackpad     fine deltas + the OS's own momentum tail
// so the hero (camera driven by scroll position) received a smooth input from one
// and a raw, jittery one from the others. Here every wheel delta only moves a
// virtual TARGET; the real scroll position glides towards it on the shared rAF
// loop with frame-rate-independent damping. Same curve for every device.
//
// Native everywhere else: keyboard, scrollbar drag, anchor jumps, the hero magnet
// and touch screens are untouched — if the page moves without us, we re-sync.
// Off for prefers-reduced-motion and coarse pointers. Debug: ?smooth=0 disables.
import { addTask, wake } from './loop.js';

const RATE = 11;          // 1/s — time constant ≈ 90 ms, close to a mouse wheel's native easing
const LINE_PX = 16;       // deltaMode 1 (Firefox on some mice)
const EPS = 0.5;          // px — close enough, stop

export const smoothScroll = {
  enabled: false,         // wheel input is being smoothed (fine pointer, motion allowed)
  active: false,          // true while the page is gliding towards the target
  stop() { this.active = false; target = current = scrollY; },
};

let target = 0, current = 0, lastWritten = -1, limit = 0;

const measure = () => { limit = Math.max(0, document.documentElement.scrollHeight - innerHeight); };

// Let nested scrollables (the contact textarea) and pinch-zoom keep native wheel.
// Deliberately a cheap selector test, not a walk reading scrollHeight/computed style:
// those reads can force a synchronous layout on every wheel event — the very hitch
// this module exists to remove. Mark any future inner scroller with data-native-scroll.
function wantsNative(e) {
  if (e.ctrlKey || e.defaultPrevented) return true;                 // pinch / ctrl+wheel zoom
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return true;          // horizontal gestures
  const t = e.target;
  return t instanceof Element && !!t.closest('textarea, select, [data-native-scroll]');
}

function onWheel(e) {
  if (!smoothScroll.enabled || wantsNative(e)) return;
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
  if (!smoothScroll.active) target = current = scrollY;    // start from where the page really is
  target = Math.min(limit, Math.max(0, target + dy));
  smoothScroll.active = true;
  wake();
}

// Anything else moved the page (keyboard, scrollbar, anchor, magnet tween): adopt it.
function onScroll() {
  if (Math.abs(scrollY - lastWritten) > 1.5) {
    smoothScroll.active = false;
    target = current = scrollY;
  }
}

function task(dt) {
  if (!smoothScroll.active) return false;
  current += (target - current) * (1 - Math.exp(-RATE * dt));
  if (Math.abs(target - current) < EPS) { current = target; smoothScroll.active = false; }
  window.scrollTo({ top: current, behavior: 'instant' });
  lastWritten = scrollY;
  return smoothScroll.active;
}

export function initSmoothScroll() {
  const off = new URLSearchParams(location.search).get('smooth') === '0';
  const mqFine = matchMedia('(pointer: fine)');
  const mqReduced = matchMedia('(prefers-reduced-motion: reduce)');
  const apply = () => {
    smoothScroll.enabled = !off && mqFine.matches && !mqReduced.matches;
    if (!smoothScroll.enabled) smoothScroll.stop();
  };
  apply();
  mqFine.addEventListener('change', apply);
  mqReduced.addEventListener('change', apply);

  measure();
  new ResizeObserver(measure).observe(document.body);
  addEventListener('resize', measure);
  // capture: the hero canvas stops wheel propagation (its OrbitControls guard), so a
  // bubbling listener would never see wheels over the 3D — exactly where it matters.
  addEventListener('wheel', onWheel, { passive: false, capture: true });
  addEventListener('scroll', onScroll, { passive: true });
  addTask(task);
  target = current = lastWritten = scrollY;
}
