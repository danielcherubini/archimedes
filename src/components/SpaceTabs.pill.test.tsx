import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useSessions } from "../store/sessions";
import { makeSpaceRow } from "../test/fixtures";
import { resetModuleFlags, resetStores } from "../test/resetStores";
import SpaceTabs from "./SpaceTabs";

/**
 * THE SPACE TABS, AS RENDERED: active and inactive are ONE KIND OF OBJECT.
 *
 * This contract used to be pinned by `src/lib/slabFloatSeparation.test.ts`,
 * which read `SpaceTabs.tsx` as TEXT: it lifted the pill's class literal out of
 * the source with a regex, lifted every `active ? "…" : "…"` class ternary with
 * another regex, and compared the two. Two consequences of reading text rather
 * than DOM, both of which Finding 1 of the improvement report is about:
 *
 *   - it could only see a contract WRITTEN AS A TERNARY. Express the same
 *     correct pair as a lookup, a `cn()` call, or a variant and the reader
 *     THREW — a build-green, visually-correct component with zero tests run;
 *   - it asserted the SHAPE OF THE SOURCE, so a refactor that moved the pill's
 *     geometry into a shared child file reddened it with every pixel unchanged.
 *
 * The repo has been here before and retired a pin for exactly that reason: see
 * `src/lib/skills.test.ts:16-24`, which records that its source-lifting pin was
 * deleted as "a landmine … with no detection value the component tests did not
 * already have", and that its guarantee moved to where the behaviour is
 * observable. Same move here — the two invariants below are the same ones,
 * asserted on the rendered `className` of the actual pill:
 *
 *   1. every tab pill is the SAME inset pill (`h-8`, `rounded-md`), active or
 *      not, and the pill's shape exists exactly ONCE across the state pair;
 *   2. the active/inactive pair differs ONLY by fill and ink — never by a
 *      geometry utility — and the bridge (the old full-height sheet-edge tab)
 *      stays out of everything the strip renders.
 *
 * `slabFloatSeparation.test.ts` keeps its float shadow/border gates: those are
 * genuinely textual, because they defend a class a component must still CONTAIN
 * for Tailwind's scanner to emit the rule at all, rendered or not. Only the tabs
 * block, whose subject is pure rendered geometry, moved here.
 *
 * WHY THIS FILE PASSES ON ITS FIRST RUN AGAINST UNCHANGED CODE. It is a
 * characterisation test: it locks today's rendered contract so the extraction
 * work in Phase C cannot quietly change it. A failure here on unmodified
 * `SpaceTabs.tsx` means an assertion below is wrong, not that the component is.
 */

// The environment this component needs (Radix's pointer-capture trio +
// `matchMedia`, for the `+`'s `NewSpaceDialog`) is installed once for the whole
// suite in `src/test/setup.tsx` — the block that used to sit here was the same
// 12 lines `SpaceTabs.test.tsx` carried, "repeated rather than shared", which is
// the duplication finding 9 is about.
const space = (path: string) => makeSpaceRow({ path });

beforeEach(() => {
  // Every store back to its initial state (the hand-written version of this
  // named nine `useSessions` keys and skipped everything else the store carries —
  // `contextUsage`, `compacting`, `inTurn`, `stopReasons`, `stalled`, `history`,
  // `newSessionError` among them — and those leaked between cases). No field
  // count is quoted here: the store's shape moves, and a copied number goes
  // stale in every copy that repeats it.
  resetStores();
  // The Open-Space-dialog flag is module-scoped: a leaked `true` would auto-mount
  // a real Radix modal (`aria-hidden`ing the rest of the document) in every later
  // render here — the same guard `SpaceTabs.test.tsx` carries.
  resetModuleFlags();
});

/** Two Spaces, so there is always one tab to make active and one to leave inactive. */
const ALPHA = "/w/alpha";
const BETA = "/w/beta";

/** What one render of the two-tab strip exposes about its pills. */
interface Pills {
  /** The selected tab's pill (the wrapper `div`) and label (`role="tab"`) classes. */
  active: { pill: string; label: string };
  /** The unselected tab's, same shape. */
  inactive: { pill: string; label: string };
  /** Every class string the strip renders, pill / label / ✕ / `+` / spacer. */
  rendered: string[];
}

/**
 * Render the two-tab strip with `activePath` selected, read what the DOM says,
 * and unmount.
 *
 * The unmount is load-bearing, not tidiness: `screen.getByRole` searches the
 * whole document, so a second `render()` on top of the first would find two tabs
 * per name and throw for the wrong reason. Every assertion therefore runs on the
 * STRINGS this returns, never on a DOM that may have been replaced.
 */
const readStrip = (activePath: string): Pills => {
  useSessions.setState({
    spaces: [space(ALPHA), space(BETA)],
    activeSpacePath: activePath,
  });
  const view = render(<SpaceTabs />);
  const [activeName, inactiveName] = activePath === ALPHA ? ["alpha", "beta"] : ["beta", "alpha"];
  // The pill is the wrapper `div` HOLDING the `role="tab"` label and the ✕ —
  // `SpaceTabs.test.tsx:268-274` pins that the two controls are siblings of one
  // parent — and there is deliberately no `data-testid="space-tab"`, so the
  // pill is the tab's PARENT.
  const pillOf = (name: string): HTMLElement =>
    screen.getByRole("tab", { name }).parentElement!;
  const read = (name: string) => ({
    pill: pillOf(name).className,
    label: screen.getByRole("tab", { name }).className,
  });
  const pills: Pills = {
    active: read(activeName),
    inactive: read(inactiveName),
    rendered: [...screen.getByTestId("space-tabs").querySelectorAll("[class]")].map((el) =>
      el.getAttribute("class")!,
    ),
  };
  view.unmount();
  return pills;
};

/**
 * A token's utility with its VARIANT PREFIXES removed.
 *
 * Variant-awareness is the whole reason this file does not go red on correct
 * code. Measured on today's DOM: the active pill is `… rounded-md
 * bg-surface-hover`, the inactive pill is `… rounded-md bg-surface
 * hover:bg-surface-hover`. A filter that dropped only an un-prefixed `bg-` would
 * leave `hover:bg-surface-hover` in the inactive set, the two geometry sets
 * would differ, and a CORRECT component would fail the geometry gate. So every
 * `prefix:` chain — `hover:`, `focus-visible:`, `md:`, `data-*[…]:` — comes off
 * before the utility is classified.
 *
 * `lastIndexOf(":")`, not `split(":")[0]`: an arbitrary variant carries its own
 * colons inside its brackets (`data-[state=open]:bg-x`), and only the LAST colon
 * is the separator.
 */
const bareUtility = (token: string): string => token.slice(token.lastIndexOf(":") + 1);

/** The utilities that PAINT a surface or an ink (as opposed to shaping a box). */
const FILL_OR_TEXT = /^(bg|text|font)-/;

/**
 * A class list reduced to its GEOMETRY: drop every token whose bare utility
 * paints, sort (so a re-ordering of the class string is not a state
 * difference), keep the rest.
 *
 * Note what survives the strip: `border-*`, `ring-*`, `shadow-*`, `max-w-*`,
 * `flex`, `items-*`, `gap-*`, `p-*`, `truncate`. So the claim being made is
 * stronger than "both states share a height and a radius" — it is "the two
 * states differ ONLY in what they paint". Mirrors the `GEOMETRY` set the retired
 * source gate used (`h-` / `w-` / `size-` / `rounded`), inverted: that gate
 * forbade geometry to appear in a state branch, this one forbids anything but
 * paint from appearing in a state difference.
 */
const geometryOf = (className: string): string[] =>
  className
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !FILL_OR_TEXT.test(bareUtility(token)))
    .sort();

const geometryKey = (className: string): string => geometryOf(className).join(" ");

describe("the space tabs, as rendered (active and inactive are one kind of object: pills)", () => {
  it("gives every tab pill the inset pill geometry, active AND inactive", () => {
    const { active, inactive } = readStrip(ALPHA);
    for (const [state, cls] of [
      ["active", active.pill],
      ["inactive", inactive.pill],
    ] as const) {
      const tokens = cls.split(/\s+/);
      expect(tokens, `the ${state} pill lost its inset height`).toContain("h-8");
      expect(tokens, `the ${state} pill lost its corners`).toContain("rounded-md");
    }
    // The LABEL owns the pill's height (the wrapper centres everything else) —
    // the other half of "an inset pill, not a full-height tab".
    expect(active.label.split(/\s+/), "the label no longer owns the pill's height").toContain(
      "self-stretch",
    );
  });

  it("makes the state pair differ ONLY by fill and ink, for the pill and for the label", () => {
    // Read the pair from BOTH directions. Rendering one active Space alone would
    // compare one active string against one inactive string and could not see a
    // state-dependent geometry that followed the SPACE rather than the state.
    const fromAlpha = readStrip(ALPHA);
    const fromBeta = readStrip(BETA);

    const pills = [
      fromAlpha.active.pill,
      fromAlpha.inactive.pill,
      fromBeta.active.pill,
      fromBeta.inactive.pill,
    ];
    const labels = [
      fromAlpha.active.label,
      fromAlpha.inactive.label,
      fromBeta.active.label,
      fromBeta.inactive.label,
    ];
    // Vacuity guard (carried across from the retired gate): a collapsed list
    // makes "exactly one shape" true by having nothing in it. Four reads of a
    // two-tab strip is the expected census.
    expect(pills).toHaveLength(4);
    expect(labels).toHaveLength(4);

    // THE POSITIVE HALF: the pill's shape exists exactly ONCE across the whole
    // state pair. This is the hole the text reader could not cover — it proved
    // "a shared geometry string exists" but could not see a SECOND copy of
    // `h-8 rounded-md` smuggled into one branch of a state ternary (which resizes
    // the active tab) or into both (the drift that stayed green under it). On the
    // rendered class list there is nowhere to hide a second shape.
    const pillShapes = [...new Set(pills.map(geometryKey))];
    expect(
      pillShapes,
      `the pill's shape differs between states — one kind of object means ONE geometry: ${JSON.stringify(
        pillShapes,
      )}`,
    ).toHaveLength(1);
    // And the one shape IS the pill's: a set of empty strings would also have
    // length 1, so presence is asserted AFTER the count.
    expect(pillShapes[0]!.split(" ")).toEqual(
      expect.arrayContaining(["flex", "h-8", "max-w-48", "items-center", "rounded-md"]),
    );

    const labelShapes = [...new Set(labels.map(geometryKey))];
    expect(
      labelShapes,
      `the tab label's shape differs between states: ${JSON.stringify(labelShapes)}`,
    ).toHaveLength(1);

    // THE NEGATIVE HALF, stated rather than inferred: the states DO differ as
    // class strings — if they were accidentally identical, "same geometry once
    // paint is stripped" would be vacuous — and the ONLY difference is in the
    // utilities the stripper removes.
    expect(fromAlpha.active.pill).not.toBe(fromAlpha.inactive.pill);
    expect(fromAlpha.active.label).not.toBe(fromAlpha.inactive.label);
    expect(geometryKey(fromAlpha.active.pill)).toBe(geometryKey(fromAlpha.inactive.pill));
    expect(geometryKey(fromAlpha.active.label)).toBe(geometryKey(fromAlpha.inactive.label));
  });

  it("lifts the active tab one step: surface-hover over surface, full-contrast ink", () => {
    const { active, inactive } = readStrip(ALPHA);
    // THE FILL PAIR, asserted on the rendered pill. This is what the retired gate
    // reached for by finding "the ternary whose ACTIVE branch carries
    // `bg-surface-hover`"; the ternary SHAPE is no longer required, the effect is.
    expect(
      active.pill.split(/\s+/),
      "the active tab is not a lifted pill",
    ).toContain("bg-surface-hover");
    expect(
      inactive.pill.split(/\s+/),
      "the inactive pill changed its fill",
    ).toContain("bg-surface");
    // The active pill must not ALSO wear the plain step — otherwise "one step
    // lifted" would be a coincidence of which rule wins in the cascade.
    expect(active.pill.split(/\s+/)).not.toContain("bg-surface");

    // THE INK PAIR: the active label is full-contrast and weighted, the inactive
    // one wears the quiet text token and no weight.
    const activeLabel = active.label.split(/\s+/);
    const inactiveLabel = inactive.label.split(/\s+/);
    expect(activeLabel).toContain("text-foreground");
    expect(activeLabel).toContain("font-medium");
    expect(inactiveLabel).toContain("text-foreground-subtle");
    expect(inactiveLabel).not.toContain("font-medium");
  });

  it("keeps the bridge out of everything the strip renders: no h-10, no rounded-top, no bridge shadow, no paint-order hack", () => {
    // The active tab used to BE the chat sheet's top edge: a full-height `h-10`
    // tab with a hard 5px same-colour shadow that extended its fill across the
    // frame gap and merged it into the slab (the "bridge" design). That seam
    // logic is the sort of thing that looks intentional in a diff review and
    // survives a colour-only test, so the ban is pinned on the RENDERED strip —
    // every classed element in it, not just the pill, because a bridge is by
    // definition a class on more than one box.
    const { rendered } = readStrip(ALPHA);
    // Vacuity guard: `[class]` over an empty strip returns `[]`, and a
    // `not.toMatch` loop over `[]` is a green test that checked nothing.
    expect(rendered.length, "the strip rendered no classed elements").toBeGreaterThan(0);
    for (const cls of rendered) {
      expect(cls, "the bridge shadow is back — the active tab is the sheet again").not.toMatch(
        /shadow-\[0_\d+px_0_0/,
      );
      expect(cls, "a full-height tab is not an inset pill").not.toMatch(/(^|\s)h-10(\s|$)/);
      expect(cls, "a rounded-top tab is the sheet's edge, not a pill").not.toMatch(/rounded-t-md/);
      expect(cls, "the paint-order hack is back with the bridge").not.toMatch(/relative z-\d+/);
    }
  });

  it("a drag in flight changes the TARGET pill by exactly the two indicator tokens, and adds no node", () => {
    // The pill's "one kind of object" contract has to survive the drag feature
    // (ADR 0075, T07). The indicator is a CLASS on the real pill — the spec
    // forces it, because the obvious alternatives (a placeholder pill, a
    // portal-drawn ghost) would add a DOM level to a strip whose tests resolve
    // through ancestry — so the WHOLE difference a gesture makes must be two
    // tokens on one element.
    //
    // TWO COMPETING ANSWERS: the target pill's token set gains EXACTLY
    // `border-l-2` + `border-brand` and the strip's element count is unchanged
    // (correct), vs a call site that smuggles in height/shadow utilities, or a
    // placeholder element inserted beside the pills (the count moves, and every
    // ancestry-resolving query in the repo's tab tests starts lying).
    // (`border-l-2`, not the sidebar's `border-t-2`: this strip is horizontal, so
    // the call site paints "earlier" on the pill's LEFT edge. The token pair is
    // the call site's own choice — see `SpaceTabs.test.tsx`, which asserts the
    // left/right pair here and the sidebar's top/bottom pair in
    // `SpacesList.test.tsx`.)
    useSessions.setState({
      spaces: [space(ALPHA), space(BETA)],
      activeSpacePath: ALPHA,
    });
    const view = render(<SpaceTabs />);
    const pill = (name: string) =>
      screen.getByRole("tab", { name }).parentElement!;
    const tokens = (el: HTMLElement) =>
      [...new Set(el.className.split(/\s+/).filter(Boolean))].sort();
    const elementCount = () =>
      screen.getByTestId("space-tabs").querySelectorAll("*").length;

    const targetWas = tokens(pill("beta"));
    const otherWas = tokens(pill("alpha"));
    const countWas = elementCount();

    // A drag in flight: `alpha` held, pointer over the LEFT half of `beta`. The
    // rect override + hand-built event are the two jsdom idioms the drag tests
    // in `SpaceTabs.test.tsx` document — without them the half is not a fact the
    // test chooses.
    //
    // THE GEOMETRY IS HORIZONTAL, and that is the whole point of the override
    // below: the strip is a row, so the pills share a y range and differ in x,
    // and the pointer travels in X with `clientY` sitting exactly on their shared
    // vertical midpoint (116 of 100..132). Under the pre-fix hook — which read
    // `clientY` for both lists — that pointer answered "after" and this drag was
    // a NO-OP, so the assertion below would have seen NO new tokens at all.
    const pillRect = (left: number) => () =>
      ({ top: 100, bottom: 132, height: 32, width: 120, left, right: left + 120, x: left, y: 100, toJSON: () => ({}) }) as DOMRect;
    const from = pill("alpha");
    const to = pill("beta");
    from.getBoundingClientRect = pillRect(0);
    to.getBoundingClientRect = pillRect(100); // 100..220, midpoint 160
    const mk = (type: string, x: number, y: number) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(ev, {
        clientX: x,
        clientY: y,
        dataTransfer: { setData: () => {}, getData: () => "", setDragImage: () => {} },
      });
      return ev;
    };
    fireEvent(from, mk("dragstart", 60, 116));
    // The vertical CENTRE (116) and the target's LEFT half (x 110 < 160): a
    // rightward intent stated entirely in X.
    fireEvent(to, mk("dragover", 110, 116));

    expect(
      tokens(to).filter((t) => !targetWas.includes(t)),
      "the drop indicator is not the two pinned tokens",
    ).toEqual(["border-brand", "border-l-2"]);
    // The pill the pointer is NOT over is untouched — no second answer to "which
    // pill is the target".
    expect(tokens(pill("alpha"))).toEqual(otherWas);
    // And nothing was INSERTED to draw the edge with.
    expect(elementCount(), "the indicator added a DOM node").toBe(countWas);
    view.unmount();
  });
});
