/**
 * The Archimedes ASCII film — the three.js scene, rendered offscreen.
 *
 * This is a port of `/home/daniel/Downloads/archimedes_cinematic_ascii_film.html`
 * (three r128, CDN) onto pinned `three@0.186.1`. Geometry, materials, the human
 * rig, the choreography and the IK maths are carried over with their numbers
 * verbatim; what changed is the API surface (ADR 0070) and the lighting (see
 * `RE-LIGHT` below). The scene is Archimedes levering a boulder: a 10.5 s loop
 * of reach-in, isometric struggle, full heave, and an earth-shattering slam.
 *
 * ## The output contract (Task 3 pinned this)
 *
 * `frame()` returns **final, post-tone-curve luminance**. The demo's vignette,
 * its `Math.pow(lum, 1.85) * vignette * 0.65` contrast curve and its `lum < 0.04`
 * crushed-black branch all live HERE, in `applyToneCurve`, because the scene owns
 * the look. `compositor.ts` re-applies nothing — `bandFor` sees a value and no
 * position, so a curve applied twice crushes everything and a curve applied
 * nowhere yields a flat, washed-out film. No jsdom test can see either failure;
 * only the rendered comparison against `/tmp/film-ref-6p5s.png` catches it.
 *
 * ## Why nothing here touches the DOM
 *
 * The app window is `"transparent": true` (`src-tauri/tauri.conf.json:16`) and a
 * composited WebGL surface inside a transparent WebKitGTK window has a documented
 * paints-nothing failure mode, so the renderer draws into a
 * `WebGLRenderTarget` that is **never appended to the document** (ADR 0070). The
 * canvas handed to `WebGLRenderer` is created here and owned by nothing else; the
 * only surface the DOM ever sees is Task 5's 2D canvas. Consequently:
 *
 *  - **No capability probing.** `renderer.capabilities` and
 *    `WEBGL_debug_renderer_info` are deliberately absent: WebKitGTK masks the
 *    renderer string and software-backed context creation reports success, so a
 *    probe answers "yes" on exactly the machines that are broken. Liveness is
 *    judged downstream by counting drawn cells.
 *  - **No drawing-buffer preservation, no raw GL pixel read-back.** The demo used
 *    both and it costs a synchronous GPU stall per frame (`GPU stall due to
 *    ReadPixels` reproduces on unmodified Chrome).
 *    `renderer.readRenderTargetPixels` is used instead, and it does not need the
 *    back buffer kept alive between frames.
 *  - **No `document`/`window` at module top level.** A module that touched the
 *    DOM while being imported would pay that cost even when the setting is `off`.
 *    The only DOM touch is one detached canvas created inside `createFilmEngine`.
 *  - **This module never probes for its own presence.** The keep-`three`-out-of-
 *    jsdom guard belongs on the *caller* side of the dynamic `import("./scene")`;
 *    by the time this file is evaluating, `three` is already parsed.
 *
 * ## Buffer ownership
 *
 * `frame()` returns the same `Float32Array` instance every call — allocated in
 * `resize()`, reused forever after. A fresh ~105 KB array per frame is precisely
 * the garbage this loop exists to avoid. The caller finishes reading before the
 * next call, so it may keep the reference only until then.
 */
import * as THREE from "three";

/** The demo's loop length; the film is periodic with this period. */
export const FILM_LOOP_SECONDS = 10.5;

/**
 * The frame the `"static"` setting shows: mid-heave, boulder near its highest,
 * body fully committed to the lever. Chosen because it reads as effort with no
 * motion to carry it — the reach-in looks like standing, the slam looks like
 * nothing at all. Matches the captured reference `/tmp/film-ref-6p5s.png`.
 */
export const FILM_HERO_TIME = 6.5;

/** The six choreography channels plus the wrapped time. */
export interface Choreography {
  /** `time` wrapped into `[0, FILM_LOOP_SECONDS)`. */
  t: number;
  /** How far the body is driving into the lever, 0–1. */
  push: number;
  /** How far the boulder has risen, 0–1. */
  lift: number;
  /** How much the wooden lever is bowed, radians-ish of deflection. */
  bend: number;
  /** Isometric strain; above 0.4 it also drives the muscle tremor. */
  strain: number;
  /** Camera/limb tremor amplitude. */
  shake: number;
  /** Impact energy, non-zero only inside the 7.6–9.0 slam window. */
  slam: number;
}

/**
 * The 10.5 s choreography, VERBATIM from the demo including the phase boundaries
 * at 1.8 / 4.6 / 7.6 / 9.0 and every easing constant.
 *
 * Pure and side-effect free, which is what makes it testable without a GL
 * context. Note the two behaviours the tests pin because they are load bearing
 * rather than incidental: `lift` is exactly 0 until 68% through the struggle
 * phase (the boulder must not drift during the reach-in), and `slam` is exactly 0
 * outside 7.6–9.0 (the debris burst and the camera shake both gate on it).
 */
export function evaluateChoreography(time: number): Choreography {
  const t = time % FILM_LOOP_SECONDS;
  let push = 0;
  let lift = 0;
  let bend = 0;
  let strain = 0;
  let shake = 0;
  let slam = 0;

  if (t < 1.8) {
    // Reaching up and pulling body weight into the high beam
    const p = t / 1.8;
    const ease = p * p * (3 - 2 * p);
    push = ease * 0.26;
    lift = 0;
    bend = ease * 0.45;
    strain = ease * 0.35;
  } else if (t < 4.6) {
    // Intense isometric struggle: muscles lock, body tremors, wood bows deeply
    const p = (t - 1.8) / 2.8;
    push = 0.26 + p * 0.36;
    lift = p > 0.68 ? Math.pow((p - 0.68) / 0.32, 2) * 0.22 : 0;
    bend = 0.45 + Math.sin(p * Math.PI * 0.85) * 0.82;
    strain = 0.65 + p * 0.55;
    shake = 0.25 + p * 0.45;
  } else if (t < 7.6) {
    // Full heave: Archimedes drives downward into a deep lunge as the boulder rises
    const p = (t - 4.6) / 3.0;
    const easeOut = 1 - Math.pow(1 - p, 3);
    push = 0.62 + easeOut * 0.38;
    lift = 0.22 + easeOut * 0.78;
    bend = 0.95 - easeOut * 0.5;
    strain = 0.85 - easeOut * 0.25;
    shake = 0.35 * (1 - p * 0.6);
  } else if (t < 9.0) {
    // Heavy release and earth-shattering drop
    const p = (t - 7.6) / 1.4;
    if (p < 0.28) {
      const f = Math.pow(p / 0.28, 2.2);
      push = 1.0 - f * 0.94;
      lift = 1.0 - f;
      bend = 0.45 * (1 - f);
    } else {
      const imp = (p - 0.28) / 0.72;
      const wave = Math.sin(imp * Math.PI * 5) * (1 - imp);
      push = 0.06 + wave * 0.06;
      lift = Math.max(0, Math.sin(imp * Math.PI * 3) * 0.06 * (1 - imp));
      bend = wave * 0.32;
      shake = (1 - imp) * 1.6;
      slam = 1 - imp;
    }
  } else {
    // Deep recovery breath before gripping again
    const p = (t - 9.0) / 1.5;
    push = Math.sin(p * Math.PI) * 0.05;
    lift = 0;
    bend = 0;
    strain = 0;
  }

  return { t, push, lift, bend, strain, shake, slam };
}

/** One bone of the two-bone chain: a pivot group, the mesh hanging from it, and its length. */
export interface LimbSegment {
  group: THREE.Group;
  mesh: THREE.Mesh;
  len: number;
}

/**
 * The demo's two-bone IK, VERBATIM in signature and maths.
 *
 * Solves in the XY plane at a fixed z, which is all a mostly-side-on figure
 * needs. Two guards are why this is safe on animated (i.e. sometimes absurd)
 * targets rather than only on hand-picked ones, and both survive the port:
 * the distance is floored at 0.05 so a collapsed chain cannot divide by zero,
 * and the law-of-cosines cosine is clamped to [-1, 1] so an out-of-reach target
 * degenerates to full extension instead of `NaN`. `len1 + len2` is therefore
 * never exceeded — a hand can go slack on the lever, it can never teleport.
 *
 * @param bendDir  which side of the root→target line the joint points to
 */
export function solveLimbIK(
  rootPos: { x: number; y: number },
  targetPos: { x: number; y: number },
  len1: number,
  len2: number,
  bendDir: 1 | -1,
  upper: LimbSegment,
  lower: LimbSegment,
  zOffset: number,
): void {
  const p0 = new THREE.Vector3(rootPos.x, rootPos.y, zOffset);
  const p2 = new THREE.Vector3(targetPos.x, targetPos.y, zOffset);

  const dx = p2.x - p0.x;
  const dy = p2.y - p0.y;
  const dist = Math.min(len1 + len2 - 0.005, Math.max(0.05, Math.hypot(dx, dy)));

  const baseAngle = Math.atan2(dy, dx);
  const cosA = THREE.MathUtils.clamp(
    (len1 * len1 + dist * dist - len2 * len2) / (2 * len1 * dist),
    -1,
    1,
  );
  const angleA = Math.acos(cosA);
  const theta1 = baseAngle + bendDir * angleA;

  const jointX = p0.x + Math.cos(theta1) * len1;
  const jointY = p0.y + Math.sin(theta1) * len1;

  upper.group.position.set(p0.x, p0.y, zOffset);
  upper.group.rotation.set(0, 0, theta1 + Math.PI / 2);

  const theta2 = Math.atan2(p2.y - jointY, p2.x - jointX);
  lower.group.position.set(jointX, jointY, zOffset);
  lower.group.rotation.set(0, 0, theta2 + Math.PI / 2);
}

/* -------------------------------------------------------------------------- */
/* Everything below needs a GL context, so it is all built lazily by          */
/* `createFilmEngine` rather than at module scope.                             */
/* -------------------------------------------------------------------------- */

/**
 * The demo's grid resolution, used only to derive the camera's aspect. Every
 * `GRID_TIERS` entry is 2:1, so `(230 * 0.58) / 115` equals `(160 * 0.58) / 80`
 * and the camera never needs re-aiming when the tier changes.
 */
const CAMERA_ASPECT = (230 * 0.58) / 115;

/** The fulcrum's contact point with the lever, in world space (`updateScene` pivots about it). */
const PIVOT_X = 0.45;
const PIVOT_Y = 1.18;

/**
 * A material colour, authored the way the demo authored it.
 *
 * r128 shipped with `THREE.ColorManagement.enabled === false`, so `0xb0b0b0`
 * entered the shader as `176/255 = 0.690` LINEAR. r186 enables colour management
 * and reads a bare hex as sRGB, so the same literal now enters as `0.434` — the
 * rock loses 37% of its albedo, the wood 26%, the ground 77%, the hair 73%. That is
 * a large part of why a literal port of the demo's numbers renders a flat, dark
 * film even once the lights are translated correctly.
 *
 * Declaring the source space as working/linear makes `setHex` a no-op, reproducing
 * r128's behaviour exactly, and keeps the demo's hex literals readable here. The
 * alternative — raising the two spot intensities until brightness matched — buys the
 * same mean luminance by lifting the shadows too, which flattens exactly the
 * chiaroscuro the film is made of: a gain knob scales the whole image, an albedo
 * correction only stops over-darkening the surfaces that were being over-darkened.
 * Intensity is therefore reserved for the LIGHTS and these hexes stay as written.
 */
const filmColor = (hex: number): THREE.Color =>
  new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);

/**
 * RE-LIGHT — the one part of this port that is a judgement call.
 *
 * three r155 removed `useLegacyLights`, and r128's default WAS legacy mode, so
 * there is no escape hatch to the modern physical model. Two things changed
 * together, and they were measured against the installed r186.1 source rather
 * than remembered:
 *
 *  1. **The π scale factor is gone.** r128's `WebGLLights` multiplied spot and
 *     point intensity by π whenever lights were not physically correct. r186 has
 *     no such branch. Hence `intensity × Math.PI` on both `SpotLight`s — the
 *     documented migration — which is what makes 2.9 → 9.11 and 3.6 → 11.31.
 *  2. **`distance = 0` meant NO falloff in r128, and means 1/d in r186.** The demo
 *     constructed its spots with only `(color, intensity)`, so `distance` defaulted
 *     to 0. r128's legacy attenuation branch was
 *     `if (cutoffDistance > 0 && decay > 0) pow(saturate(1 − d/cutoff), decay); return 1.0;`
 *     — with `cutoffDistance === 0` it fell through to the **`return 1.0`**, i.e.
 *     these two lights had NO distance attenuation whatsoever. r186's branch has no
 *     such escape: `1 / max(pow(d, decay), 0.01)` is unconditional, so the same
 *     arguments silently become 1/d, which at the ~16 unit light distance is a ~16×
 *     darkening no intensity bump should be asked to paper over. So both spots pass
 *     `decay: 0` EXPLICITLY, which is the demo's actual flat falloff — and is also
 *     what makes rule (1) exactly compensating rather than approximately so.
 *     (`decay: 1`, the r186 default, is *wrong* here: measured, it put the hero
 *     frame at 1,211 drawn cells where the reference composites 16,845.)
 *
 * The `DirectionalLight` is untouched (0.55), as instructed: directional intensity
 * did not change meaning in r155, so scaling it would be guessing.
 *
 * The third delta is colour, not intensity, and it is handled in `filmColor` rather
 * than here: r128 ran with colour management OFF, so `0xb0b0b0` was already a
 * LINEAR albedo. Reading it as sRGB under r186 costs the rock 37% of its albedo and
 * the ground 77%. That belongs with the albedos, not on the light gain — a gain knob
 * lifts the shadows along with everything else and flattens the chiaroscuro, whereas
 * the albedo correction only stops over-darkening the surfaces that were being
 * over-darkened.
 *
 * **The one free parameter left is the key light's `* 1.3`.** With both spots on the
 * bare `× π` rule the hero frame measured mean luminance 0.2685 against the
 * reference's 0.2713, so the *global* exposure already matched; what did not match
 * was the distribution. The boulder sits under the key light at `(6, 13, 8)` and in
 * the reference it reads brighter than a straight port produced (upper-right
 * quadrant 0.3455 measured vs 0.2542 ported), and pushing only the key light lifts
 * that without inflating the whole frame. 1.3 is where the hero frame's correlation
 * against the reference peaked in a sweep of 1.0/1.15/1.3/1.6 on the key and
 * 1.0/1.2/1.5 on the rim; raising the rim further degraded it, which is why the rim
 * stays on the unprefixed `× π`. Final measured hero frame: coverage 66.7% vs the
 * reference's 63.7%, mean 0.2790 vs 0.2713, max 0.650 vs 0.643.
 *
 * Also measured and then removed: explicit `shadow.camera.near/far` and a
 * `shadow.bias`. The demo set neither and they changed the hero frame's mean by
 * 0.0003, so they are left out — this file should not carry knobs that do nothing.
 *
 * These numbers are recorded in the commit message too: this is a look, not a law.
 * Do NOT recover contrast by disabling shadows — the shadowed chiaroscuro IS the
 * film.
 */
const KEY_LIGHT_INTENSITY = 2.9 * Math.PI * 1.3;
const RIM_LIGHT_INTENSITY = 3.6 * Math.PI;
const BOUNCE_LIGHT_INTENSITY = 0.55;

/** Debris pool size — the demo's count, and the reason no allocation happens per frame. */
const PARTICLE_COUNT = 38;

interface Debris {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

/** The rig, exactly the demo's hierarchy. */
interface HumanRig {
  root: THREE.Group;
  pelvis: THREE.Group;
  torso: THREE.Group;
  chest: THREE.Group;
  neck: THREE.Group;
  head: THREE.Group;
}

/** Public handle on the offscreen film. See the module header for the contract. */
export interface FilmEngine {
  /**
   * Resize the render target to `tier` × a supersample factor chosen from `dpr`,
   * and re-allocate the readback + luminance buffers. Safe to call repeatedly;
   * the old render target is disposed here.
   *
   * `boxWidth`/`boxHeight` are the CSS box the film will be drawn into and only
   * ever *reduce* the supersample factor — the film never renders more pixels than
   * there are device pixels to show them. At `dpr === 1` (and therefore in the
   * reference comparison) the factor is 1 and the readback is exactly the demo's
   * one-pixel-per-cell, so measured luminance stays comparable to the reference.
   */
  resize(boxWidth: number, boxHeight: number, dpr: number, tier: { cols: number; rows: number }): void;
  /**
   * Advance choreography to `elapsedSec` and return `COLS*ROWS` luminance in
   * [0,1], row-major, **y already flipped**. POST-TONE-CURVE.
   *
   * Returns the SAME array instance until the next `resize()`. After a context
   * loss or a dispose it returns a grid of zeros, which makes the caller's
   * drawn-cell count 0 and therefore triggers its fallback (ADR 0070).
   */
  frame(elapsedSec: number, dtSec: number): Float32Array;
  /** Free the GL context and every GPU buffer. Idempotent. */
  dispose(): void;
  /** Called by the owner on `webglcontextlost`. Kills further GL work. */
  onContextLost(): void;
}

/**
 * Build the scene graph once. Takes a renderer only so the materials/geometry it
 * creates can be disposed later; nothing here uploads anything until first render.
 */
function createScene(): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  human: HumanRig;
  leverGeo: THREE.BufferGeometry;
  leverBasePos: THREE.BufferAttribute;
  boulderGroup: THREE.Group;
  lFoot: THREE.Mesh;
  rFoot: THREE.Mesh;
  lHandMesh: THREE.Mesh;
  rHandMesh: THREE.Mesh;
  limbs: {
    lThigh: LimbSegment;
    lCalf: LimbSegment;
    rThigh: LimbSegment;
    rCalf: LimbSegment;
    lUpperArm: LimbSegment;
    lForearm: LimbSegment;
    rUpperArm: LimbSegment;
    rForearm: LimbSegment;
  };
  debris: Debris[];
  disposables: Array<{ dispose(): void }>;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x000000, 0.032);

  const camera = new THREE.PerspectiveCamera(32, CAMERA_ASPECT, 0.1, 100);

  // Everything the GPU was ever told about; tracked so dispose() can actually free it.
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };

  /* ---------------- lights ---------------- */

  // Strong top-right key light casting crisp anatomical shadows
  // The trailing 0 is `decay`: see RE-LIGHT above, decay 0 is what r128's
  // `distance === 0` legacy branch actually produced.
  const keyLight = new THREE.SpotLight(0xffffff, KEY_LIGHT_INTENSITY, 0, Math.PI / 3, 0.65, 0);
  keyLight.position.set(6, 13, 8);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.width = 1024;
  keyLight.shadow.mapSize.height = 1024;
  scene.add(keyLight);

  // Intense backlight / rim-light to carve realistic human silhouette from the dark background
  const rimLight = new THREE.SpotLight(0xffffff, RIM_LIGHT_INTENSITY, 0, Math.PI / 2.5, 0.4, 0);
  rimLight.position.set(-9, 8, -7);
  scene.add(rimLight);

  // Warm bounce light from the ground
  const bounceLight = new THREE.DirectionalLight(0x888888, BOUNCE_LIGHT_INTENSITY);
  bounceLight.position.set(0, -6, 5);
  scene.add(bounceLight);

  // Volumetric spotlight cone mesh in background for cinematic atmosphere
  const beamGeo = track(new THREE.ConeGeometry(7.5, 22, 32, 1, true));
  const beamMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.045,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const lightShaft = new THREE.Mesh(beamGeo, beamMat);
  lightShaft.position.set(1.2, 6.5, -2.5);
  lightShaft.rotation.z = -0.24;
  scene.add(lightShaft);

  /* ---------------- materials ---------------- */

  const skinMat = track(
    new THREE.MeshStandardMaterial({ color: filmColor(0xd8d8d8), roughness: 0.42, metalness: 0.08 }),
  );
  const hairMat = track(
    new THREE.MeshStandardMaterial({ color: filmColor(0x555555), roughness: 0.85, metalness: 0.02 }),
  );
  const tunicMat = track(
    new THREE.MeshStandardMaterial({ color: filmColor(0xefefef), roughness: 0.65, metalness: 0.02 }),
  );
  const rockMat = track(
    new THREE.MeshStandardMaterial({
      color: filmColor(0xb0b0b0),
      roughness: 0.82,
      metalness: 0.12,
      flatShading: true,
    }),
  );
  const beamWoodMat = track(
    new THREE.MeshStandardMaterial({ color: filmColor(0xc8c8c8), roughness: 0.55, metalness: 0.15 }),
  );
  const groundMat = track(
    new THREE.MeshStandardMaterial({
      color: filmColor(0x484848),
      roughness: 0.9,
      metalness: 0.05,
      flatShading: true,
    }),
  );

  /* ---------------- ground ---------------- */

  const groundGeo = track(new THREE.PlaneGeometry(36, 20, 64, 32));
  groundGeo.rotateX(-Math.PI / 2);
  const gPos = groundGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < gPos.count; i++) {
    const vx = gPos.getX(i);
    const vz = gPos.getZ(i);
    const bump =
      Math.sin(vx * 1.4) * Math.cos(vz * 1.4) * 0.08 + Math.sin(vx * 3.7 + vz * 2.3) * 0.03;
    gPos.setY(i, bump);
  }
  groundGeo.computeVertexNormals();
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  /* ---------------- fulcrum ---------------- */

  // Craggy pyramidal Fulcrum block
  const fulcrumGeo = track(new THREE.ConeGeometry(0.92, 1.35, 6, 3));
  const fPos = fulcrumGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < fPos.count; i++) {
    const vy = fPos.getY(i);
    if (vy < 0.5) {
      fPos.setX(i, fPos.getX(i) + Math.sin(i * 4.1) * 0.06);
      fPos.setZ(i, fPos.getZ(i) + Math.cos(i * 3.7) * 0.06);
    }
  }
  fulcrumGeo.computeVertexNormals();
  const fulcrumMesh = new THREE.Mesh(fulcrumGeo, rockMat);
  fulcrumMesh.position.set(0.45, 0.65, 0);
  fulcrumMesh.castShadow = true;
  fulcrumMesh.receiveShadow = true;
  scene.add(fulcrumMesh);

  /* ---------------- boulder ---------------- */

  // Colossal Craggy Boulder
  const boulderGroup = new THREE.Group();
  scene.add(boulderGroup);

  const boulderGeo = track(new THREE.IcosahedronGeometry(2.15, 3));
  const bPos = boulderGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < bPos.count; i++) {
    const vx = bPos.getX(i);
    const vy = bPos.getY(i);
    const vz = bPos.getZ(i);
    const noise =
      Math.sin(vx * 2.1 + vy * 1.7) * 0.22 +
      Math.cos(vy * 3.4 - vz * 2.6) * 0.14 +
      Math.sin(vz * 4.8 + vx * 3.9) * 0.07;
    const scale = 1 + noise * 0.18;
    bPos.setXYZ(i, vx * scale * 1.12, vy * scale * 0.96, vz * scale);
  }
  boulderGeo.computeVertexNormals();
  const boulderMesh = new THREE.Mesh(boulderGeo, rockMat);
  boulderMesh.castShadow = true;
  boulderMesh.receiveShadow = true;
  boulderGroup.add(boulderMesh);

  /* ---------------- lever ---------------- */

  const leverLength = 7.4;
  const leverGeo = track(new THREE.CylinderGeometry(0.11, 0.14, leverLength, 12, 36));
  leverGeo.rotateZ(Math.PI / 2); // Align along X axis
  // The undeformed positions, kept so the per-frame bend is always authored from
  // rest. Without this the bow would compound every frame and the beam would
  // self-destruct.
  const leverBasePos = (leverGeo.attributes.position as THREE.BufferAttribute).clone();
  const leverMesh = new THREE.Mesh(leverGeo, beamWoodMat);
  leverMesh.castShadow = true;
  leverMesh.receiveShadow = true;
  // r186 hint: the position buffer is rewritten every frame, so say so.
  (leverGeo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  scene.add(leverMesh);

  /* ---------------- human ---------------- */

  function createLimbSegment(rTop: number, rBot: number, len: number, mat: THREE.Material): LimbSegment {
    const group = new THREE.Group();
    const geo = track(new THREE.CylinderGeometry(rTop, rBot, len, 14));
    geo.translate(0, -len / 2, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    // Joint sphere cap
    const jointGeo = track(new THREE.SphereGeometry(rTop * 1.04, 12, 12));
    const jointMesh = new THREE.Mesh(jointGeo, mat);
    jointMesh.castShadow = true;
    group.add(jointMesh);

    return { group, mesh, len };
  }

  const human: HumanRig = {
    root: new THREE.Group(),
    pelvis: new THREE.Group(),
    torso: new THREE.Group(),
    chest: new THREE.Group(),
    neck: new THREE.Group(),
    head: new THREE.Group(),
  };
  scene.add(human.root);

  // Pelvis & Draped Greek Exomis / Chiton Tunic Skirt
  const pelvisMesh = new THREE.Mesh(track(new THREE.SphereGeometry(0.34, 16, 12)), tunicMat);
  pelvisMesh.scale.set(1.05, 0.75, 0.88);
  pelvisMesh.castShadow = true;
  human.pelvis.add(pelvisMesh);

  // Pleated Tunic Skirt
  const skirtGeo = track(new THREE.ConeGeometry(0.46, 0.72, 18, 4, true));
  const sPos = skirtGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < sPos.count; i++) {
    const a = Math.atan2(sPos.getZ(i), sPos.getX(i));
    const pleat = Math.sin(a * 9) * 0.035;
    sPos.setX(i, sPos.getX(i) * (1 + pleat));
    sPos.setZ(i, sPos.getZ(i) * (1 + pleat));
  }
  skirtGeo.computeVertexNormals();
  const skirtMesh = new THREE.Mesh(skirtGeo, tunicMat);
  skirtMesh.position.y = -0.22;
  skirtMesh.castShadow = true;
  human.pelvis.add(skirtMesh);
  human.root.add(human.pelvis);

  // Muscular Abdomen & Ribcage/Chest
  human.pelvis.add(human.torso);
  const abdomenMesh = new THREE.Mesh(track(new THREE.CylinderGeometry(0.34, 0.29, 0.52, 16)), skinMat);
  abdomenMesh.position.y = 0.25;
  abdomenMesh.scale.set(1.0, 1.0, 0.78);
  abdomenMesh.castShadow = true;
  human.torso.add(abdomenMesh);

  // Draped Shoulder Tunic Sash
  const sashGeo = track(new THREE.TorusGeometry(0.34, 0.09, 10, 24));
  const sashMesh = new THREE.Mesh(sashGeo, tunicMat);
  sashMesh.position.set(0, 0.42, 0);
  sashMesh.rotation.set(0.3, 0.2, 0.85);
  sashMesh.scale.set(1.15, 1.35, 0.85);
  sashMesh.castShadow = true;
  human.torso.add(sashMesh);

  human.torso.add(human.chest);
  human.chest.position.y = 0.48;

  const chestMesh = new THREE.Mesh(track(new THREE.SphereGeometry(0.41, 18, 14)), skinMat);
  chestMesh.position.y = 0.22;
  chestMesh.scale.set(1.12, 0.95, 0.82);
  chestMesh.castShadow = true;
  human.chest.add(chestMesh);

  // Broad Deltoids / Shoulders
  const lShoulderBulb = new THREE.Mesh(track(new THREE.SphereGeometry(0.18, 12, 12)), skinMat);
  lShoulderBulb.position.set(0.04, 0.34, 0.38);
  human.chest.add(lShoulderBulb);

  const rShoulderBulb = new THREE.Mesh(track(new THREE.SphereGeometry(0.18, 12, 12)), skinMat);
  rShoulderBulb.position.set(0.04, 0.34, -0.38);
  human.chest.add(rShoulderBulb);

  // Sculpted Head, Brow, Nose & Classical Philosopher Beard
  human.chest.add(human.neck);
  human.neck.position.set(0.06, 0.46, 0);
  const neckMesh = new THREE.Mesh(track(new THREE.CylinderGeometry(0.13, 0.15, 0.22, 12)), skinMat);
  neckMesh.position.y = 0.08;
  human.neck.add(neckMesh);

  human.neck.add(human.head);
  human.head.position.set(0.04, 0.22, 0);

  const cranium = new THREE.Mesh(track(new THREE.SphereGeometry(0.24, 16, 16)), skinMat);
  cranium.scale.set(1.08, 1.15, 0.92);
  cranium.castShadow = true;
  human.head.add(cranium);

  // Brow ridge & nose bridge for sharp profile lighting
  const brow = new THREE.Mesh(track(new THREE.BoxGeometry(0.14, 0.07, 0.28)), skinMat);
  brow.position.set(0.21, 0.06, 0);
  human.head.add(brow);

  const nose = new THREE.Mesh(track(new THREE.ConeGeometry(0.055, 0.15, 6)), skinMat);
  nose.rotation.z = -Math.PI / 2.3;
  nose.position.set(0.27, 0.0, 0);
  human.head.add(nose);

  // Full Sculpted Beard
  const beard = new THREE.Mesh(track(new THREE.ConeGeometry(0.21, 0.38, 10)), hairMat);
  beard.rotation.z = Math.PI + 0.38;
  beard.position.set(0.16, -0.18, 0);
  beard.scale.set(1.1, 1.0, 0.85);
  beard.castShadow = true;
  human.head.add(beard);

  // Hair Mass & Classical Fillet Headband
  const hairMass = new THREE.Mesh(track(new THREE.SphereGeometry(0.255, 14, 14)), hairMat);
  hairMass.position.set(-0.04, 0.04, 0);
  human.head.add(hairMass);

  // Articulated Limbs (Upper & Lower segments for 2-bone IK)
  const lThigh = createLimbSegment(0.19, 0.145, 0.84, skinMat);
  const lCalf = createLimbSegment(0.14, 0.10, 0.82, skinMat);
  const rThigh = createLimbSegment(0.19, 0.145, 0.84, skinMat);
  const rCalf = createLimbSegment(0.14, 0.10, 0.82, skinMat);

  const lUpperArm = createLimbSegment(0.14, 0.115, 0.68, skinMat);
  const lForearm = createLimbSegment(0.11, 0.085, 0.64, skinMat);
  const rUpperArm = createLimbSegment(0.14, 0.115, 0.68, skinMat);
  const rForearm = createLimbSegment(0.11, 0.085, 0.64, skinMat);

  // The demo added these to the scene directly: the limbs are solved in WORLD
  // space each frame, so they must not inherit the figure's transform.
  scene.add(lThigh.group, lCalf.group, rThigh.group, rCalf.group);
  scene.add(lUpperArm.group, lForearm.group, rUpperArm.group, rForearm.group);

  // Foot meshes planted on the ground
  const footGeo = track(new THREE.BoxGeometry(0.38, 0.12, 0.18));
  const lFoot = new THREE.Mesh(footGeo, skinMat);
  const rFoot = new THREE.Mesh(footGeo, skinMat);
  lFoot.castShadow = true;
  rFoot.castShadow = true;
  scene.add(lFoot, rFoot);

  // Hand grip spheres on the beam
  const handGeo = track(new THREE.SphereGeometry(0.115, 10, 10));
  const lHandMesh = new THREE.Mesh(handGeo, skinMat);
  const rHandMesh = new THREE.Mesh(handGeo, skinMat);
  scene.add(lHandMesh, rHandMesh);

  /* ---------------- debris ---------------- */

  const debrisGeo = track(new THREE.DodecahedronGeometry(0.065, 0));
  const debris: Debris[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const m = new THREE.Mesh(debrisGeo, rockMat);
    m.visible = false;
    scene.add(m);
    debris.push({ mesh: m, vx: 0, vy: 0, vz: 0, life: 0 });
  }

  return {
    scene,
    camera,
    human,
    leverGeo,
    leverBasePos,
    boulderGroup,
    lFoot,
    rFoot,
    lHandMesh,
    rHandMesh,
    limbs: { lThigh, lCalf, rThigh, rCalf, lUpperArm, lForearm, rUpperArm, rForearm },
    debris,
    disposables,
  };
}

/** Scratch vectors reused every frame — the rig is solved ~6 times per frame and allocating there is pure waste. */
const scratchShoulder = new THREE.Vector3();
const scratchHipL = new THREE.Vector3();
const scratchHipR = new THREE.Vector3();
const scratchLeftFoot = new THREE.Vector3();
const scratchRightFoot = new THREE.Vector3();
const scratchPelvis = new THREE.Vector3();

/**
 * Advance the rig, the lever deformation, the boulder and the debris to `time`,
 * and aim the camera. Ported verbatim from `updateScene`.
 *
 * The one deliberate deletion is the demo's per-frame
 * `leverGeo.computeVertexNormals()`: at 230×115 it rebuilds normals over ~864
 * triangles every frame to shade a beam that is a dozen pixels long, and the bow
 * reads through the silhouette rather than through the normal field. The beam is
 * lit from its rest normals instead, which is why the wood still takes a highlight.
 */
function updateScene(
  time: number,
  dt: number,
  rig: ReturnType<typeof createScene>,
): void {
  const seq = evaluateChoreography(time);
  const { human, leverGeo, leverBasePos, boulderGroup, limbs, debris } = rig;

  // Subtle muscle tremor under peak isometric strain
  const tremorX = seq.strain > 0.4 ? Math.cos(time * 52) * seq.strain * 0.025 : 0;
  const tremorY = seq.strain > 0.4 ? Math.sin(time * 58) * seq.strain * 0.022 : 0;

  // Hand grip position on left side of lever
  const handX = -2.42 + seq.push * 0.22 + tremorX;
  const handY = 2.52 - seq.push * 1.58 + tremorY;

  // Load contact point under the monolith on right side of lever
  const loadX = 2.05;
  const loadY = 0.58 + seq.lift * 1.15;

  // Deform the wooden lever mesh smoothly across hands -> fulcrum -> boulder
  const lPos = leverGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < lPos.count; i++) {
    const bx = leverBasePos.getX(i); // -3.7 to +3.7
    const by = leverBasePos.getY(i);
    const bz = leverBasePos.getZ(i);

    const worldX = bx - 0.15;
    let centerLineY;
    let slope;

    if (worldX <= PIVOT_X) {
      const u = (worldX - handX) / (PIVOT_X - handX);
      const linearY = handY + u * (PIVOT_Y - handY);
      const bow = Math.sin(THREE.MathUtils.clamp(u, 0, 1) * Math.PI) * seq.bend * 0.42;
      centerLineY = linearY + bow;
      slope = (PIVOT_Y - handY) / (PIVOT_X - handX);
    } else {
      const u = (worldX - PIVOT_X) / (loadX - PIVOT_X);
      const linearY = PIVOT_Y + u * (loadY - PIVOT_Y);
      const bow = Math.sin(THREE.MathUtils.clamp(u, 0, 1) * Math.PI) * seq.bend * 0.22;
      centerLineY = linearY + bow;
      slope = (loadY - PIVOT_Y) / (loadX - PIVOT_X);
    }

    lPos.setX(i, worldX - by * slope * 0.5);
    lPos.setY(i, centerLineY + by);
    lPos.setZ(i, bz);
  }
  lPos.needsUpdate = true;

  // Position & rotate the massive monolith as it is pried upward
  boulderGroup.position.set(2.82 + seq.lift * 0.28 + tremorX * 0.6, 1.82 + seq.lift * 1.18, 0);
  boulderGroup.rotation.z = -seq.lift * 0.26;
  boulderGroup.rotation.y = 0.35 + seq.lift * 0.08;

  // Position Archimedes' feet in a wide heroic lunge stance
  scratchLeftFoot.set(-3.55, 0.06, 0.28);
  scratchRightFoot.set(-2.38, 0.06, -0.28);
  rig.lFoot.position.copy(scratchLeftFoot);
  rig.rFoot.position.copy(scratchRightFoot);

  // Hips drop low and shift forward as he drives his body weight into the lever
  const breath = Math.sin(time * 3.5) * 0.025;
  scratchPelvis.set(-3.02 + seq.push * 0.34 + tremorX, 1.38 - seq.push * 0.54 + breath + tremorY, 0);
  human.pelvis.position.copy(scratchPelvis);

  // Torso leans sharply forward over the lever
  const torsoLean = -0.38 - seq.push * 0.46 - seq.strain * 0.14;
  human.torso.rotation.z = torsoLean;
  human.chest.rotation.z = -0.12 - seq.strain * 0.08;

  // Head tilts with effort, looking toward the fulcrum and rising monolith
  human.head.rotation.z = 0.22 + seq.push * 0.25 - seq.strain * 0.18;
  human.head.rotation.y = -0.18;

  // Compute world-space hip & shoulder sockets for 2-bone IK
  human.root.updateMatrixWorld(true);
  scratchShoulder.set(0.05, 0.34, 0).applyMatrix4(human.chest.matrixWorld);

  rig.lHandMesh.position.set(handX, handY, 0.32);
  rig.rHandMesh.position.set(handX + 0.1, handY, -0.32);

  // Solve Arm IK (both arms gripping the lever)
  solveLimbIK(scratchShoulder, rig.lHandMesh.position, 0.68, 0.64, 1, limbs.lUpperArm, limbs.lForearm, 0.32);
  solveLimbIK(scratchShoulder, rig.rHandMesh.position, 0.68, 0.64, -1, limbs.rUpperArm, limbs.rForearm, -0.32);

  scratchHipL.set(-0.12, -0.15, 0.22).applyMatrix4(human.pelvis.matrixWorld);
  scratchHipR.set(-0.12, -0.15, -0.22).applyMatrix4(human.pelvis.matrixWorld);

  solveLimbIK(scratchHipL, scratchLeftFoot, 0.84, 0.82, -1, limbs.lThigh, limbs.lCalf, 0.28);
  solveLimbIK(scratchHipR, scratchRightFoot, 0.84, 0.82, 1, limbs.rThigh, limbs.rCalf, -0.28);

  // Spawn sweat droplets and dust particles during heavy exertion and impact slam
  if (seq.strain > 0.5 && Math.random() < 0.35) {
    spawnDebris(
      debris,
      scratchShoulder.x + (Math.random() - 0.5) * 0.2,
      scratchShoulder.y + 0.3 + Math.random() * 0.2,
      0,
      (Math.random() - 0.5) * 1.2,
      1.5 + Math.random() * 2.5,
      (Math.random() - 0.5) * 1.2,
      0.28,
      0.6,
    );
  }

  if (seq.slam > 0.1 && Math.random() < 0.6) {
    spawnDebris(
      debris,
      loadX + (Math.random() - 0.5) * 0.8,
      0.2,
      (Math.random() - 0.5) * 0.8,
      (Math.random() - 0.5) * 3.5,
      1.0 + Math.random() * 3.0,
      (Math.random() - 0.5) * 3.5,
      0.6,
      0.9,
    );
  }

  // Update particle physics
  for (const d of debris) {
    if (d.life > 0) {
      d.life -= dt;
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;
      d.vy -= 9.8 * dt; // gravity
      if (d.mesh.position.y < 0.05) {
        d.mesh.position.y = 0.05;
        d.vy *= -0.3;
        d.vx *= 0.7;
        d.vz *= 0.7;
      }
      if (d.life <= 0) d.mesh.visible = false;
    }
  }

  // Cinematic camera vibration on slam impact
  const camShake = seq.slam * 0.18 * Math.sin(time * 75);
  rig.camera.position.set(camShake * 0.6, 3.8 + camShake, 8.9);
  rig.camera.lookAt(0.2, 1.6, 0);
}

/** Take the first dead particle, the demo's pool policy: never allocate, never evict a live one. */
function spawnDebris(
  debris: Debris[],
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  scale: number,
  life: number,
): void {
  for (const d of debris) {
    if (d.life <= 0) {
      d.mesh.position.set(x, y, z);
      d.mesh.scale.setScalar(scale);
      d.mesh.visible = true;
      d.vx = vx;
      d.vy = vy;
      d.vz = vz;
      d.life = life;
      return;
    }
  }
}

/**
 * The demo's chiaroscuro transfer function, applied to the readback.
 *
 * This is the whole look and it is here, not in the compositor, on purpose:
 *  - `0.299/0.587/0.114` luma, then
 *  - a vignette that is `max(0, 1 − (0.8·nx² + 1.1·ny²))`, so the corners go black
 *    before the edges do (the vertical term is larger because the frame is short),
 *  - crushed to zero below 0.04 — but NOT to literal zero: a dead cell gets
 *    `vignette * 0.005`, which is comfortably under the compositor's 0.015 cut, so
 *    background emits no draw call and never sits at the threshold flickering,
 *  - and `pow(lum, 1.85) * vignette * 0.65` everywhere else, which is a hard
 *    gamma that pushes mid-tones down and keeps only genuinely lit surfaces bright.
 *
 * The vignette is computed from the OUTPUT row (`y`), as in the demo — the readback
 * comes back bottom-up and is flipped on the way in, so screen-space is the space
 * the vignette belongs to.
 */
function applyToneCurve(
  pixels: Uint8Array,
  out: Float32Array,
  cols: number,
  rows: number,
): void {
  for (let y = 0; y < rows; y++) {
    // Flip Y because WebGL coordinate system is bottom-up
    const flippedY = rows - 1 - y;
    const ny = y / rows - 0.5;
    for (let x = 0; x < cols; x++) {
      const idx = (flippedY * cols + x) * 4;
      const r = pixels[idx]!;
      const g = pixels[idx + 1]!;
      const b = pixels[idx + 2]!;
      let lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;

      const nx = x / cols - 0.5;
      const vignette = Math.max(0, 1 - (nx * nx * 0.8 + ny * ny * 1.1));

      if (lum < 0.04) {
        lum = vignette * 0.005;
      } else {
        // High-contrast power curve for dramatic shadows
        lum = Math.pow(lum, 1.85) * vignette * 0.65;
      }

      out[y * cols + x] = Math.min(1.0, Math.max(0.0, lum));
    }
  }
}

/**
 * Create the film engine.
 *
 * **Throws** when WebGL2 is unavailable or the render target cannot be obtained —
 * it never returns `null`. That is the ADR 0070 contract: the caller wraps this in
 * `try`/`catch` and falls back to the text line, and the *behavioural* liveness
 * test (count drawn cells) catches the cases where construction succeeds but
 * nothing paints. three ≥ r163 is WebGL2-only, so an older Linux webview is a
 * supported fallback case rather than a crash.
 */
export function createFilmEngine(): FilmEngine {
  // Created, never appended. This canvas is the GL surface; the document must end
  // up holding only Task 5's 2D canvas.
  const canvas = document.createElement("canvas");

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // The `webglcontextlost` event lands on the canvas, and this canvas is the only
  // thing that owns the context — Task 5 never sees it, because it is never in the
  // document. So the latch is wired here as well as exposed as `onContextLost`,
  // and both paths go through the same one-way flag: `upstream#6559` is a real
  // "WebGL: context lost" report, and a lost context would otherwise leave the film
  // frozen on its last frame forever instead of falling back. `onContextLost` stays
  // on the public surface because the contract says the owner calls it, and because
  // the owner may be watching a DIFFERENT canvas (its 2D one) for the same event.
  const handleContextLost = (event: Event): void => {
    // Cancelling the default is what tells the browser we intend to handle it; we do
    // not attempt a restore, because re-creating the scene is the owner's decision.
    event.preventDefault();
    onContextLost();
  };
  canvas.addEventListener("webglcontextlost", handleContextLost);

  const gl = renderer.getContext();
  if (gl === null) {
    renderer.dispose();
    throw new Error("film engine: WebGL2 context could not be created");
  }

  const rig = createScene();

  // The demo's r128 rendered to the default drawing buffer with LinearEncoding,
  // i.e. the pixels it read back were LINEAR. r186 renders an ordinary
  // WebGLRenderTarget in ColorManagement.workingColorSpace, which is also linear
  // (WebGLRenderer.js: the non-null render target branch bypasses outputColorSpace
  // entirely). So the readback is the same KIND of number and the demo's 1.85
  // exponent still means what it meant. Forcing the target's texture to sRGB here
  // would pre-encode the pixels and make that curve double-apply — brighter,
  // flatter, and nothing like the reference.
  let renderTarget: THREE.WebGLRenderTarget | null = null;
  let pixelBuffer = new Uint8Array(0);
  let lumGrid = new Float32Array(0);
  let cols = 230;
  let rows = 115;
  let supersample = 1;
  let disposed = false;
  let contextLost = false;

  /**
   * Build the target at `tier` resolution. `ss` > 1 renders a whole-pixel grid and
   * averages it down to the cells, which is the only antialiasing that survives at
   * one cell per glyph — `antialias: true` on a 1-pixel-per-cell buffer does
   * essentially nothing. `ss` is 1 at `dpr === 1`, so the reference comparison and
   * the shipped behaviour on a non-HiDpi display are the demo's own path.
   */
  const buildTarget = (
    boxWidth: number,
    boxHeight: number,
    dpr: number,
    tier: { cols: number; rows: number },
  ): void => {
    cols = tier.cols;
    rows = tier.rows;

    // Only supersample when the display actually has the pixels for it, and never
    // so much that the readback (which is synchronous) gets large.
    let ss = dpr >= 1.5 ? 2 : 1;
    if (cols * ss > boxWidth * dpr || rows * ss > boxHeight * dpr) ss = 1;
    if (!(ss >= 1)) ss = 1;
    supersample = ss;

    const rtWidth = cols * ss;
    const rtHeight = rows * ss;

    if (renderTarget !== null) renderTarget.dispose();
    renderTarget = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      // The demo's 1px-per-cell target had a depth buffer by default and needs one
      // now more than ever — the boulder, figure and lever overlap heavily.
      depthBuffer: true,
      stencilBuffer: false,
    });

    // Fail loudly, exactly once, at construction time: an incomplete framebuffer
    // means nothing will ever be drawn, and the caller's fallback is the answer.
    renderer.setRenderTarget(renderTarget);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    renderer.setRenderTarget(null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      renderTarget.dispose();
      renderTarget = null;
      renderer.dispose();
      throw new Error(
        `film engine: render target is not framebuffer complete (status 0x${status.toString(16)})`,
      );
    }

    renderer.setSize(rtWidth, rtHeight, false);
    pixelBuffer = new Uint8Array(rtWidth * rtHeight * 4);
    lumGrid = new Float32Array(cols * rows);
  };

  // Start on the demo's own grid so `frame()` is legal before any `resize()`.
  buildTarget(230, 115, 1, { cols: 230, rows: 115 });

  const resize: FilmEngine["resize"] = (boxWidth, boxHeight, dpr, tier) => {
    if (disposed || contextLost) return;
    buildTarget(boxWidth, boxHeight, dpr, tier);
  };

  const frame: FilmEngine["frame"] = (elapsedSec, dtSec) => {
    if (disposed || contextLost || renderTarget === null) {
      // A dead engine answers with an all-background grid, so the caller's drawn
      // cell count is 0 and its fallback engages (ADR 0070).
      lumGrid.fill(0);
      return lumGrid;
    }

    updateScene(elapsedSec, dtSec, rig);

    renderer.setRenderTarget(renderTarget);
    renderer.render(rig.scene, rig.camera);
    renderer.setRenderTarget(null);
    // Not a raw GL read-back: that path needs the back buffer preserved and stalls the GPU.
    renderer.readRenderTargetPixels(
      renderTarget,
      0,
      0,
      cols * supersample,
      rows * supersample,
      pixelBuffer,
    );

    if (supersample === 1) {
      applyToneCurve(pixelBuffer, lumGrid, cols, rows);
    } else {
      downsampleAndToneCurve(pixelBuffer, lumGrid, cols, rows, supersample);
    }
    return lumGrid;
  };

  const dispose: FilmEngine["dispose"] = () => {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener("webglcontextlost", handleContextLost);
    if (renderTarget !== null) {
      renderTarget.dispose();
      renderTarget = null;
    }
    for (const thing of rig.disposables) thing.dispose();
    // Browsers cap live WebGL contexts near 16 and this is the only GL user in the
    // app, so the slot really has to come back on unmount (ADR 0070).
    renderer.dispose();
    renderer.forceContextLoss();
    pixelBuffer = new Uint8Array(0);
    lumGrid = new Float32Array(0);
    cols = 0;
    rows = 0;
  };

  const onContextLost: FilmEngine["onContextLost"] = () => {
    // One-way latch: every later frame() returns zeros, which is what makes the
    // owner's liveness counter notice rather than show a frozen last frame forever.
    contextLost = true;
    lumGrid.fill(0);
  };

  /**
   * Supersampled variant of the tone-curve pass: average the `ss×ss` pixel block
   * that covers one cell, THEN curve it. The order matters — averaging after the
   * 1.85 gamma would lift dark edges into the visible bands and smear the contours
   * the glyph selection depends on.
   */
  const downsampleAndToneCurve = (
    pixels: Uint8Array,
    out: Float32Array,
    gridCols: number,
    gridRows: number,
    ss: number,
  ): void => {
    const stride = gridCols * ss;
    const area = ss * ss;
    for (let y = 0; y < gridRows; y++) {
      const flippedY = gridRows - 1 - y;
      const ny = y / gridRows - 0.5;
      for (let x = 0; x < gridCols; x++) {
        let sum = 0;
        for (let sy = 0; sy < ss; sy++) {
          const pixelRow = (flippedY * ss + sy) * stride;
          for (let sx = 0; sx < ss; sx++) {
            const idx = (pixelRow + x * ss + sx) * 4;
            sum += 0.299 * pixels[idx]! + 0.587 * pixels[idx + 1]! + 0.114 * pixels[idx + 2]!;
          }
        }
        let lum = sum / (255.0 * area);
        const nx = x / gridCols - 0.5;
        const vignette = Math.max(0, 1 - (nx * nx * 0.8 + ny * ny * 1.1));
        lum = lum < 0.04 ? vignette * 0.005 : Math.pow(lum, 1.85) * vignette * 0.65;
        out[y * gridCols + x] = Math.min(1.0, Math.max(0.0, lum));
      }
    }
  };

  return { resize, frame, dispose, onContextLost };
}
