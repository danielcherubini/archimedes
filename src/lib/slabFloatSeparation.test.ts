import { describe, expect, it } from "vitest";
import { readResolvedIndexCss, stripCssComments } from "./cssSource";

/**
 * THE ONE COLLISION THE ISLAND LAYOUT BUYS ON PURPOSE (ADR 0027, option B).
 *
 * The content slab — the transcript column, the side pane and the composer
 * chat column and the inspector, both reading the same Background step,
 * `#282a36`. That step is ALSO what the spec assigns to "Floating interactive
 * elements", so every float (`bg-menu`, `bg-popover`, `bg-tooltip`) is now the
 * EXACT SAME COLOUR as the surface it floats over: 1.00, not 1.0X — identical.
 *
 * This was a decision, not an oversight. The alternatives were worse:
 *   - keep the slab below the float step: the spec has no sixth dark step, so it
 *     would need an off-spec hex, which is the exact sin the spec-gate in
 *     `paletteCompleteness.test.ts` was written to reject;
 *   - move the floats UP to `#343746`: then `card`, `secondary` and `tag` have
 *     nowhere above them, and re-merging badges with the float that contains
 *     them is the elevation INVERSION this same ADR records fixing once already.
 *
 * So the floats stay, and the app pays for it here. This file exists so the
 * price is a measured, named fact rather than a rumour — the ADR's own
 * conclusion is "count it, do not recall it", and prose in `index.css` is the
 * form of this correction that keeps needing to be corrected again.
 *
 * WHAT ACTUALLY SAVES A FLOAT is its elevation affordance, and that is a
 * property of the COMPONENT, not of the palette. Hence the second half of this
 * file reads the component sources: if someone deletes a `shadow-md` or a
 * `border` from a float, the float over the chat becomes invisible and no
 * palette test can see it. That is the regression this pins.
 */

const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

const lumOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lumOf(a), lumOf(b)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
};

const dracula = (token: string): string => {
  const css = stripCssComments(readResolvedIndexCss());
  const body = css.match(/^\.theme-dracula\s*\{/m)!;
  const start = css.indexOf(body[0]!);
  const block = css.slice(start, css.indexOf("}", start));
  const v = block.match(new RegExp(`--color-${token}\\s*:\\s*([^;]+);`))![1]!;
  return v.trim().toLowerCase();
};

/**
 * A component's source with its COMMENTS removed — the only safe reader for
 * this file. Its assertions are about CLASS LISTS, and the comments in those
 * components describe the classes they document, so a raw read lets the PROSE
 * satisfy an assertion after the class itself has been deleted: a
 * "keeps its stacking context" test passed for exactly that reason while the
 * stacking context was gone. Stripping comments makes the assertion read what
 * the component actually RENDERS.
 */
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

describe("floats over the content slab (the accepted collision)", () => {
  const slab = dracula("chat");
  const floats = ["menu", "popover", "tooltip", "toast", "header", "tab"] as const;

  it("puts the slab and every float on the SAME colour — the collision is real", () => {
    // Asserted as a fact, not hoped away. If a future change gives the floats
    // their own step, THIS test is what says the trade-off has been paid off —
    // and it fails, pointing at the comment that needs deleting.
    expect(slab).toBe("#282a36");
    for (const token of floats) {
      expect(dracula(token), `--color-${token}`).toBe(slab);
    }
  });

  it("measures the collision at exactly 1.00, so fill alone cannot separate them", () => {
    for (const token of floats) {
      expect(
        contrast(dracula(token), slab),
        `--color-${token} against the slab`,
      ).toBeCloseTo(1, 5);
    }
  });

  /** Every float component and the affordance that ACTUALLY carries it, read
   *  from the source rather than assumed. `shadow` is the strong one — it is
   *  drawn outside the box, so a same-colour fill cannot eat it. `border` is
   *  weak by construction here: `--color-popover-border` aliases
   *  `--color-border`, which is Comment `#6272a4` at 2.51 on the slab — BELOW
   *  the 3:1 WCAG floor for a non-text boundary. So the border is a hint and
   *  the shadow is the separation.
   *
   *  `border` is false for `alert-dialog` and that is intentional, not an
   *  oversight to fix: it is `border-none bg-popover/98 shadow-2xl`. A
   *  full-screen modal wearing the strongest shadow in the kit does not need a
   *  hairline. It is enumerated anyway so the SHADOW is the pinned invariant
   *  for every float, and so dropping a border where one exists is a review
   *  rather than a silence. */
  const FLOATS: Array<{ file: string; label: string; border: boolean }> = [
    { file: "src/components/ui/select.tsx", label: "Select content", border: true },
    { file: "src/components/ui/dropdown-menu.tsx", label: "DropdownMenu content", border: true },
    { file: "src/components/ui/dialog.tsx", label: "Dialog content", border: true },
    { file: "src/components/ui/alert-dialog.tsx", label: "AlertDialog content", border: false },
  ];

  for (const f of FLOATS) {
    it(`${f.label} keeps its shadow — the only thing separating it from the slab`, () => {
      const cls = code(f.file);
      expect(cls, `${f.file} lost its shadow`).toMatch(/shadow-/);
      if (f.border) {
        expect(cls, `${f.file} lost its border`).toMatch(/border-(popover-border|border)\b/);
      } else {
        // `border-none` is deliberate (a full-screen modal with the strongest
        // shadow in the kit needs no hairline) — assert the DECLARATION, since a
        // `border-none` class contains the word "border" and a naive
        // not.toMatch(/border/) could never pass.
        expect(cls, `${f.file} now has a border — promote it in FLOATS`).toMatch(
          /border-none/,
        );
      }
    });
  }

  it("records that the TOOLTIP has no shadow and is the accepted casualty", () => {
    // The tooltip is the one float with neither a shadow nor a meaning that
    // survives losing its edge: `tooltip.tsx` carries `border border-border` and
    // no `shadow-*`, so over the chat column it reads as a same-colour patch
    // lifted only by a 2.51 rule.
    //
    // NOT FIXED HERE, and that is deliberate rather than lazy: the fix is a
    // `shadow-md` on the tooltip, which is a component change with its own test
    // surface (the tooltip's own suite asserts its class list), and dragging it
    // into a palette change is how an unrelated regression gets attributed to
    // the colour work. Pinned as a NEGATIVE so the gap cannot be forgotten OR
    // quietly closed by accident — if a shadow is ever added, this fails and the
    // entry gets promoted into FLOATS above.
    const cls = code("src/components/ui/tooltip.tsx");
    expect(cls).toMatch(/border-border/);
    expect(cls).not.toMatch(/shadow-/);
  });

  it("keeps the context bar's track legible against the pane it rides", () => {
    // GRADED AGAINST `inspector`, the pane's own plane — the surface the
    // track's pixels ACTUALLY land on. This gate has named the wrong surface
    // twice (the chat slab, then `composer` after the bar left the island, then
    // the `bg-input` WELL after the bar left the composer for the pane), and
    // the well is now gone too: the user rejected it as a sunken slot inside a
    // plane, and `SessionConfigBlock.tsx` says so at its top. A gate must name
    // the surface the pixels land on, so this reads `inspector`.
    //
    // THE FLOOR IS 1.2, NOT 1.3, AND THAT IS A REAL CONCESSION, not gate-
    // loosening to hide a failure: 1.3 was measurable only BECAUSE of the well.
    // Against the bare pane no non-Selection Dracula step clears 1.3 —
    // `#343746` 1.208, `#191a21` 1.218, `#21222c` 1.109 — the palette simply
    // has no step at that distance from `#282a36`. What carries the bar is the
    // FILL against the TRACK (every band clears 3:1, worst 4.33), and band-vs-
    // pane separation actually IMPROVES without the well (5.23 vs 4.33).
    // 1.2 still fails the true collisions — a track that IS the pane
    // (`#282a36`, 1.000) or the page plane under it (`#21222c`, 1.109).
    // The invariant is SEPARATION, not direction.
    const track = dracula("context-track");
    const pane = dracula("inspector");
    expect(
      contrast(track, pane),
      `track ${track} is invisible against the pane ${pane} it rides`,
    ).toBeGreaterThanOrEqual(1.2);
  });
});

/**
 * THE SPACE TABS MOVED OUT OF THIS FILE. Active and inactive used to be pinned
 * here by READING THE TAB-STRIP COMPONENT'S SOURCE TEXT: lifting the pill's
 * class literal out of the source with one regex, lifting every
 * `active ? "…" : "…"` class ternary with another, and comparing the two — plus
 * a hard failure raised when a ternary could not be found. That last part was
 * the problem in miniature: a component that expressed the same correct pair as
 * a lookup, a `cn()` call, or a variant failed at test time, so a build-green,
 * pixel-identical component arrived with zero tests run. It also punished
 * RELOCATION: moving the pill's geometry into a shared child reddened a gate
 * about how a file is WRITTEN.
 *
 * Both invariants now live where they are observable, in the rendered DOM:
 * `src/components/SpaceTabs.pill.test.tsx` renders the strip and asserts (a) the
 * pill is the same `h-8` `rounded-md` inset for the active and the inactive tab,
 * with the shape existing exactly once across the state pair, and (b) the state
 * pair differs ONLY by fill and ink — a geometry difference in either direction
 * fails it — plus the bridge ban (no `h-10`, no `rounded-t-md`, no bridge
 * shadow, no paint-order hack) over every class the strip renders. The
 * "one kind of object" claim is now STRONGER than the source gate managed: the
 * text reader could not see a duplicated geometry string inside a ternary
 * branch, whereas the rendered class list cannot contain one invisibly.
 *
 * This file keeps ONLY the gates no render can express: the palette collision
 * measurements, and the float shadow/border gates. Those are textual on purpose
 * — a `shadow-md` that a component must still CONTAIN for Tailwind's scanner to
 * emit the rule at all is a source-text fact whether or not a given test mounts
 * the component, so `FLOATS` and the tooltip's accepted casualty stay.
 */
