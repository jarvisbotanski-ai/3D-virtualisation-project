// Mobile hero, direction B — "the flat is the page".
//
// No GLB and no meshes on phones: one full-screen shader ray-marches a baked height
// field (public/flat/geo.png), so walls and furniture get real depth, parallax and
// shadows while the phone downloads ~180 kB of images.
//
// Scroll story: upright plan with dimensions → camera tilts into a maquette view →
// a section line sweeps down the flat; behind it walls rise out of the paper and the
// materials dither in from the floor up; each room gets its name + m² → pull back to
// the finished flat + CTA.
//
// The maps are baked from the same model by reference/mobile-flat/:
//   render.html → proto/build-maps.mjs → proto/bake.mjs → copy proto/maps/{geo.png,
//   light.webp,color.webp,plan.webp} to public/flat/ and update MAP/ROOMS below
//   from proto/maps/info.json + rooms.json.
//
// Debug: ?hud=1 (fps / DPR / steps)   ?dpr=N (force pixel ratio)   ?p=0..1 (freeze progress)

// proto/maps/info.json
const MAP = { W: 912, H: 1886, ppm: 128, margin: 0.6, size: [5.927, 2.756, 13.537] };
// proto/maps/rooms.json (centroids in map metres, floor area from the poche)
const ROOMS = [
  { name: 'Living room', area: 13.3, cx: 3.79, cz: 2.78 },
  { name: 'Kitchen · dining', area: 25.1, cx: 3.83, cz: 7.36 },
  { name: 'Bathroom', area: 6.0, cx: 1.98, cz: 12.19 },
  { name: 'Bedroom', area: 9.0, cx: 4.41, cz: 12.22 },
];
// toward the sun in image space (x right, y = z down) — same as bake.mjs SUN
const SUN_IMG = [-0.85, -0.3], SUN_EL = 60 * Math.PI / 180;

const QS = new URLSearchParams(location.search);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const PPM = MAP.ppm;
const MAP_W = MAP.W / PPM, MAP_H = MAP.H / PPM;
const FX0 = MAP.margin, FX1 = MAP.margin + MAP.size[0];
const FZ0 = MAP.margin, FZ1 = MAP.margin + MAP.size[2];
const FLAT_W = MAP.size[0], FLAT_L = MAP.size[2];
const BAND = 2.4;                                    // construction zone behind the line (m)
const LINE_Z0 = FZ0 - 0.35, LINE_Z1 = FZ1 + BAND + 0.3;
const FOV = 36 * Math.PI / 180, TAN = Math.tan(FOV / 2);
const sl = Math.hypot(...SUN_IMG);
const SUN = [Math.cos(SUN_EL) * SUN_IMG[0] / sl, Math.sin(SUN_EL), Math.cos(SUN_EL) * SUN_IMG[1] / sl];
const SWEEP_PITCH = 38 * Math.PI / 180, OUTRO_PITCH = 30 * Math.PI / 180;
// scroll phases (fraction of the hero's scroll range)
const A0 = 0.05, A1 = 0.16, A2 = 0.84, A3 = 0.95;

const VS = `#version 300 es
out vec2 vNdc;
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vNdc = p * 2.0 - 1.0; gl_Position = vec4(vNdc, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vNdc;
out vec4 outColor;
uniform sampler2D uGeo, uLight, uColor, uPlan;
uniform vec3 uCamPos, uCamF, uCamR, uCamU, uSun, uBg;
uniform float uTan, uAspect, uPpm, uLineZ, uBand, uLineA, uDitherPx, uPxAngle, uFogNear, uFogFar;
uniform vec2 uMap, uSunImg, uLineX;
uniform int uMaxSteps;

const float Y_MIN = -0.16;   // the table the maquette stands on
const float Y_TOP = 1.22;
const float WALL_H = 1.2;    // = section cut height used when the maps were rendered
const float HMAX = 3.0;
const vec3 INK = vec3(0.031, 0.035, 0.047);

float buildAt(float z){ return clamp((uLineZ - z) / uBand, 0.0, 1.0); }
float riseAt(float z){ return smoothstep(0.0, 0.32, (uLineZ - z) / uBand); }

float heightAt(vec2 xz){
  vec2 uv = xz / uMap;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return Y_MIN;
  vec4 g = textureLod(uGeo, uv, 0.0);
  float furn = max(0.0, g.r * HMAX - 0.06);
  float h = max(furn, g.g * WALL_H) * riseAt(xz.y);
  return mix(Y_MIN, h, g.b);
}

float bayer8(vec2 c){
  ivec2 p = ivec2(mod(c, 8.0));
  int x = p.x, y = p.y, e = x ^ y;
  int v = ((e & 1) << 5) | ((y & 1) << 4) | ((e & 2) << 2) | ((y & 2) << 1) | ((e & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}

void main(){
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamF + vNdc.x * uTan * uAspect * uCamR + vNdc.y * uTan * uCamU);
  if (rd.y > -1e-4) { outColor = vec4(uBg, 1.0); return; }

  // march the slab between the highest possible surface and the table
  float t0 = max(0.0, (Y_TOP - ro.y) / rd.y);
  float t1 = (Y_MIN - ro.y) / rd.y;
  float texels = (t1 - t0) * length(rd.xz) * uPpm;
  int n = int(clamp(ceil(texels / 2.2), 3.0, float(uMaxSteps)));
  float dt = (t1 - t0) / float(n);
  float a = t0, b = t1;
  for (int i = 1; i <= 96; i++) {
    if (i > n) break;
    float t = t0 + dt * float(i);
    vec3 p = ro + rd * t;
    if (p.y <= heightAt(p.xz)) { b = t; break; }
    a = t;
  }
  for (int k = 0; k < 6; k++) {
    float m = 0.5 * (a + b);
    vec3 p = ro + rd * m;
    if (p.y <= heightAt(p.xz)) b = m; else a = m;
  }
  vec3 p = ro + rd * b;
  vec2 uv = p.xz / uMap;
  bool inMap = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));

  // surface orientation from the height field gradient (vertical faces = steep)
  float e = 1.0 / uPpm;
  float hx = heightAt(p.xz + vec2(e, 0.0)) - heightAt(p.xz - vec2(e, 0.0));
  float hz = heightAt(p.xz + vec2(0.0, e)) - heightAt(p.xz - vec2(0.0, e));
  vec2 grad = vec2(hx, hz) / (2.0 * e);
  float side = smoothstep(2.5, 9.0, length(grad));
  vec3 sideN = normalize(vec3(-grad.x, 0.0, -grad.y) + vec3(0.0, 1e-4, 0.0));
  vec3 nrm = normalize(mix(vec3(0.0, 1.0, 0.0), sideN, side));

  float lod = log2(max(b * uPxAngle * uPpm / max(abs(dot(rd, nrm)), 0.3), 1.0));
  vec4 g = inMap ? textureLod(uGeo, uv, 0.0) : vec4(0.0);
  float bt = buildAt(p.z), rise = riseAt(p.z);
  float sunLit = max(dot(nrm, uSun), 0.0);

  vec3 col;
  if (!inMap || (g.b < 0.5 && p.y < -0.08 && side < 0.5)) {
    // table: paper, with the maquette's soft shadow thrown away from the sun
    vec2 suv = (p.xz + uSunImg * 0.22) / uMap;
    float sh = (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) ? textureLod(uGeo, suv, 4.0).b : 0.0;
    float contact = inMap ? textureLod(uGeo, uv, 2.5).b : 0.0;
    col = uBg * (1.0 - 0.07 * sh - 0.10 * contact);
  } else {
    // build state: materials appear through a 2 px ordered dither, floor first, then up
    float hN = clamp(p.y / WALL_H, 0.0, 1.0);
    float m = smoothstep(0.30, 1.0, bt);
    float built = step(bayer8(floor(gl_FragCoord.xy / uDitherPx)), m * 1.3 - hN * 0.3);

    vec2 L = textureLod(uLight, uv, max(lod - 1.0, 0.0)).rg;
    float shadow = mix(1.0, L.r, rise), ao = mix(1.0, L.g, rise);

    if (side < 0.5) {
      // top faces
      vec3 planC = textureLod(uPlan, uv, lod).rgb;
      vec3 colC = textureLod(uColor, uv, lod).rgb;
      float wallCap = smoothstep(0.4, 0.6, g.g);
      vec3 paper = mix(planC, INK, wallCap * rise);
      paper *= 1.0 - (1.0 - shadow) * 0.16 - (1.0 - ao) * 0.35;
      vec3 mat = mix(colC, vec3(0.16, 0.15, 0.14), wallCap);
      mat *= (0.70 + 0.30 * shadow) * (0.50 + 0.50 * ao);
      col = mix(paper, mat, built);
    } else if (p.y < 0.0) {
      // slab edge of the maquette
      col = vec3(0.86, 0.85, 0.82) * (0.70 + 0.30 * sunLit);
    } else {
      // vertical faces: walls in white, furniture in its own colour, both lit by the sun
      float shade = (0.60 + 0.40 * sunLit) * (0.78 + 0.22 * hN);
      vec3 paperSide = vec3(0.985) * shade;
      bool wall = g.g > 0.3 || textureLod(uGeo, uv - sideN.xz * e * 2.5 / uMap, 0.0).g > 0.3;
      vec3 matSide = wall ? vec3(0.94, 0.925, 0.90) * shade
                          : textureLod(uColor, (p.xz - sideN.xz * e * 3.0) / uMap, lod).rgb * shade * 0.92;
      col = mix(paperSide, matSide, built);
    }

    // the section line, drawn on the surfaces it crosses
    float hw = b * uPxAngle * 0.75;
    float onLine = (1.0 - smoothstep(hw, hw * 2.0, abs(p.z - uLineZ))) * step(uLineX.x, p.x) * step(p.x, uLineX.y);
    col = mix(col, INK, onLine * uLineA * (1.0 - side));
  }

  // a little air between near and far: helps the eye read depth
  col = mix(col, uBg, smoothstep(uFogNear, uFogFar, b) * 0.35);
  outColor = vec4(col, 1.0);
}`;

const UNIFORMS = ['uGeo', 'uLight', 'uColor', 'uPlan', 'uCamPos', 'uCamF', 'uCamR', 'uCamU', 'uSun', 'uBg',
  'uTan', 'uAspect', 'uPpm', 'uLineZ', 'uBand', 'uLineA', 'uDitherPx', 'uPxAngle', 'uFogNear', 'uFogFar',
  'uMap', 'uSunImg', 'uLineX', 'uMaxSteps'];

/**
 * @param {object} el  { hero, sticky, host, dims, intro, outro, hint }
 * @param {object} o   { onFail(err) — called if WebGL setup fails or the context is lost }
 * @returns teardown()
 */
export function setupFlat(el, { onFail } = {}) {
  const FORCE_P = QS.has('p') ? clamp(+QS.get('p'), 0, 1) : null;
  const DPR_CAP = QS.has('dpr') ? +QS.get('dpr') : 1.6;

  const canvas = document.createElement('canvas');
  canvas.className = 'flat-canvas';
  el.host.appendChild(canvas);
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });

  // overlays: room labels + the running measurement at the end of the section line
  const labelsEl = document.createElement('div');
  labelsEl.className = 'flat-labels';
  labelsEl.setAttribute('aria-hidden', 'true');
  el.host.appendChild(labelsEl);
  const rooms = ROOMS.map((r) => {
    const lab = document.createElement('div');
    lab.className = 'flat-lab';
    lab.innerHTML = `<b>${r.name}</b><span>${r.area.toFixed(1)} m²</span>`;
    labelsEl.appendChild(lab);
    return { ...r, el: lab, shown: false };
  });
  const tag = document.createElement('div');
  tag.className = 'flat-tag';
  labelsEl.appendChild(tag);

  let dead = false, ready = false, U = {};
  const textures = [];
  let prog = null, vao = null;

  function fail(err) {
    if (dead) return;
    console.warn('[hero] flat mobile hero failed', err);
    onFail?.(err);
  }

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  async function texture(url, unit) {
    const blob = await fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); });
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (dead) return;
    const t = gl.createTexture();
    textures.push(t);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    bmp.close?.();
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  async function init() {
    if (!gl) throw new Error('no webgl2');
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    for (const name of UNIFORMS) U[name] = gl.getUniformLocation(prog, name);
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    await Promise.all([
      texture('/flat/geo.png', 0), texture('/flat/light.webp', 1),
      texture('/flat/color.webp', 2), texture('/flat/plan.webp', 3),
    ]);
    if (dead) return;
    gl.uniform1i(U.uGeo, 0); gl.uniform1i(U.uLight, 1); gl.uniform1i(U.uColor, 2); gl.uniform1i(U.uPlan, 3);
    gl.uniform2f(U.uMap, MAP_W, MAP_H);
    gl.uniform1f(U.uPpm, PPM);
    gl.uniform1f(U.uBand, BAND);
    gl.uniform3f(U.uSun, ...SUN);
    gl.uniform2f(U.uSunImg, SUN_IMG[0] / sl, SUN_IMG[1] / sl);
    gl.uniform3f(U.uBg, 247 / 255, 247 / 255, 247 / 255);
    gl.uniform1f(U.uTan, TAN);
    gl.uniform2f(U.uLineX, FX0 - 0.35, FX1 + 0.35);
    ready = true;
    render();
    el.host.classList.add('ready');
  }

  // ───────────── camera ─────────────
  let vw = 0, vh = 0, dpr = 1, qualityScale = 1, maxSteps = 72;
  let introTop = 0, outroBottom = 0;

  // camera = look-at a ground target from `dist`, tilted `pitch` toward the viewer (+z).
  // pitch 0 = straight down with the flat upright (screen up = -z).
  function basis(c) {
    const s = Math.sin(c.pitch), co = Math.cos(c.pitch);
    return { pos: [c.tx, c.dist * co, c.tz + c.dist * s], F: [0, -co, -s], R: [1, 0, 0], Uv: [0, s, -co] };
  }
  const distFor = (pxPerM) => vh / (2 * TAN * pxPerM);
  // screen y (px) → offset of the ground target so that point lands at that y
  const tzShift = (screenY, dist, pitch) => (1 - (2 * screenY) / vh) * dist * TAN / Math.cos(pitch);

  function introCam() {
    const top = introTop, bottom = 52;
    const s = Math.min((vh - top - bottom) / FLAT_L, (vw - 72) / FLAT_W);
    const dist = distFor(s);
    return { tx: (FX0 + FX1) / 2, tz: (FZ0 + FZ1) / 2 + tzShift(top + (vh - top - bottom) / 2, dist, 0), dist, pitch: 0 };
  }
  function sweepCam(lineZ) {
    const dist = distFor(vw / (FLAT_W + 0.9));
    // the line sits ~62 % down the screen: built rooms recede above it, the drawing
    // waits below — clamped so the screen is never half empty at the start or end
    const k = dist * TAN / Math.cos(SWEEP_PITCH);
    const tz = clamp(lineZ - 0.26 * k, FZ0 - 0.2 + 0.72 * k, FZ1 + 0.2 - 0.9 * k);
    return { tx: (FX0 + FX1) / 2, tz, dist, pitch: SWEEP_PITCH };
  }
  function outroCam() {
    const top = 32, bottom = outroBottom;
    const avail = Math.max(120, vh - top - bottom);
    const s = Math.min((avail * 0.92) / (FLAT_L * Math.cos(OUTRO_PITCH)), (vw - 48) / FLAT_W);
    const dist = distFor(s);
    return { tx: (FX0 + FX1) / 2, tz: (FZ0 + FZ1) / 2 + tzShift(top + avail / 2, dist, OUTRO_PITCH), dist, pitch: OUTRO_PITCH };
  }
  const mixCam = (a, b, t) => ({
    tx: lerp(a.tx, b.tx, t), tz: lerp(a.tz, b.tz, t), pitch: lerp(a.pitch, b.pitch, t),
    dist: Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), t)),
  });
  const lineAt = (p) => lerp(LINE_Z0, LINE_Z1, clamp((p - A1) / (A2 - A1), 0, 1));
  function camAt(p) {
    if (p <= A0) return introCam();
    if (p < A1) return mixCam(introCam(), sweepCam(LINE_Z0), ease((p - A0) / (A1 - A0)));
    if (p <= A2) return sweepCam(lineAt(p));
    if (p < A3) return mixCam(sweepCam(LINE_Z1), outroCam(), ease((p - A2) / (A3 - A2)));
    return outroCam();
  }
  function project(B, x, y, z) {
    const v = [x - B.pos[0], y - B.pos[1], z - B.pos[2]];
    const cz = v[0] * B.F[0] + v[1] * B.F[1] + v[2] * B.F[2];
    const cx = v[0] * B.R[0] + v[1] * B.R[1] + v[2] * B.R[2];
    const cy = v[0] * B.Uv[0] + v[1] * B.Uv[1] + v[2] * B.Uv[2];
    return [((cx / (cz * TAN * (vw / vh))) + 1) / 2 * vw, (1 - cy / (cz * TAN)) / 2 * vh];
  }

  // ───────────── overlays ─────────────
  const fmt = (m) => m.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  let dimsKey = '';
  function drawDims(B, alpha) {
    el.dims.style.opacity = alpha > 0.001 ? alpha : 0;
    if (alpha <= 0.001) return;
    const [lx, ty] = project(B, FX0, 0, FZ0);
    const [rx] = project(B, FX1, 0, FZ0);
    const [, by] = project(B, FX0, 0, FZ1);
    const yW = Math.round(ty - 14) + 0.5, xL = Math.round(lx - 14) + 0.5;
    const key = `${yW}|${xL}|${Math.round(rx)}|${Math.round(by)}`;
    if (key === dimsKey) return;               // geometry only changes on resize / during the tilt
    dimsKey = key;
    el.dims.innerHTML = `
      <line x1="${lx}" y1="${yW}" x2="${rx}" y2="${yW}"/><line x1="${lx}" y1="${yW - 4}" x2="${lx}" y2="${yW + 4}"/><line x1="${rx}" y1="${yW - 4}" x2="${rx}" y2="${yW + 4}"/>
      <text x="${(lx + rx) / 2}" y="${yW - 6}" text-anchor="middle">${fmt(FLAT_W)} m</text>
      <line x1="${xL}" y1="${ty}" x2="${xL}" y2="${by}"/><line x1="${xL - 4}" y1="${ty}" x2="${xL + 4}" y2="${ty}"/><line x1="${xL - 4}" y1="${by}" x2="${xL + 4}" y2="${by}"/>
      <text x="${xL - 6}" y="${(ty + by) / 2}" text-anchor="middle" transform="rotate(-90 ${xL - 6} ${(ty + by) / 2})">${fmt(FLAT_L)} m</text>`;
  }

  // ───────────── frame ─────────────
  function progress() {
    if (FORCE_P !== null) return FORCE_P;
    const r = el.hero.getBoundingClientRect();
    return clamp(-r.top / Math.max(1, r.height - vh), 0, 1);
  }
  function resize() {
    vw = el.sticky.clientWidth; vh = el.sticky.clientHeight;
    dpr = Math.min(devicePixelRatio || 1, DPR_CAP) * qualityScale;
    canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
    // the plan starts under the intro copy and the finished flat ends above the CTA
    const stTop = el.sticky.getBoundingClientRect().top;
    introTop = Math.min(vh * 0.42, el.intro.getBoundingClientRect().bottom - stTop + 44);
    outroBottom = Math.min(vh * 0.45, el.outro.offsetHeight + 40);
    dimsKey = '';
  }

  let lastP = -1;
  function render() {
    const p = progress();
    const c = camAt(p), B = basis(c);
    const lineZ = lineAt(p);
    lastP = p;

    if (ready) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform3f(U.uCamPos, ...B.pos); gl.uniform3f(U.uCamF, ...B.F);
      gl.uniform3f(U.uCamR, ...B.R); gl.uniform3f(U.uCamU, ...B.Uv);
      gl.uniform1f(U.uAspect, vw / vh);
      gl.uniform1f(U.uLineZ, lineZ);
      gl.uniform1f(U.uLineA, sstep(A0 + 0.04, A1, p) * (1 - sstep(A2 - 0.02, A2 + 0.03, p)));
      gl.uniform1f(U.uDitherPx, Math.max(1, Math.round(2 * dpr)));
      gl.uniform1f(U.uPxAngle, (2 * TAN) / canvas.height);
      gl.uniform1f(U.uFogNear, c.dist * 1.0); gl.uniform1f(U.uFogFar, c.dist * 1.9);
      gl.uniform1i(U.uMaxSteps, maxSteps);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // intro copy out, outro copy + CTA in
    const out = sstep(0.0, A0 + 0.04, p);
    el.intro.style.opacity = 1 - out;
    el.intro.style.translate = `0 ${-24 * out}px`;   // `translate`, not `transform`: the mobile CSS pins transform
    el.intro.style.visibility = out > 0.999 ? 'hidden' : '';
    el.hint.style.opacity = 1 - sstep(0, 0.02, p);
    const ctaIn = sstep(A3 - 0.03, A3 + 0.03, p);
    el.outro.style.opacity = ctaIn;
    el.outro.style.translate = `0 ${12 * (1 - ctaIn)}px`;
    el.outro.style.visibility = ctaIn < 0.001 ? 'hidden' : 'visible';   // CSS starts it hidden
    el.outro.style.pointerEvents = ctaIn > 0.5 ? 'auto' : 'none';
    drawDims(B, ready ? 1 - sstep(A0 * 0.4, A0 + 0.02, p) : 0);

    // room labels: appear once their room has been built
    for (const r of rooms) {
      const a = ready ? sstep(0.55, 0.9, (lineZ - r.cz) / BAND) : 0;
      if (a <= 0.001) { if (r.shown) { r.el.style.opacity = 0; r.shown = false; } continue; }
      const [x, y] = project(B, r.cx, 1.35, r.cz);
      r.el.style.opacity = a;
      r.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) translateY(${8 * (1 - a)}px)`;
      r.shown = true;
    }
    const tagA = ready ? sstep(A1 - 0.02, A1 + 0.02, p) * (1 - sstep(A2 - 0.04, A2, p)) : 0;
    if (tagA > 0.001) {
      const [x, y] = project(B, FX1 + 0.42, 0, lineZ);
      tag.style.opacity = tagA;
      tag.textContent = `${clamp(lineZ - FZ0, 0, FLAT_L).toFixed(1)} m`;
      tag.style.transform = `translate(${Math.min(x, vw - 34)}px, ${y}px) translate(-100%, -120%)`;
    } else tag.style.opacity = 0;
  }

  // ───────────── scheduling + adaptive quality ─────────────
  // Renders only on scroll/resize (a still page costs nothing). If back-to-back scroll
  // frames keep missing ~45 fps, step resolution + march steps down once.
  let queued = 0, lastT = 0, slow = 0, frames = 0, fpsAcc = 0;
  const hud = QS.has('hud') ? document.createElement('div') : null;
  if (hud) { hud.className = 'flat-hud'; document.body.appendChild(hud); }
  function frame(t) {
    queued = 0;
    if (dead) return;
    const gap = lastT ? t - lastT : 0;
    lastT = t;
    render();
    if (gap > 0 && gap < 120) {
      frames++; fpsAcc += gap;
      slow = gap > 24 ? slow + 1 : Math.max(0, slow - 1);
      if (slow > 24 && qualityScale > 0.7) { qualityScale = 0.7; maxSteps = 48; slow = 0; resize(); }
    }
    if (hud && frames) {
      hud.textContent = `fps ${(1000 / (fpsAcc / frames)).toFixed(0)}\ndpr ${dpr.toFixed(2)}  ${canvas.width}×${canvas.height}\nsteps ${maxSteps}\np ${lastP.toFixed(3)}`;
      if (frames > 30) { frames = 0; fpsAcc = 0; }
    }
  }
  const request = () => { if (!queued) queued = requestAnimationFrame(frame); };
  const onResize = () => { resize(); request(); };
  const onLost = (e) => { e.preventDefault(); fail(new Error('webgl context lost')); };
  // the copy height (and with it the framing) changes once the web font arrives
  const ro = new ResizeObserver(onResize);
  ro.observe(el.sticky);
  ro.observe(el.intro);
  addEventListener('scroll', request, { passive: true });
  addEventListener('resize', onResize);
  canvas.addEventListener('webglcontextlost', onLost);
  resize();
  request();
  init().catch(fail);

  return () => {
    dead = true;
    if (queued) cancelAnimationFrame(queued);
    ro.disconnect();
    removeEventListener('scroll', request);
    removeEventListener('resize', onResize);
    canvas.removeEventListener('webglcontextlost', onLost);
    if (gl && !gl.isContextLost()) {
      textures.forEach((t) => gl.deleteTexture(t));
      if (prog) gl.deleteProgram(prog);
      if (vao) gl.deleteVertexArray(vao);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    canvas.remove(); labelsEl.remove(); hud?.remove();
    el.host.classList.remove('ready');
    el.dims.innerHTML = ''; el.dims.style.opacity = '';
    for (const k of [el.intro, el.outro, el.hint]) {
      k.style.opacity = ''; k.style.translate = ''; k.style.visibility = ''; k.style.pointerEvents = '';
    }
  };
}
