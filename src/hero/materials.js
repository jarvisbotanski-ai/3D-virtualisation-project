// Patches the real GLB materials so ONE material per mesh can be:
//   blueprint (ink on paper)  →  clay #c9c2b6  →  textured
// driven by shared uniforms. No material swaps at runtime, so no shader
// recompiles mid-scroll.
//
// Materialisation = ordered Bayer dither, 2 CSS px blocks anchored to
// gl_FragCoord (never UV, or it crawls), progress from the floor upward:
//   mix(clay, texture, step(bayer8(gl_FragCoord / block), progress - heightBias))
import * as THREE from 'three';

export function createSharedUniforms(colors) {
  return {
    uMat: { value: 0 },          // materialisation progress 0..1
    uBlueprint: { value: 1 },    // 0..1 plan look
    uDither: { value: 1 },       // 1 = Bayer dissolve, 0 = plain crossfade (Tweaks)
    uBlock: { value: 2 },        // Bayer cell size in device px
    uFloorY: { value: 0 },
    uSpread: { value: 0.7 },
    uHRange: { value: 1.8 },
    uClay: { value: new THREE.Color(colors.clay) },
    uPaper: { value: new THREE.Color(colors.paper) },
    uInk: { value: new THREE.Color(colors.ink) },
    uPlanTop: { value: new THREE.Color(colors.planTop) },
  };
}

const VERT_DECL = /* glsl */ `
varying float vBpY;
`;
const VERT_BODY = /* glsl */ `
{
  vec4 bpW = modelMatrix * vec4( transformed, 1.0 );
  vBpY = bpW.y;
}
`;

const FRAG_DECL = /* glsl */ `
varying float vBpY;
uniform float uMat, uBlueprint, uDither, uBlock, uFloorY, uSpread, uHRange;
uniform vec3 uClay, uPaper, uInk, uPlanTop;

// 8x8 ordered Bayer threshold, (0,1). Same construction as the kachingappz field.
float bayer8( vec2 cell ) {
  ivec2 p = ivec2( mod( cell, 8.0 ) );
  int v = 0;
  for ( int i = 0; i < 3; i++ ) {
    int x = ( p.x >> i ) & 1, y = ( p.y >> i ) & 1;
    v |= ( ( x ^ y ) << ( 5 - 2 * i ) ) | ( y << ( 4 - 2 * i ) );
  }
  return ( float( v ) + 0.5 ) / 64.0;
}
`;

// After map/color: diffuseColor holds the textured albedo.
const FRAG_MIX = /* glsl */ `
float bpH = clamp( ( vBpY - uFloorY ) / uHRange, 0.0, 1.0 );
float bpLocal = uMat * ( 1.0 + uSpread ) - uSpread * bpH;      // floor first, then upward
float bpTh = bayer8( floor( gl_FragCoord.xy / uBlock ) );
float bpM = uDither > 0.5 ? step( bpTh, bpLocal ) : clamp( uMat, 0.0, 1.0 );
if ( uMat <= 0.0 ) bpM = 0.0;
if ( uMat >= 1.0 ) bpM = 1.0;
diffuseColor.rgb = mix( uClay, diffuseColor.rgb, bpM );
`;

const FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix( 0.95, roughnessFactor, bpM );
`;

// Plan look (from reference/harness/shots.html): paper on up-facing faces darkening
// with height so furniture reads as footprints. The harness also painted faces seen
// "from behind" in ink; with SketchUp's coincident back-face duplicates that rule
// depends on draw order (whole bed went black after merging), so the approved
// line-only plan is reproduced with paper fills + ink edge lines instead.
const FRAG_PLAN = /* glsl */ `
if ( uBlueprint > 0.0 ) {
  float hh = clamp( ( vBpY - uFloorY ) / 1.2, 0.0, 1.0 );
  vec3 plan = mix( uPaper, uPlanTop, hh * 0.9 );
  outgoingLight = uBlueprint >= 0.999 ? plan : mix( outgoingLight, plan, uBlueprint );
}
`;

export function patchMaterial(src, U, opts = {}) {
  // Keep the GLB's own map/colour/roughness; normalise the rest.
  const m = new THREE.MeshStandardMaterial({
    map: src.map || null,
    color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1),
    roughness: src.roughness ?? 0.8,
    metalness: 0,
    // v2: honour the GLB's doubleSided flag. SketchUp exports every face twice (front
    // material + back material, opposite winding, same plane); with DoubleSide both
    // rasterise at the same depth and the draw order decides → z-fighting / wrong
    // material showing through. tools/build-assets.mjs repairs the normals so winding
    // is trustworthy; FrontSide then shows exactly the face SketchUp meant.
    side: src.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide,
    polygonOffset: true,         // keeps the plan's ink edges on top of faces
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  if (opts.offset) { m.polygonOffsetFactor += opts.offset; m.polygonOffsetUnits += opts.offset * 2; }
  m.name = src.name;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_MIX)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + FRAG_ROUGH)
      .replace('#include <opaque_fragment>', FRAG_PLAN + '\n#include <opaque_fragment>');
  };
  m.customProgramCacheKey = () => 'apt-materialise-v2';
  return m;
}
