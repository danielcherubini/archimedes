/**
 * The film's maths, asserted with NO WebGL context anywhere.
 *
 * Everything in this file runs against the two pure exports of `scene.ts` —
 * `evaluateChoreography` and `solveLimbIK`. Constructing `THREE.Group`/
 * `THREE.Mesh` here is deliberate and cheap: those are plain JS objects, and no
 * `WebGLRenderer` is ever built, so the suite stays runnable in jsdom where the
 * GL factory cannot work. The look of the film is NOT testable this way — the
 * tone curve, the re-light and the vignette are checked against a rendered
 * reference frame (see the commit that introduces this file), because a
 * `Float32Array` of luminance that is uniformly wrong still passes any number of
 * unit tests.
 *
 * `three` is statically imported here (and through `./scene`), which is fine for
 * a test: tests do not ship, so they do not inflate the app bundle. The
 * keep-`three`-out-of-the-bundle-until-needed rule lives on Task 5's *dynamic*
 * `import("./scene")`, on the caller side of the boundary.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  FILM_HERO_TIME,
  FILM_LOOP_SECONDS,
  evaluateChoreography,
  solveLimbIK,
  type LimbSegment,
} from "./scene";

/**
 * A real `LimbSegment`, because the exported interface asks for a real
 * `THREE.Group` and `THREE.Mesh`. `solveLimbIK` only ever writes to `.group`, but
 * a fabricated object literal would let the interface drift away from what
 * `createLimbSegment` actually returns without anything noticing.
 */
const makeSegment = (len: number): LimbSegment => ({
  group: new THREE.Group(),
  mesh: new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.1, len, 6),
    new THREE.MeshStandardMaterial(),
  ),
  len,
});

/**
 * Where a segment's tip lands, derived the way the shader derives it: the limb
 * geometry is a cylinder translated to hang from its own origin down −Y, and
 * `solveLimbIK` sets `rotation.z = theta + PI/2`, which swings that −Y axis onto
 * `theta`. So the tip is `origin + len * (cos theta, sin theta)`.
 */
const segmentTip = (segment: LimbSegment): { x: number; y: number } => {
  const theta = segment.group.rotation.z - Math.PI / 2;
  return {
    x: segment.group.position.x + Math.cos(theta) * segment.len,
    y: segment.group.position.y + Math.sin(theta) * segment.len,
  };
};

/** The signed side of the root→target line that the knee/elbow sits on. */
const sideOf = (
  root: { x: number; y: number },
  target: { x: number; y: number },
  joint: { x: number; y: number },
): number => Math.sign((target.x - root.x) * (joint.y - root.y) - (target.y - root.y) * (joint.x - root.x));

/** Every choreography sample at a 1 ms stride, for the window/peak assertions. */
const sampleLoop = (): Array<{ t: number; shake: number; slam: number; push: number; lift: number }> => {
  const out: Array<{ t: number; shake: number; slam: number; push: number; lift: number }> = [];
  for (let i = 0; i < 10500; i++) {
    const seq = evaluateChoreography(i / 1000);
    out.push({ t: i / 1000, shake: seq.shake, slam: seq.slam, push: seq.push, lift: seq.lift });
  }
  return out;
};

describe("film loop constants", () => {
  it("runs the demo's 10.5 second loop", () => {
    expect(FILM_LOOP_SECONDS).toBe(10.5);
  });

  it("puts the hero frame inside the full-heave phase, mid-rise", () => {
    expect(FILM_HERO_TIME).toBe(6.5);
    expect(FILM_HERO_TIME).toBeGreaterThan(4.6);
    expect(FILM_HERO_TIME).toBeLessThan(7.6);
    // The `static` state is supposed to freeze the moment the boulder is highest
    // and the figure is fully committed to the lever — not the reach-in, not the
    // slam, so the still frame reads as effort even with no motion to read.
    const hero = evaluateChoreography(FILM_HERO_TIME);
    expect(hero.lift).toBeGreaterThan(0.9);
    expect(hero.push).toBeGreaterThan(0.9);
  });
});

describe("evaluateChoreography", () => {
  it("starts cold with nothing applied", () => {
    const seq = evaluateChoreography(0);
    expect(seq.t).toBe(0);
    expect(seq.push).toBe(0);
    expect(seq.lift).toBe(0);
    expect(seq.bend).toBe(0);
    expect(seq.strain).toBe(0);
    expect(seq.shake).toBe(0);
    expect(seq.slam).toBe(0);
  });

  it("returns exactly the six channel fields plus t", () => {
    expect(Object.keys(evaluateChoreography(3.3)).sort()).toEqual([
      "bend",
      "lift",
      "push",
      "shake",
      "slam",
      "strain",
      "t",
    ]);
  });

  describe("phase boundaries", () => {
    it("has not begun the lift just before 1.8", () => {
      // The reach-in phase never lifts: the boulder moves only once the struggle
      // phase starts, which is the whole point of the 1.8 boundary.
      expect(evaluateChoreography(1.7999).lift).toBe(0);
      expect(evaluateChoreography(1.7999).bend).toBeCloseTo(0.45, 3);
      expect(evaluateChoreography(1.7999).push).toBeCloseTo(0.26, 3);
    });

    it("opens the struggle phase at 1.8 with zero lift and no boulder rise", () => {
      const seq = evaluateChoreography(1.8);
      expect(seq.t).toBeCloseTo(1.8, 9);
      expect(seq.lift).toBe(0);
      expect(seq.push).toBeCloseTo(0.26, 9);
      expect(seq.bend).toBeCloseTo(0.45, 9);
      expect(seq.strain).toBeCloseTo(0.65, 9);
      expect(seq.shake).toBeCloseTo(0.25, 9);
      expect(seq.slam).toBe(0);
    });

    it("keeps the lift flat until 68% through the struggle phase", () => {
      // 1.8 + 0.68 * 2.8 = 3.704 is where the boulder first moves at all.
      expect(evaluateChoreography(3.703).lift).toBe(0);
      expect(evaluateChoreography(3.8).lift).toBeGreaterThan(0);
    });

    it("hands over to the full heave at 4.6", () => {
      const seq = evaluateChoreography(4.6);
      expect(seq.t).toBeCloseTo(4.6, 9);
      expect(seq.push).toBeCloseTo(0.62, 9);
      expect(seq.lift).toBeCloseTo(0.22, 9);
      expect(seq.bend).toBeCloseTo(0.95, 9);
      expect(seq.strain).toBeCloseTo(0.85, 9);
      expect(seq.shake).toBeCloseTo(0.35, 9);
      expect(seq.slam).toBe(0);
    });

    it("releases at 7.6 with the lever still fully loaded", () => {
      const seq = evaluateChoreography(7.6);
      expect(seq.t).toBeCloseTo(7.6, 9);
      expect(seq.push).toBeCloseTo(1.0, 9);
      expect(seq.lift).toBeCloseTo(1.0, 9);
      expect(seq.bend).toBeCloseTo(0.45, 9);
      expect(seq.slam).toBe(0);
    });

    it("recovers at 9.0 with the beam unbent and unlit by the impact", () => {
      const seq = evaluateChoreography(9.0);
      expect(seq.t).toBeCloseTo(9.0, 9);
      expect(seq.push).toBe(0);
      expect(seq.lift).toBe(0);
      expect(seq.bend).toBe(0);
      expect(seq.strain).toBe(0);
      expect(seq.shake).toBe(0);
      expect(seq.slam).toBe(0);
    });
  });

  describe("channel shapes", () => {
    it("drives push to a full 1.0 through the heave", () => {
      expect(evaluateChoreography(4.6).push).toBeCloseTo(0.62, 3);
      expect(evaluateChoreography(6.5).push).toBeGreaterThan(0.9);
      expect(evaluateChoreography(7.5999).push).toBeCloseTo(1.0, 3);
    });

    it("raises the lift monotonically across the heave", () => {
      const lifts = [4.6, 5.2, 5.8, 6.5, 7.0, 7.59].map((t) => evaluateChoreography(t).lift);
      for (let i = 1; i < lifts.length; i++) expect(lifts[i]).toBeGreaterThan(lifts[i - 1]!);
      expect(lifts[lifts.length - 1]).toBeCloseTo(1.0, 2);
    });

    it("peaks shake inside the slam window and nowhere else", () => {
      const loop = sampleLoop();
      const peak = Math.max(...loop.map((s) => s.shake));
      expect(peak).toBeGreaterThan(1.5);
      expect(peak).toBeCloseTo(1.6, 2);
      // The impact tremor is an order of magnitude above the isometric tremor, so
      // a channel that leaked outside its window would be visible immediately.
      for (const s of loop) {
        if (s.shake > 1.0) expect(s.t).toBeGreaterThanOrEqual(7.6);
        if (s.shake > 1.0) expect(s.t).toBeLessThan(9.0);
        if (s.t < 7.6 || s.t >= 9.0) expect(s.shake).toBeLessThan(0.75);
      }
    });

    it("keeps slam at zero outside the 7.6–9.0 impact window", () => {
      const loop = sampleLoop();
      for (const s of loop) {
        if (s.t < 7.6 || s.t >= 9.0) expect(s.slam).toBe(0);
      }
    });

    it("holds slam at zero for the first 28% of the release window, then decays it", () => {
      // The beam has to actually fall before the ground is hit.
      expect(evaluateChoreography(7.6).slam).toBe(0);
      expect(evaluateChoreography(7.9).slam).toBe(0);
      expect(evaluateChoreography(8.0).slam).toBeGreaterThan(0.99);
      expect(evaluateChoreography(8.5).slam).toBeLessThan(evaluateChoreography(8.0).slam);
      expect(evaluateChoreography(8.99).slam).toBeLessThan(0.05);
      const loop = loop_slamInsideWindow();
      for (const value of loop) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("periodicity", () => {
    it("wraps the loop so 10.5 is 0", () => {
      expect(evaluateChoreography(10.5)).toEqual(evaluateChoreography(0));
      expect(evaluateChoreography(31.5)).toEqual(evaluateChoreography(0));
    });

    it("returns the wrapped time and repeats an interior sample", () => {
      expect(evaluateChoreography(12.0).t).toBeCloseTo(1.5, 9);
      expect(evaluateChoreography(12.0)).toEqual(evaluateChoreography(1.5));
      expect(evaluateChoreography(2.0)).toEqual(evaluateChoreography(10.5 + 2.0));
    });
  });
});

/** slam sampled strictly inside the impact window (used by the decay assertion). */
const loop_slamInsideWindow = (): number[] => {
  const out: number[] = [];
  for (let i = 0; i <= 200; i++) out.push(evaluateChoreography(7.6 + (i / 200) * 1.4).slam);
  return out;
};

describe("solveLimbIK", () => {
  it("places the end effector on a reachable target", () => {
    const root = { x: -2.9, y: 2.1 };
    const target = { x: -2.42, y: 2.52 };
    const upper = makeSegment(0.68);
    const lower = makeSegment(0.64);

    solveLimbIK(root, target, 0.68, 0.64, 1, upper, lower, 0.32);

    const tip = segmentTip(lower);
    expect(Math.hypot(tip.x - target.x, tip.y - target.y)).toBeLessThan(1e-3);
    // The bones keep their lengths: the joint is len1 from the root and the tip is
    // len2 from the joint, so no limb can stretch when the pose is re-solved.
    expect(upper.group.position.x).toBeCloseTo(root.x, 9);
    expect(upper.group.position.y).toBeCloseTo(root.y, 9);
    expect(Math.hypot(lower.group.position.x - root.x, lower.group.position.y - root.y)).toBeCloseTo(
      0.68,
      6,
    );
    expect(Math.hypot(tip.x - lower.group.position.x, tip.y - lower.group.position.y)).toBeCloseTo(
      0.64,
      6,
    );
  });

  it("writes the z offset to both segments so limbs stay on their own plane", () => {
    const upper = makeSegment(0.68);
    const lower = makeSegment(0.64);
    solveLimbIK({ x: 0, y: 2 }, { x: -0.5, y: 1.5 }, 0.68, 0.64, 1, upper, lower, 0.32);
    expect(upper.group.position.z).toBe(0.32);
    expect(lower.group.position.z).toBe(0.32);
  });

  it("clamps an out-of-reach target to full extension instead of failing", () => {
    const root = { x: 0, y: 0 };
    const upper = makeSegment(0.68);
    const lower = makeSegment(0.64);

    solveLimbIK(root, { x: 10, y: 0 }, 0.68, 0.64, 1, upper, lower, 0);

    const tip = segmentTip(lower);
    expect(Number.isFinite(tip.x)).toBe(true);
    expect(Number.isFinite(tip.y)).toBe(true);
    const reach = Math.hypot(tip.x - root.x, tip.y - root.y);
    expect(reach).toBeLessThanOrEqual(0.68 + 0.64 + 1e-9);
    // Clamped, not collapsed: the arm goes straight toward the target instead of
    // folding, which is what keeps a too-far hand from detaching from the lever.
    expect(reach).toBeGreaterThan(0.68 + 0.64 - 0.05);
  });

  it("survives a fully collapsed target without producing NaN", () => {
    // A zero-length limb chain would divide by zero in the law of cosines; the
    // demo floors the distance at 0.05 and clamps the cosine, and this is the
    // assertion that the floor survived the port.
    const upper = makeSegment(0.68);
    const lower = makeSegment(0.64);
    solveLimbIK({ x: 1, y: 1 }, { x: 1, y: 1 }, 0.68, 0.64, 1, upper, lower, 0);
    for (const segment of [upper, lower]) {
      const tip = segmentTip(segment);
      expect(Number.isFinite(tip.x)).toBe(true);
      expect(Number.isFinite(tip.y)).toBe(true);
      expect(Number.isFinite(segment.group.rotation.z)).toBe(true);
    }
  });

  it("bends the knee to the side bendDir asks for", () => {
    const root = { x: -3.02, y: 1.38 };
    const target = { x: -3.55, y: 0.06 };
    const upA = makeSegment(0.84);
    const loA = makeSegment(0.82);
    const upB = makeSegment(0.84);
    const loB = makeSegment(0.82);

    solveLimbIK(root, target, 0.84, 0.82, 1, upA, loA, 0.28);
    solveLimbIK(root, target, 0.84, 0.82, -1, upB, loB, 0.28);

    const sideA = sideOf(root, target, { x: loA.group.position.x, y: loA.group.position.y });
    const sideB = sideOf(root, target, { x: loB.group.position.x, y: loB.group.position.y });
    expect(sideA).not.toBe(sideB);
    // Both solutions still land the foot in the same place.
    expect(Math.hypot(segmentTip(loA).x - target.x, segmentTip(loA).y - target.y)).toBeLessThan(1e-3);
    expect(Math.hypot(segmentTip(loB).x - target.x, segmentTip(loB).y - target.y)).toBeLessThan(1e-3);
  });

  it("never exceeds len1 + len2 across a sweep of targets", () => {
    const len1 = 0.84;
    const len2 = 0.82;
    const root = { x: -3.02, y: 1.38 };
    for (let ix = -12; ix <= 4; ix++) {
      for (let iy = -6; iy <= 8; iy++) {
        const target = { x: root.x + ix * 0.5, y: root.y + iy * 0.4 };
        const upper = makeSegment(len1);
        const lower = makeSegment(len2);
        solveLimbIK(root, target, len1, len2, ix % 2 === 0 ? 1 : -1, upper, lower, 0);
        const tip = segmentTip(lower);
        expect(Number.isFinite(tip.x)).toBe(true);
        expect(Number.isFinite(tip.y)).toBe(true);
        expect(Math.hypot(tip.x - root.x, tip.y - root.y)).toBeLessThanOrEqual(len1 + len2 + 1e-9);
      }
    }
  });
});
