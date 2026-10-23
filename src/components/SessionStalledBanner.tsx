import { useState } from "react";
import { X } from "lucide-react";
import { useSessions } from "../store/sessions";
import { externalOpen } from "../lib/tauri";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";

/**
 * C7: the crash-log line is a `<Button variant="link" size="default">`. `link` is
 * the variant that matches what this line already was — a text-coloured,
 * underline-on-hover control — and it is the ONLY variant with no hover
 * background, so nothing has to be undone against `hover:bg-*`; its
 * `underline-offset-4` loses to the line's own `underline-offset-2` and its
 * `text-primary` loses to `text-foreground-subtle`. Both props are named
 * explicitly because `ui/button.tsx:40` sets `defaultVariants {variant:"default"}`,
 * which would otherwise paint this path string `bg-primary` in a warning banner.
 * Measured with the real `cn()`, the rendered utility SET is exactly what the
 * line spelled. What `CRASH_LOG_WALL` undoes:
 *  - `border-0` — the base's `border` is a 1px ring this line never had
 *    (preflight sets `border: 0 solid`); it would indent the path by 1px inside
 *    the banner and make the base's `bg-clip-padding` a no-op besides.
 *  - `h-auto` — the size's `h-7` is a fixed 28px; the line is a `block` text line
 *    at its own line-height.
 *  - `px-0` — the size's `px-2` would inset the path by 8px, so it would not
 *    start at the same x as the sentence above it.
 *  - `justify-start` — the base centres on the main axis.
 *  - `shrink` — belt-and-braces, provably inert: the base's `shrink-0` would
 *    refuse to shrink, but this line is a block child of the banner's
 *    `min-w-0 flex-1` BLOCK column, so `flex-shrink` never applies to it. It is
 *    restored anyway so a future flex parent cannot silently inherit a
 *    non-shrinking path that pushes the Resume/Dismiss buttons out.
 *  - `select-auto` — the base's `select-none` would make a crash-log PATH
 *    unselectable, which is exactly the text a user wants to copy.
 * Inert here: `inline-flex` is overridden by the line's own `block` (same
 * display group, later wins); `gap-1` (a `block` element has no flex gap);
 * `items-center`/`justify-center` (not a flex container); `rounded-md` +
 * `bg-clip-padding` (no background paints); `whitespace-nowrap` (the line spells
 * `truncate`, whose own `white-space: nowrap` it needs anyway);
 * `transition-colors` (the only hover change is `underline`, which is not a
 * colour transition — the underline appears instantly either way);
 * `outline-none` (`base.css:53-57` forces `outline: none !important` on every
 * focus, and again under `forced-colors`); `disabled:*` / `aria-invalid:*` /
 * `aria-expanded:*`; `group/button`; `text-ui-base` from the size (it collapses
 * the base's `text-ui-base/relaxed` in the same font-size group, and the line's
 * own `text-ui-sm` is spelled LATER so it wins the group outright);
 * `has-data-[icon=inline-*]:pr/pl` (no child at all); and the three `[&_svg…]`
 * rules (the line's only child is a text node — no `<svg>` to resize).
 */
const CRASH_LOG_WALL =
  "border-0 h-auto px-0 justify-start shrink select-auto";

/**
 * The stalled-session banner (ADR 0025 Task 6 — the user-visible half of
 * the Worker architecture): shown when the session's state is `stalled`
 * (a Worker crash — the `session-stalled` event set the store's
 * `stalled` entry). The spec's §4 wording: "Session stopped
 * unexpectedly at <time> — last turn incomplete."
 *
 * - `[Resume]` calls the store's `resumeSession` (the `resume_session`
 *   command — the Supervisor re-spawns the Worker; a success clears the
 *   `stalled` entry, which hides the banner).
 * - The secondary line (a clickable file path — the External-open seam,
 *   ADR 0051) shows the crash log when `crashLog` is non-null.
 * - Dismissible (a LOCAL `useState` — the session stays stalled in the
 *   store; the banner reappears on re-open, when the component remounts
 *   with a fresh dismiss state).
 */
export default function SessionStalledBanner({
  sessionId,
}: {
  sessionId: string;
}) {
  const stalled = useSessions((s) => s.stalled[sessionId]);
  const resumeSession = useSessions((s) => s.resumeSession);
  const [dismissed, setDismissed] = useState(false);
  if (!stalled || dismissed) return null;
  return (
    <div
      role="alert"
      data-testid="stalled-banner"
      className="flex items-start gap-3 rounded-lg border border-warning bg-warning/10 px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="text-ui-base text-warning">
          Session stopped unexpectedly at {new Date(stalled.at).toLocaleString()} — last turn incomplete.
        </p>
        {stalled.crashLog && (
          <Button
            type="button"
            variant="link"
            size="default"
            data-testid="stalled-crash-log"
            onClick={() => void externalOpen(stalled.crashLog!)}
            className={cn(
              CRASH_LOG_WALL,
              "mt-0.5 block max-w-full truncate font-mono text-ui-sm text-foreground-subtle underline-offset-2 hover:underline",
            )}
            title={stalled.crashLog}
          >
            {stalled.crashLog}
          </Button>
        )}
      </div>
      <Button
        variant="warning"
        size="sm"
        onClick={() => void resumeSession(sessionId)}
      >
        Resume
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss stalled banner"
        onClick={() => setDismissed(true)}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
