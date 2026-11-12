# Interior design portfolio — scroll-driven 3D hero

Vite + three.js (npm, r180). Design decisions: `DIZAINO-SPRENDIMAI.md` (source of truth).
Progress log: `PROGRESAS.md`. Open work: `OPTIMIZACIJA.md`, `MOBILE.md`.

## Run

```bash
npm install
npm run dev      # http://127.0.0.1:5173  (bound to 127.0.0.1 in vite.config.js — never use --host)
npm run build    # → dist/
npm run preview  # http://127.0.0.1:4173
npm run assets   # models/citify_butas.glb → public/models/citify_butas.{opt,mobile}.glb
node tools/build-assets.mjs <src.glb> <basename>   # same pipeline for any other model
```

`npm run assets` is the build-time asset pipeline (`tools/build-assets.mjs`, gltf-transform):
normal repair, duplicate-face removal, teal-marker repaint, WebP ≤1024 (mobile ≤512), palette,
height bands from the station cuts, join, meshopt. Source 15.2 MB → 3.6 MB desktop / 3.0 MB mobile.
Rerun it after changing the source GLB or a station `cut`; commit the outputs in `public/models/`.
`models/` is the untouched source and is not shipped. Passing a source path + basename runs the
same pipeline for a non-hero model (no mobile variant): that is how `migdol_citify.opt.glb` is built.

**Teal marker:** both SketchUp exports paint unassigned faces rgb(0,153,135). The pipeline
repaints it as plaster; `ASSETS_TEAL=0` disables that to inspect the raw export.

Note (WSL): `node_modules` holds both the Windows and Linux native bindings of rolldown /
lightningcss so `npm run build` works from either side. After an `npm install` on Linux, check
`node_modules/@rolldown/binding-*` if the Windows side stops building.

## Structure

```
index.html              page markup (hero, Approach, Work, Process, Contact, signature, Tweaks)
src/main.js             entry: fonts, styles, work grid, reveal-on-scroll, signature reveal, jump CTA, tweaks
src/styles.css          kachingappz tokens verbatim + layout (desktop / ≤860px / reduced motion)
src/loop.js             the single requestAnimationFrame loop (sleeps when idle)
src/projects.js         "Selected work" data
src/hero/stations.js    ALL camera stations + scroll timing + magnet/orbit/quality settings (one config object)
src/hero/scene.js       three.js engine: meshopt GLB load, mm→m, merge, clipping cut, fit-to-frame camera
                        solve, lights + on-demand shadow map, pixel budget, OrbitControls
src/hero/materials.js   onBeforeCompile patch: blueprint ↔ clay ↔ textures via 2px Bayer dither
src/hero/hero.js        modes (scroll / mobile / static), scroll → progress, magnet, station UI, loading
public/brand/           mark.svg + wordmark.svg — traced from logo.jpg, used as CSS masks (inherit ink)
public/posters/         plan.png (instant poster) + mid.png (mobile / reduced-motion poster)
public/img/             work-grid thumbnails
public/models/          citify_butas.{opt,mobile}.glb + migdol_citify.opt.glb — built by `npm run assets`
models/                 SOURCE: citify_butas.glb (hero), migdol_citify.glb, house.glb — not shipped, never edited
tools/build-assets.mjs  the asset pipeline (`npm run assets`, or with <src> <basename> args)
tools/trace-logo.py     logo.jpg → public/brand/*.svg (potracer; needs a venv with pillow+numpy+potracer)
tools/poster.html       dev-only: renders a station with the real engine (regenerate posters)
tools/thumb.html        dev-only: renders ANY glb with the hero engine (?model=&az=&el=&cut=&mat=)
tools/posters.sh        screenshots tools/poster.html → trimmed public/posters/*.png (dev server must run)
tools/perf.js           dev-only perf probe (ms/frame, draw calls, shadow passes per station)
tools/verify-v2.sh      agent-browser: stations at W×H → verify/v2/*.png + model-bbox-in-frame check
tools/verify-sections.sh  agent-browser: no-header + section geometry + signature reveal → verify/d28/*.png
tools/verify-artefacts.sh  v1 (source GLB + DoubleSide) vs v2 at stations 2/3 → verify/v2/artefacts-*.png
tools/verify-*.sh       older v1 verification scripts → verify/*.png
tools/analysis/         source-model diagnostics (winding, coincident faces, floor pairs, size breakdown)
reference/              old static mockup + render harness (not shipped)
```

## Camera stations

Edit `HERO.stations` in `src/hero/stations.js` only. Per station: `az/el` (deg), `fov`
(perspective strength), `fit: 'bbox' | { padding, padPx }`, `cut` (section height, m),
`blueprint`, `materialise`, `scroll: [holdStart, holdEnd]` in hero progress 0..1.
There is no `dist`: the engine solves distance + lens shift so every model vertex under the cut
fits the hero frame (`.frame` in styles.css — the viewport right of the copy column) on the real
canvas aspect. The hero canvas is full-bleed (100vw × 100vh); the sections below use the same
`--hero-pad` left/right margin, so one edge runs from the top of the page to the signature.
After changing station 0 or 3, regenerate posters: `npm run dev` then `bash tools/posters.sh`.
After changing a `cut`, rerun `npm run assets` (height bands come from the cuts).

## Add a project

Add one object to `PROJECTS` in `src/projects.js` (`title, area, year, thumb, href`). For the
thumbnail, render the model with the site's own engine rather than screenshotting SketchUp:

```bash
node tools/build-assets.mjs models/<name>.glb <name>     # → public/models/<name>.opt.glb
npm run dev
# open /tools/thumb.html?model=/models/<name>.opt.glb&az=50&el=62&cut=1.2&mat=1 at 1600×900,
# wait for window.__thumbReady, screenshot, then trim with sharp into public/img/
```

A 3D per-project viewer (`model:` field, D21) is not wired yet.

## Debug

`?magnet=0` disables magnetic stations (for screenshots). `?tiers=0` disables the adaptive
pixel-ratio step-down. `?model=src` loads the unoptimised source GLB, `?side=double` forces v1's
DoubleSide materials (artefact before/after). `window.__heroStats` has load timings;
`agent-browser eval "$(cat tools/perf.js)"` then poll `window.__perf` for per-station timings.
