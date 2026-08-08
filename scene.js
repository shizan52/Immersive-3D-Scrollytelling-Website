/**
 * The 3D hero scene — everything three.js touches.
 *
 * This is the lazy-loaded half of the site: app.js never imports it, hero.js pulls it in
 * with a dynamic import() only once the hero is near the viewport AND the page has gone
 * idle, so a visitor who never scrolls (or whose device declined the 3D) pays nothing.
 *
 * Contents, in order:
 *   1. MATERIALS / THEMES   day & night definitions, keyed by glTF material name
 *   2. TIERS / detectTier / QualityGovernor   adaptive quality
 *   3. CameraPath / Damped  scroll -> camera
 *   4. Backdrop             the sky, drawn in-scene
 *   5. Petals               GPU-instanced blossom
 *   6. RenderLoop / Stage   the renderer and its single frame loop
 */
import {
  ACESFilmicToneMapping, AmbientLight, BufferAttribute, BufferGeometry, CatmullRomCurve3,
  Color, DirectionalLight, DoubleSide, FogExp2, HemisphereLight, InstancedBufferAttribute,
  InstancedBufferGeometry, Mesh, PerspectiveCamera, PlaneGeometry, Scene, ShaderMaterial,
  Sphere, SRGBColorSpace, UniformsLib, UniformsUtils, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// ═════════════════════════════════════════════════════ 1. materials & themes
//
// There is exactly ONE geometry. Day and night differ only in material properties,
// lighting, fog and tone mapping — so the browser downloads a single GLB and the theme
// toggle is a few dozen property writes instead of a second multi-megabyte fetch.
//
// The keys below are glTF material NAMES. build.mjs asserts that the exported GLB carries
// exactly these names, so a rename in Blender fails the build instead of silently
// dropping a surface out of the theme system.

/** Opaque surface that only changes colour between themes. */
const surface = (night, day) => ({
  night: { color: night, emissiveIntensity: 0 },
  day: { color: day, emissiveIntensity: 0 },
});

/** Light source that glows at night and is inert by day. */
const glow = (nightIntensity, dayIntensity) => ({
  night: { emissiveIntensity: nightIntensity },
  day: { emissiveIntensity: dayIntensity },
});

export const MATERIALS = {
  // ---- architecture -------------------------------------------------------
  Wall_Concrete: surface('#23262d', '#8f9298'),
  Wall_Tile: surface('#282420', '#9a9184'),
  Wall_Brick: surface('#2a1c17', '#9c6350'),
  Wall_Plaster: surface('#2e2b26', '#b3ab98'),
  Wall_Dark: surface('#1b1e25', '#70737b'),
  Sidewalk_Concrete: surface('#33363d', '#9498a0'),
  Curb_Concrete: surface('#3a3e46', '#a4a8b0'),
  Ground_Far: surface('#0e1016', '#3c424a'),
  RoadPaint: surface('#57534a', '#cfcabb'),
  Skyline_Dark: surface('#0d1018', '#7d8794'),
  Sign_PanelDark: surface('#15181f', '#5f646d'),
  Metal_Dark: surface('#1a1d23', '#6b6f77'),
  AC_Metal: surface('#2b2f36', '#8d9199'),
  Vent_Metal: surface('#262a31', '#868a92'),
  Bin_Metal: surface('#22262c', '#7b7f87'),
  Pipe_PVC: surface('#2c2e33', '#9a9ca1'),
  Pole_Wood: surface('#241d16', '#8a6f52'),
  Wire_Blk: surface('#0f1116', '#3b3f46'),
  Tank_Blue: surface('#1a2733', '#5f83a3'),
  Tire: surface('#111317', '#3a3d42'),
  Pot_Terra: surface('#3a241a', '#b46a4a'),
  Torii_Black: surface('#14100f', '#42383a'),
  Torii_Vermillion: surface('#8f2417', '#d9482f'),
  Torii_Gold: surface('#8a6a2a', '#d8ae53'),
  VM_Body: surface('#1d2128', '#6e737b'),
  VM_Body2: surface('#20242b', '#767a82'),

  // ---- fabric / foliage ---------------------------------------------------
  Fab_Navy: surface('#161c2b', '#3f4d6b'),
  Fab_Green: surface('#16241c', '#3f6b52'),
  Fab_Red: surface('#2a1114', '#8f3540'),
  Fab_Cream: surface('#2c2925', '#cfc3ac'),
  Foliage_Green: surface('#131d16', '#3f6b48'),
  Sakura_Bark: surface('#241a13', '#4a3626'),

  // ---- cherry blossom -----------------------------------------------------
  // Faint self-glow at night so the canopy reads against a dark sky; fully lit by day.
  Blossom_Pink: {
    night: { color: '#e7b3c2', emissive: '#7a4a58', emissiveIntensity: 0.35 },
    day: { color: '#f4c9d5', emissive: '#000000', emissiveIntensity: 0 },
  },
  Blossom_White: {
    night: { color: '#efd0d8', emissive: '#6a5158', emissiveIntensity: 0.3 },
    day: { color: '#f6dbe1', emissive: '#000000', emissiveIntensity: 0 },
  },
  Blossom_Deep: {
    night: { color: '#e19bb0', emissive: '#7a3e50', emissiveIntensity: 0.4 },
    day: { color: '#efb9c8', emissive: '#000000', emissiveIntensity: 0 },
  },

  // ---- road (wet at night, dry by day) ------------------------------------
  Asphalt_Wet: {
    night: { color: '#0b0d12', roughness: 0.42, metalness: 0.1 },
    day: { color: '#565760', roughness: 0.62, metalness: 0 },
  },
  Puddle: {
    night: { color: '#0c0e15', roughness: 0.07, metalness: 0.25 },
    day: { color: '#5a5b62', roughness: 0.5, metalness: 0 },
  },

  // ---- emissive: windows, shopfronts, neon, lanterns ----------------------
  Win_Dark: { night: { color: '#12151d' }, day: { color: '#39414d', roughness: 0.1 } },
  Win_Warm: glow(1.6, 0),
  Win_Warm2: glow(1.9, 0),
  Win_Cool: glow(1.3, 0),
  Win_TV: glow(2.0, 0),
  Shop_Warm: glow(1.9, 0),
  Shop_Cool: glow(1.8, 0),
  Shop_Red: glow(2.0, 0),
  Skyline_Win: glow(0.9, 0),
  Neon_cyan: glow(3.6, 0.1),
  Neon_blue: glow(3.6, 0.1),
  Neon_gold: glow(3.6, 0.1),
  Neon_green: glow(3.6, 0.1),
  Neon_red: glow(3.6, 0.1),
  Neon_warm: glow(3.6, 0.1),
  Neon_pink: glow(3.6, 0.1),
  Neon_purple: glow(3.6, 0.1),
  Lantern_Red: glow(2.0, 0.5),
  Lantern_Warm: glow(2.0, 0.5),
  Lamp_Glass: glow(2.4, 0.2),
  VM_Face: glow(1.6, 0.3),
  VM_Face2: glow(1.5, 0.3),
  Torii_PlaqueText: glow(2.2, 0.6),
  'Moon.001': glow(2.0, 0),
};

/** Scene-wide render settings per theme. */
export const THEMES = {
  night: {
    exposure: 0.95,
    bloom: { strength: 0.55, threshold: 0.62, radius: 0.55 },
    fog: { color: '#0a0e1a', density: 0.016 },
    ambient: { color: '#2a3242', intensity: 0.6 },
    hemisphere: { sky: '#2a3550', ground: '#0a0c12', intensity: 0.3 },
    directional: { color: '#9fb4dc', intensity: 0.28, position: [-6, 12, -4] },
    petal: { color: '#f0bccb', emissive: 0.45 },
    sky: { top: '#05060d', mid: '#0b1024', bottom: '#1b1330', stars: 1 },
    moonVisible: true,
  },
  day: {
    exposure: 1.0,
    bloom: { strength: 0.1, threshold: 0.8, radius: 0.5 },
    fog: { color: '#d7e6f3', density: 0.009 },
    ambient: { color: '#a6bad0', intensity: 0.75 },
    hemisphere: { sky: '#c2daf5', ground: '#75705f', intensity: 1.35 },
    directional: { color: '#fff2e0', intensity: 2.1, position: [6, 12, 5] },
    petal: { color: '#f7d3dd', emissive: 0 },
    sky: { top: '#7fb0e6', mid: '#a9cdee', bottom: '#dfeaf3', stars: 0 },
    moonVisible: false,
  },
};

// ═══════════════════════════════════════════════════════════ 2. quality tiers
//
// The site is served from a home server to unknown hardware, so a fixed quality setting
// is a guess that is wrong for most visitors. Instead: pick a starting tier from a cheap
// device probe, then measure real frame times and step up or down to hold 60 FPS.
//
// Measured on an Intel UHD 630 at 1444x844: minimal 54 fps, low 53, medium 46, high 42.
// Bloom is by far the most expensive item here — turning it off at the top tier recovers
// 12 fps on that machine.

export const TIERS = [
  { name: 'minimal', dpr: 1.0, bloom: false, bloomScale: 0.0, petals: 40, antialias: false },
  { name: 'low', dpr: 1.25, bloom: false, bloomScale: 0.0, petals: 90, antialias: false },
  { name: 'medium', dpr: 1.5, bloom: true, bloomScale: 0.5, petals: 150, antialias: false },
  { name: 'high', dpr: 2.0, bloom: true, bloomScale: 0.75, petals: 240, antialias: true },
];

/**
 * Guess a starting tier before a single frame has been drawn. Deliberately conservative:
 * starting too low and being promoted after ~3 seconds is invisible, whereas starting too
 * high means the first impression of the site is a stutter.
 */
export function detectTier() {
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const smallScreen = Math.min(innerWidth, innerHeight) < 700;
  const pixels = innerWidth * innerHeight * Math.min(devicePixelRatio, 2);

  let score = 0;
  if (mem >= 8) score += 2; else if (mem >= 4) score += 1;
  if (cores >= 8) score += 2; else if (cores >= 4) score += 1;
  if (!coarse) score += 1;
  if (!smallScreen) score += 1;
  // A phone pushing a 3x retina panel has to fill more pixels than a desktop at 1080p.
  if (pixels > 4.0e6) score -= 1;

  if (score >= 5) return 3;
  if (score >= 3) return 2;
  if (score >= 1) return 1;
  return 0;
}

/**
 * Rolling frame-time governor.
 *
 * Uses a median rather than a mean so a single GC pause or a tab switch cannot drag the
 * tier down, and requires a sustained run of bad (or good) frames before acting, with a
 * cooldown after every change. Without that hysteresis the tier oscillates: dropping
 * quality raises FPS, which immediately argues for raising quality again.
 */
class QualityGovernor {
  #samples = new Float32Array(60);
  #n = 0;
  #bad = 0;
  #good = 0;
  #cooldown = 0;
  #ceiling;

  constructor(tier, onChange) {
    this.tier = tier;
    this.onChange = onChange;
    // Never promote above where the device probe started us; being promoted into a
    // stutter is worse than staying slightly conservative.
    this.#ceiling = tier;
  }

  /** @param {number} dt seconds since the previous frame */
  sample(dt) {
    if (this.#cooldown > 0) { this.#cooldown--; return; }
    // Ignore absurd deltas — a backgrounded tab or a blocking asset decode is not a
    // statement about rendering cost.
    if (dt > 0.5) return;

    this.#samples[this.#n++ % this.#samples.length] = dt * 1000;
    if (this.#n < this.#samples.length) return;

    const sorted = Array.from(this.#samples).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];

    if (median > 20.0) { this.#bad++; this.#good = 0; }        // below ~50 FPS
    else if (median < 13.0) { this.#good++; this.#bad = 0; }   // comfortably above 60
    else { this.#bad = 0; this.#good = 0; }

    if (this.#bad >= 3 && this.tier > 0) this.#apply(this.tier - 1);
    else if (this.#good >= 8 && this.tier < this.#ceiling) this.#apply(this.tier + 1);
  }

  #apply(tier) {
    this.tier = tier;
    this.#bad = this.#good = 0;
    this.#n = 0;
    this.#cooldown = 90; // ~1.5 s at 60 FPS for the change to settle before re-measuring
    this.onChange(tier);
  }
}

// ═══════════════════════════════════════════════════════════ 3. camera path

/**
 * Scroll progress (0..1) -> camera position and look-at target.
 *
 * assets/camera_path.json holds 25 samples baked out of the Blender camera. Interpolating
 * them linearly (as the first version did) makes the camera change direction abruptly at
 * every sample, which reads as a stutter even at a locked 60 FPS. A centripetal
 * Catmull-Rom spline through the same points is C1-continuous and costs nothing extra at
 * runtime — the curve is built once.
 */
class CameraPath {
  constructor(data) {
    const samples = [...data.samples].sort((a, b) => a.progress - b.progress);
    this.progress = samples.map(s => s.progress);
    this.positions = new CatmullRomCurve3(
      samples.map(s => new Vector3(...s.position)), false, 'centripetal', 0.5);
    this.targets = new CatmullRomCurve3(
      samples.map(s => new Vector3(...s.target)), false, 'centripetal', 0.5);

    this._pos = new Vector3();
    this._tgt = new Vector3();
  }

  /**
   * Map scroll progress onto curve parameter space.
   *
   * The baked samples are not evenly spaced in progress, so feeding progress straight
   * into getPoint(t) would speed the camera up and slow it down for no reason. Find the
   * bracketing samples and convert to the curve's uniform index space instead.
   */
  #toCurveT(p) {
    const P = this.progress;
    const last = P.length - 1;
    if (p <= P[0]) return 0;
    if (p >= P[last]) return 1;
    let i = 0;
    while (i < last && p > P[i + 1]) i++;
    const span = P[i + 1] - P[i] || 1;
    return (i + (p - P[i]) / span) / last;
  }

  apply(p, camera) {
    const t = this.#toCurveT(Math.min(1, Math.max(0, p)));
    this.positions.getPoint(t, this._pos);
    this.targets.getPoint(t, this._tgt);
    camera.position.copy(this._pos);
    camera.lookAt(this._tgt);
  }
}

/**
 * Critically-damped spring.
 *
 * Scroll events arrive at whatever rate the browser feels like, and the old code lerped
 * by a fixed 0.09 per frame — which means the camera moves twice as fast on a 120 Hz
 * display as on a 60 Hz one. This is frame-rate independent: the same wall-clock time to
 * settle regardless of how often it is stepped.
 */
class Damped {
  constructor(value = 0, halfLife = 0.12) {
    this.value = value;
    this.target = value;
    this.halfLife = halfLife;
  }

  /** @returns {boolean} true while still visibly moving */
  step(dt) {
    const d = this.target - this.value;
    if (Math.abs(d) < 1e-4) {
      const moved = this.value !== this.target;
      this.value = this.target;
      return moved;
    }
    this.value += d * (1 - Math.pow(2, -dt / this.halfLife));
    return true;
  }

  jump(v) { this.value = this.target = v; }
}

// ═══════════════════════════════════════════════════════════════ 4. backdrop
//
// The sky used to be three stacked fixed-position CSS layers (a gradient, a twinkling
// star field, and a vignette) sitting behind a transparent canvas. Measured on an Intel
// UHD 630 at 1444x844 that cost ~1.7 ms of compositing per frame — with the scene itself
// costing only ~1.8 ms. Four full-screen layers, one alpha-blended, was the difference
// between 54 and 60 FPS.
//
// Drawing it in-scene lets the canvas be opaque, so the browser composites one layer
// instead of four. The vignette stays in CSS: it has to sit *above* the 3D.
//
// Cost here: one draw call, one triangle, no depth testing.

const backdropVert = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // position already holds clip-space coordinates; z = 1 pins it to the far plane.
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

const backdropFrag = /* glsl */`
  precision highp float;
  uniform vec3  uTop;
  uniform vec3  uMid;
  uniform vec3  uBottom;
  uniform float uStars;   // 0 = none (day), 1 = full (night)
  uniform float uTime;
  uniform vec2  uResolution;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

  void main() {
    // Two-stop vertical ramp matching the CSS radial gradient this replaces.
    float t = 1.0 - vUv.y;
    vec3 col = t < 0.45
      ? mix(uTop, uMid, smoothstep(0.0, 0.45, t))
      : mix(uMid, uBottom, smoothstep(0.45, 1.0, t));

    if (uStars > 0.001) {
      // Procedural star field: quantise to a grid, keep the sparse cells, twinkle each on
      // its own phase. Cheaper than compositing two viewport-sized animated layers.
      vec2 grid = vUv * uResolution / 3.0;
      vec2 cell = floor(grid);
      float r = hash(cell);
      if (r > 0.9965) {
        vec2 f = fract(grid) - 0.5;
        float star = smoothstep(0.5, 0.0, length(f));
        float twinkle = 0.55 + 0.45 * sin(uTime * 1.7 + r * 40.0);
        // Fade towards the horizon so stars do not sit on top of the buildings.
        float altitude = smoothstep(0.15, 0.6, 1.0 - vUv.y);
        col += star * twinkle * uStars * altitude * 0.9;
      }
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

class Backdrop {
  constructor() {
    // A single oversized triangle rather than a quad: no diagonal seam, and the GPU
    // rasterises one primitive instead of two.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geometry.setAttribute('uv', new BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2));

    this.material = new ShaderMaterial({
      vertexShader: backdropVert,
      fragmentShader: backdropFrag,
      uniforms: {
        uTop: { value: new Color('#05060d') },
        uMid: { value: new Color('#0b1024') },
        uBottom: { value: new Color('#1b1330') },
        uStars: { value: 1 },
        uTime: { value: 0 },
        uResolution: { value: [1920, 1080] },
      },
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.name = 'Backdrop';
  }

  set time(t) { this.material.uniforms.uTime.value = t; }

  setSize(width, height) { this.material.uniforms.uResolution.value = [width, height]; }

  /** Interpolate between two theme skies during a crossfade. */
  lerp(from, to, k) {
    const u = this.material.uniforms;
    u.uTop.value.set(from.top).lerp(new Color(to.top), k);
    u.uMid.value.set(from.mid).lerp(new Color(to.mid), k);
    u.uBottom.value.set(from.bottom).lerp(new Color(to.bottom), k);
    u.uStars.value = from.stars + (to.stars - from.stars) * k;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ═════════════════════════════════════════════════════════════════ 5. petals
//
// The GLB used to carry 110 individual petal objects, each with its own baked
// AnimationClip: 110 nodes, 110 primitives, 111 clips and ~0.41 MB of keyframe data — for
// 220 triangles of geometry. Worse, an AnimationMixer had to interpolate 220 channels on
// the CPU every frame, and the motion looped visibly every 120 frames.
//
// Here a single InstancedBufferGeometry draws every petal in one call, and each petal's
// position and tumble are a closed-form function of uTime and a per-instance seed. The
// CPU cost per frame is one uniform write; the motion never repeats; and the petal count
// is a free variable the quality governor can turn down on weak hardware.

const MAX_PETALS = 256;

// Roughly the volume the original baked petals occupied, converted from Blender's Z-up to
// three.js Y-up (three.js Z = -Blender Y), then widened a little so petals still fill the
// frame at the wide end of the adaptive FOV.
const SPAWN = { x: 9.0, zNear: 10.0, zFar: -34.0 };
const FALL_SPAN = 9.0; // metres a petal falls before wrapping back to the top

const petalVert = /* glsl */`
  attribute vec3  aOrigin;   // spawn point inside the spawn volume
  attribute vec4  aRandom;   // x fall speed, y sway rate, z phase, w size

  uniform float uTime;
  uniform float uSpan;

  varying vec2  vUv;
  varying float vShade;

  #include <fog_pars_vertex>

  vec3 rotateX(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(p.x, c*p.y - s*p.z, s*p.y + c*p.z); }
  vec3 rotateY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c*p.x + s*p.z, p.y, -s*p.x + c*p.z); }

  void main() {
    // Fall and wrap. mod() keeps every petal inside the volume forever without any
    // respawn bookkeeping — there is no state to keep, so there is nothing to desync.
    float y = mod(aOrigin.y - uTime * aRandom.x, uSpan);

    // Two out-of-phase oscillations give the sideways drift of a real petal rather than
    // a pendulum swing.
    float sway  = sin(uTime * aRandom.y + aRandom.z);
    float sway2 = cos(uTime * aRandom.y * 0.7 + aRandom.z * 1.7);
    vec3 center = vec3(aOrigin.x + sway * 0.5, y, aOrigin.z + sway2 * 0.5);

    // Tumble about two axes at unrelated rates so petals catch the light irregularly.
    float ax = uTime * (0.6 + aRandom.y) + aRandom.z;
    float ay = uTime * (0.4 + aRandom.x) + aRandom.z * 2.0;
    vec3 local  = rotateY(rotateX(position * aRandom.w, ax), ay);
    vec3 normal = rotateY(rotateX(vec3(0.0, 0.0, 1.0), ax), ay);

    vec4 mvPosition = modelViewMatrix * vec4(center + local, 1.0);

    // Cheap stand-in for lighting: how square-on the petal faces the viewer.
    vShade = 0.55 + 0.45 * abs(normalize((modelViewMatrix * vec4(normal, 0.0)).xyz).z);
    vUv = uv;

    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const petalFrag = /* glsl */`
  uniform vec3  uColor;
  uniform float uEmissive;
  varying vec2  vUv;
  varying float vShade;

  #include <fog_pars_fragment>

  void main() {
    // Carve a petal out of the quad instead of paying for a texture: an ellipse, pinched
    // towards one end so the silhouette is not a plain disc.
    vec2 p = vUv * 2.0 - 1.0;
    float taper = 1.0 - 0.35 * (p.y * 0.5 + 0.5);
    float d = (p.x * p.x) / (taper * taper) + (p.y * p.y) / 1.0;
    if (d > 1.0) discard;

    // Soften the rim so petals do not alias into hard specks at distance.
    float edge = smoothstep(1.0, 0.75, d);

    vec3 col = uColor * vShade + uColor * uEmissive;
    gl_FragColor = vec4(col, edge);

    #include <fog_fragment>
  }
`;

class Petals {
  constructor(count = 160) {
    const quad = new PlaneGeometry(1, 1);

    const geometry = new InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.attributes.position = quad.attributes.position;
    geometry.attributes.uv = quad.attributes.uv;
    quad.dispose();

    const origin = new Float32Array(MAX_PETALS * 3);
    const random = new Float32Array(MAX_PETALS * 4);
    for (let i = 0; i < MAX_PETALS; i++) {
      origin[i * 3 + 0] = (Math.random() * 2 - 1) * SPAWN.x;
      origin[i * 3 + 1] = Math.random() * FALL_SPAN;
      origin[i * 3 + 2] = SPAWN.zFar + Math.random() * (SPAWN.zNear - SPAWN.zFar);
      random[i * 4 + 0] = 0.45 + Math.random() * 0.7;   // fall speed, m/s
      random[i * 4 + 1] = 0.5 + Math.random() * 0.9;    // sway rate
      random[i * 4 + 2] = Math.random() * Math.PI * 2;  // phase
      random[i * 4 + 3] = 0.09 + Math.random() * 0.08;  // size, m
    }
    geometry.setAttribute('aOrigin', new InstancedBufferAttribute(origin, 3));
    geometry.setAttribute('aRandom', new InstancedBufferAttribute(random, 4));
    geometry.instanceCount = Math.min(count, MAX_PETALS);

    // Everything moves in the vertex shader, so three cannot derive bounds from the
    // attributes. Give it a sphere that covers the whole spawn volume, otherwise frustum
    // culling removes the petals the moment the camera looks away from the origin.
    geometry.boundingSphere = new Sphere(
      new Vector3(0, FALL_SPAN * 0.5, (SPAWN.zNear + SPAWN.zFar) * 0.5),
      Math.hypot(SPAWN.x, FALL_SPAN, (SPAWN.zNear - SPAWN.zFar) * 0.5) + 2,
    );

    this.material = new ShaderMaterial({
      vertexShader: petalVert,
      fragmentShader: petalFrag,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uSpan: { value: FALL_SPAN },
          uColor: { value: new Color('#f0bccb') },
          uEmissive: { value: 0.45 },
        },
      ]),
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = true;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'Petals';
  }

  set time(t) { this.material.uniforms.uTime.value = t; }

  /** @param {number} n how many of the pre-allocated petals to draw */
  set count(n) {
    this.mesh.geometry.instanceCount = Math.max(0, Math.min(n | 0, MAX_PETALS));
  }

  applyTheme(theme) {
    this.material.uniforms.uColor.value.set(theme.color);
    this.material.uniforms.uEmissive.value = theme.emissive;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ══════════════════════════════════════════════════════════ 6. render & stage

const THEME_FADE = 0.7; // seconds

/**
 * The single render loop.
 *
 * The previous version re-armed requestAnimationFrame from two separate scroll listeners
 * as well as from inside the frame callback, so every scroll event spawned another
 * self-perpetuating chain that never terminated. Measured: 250 ms/frame on a fresh load,
 * 2,873 ms/frame after ordinary scrolling.
 *
 * There is exactly one way to create a chain here (start), it is idempotent, and stop
 * actually cancels it.
 */
class RenderLoop {
  #raf = 0;
  #last = 0;

  constructor(onFrame) { this.onFrame = onFrame; }

  get running() { return this.#raf !== 0; }

  start() {
    if (this.#raf) return;
    this.#last = performance.now();
    this.#raf = requestAnimationFrame(this.#tick);
  }

  stop() {
    if (!this.#raf) return;
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  #tick = (now) => {
    this.#raf = requestAnimationFrame(this.#tick);
    // Clamp: after a tab switch `now - last` can be minutes, which would teleport the
    // petals and hand the quality governor a meaningless sample.
    const dt = Math.min((now - this.#last) / 1000, 1 / 15);
    this.#last = now;
    this.onFrame(dt);
  };
}

/** Snapshot the properties a theme is allowed to animate. */
function snapshot(mat) {
  return {
    color: mat.color?.clone() ?? null,
    emissive: mat.emissive?.clone() ?? null,
    emissiveIntensity: mat.emissiveIntensity ?? 0,
    roughness: mat.roughness ?? 1,
    metalness: mat.metalness ?? 0,
  };
}

/** original state overridden by a theme spec -> a complete, interpolatable state. */
function resolve(original, spec) {
  const s = {
    color: original.color?.clone() ?? null,
    emissive: original.emissive?.clone() ?? null,
    emissiveIntensity: original.emissiveIntensity,
    roughness: original.roughness,
    metalness: original.metalness,
  };
  if (!spec) return s;
  if (spec.color && s.color) s.color.set(spec.color);
  if (spec.emissive && s.emissive) s.emissive.set(spec.emissive);
  if (spec.emissiveIntensity !== undefined) s.emissiveIntensity = spec.emissiveIntensity;
  if (spec.roughness !== undefined) s.roughness = spec.roughness;
  if (spec.metalness !== undefined) s.metalness = spec.metalness;
  return s;
}

export class Stage {
  constructor(container, { reducedMotion = false } = {}) {
    this.container = container;
    this.reducedMotion = reducedMotion;
    this.disposed = false;

    this.width = innerWidth;
    this.height = innerHeight;

    this.tierIndex = detectTier();
    const tier = TIERS[this.tierIndex];

    this.renderer = new WebGLRenderer({
      antialias: tier.antialias,
      // Opaque — the sky is drawn in-scene (section 4), so the browser composites one
      // opaque layer rather than alpha-blending four full-screen ones.
      alpha: false,
      powerPreference: 'high-performance',
      // The hero is never screenshotted or read back; letting the browser discard the
      // buffer after compositing saves a full-screen copy every frame.
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, tier.dpr));
    this.renderer.setSize(this.width, this.height);
    this.renderer.setClearColor(0x05060d, 1);
    // renderer.info resets itself on every render() call, and EffectComposer issues one
    // per pass — so reading it after composer.render() reports only the final OutputPass
    // (1 draw, 1 triangle). Take manual control and reset once per frame instead, so the
    // numbers cover the scene AND the post chain, which is what actually costs anything.
    this.renderer.info.autoReset = false;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-hidden', 'true');

    this.scene = new Scene();
    this.scene.fog = new FogExp2(0x0a0e1a, 0.016);

    this.camera = new PerspectiveCamera(46, this.width / this.height, 0.1, 400);
    this.#applyFov();

    this.ambient = new AmbientLight(0x2a3242, 0.6);
    this.hemisphere = new HemisphereLight(0x2a3550, 0x0a0c12, 0.3);
    this.directional = new DirectionalLight(0x9fb4dc, 0.28);
    this.directional.position.set(-6, 12, -4);
    this.scene.add(this.ambient, this.hemisphere, this.directional);

    this.backdrop = new Backdrop();
    this.backdrop.setSize(this.width, this.height);
    this.scene.add(this.backdrop.mesh);

    this.petals = new Petals(tier.petals);
    this.scene.add(this.petals.mesh);

    // Always composited through OutputPass so tone mapping and colour-space conversion
    // happen in exactly one place, whether or not bloom is on. UnrealBloomPass allocates
    // five mip-chain render-target pairs, so on devices that start below the medium tier
    // it is never constructed at all — and since the governor never promotes above its
    // starting tier, it will never be needed later either.
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(this.width, this.height);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = null;
    if (tier.bloom) {
      this.bloom = new UnrealBloomPass(new Vector2(this.width, this.height), 0.55, 0.55, 0.62);
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(new OutputPass());
    this.#applyTierSizes(tier);

    this.progress = new Damped(0, reducedMotion ? 0.001 : 0.13);
    this.path = null;
    this.model = null;
    this.moon = null;
    this.managed = new Map();   // material name -> { mat, original }
    this.themeName = 'night';
    this.fade = { t: 1, from: null, to: 'night' };
    this.clock = 0;
    this.needsRender = true;

    this.governor = new QualityGovernor(this.tierIndex, (t) => this.#setTier(t));
    this.loop = new RenderLoop((dt) => this.#frame(dt));

    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize, { passive: true });
  }

  // ------------------------------------------------------------------ load
  async load({ glbUrl, pathUrl, onProgress }) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

    const [pathData, gltf] = await Promise.all([
      fetch(pathUrl).then(r => r.json()),
      new Promise((res, rej) => loader.load(glbUrl, res, (e) => {
        if (e.total) onProgress?.(e.loaded / e.total);
      }, rej)),
    ]);
    if (this.disposed) return;

    this.path = new CameraPath(pathData);
    this.model = gltf.scene;

    this.model.traverse((o) => {
      if (!o.isMesh) return;
      const mat = o.material;
      if (!mat) return;
      // The GLB ships one merged mesh per material, so the name is a reliable key.
      if (MATERIALS[mat.name] && !this.managed.has(mat.name)) {
        this.managed.set(mat.name, { mat, original: snapshot(mat) });
      }
      if (mat.name === 'Moon.001') this.moon = o;
    });
    this.scene.add(this.model);

    this.applyTheme(this.themeName, { immediate: true });
    this.path.apply(0, this.camera);

    // Force shader compilation before the scene is revealed. three compiles a material
    // the first time it is actually drawn, so without this the very first frame stalls
    // for a few hundred milliseconds — exactly the moment the visitor is looking.
    this.renderer.compile(this.scene, this.camera);
    this.composer.render();

    return { materials: this.managed.size };
  }

  // ----------------------------------------------------------------- theme
  applyTheme(name, { immediate = false } = {}) {
    if (!THEMES[name]) return;
    this.fade = {
      t: immediate || this.reducedMotion ? 1 : 0,
      from: this.themeName === name ? null : this.themeName,
      to: name,
    };
    this.themeName = name;
    if (this.moon) this.moon.visible = THEMES[name].moonVisible || this.fade.t < 1;
    this.#stepTheme(0);
    this.invalidate();
  }

  #stepTheme(dt) {
    const f = this.fade;
    if (f.t >= 1 && dt > 0) return false;
    f.t = Math.min(1, f.t + (dt > 0 ? dt / THEME_FADE : 0));
    // Smoothstep so the crossfade eases in and out rather than starting abruptly.
    const k = f.t * f.t * (3 - 2 * f.t);
    const to = THEMES[f.to];
    const from = f.from ? THEMES[f.from] : to;

    for (const [name, { mat, original }] of this.managed) {
      const spec = MATERIALS[name];
      const a = resolve(original, spec[f.from] ?? spec[f.to]);
      const b = resolve(original, spec[f.to]);
      if (mat.color && a.color && b.color) mat.color.copy(a.color).lerp(b.color, k);
      if (mat.emissive && a.emissive && b.emissive) mat.emissive.copy(a.emissive).lerp(b.emissive, k);
      mat.emissiveIntensity = a.emissiveIntensity + (b.emissiveIntensity - a.emissiveIntensity) * k;
      if (mat.roughness !== undefined) mat.roughness = a.roughness + (b.roughness - a.roughness) * k;
      if (mat.metalness !== undefined) mat.metalness = a.metalness + (b.metalness - a.metalness) * k;
    }

    const mixC = (out, x, y) => out.set(x).lerp(new Color(y), k);
    const mix = (x, y) => x + (y - x) * k;

    mixC(this.scene.fog.color, from.fog.color, to.fog.color);
    this.scene.fog.density = mix(from.fog.density, to.fog.density);
    mixC(this.ambient.color, from.ambient.color, to.ambient.color);
    this.ambient.intensity = mix(from.ambient.intensity, to.ambient.intensity);
    mixC(this.hemisphere.color, from.hemisphere.sky, to.hemisphere.sky);
    mixC(this.hemisphere.groundColor, from.hemisphere.ground, to.hemisphere.ground);
    this.hemisphere.intensity = mix(from.hemisphere.intensity, to.hemisphere.intensity);
    mixC(this.directional.color, from.directional.color, to.directional.color);
    this.directional.intensity = mix(from.directional.intensity, to.directional.intensity);
    this.directional.position.set(
      mix(from.directional.position[0], to.directional.position[0]),
      mix(from.directional.position[1], to.directional.position[1]),
      mix(from.directional.position[2], to.directional.position[2]));

    this.renderer.toneMappingExposure = mix(from.exposure, to.exposure);
    if (this.bloom) {
      this.bloom.strength = mix(from.bloom.strength, to.bloom.strength);
      this.bloom.threshold = mix(from.bloom.threshold, to.bloom.threshold);
      this.bloom.radius = mix(from.bloom.radius, to.bloom.radius);
    }
    this.petals.applyTheme({
      color: to.petal.color,
      emissive: mix(from.petal.emissive, to.petal.emissive),
    });
    this.backdrop.lerp(from.sky, to.sky, k);

    if (f.t >= 1 && this.moon) this.moon.visible = to.moonVisible;
    return f.t < 1;
  }

  // --------------------------------------------------------------- quality
  #setTier(index) {
    this.tierIndex = index;
    const tier = TIERS[index];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, tier.dpr));
    this.petals.count = tier.petals;
    if (this.bloom) this.bloom.enabled = tier.bloom;
    this.resize();
  }

  #applyTierSizes(tier) {
    this.composer.setPixelRatio(Math.min(devicePixelRatio, tier.dpr));
    this.composer.setSize(this.width, this.height);
    // composer.setSize resizes every pass, so scale bloom down afterwards. Bloom is a
    // wide blur; running it at half resolution is free quality-wise and quarters its cost.
    if (this.bloom && tier.bloomScale > 0) {
      this.bloom.setSize(this.width * tier.bloomScale, this.height * tier.bloomScale);
    }
  }

  #applyFov() {
    // Frame for a constant *horizontal* field of view, so a phone in portrait sees the
    // same width of street as a widescreen desktop instead of a cropped sliver.
    const hfov = 68 * Math.PI / 180;
    const aspect = this.width / this.height;
    const v = 2 * Math.atan(Math.tan(hfov / 2) / aspect) * 180 / Math.PI;
    this.camera.fov = Math.max(34, Math.min(82, v));
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    if (this.disposed) return;
    this.width = innerWidth;
    this.height = innerHeight;
    const tier = TIERS[this.tierIndex];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, tier.dpr));
    this.renderer.setSize(this.width, this.height);
    this.#applyFov();
    this.#applyTierSizes(tier);
    this.backdrop.setSize(this.width, this.height);
    this.invalidate();
  }

  // ---------------------------------------------------------------- frame
  /** @param {number} p scroll progress 0..1 */
  setProgress(p) {
    this.progress.target = Math.min(1, Math.max(0, p));
    this.invalidate();
  }

  /** Snap the camera to a progress value without easing (debug hook, reduced motion). */
  jumpTo(p) {
    this.progress.jump(Math.min(1, Math.max(0, p)));
    this.path?.apply(this.progress.value, this.camera);
    this.invalidate();
  }

  invalidate() { this.needsRender = true; }

  #frame(dt) {
    if (this.disposed) return;
    this.clock += dt;
    this.governor.sample(dt);

    const moving = this.progress.step(dt);
    if (moving && this.path) this.path.apply(this.progress.value, this.camera);

    const fading = this.#stepTheme(dt);

    // Petals drift continuously, so whenever they are animating there is always something
    // new to draw and the loop is genuinely 60 Hz — but it only ever runs while the hero
    // is on screen (see hero.js). Under prefers-reduced-motion they hold still, and the
    // loop becomes truly on-demand: frames are drawn only when the camera, the theme or
    // the viewport actually changed.
    if (!this.reducedMotion) {
      this.petals.time = this.clock;
      this.backdrop.time = this.clock;
    }

    if (!this.reducedMotion || moving || fading || this.needsRender) {
      this.needsRender = false;
      this.renderer.info.reset();
      this.composer.render();
    }
  }

  start() { if (!this.disposed) this.loop.start(); }
  stop() { this.loop.stop(); }

  /** Render exactly one frame without starting the loop. */
  renderOnce() {
    if (this.disposed) return;
    this.#stepTheme(0);
    this.renderer.info.reset();
    this.composer.render();
  }

  get stats() {
    const info = this.renderer.info;
    return {
      tier: TIERS[this.tierIndex].name,
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      programs: info.programs?.length ?? 0,
    };
  }

  // -------------------------------------------------------------- teardown
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    removeEventListener('resize', this._onResize);

    this.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m?.dispose();
    });
    this.petals.dispose();
    this.backdrop.dispose();
    this.composer.dispose();
    this.bloom?.dispose?.();
    this.renderer.dispose();
    // Without an explicit context loss the browser can hold the WebGL context — and its
    // GPU memory — long after the canvas is detached.
    this.renderer.forceContextLoss?.();
    this.renderer.domElement.remove();
    this.managed.clear();
    this.model = null;
  }
}
