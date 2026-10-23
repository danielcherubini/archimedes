import type { ReactNode } from "react";
import { cn } from "./lib/utils";
import { RowButton } from "./RowButton";

/**
 * One **Session** row of the sidebar, ONCE (finding 3, Task C4).
 *
 * `SessionRow` (live + stored) and `ArchivedSessionRow` were this component
 * drawn twice. A line-by-line diff found the shell identical in every respect
 * and exactly TWO real differences, so exactly two slots are props (plus
 * `time`, which turned out not to be a difference at all — see below):
 *
 *  - **`leading`** — the 16px slot. A live/stored row wears the attention mark
 *    (`SessionStatusMark`, the spinner / `?` / ring the collapsed rail and the
 *    tab draw from the same rule); an archived row wears NOTHING, because an
 *    archived Session is never live. Both are 16px, which is what keeps the two
 *    sections' titles vertically aligned.
 *  - **`actions`** — the hover-revealed buttons. Live: Stop then Archive.
 *    Stored: Archive alone. Archived: Unarchive then Delete. The ORDER is a
 *    decision at each site (ADR 0016: Archive is reversible so the live row
 *    does not copy the archived row's destructive-outermost rule), so this
 *    component renders what it is handed, in order, unwrapped.
 *
 * The time slot LOOKED like a third difference — `SessionRow` hoisted a
 * `rightSlot` variable, `ArchivedSessionRow` inlined the ternary — but the two
 * arms were the same two nodes, so it is a prop of its own (`time`) and the two
 * arms live here once.
 *
 * ---------------------------------------------------------------------------
 * THREE CONSTRAINTS THIS FILE EXISTS TO RESPECT
 * ---------------------------------------------------------------------------
 *
 * **`textContent` must be the TITLE ALONE** when there is no time.
 * `SpacesList.test.tsx`'s "renders an empty time slot (no time text) for a
 * session with no loaded messages" asserts `row!.textContent === "alpha"` — exact
 * equality, the tightest pin on this surface. Nothing here may add a node or a
 * character of text: no wrapper label, no `· {spaceName}` suffix (the Archived
 * section is Space-scoped, so that suffix was deleted deliberately), no text
 * inside the action buttons (they carry `aria-label`s and an icon, and jsdom
 * keeps them in the DOM even though CSS hides them until hover).
 *
 * **NO DOM LEVEL.** Every child is a DIRECT child of the `role="button"`
 * element. `SpacesList.test.tsx`'s "keeps the rail's marks POSITIONALLY equal to
 * the rows after the activity sort" compares row positions with
 * `compareDocumentPosition` against the collapsed rail's marks, and the eight
 * `.closest('[role="button"]')` sites plus `rowOf()` resolve through ancestry.
 * Same lesson C6 recorded for the picker shell: a React boundary is free, an
 * element is not.
 *
 * **ONE `role="button"`.** The row is the affordance (`RowButton`); its hover
 * actions are plain `<button>` elements with no `role`. `RowButton` is
 * therefore NOT used for an action — it would emit `role="button"` inside the
 * row and turn each of the `rowOf(…).getByRole("button", { name: "Archive …" })`
 * queries into a multiple-match throw.
 *
 * The `cn()` call below is the identity by measurement (the C8 note that used
 * to sit at the call site): the two ternary arms are mutually exclusive and both
 * land in tailwind-merge's background group, so exactly one of `bg-selected` /
 * `hover:bg-surface-hover` reaches the string, which is what the `bg-selected`
 * pin — "opens a session on row click (the store's activeSessionId + the
 * selection styling)" — reads.
 */
export interface SessionListRowProps {
  /** The row's display title — already resolved by the caller (`titleFor`). */
  title: string;
  /** Whether this is the open Session (the row wears `bg-selected`). */
  active?: boolean;
  /** The relative time of last activity, or `null` for no loaded transcript. */
  time?: string | null;
  /** The 16px leading slot. Defaults to the empty archived-row slot. */
  leading?: ReactNode;
  /** Hover-revealed action buttons, in the order the site wants them. */
  actions?: ReactNode;
  /** Open the Session (click, or Enter). */
  onOpen: () => void;
}

export function SessionListRow({
  title,
  active = false,
  time = null,
  leading,
  actions,
  onOpen,
}: SessionListRowProps) {
  return (
    <RowButton
      onClick={onOpen}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1",
        active ? "bg-selected" : "hover:bg-surface-hover",
      )}
    >
      {/* The state glyph, in the slot the spinner already owned: a session that
          is idle now wears a RING rather than nothing, which is the cue the
          collapsed rail has always had and the expanded list has never shown.
          16px = the slot's old `size-4`, so the title's indent is unchanged and
          these rows still line up with the Archived section, whose leading slot
          is the same 16px. NO ink class here: the mark owns the ink
          (`text-foreground` on the active row, `text-foreground-subtlest`
          otherwise), and passing one from the row would fight it — which of two
          same-specificity utility classes wins is a CSS source-order fact this
          row cannot control. An archived row passes NOTHING and gets the plain
          16px spacer. */}
      {leading ?? <span className="size-4 shrink-0" />}
      {/* NOT `truncate`: the fade mask is the sole overflow cue (background-agnostic,
          so it works over `bg-frame` / `bg-selected` / `bg-surface-hover` alike), and
          the text overflows UNDER the fade rather than being ellipsized. */}
      <span
        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ui-base text-foreground"
        style={{
          maskImage:
            "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
          WebkitMaskImage:
            "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
        }}
      >
        {title}
      </span>
      {/* Every row — live, stored or archived — swaps the time for its actions at
          hover. The live row used to render the time with no swap at all: the Pause
          button was deleted and nothing replaced it, so a running Session had no way
          to be stopped or put away without opening it first. */}
      <span className="group-hover:hidden">
        {time !== null ? (
          <span className="text-ui-sm text-foreground-subtle">{time}</span>
        ) : (
          // Empty slot — keeps alignment when there is no loaded transcript.
          <span className="size-4" />
        )}
      </span>
      {actions}
    </RowButton>
  );
}
