import type { ComponentProps, KeyboardEvent, MouseEvent } from "react";

/**
 * `RowButton` — the ONE hand-rolled `role="button"` div row (finding 3, Task C4).
 *
 * Five surfaces spell the same affordance by hand: `SpacesList`'s session row,
 * its **Archived** section header, its archived row, and the Skills and Model
 * picker rows. Each spells `role="button"` + `tabIndex={0}` + an Enter handler
 * that calls the same function its `onClick` calls. This owns those three.
 *
 * **What is NOT folded in, and why.** `TodoBoardPanel.tsx`'s board tile (the
 * `role="button"` div at `:279`) is a sixth
 * hand-rolled affordance but a DIFFERENT one: it activates on `Enter || " "`
 * with `preventDefault`. Space-on-a-div is the correct keyboard contract for a
 * real button substitute and WRONG for these rows — none of the five sites here
 * advertises it, and folding it in would change what a keypress does in five
 * surfaces. So this component handles Enter ONLY, and
 * `RowButton.test.tsx` pins that Space stays inert.
 *
 * **Exactly ONE `role="button"` per row is the load-bearing constraint.**
 * `SpacesList.test.tsx` reaches rows through `.closest('[role="button"]')` at
 * EIGHT sites plus its `rowOf()` helper, so a second `role="button"` anywhere in
 * a row's ancestry resolves to the WRONG node and all nine reads break at once.
 * Two consequences:
 *  - the hover-action controls inside a row (Stop / Archive / Unarchive /
 *    Delete) are NOT this component. They are real `<button>` elements and they
 *    carry no `role` attribute — `RowButton` would give them one and turn every
 *    `rowOf(…).getByRole("button", …)` into a multiple-match throw.
 *  - `AgentsDialog`'s rows stay hand-rolled as plain `div`s: they are
 *    deliberately NOT controls at all (`AgentsDialog.tsx`'s own doc-comment
 *    says why), and
 *    `SkillsDialog.test.tsx`'s `the_shadow_report_is_not_clickable` and
 *    `AgentsDialog.test.tsx`'s orphan-block test assert that a non-row line
 *    carries no `role` and no `tabindex`.
 *
 * **`className` is passed through, never re-merged.** Every site owns its own
 * class string, and one of them depends on `cn()` NOT running: the Model
 * picker's disabled row spells `cursor-pointer` (base) and `cursor-not-allowed`
 * (disabled arm) — ONE tailwind-merge cursor group, so a merge drops one of
 * them and changes which cursor a disabled row shows. That site is allowlisted
 * in `lib/classNameConvention.test.ts` for exactly that measured reason, and it
 * passes its template literal straight through here. The row shell therefore
 * composes nothing: `className={className}` is a reference, which is what keeps
 * this file inside the `cn()` convention rather than outside it.
 *
 * **Attribute order is part of the contract, not an accident.** The DOM
 * serialisation of these rows is byte-compared before and after the extraction,
 * so the element emits `role`, `tabIndex`, `aria-disabled`, then the handlers,
 * then `className`, then whatever the caller spread — the order the five call
 * sites spelled by hand today.
 */
export type RowButtonProps = Omit<
  ComponentProps<"div">,
  "onClick" | "onKeyDown" | "disabled"
> & {
  /** A row that is shown but not selectable (the Model picker's stale-override
   *  pattern). NOT an HTML attribute of a `div`, so it is declared here and
   *  DESTRUCTURED OUT below — it never reaches the DOM. What a disabled row
   *  emits instead is `aria-disabled="true"` + `tabIndex={-1}`, which is what
   *  `ModelPickerDialog.test.tsx`'s "a disabled row is NOT selectable" reads, and
 *  its click/Enter are inert. */
  disabled?: boolean;
  /** Fires on a click AND on Enter — the two ways every one of the five sites
   *  activates today. Widened beyond `MouseEventHandler` because the Enter path
   *  hands over a keyboard event; no site reads the event (they all ignore their
   *  argument), so the union costs nothing and keeps `tsc` honest. */
  onClick?: (
    event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>,
  ) => void;
};

export function RowButton({
  className,
  onClick,
  disabled,
  tabIndex,
  "aria-disabled": ariaDisabled,
  ...rest
}: RowButtonProps) {
  return (
    <div
      role="button"
      tabIndex={tabIndex ?? (disabled ? -1 : 0)}
      // `undefined` and not `"false"`: an enabled row carries no `aria-disabled`
      // at all, which is what every site does today and what the a11y tree shows.
      aria-disabled={ariaDisabled ?? (disabled ? "true" : undefined)}
      onClick={(event) => {
        // A disabled row is inert to the pointer too. The Model picker guarded
        // this inside its own `select()` (`if (item.disabled) return`); the
        // guard moves here so every site gets it, and the outcome is unchanged.
        if (disabled) return;
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        // Enter only — see the header for why Space stays out.
        if (event.key === "Enter") onClick?.(event);
      }}
      className={className}
      {...rest}
    />
  );
}
