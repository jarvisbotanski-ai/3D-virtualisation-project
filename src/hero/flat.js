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
// Debug: ?hud=1 (fps, frame p95, tier, scroll jumps, viewport resizes)   ?dpr=N (force
// pixel ratio)   ?p=0..1 (freeze progress)   ?follow=N (camera follow rate, 1/s)
// ?len=N (hero length in svh; default 380 from styles.css)
// sessionStorage 'flat-tier' remembers a quality step-down; clear it to retest tier 0.

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
// smooth max/min (hyperbolic): equal to max/min far from the corner, C¹ through it
const smax = (a, b, k) => (a + b + Math.sqrt((a - b) * (a - b) + k * k)) / 2;
const smin = (a, b, k) => (a + b - Math.sqrt((a - b) * (a - b) + k * k)) / 2;
const SOFT = 1.2;   // m of camera-target travel over which the sweep camera eases in/out

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
uniform sampler2D uGeo, uLight, uColor, uPlan, uMax;
uniform vec3 uCamPos, uCamF, uCamR, uCamU, uSun, uBg;
uniform float uTan, uAspect, uPpm, uLineZ, uBand, uLineA, uDitherPx, uPxAngle, uFogNear, uFogFar;
uniform vec2 uMap, uSunImg, uLineX;
uniform vec4 uFoot;          // maquette footprint (+4 texels): x0, z0, x1, z1 in map metres
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

// conservative max height of a 16×16-texel cell and its 8 neighbours (built once from
// uGeo at load, rounded UP) — lets the march skip empty floor/table in blocks
const float CELL = 16.0;
float maxAt(vec2 xz){
  ivec2 c = clamp(ivec2(floor(xz * uPpm / CELL)), ivec2(0), textureSize(uMax, 0) - 1);
  return texelFetch(uMax, c, 0).r * (Y_TOP - Y_MIN) + Y_MIN;
}

void main(){
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamF + vNdc.x * uTan * uAspect * uCamR + vNdc.y * uTan * uCamU);
  if (rd.y > -1e-4) { outColor = vec4(uBg, 1.0); return; }

  // march the slab between the highest possible surface and the table. Same sample
  // positions as a plain fixed-step march (so the image is unchanged), but:
  //  · only the part of the ray over the maquette's footprint is marched — outside it
  //    the height is the table, so the ray simply lands at t1;
  //  · samples go in blocks of K; a whole block is skipped when its lowest point is
  //    still above the max-height cell under it (one fetch instead of K).
  float t0 = max(0.0, (Y_TOP - ro.y) / rd.y);
  float t1 = (Y_MIN - ro.y) / rd.y;
  float lxz = length(rd.xz);
  float texels = (t1 - t0) * lxz * uPpm;
  int n = int(clamp(ceil(texels / 2.2), 3.0, float(uMaxSteps)));
  float dt = (t1 - t0) / float(n);

  float ta = t0, tb = t1;
  if (abs(rd.x) > 1e-6) {
    float u = (uFoot.x - ro.x) / rd.x, w = (uFoot.z - ro.x) / rd.x;
    ta = max(ta, min(u, w)); tb = min(tb, max(u, w));
  } else if (ro.x < uFoot.x || ro.x > uFoot.z) tb = -1.0;
  if (abs(rd.z) > 1e-6) {
    float u = (uFoot.y - ro.z) / rd.z, w = (uFoot.w - ro.z) / rd.z;
    ta = max(ta, min(u, w)); tb = min(tb, max(u, w));
  } else if (ro.z < uFoot.y || ro.z > uFoot.w) tb = -1.0;

  float a = t0, b = t1;
  bool hit = false;
  if (ta < tb) {
    int i = max(1, int(floor((ta - t0) / dt)));
    int iEnd = min(n, int(ceil((tb - t0) / dt)));
    int K = int(clamp(floor((2.0 * CELL - 4.0) / max(dt * lxz * uPpm, 1e-3)), 1.0, 16.0));
    for (int blk = 0; blk < 96; blk++) {
      if (i > iEnd || hit) break;
      int j1 = min(i + K - 1, iEnd);
      float tl = t0 + dt * float(j1);
      vec3 pm = ro + rd * (t0 + dt * 0.5 * float(i - 1 + j1));
      if (ro.y + rd.y * tl > maxAt(pm.xz)) { i = j1 + 1; continue; }
      for (int j = 0; j < 16; j++) {
        int s = i + j;
        if (s > j1) break;
        float t = t0 + dt * float(s);
        vec3 p = ro + rd * t;
        if (p.y <= heightAt(p.xz)) { b = t; a = t - dt; hit = true; break; }
      }
      i = j1 + 1;
    }
  }
  if (hit) {
    for (int k = 0; k < 6; k++) {
      float m = 0.5 * (a + b);
      vec3 p = ro + rd * m;
      if (p.y <= heightAt(p.xz)) b = m; else a = m;
    }
  }
  vec3 p = ro + rd * b;
  vec2 uv = p.xz / uMap;
  bool inMap = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));

  // surface orientation from the height field gradient (vertical faces = steep).
  // Well clear of the footprint it is flat table: skip the four extra fetches.
  float e = 1.0 / uPpm;
  vec2 grad = vec2(0.0);
  if (all(greaterThan(p.xz, uFoot.xy - 3.0 * e)) && all(lessThan(p.xz, uFoot.zw + 3.0 * e))) {
    float hx = heightAt(p.xz + vec2(e, 0.0)) - heightAt(p.xz - vec2(e, 0.0));
    float hz = heightAt(p.xz + vec2(0.0, e)) - heightAt(p.xz - vec2(0.0, e));
    grad = vec2(hx, hz) / (2.0 * e);
  }
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

const UNIFORMS = ['uGeo', 'uLight', 'uColor', 'uPlan', 'uMax', 'uCamPos', 'uCamF', 'uCamR', 'uCamU', 'uSun', 'uBg',
  'uTan', 'uAspect', 'uPpm', 'uLineZ', 'uBand', 'uLineA', 'uDitherPx', 'uPxAngle', 'uFogNear', 'uFogFar',
  'uMap', 'uSunImg', 'uLineX', 'uFoot', 'uMaxSteps'];

// Quality tiers. The dither cell is 2 CSS px in every tier (uDitherPx = 2·dpr is an
// integer for each), so a step down changes edge sharpness only — never the pattern.
// It is taken once, while the page is still, and never back up.
const TIERS = [1.5, 1.0];
const MAX_CELL = 16;                                 // = CELL in the shader
const Y_MIN = -0.16, Y_TOP = 1.22, WALL_H = 1.2, HMAX = 3.0;   // = shader constants

// Conservative max-height grid for the march to skip empty space: per 16×16-texel cell,
// the highest surface in the cell and its 8 neighbours (covers bilinear reach + the
// ray's travel inside one block), quantised UP. Built from the exact texels the GPU
// samples (read back from the uploaded texture).
function buildMaxGrid(px, W, H) {
  const CW = Math.ceil(W / MAX_CELL), CH = Math.ceil(H / MAX_CELL);
  const raw = new Float32Array(CW * CH).fill(Y_MIN);
  for (let y = 0; y < H; y++) {
    const row = ((y / MAX_CELL) | 0) * CW;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const h = Math.max(0, px[i] / 255 * HMAX - 0.06, px[i + 1] / 255 * WALL_H);
      const k = row + ((x / MAX_CELL) | 0);
      if (h > raw[k]) raw[k] = h;
    }
  }
  const out = new Uint8Array(CW * CH);
  for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
    let m = Y_MIN;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = cx + dx, yy = cy + dy;
      if (xx >= 0 && yy >= 0 && xx < CW && yy < CH) m = Math.max(m, raw[yy * CW + xx]);
    }
    out[cy * CW + cx] = Math.min(255, Math.ceil((m - Y_MIN) / (Y_TOP - Y_MIN) * 255) + 2);
  }
  return { data: out, CW, CH };
}

/**
 * @param {object} el  { hero, sticky, host, dims, intro, outro, hint }
 * @param {object} o   { onFail(err) — called if WebGL setup fails or the context is lost }
 * @returns teardown()
 */
export function setupFlat(el, { onFail } = {}) {
  const FORCE_P = QS.has('p') ? clamp(+QS.get('p'), 0, 1) : null;
  const DPR_CAP = QS.has('dpr') ? +QS.get('dpr') : 0;   // ?dpr=N forces the pixel ratio (no tiers)

  // ?len=N — hero length in svh, to compare scroll lengths on a real phone
  const LEN = QS.has('len') ? clamp(+QS.get('len') || 0, 150, 1000) : 0;
  if (LEN) el.hero.style.height = `${LEN}svh`;

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
    return { t, w: bmp.width, h: bmp.height };
  }
  // max grid from the geo texture as uploaded (read back through a framebuffer, so it
  // is built from exactly the texels the shader samples — no 2D-canvas colour handling)
  function maxTexture(geo, unit) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, geo.t, 0);
    const px = new Uint8Array(geo.w * geo.h * 4);
    gl.readPixels(0, 0, geo.w, geo.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    const g = buildMaxGrid(px, geo.w, geo.h);
    const t = gl.createTexture();
    textures.push(t);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, g.CW, g.CH, 0, gl.RED, gl.UNSIGNED_BYTE, g.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
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
    const [geo] = await Promise.all([
      texture('/flat/geo.png', 0), texture('/flat/light.webp', 1),
      texture('/flat/color.webp', 2), texture('/flat/plan.webp', 3),
    ]);
    if (dead || !geo) return;
    maxTexture(geo, 4);
    gl.uniform1i(U.uGeo, 0); gl.uniform1i(U.uLight, 1); gl.uniform1i(U.uColor, 2); gl.uniform1i(U.uPlan, 3);
    gl.uniform1i(U.uMax, 4);
    const pad = 4 / PPM;   // bilinear reach + margin: beyond this the geo map is pure table
    gl.uniform4f(U.uFoot, FX0 - pad, FZ0 - pad, FX1 + pad, FZ1 + pad);
    gl.uniform2f(U.uMap, MAP_W, MAP_H);
    gl.uniform1f(U.uPpm, PPM);
    gl.uniform1f(U.uBand, BAND);
    gl.uniform3f(U.uSun, ...SUN);
    gl.uniform2f(U.uSunImg, SUN_IMG[0] / sl, SUN_IMG[1] / sl);
    gl.uniform3f(U.uBg, 247 / 255, 247 / 255, 247 / 255);
    gl.uniform1f(U.uTan, TAN);
    gl.uniform2f(U.uLineX, FX0 - 0.35, FX1 + 0.35);
    ready = true;
    dirty = true;
    request();
    el.host.classList.add('ready');
  }

  // ───────────── camera ─────────────
  let vw = 0, vh = 0, dpr = 1;
  const maxSteps = 72;
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
    // waits below — limited so the screen is never half empty at the start or end.
    // Soft limits, not a hard clamp: a hard clamp parks the camera for the first half of
    // the sweep and then starts it at full speed in one frame (a visible lurch).
    const k = dist * TAN / Math.cos(SWEEP_PITCH);
    const tz = smin(smax(lineZ - 0.26 * k, FZ0 - 0.2 + 0.72 * k, SOFT), FZ1 + 0.2 - 0.9 * k, SOFT);
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
    setStyle(el.dims, 'opacity', String(alpha > 0.001 ? alpha : 0));
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
  // Hero geometry is measured on resize only (no layout reads per frame). The camera
  // follows the scroll position through a short frame-rate-independent damper, so an
  // uneven input — 30 fps frames, a finger stopping a fling, iOS delivering a late
  // scroll position — reads as a quick glide instead of a jump.
  let heroTop = 0, heroRange = 1, heroBottom = 0;
  const FOLLOW = QS.has('follow') ? +QS.get('follow') : 16;   // 1/s — τ ≈ 60 ms
  const targetP = () => (FORCE_P !== null ? FORCE_P : clamp((scrollY - heroTop) / heroRange, 0, 1));
  let shownP = -1;

  function resize() {
    const w = el.sticky.clientWidth, h = el.sticky.clientHeight;
    const nd = QS.has('dpr') ? DPR_CAP : Math.min(devicePixelRatio || 1, TIERS[tier]);
    const cw = Math.round(w * nd), ch = Math.round(h * nd);
    vw = w; vh = h; dpr = nd;
    // iOS fires `resize` whenever the toolbar shows/hides; the sticky box is svh, so the
    // size usually did not change. Reassigning canvas.width anyway reallocates and CLEARS
    // the drawing buffer — a blank (black, alpha:false) frame on the next composite.
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const r = el.hero.getBoundingClientRect();
    heroTop = r.top + scrollY;
    heroRange = Math.max(1, r.height - vh);
    heroBottom = heroTop + r.height;
    // the plan starts under the intro copy and the finished flat ends above the CTA
    const stTop = el.sticky.getBoundingClientRect().top;
    introTop = Math.min(vh * 0.42, el.intro.getBoundingClientRect().bottom - stTop + 44);
    outroBottom = Math.min(vh * 0.45, el.outro.offsetHeight + 40);
    dimsKey = '';
    dirty = true;
  }

  // style writes only when the value changes (each write invalidates style on the main thread)
  const styleCache = new Map();
  function setStyle(node, prop, val) {
    let c = styleCache.get(node);
    if (!c) styleCache.set(node, (c = {}));
    if (c[prop] === val) return;
    c[prop] = val;
    node.style[prop] = val;
  }

  let dirty = true;
  function render(p) {
    const c = camAt(p), B = basis(c);
    const lineZ = lineAt(p);

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

    // intro copy out, outro copy + CTA in (rounded so settled values stop re-writing)
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const out = r3(sstep(0.0, A0 + 0.04, p));
    setStyle(el.intro, 'opacity', String(1 - out));
    setStyle(el.intro, 'translate', `0 ${(-24 * out).toFixed(2)}px`);   // `translate`, not `transform`: the mobile CSS pins transform
    setStyle(el.intro, 'visibility', out > 0.999 ? 'hidden' : '');
    setStyle(el.hint, 'opacity', String(r3(1 - sstep(0, 0.02, p))));
    const ctaIn = r3(sstep(A3 - 0.03, A3 + 0.03, p));
    setStyle(el.outro, 'opacity', String(ctaIn));
    setStyle(el.outro, 'translate', `0 ${(12 * (1 - ctaIn)).toFixed(2)}px`);
    setStyle(el.outro, 'visibility', ctaIn < 0.001 ? 'hidden' : 'visible');   // CSS starts it hidden
    setStyle(el.outro, 'pointerEvents', ctaIn > 0.5 ? 'auto' : 'none');
    drawDims(B, ready ? r3(1 - sstep(A0 * 0.4, A0 + 0.02, p)) : 0);

    // room labels: appear once their room has been built
    for (const r of rooms) {
      const a = ready ? r3(sstep(0.55, 0.9, (lineZ - r.cz) / BAND)) : 0;
      if (a <= 0.001) { if (r.shown) { setStyle(r.el, 'opacity', '0'); r.shown = false; } continue; }
      const [x, y] = project(B, r.cx, 1.35, r.cz);
      setStyle(r.el, 'opacity', String(a));
      setStyle(r.el, 'transform', `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) translateY(${(8 * (1 - a)).toFixed(2)}px)`);
      r.shown = true;
    }
    const tagA = ready ? r3(sstep(A1 - 0.02, A1 + 0.02, p) * (1 - sstep(A2 - 0.04, A2, p))) : 0;
    if (tagA > 0.001) {
      const [x, y] = project(B, FX1 + 0.42, 0, lineZ);
      setStyle(tag, 'opacity', String(tagA));
      const txt = `${clamp(lineZ - FZ0, 0, FLAT_L).toFixed(1)} m`;
      if (tag.textContent !== txt) tag.textContent = txt;
      setStyle(tag, 'transform', `translate(${Math.min(x, vw - 34).toFixed(1)}px, ${y.toFixed(1)}px) translate(-100%, -120%)`);
    } else setStyle(tag, 'opacity', '0');
  }

  // ───────────── scheduling + quality ─────────────
  // Frames run while scrolling and while the camera is still gliding to the scroll
  // position; a still page (or a hero scrolled out of view) costs nothing.
  // Quality: if scroll frames keep missing ~40 fps, the step down to the lower tier is
  // queued and applied only once the page has been still for 300 ms — never mid-motion
  // (a mid-scroll canvas resize is a multi-frame stall and visibly softens the image).
  // The decision is remembered for the session, so a reload starts on the right tier.
  const TIER_KEY = 'flat-tier';
  let tier = QS.has('dpr') ? 0 : clamp(+(sessionStorage.getItem(TIER_KEY) || 0), 0, TIERS.length - 1);
  let queued = 0, lastT = 0, slow = 0, downgrade = false, idleTimer = 0;
  const hud = QS.has('hud') ? document.createElement('div') : null;
  if (hud) { hud.className = 'flat-hud'; document.body.appendChild(hud); }
  // HUD diagnostics: frame times, scroll jumps between frames, viewport changes
  const diag = { gaps: [], jumps: 0, maxJump: 0, resizes: 0, lastY: scrollY };

  function frame(t) {
    queued = 0;
    if (dead) return;
    const gap = lastT ? t - lastT : 0;
    lastT = t;
    const dt = Math.min(1 / 30, gap > 0 ? gap / 1000 : 1 / 60);

    const target = targetP();
    const inView = scrollY < heroBottom && scrollY + vh > heroTop;
    if (shownP < 0 || FORCE_P !== null || !inView) shownP = target;   // jump-cut only when not visible
    else shownP += (target - shownP) * (1 - Math.exp(-FOLLOW * dt));
    if (Math.abs(target - shownP) < 2e-5) shownP = target;
    const moving = shownP !== target;

    if (inView && (moving || dirty || shownP !== lastShown)) {
      render(shownP);
      lastShown = shownP; dirty = false;
      if (gap > 0 && gap < 120) {
        slow = gap > 25 ? slow + 1 : Math.max(0, slow - 1);
        if (slow > 20 && tier < TIERS.length - 1) downgrade = true;
      }
    }
    if (hud) drawHud(gap);
    if (moving) request();
  }
  let lastShown = -1;

  function drawHud(gap) {
    const dy = scrollY - diag.lastY; diag.lastY = scrollY;
    if (Math.abs(dy) > 160) { diag.jumps++; diag.maxJump = Math.max(diag.maxJump, Math.round(Math.abs(dy))); }
    if (gap > 0 && gap < 500) { diag.gaps.push(gap); if (diag.gaps.length > 60) diag.gaps.shift(); }
    const g = [...diag.gaps].sort((a, b) => a - b);
    const avg = g.length ? g.reduce((s, x) => s + x, 0) / g.length : 0;
    const p95 = g.length ? g[Math.floor(g.length * 0.95)] : 0;
    hud.textContent = `fps ${avg ? (1000 / avg).toFixed(0) : '–'}  p95 ${p95.toFixed(0)}ms\n`
      + `tier ${tier} dpr ${dpr.toFixed(2)}  ${canvas.width}×${canvas.height}\n`
      + `p ${shownP.toFixed(3)} → ${targetP().toFixed(3)}\n`
      + `jumps>160px ${diag.jumps} (max ${diag.maxJump})\n`
      + `resizes ${diag.resizes}  ih ${innerHeight}  vv ${Math.round(visualViewport?.height || 0)}`;
  }

  const request = () => { if (!queued) queued = requestAnimationFrame(frame); };
  const onScroll = () => {
    request();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, 300);
  };
  function onIdle() {
    if (!downgrade || dead) return;
    downgrade = false; slow = 0;
    tier = Math.min(tier + 1, TIERS.length - 1);
    try { sessionStorage.setItem(TIER_KEY, String(tier)); } catch { /* private mode */ }
    resize(); request();
  }
  // Coalesce resize sources (window resize + ResizeObserver on the sticky box / intro copy)
  // into one measurement per frame.
  let resizeQueued = false;
  const onResize = () => {
    diag.resizes++;
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; if (!dead) { resize(); request(); } });
  };
  const onLost = (e) => { e.preventDefault(); fail(new Error('webgl context lost')); };
  // the copy height (and with it the framing) changes once the web font arrives
  const ro = new ResizeObserver(onResize);
  ro.observe(el.sticky);
  ro.observe(el.intro);
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onResize);
  canvas.addEventListener('webglcontextlost', onLost);
  resize();
  request();
  init().catch(fail);

  return () => {
    dead = true;
    if (queued) cancelAnimationFrame(queued);
    clearTimeout(idleTimer);
    ro.disconnect();
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', onResize);
    canvas.removeEventListener('webglcontextlost', onLost);
    if (gl && !gl.isContextLost()) {
      textures.forEach((t) => gl.deleteTexture(t));
      if (prog) gl.deleteProgram(prog);
      if (vao) gl.deleteVertexArray(vao);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    canvas.remove(); labelsEl.remove(); hud?.remove();
    if (LEN) el.hero.style.height = '';
    el.host.classList.remove('ready');
    el.dims.innerHTML = ''; el.dims.style.opacity = '';
    for (const k of [el.intro, el.outro, el.hint]) {
      k.style.opacity = ''; k.style.translate = ''; k.style.visibility = ''; k.style.pointerEvents = '';
    }
  };
}
