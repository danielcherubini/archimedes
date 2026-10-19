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
 *   - a `min-w` FLOOR HERE (`MIN_INDICATOR_WIDTH_CLASS`, see below) — the box
 *     has to be able to shrink, or a long quip pushes the buttons off the row,
 *     but it must not shrink PAST THE SPINNER;
 *   - `min-w-0` + `truncate` on the `<p>` — `truncate` supplies
 *     `overflow: hidden`, which is what zeroes a flex item's content-based
 *     automatic minimum; `min-w-0` states the intent instead of leaning on
 *     that side effect;
 *   - the spinner is `shrink-0`, because a braille loader that squashes to
 *     three dots is not a spinner any more.
 *
 * THE FLOOR REPLACES A BARE `min-w-0`, AND THE DIFFERENCE IS THE BUG. A bare
 * `min-w-0` lets this box shrink toward ZERO while the `shrink-0` spinner
 * inside it holds its intrinsic ~50px, and this box never clipped — so past
 * the crossover the spinner painted OVER the `+` button, and the quip
 * truncating to nothing could not prevent it, because the spinner ALONE no
 * longer fit. That crossover is not exotic: at the app's DEFAULT 800px window
 * (`tauri.conf.json`) with the left pane open (260px) and the side pane at
 * 400px, the composer island's content box is ~108px, `+` and Send plus their
 * gaps take ~68px, and the indicator is left ~40px — under the ~50px spinner.
 * So the box now refuses to go below `MIN_INDICATOR_WIDTH_PX`, and the row
 * WRAPS (`ComposerRow.tsx`): below the crossover the indicator drops to a line
 * of its own ABOVE the buttons instead of overprinting them. `flex-wrap` is
 * what turns the floor into a fallback rather than a new overflow, and it
 * matches the button wrapper, which already wrapped.
 *
 * `overflow-hidden` on this box was the other candidate and is rejected: it
 * hides the collision by cutting the spinner mid-glyph, which is the exact
 * failure the `shrink-0` above exists to prevent.
 *
 * THE TEXT IS `foreground`, NOT the `foreground-subtle` it used to be, and the
 * reason is the move itself: the row's background changed from the chat plane
 * (`--color-chat`, `#232323` under zai dark) to the composer fill
 * (`--color-input`, `#2b2b2b`), and on the lighter fill subtle text measures
 * **4.46:1** where it measured 4.76:1 on the chat plane — i.e. it crosses
 * WCAG's 4.5:1 small-text floor, on the one line the user reads while the
 * agent works. `foreground` is 9.55:1 there. The spinner already landed on
 * `foreground`, by inheriting the composer island's ink.
 *
 * Props-only: `quip` comes from `useSpinQuip`, which stays in `ChatStream`
 * (it is called unconditionally, alongside the other cue hooks, and this
 * component renders `null` most of the time — a hook in a conditionally-rendered
 * child would change hook count with the working state).
 */
/**
 * The narrow-row floor: the widest spinner the settings offer must stay fully
 * visible inside this box. Derived, not guessed — every variant ships a braille
 * grid of at most 6 cells (`gridSize` in `lib/braille/variants/*`;
 * `reflected-ripple` is the widest) drawn at this component's fixed
 * `fontSize={14}` in `--font-mono`, whose advance is conventionally 0.6em:
 * 6 × 14 × 0.6 ≈ 50px, so the floor sits one spacing step above it. The test
 * re-derives the same number from the variant table independently, so the two
 * cannot drift apart silently.
 */
export const MIN_INDICATOR_WIDTH_PX = 56;
/**
 * `MIN_INDICATOR_WIDTH_PX` as a CLASS, spelled as a LITERAL and not
 * interpolated from the number: Tailwind v4 finds utilities by scanning SOURCE
 * TEXT for candidate names, so a class assembled at runtime — interpolating the
 * px value into the string — produces a name the scanner never sees and never
 * emits. The floor would then do nothing in the browser while every jsdom
 * assertion still passed, because jsdom reads `className` and not the
 * stylesheet: the overlap this change exists to remove, back again and silent.
 * `min-w-14` is the spacing-scale step that equals 56px (14 × 0.25rem) — a real
 * utility, not an arbitrary value. `ChatStream.test.tsx` pins class-to-constant
 * (14 × 4 = 56) so the two spellings cannot drift apart.
 */
export const MIN_INDICATOR_WIDTH_CLASS = "min-w-14";

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
      className={`flex flex-1 flex-wrap items-center gap-2 ${MIN_INDICATOR_WIDTH_CLASS}`}
      data-testid="working-indicator"
    >
      {agentState === "blocked" ? (
        <p className="min-w-0 truncate text-ui-sm text-foreground">
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
          <p className="min-w-0 truncate text-ui-sm text-foreground">
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
          <p className="min-w-0 truncate text-ui-sm text-foreground">{quip}</p>
        </>
      )}
    </div>
  );
}
