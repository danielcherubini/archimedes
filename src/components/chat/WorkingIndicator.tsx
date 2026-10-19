import { BrailleLoader } from "../ui/braille-loader";
import type { BrailleLoaderVariant } from "../../lib/braille-loader";

/**
 * The working indicator: the braille spinner + the rotating quip, the
 * `Compacting` line while a compaction runs, or the waiting line while
 * `blocked`. It renders as ONE ITEM of the composer's bottom row — the left
 * end of the line that carries the `+` and Send buttons — so the composer's
 * bottom edge is a single strip of "what is happening" plus "what you can do".
 *
 * It used to be a bar of its own parked ABOVE the composer box, pulled down
 * onto it with `-mb-2` so the two read as one surface. Inside the row, that
 * hug and the separate line both go away; what replaces them is a constraint
 * the bar never had — **the text must be the thing that gives, never the
 * buttons.** A quip runs to ~60 characters (`lib/spin-quips.ts`), and in a flex
 * row an unshrinkable text child grows the line and squeezes two 24–28px hit
 * targets. Hence three coupled classes, and the row's own `shrink-0` on the
 * button wrapper (`ComposerRow.tsx`):
 *   - `min-w-0` HERE — a flex child's automatic minimum is its content width,
 *     which is exactly what makes a `truncate` descendant a no-op without it;
 *   - `truncate` on the `<p>`;
 *   - the spinner is `shrink-0`, because a braille loader that squashes to
 *     three dots is not a spinner any more.
 *
 * Props-only: `quip` comes from `useSpinQuip`, which stays in `ChatStream`
 * (it is called unconditionally, alongside the other cue hooks, and this
 * component renders `null` most of the time — a hook in a conditionally-rendered
 * child would change hook count with the working state).
 */
export function WorkingIndicator({
  agentState,
  workingOrInTurn,
  compacting,
  spinnerStyle,
  quip,
}: {
  agentState: "working" | "idle" | "blocked" | undefined;
  workingOrInTurn: boolean;
  /** The active session's in-flight compaction reason (ADR 0045), or `undefined` when none runs. */
  compacting?: string;
  spinnerStyle: BrailleLoaderVariant;
  quip: string;
}) {
  // The render gate. It appears while the agent works or waits for input; the
  // message stream scrolls above it, unchanged by any of this. `blocked` takes
  // precedence over `working` (a blocked agent that is also mid-turn shows the
  // waiting line, NOT the braille loader — both would render otherwise).
  //
  // THE GATE WIDENS FOR `compacting`: an IDLE compaction (the `/compact`
  // command, ADR 0045) emits no `turn_start`/`agent_settled`, so neither
  // `agentState === "blocked"` nor `workingOrInTurn` holds — without this term
  // the branch below could never render.
  if (
    !(agentState === "blocked" || compacting !== undefined || workingOrInTurn)
  ) {
    return null;
  }
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-2"
      data-testid="working-indicator"
    >
      {agentState === "blocked" ? (
        <p className="truncate text-ui-sm text-foreground-subtle">
          Waiting for your input…
        </p>
      ) : compacting !== undefined ? (
        // One label for all three reasons (`manual` / `threshold` / `overflow`)
        // is the product decision: what the user needs to know is that the
        // context is being rewritten, not why. The variant is an OVERRIDE —
        // `pulse`, not the settings' `spinnerStyle`: this wait is a different
        // kind of work, and the quip is deliberately absent (the quips are
        // about the agent thinking, which it is not).
        <>
          <BrailleLoader
            variant="pulse"
            speed="normal"
            fontSize={14}
            label="Compacting"
            className="shrink-0"
          />
          <p className="truncate text-ui-sm text-foreground-subtle">
            Compacting
          </p>
        </>
      ) : (
        <>
          <BrailleLoader
            variant={spinnerStyle}
            speed="normal"
            fontSize={14}
            label="Agent working"
            className="shrink-0"
          />
          <p className="truncate text-ui-sm text-foreground-subtle">{quip}</p>
        </>
      )}
    </div>
  );
}
