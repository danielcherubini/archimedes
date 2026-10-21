import { describe, expect, it, vi } from "vitest";

import {
  BAND_COUNT,
  CHAR_RAMP,
  DRAW_THRESHOLD_LUM,
  FILM_ASPECT,
  FILM_CELL_ASPECT,
  FILM_GLYPH_COLOR_CLASS,
  GRID_TIERS,
  MIN_CELL_HEIGHT_PX,
  SOBEL_EDGE_THRESHOLD,
  bandFor,
  chooseTier,
  containBox,
  drawGrid,
  glyphFor,
  measureAdvanceRatio,
  resolveTokenColor,
  type GlyphSink,
  type GridTier,
} from "./compositor";

/**
 * The ASCII film compositor: a luminance grid in, glyph draw calls out.
 *
 * Three of the assertions below exist because of a MEASURED environment rather
 * than taste, so the measurement is stated where it bites:
 *
 *  - jsdom returns `null` from `canvas.getContext("2d")`, so nothing in this
 *    file ever constructs a real 2D context. The sink is a recording fake, and
 *    the only "context" here is the hand-rolled fake `measureAdvanceRatio` reads.
 *  - `(230 * 0.58) / 115` evaluates to `1.1599999999999997`, NOT `1.16`, so
 *    `FILM_ASPECT` is pinned with `toBeCloseTo(…, 6)`; `toBe(1.16)` fails.
 *  - A tier's aspect is `2 × 0.58` exactly only when `cols === 2 * rows`:
 *    `115×58` is `1.15` and silently STRETCHES the render, so one loop over
 *    `GRID_TIERS` makes that whole bug class unrepresentable.
 *
 * Two behaviours are the feature's own decisions, not incidental geometry, so
 * they are asserted (ADR 0071): a cell below the draw threshold produces NO
 * sink call at all — the canvas keeps its alpha and the pane's `--color-chat`
 * shows through, which is why no letterbox bars are needed — and a same-band
 * run collapses into ONE `drawRun` call carrying the concatenated glyphs, so
 * colour strings are built 8× a frame instead of 26,000×.
 */

// Node's fs through a COMPUTED specifier — this app ships no `@types/node`, so a
// bare `node:fs` would not typecheck (the idiom `src/lib/cssSource.ts` uses).
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

const COMPOSITOR_SOURCE = "src/lib/archimedes-film/compositor.ts";

/** One recorded `drawRun` call. */
interface RecordedRun {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly band: number;
}

/** A `GlyphSink` that records every call. Never paints, never touches a context. */
function recordingSink(): { sink: GlyphSink; calls: RecordedRun[] } {
  const calls: RecordedRun[] = [];
  return {
    calls,
    sink: {
      drawRun: (text, x, y, band) => {
        calls.push({ text, x, y, band });
      },
    },
  };
}

const TIER_16x8: GridTier = { cols: 16, rows: 8 };
const TIER_4x1: GridTier = { cols: 4, rows: 1 };
const TIER_1x1: GridTier = { cols: 1, rows: 1 };

const gridOf = (tier: GridTier, lum: (x: number, y: number) => number): Float32Array => {
  // A Float32Array, because that is what the scene hands over (Task 4) and what
  // the demo read back out of `gl.readPixels`.
  const out = new Float32Array(tier.cols * tier.rows);
  for (let y = 0; y < tier.rows; y++) {
    for (let x = 0; x < tier.cols; x++) out[y * tier.cols + x] = lum(x, y);
  }
  return out;
};

const constantGrid = (tier: GridTier, lum: number): Float32Array => gridOf(tier, () => lum);

/** The four glyphs the Sobel branch may emit. `_` and `\` appear in no ramp. */
const EDGE_GLYPHS = ["/", "_", "\\", "|"];

describe("the constants", () => {
  it("copies the demo's ramp verbatim: 68 characters, space to full block", () => {
    expect(CHAR_RAMP.length).toBe(68);
    expect(CHAR_RAMP[0]).toBe(" ");
    expect(CHAR_RAMP[67]).toBe("\u2588");
  });

  it("pins the aspect as the FLOAT the expression yields, not 1.16", () => {
    // `1.16` and `(230 * 0.58) / 115` are different doubles — the second is
    // 1.1599999999999997 — so `toBe(1.16)` fails on correct code.
    expect(FILM_ASPECT).toBeCloseTo(1.16, 6);
    expect(FILM_ASPECT).toBe((230 * 0.58) / 115);
    expect(FILM_CELL_ASPECT).toBe(0.58);
  });

  it("keeps every tier at a 2:1 grid so no tier can stretch the render", () => {
    // cols/rows must be EXACTLY 2 for the cell aspect (FILM_CELL_ASPECT) to put
    // the box back on FILM_ASPECT. 115x58 — the tempting off-by-one — is 1.15.
    expect(GRID_TIERS.length).toBeGreaterThan(0);
    for (const tier of GRID_TIERS) {
      expect(tier.cols).toBe(2 * tier.rows);
      expect(tier.rows).toBeGreaterThan(0);
    }
    // Largest first, and the demo's own 230x115 leads.
    expect(GRID_TIERS[0]).toEqual({ cols: 230, rows: 115 });
    const sizes = GRID_TIERS.map((tier) => tier.cols * tier.rows);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it("pins the tuning numbers the rest of the feature quotes", () => {
    expect(BAND_COUNT).toBe(8);
    expect(DRAW_THRESHOLD_LUM).toBe(0.015);
    expect(SOBEL_EDGE_THRESHOLD).toBe(0.22);
    expect(MIN_CELL_HEIGHT_PX).toBe(4);
    // The probe's class name is what earns the `.text-film-glyph` utility rule
    // in the built CSS, so it is a contract with the BUILD, not a detail.
    expect(FILM_GLYPH_COLOR_CLASS).toBe("text-film-glyph");
  });
});

describe("containBox", () => {
  it("fits the film inside a wide box without stretching it", () => {
    const box = containBox(800, 600);
    expect(box.width).toBeCloseTo(696, 3);
    expect(box.height).toBeCloseTo(600, 3);
  });

  it("fits the film inside a tall box, and returns UNROUNDED floats", () => {
    const box = containBox(600, 900);
    expect(box.width).toBeCloseTo(600, 3);
    expect(box.height).toBeCloseTo(517.241, 3);
    // Rounding is not cosmetic here: 600/517 = 1.16054…, which is 5.4e-4 off the
    // aspect — a rounded integer breaks this very assertion at precision 3 and
    // 6. The caller rounds when assigning canvas.width/height; the maths may not.
    expect(box.width / box.height).toBeCloseTo(FILM_ASPECT, 6);
  });

  it("holds the aspect for a wide, a tall and a square input", () => {
    for (const [w, h] of [[800, 600], [600, 900], [500, 500]] as const) {
      const box = containBox(w, h);
      expect(box.width / box.height).toBeCloseTo(FILM_ASPECT, 6);
      expect(box.width).toBeLessThanOrEqual(w + 1e-9);
      expect(box.height).toBeLessThanOrEqual(h + 1e-9);
    }
  });

  it("never enlarges: the contained box touches at least one edge", () => {
    expect(containBox(800, 600).height).toBeCloseTo(600, 9);
    expect(containBox(600, 900).width).toBeCloseTo(600, 9);
  });

  it("survives a degenerate box instead of returning NaN", () => {
    for (const [w, h] of [[0, 0], [0, 600], [800, 0]] as const) {
      const box = containBox(w, h);
      expect(Number.isFinite(box.width)).toBe(true);
      expect(Number.isFinite(box.height)).toBe(true);
      expect(box.width).toBeGreaterThanOrEqual(0);
      expect(box.height).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("bandFor", () => {
  it("emits NOTHING below the draw threshold — the transparency mechanism", () => {
    expect(bandFor(0)).toBeNull();
    expect(bandFor(0.01)).toBeNull();
    expect(bandFor(DRAW_THRESHOLD_LUM - 1e-9)).toBeNull();
  });

  it("draws at and above the threshold, inside the band range", () => {
    expect(bandFor(DRAW_THRESHOLD_LUM)).not.toBeNull();
    const band = bandFor(0.9);
    expect(band).not.toBeNull();
    expect(Number.isInteger(band)).toBe(true);
    expect(band!).toBeGreaterThanOrEqual(0);
    expect(band!).toBeLessThan(BAND_COUNT);
  });

  it("is monotonic and clamps the top of the range", () => {
    expect(bandFor(1)).toBe(BAND_COUNT - 1);
    const ascending = [0.02, 0.2, 0.4, 0.6, 0.8, 1].map((lum) => bandFor(lum)!);
    for (let i = 1; i < ascending.length; i++) {
      expect(ascending[i]).toBeGreaterThanOrEqual(ascending[i - 1]);
    }
    expect(ascending[ascending.length - 1]).toBeGreaterThan(ascending[0]);
  });

  it("applies only the cut and the quantisation — no vignette, no tone curve", () => {
    // Task 4 owns `Math.pow(lum, 1.85) * vignette * 0.65` and the `lum < 0.04`
    // crushed-black branch. Re-applying either here is what would make an
    // all-0.9 grid lose its corners; position is not an input to bandFor.
    expect(bandFor(0.9)).toBe(bandFor(0.9));
    expect(bandFor(0.9)).toBe(Math.min(BAND_COUNT - 1, Math.floor(0.9 * BAND_COUNT)));
    expect(bandFor(0.05)).toBe(Math.min(BAND_COUNT - 1, Math.floor(0.05 * BAND_COUNT)));
  });

  it("never picks the blank ramp glyph, because the cut sits above its bucket", () => {
    // The ramp's index 0 is a space and that whole bucket is lum < 1/67 ≈
    // 0.01493, strictly under DRAW_THRESHOLD_LUM. So a cell that IS drawn is
    // never drawn invisible — the threshold and the ramp cannot drift apart
    // silently, because this loop fails the moment they do.
    for (let i = 1; i <= 1000; i++) {
      const lum = i / 1000;
      if (bandFor(lum) === null) continue;
      expect(CHAR_RAMP[Math.min(67, Math.floor(lum * 67))]).not.toBe(" ");
    }
  });
});

describe("glyphFor", () => {
  /**
   * A 3x3 grid with an independent gradient around the centre cell: `gx` is
   * right − left, `gy` is down − up, so the caller sets each axis exactly.
   */
  const centreGradient = (gx: number, gy: number): Float32Array => {
    const g = new Float32Array(9);
    g.fill(0.5);
    g[3] = 0.5 - gx / 2; // left of centre
    g[5] = 0.5 + gx / 2; // right
    g[1] = 0.5 - gy / 2; // above
    g[7] = 0.5 + gy / 2; // below
    return g;
  };

  it("picks an edge glyph for a strong horizontal gradient", () => {
    const tier: GridTier = { cols: 8, rows: 4 };
    const rising = gridOf(tier, (x) => x * 0.3);
    const g = glyphFor(rising, tier.cols, tier.rows, 3, 2);
    expect(EDGE_GLYPHS).toContain(g);
    // Brighter to the RIGHT is a vertical contour.
    expect(g).toBe("|");
  });

  it("maps each gradient direction to its own glyph, as the demo does", () => {
    // deg = (atan2(gy, gx) in degrees + 180) % 180, then 22.5/67.5/112.5/157.5.
    expect(glyphFor(centreGradient(0.6, 0), 3, 3, 1, 1)).toBe("|");
    expect(glyphFor(centreGradient(0, 0.6), 3, 3, 1, 1)).toBe("_");
    expect(glyphFor(centreGradient(-0.6, 0.6), 3, 3, 1, 1)).toBe("\\");
    expect(glyphFor(centreGradient(0.6, 0.6), 3, 3, 1, 1)).toBe("/");
  });

  it("falls back to the ramp on a flat region, and on a gradient under the threshold", () => {
    const flat = constantGrid({ cols: 5, rows: 5 }, 0.5);
    const g = glyphFor(flat, 5, 5, 2, 2);
    expect(EDGE_GLYPHS).not.toContain(g);
    expect(g).toBe(CHAR_RAMP[Math.floor(0.5 * 67)]);

    // A gradient below SOBEL_EDGE_THRESHOLD is texture, not an edge: the same
    // direction that produced "|" above must now produce a ramp character.
    const gentle = centreGradient(SOBEL_EDGE_THRESHOLD / 3, 0);
    const weak = glyphFor(gentle, 3, 3, 1, 1);
    expect(EDGE_GLYPHS).not.toContain(weak);
    expect(CHAR_RAMP).toContain(weak);
  });

  it("clamps at the four borders instead of reading a neighbour off the grid", () => {
    const tier: GridTier = { cols: 4, rows: 4 };
    const ramp = gridOf(tier, (x, y) => x * 0.4 + y * 0.1);
    for (const [x, y] of [
      [0, 0],
      [3, 0],
      [0, 3],
      [3, 3],
      [0, 1],
      [3, 2],
      [1, 0],
      [2, 3],
    ] as const) {
      const g = glyphFor(ramp, tier.cols, tier.rows, x, y);
      expect(g.length).toBe(1);
      expect(EDGE_GLYPHS.includes(g) || CHAR_RAMP.includes(g)).toBe(true);
    }
    // A 1x1 grid has no neighbours at all, and must still answer.
    expect(glyphFor(new Float32Array([0.7]), 1, 1, 0, 0).length).toBe(1);
  });

  it("indexes the ramp the demo's way: floor(lum × (len − 1)), clamped", () => {
    const tier: GridTier = { cols: 3, rows: 3 };
    expect(glyphFor(constantGrid(tier, 1), 3, 3, 1, 1)).toBe(CHAR_RAMP[67]);
    expect(glyphFor(constantGrid(tier, 0.02), 3, 3, 1, 1)).toBe(CHAR_RAMP[Math.floor(0.02 * 67)]);
  });
});

describe("drawGrid", () => {
  it("calls the sink NOT AT ALL on a dark grid, and reports zero lit cells", () => {
    const { sink, calls } = recordingSink();
    const lit = drawGrid(constantGrid(TIER_16x8, 0), TIER_16x8, 696, 600, sink);
    expect(lit).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("skips a sub-threshold cell without clearing it (ADR 0071)", () => {
    // The demo's `continue`, kept: no call is issued for a dark cell, so the
    // canvas keeps its alpha there and the pane shows through. A `clearRect`,
    // a black `fillRect` or a space glyph would all satisfy the call count and
    // still break the transparency — hence the x-position assertions.
    const { sink, calls } = recordingSink();
    const cells = new Float32Array([0.05, 0.05, 0.01, 0.5]);
    const lit = drawGrid(cells, TIER_4x1, 400, 100, sink);
    const cellW = 400 / TIER_4x1.cols;
    expect(lit).toBe(3);
    expect(calls).toHaveLength(2); // one run of two, then one run of one
    expect(calls.map((c) => c.text.length)).toEqual([2, 1]);
    expect(calls[0].x).toBeCloseTo(0, 9);
    expect(calls[1].x).toBeCloseTo(3 * cellW, 9);
    expect(calls.some((c) => Math.abs(c.x - 2 * cellW) < 1e-9)).toBe(false);
  });

  it("stores the threshold honestly at Float32 precision", () => {
    // A grid is a Float32Array, so a value written at exactly
    // DRAW_THRESHOLD_LUM is stored as 0.014999999664723873 — just UNDER it. A
    // scene that wants a cell drawn must clear the threshold, not touch it;
    // pinning this now beats discovering it as a flickering cell in Task 5.
    const atThreshold = new Float32Array([DRAW_THRESHOLD_LUM]);
    const below = new Float32Array([DRAW_THRESHOLD_LUM * 1.01]);
    expect(drawGrid(atThreshold, TIER_1x1, 100, 100, recordingSink().sink)).toBe(0);
    expect(drawGrid(below, TIER_1x1, 100, 100, recordingSink().sink)).toBe(1);
  });

  it("collapses an all-lit 16x8 grid into one run per row, losing no glyph", () => {
    const { sink, calls } = recordingSink();
    const lit = drawGrid(constantGrid(TIER_16x8, 0.9), TIER_16x8, 696, 600, sink);
    expect(lit).toBe(128);
    // The batching is real: 8 calls, not 128 (measured ~12ms → ~3ms per frame).
    expect(calls).toHaveLength(8);
    expect(calls.length).toBeLessThan(128);
    expect(calls.reduce((sum, c) => sum + c.text.length, 0)).toBe(128);

    const cellH = 600 / TIER_16x8.rows;
    const expectedRow = Array.from({ length: 16 }, (_, x) =>
      glyphFor(constantGrid(TIER_16x8, 0.9), 16, 8, x, 0),
    ).join("");
    calls.forEach((call, row) => {
      expect(call.text.length).toBe(16);
      // A run starts at the row's left edge, and at the row's baseline.
      expect(call.x).toBeCloseTo(0, 9);
      expect(call.y).toBeCloseTo(row * cellH, 9);
      expect(call.band).toBe(bandFor(0.9));
      // The run carries exactly the glyphs one-per-cell would have produced.
      expect(call.text).toBe(expectedRow);
    });
  });

  it("splits a run where the band changes, keeping one call per run", () => {
    const { sink, calls } = recordingSink();
    const cells = new Float32Array([0.2, 0.2, 0.9, 0.9]);
    const lit = drawGrid(cells, TIER_4x1, 400, 100, sink);
    expect(lit).toBe(4);
    expect(calls).toHaveLength(2);
    expect(calls[0].band).toBe(bandFor(0.2));
    expect(calls[1].band).toBe(bandFor(0.9));
    expect(calls.map((c) => c.text.length)).toEqual([2, 2]);
    const cellW = 400 / 4;
    expect(calls[0].x).toBeCloseTo(0, 9);
    expect(calls[1].x).toBeCloseTo(2 * cellW, 9);
    expect(calls.every((c) => c.y === 0)).toBe(true);
  });

  it("splits a run around a dark cell, and the dark glyph appears in no call", () => {
    const { sink, calls } = recordingSink();
    const cells = new Float32Array([0.9, 0.9, 0.01, 0.9]);
    const lit = drawGrid(cells, TIER_4x1, 400, 100, sink);
    expect(lit).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls.reduce((sum, c) => sum + c.text.length, 0)).toBe(3);
    expect(calls.map((c) => c.text.length)).toEqual([2, 1]);
    const cellW = 400 / 4;
    expect(calls[0].x).toBeCloseTo(0, 9);
    expect(calls[1].x).toBeCloseTo(3 * cellW, 9);
  });

  it("never carries a run across a row boundary", () => {
    const { sink, calls } = recordingSink();
    const tier: GridTier = { cols: 2, rows: 3 };
    const lit = drawGrid(constantGrid(tier, 0.9), tier, 200, 300, sink);
    expect(lit).toBe(6);
    expect(calls).toHaveLength(3);
    const ys = calls.map((c) => c.y);
    expect(new Set(ys).size).toBe(3);
    // Glyph placement is y * cellH, cellH = boxHeight / rows.
    expect([...ys].sort((a, b) => a - b)).toEqual([0, 100, 200]);
  });

  it("emits only ramp or edge glyphs, and never a blank one", () => {
    const tier: GridTier = { cols: 12, rows: 6 };
    const noisy = gridOf(tier, (x, y) => ((x * 7 + y * 13) % 11) / 12);
    const { sink, calls } = recordingSink();
    const lit = drawGrid(noisy, tier, 600, 300, sink);
    const all = calls.map((c) => c.text).join("");
    expect(all.length).toBe(lit);
    for (const ch of all) {
      expect(EDGE_GLYPHS.includes(ch) || CHAR_RAMP.includes(ch)).toBe(true);
      expect(ch).not.toBe(" ");
    }
    for (const call of calls) {
      expect(call.band).toBeGreaterThanOrEqual(0);
      expect(call.band).toBeLessThan(BAND_COUNT);
    }
  });

  it("reports the lit-cell count Task 5 judges liveness by (ADR 0070)", () => {
    // A wholly sub-threshold frame must read as DEAD, not as "drew something",
    // or the fallback never takes over from a film that has gone black.
    const dead = drawGrid(constantGrid(TIER_1x1, 0.014), TIER_1x1, 100, 100, recordingSink().sink);
    const alive = drawGrid(constantGrid(TIER_1x1, 0.02), TIER_1x1, 100, 100, recordingSink().sink);
    expect(dead).toBe(0);
    expect(alive).toBe(1);
  });

  it("never calls the sink more times than there are lit cells", () => {
    const tier: GridTier = { cols: 20, rows: 10 };
    const mixed = gridOf(tier, (x, y) => (x % 3 === 0 ? 0.9 : (x + y) % 5 === 0 ? 0 : 0.4));
    const { sink, calls } = recordingSink();
    const lit = drawGrid(mixed, tier, 800, 400, sink);
    expect(lit).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(lit);
    expect(calls.reduce((sum, c) => sum + c.text.length, 0)).toBe(lit);
  });
});

describe("chooseTier", () => {
  it("takes the largest tier when the box is tall enough for 4px cells", () => {
    expect(chooseTier(1600, 900)).toEqual(GRID_TIERS[0]);
    expect(chooseTier(800, 600)).toEqual(GRID_TIERS[0]);
  });

  it("steps down when the top tier's cells would fall under MIN_CELL_HEIGHT_PX", () => {
    // 464x400 contains a 464x400 box: 400/115 = 3.48px is under the floor,
    // 400/80 = 5px clears it.
    expect(chooseTier(464, 400)).not.toEqual(GRID_TIERS[0]);
    const tier = chooseTier(464, 400);
    expect(tier.cols).toBeLessThan(GRID_TIERS[0].cols);
    expect(containBox(464, 400).height / tier.rows).toBeGreaterThanOrEqual(MIN_CELL_HEIGHT_PX);
  });

  it("never returns a tier under the cell floor when a smaller one would fit", () => {
    for (const [w, h] of [[1920, 1080], [800, 600], [464, 400], [300, 260], [240, 200]] as const) {
      const box = containBox(w, h);
      const chosen = chooseTier(w, h);
      const anyFits = GRID_TIERS.some((t) => box.height / t.rows >= MIN_CELL_HEIGHT_PX);
      if (anyFits) expect(box.height / chosen.rows).toBeGreaterThanOrEqual(MIN_CELL_HEIGHT_PX);
      // And it never skips past a tier that would have fit — largest first.
      if (anyFits) {
        const index = GRID_TIERS.indexOf(chosen);
        for (let i = 0; i < index; i++) {
          expect(box.height / GRID_TIERS[i].rows).toBeLessThan(MIN_CELL_HEIGHT_PX);
        }
      }
      expect(GRID_TIERS).toContain(chosen);
    }
  });

  it("still answers a box too small for every tier, instead of throwing", () => {
    const chosen = chooseTier(80, 40);
    expect(GRID_TIERS).toContain(chosen);
    expect(chosen).toEqual(GRID_TIERS[GRID_TIERS.length - 1]);
    // Degenerate input must not hand NaN geometry downstream.
    for (const [w, h] of [[0, 0], [-100, 200]] as const) {
      expect(GRID_TIERS).toContain(chooseTier(w, h));
    }
  });
});

describe("resolveTokenColor", () => {
  it("reads a computed `color`, so the string is something canvas can parse", () => {
    const color = resolveTokenColor(FILM_GLYPH_COLOR_CLASS);
    expect(typeof color).toBe("string");
    expect(color.length).toBeGreaterThan(0);
    // The whole reason for the probe element: getPropertyValue of the custom
    // property hands back the unresolved `color-mix(…)`, which fillStyle cannot
    // parse. A computed `color` is always a concrete colour.
    expect(color).not.toContain("color-mix");
    expect(color).not.toContain("var(");
    expect(color).not.toContain("--color-");
  });

  it("resolves the default class to the inherited colour under jsdom", () => {
    // No stylesheet is loaded in jsdom, so `.text-film-glyph` matches nothing
    // and the probe element simply inherits. Do NOT read a wrong answer here and
    // do not invent a sentinel for "unresolved": the guard against a missing
    // utility rule is the built-CSS grep, not this function.
    expect(resolveTokenColor()).toBe("rgb(0, 0, 0)");
    expect(resolveTokenColor("text-a-class-nobody-emits")).toBe("rgb(0, 0, 0)");
  });

  it("applies the class by NAME (Tailwind must scan it), never an inline style", () => {
    const created: HTMLElement[] = [];
    const realCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag);
      created.push(el);
      return el;
    });
    try {
      resolveTokenColor(FILM_GLYPH_COLOR_CLASS);
    } finally {
      spy.mockRestore();
    }
    expect(created).toHaveLength(1);
    expect(created[0].className).toBe(FILM_GLYPH_COLOR_CLASS);
    // An inline `style.color` is invisible to Tailwind's scanner, so the
    // `.text-film-glyph` rule would never be generated and the film would paint
    // black-on-black while every jsdom test stayed green.
    expect(created[0].style.color).toBe("");
    // The probe is a guest: it leaves again, whether it was attached or not.
    expect(document.body.contains(created[0])).toBe(false);
  });

  it("measures the probe while it is ATTACHED to the live tree", () => {
    // jsdom cannot tell the two apart — an unstyled class computes to
    // `rgb(0, 0, 0)` attached or detached — so the contract is checked
    // structurally. The palette classes (`.dark`, `.theme-dracula`, …) sit on the
    // root element, so a probe left detached resolves against nothing and would
    // read the `@theme` default instead of the theme the user actually picked:
    // a wrong colour that no jsdom test could ever see.
    const realCompute = getComputedStyle;
    const sawAttached: boolean[] = [];
    vi.stubGlobal("getComputedStyle", (el: Element) => {
      sawAttached.push(el.isConnected === true && document.contains(el));
      return realCompute(el);
    });
    try {
      resolveTokenColor(FILM_GLYPH_COLOR_CLASS);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sawAttached).toHaveLength(1);
    expect(sawAttached[0]).toBe(true);
  });

  it("leaves the document as it found it", () => {
    const before = document.body.childElementCount;
    resolveTokenColor(FILM_GLYPH_COLOR_CLASS);
    resolveTokenColor(FILM_GLYPH_COLOR_CLASS);
    expect(document.body.childElementCount).toBe(before);
  });

  it("returns the empty string when the DOM APIs are absent, and never throws", () => {
    // A caller running before the DOM exists (or in a worker) must get a value
    // it can pass straight to its fallback path, not an exception. `""` is the
    // ONLY case that returns empty.
    vi.stubGlobal("document", undefined);
    try {
      expect(resolveTokenColor(FILM_GLYPH_COLOR_CLASS)).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("getComputedStyle", undefined);
    try {
      expect(resolveTokenColor(FILM_GLYPH_COLOR_CLASS)).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
    // And the stubs really were temporary — later tests still have a DOM.
    expect(typeof document).toBe("object");
    expect(typeof getComputedStyle).toBe("function");
    expect(resolveTokenColor(FILM_GLYPH_COLOR_CLASS)).toBe("rgb(0, 0, 0)");
  });
});

describe("measureAdvanceRatio", () => {
  /** A fake context: `measureText` answers a fixed width and records what it was asked. */
  const fakeContext = (advance: number) => {
    const measured: string[] = [];
    const ctx = {
      font: "",
      measured,
      measureText: (text: string) => {
        measured.push(text);
        return { width: advance };
      },
    };
    return ctx as unknown as CanvasRenderingContext2D & { measured: string[] };
  };

  it("derives the ratio from measureText, so glyph size can follow cell WIDTH", () => {
    const ctx = fakeContext(6);
    const ratio = measureAdvanceRatio(ctx, '10px "Fira Code", monospace');
    expect(ratio).toBeCloseTo(0.6, 9);
    expect(Number.isFinite(ratio)).toBe(true);
    expect(ratio).toBeGreaterThan(0);
    // The font must be set BEFORE measuring, or it measures the default face —
    // and `--font-mono` is user-changeable, so the default face is the wrong answer.
    expect(ctx.font).toBe('10px "Fira Code", monospace');
    expect(ctx.measured).toEqual(["M"]);
  });

  it("measures with the requested font ALREADY installed", () => {
    // The fake records the font as it stood at the moment it was asked to
    // measure, which is the only way to see the ordering: asserting the final
    // value of `ctx.font` passes whether the assignment came before or after,
    // and measuring the default face is precisely the bug (the demo sized the
    // font off cell HEIGHT with Courier New's metrics in mind).
    const measured: { text: string; font: string }[] = [];
    const ctx = {
      font: "10px serif",
      measureText: (text: string) => {
        measured.push({ text, font: ctx.font });
        return { width: 6 };
      },
    } as unknown as CanvasRenderingContext2D;

    const ratio = measureAdvanceRatio(ctx, '700 10px "Fira Code", monospace');
    expect(ratio).toBeCloseTo(0.6, 9);
    expect(measured.map((m) => m.text)).toEqual(["M"]);
    expect(measured[0].font).toBe('700 10px "Fira Code", monospace');
  });

  it("finds the size past a weight and a family list", () => {
    const ctx = fakeContext(7);
    const ratio = measureAdvanceRatio(ctx, '700 14px "Fira Code", monospace');
    expect(ratio).toBeCloseTo(0.5, 9);
    expect(ctx.font).toBe('700 14px "Fira Code", monospace');
  });

  it("answers a malformed spec with a usable ratio rather than NaN or Infinity", () => {
    const ctx = fakeContext(6);
    for (const spec of ["", "monospace", "11px"]) {
      const ratio = measureAdvanceRatio(ctx, spec);
      expect(Number.isFinite(ratio)).toBe(true);
      expect(ratio).toBeGreaterThan(0);
    }
  });
});

describe("the module's own boundaries", () => {
  it("imports nothing from three.js, React, or any stylesheet", () => {
    // The compositor is the half of the feature that has to stay testable in
    // jsdom and reusable outside the film; the seam with the scene is a
    // Float32Array, so the module needs no imports at all. That is the strongest
    // form of the rule, and it is what makes Task 5's `static` state cheap.
    const source = readFileSync(COMPOSITOR_SOURCE, "utf8");
    const specifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    const requires = [...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of [...specifiers, ...requires]) {
      expect(spec).not.toMatch(/three/);
      expect(spec).not.toMatch(/^react/);
      expect(spec).not.toMatch(/\.css$/);
    }
    expect(specifiers).toEqual([]);
    expect(requires).toEqual([]);
    expect(source).not.toContain("getContext");
  });

  it("carries the utility class as a literal, where Tailwind's scanner can see it", () => {
    // Tailwind v4 emits `.text-film-glyph{color:var(--color-film-glyph)}` only
    // when a SCANNED source names the class, so the literal must live in this
    // file's code — prose in a markdown file satisfies the build's grep while
    // shipping a component that never asks for the rule.
    const source = readFileSync(COMPOSITOR_SOURCE, "utf8");
    expect(source).toContain('"text-film-glyph"');
    // And it reaches the probe as a CLASS, which is the only form the scanner reads.
    expect(source).toMatch(/\.className\s*=/);
  });
});
