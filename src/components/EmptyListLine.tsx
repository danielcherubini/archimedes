import type { ReactNode } from "react";

import { cn } from "./lib/utils";

/**
 * The empty-list sentence inside a list or a picker: `p-3 text-ui-sm
 * text-foreground-subtlest`, once.
 *
 * WHY THIS EXISTS (finding 15). The triple was hand-spelled at 8 sites in 4
 * files — `SkillsDialog` (no skills at all / no match for the query),
 * `AgentsDialog` (loading / no definitions / no match), `ModelPickerDialog`
 * (no models / no match) and the sidebar's `No spaces yet.` Each is the same
 * sentence in the same box, and each copy is pinned by a test
 * (`SkillsDialog.test.tsx:236,268`, `ModelPickerDialog.test.tsx:187,195`,
 * `SpacesList.test.tsx:871,996`) while the CLASSES behind it are pinned by
 * nobody. So the copy is protected and the shape is not — the exact asymmetry
 * that lets one site quietly lose its padding.
 *
 * WHY NOT MORE. It owns the padding + the type scale ONLY. The three dialogs
 * differ in ways a shell must not average away (their filters, their row markup,
 * whether keyboard nav exists at all, what renders above the search input) and
 * that is Task C6's problem, not this component's. This one takes the single
 * leaf element that is byte-identical at all 8 sites.
 *
 * THE VARIANTS STAY VARIANTS. `McpSection.tsx:436`'s empty row is
 * `px-4 py-3 text-ui-base text-foreground-subtle` — a settings-card row, not a
 * list row — and it is deliberately NOT folded in, neither as a `variant` arm
 * nor as a default. Measured through the real `cn()`, an override of
 * `px-4 py-3 text-ui-base text-foreground-subtle` on this base renders
 * `p-3 px-4 py-3 …`: tailwind-merge does NOT delete a parent padding utility
 * when the later override supplies both axes (it lets CSS order decide, and
 * `dist/assets/*.css` emits `.px-4` after `.p-3`), so the fold would ship a dead
 * `p-3` in the class attribute. `EmptyListLine.test.tsx` pins that measurement
 * so nobody re-derives it differently. The same reasoning is why this component
 * has no `variant` prop at all: C2's badge decision (`primitives.test.tsx`)
 * already established that an arm which needs negations to look right is a sign
 * the base is the wrong home.
 *
 * NO WRAPPER ELEMENT. Every site renders this as a SIBLING of the list it
 * replaces, inside a flex column that the tests walk
 * (`SkillsDialog.test.tsx:315-324` goes `row → parentElement` to reach the
 * scroller and asserts its classes). A wrapper would insert a DOM level between
 * the empty state and that column, and C6's shell pins forbid a new level for
 * the same reason.
 */
export function EmptyListLine({
  children,
  className,
}: {
  children: ReactNode;
  /** Merged through `cn()`, so a same-group utility here replaces the base's.
   * See the component doc for why the settings-card variant is NOT routed here. */
  className?: string;
}) {
  return <p className={cn("p-3 text-ui-sm text-foreground-subtlest", className)}>{children}</p>;
}
