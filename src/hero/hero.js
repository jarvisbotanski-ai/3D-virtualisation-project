// Hero controller: decides the mode, owns scroll choreography, magnet, station UI,
// loading (poster → canvas crossfade) and the mobile flat hero (flat.js).
//
// Modes
//   scroll  — desktop, WebGL, motion allowed: full 4-station choreography
//   mobile  — ≤860px: "the flat is the page" — baked height-field shader, no GLB (flat.js)
//   static  — prefers-reduced-motion or no WebGL: poster only
import { HERO } from './stations.js';
import { HeroScene, webglAvailable } from './scene.js';
import { addTask, wake } from '../loop.js';
import { smoothScroll } from '../smooth-scroll.js';
import { setupFlat } from './flat.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));

const MQ_MOBILE = matchMedia('(max-width: 860px)');
const MQ_REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
// Debug params (verification / screenshots only):
//   ?magnet=0  disables the magnetic stations
//   ?tiers=0   disables the adaptive pixel-ratio step-down
//   ?model=src loads the unoptimised source GLB (models/) for before/after comparison
//   ?side=double forces v1's DoubleSide materials (artefact comparison)
//   ?aniso=N   texture anisotropy override (1 = v2's old shimmering default)
//   ?follow=N  camera follow rate for free scrolling (default 22 with smooth wheel,
//              9 with ?smooth=0 — the wheel is already eased, so the camera need
//              not smooth it a second time)
const QS = new URLSearchParams(location.search);
const NO_MAGNET = QS.get('magnet') === '0';
const DEBUG_MODEL = QS.get('model') === 'src' ? '/models/citify_butas.glb' : undefined;
const DEBUG_SIDE = QS.get('side') === 'double';
const DEBUG_ANISO = QS.has('aniso') ? Number(QS.get('aniso')) || 1 : undefined;
const FOLLOW_QS = Number(QS.get('follow')) || 0;
const follow = () => FOLLOW_QS || (smoothScroll.enabled ? 22 : 9);

export function initHero() {
  const hasGL = webglAvailable();
  document.documentElement.classList.toggle('can-3d', hasGL);
  let teardown = null;
  let mode = null;
  let flatFailed = false;

  const pick = () => (!hasGL || MQ_REDUCED.matches ? 'static' : MQ_MOBILE.matches ? (flatFailed ? 'static' : 'mobile') : 'scroll');
  const apply = () => {
    const m = pick();
    if (m === mode) return;
    teardown?.();
    mode = m;
    document.documentElement.classList.toggle('hero-static', m === 'static');
    document.documentElement.dataset.heroMode = m;
    teardown = m === 'scroll' ? setupScroll() : m === 'mobile' ? setupMobile(() => { flatFailed = true; apply(); }) : setupStatic();
  };
  MQ_MOBILE.addEventListener('change', apply);
  MQ_REDUCED.addEventListener('change', apply);
  apply();
  window.__hero = { get mode() { return mode; } };
}

// ───────────────────────────── static ─────────────────────────────
function setupStatic() {
  const mid = $('.poster-mid');
  mid.loading = 'eager';
  return () => {};
}

// ───────────────────────────── desktop scroll ─────────────────────────────
function setupScroll() {
  const hero = $('#hero');
  const stage = $('#stage3d');
  const host = $('#canvasHost');
  const sts = $$('.copy .st');
  const dots = $$('.dots button');
  const hint = $('.hint');
  const dims = $('#dims');
  const twDither = $('#tw-dither');
  const S = HERO.stations;

  const engine = new HeroScene(host, { frameEl: $('#heroFrame'), interactive: false, adaptive: QS.get('tiers') !== '0', forceDoubleSide: DEBUG_SIDE, anisotropy: DEBUG_ANISO });
  engine.setDither(twDither.checked);
  window.__engine = engine;

  let visible = true;
  let target = 0;          // raw scroll progress
  let smoothP = 0;         // what the camera follows
  let tween = null;        // magnet / dot tween
  let idleTimer = 0;
  let lastY = scrollY, dir = 1;
  let station = -1;

  // Hero geometry is read ONCE per resize, never per scroll event. Reading
  // getBoundingClientRect()/offsetHeight inside the scroll handler forces a
  // synchronous layout on every wheel tick, and during the materialise station
  // (where the dims overlay also writes) that is the single biggest source of
  // uneven scroll pacing — the hitch lands in a different place each run
  // depending on where the browser happens to need a reflow.
  let mTop = 0, mTotal = 1;
  const measure = () => {
    mTotal = Math.max(1, hero.offsetHeight - innerHeight);
    mTop = hero.getBoundingClientRect().top + scrollY;
  };
  measure();

  const total = () => mTotal;
  const top = () => mTop;
  const progressNow = () => clamp01((scrollY - mTop) / mTotal);
  const yFor = (p) => mTop + p * mTotal;

  // ── station UI (D8: copy only while the camera is still; D10 hints) ──
  function stationFor(p) {
    const eps = 0.006;
    for (let i = 0; i < S.length; i++) {
      const [a, b] = S[i].scroll;
      const until = S[i].copyUntil ?? b;
      if (p >= a - eps && p <= until + eps) return i;
    }
    return -1;
  }
  function nearest(p) {
    let best = 0, bd = 1e9;
    S.forEach((s, i) => { const d = p < s.scroll[0] ? s.scroll[0] - p : p > s.scroll[1] ? p - s.scroll[1] : 0; if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function updateUI(p) {
    const st = stationFor(p);
    const near = nearest(p);
    dots.forEach((d, k) => d.classList.toggle('on', k === near));
    if (st === station) return;
    station = st;
    sts.forEach((s, k) => s.classList.toggle('on', k === st));
    hint.classList.toggle('on', st !== 3 && p < 0.97);
    // The desktop hero no longer hands the model to the mouse (see stations.js):
    // setOrbit stays false, so no OrbitControls, no per-pointer re-render.
    engine.setOrbit(false);
    // The sway is the only motion left at the last station — switch it on there,
    // and only there, so the scripted stations stay exactly as composed.
    engine.setSway(st === S.length - 1);
  }

  // ── dimension overlay on the plan (HTML/SVG anchored to 3D points) ──
  let dimsSig = '';
  let dimsOp = -1;
  function updateDims() {
    const bp = engine.U.uBlueprint.value;
    const op = Math.max(0, (bp - 0.5) * 2);
    // Writing style.opacity every frame invalidates the overlay even when it is
    // fully transparent (stations 1–3 — i.e. most of the scroll). Touch the DOM
    // only when the value actually changes, and do no projection work at all
    // while the plan is gone.
    if (op !== dimsOp) { dimsOp = op; dims.style.opacity = op.toFixed(3); }
    if (op <= 0) return;
    const a = engine.planAnchors();
    if (!a) return;
    // top edge = long side (AB), right edge = short side (AC) — right, so it never
    // crowds the headline in the left column; offsets in px
    const ab = [a.a, a.b].sort((m, n) => m.x - n.x);
    const y0 = Math.min(a.a.y, a.b.y, a.c.y) - 18;
    const x0 = Math.max(a.a.x, a.b.x, a.c.x) + 18;
    const ys = [a.a.y, a.c.y].sort((m, n) => m - n);
    const sig = [ab[0].x, ab[1].x, y0, x0, ys[0], ys[1]].map((v) => v.toFixed(1)).join();
    if (sig === dimsSig) return;
    dimsSig = sig;
    const tick = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    const mx = (ab[0].x + ab[1].x) / 2, my = (ys[0] + ys[1]) / 2;
    dims.innerHTML =
      tick(ab[0].x, y0, ab[1].x, y0) + tick(ab[0].x, y0 - 4, ab[0].x, y0 + 4) + tick(ab[1].x, y0 - 4, ab[1].x, y0 + 4) +
      `<text x="${mx}" y="${y0 - 8}" text-anchor="middle">${a.lenAB.toFixed(2)} m</text>` +
      tick(x0, ys[0], x0, ys[1]) + tick(x0 - 4, ys[0], x0 + 4, ys[0]) + tick(x0 - 4, ys[1], x0 + 4, ys[1]) +
      `<text x="${x0 + 14}" y="${my}" text-anchor="middle" transform="rotate(90 ${x0 + 14} ${my})">${a.lenAC.toFixed(2)} m</text>`;
  }

  // ── magnet (D11): never a lock; after the wheel goes quiet, ease to a hold ──
  function magnetTarget(p) {
    for (let i = 0; i < S.length - 1; i++) {
      const a = S[i].scroll[1], b = S[i + 1].scroll[0];
      if (p > a + 1e-4 && p < b - 1e-4) {
        const t = (p - a) / (b - a);
        const fwd = dir > 0 ? t > HERO.magnet.release : t > 1 - HERO.magnet.release;
        // A transition that also changes the materialise level gets the spec's ~1.2 s.
        // (The main clay → texture dissolve now runs inside station 2's own hold, with
        // the camera still, so this only applies to any residual step between holds.)
        const endA = Array.isArray(S[i].materialise) ? S[i].materialise[1] : S[i].materialise;
        const startB = Array.isArray(S[i + 1].materialise) ? S[i + 1].materialise[0] : S[i + 1].materialise;
        const isMat = endA !== startB;
        const toP = fwd ? b : a;
        const dur = isMat ? HERO.magnet.materialiseMs * Math.max(0.35, Math.abs(toP - p) / (b - a)) : HERO.magnet.durationMs;
        return { toP, dur };
      }
    }
    return null;
  }
  function startTween(toP, dur) {
    smoothScroll.stop();     // one writer at a time: the magnet/dot tween owns the scroll now
    tween = { from: scrollY, to: yFor(toP), t0: performance.now(), dur, expect: scrollY };
    wake();
  }
  const cancelTween = () => { tween = null; };
  const onUserInput = () => { cancelTween(); clearTimeout(idleTimer); };

  // Scroll velocity, measured from the scroll events themselves. Trackpad inertia
  // keeps firing `scroll` long after the last `wheel`, with gaps that can exceed
  // the magnet's idle delay — so the old "160 ms since the last scroll event"
  // test let the magnet start pulling WHILE the page was still gliding. The two
  // motions then fought, and because inertia decays differently every flick the
  // artefact landed somewhere new each time. Engage only once the page is
  // genuinely slow.
  let vel = 0, lastT = performance.now();
  const trackVelocity = (y) => {
    const now = performance.now();
    const dtv = Math.max(8, now - lastT);
    lastT = now;
    const v = Math.abs(y - lastY) / dtv;            // px per ms
    vel = vel * 0.6 + v * 0.4;
  };

  function onScroll() {
    const y = scrollY;
    if (!tween) trackVelocity(y);
    if (y !== lastY && !tween) dir = y > lastY ? 1 : -1;
    lastY = y;
    target = progressNow();
    updateUI(target);
    wake();
    if (tween) return;
    if (NO_MAGNET) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // pinned check from the cached metrics — no layout read on the idle path
      if (scrollY < mTop || scrollY > mTop + mTotal) return;
      if (vel > HERO.magnet.maxVel || smoothScroll.active) {   // still gliding: ask again later
        idleTimer = setTimeout(() => onScroll(), HERO.magnet.idleMs);
        return;
      }
      const m = magnetTarget(progressNow());
      if (m) startTween(m.toP, m.dur);
    }, HERO.magnet.idleMs);
  }

  const onResize = () => { measure(); onScroll(); };

  // ── pointer parallax: removed ──
  // The model used to follow the cursor by a degree or two (D10 "body language").
  // Every mouse move marked the frame dirty, so moving the mouse while scrolling
  // doubled the render load exactly when the choreography needed it. The idle sway
  // carries the same "it is alive" signal for free, on a timer, with no input.

  // Plain wheel over the canvas always scrolls the page (no scroll trap).
  // Nothing zooms any more: the canvas never captures pointer input on desktop.
  const wheelGuard = (e) => { e.stopImmediatePropagation(); };
  engine.renderer.domElement.addEventListener('wheel', wheelGuard, { capture: true, passive: true });

  const goTo = (i) => {
    const p = HERO.dotTargets[i];
    const d = Math.abs(p - progressNow());
    startTween(p, Math.min(1800, 600 + d * 2200));
  };
  dots.forEach((d) => (d.onclick = () => goTo(+d.dataset.go)));

  const onDither = () => { engine.setDither(twDither.checked); wake(); };
  twDither.addEventListener('change', onDither);

  // ── visibility gate: no work while the hero is offscreen ──
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) { engine.forceRender = true; wake(); } });
  io.observe(hero);

  // ── the loop task ──
  const removeTask = addTask((dt, now) => {
    let busy = false;
    if (tween) {
      // If the page moved since our last write, something other than this tween
      // moved it (trackpad inertia that outlived the velocity gate, a keyboard
      // page-down, a browser smooth-scroll). Writing our own position on top of
      // that is what produces the "it fights me / different every time" feel —
      // hand the scroll back instead of winning the tug of war.
      if (Math.abs(scrollY - tween.expect) > 2) {
        tween = null;
      } else {
        const t = clamp01((now - tween.t0) / tween.dur);
        const y = Math.round(tween.from + (tween.to - tween.from) * easeOutQuint(t));
        window.scrollTo({ top: y, behavior: 'instant' });
        tween.expect = scrollY;
        lastY = scrollY;
        target = progressNow();
        if (t >= 1) tween = null; else busy = true;
      }
    }
    if (!visible || !engine.ready) return busy;
    // Read the scroll position the smooth-scroll task wrote THIS frame, rather than
    // waiting for the `scroll` event (dispatched next frame) — saves a frame of lag.
    if (!tween) target = progressNow();
    // During a tween the scroll position itself is eased, so the camera follows
    // tightly. Free scrolling is damped — and the rate is frame-rate independent
    // (exp damping), so a dropped frame changes WHEN the camera arrives, never
    // HOW it travels.
    smoothP = damp(smoothP, target, tween ? 30 : follow(), dt);
    if (Math.abs(smoothP - target) < 1e-5) smoothP = target; else busy = true;
    engine.progress = smoothP;
    if (engine.frame(dt, now)) busy = true;
    updateDims();
    return busy;
  });

  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onResize);
  // capture: the canvas guard stops wheel propagation, so a bubbling listener would
  // miss wheels over the 3D and a running magnet tween would fight the smooth scroll.
  addEventListener('wheel', onUserInput, { passive: true, capture: true });
  addEventListener('touchstart', onUserInput, { passive: true });
  addEventListener('keydown', onUserInput);
  engine.onNeedFrame = wake;

  target = smoothP = progressNow();
  engine.progress = smoothP;
  updateUI(target);

  // ── loading: poster is already on screen; crossfade the canvas in when ready ──
  const tLoad = performance.now();
  engine.load(DEBUG_MODEL).then((stats) => {
    smoothP = target = progressNow();
    engine.progress = smoothP;
    engine.render();
    updateDims();
    requestAnimationFrame(() => {
      host.classList.add('ready');
      stage.classList.add('canvas-on');
      window.__heroReady = true;
      window.__heroStats = { ...window.__heroStats, sinceInitMs: Math.round(performance.now() - tLoad) };
      console.info('[hero] GLB ready', window.__heroStats);
      wake();
    });
  }).catch((err) => {
    console.warn('[hero] 3D unavailable, keeping the poster', err);
  });

  return () => {
    removeTask();
    io.disconnect();
    clearTimeout(idleTimer);
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', onResize);
    removeEventListener('wheel', onUserInput, { capture: true });
    removeEventListener('touchstart', onUserInput);
    removeEventListener('keydown', onUserInput);
    twDither.removeEventListener('change', onDither);
    dots.forEach((d) => (d.onclick = null));
    engine.dispose();
    host.classList.remove('ready', 'orbit-on');
    stage.classList.remove('canvas-on');
    dims.innerHTML = '';
    sts.forEach((s, k) => s.classList.toggle('on', k === 0));
  };
}

// ───────────────────────────── mobile: the flat is the page ─────────────────────────────
// No GLB on phones: a baked height field ray-marched by one shader (./flat.js).
// If WebGL setup fails or the context is lost, fall back to the static poster.
function setupMobile(onFail) {
  return setupFlat({
    hero: $('#hero'),
    sticky: $('#hero .sticky'),
    host: $('#canvasHost'),
    dims: $('#dims'),
    intro: $('.copy .st[data-st="0"]'),
    outro: $('.copy .st[data-st="3"]'),
    hint: $('.hint'),
  }, { onFail });
}
