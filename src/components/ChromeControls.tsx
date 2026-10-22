import { useSyncExternalStore } from "react";
import {
  PanelLeftIcon,
  PanelRightIcon,
  SettingsIcon,
} from "lucide-react";
import {
  getLeftPaneCollapsed,
  setLeftPaneCollapsed,
  subscribeLeftPane,
} from "../lib/leftPaneState";
import {
  getSidePaneCollapsed,
  setSidePaneCollapsed,
  subscribeSidePane,
} from "../lib/sidePaneState";
import { useHasPendingRequest } from "../hooks/useHasPendingRequest";

/**
 * The chrome bar's app-control cluster — the Settings gear and the two pane
 * collapse toggles — sitting immediately left of `WindowControls`, so the whole
 * top-right of the window reads as one group of window/app buttons.
 *
 * WHY HERE AND NOT IN THE PANES: these three controls used to live at the
 * BOTTOM of their own panes (the gear and the left toggle in the sidebar's
 * footer, the right toggle pinned to the side pane's inner-bottom corner), and
 * the collapsed rail carried a second copy of the gear while the sidebar was a
 * sliver. That placement had one job — keep the control under the cursor that
 * just used it — and a long list of consequences to defend it: the gear had to
 * be hidden rather than clipped so it would not poke into the rail, the rail
 * needed a tail action strip so collapsing did not lock you out of Settings,
 * the rails reserved `bottom-9` and the session config block `pb-10` purely to
 * leave the toggles a gap, and a collapsed pane's sliver had to be exactly wide
 * enough to hold a 24px button. Here, the controls exist independently of any
 * pane's width, so all of that falls away with them.
 *
 * ONE CONTROL PER JOB, UNCONDITIONAL. Both toggles render in both states, so
 * one button per pane does collapse AND expand (the label and `aria-pressed`
 * flip with the state; pressed = the pane is OPEN). There is no second copy
 * anywhere — no rail tail strip, no footer gear. The tests that used to pin the
 * OLD placement (`the chrome bar NEVER holds a pane control`, `has EXACTLY ONE
 * Settings door`, `KEEPS its toggle while collapsed`) now assert the inverse:
 * the bar holds all three, and the panes hold none.
 *
 * OUTSIDE `WindowControls`' `[data-window-control]` container, deliberately.
 * That attribute is the attention-alert's exemption (ADR 0038): a click inside
 * it is NOT treated as user activity, which is right for "run finishes → click
 * Minimize → walk away" and wrong here — clicking a pane open or the gear is a
 * person coming back to work, and the alert should hear that.
 *
 * The `bg-warning` dot keeps its old meaning — "something needs you BEHIND the
 * hidden pane" — so it stays gated on that pane's own collapsed flag, not on the
 * pending state alone: a dot on a toggle whose pane is open would duplicate the
 * cue the pane is already showing.
 */
export default function ChromeControls({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const leftCollapsed = useSyncExternalStore(
    subscribeLeftPane,
    getLeftPaneCollapsed,
  );
  const rightCollapsed = useSyncExternalStore(
    subscribeSidePane,
    getSidePaneCollapsed,
  );
  // The ONE derivation of "you owe an answer somewhere" — the same hook the
  // sidebar rows' `?` and the composer read, so the dots cannot disagree.
  const hasPendingRequest = useHasPendingRequest();

  // The shared button grammar: `WindowControls`' box size (these sit in the
  // same row, facing the same cursor) and its subtle-ink hover.
  const BTN =
    "relative flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground";

  return (
    <div className="flex items-center gap-0.5 pr-1" data-testid="chrome-controls">
      <button
        type="button"
        aria-label="Settings"
        onClick={onOpenSettings}
        className={BTN}
      >
        <SettingsIcon size={14} aria-hidden />
      </button>
      <button
        type="button"
        data-testid="left-pane-toggle"
        aria-label={
          leftCollapsed ? "Expand session list" : "Collapse session list"
        }
        aria-pressed={!leftCollapsed}
        onClick={() => setLeftPaneCollapsed(!leftCollapsed)}
        className={BTN}
      >
        <PanelLeftIcon size={14} aria-hidden />
        {leftCollapsed && hasPendingRequest && (
          <span
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warning"
            aria-hidden
          />
        )}
      </button>
      <button
        type="button"
        data-testid="right-pane-toggle"
        aria-label={rightCollapsed ? "Expand side pane" : "Collapse side pane"}
        aria-pressed={!rightCollapsed}
        onClick={() => setSidePaneCollapsed(!rightCollapsed)}
        className={BTN}
      >
        <PanelRightIcon size={14} aria-hidden />
        {rightCollapsed && hasPendingRequest && (
          <span
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warning"
            aria-hidden
          />
        )}
      </button>
    </div>
  );
}
