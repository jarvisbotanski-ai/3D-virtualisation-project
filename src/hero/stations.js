// ─────────────────────────────────────────────────────────────────────────────
// HERO CHOREOGRAPHY — the single source of truth for camera stations.
//
// Every camera/scroll number of the hero lives here. Nothing else in the code
// base hard-codes a camera position.
//
// v2 framing = FIT, not distance. For every station the engine solves the camera
// distance (and a lens shift) so the visible model — every vertex below the section
// cut — fits the hero FRAME (the area right of the copy, see .frame in styles.css)
// on the actual canvas aspect ratio. Nothing is ever cropped, no edge fades.
//   az / el  — degrees, orbit around the model centre (az 0 = from +z, el 90 = top-down)
//   fov      — vertical FOV in degrees (perspective strength only; size comes from fit)
//   hfov     — plan only: horizontal FOV (1° from far away = optically orthographic,
//              so plan → perspective is one continuous dolly-zoom)
//   fit      — 'bbox' (default padding) or { padding, padPx, focus }:
//                padding  fraction of min(frameW, frameH) kept free on every side
//                padPx    [top, right, bottom, left] extra px (plan: room for dimensions)
//                focus    { x: [min,max], z: [min,max] } — fit THIS world box instead
//                         of the whole model, floor → cut. The flat is cropped around
//                         it: this is how the mockup's mid-shot (03/04) gets close.
//                         Without focus nothing is ever cropped (stations 0–1).
//   cut      — section-cut (clipping plane) height above the floor in metres
//   blueprint   0..1 — ink-on-paper plan look
//   materialise 0..1 — clay → textures (ordered Bayer dither in the material shader).
//                      A [from, to] pair ramps ACROSS THE STATION'S OWN HOLD, so the
//                      dissolve happens with the camera standing still (D7).
//   scroll   — [start, end] of the station's HOLD in hero scroll progress (0..1).
//              The gaps between holds are the transitions.
// ─────────────────────────────────────────────────────────────────────────────
const BASE = import.meta.env?.BASE_URL ?? '/';

export const HERO = {
  // Built by `npm run assets` from models/citify_butas.glb (meshopt + WebP, see tools/build-assets.mjs)
  model: BASE + 'models/citify_butas.opt.glb',
  modelMobile: BASE + 'models/citify_butas.mobile.glb',
  targetY: 0.6,            // fallback look-at height above floor (m) before the model loads
  defaultFit: { padding: 0.05, padPx: [0, 0, 0, 0] },

  colors: {
    clay: '#c9c2b6',
    paper: '#f7f7f7',
    ink: '#08090c',
    planTop: '#cccccc',    // furniture tops in the plan (harness: grey .80)
  },

  stations: [
    {
      id: 'plan',
      scroll: [0.00, 0.12],
      // az -90 puts the long axis horizontal (same as the harness ortho camera, up = +x).
      az: -90, el: 90, hfov: 1,
      fit: { padding: 0.04, padPx: [34, 44, 8, 8] },   // dims label above + right
      cut: 1.2, blueprint: 1, materialise: 0,
    },
    {
      id: 'clay',
      scroll: [0.26, 0.38],
      az: 50, el: 42, fov: 32,
      fit: { padding: 0.12 },                          // wide: the whole shape, room around it
      cut: 1.7, blueprint: 0, materialise: 0,
    },
    {
      // Mockup 03-clay-mid / 04-textured: the camera comes INSIDE the flat and frames
      // the dining table + kitchen run; the rest of the apartment runs off-frame.
      // The box is measured from the model (table x 4.28…5.97 z -9.83…-7.16,
      // kitchen run x 1.79…2.40 z -10.47…-6.75) plus breathing room.
      // The dissolve runs across this hold, camera still — colour arrives here (D7).
      id: 'mid',
      scroll: [0.52, 0.72],
      az: 50, el: 44, fov: 30,
      fit: { focus: { x: [1.3, 6.4], z: [-11.0, -6.2] }, padding: 0.03 },
      cut: 1.8, blueprint: 0, materialise: [0, 1],
    },
    {
      // The last station is a still, composed wide shot — no dragging. Orbit was
      // dropped: dragging 172k triangles re-rendered every pointer move and the
      // hero dropped to ~24 fps for the whole visit. The idle sway stays, so the
      // shot still breathes; the only thing the hero asks of the mouse is a click
      // on the CTA. (The mobile "Look around" viewer keeps its orbit — it is
      // opt-in, fullscreen, and nothing else is animating there.)
      id: 'orbit',
      scroll: [0.86, 1.00],
      az: 50, el: 44, fov: 30,
      fit: { padding: 0.02 },
      cut: 1.8, blueprint: 0, materialise: 1,
      orbit: false,
    },
  ],

  // Where the station dots / magnet send you (hero progress).
  // Station 2 lands at the START of its hold so the dissolve plays out as you scroll on.
  dotTargets: [0.04, 0.32, 0.53, 0.93],

  materialise: {
    blockPx: 2,            // Bayer cell size in CSS px (anchored to gl_FragCoord)
    spread: 0.7,           // how much the floor leads the ceiling (0 = uniform)
    heightRange: 1.8,      // metres over which the bottom-up sweep runs
  },

  magnet: {
    idleMs: 160,           // scroll idle before the magnet engages
    durationMs: 900,
    materialiseMs: 1200,   // the clay → texture segment gets the 1.2 s from the spec
    release: 0.15,         // segment fraction you must travel before it pulls forward
    // Trackpad inertia keeps firing scroll events for a second or more after the
    // fingers leave, so "no scroll event for 160 ms" is NOT the same as "the page
    // has stopped". The magnet additionally waits until the page is moving slower
    // than this (px per ms, ≈ 1 screen in 2.5 s) — otherwise its tween and the
    // browser's inertia push the same scrollTop and the hero stutters differently
    // on every flick.
    maxVel: 0.35,
  },

  orbit: {
    minDistMul: 0.65, maxDistMul: 1.3,   // limited zoom (pinch / ctrl+wheel)
    minEl: 12, maxEl: 80,
    idleAmpDeg: 3, idlePeriodS: 14,      // idle sway ±3°
    hintAfterMs: 4000,
  },

  parallax: { azDeg: 1.5, elDeg: 1.0 },  // body language: model follows the cursor a little

  // Render budget (perf #1). Device pixels are capped so a full-bleed canvas on a
  // retina laptop does not shade 5+ MP per frame; if busy frames still run slow the
  // engine steps the pixel ratio down (D19 light). `?tiers=0` disables the step-down.
  quality: {
    maxPixels: 2.8e6,      // canvas device pixels cap (1440×900 @2x → pr ≈ 1.39)
    slowFrameMs: 26,       // median busy-frame interval that counts as "slow"
    stepDown: 0.8, minScale: 0.6,
    shadowMapSize: 2048,
    shadowCutStep: 0.15,   // m of section-cut travel between shadow-map refreshes
    shadowSettleMs: 120,   // stillness required before the deferred settle refresh is spent
    // Texture minification quality. The flat-lying, grazing-angle surfaces here
    // (shelf lines on the wall units, curtain pleats, kitchen backsplash, floor
    // mosaic) are thin stripe patterns: with the default anisotropy of 1 the
    // mip chain blurs along the wrong axis and the stripes crawl/shimmer while
    // the camera moves. 8× is the usual sweet spot — cost is sampling-only (no
    // extra VRAM, no extra draw calls). `?aniso=N` overrides for A/B.
    anisotropy: 8,
  },
};
