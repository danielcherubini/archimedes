import { useCallback } from "react";
import { Brain } from "lucide-react";
import SessionConfigSelect from "./SessionConfigSelect";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { useSessions } from "../store/sessions";
import { setSessionConfigOption } from "../lib/tauri";
import {
  contextPercentOf,
  contextRampFor,
  contextUsageOf,
  findConfigOption,
  sessionConfigOptionsOf,
} from "../lib/sessionConfig";

/**
 * The session's three config LINES — Model, Reasoning, Context — stacked at the
 * BOTTOM of the side pane. They used to be the composer's bottom row; they moved
 * because a 40px-wide composer row cannot hold a bar, two triggers and two
 * buttons, and because the move kills a perf coupling: the composer re-renders
 * on every keystroke (`draft` is its state), and the selectors sat in that
 * subtree (see the memo note in `SessionConfigSelect.tsx` — a per-option closure
 * re-rendered ~600 mounted model `SelectItem`s at ~140ms per keystroke). The
 * pane reads STORES and never the draft, so typing cannot re-render these
 * controls at all.
 *
 * Three placement decisions, each load-bearing:
 *
 * - **A sibling AFTER the pane's scroll area, never inside it.** The content
 *   div is `flex-1 overflow-y-auto` and the todo boards GROW, so a block inside
 *   it scrolls away and drifts with the board's length — the config of the
 *   session you are looking at would be somewhere above the fold. Pinned by the
 *   `mounts the config block AFTER the scroll area` case in `SidePane.test.tsx`.
 * - **`shrink-0` on the wrapper.** The frame is a `flex-col` whose only other
 *   child is the `flex-1` (basis 0) scroller, so a new sibling with the default
 *   `flex-basis: auto` would be the ONLY item able to absorb a height shortfall:
 *   a long board would squash the block to nothing instead of scrolling. The
 *   composer island documents the identical trap (`ComposerRow.tsx`).
 * - **`invisible` while collapsed, on its OWN class.** The scroller carries
 *   `invisible` while the pane is collapsed to its 40px rail, and that class is
 *   what keeps the board's text and scrollbar out of the sliver paint. This
 *   block is the scroller's SIBLING, so it needs its own — and while collapsed
 *   there is deliberately NO access to model / reasoning / context: the user
 *   expands the pane to change them.
 *
 * The Context line gets its own `bg-input` WELL. That is not decoration: the
 * bar used to paint on `--color-composer` (`#21222c`), where the `#343746` track
 * measured 1.339 against it. On the pane's `--color-inspector` (`#282a36`) the
 * same track measures 1.208 — under the 1.3 floor both contrast gates enforce,
 * so the bar's EXTENT (the only thing it reports) would be unreadable. `bg-input`
 * (`#191a21`) puts the pair back to 1.471 with no token re-valued, and it is
 * where the bar originally lived before the island layout moved it out.
 */
export default function SessionConfigBlock({ collapsed }: { collapsed: boolean }) {
  // The derivations are the SHARED ones (`lib/sessionConfig`), run INSIDE the
  // selector so this component subscribes to the derived VALUE and not to the
  // three session lists. Stable references either way: `sessionConfigOptionsOf`
  // returns the stored array (or `null`), `contextUsageOf` a stored object (or
  // `undefined`) — never a fresh literal.
  const configOptions = useSessions((s) =>
    sessionConfigOptionsOf(s, s.activeSessionId),
  );
  const contextUsage = useSessions((s) =>
    contextUsageOf(s, s.activeSessionId),
  );
  // A stored (non-live) session: its transcript is read-only unless the agent
  // negotiated `loadSession`. `!!liveSession` — found by id in `sessions`, NOT a
  // truthiness test on `activeSessionId` (a stored session has an id too, and its
  // selectors must be populated but DISABLED: there is no agent process to
  // deliver `set_config_option` to).
  const isLive = useSessions(
    (s) => !!s.sessions.find((x) => x.sessionId === s.activeSessionId),
  );
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const applyConfigOptions = useSessions((s) => s.applyConfigOptions);

  // ONE stable callback for both config selects (the consumer-side half of the
  // SessionConfigSelect memo fix): a per-option closure minted per render would
  // re-render the ~600 mounted model-catalog SelectItems on every re-render of
  // the parent. `applyConfigOptions` is a zustand action — a stable reference —
  // so this callback's identity only changes when the active session changes.
  const onSet = useCallback(
    async (optionId: string, value: string) => {
      if (!activeSessionId) return;
      const options = await setSessionConfigOption(
        activeSessionId,
        optionId,
        value,
      );
      applyConfigOptions(activeSessionId, options);
    },
    [activeSessionId, applyConfigOptions],
  );

  const contextPercent = contextPercentOf(contextUsage);
  const contextRamp = contextRampFor(contextPercent);
  const modelOption = findConfigOption(configOptions, "model", "model");
  const thinkingOption = findConfigOption(
    configOptions,
    "thought_level",
    "thought_level",
  );
  // The token counts as TEXT (the number is what the bar shows; these are
  // what the assistive tech and the tooltip carry). `undefined` until the
  // first usage frame — the same gate as the label itself.
  const countsText =
    contextUsage && contextPercent !== undefined
      ? `${contextUsage.used.toLocaleString()} of ${contextUsage.window.toLocaleString()} tokens (${contextPercent}%)`
      : undefined;
  const countsLabel = countsText ? `Context used: ${countsText}` : undefined;

  return (
    <div
      data-testid="session-config-block"
      className={`shrink-0 px-3 pb-10 pt-2 ${collapsed ? "invisible" : ""}`}
    >
      <div className="flex flex-col gap-1.5" data-testid="session-config-controls">
        {/* Model, then Reasoning, then Context: one control per line, each
            full line-width (`fullWidth` — see `SessionConfigSelect`). The
            composer's tight `gap-1` cluster is gone: it existed to knit two
            side-by-side triggers into one block of session config, and on a
            stacked line there is nothing to knit. */}
        <div className="min-w-0">
          <SessionConfigSelect
            kind="model"
            option={modelOption ?? null}
            onSet={onSet}
            disabled={!isLive}
            fullWidth
          />
        </div>
        <div className="min-w-0">
          <SessionConfigSelect
            kind="thinking"
            option={thinkingOption ?? null}
            onSet={onSet}
            disabled={!isLive}
            fullWidth
          />
        </div>
        {/* The context bar (the dynamic percentage — the reference UI's
            `🧠 [====] 61%` look), ALWAYS rendered: a live session's fill appears
            as the session grows, the label waits for the first frame, and a
            closed session (the context is dropped on close — re-emitted on
            resume) shows the empty 0% track. It is its own `bg-input` well (see
            the component note). */}
        <div
          className="flex min-w-0 items-center gap-2 rounded-md bg-input px-2 py-1"
          data-testid="context-usage-bar"
        >
          <Brain
            className="size-3.5 shrink-0 text-foreground-subtle"
            aria-hidden
            data-testid="context-bar-icon"
          />
          {/* The counts ride the progressbar as its TEXT alternative
              (`aria-valuetext`) — a bare percentage is what the bar draws, but
              the numbers are the useful part and a progressbar exposes only its
              value. */}
          {/* The track is its OWN token (`--color-context-track`), not the
              subtlest-TEXT token it used to borrow. The bar's whole meaning is
              the band FILL (green → caution → warning → red) and the track is
              the only thing separating that fill from the unfilled remainder;
              under Dracula the borrowed Comment hue measured 3.43 / 4.21 /
              2.76 / 1.73 against the four fills this component emits, so the red
              band was almost invisible on the bar it was drawn on. Every palette
              but Dracula aliases the new token straight back to
              `foreground-subtlest`, so zai renders EXACTLY as it always has. The
              per-palette ratios (track vs the `bg-input` well, and each band vs
              the track) are pinned in the context-bar gate in
              `paletteCompleteness.test.ts`. */}
          <div
            role="progressbar"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={contextPercent ?? 0}
            aria-valuetext={countsText}
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-context-track"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${contextRamp.fill}`}
              style={{ width: `${contextPercent ?? 0}%` }}
            />
          </div>
          {contextPercent !== undefined && contextUsage && (
            <TooltipProvider>
              <Tooltip>
                {/* The trigger is a BUTTON, not a `<span>`: Radix opens
                    the tooltip on focus, so the counts are
                    keyboard-reachable only if the trigger is a tab stop;
                    and they ride in the accessible NAME, so they are
                    heard without opening the tooltip at all. Visuals are
                    unchanged — the reset classes keep the bare-number
                    look. */}
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-testid="context-usage"
                    aria-label={countsLabel}
                    className={`shrink-0 cursor-help appearance-none rounded-sm border-0 bg-transparent p-0 text-ui-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${contextRamp.label}`}
                  >
                    {contextPercent}%
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" align="end">
                  {contextUsage.used.toLocaleString()} /{" "}
                  {contextUsage.window.toLocaleString()} tokens ·{" "}
                  {contextPercent}% of context
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
    </div>
  );
}
