// The hero 3D engine: one renderer, one scene, one camera.
// Owns: GLB loading + preparation, fit-to-frame camera solve per station,
// pose interpolation between the stations in stations.js, OrbitControls at the
// last station, render-on-demand, shadow-map refresh policy, pixel budget.
//
// It never schedules its own RAF — the page loop (src/loop.js) calls frame().
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HERO } from './stations.js';
import { createSharedUniforms, patchMaterial } from './materials.js';

const D2R = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const wrapDeg = (d) => ((d + 540) % 360) - 180;
const Q = HERO.quality;

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
  } catch { return false; }
}

// KHR_mesh_quantization / meshopt give int16/int8 normalized (sometimes interleaved)
// attributes. We bake world matrices and merge, so go back to plain float32.
function toFloat32(attr) {
  if (!attr.isInterleavedBufferAttribute && attr.array instanceof Float32Array && !attr.normalized) return attr;
  const n = attr.count, s = attr.itemSize, out = new Float32Array(n * s);
  for (let i = 0; i < n; i++) {
    out[i * s] = attr.getX(i);
    if (s > 1) out[i * s + 1] = attr.getY(i);
    if (s > 2) out[i * s + 2] = attr.getZ(i);
    if (s > 3) out[i * s + 3] = attr.getW(i);
  }
  return new THREE.BufferAttribute(out, s);
}

export class HeroScene {
  /**
   * @param {HTMLElement} host  element the canvas is appended to (sized by CSS)
   * @param {object} opts { mobile, frameEl, preserveDrawingBuffer, interactive, adaptive, anisotropy }
   *   frameEl — element whose box (relative to host) the model is fitted into.
   *             Without it the whole canvas is the frame.
   *   anisotropy — overrides HERO.quality.anisotropy (clamped to the GPU max).
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = { mobile: false, frameEl: null, preserveDrawingBuffer: false, interactive: true, adaptive: true, anisotropy: undefined, ...opts };
    this.cfg = HERO;
    this.U = createSharedUniforms(HERO.colors);
    this.U.uSpread.value = HERO.materialise.spread;
    this.U.uHRange.value = HERO.materialise.heightRange;
    this.ready = false;
    this.progress = 0;            // smoothed hero progress (set by hero.js)
    this.fixedStation = null;     // mobile viewer / poster tool: pin to one station
    this.orbitEnabled = false;
    this.user = { az: 0, el: 0, zoom: 1 };
    this.sway = { amp: 0, phase: 0 };
    this.swayEnabled = false;   // hero.js turns it on at the last station
    this.parallax = { x: 0, y: 0, tx: 0, ty: 0 };   // unused on desktop; kept for the mobile viewer's math
    this.lastInteract = 0;
    this.interacting = false;
    this._sig = null;             // numeric render signature (see _renderIfChanged)
    this._shadowPending = false;  // deferred shadow-map settle refresh
    this._stillSince = null;
    this.forceRender = true;
    this.stats = {};
    this.qScale = 1;              // adaptive pixel-ratio scale (D19 light)
    this._slow = [];
    this._lastStep = 0;
    this._fits = new Map();
    this.frameRect = { l: 0, t: 0, r: 1, b: 1 };

    const r = (this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,             // transparent: the page paper shows through
      preserveDrawingBuffer: this.opts.preserveDrawingBuffer,
      powerPreference: 'high-performance',
    }));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.localClippingEnabled = true;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false;   // geometry + sun are static; refreshed only when the cut moves
    r.setClearColor(0x000000, 0);
    r.domElement.className = 'hero-canvas';
    host.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 500);
    this.cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.2);

    this._resize = this._resize.bind(this);
    // The observer fires for the host AND the frame element. During a scroll the
    // sticky hero can report sub-pixel box changes, so _resize would clear the
    // fit cache and force a re-render on frames where nothing visually changed.
    // Coalesce to one call per animation frame and let _resize's own
    // sizeChanged/frameChanged guards do the rest.
    let roPending = 0;
    this.ro = new ResizeObserver(() => {
      if (roPending) return;
      roPending = requestAnimationFrame(() => { roPending = 0; this._resize(); this.onNeedFrame?.(); });
    });
    this._roCancel = () => { if (roPending) cancelAnimationFrame(roPending); roPending = 0; };
    this.ro.observe(host);
    if (this.opts.frameEl) this.ro.observe(this.opts.frameEl);
    this._resize();
  }

  // ───────────────────────────── loading ─────────────────────────────
  async load(url = this.opts.mobile ? HERO.modelMobile : HERO.model) {
    const t0 = performance.now();
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    const t1 = performance.now();
    this._prepare(gltf.scene);
    const t2 = performance.now();
    // Compile shaders before the first visible frame (avoids a hitch on reveal).
    this._applyPose(this._poseAt(this.progress));
    try { await this.renderer.compileAsync(this.scene, this.camera); } catch { /* optional */ }
    this.ready = true;
    this.forceRender = true;
    this.stats = { fetchParseMs: Math.round(t1 - t0), prepareMs: Math.round(t2 - t1), totalMs: Math.round(performance.now() - t0) };
    window.__heroStats = { ...this.stats, url, triangles: this._tris, drawGroups: this._groups, textures: this._texCount, anisotropy: this._aniso, maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy?.() ?? 1 };
    return this.stats;
  }

  _prepare(root) {
    // mm → m (openskp exports millimetres)
    root.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(root);
    let size = box.getSize(new THREE.Vector3());
    if (size.x > 100) root.scale.setScalar(0.001);
    root.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
    this.box = box; this.size = size;
    this.ctr = box.getCenter(new THREE.Vector3());
    this.floorY = box.min.y;
    this.radius = size.length() / 2;
    this.U.uFloorY.value = this.floorY;

    // One patched material per source material (shared uniforms → no recompiles).
    // Textures get anisotropic filtering here: every map is shared between the
    // materials that reference it, so a Set keeps the work to once per texture.
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy?.() ?? 1;
    const aniso = Math.max(1, Math.min(this.opts.anisotropy ?? Q.anisotropy ?? 1, maxAniso));
    this._aniso = aniso;
    const TEX_SLOTS = ['map', 'roughnessMap', 'metalnessMap', 'normalMap', 'emissiveMap', 'aoMap'];
    const tuneTextures = (src) => {
      for (const slot of TEX_SLOTS) {
        const t = src[slot];
        if (!t || t.anisotropy === aniso) continue;
        t.anisotropy = aniso;
        // Trilinear between mips as well — without it the stripes pop at mip
        // boundaries even when anisotropy is high.
        if (t.minFilter === THREE.LinearMipmapNearestFilter || t.minFilter === THREE.NearestMipmapLinearFilter) {
          t.minFilter = THREE.LinearMipmapLinearFilter;
        }
        t.needsUpdate = true;   // the sampler state is uploaded with the texture
      }
    };
    const matCache = new Map();
    const texSeen = new Set();
    const getMat = (src) => {
      if (!matCache.has(src)) {
        tuneTextures(src);
        const m = patchMaterial(src, this.U);
        if (this.opts.forceDoubleSide) m.side = THREE.DoubleSide;
        m.clippingPlanes = [this.cutPlane];
        m.clipShadows = true;
        matCache.set(src, m);
        if (src.map) texSeen.add(src.map);
      }
      return matCache.get(src);
    };

    // Static meshes (visible at every cut) are merged per material. Meshes that start
    // above the lowest cut stay separate so they can be hidden when fully above it.
    const minCut = Math.min(...HERO.stations.map((s) => s.cut));
    const byMat = new Map();
    const loose = [];
    const edgeParts = [];
    let tris = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const src = o.geometry;
      const g = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'uv']) if (src.attributes[k]) g.setAttribute(k, toFloat32(src.attributes[k]));
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      const n = g.attributes.position.count;
      const idx = src.index ? Uint32Array.from(src.index.array) : Uint32Array.from({ length: n }, (_, i) => i);
      g.applyMatrix4(o.matrixWorld);
      // Mirrored nodes: baking a negative-determinant matrix flips the winding → swap.
      if (o.matrixWorld.determinant() < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      tris += idx.length / 3;
      // Blueprint ink lines (30° crease) — merged into one LineSegments below.
      edgeParts.push(new THREE.EdgesGeometry(g, 30));
      g.computeBoundingBox();
      const mat = getMat(o.material);
      if (g.boundingBox.min.y > this.floorY + minCut - 0.05) {
        loose.push({ g, mat, minY: g.boundingBox.min.y });
      } else {
        if (!byMat.has(mat)) byMat.set(mat, []);
        byMat.get(mat).push(g);
      }
    });
    this._tris = Math.round(tris);
    this._texCount = texSeen.size;

    const group = new THREE.Group();
    const pts = [];
    const addMesh = (g, mat) => {
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      m.receiveShadow = false;   // only the ground receives — interior stays evenly lit
      m.frustumCulled = false;
      group.add(m);
      pts.push(g.attributes.position.array);
      return m;
    };
    for (const [mat, list] of byMat) {
      addMesh(list.length === 1 ? list[0] : mergeGeometries(list, false), mat);
      list.forEach((g) => list.length > 1 && g.dispose());
    }
    // Loose meshes (start above the lowest cut) bucketed by material + 5 cm of start height.
    const buckets = new Map();
    for (const { g, mat, minY } of loose) {
      const key = mat.uuid + ':' + Math.floor(minY / 0.05);
      if (!buckets.has(key)) buckets.set(key, { mat, minY, list: [] });
      const b = buckets.get(key);
      b.minY = Math.min(b.minY, minY);
      b.list.push(g);
    }
    this.cutMeshes = [...buckets.values()].map(({ mat, minY, list }) => {
      const m = addMesh(list.length === 1 ? list[0] : mergeGeometries(list, false), mat);
      if (list.length > 1) list.forEach((g) => g.dispose());
      m.userData.minY = minY;
      return m;
    });
    this._groups = group.children.length;
    this._buildFitPoints(pts);

    const lineGeo = mergeGeometries(edgeParts.map((e) => { const x = new THREE.BufferGeometry(); x.setAttribute('position', e.attributes.position); return x; }), false);
    edgeParts.forEach((e) => e.dispose());
    this.lineMat = new THREE.LineBasicMaterial({ color: HERO.colors.ink, transparent: true, opacity: 1, clippingPlanes: [this.cutPlane] });
    this.lines = new THREE.LineSegments(lineGeo, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;
    group.add(this.lines);
    this.scene.add(group);

    // Lighting — harness values. Shadow map 2048 (was 4096), frustum fitted to the model.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xa8a298, 1.6));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff4e6, 2.4));
    sun.castShadow = true;
    sun.shadow.mapSize.set(Q.shadowMapSize, Q.shadowMapSize);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    const sunOff = new THREE.Vector3(-4, 22, 6);
    sun.position.set(this.ctr.x + sunOff.x, this.floorY + sunOff.y, this.ctr.z + sunOff.z);
    sun.target.position.copy(this.ctr);
    const sc = sun.shadow.camera, ext = this.radius + 1.5, sd = sun.position.distanceTo(this.ctr);
    sc.left = sc.bottom = -ext; sc.right = sc.top = ext;
    sc.near = Math.max(0.5, sd - this.radius - 2); sc.far = sd + this.radius + 4;
    this.scene.add(sun, sun.target);

    this.groundMat = new THREE.ShadowMaterial({ opacity: 0.16 });
    const ground = (this.ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), this.groundMat));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = this.floorY - 0.003;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Orbit controls: only for the surfaces that actually drag (the mobile opt-in
    // viewer). The desktop hero passes interactive:false — creating the controls
    // there would attach pointer listeners that mark the frame dirty on every move.
    if (this.opts.interactive) {
      const c = (this.controls = new OrbitControls(this.camera, this.renderer.domElement));
      c.enableDamping = true;
      c.dampingFactor = 0.08;
      c.enablePan = false;
      c.rotateSpeed = 0.6;
      c.zoomSpeed = 0.6;
      c.minPolarAngle = (90 - HERO.orbit.maxEl) * D2R;
      c.maxPolarAngle = (90 - HERO.orbit.minEl) * D2R;
      c.enabled = false;
      c.addEventListener('start', () => { this.interacting = true; this.lastInteract = performance.now(); this.onInteract?.(); this.onNeedFrame?.(); });
      c.addEventListener('end', () => { this.interacting = false; this.lastInteract = performance.now(); });
      c.addEventListener('change', () => this.onNeedFrame?.());
    }
    this._fits.clear();
  }

  // Unique vertex positions on a 2 cm grid — the silhouette the fit has to contain.
  _buildFitPoints(arrays) {
    const seen = new Set();
    const out = [];
    for (const a of arrays) for (let i = 0; i < a.length; i += 3) {
      const k = Math.round(a[i] * 50) + ',' + Math.round(a[i + 1] * 50) + ',' + Math.round(a[i + 2] * 50);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a[i], a[i + 1], a[i + 2]);
    }
    this.fitPts = new Float32Array(out);
  }

  // ───────────────────────────── framing (fit-to-frame) ─────────────────────────────
  _aspect() { return this.w / this.h || 1; }

  _readFrame() {
    const fe = this.opts.frameEl;
    if (!fe) { this.frameRect = { l: 0, t: 0, r: this.w, b: this.h }; return; }
    const f = fe.getBoundingClientRect(), h = this.host.getBoundingClientRect();
    this.frameRect = { l: f.left - h.left, t: f.top - h.top, r: f.right - h.left, b: f.bottom - h.top };
  }

  /** frame rect (CSS px, host coords) minus the station padding */
  stationRect(s) {
    const fit = !s.fit || s.fit === 'bbox' ? HERO.defaultFit : { ...HERO.defaultFit, ...s.fit };
    const F = this.frameRect;
    const pad = fit.padding * Math.min(F.r - F.l, F.b - F.t);
    const pp = fit.padPx || [0, 0, 0, 0];
    return { l: F.l + pad + pp[3], t: F.t + pad + pp[0], r: F.r - pad - pp[1], b: F.b - pad - pp[2] };
  }

  /**
   * Solve the camera for a station so every model vertex below the cut lands inside
   * the station rect. Orientation (az/el) and FOV come from stations.js; the solve
   * gives the distance and a lens shift (off-axis projection) so the model is
   * composed right of the copy while the orbit pivot stays the model centre.
   *
   * fit.focus = { x:[min,max], z:[min,max] } fits that world box (floor → cut)
   * instead of the whole model, so the flat is deliberately cropped around a zone
   * (mockup 03/04). Without it the fit still contains every vertex: no cropping.
   */
  _fitStation(i) {
    if (this._fits.has(i)) return this._fits.get(i);
    const s = HERO.stations[i];
    const aspect = this._aspect();
    const tanY = s.hfov ? Math.tan((s.hfov / 2) * D2R) / aspect : Math.tan((s.fov / 2) * D2R);
    const tanX = tanY * aspect;
    const vfov = 2 * Math.atan(tanY) / D2R;
    const R = this.stationRect(s);
    const x0 = (R.l / this.w) * 2 - 1, x1 = (R.r / this.w) * 2 - 1;
    const y1 = 1 - (R.t / this.h) * 2, y0 = 1 - (R.b / this.h) * 2;

    if (!this.fitPts) {   // before the model is loaded: a sane placeholder
      const pose = { az: s.az, el: s.el, vfov, dist: 20, T: new THREE.Vector3(0, HERO.targetY, 0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
      return pose;
    }
    // camera basis (same as Object3D.lookAt with up = +y)
    const el = Math.min(89.9, s.el) * D2R, az = s.az * D2R;
    const z = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const xr = new THREE.Vector3(0, 1, 0).cross(z).normalize();
    const yu = new THREE.Vector3().crossVectors(z, xr);
    // points clamped to the cut (clipped walls end at the cut height)
    const cutY = this.floorY + s.cut;
    const focus = (s.fit && s.fit.focus) || null;
    // Focus: the 8 corners of the world box (floor → cut) are the only points that
    // must be framed. Otherwise: every model vertex, so nothing is ever cropped.
    let P, n;
    if (focus) {
      const [fx0, fx1] = focus.x, [fz0, fz1] = focus.z;
      const fy0 = this.floorY, fy1 = cutY;
      const corners = [];
      for (const cxw of [fx0, fx1]) for (const cyw of [fy0, fy1]) for (const czw of [fz0, fz1]) corners.push(cxw, cyw, czw);
      P = corners; n = 8;
    } else {
      P = this.fitPts; n = P.length / 3;
    }
    const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
    const mn = new THREE.Vector3(Infinity, Infinity, Infinity), mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let k = 0; k < n; k++) {
      const px = P[k * 3], py = Math.min(P[k * 3 + 1], cutY), pz = P[k * 3 + 2];
      mn.min({ x: px, y: py, z: pz }); mx.max({ x: px, y: py, z: pz });
    }
    const T = mn.clone().add(mx).multiplyScalar(0.5);
    for (let k = 0; k < n; k++) {
      const qx = P[k * 3] - T.x, qy = Math.min(P[k * 3 + 1], cutY) - T.y, qz = P[k * 3 + 2] - T.z;
      X[k] = qx * xr.x + qy * xr.y + qz * xr.z;
      Y[k] = qx * yu.x + qy * yu.y + qz * yu.z;
      Z[k] = qx * z.x + qy * z.y + qz * z.z;     // toward the camera
    }
    let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, dist = 1;
    for (let it = 0; it < 6; it++) {
      // smallest distance with every point inside [x0,x1]×[y0,y1] (depth = dist - Z)
      dist = 0.1;
      const ax1 = (x1 - cx) * tanX, ax0 = (cx - x0) * tanX, ay1 = (y1 - cy) * tanY, ay0 = (cy - y0) * tanY;
      for (let k = 0; k < n; k++) {
        const x = X[k], y = Y[k], zz = Z[k];
        const dx = x > 0 ? zz + x / ax1 : zz - x / ax0;
        const dy = y > 0 ? zz + y / ay1 : zz - y / ay0;
        if (dx > dist) dist = dx;
        if (dy > dist) dist = dy;
      }
      // projected extents → re-centre the lens shift on the target rect
      let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity;
      for (let k = 0; k < n; k++) {
        const d = dist - Z[k];
        const sx = cx + X[k] / (d * tanX), sy = cy + Y[k] / (d * tanY);
        if (sx < lx) lx = sx; if (sx > hx) hx = sx; if (sy < ly) ly = sy; if (sy > hy) hy = sy;
      }
      const ex = (x0 + x1) / 2 - (lx + hx) / 2, ey = (y0 + y1) / 2 - (ly + hy) / 2;
      cx = Math.min(x1 - 1e-3, Math.max(x0 + 1e-3, cx + ex));
      cy = Math.min(y1 - 1e-3, Math.max(y0 + 1e-3, cy + ey));
      if (Math.abs(ex) + Math.abs(ey) < 1e-4) break;
    }
    const pose = { az: s.az, el: s.el, vfov, dist, T, cx, cy };
    this._fits.set(i, pose);
    return pose;
  }

  _stationPose(i, p = null) {
    const s = HERO.stations[i];
    const f = this._fitStation(i);
    // materialise may be a [from, to] pair: the dissolve runs across this station's
    // own hold, so the colour arrives while the camera stands still (D7 / mockup 03→04).
    let mat = s.materialise;
    if (Array.isArray(mat)) {
      const [a, b] = s.scroll;
      const t = p == null || b <= a ? 1 : Math.min(1, Math.max(0, (p - a) / (b - a)));
      mat = lerp(mat[0], mat[1], smooth(t));
    }
    return { ...f, H: f.dist * Math.tan((f.vfov / 2) * D2R), cut: s.cut, bp: s.blueprint, mat };
  }

  /** a station's materialise value at the very end of its hold (for transitions) */
  _matEnd(i) {
    const m = HERO.stations[i].materialise;
    return Array.isArray(m) ? m[1] : m;
  }

  /** a station's materialise value at the very start of its hold */
  _matStart(i) {
    const m = HERO.stations[i].materialise;
    return Array.isArray(m) ? m[0] : m;
  }

  _poseAt(p) {
    const st = HERO.stations;
    if (this.fixedStation != null) return this._stationPose(this.fixedStation);
    if (p <= st[0].scroll[1]) return this._stationPose(0, p);
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      if (p >= s.scroll[0] && p <= s.scroll[1]) return this._stationPose(i, p);
      const n = st[i + 1];
      if (n && p > s.scroll[1] && p < n.scroll[0]) {
        const a = this._stationPose(i, s.scroll[1]), b = this._stationPose(i + 1, n.scroll[0]);
        const tl = (p - s.scroll[1]) / (n.scroll[0] - s.scroll[1]);
        const t = smooth(tl);
        const vfov = Math.exp(lerp(Math.log(a.vfov), Math.log(b.vfov), t));   // dolly-zoom: ortho → perspective
        const H = lerp(a.H, b.H, t);                                          // visible half-height at the pivot
        // Reused scratch vector: _poseAt runs every frame of every transition,
        // and a fresh Vector3 per frame is avoidable garbage.
        const T = (this._tmpT || (this._tmpT = new THREE.Vector3())).copy(a.T).lerp(b.T, t);
        return {
          az: lerp(a.az, b.az, t),
          el: lerp(a.el, b.el, t),
          vfov, H, dist: H / Math.tan((vfov / 2) * D2R),
          T,
          cx: lerp(a.cx, b.cx, t), cy: lerp(a.cy, b.cy, t),
          cut: lerp(a.cut, b.cut, t),
          bp: lerp(a.bp, b.bp, smooth(tl * 1.6)),   // plan look leaves in the first ~60 %
          mat: lerp(this._matEnd(i), this._matStart(i + 1), tl),
        };
      }
    }
    return this._stationPose(st.length - 1, p);
  }

  _placeCamera(target, az, el, dist, vfov, cx, cy) {
    el = Math.min(89.9, el);
    const a = az * D2R, e = el * D2R;
    const cam = this.camera;
    cam.position.set(
      target.x + Math.sin(a) * Math.cos(e) * dist,
      target.y + Math.sin(e) * dist,
      target.z + Math.cos(a) * Math.cos(e) * dist
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    this._setProjection(dist, vfov, cx, cy);
  }

  // Tight near/far around the model's bounding sphere (v1: near 0.05 → far 100 wasted
  // depth precision and z-fought coplanar SketchUp faces) + off-axis lens shift.
  _setProjection(dist, vfov, cx, cy) {
    const cam = this.camera, r = this.radius || 10;
    cam.fov = vfov;
    cam.aspect = this._aspect();
    cam.near = Math.max(0.05, (dist - r) * 0.9 - 0.5);
    cam.far = dist + r + 4;
    cam.updateProjectionMatrix();
    const m = cam.projectionMatrix.elements;
    m[8] = -cx; m[9] = -cy;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.updateMatrixWorld();
  }

  _applyPose(pose, dt = 0) {
    this.pose = pose;
    const target = pose.T;
    const baseDist = pose.dist;
    this.baseDist = baseDist;

    // OrbitControls own the user offset at the orbit station.
    if (this.controls && this.orbitEnabled) {
      this._placeCamera(target, pose.az + this.user.az, pose.el + this.user.el, baseDist * this.user.zoom, pose.vfov, pose.cx, pose.cy);
      const c = this.controls;
      c.minDistance = baseDist * HERO.orbit.minDistMul;
      c.maxDistance = baseDist * HERO.orbit.maxDistMul;
      c.target.copy(target);
      c.update(dt);
      const off = this.camera.position.clone().sub(target);
      const len = off.length();
      const az = Math.atan2(off.x, off.z) / D2R;
      const el = Math.asin(off.y / len) / D2R;
      this.user.az = wrapDeg(az - pose.az);
      this.user.el = el - pose.el;
      this.user.zoom = len / baseDist;
    } else if (dt) {
      // leaving the orbit station: the user's offset decays back to the scripted path
      this.user.az = damp(this.user.az, 0, 4, dt);
      this.user.el = damp(this.user.el, 0, 4, dt);
      this.user.zoom = damp(this.user.zoom, 1, 4, dt);
    }

    const nonPlan = 1 - pose.bp;
    const az = pose.az + this.user.az + this.sway.amp * HERO.orbit.idleAmpDeg * Math.sin(this.sway.phase) * nonPlan;
    const el = pose.el + this.user.el;
    this._placeCamera(target, az, el, baseDist * this.user.zoom, pose.vfov, pose.cx, pose.cy);

    // uniforms / scene state
    const U = this.U;
    U.uBlueprint.value = pose.bp;
    U.uMat.value = pose.mat;
    if (!this.lineMat) return;
    this.lineMat.opacity = pose.bp;
    this.lines.visible = pose.bp > 0.002;
    this.groundMat.opacity = 0.16 * (1 - pose.bp);
    this.ground.visible = pose.bp < 0.999;            // the plan has no ground shadow: skip the draw
    const cutY = (this.floorY || 0) + pose.cut;
    const moved = Math.abs(this.cutPlane.constant - cutY) > 1e-4;
    if (moved) {
      this.cutPlane.constant = cutY;
      for (const m of this.cutMeshes || []) m.visible = !(m.userData.minY > cutY - 0.05);
    }
    // Shadow map: never per frame. Refresh when the cut has travelled a step, and once
    // more when it settles; skipped while the ground shadow is invisible (plan).
    // The settle refresh is DEFERRED: re-rendering the 2048² map in the same frame
    // the camera stops is a ~1-frame spike exactly where the motion is supposed to
    // come to rest, so it is queued and spent on a later frame instead (see frame()).
    if (this.ground.visible) {
      const diff = this._shadowCut == null ? Infinity : Math.abs(cutY - this._shadowCut);
      if (this._shadowCut == null || diff >= Q.shadowCutStep) {
        this.renderer.shadowMap.needsUpdate = true;
        this._shadowCut = cutY;
        this._shadowPending = false;
        this.shadowUpdates = (this.shadowUpdates || 0) + 1;
      } else if (!moved && diff > 1e-4) {
        this._shadowPending = cutY;
      }
    }
  }

  /** spend a deferred shadow refresh once the scene has been still for a moment */
  _flushShadow(now) {
    if (this._shadowPending === false || this._shadowPending == null) return false;
    if (this._stillSince == null || now - this._stillSince < Q.shadowSettleMs) return true;
    this.renderer.shadowMap.needsUpdate = true;
    this._shadowCut = this._shadowPending;
    this._shadowPending = false;
    this.shadowUpdates = (this.shadowUpdates || 0) + 1;
    this.forceRender = true;
    return true;
  }

  // ───────────────────────────── per frame ─────────────────────────────
  setOrbit(on) {
    if (on === this.orbitEnabled) return;
    this.orbitEnabled = on;
    if (this.controls) this.controls.enabled = on;
    this.host.classList.toggle('orbit-on', on);
  }

  /** Idle sway on/off — the hero turns it on once it has settled at the last station. */
  setSway(on) {
    if (on === this.swayEnabled) return;
    this.swayEnabled = on;
    this.onNeedFrame?.();
  }

  /** returns true while it wants more frames */
  frame(dt, now) {
    if (!this.ready) return false;
    let busy = false;

    // Idle sway ±3°, fading in/out (never jumps). The desktop hero has no orbit
    // any more, so this is the only thing keeping the shot alive — it runs at the
    // LAST station, once the scroll has settled there, and nowhere else. The plan
    // (blueprint) must stay dead straight, which _applyPose enforces via nonPlan.
    const atRest = this.swayEnabled && !this.interacting && now - this.lastInteract > 1200 && !this.reducedMotion;
    this.sway.amp = damp(this.sway.amp, atRest ? 1 : 0, 1.2, dt);
    if (this.sway.amp > 1e-3) { this.sway.phase += (dt * 2 * Math.PI) / HERO.orbit.idlePeriodS; busy = true; }
    else this.sway.amp = 0;

    const moving = Math.abs(this.progress - (this._lastProgress ?? this.progress)) > 1e-5;
    this._lastProgress = this.progress;
    this._stillSince = moving ? null : (this._stillSince ?? now);

    const pose = this._poseAt(this.progress);
    this._applyPose(pose, dt);
    if (this._flushShadow(now)) busy = true;
    if (this.orbitEnabled) busy = true; // controls damping; cheap: we only render on change
    if (Math.abs(this.user.az) + Math.abs(this.user.el) + Math.abs(this.user.zoom - 1) > 1e-3 && !this.orbitEnabled) busy = true;

    const rendered = this._renderIfChanged();
    this._watchSpeed(rendered, now);
    return busy;
  }

  // D19 (light): if consecutive rendered frames are slow, step the pixel ratio down.
  // The step is only ever taken while the scene is STILL. Resizing the drawing
  // buffer mid-scroll is itself a multi-frame stall, and it also changes the
  // Bayer cell size (uBlock scales with the pixel ratio) — doing that during the
  // dissolve makes the materialisation visibly change texture halfway through,
  // differently on every visit depending on when the tier happened to trip.
  _watchSpeed(rendered, now) {
    if (!this.opts.adaptive) return;
    if (rendered && this._lastRenderAt && now - this._lastRenderAt < 250) this._slow.push(now - this._lastRenderAt);
    if (rendered) this._lastRenderAt = now;
    if (this._slow.length < 24) return;
    const med = [...this._slow].sort((a, b) => a - b)[this._slow.length >> 1];
    this._slow.length = 0;
    const still = this._stillSince != null && now - this._stillSince > Q.shadowSettleMs;
    if (med > Q.slowFrameMs && this.qScale > Q.minScale && now - this._lastStep > 1500) {
      if (!still) { this._slowPending = true; return; }
      this.qScale = Math.max(Q.minScale, this.qScale * Q.stepDown);
      this._lastStep = now;
      this._slowPending = false;
      this._resize(true);
      console.info('[hero] slow frames (median %d ms) → pixel ratio %s', Math.round(med), this.renderer.getPixelRatio().toFixed(2));
    }
  }

  _renderIfChanged() {
    const c = this.camera, U = this.U, p = c.position, q = c.quaternion, e = c.projectionMatrix.elements;
    // Numeric signature, compared field by field — the old version built a
    // 17-element toFixed(5) string every single frame, which is pure garbage for
    // the collector to sweep. GC pauses are exactly the kind of hitch that lands
    // in a different place on every run.
    const s = this._sig || (this._sig = new Float64Array(17));
    const v = this._sigTmp || (this._sigTmp = new Float64Array(17));
    v[0] = p.x; v[1] = p.y; v[2] = p.z;
    v[3] = q.x; v[4] = q.y; v[5] = q.z; v[6] = q.w;
    v[7] = c.fov; v[8] = e[8]; v[9] = e[9];
    v[10] = U.uMat.value; v[11] = U.uBlueprint.value; v[12] = U.uDither.value;
    v[13] = this.cutPlane.constant; v[14] = this.w; v[15] = this.h; v[16] = this.pr;
    let same = !this.forceRender;
    if (same) for (let i = 0; i < 17; i++) if (Math.abs(s[i] - v[i]) > 1e-6) { same = false; break; }
    if (same) return false;
    s.set(v);
    this.forceRender = false;
    this.renderer.render(this.scene, c);
    this.frames = (this.frames || 0) + 1;
    return true;
  }

  render() { this.forceRender = true; this._applyPose(this._poseAt(this.progress)); this._renderIfChanged(); }

  _resize(force = false) {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    const prevFrame = JSON.stringify(this.frameRect);
    this.w = w; this.h = h;
    this._readFrame();
    const frameChanged = JSON.stringify(this.frameRect) !== prevFrame;
    // pixel budget: ≤2× DPR, ≤ maxPixels device pixels, × adaptive scale
    let pr = Math.min(window.devicePixelRatio || 1, 2);
    pr = Math.min(pr, Math.sqrt(Q.maxPixels / (w * h)));
    pr = Math.max(0.5, pr * this.qScale);
    const sizeChanged = w !== this._cw || h !== this._ch || pr !== this.pr;
    if (sizeChanged || force) {
      this._cw = w; this._ch = h; this.pr = pr;
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(w, h, true);
      // The Bayer cell is 2 CSS px, so it must track the pixel ratio. Rounding it
      // to whole device pixels keeps the lattice aligned to gl_FragCoord: a
      // fractional cell makes the dither pattern beat against the pixel grid and
      // the dissolve crawls instead of dissolving.
      this.U.uBlock.value = Math.max(1, Math.round(HERO.materialise.blockPx * pr));
    }
    if (sizeChanged || frameChanged || force) {
      this._fits.clear();
      this.forceRender = true;
    }
  }

  setDither(on) { this.U.uDither.value = on ? 1 : 0; this.forceRender = true; }

  /** screen-space anchors (CSS px in host) for the plan dimension overlay */
  planAnchors() {
    if (!this.box) return null;
    const b = this.box, y = this.floorY;
    const pts = [
      new THREE.Vector3(b.min.x, y, b.min.z),
      new THREE.Vector3(b.min.x, y, b.max.z),
      new THREE.Vector3(b.max.x, y, b.min.z),
    ].map((v) => { v.project(this.camera); return { x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h }; });
    return { a: pts[0], b: pts[1], c: pts[2], lenAB: this.size.z, lenAC: this.size.x, bp: this.U.uBlueprint.value };
  }

  dispose() {
    this.ro.disconnect();
    this._roCancel?.();
    this.controls?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
