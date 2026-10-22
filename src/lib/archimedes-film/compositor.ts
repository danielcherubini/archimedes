/**
 * The ASCII film compositor — a luminance grid in, glyph draw calls out.
 *
 * This is the ported logic of the reference demo's `renderAsciiVideoFrame`, kept
 * as pure functions over a `Float32Array` so the module knows nothing about
 * three.js, React, or the DOM beyond one colour probe. That seam is deliberate:
 * the scene (Task 4) owns the camera, the lights and the **tone curve** —
 * `Math.pow(lum, 1.85) * vignette * 0.65` and the `lum < 0.04` crushed-black
 * branch — and hands this file final luminance. Nothing here re-applies a
 * vignette or a curve: `bandFor` sees a value and no position, which is exactly
 * why an all-`0.9` grid lights every cell instead of losing its corners.
 *
 * Two behaviours are the decisions the feature was asked for, so they are load
 * bearing rather than incidental (ADR 0071):
 *
 *  1. **Skip, never clear.** A cell below `DRAW_THRESHOLD_LUM` produces NO sink
 *     call at all. The 2D canvas keeps its alpha channel, the pane's
 *     `--color-chat` shows through, and the film therefore needs neither
 *     letterbox bars nor a scrim — which is why the demo's `alpha: false`
 *     context and its full-canvas black `fillRect` are both gone.
 *  2. **One call per same-band run.** `drawGrid` walks each row and collapses
 *     consecutive same-band cells into a single `drawRun` carrying the
 *     concatenated glyphs (measured ~12ms → ~3ms per frame at the top tier). The
 *     sink takes a `band` INDEX, not a colour string, so the caller builds eight
 *     colour strings a frame instead of twenty-six thousand (ADR 0062: the
 *     palette owns the hue, this file only owns how strongly it is lit).
 *
 * It is also the half of the feature that stays testable in jsdom, where the 2D
 * context factory returns `null` — so this file must never need a real context,
 * and `measureAdvanceRatio` takes one as a parameter instead of making it.
 */

/**
 * The demo's luminance ramp, verbatim: index 0 is a space and index 67 is a full
 * block, so brightness is carried by glyph DENSITY as well as by colour. The
 * string is copied rather than re-derived because the ordering is hand-tuned —
 * it is what makes a mid-tone read as texture instead of as noise.
 */
export const CHAR_RAMP: string =
  " .`',:;-~=+*!|/?()[]{}<>iIl1tfjrxnuvczXYUJCLQ0OZmwqpdbkhao#MW&8%B@$█";

/**
 * Width ÷ height of one glyph cell in the demo, and the reason the grid is a 2:1
 * aspect: characters are tall, and a square cell would draw the film stretched.
 */
export const FILM_CELL_ASPECT = 0.58;

/**
 * The film's own aspect ratio, from the demo's camera (`GRID_COLS * 0.58 /
 * GRID_ROWS`). Note the value is `1.1599999999999997`, not `1.16` — `230 * 0.58`
 * is not exactly `133.4` — so every comparison against it belongs at
 * `toBeCloseTo`, and `containBox` must hand back floats (see its comment).
 */
export const FILM_ASPECT = (230 * FILM_CELL_ASPECT) / 115;

/** A grid resolution the film can be drawn at. */
export interface GridTier {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Resolutions, largest first. `cols` MUST be exactly `2 * rows`: the cell aspect
 * is `FILM_CELL_ASPECT`, so only a 2:1 grid puts the drawn box back on
 * `FILM_ASPECT` — `115×58` would be 1.15 and would silently stretch the render
 * on every small window. `230×115` is the demo's own grid.
 */
export const GRID_TIERS: readonly GridTier[] = [
  { cols: 230, rows: 115 },
  { cols: 160, rows: 80 },
  { cols: 116, rows: 58 },
];

/** Below this, a cell is a smudge rather than a glyph: drop a tier instead. */
export const MIN_CELL_HEIGHT_PX = 4;

/**
 * The largest box of `FILM_ASPECT` that fits inside `(w, h)` — contain, never
 * cover, never stretch.
 *
 * The floats are returned UNROUNDED on purpose. The caller rounds when it
 * assigns `canvas.width`/`height`, and rounding here would break the aspect:
 * `(600, 900)` contains a box of 600 × 517.2413793103448, and rounding the
 * height to 517 makes the ratio 1.16054…, which is 5.4e-4 off `FILM_ASPECT` —
 * too much for the precision-6 comparison the tests make, and invisible to the
 * eye either way. A degenerate box answers 0 rather than NaN, so downstream
 * geometry stays arithmetable.
 */
export function containBox(w: number, h: number): { width: number; height: number } {
  const width = Math.max(0, w);
  const height = Math.max(0, h);
  const widthLimited = height * FILM_ASPECT > width;
  return widthLimited ? { width, height: width / FILM_ASPECT } : { width: height * FILM_ASPECT, height };
}

/**
 * The resolution to draw at: the largest tier whose cells are at least
 * `MIN_CELL_HEIGHT_PX` tall. Cell HEIGHT is the criterion (not width) because
 * row count is what a short pane runs out of first — and with the aspect fixed,
 * the contained height is the only input that matters. A box too small for every
 * tier still answers the smallest one: a coarse film beats an exception, and the
 * caller decides whether to run at all.
 */
export function chooseTier(w: number, h: number): GridTier {
  const box = containBox(w, h);
  for (const tier of GRID_TIERS) {
    if (box.height / tier.rows >= MIN_CELL_HEIGHT_PX) return tier;
  }
  return GRID_TIERS[GRID_TIERS.length - 1];
}

/** How many distinct glyph colours a frame uses. */
export const BAND_COUNT = 8;

/**
 * Luminance under this is not drawn at all — the demo's `if (lum < 0.015)
 * continue`, and the transparency mechanism of ADR 0071.
 *
 * It also sits ABOVE the ramp's blank bucket: index 0 of `CHAR_RAMP` covers
 * `lum < 1/67 ≈ 0.01493`, so a cell that survives the cut is never a space. The
 * film can therefore never "draw" a cell it did not draw.
 */
export const DRAW_THRESHOLD_LUM = 0.015;

/** A Sobel gradient at least this strong is an anatomical/rock contour, not texture. */
export const SOBEL_EDGE_THRESHOLD = 0.22;

/**
 * The colour band for a luminance value, or `null` when the cell must NOT be
 * drawn. Only two things happen here — the threshold cut and the quantisation —
 * because the tone curve is the scene's business.
 *
 * `null` is not band 0. Band 0 is a dark-but-drawn glyph; `null` means "emit no
 * call", and the sink contract depends on the difference.
 */
export function bandFor(lum: number): number | null {
  if (lum < DRAW_THRESHOLD_LUM) return null;
  const band = Math.floor(lum * BAND_COUNT);
  if (band < 0) return 0;
  return band >= BAND_COUNT ? BAND_COUNT - 1 : band;
}

/**
 * The glyph for one cell — the demo's rule, ported.
 *
 * A Sobel gradient over `SOBEL_EDGE_THRESHOLD` becomes a directional glyph,
 * chosen by angle, so contours read as lines instead of as noise: rising to the
 * right is `/`, a bright-to-the-right edge is `|`, and so on. Everywhere else the
 * glyph is the ramp's entry at `floor(lum * (len − 1))`, clamped so a luminance
 * of exactly 1 cannot fall off the end.
 *
 * The four borders take the ramp branch: the demo skipped the gradient there
 * rather than reading a neighbour off the grid, and so does this — which is also
 * what makes a 1×1 grid answer instead of throwing.
 */
export function glyphFor(
  grid: Float32Array,
  cols: number,
  rows: number,
  x: number,
  y: number,
): string {
  const rampMax = CHAR_RAMP.length - 1;
  const lum = grid[y * cols + x];
  const rampGlyph = (): string => {
    const index = Math.max(0, Math.min(rampMax, Math.floor(lum * rampMax)));
    return CHAR_RAMP[index];
  };
  if (x <= 0 || y <= 0 || x >= cols - 1 || y >= rows - 1) return rampGlyph();

  // The demo's 4-neighbour gradient, not a full 3x3 Sobel: at 230x115 the
  // diagonal terms buy nothing and cost four reads per cell.
  const gx = grid[y * cols + x + 1] - grid[y * cols + x - 1];
  const gy = grid[(y + 1) * cols + x] - grid[(y - 1) * cols + x];
  if (Math.hypot(gx, gy) <= SOBEL_EDGE_THRESHOLD) return rampGlyph();

  // Fold to [0, 180): a contour has no direction of travel, so `/` at 45° and at
  // 225° are the same glyph.
  const deg = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
  if (deg >= 22.5 && deg < 67.5) return "/";
  if (deg >= 67.5 && deg < 112.5) return "_";
  if (deg >= 112.5 && deg < 157.5) return "\\";
  return "|";
}

/**
 * Where the compositor's draw calls go.
 *
 * `drawRun` is named for what it receives: `text` is a whole same-band run's
 * concatenated glyphs and `x` is the run's left edge, NOT one glyph at one
 * position. It is deliberately not called `fillText`, whose signature also takes
 * a string but whose meaning in this codebase is per-glyph. The caller paints
 * `text` at `(x, y)` in the colour for `band`, and the glyphs land on cell
 * boundaries because `textAdvance` is the width the caller measured.
 */
export interface GlyphSink {
  drawRun(text: string, x: number, y: number, band: number): void;
}

/**
 * Turn a luminance grid into draw calls. Returns the number of LIT cells, which
 * is what Task 5 judges liveness by (ADR 0070): a frame that lights nothing must
 * read as 0, or the fallback never takes over from a film that has gone black.
 *
 * Placement is `x * cellW` / `y * cellH` with `cellW = boxWidth / cols` and
 * `cellH = boxHeight / rows`. Glyph SIZE is not decided here — it is
 * `cellW / advanceRatio`, measured once per font by `measureAdvanceRatio`, and
 * the compositor does not paint, so the caller owns it. See that function for
 * why the demo's height-based guess is not portable.
 *
 * Colour is not decided here either: the sink gets a band index (see
 * `GlyphSink`), so nothing in this function builds a string it would throw away.
 */
export function drawGrid(
  grid: Float32Array,
  tier: GridTier,
  boxWidth: number,
  boxHeight: number,
  sink: GlyphSink,
): number {
  const { cols, rows } = tier;
  const cellW = boxWidth / cols;
  const cellH = boxHeight / rows;
  let litCells = 0;

  for (let y = 0; y < rows; y++) {
    const py = y * cellH;
    let runText = "";
    let runX = 0;
    let runBand = -1;
    const flush = (): void => {
      if (runText === "") return;
      sink.drawRun(runText, runX, py, runBand);
      runText = "";
      runBand = -1;
    };

    for (let x = 0; x < cols; x++) {
      const band = bandFor(grid[y * cols + x]);
      // A dark cell is not part of any run: it is skipped, and it ends the run
      // that was open. Nothing is painted over it, which is the whole point.
      if (band === null) {
        flush();
        continue;
      }
      if (band !== runBand) {
        flush();
        runX = x * cellW;
        runBand = band;
      }
      runText += glyphFor(grid, cols, rows, x, y);
      litCells++;
    }
    // A run never crosses a row boundary — the next row is a different `y`.
    flush();
  }

  return litCells;
}

/**
 * The Tailwind utility class the film's glyph colour is reached through.
 *
 * The class name has to appear as a literal in a SCANNED source file, because
 * Tailwind v4 only emits `.text-film-glyph{color:var(--color-film-glyph)}` once
 * it sees the name (ADR 0062, and `--color-row-icon` survives the same way). If
 * this string disappears the token stays declared in all five palette blocks and
 * the film paints black-on-black — so the gate is
 * `grep -c '\.text-film-glyph{' dist/assets/*.css`, not a test.
 */
export const FILM_GLYPH_COLOR_CLASS = "text-film-glyph";

/**
 * Resolve a Tailwind colour utility CLASS to something canvas can parse.
 *
 * Read the computed `color` of a throwaway element that carries the class. Do
 * NOT read the custom property: `getPropertyValue("--color-film-glyph")` hands
 * back the unresolved `color-mix(in oklab, …)` string, which `fillStyle` refuses
 * (ADR 0071), while a computed `color` is always concrete — `oklab(…)` in the
 * browser, and it round-trips through `fillStyle`.
 *
 * The element is ATTACHED, because the palette classes (`.dark`,
 * `.theme-dracula`, …) sit on the root element: a detached probe would resolve
 * against nothing and read the `@theme` default instead of the live theme. It is
 * removed again, so it never occupies layout or shows up in a snapshot.
 *
 * The return is whatever `getComputedStyle` says, and `""` ONLY when the DOM
 * APIs are absent. There is deliberately no sentinel for "the class resolved to
 * nothing": an element whose class has no stylesheet behind it simply inherits,
 * and under jsdom that inherited value is `rgb(0, 0, 0)` whether the element was
 * attached or not. Black is an acceptable answer there because no jsdom test
 * paints anything real, and because the honest guard against a missing utility
 * rule is the built-CSS grep named on `FILM_GLYPH_COLOR_CLASS` — not this
 * function guessing that a colour looked wrong.
 */
export function resolveTokenColor(colorUtilityClass: string = FILM_GLYPH_COLOR_CLASS): string {
  if (typeof document === "undefined") return "";
  if (typeof getComputedStyle !== "function") return "";

  const host = document.body ?? document.documentElement;
  if (host === null) return "";

  const probe = document.createElement("span");
  probe.className = colorUtilityClass;
  // Invisible, out of flow, and invisible to assistive tech: it exists for one
  // computed style and is gone in the same tick.
  probe.style.position = "absolute";
  probe.style.top = "0";
  probe.style.left = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.setAttribute("aria-hidden", "true");
  host.appendChild(probe);
  try {
    return getComputedStyle(probe).color;
  } catch {
    // A hostile or half-installed environment must not take the film down: an
    // empty string sends the caller to its own fallback colour.
    return "";
  } finally {
    probe.remove();
  }
}

/** The advance ratio used when nothing measurable was handed over. */
const FALLBACK_ADVANCE_RATIO = 0.6;

/**
 * The size token in a CSS `font` shorthand, in px, or 0 when there is none.
 *
 * The shorthand puts `<font-size>` first among the tokens that carry a unit
 * (after any style/variant/weight/stretch, and before any `/<line-height>`), and
 * a bare number is invalid CSS, so a token without a unit is not a size. `em`
 * and `rem` use the CSS initial of 16px because a canvas has no font size of its
 * own to resolve them against.
 */
const fontSizeFromSpec = (fontSpec: string): number => {
  const tokens = fontSpec.split("/")[0].split(/\s+/);
  for (const token of tokens) {
    const match = /^(\d+(?:\.\d+)?|\.\d+)(px|em|rem|pt)$/.exec(token);
    if (match === null) continue;
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value)) continue;
    switch (match[2]) {
      case "px":
        return value;
      case "em":
      case "rem":
        return value * 16;
      default:
        return (value * 96) / 72; // pt
    }
  }
  return 0;
};

/**
 * `measureText("M").width / fontSize` for one font spec, measured once per font
 * so glyph SIZE can be derived from cell WIDTH.
 *
 * The demo sizes its font off cell HEIGHT (`1.08 * ch`) while placing glyphs at
 * `cw`. Those two agree only by luck with Courier New, whose advance is about
 * 0.6em; this app's `--font-mono` is user-changeable (default Fira Code, advance
 * ≈ 0.6em too but its own metrics), and on a face that disagrees the glyphs would
 * either overlap or leave gaps while the grid stayed perfectly aligned. So:
 * `fontSize = cellW / ratio`, measured, never guessed. Task 5 calls this once
 * per font and caches it.
 *
 * A context is taken as a parameter rather than created here — this module must
 * not need a real 2D context (jsdom cannot make one), and the caller already
 * holds the canvas it is painting into. An unusable spec answers
 * `FALLBACK_ADVANCE_RATIO` so the caller always gets a finite, positive number
 * to divide by.
 */
export function measureAdvanceRatio(ctx: CanvasRenderingContext2D, fontSpec: string): number {
  // Set first, measure second: measuring before the assignment measures the
  // context's default face, which is the exact bug this function exists to kill.
  ctx.font = fontSpec;
  const size = fontSizeFromSpec(fontSpec);
  const advance = ctx.measureText("M").width;
  if (!(size > 0) || !(advance > 0)) return FALLBACK_ADVANCE_RATIO;
  return advance / size;
}
