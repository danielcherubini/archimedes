import type { KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useSubagents } from "../store/subagents";
import { useSubagentSelection } from "../store/subagentSelection";
import { SHEET_WIDTH_CLASS } from "../lib/subagentSheetLayout";
import { SubagentTranscript } from "./SubagentTranscript";
import { MutedCaption } from "./MutedCaption";
import { StatusIcon, STATUS_CHIP_STYLES } from "./SubagentStatusIcon";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";

/**
 * The subagent transcript SHEET — the `fixed` right-side panel that shows ONE
 * Subagent session's transcript (the entry `useSubagentSelection` marks
 * selected). `App` mounts it in the workspace view; unlike `SubagentModals` it
 * holds no gate, so the Settings-view hole that pushed the overlay host outside
 * that view does not apply here.
 *
 * - `SubagentTranscript` is rendered EXACTLY ONCE in the whole app: here, in
 *   the sheet, and ONLY while an entry is selected. (A second copy used to be
 *   mounted for every NON-selected entry and kept rendered, so that child's
 *   prompt cards could never hang unseen. The transcript renders NO gate of
 *   any kind now — a child's gate lives in `MessageList` when its parent is
 *   the active session, otherwise in the `SubagentModals` overlay — so that
 *   second mount was dead weight and is gone.) A non-selected entry therefore
 *   renders nothing until it is selected again; its data stays in the stores,
 *   so the sheet reopens with the full stream.
 * - The sheet's outer `div` is in the DOM even when nothing is selected (the
 *   `hidden` CLASS toggles `display: none`); the inner content mounts only
 *   while an entry is selected. Closing is `select(null)` alone — the entry
 *   stays in `useSubagents` (its row under the "Delegating" card,
 *   `SubagentDelegatingCard`, survives; only the sheet goes away).
 *
 * Esc closes the sheet via a React `onKeyDown` on the SHEET (NOT a
 * window-level handler). `ChatStream` registers a WINDOW-level `keydown`
 * listener that cancels the turn on Escape while a turn is in flight (the
 * "Esc stops inference" effect in `src/components/ChatStream.tsx`). The sheet's
 * `onKeyDown` calls `stopPropagation()`, which React forwards to
 * `nativeEvent.stopPropagation()`, so the native event stops AT THE REACT ROOT
 * before it reaches `window`: closing the sheet never cancels the parent's
 * turn. A window-level handler would fire for EVERY Escape (including ones
 * another consumer already consumed) and would have to swallow them. The sudo
 * modals are `fixed` overlays rendered by `SubagentModals` at the `App` root —
 * NOT in the sheet's subtree — so their own Esc handling runs independently of
 * this one.
 *
 * KNOWN LIMITATION (accepted): Esc only closes the sheet when focus is INSIDE
 * the sheet (the user clicked a row to open it, so focus is in it); an Esc with
 * focus OUTSIDE the sheet does not close it (the user uses the `X` or re-clicks
 * a row).
 */
export default function SubagentDetailHost() {
  const selectedId = useSubagentSelection((s) => s.selectedSessionId);
  const selected = useSubagents((s) => (selectedId ? s.entries[selectedId] : undefined));
  const select = useSubagentSelection((s) => s.select);
  // Esc closes the sheet (see the component doc for WHY this is a React
  // `onKeyDown` on the sheet and NOT a window-level handler).
  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      select(null);
    }
  };

  return (
    // The sheet: a `fixed` right-side panel that stays in the DOM whether or
    // not an entry is selected (the `hidden` CLASS toggles `display: none`).
    // Its width utility is `SHEET_WIDTH_CLASS`
    // (`src/lib/subagentSheetLayout.ts`): `SubagentModals`' card panel offsets
    // by that same number to sit to THIS sheet's left, so both surfaces read ONE
    // constant and the dodge cannot drift away from the sheet it dodges — widen
    // the sheet and the layout module's own literal has to move with it, or `tsc`
    // says so. See that module for why the literal lives there and not here.
    <div
      role="dialog"
      aria-label={`${selected?.agentName ?? ""} — transcript`}
      onKeyDown={handleEsc}
      className={cn(
        // `hidden` and `flex` are ONE tailwind-merge group (display), so the
        // merged string keeps `hidden` and DROPS `flex` on the unselected arm.
        // That is not a behaviour change: the concatenation it replaces carried
        // both and CSS source order already settled it — `.hidden` is emitted
        // after `.flex` in `dist/assets/*.css`, so `display: none` won then and
        // wins now, one way or the other. `flex-col` is a different group and
        // survives untouched.
        "fixed top-0 right-0 z-50 flex h-full max-w-[90vw] flex-col border-l border-border bg-background shadow-xl",
        SHEET_WIDTH_CLASS,
        selected ? "" : "hidden",
      )}
    >
      {selected && (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-border/50 p-3">
            <div className="flex min-w-0 items-center gap-2">
              <StatusIcon status={selected.status} />
              <span className="min-w-0 truncate text-ui-base font-medium">
                {selected.agentName}
              </span>
              <span
                className={cn(
                  "shrink-0 text-ui-xs",
                  STATUS_CHIP_STYLES[selected.status],
                )}
              >
                {selected.status}
              </span>
              {/* (issue #47) The resolve miss, mirroring the directory row: ONE
                  quiet caption and ONLY for `unmatched` (the dialog's
                  `aria-label` above is untouched — the name stays whatever the
                  model asked for). A child named after no definition still
                  runs, so this says "no persona loaded", not "failed". */}
              {selected.nameResolution === "unmatched" && (
                <MutedCaption
                  className="shrink-0 text-warning"
                  title={`No Agent definition named "${selected.agentName}" — this child loaded no persona, no tool allowlist and no model override, and ran the parent's config instead.`}
                >
                  no matching Agent
                </MutedCaption>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => select(null)}
              aria-label="Close subagent transcript"
              className={cn(
                // C7. The negations undo `Button`'s base and the `icon-sm`
                // size, both of which would change what this ✕ paints; the
                // row's own classes come LAST so they win every group they
                // spell (that is how `hover:text-foreground` and `size-6`
                // already beat the ghost arm's ink and the size's box).
                //   `rounded-none`  — `icon-sm` is `rounded-md`; this ✕ is
                //                      square-cornered and a radius would
                //                      clip its 2px hover inset;
                //   `border-0`      — the base's 1px ring would make this 26px;
                //   `transition-none` — no hover fade here. This is the tab
                //                      strip's second-cluster grammar, not the
                //                      chrome bar's `transition-colors` (see
                //                      `chromeButton.ts`'s consumer contract);
                //   `hover:bg-transparent` — the ghost arm FILLS `bg-hover`.
                //                      This ✕ has never had a fill: its only
                //                      hover affordance is the ink lift.
                // The rest of the base is inert on this element: no background
                // for `bg-clip-padding` to clip, nothing ever sets
                // `aria-expanded` or `aria-invalid` here, the button is never
                // disabled, `outline-none` is what `base.css:53-57` forces with
                // `!important` on every focus anyway, no child carries
                // `data-icon` for the `has-data-[icon=…]` paddings to fire on,
                // the content is one icon so `whitespace-nowrap`/`select-none`
                // have nothing to act on, and the `<X>` already carries
                // `size-4` so the base's
                // `[&_svg:not([class*='size-'])]:size-3` cannot reach it.
                "rounded-none border-0 transition-none hover:bg-transparent",
                "flex size-6 shrink-0 items-center justify-center text-foreground-subtle hover:text-foreground",
              )}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <SubagentTranscript sessionId={selected.sessionId} />
          </div>
        </>
      )}
    </div>
  );
}
