import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useSessions } from "../store/sessions";
import { Button } from "./ui/button";

/**
 * The reason the last new-session attempt failed, shown wherever the user is.
 *
 * WHY THIS COMPONENT EXISTS. `startSessionInActiveSpace` records a rejection in
 * `newSessionError`, and until now the ONLY thing that read it was the sidebar's
 * `Session actions` trigger `title` (`SpacesList`) — the component the Settings
 * view UNMOUNTS. So `⌘N` pressed on the Settings page could fail and say nothing
 * anywhere: no dialog, no message, no toast. That hole is this branch's own
 * doing: before it the chord did not exist on the Settings page at all, so
 * moving the chord to `App` root (`useAppShortcuts`) widened the silent-failure
 * surface as a side effect. A command that is app-scoped needs its failure
 * app-scoped too. So this banner mounts at `App` root, a sibling of the view
 * ternary exactly like `SubagentModals` and the root `NewSpaceDialog`, and the
 * reason survives the page the sidebar does not.
 *
 * WHY A STRIP AND NOT A TOAST. `SessionStalledBanner` is this repo's existing
 * answer to "a store field the user has to notice": a `role="alert"` strip on the
 * `warning` tokens with a dismiss button. This copies that shape. A toast would
 * expire on a failure the user cannot fix in one keystroke (a folder that
 * vanished, a harness that will not start) — and that message IS the payload.
 * The sidebar's `title` stays as it was: a tooltip on a menu item is the right
 * surface for "why is this item dead", not for "your keystroke did nothing".
 *
 * DISMISSAL HIDES THE CURRENT NOTICE AND NOTHING AFTER IT, which is the one
 * subtle thing here. This component never unmounts, so unlike
 * `SessionStalledBanner` — which remounts with its session and gets a fresh local
 * `useState` for free — a plain boolean would let ONE click hide every later
 * failure for the rest of the session: a brand-new reason would land in the store
 * and stay invisible, which is exactly the silent failure this banner was added
 * to close. So the dismissal stands down only until the field is cleared, and the
 * action clears it at the top of EVERY run: dismissing, then pressing `⌘N` again,
 * always re-arms the notice. The effect below is the repo's "adjust state when
 * the store changes" bookkeeping, not a render-time guess.
 *
 * THE FIELD IS NOT CLEARED HERE — deliberately. It is also the sidebar menu's
 * `title`, and its own contract in `store/sessions.ts` says it is cleared ONLY by
 * the reset at the top of the next run (the branch deleted the old hook's
 * `clearError` because no consumer ever called one). Dismissing from here would
 * let one surface's housekeeping un-inform another, so dismissal is local state.
 */
export default function NewSessionErrorBanner() {
  const newSessionError = useSessions((s) => s.newSessionError);
  // The message the user dismissed; `null` while nothing is dismissed.
  const [dismissedMessage, setDismissedMessage] = useState<string | null>(null);
  // Re-arm whenever the field empties — which is what the next attempt does
  // before it can fail again. (No dependency on the message text: a repeat of an
  // old reason after a fresh attempt is news again, because the attempt is new.)
  useEffect(() => {
    if (newSessionError === null) setDismissedMessage(null);
  }, [newSessionError]);
  if (newSessionError === null || newSessionError === dismissedMessage) {
    return null;
  }
  return (
    <div
      role="alert"
      data-testid="new-session-error"
      className="mx-2 my-1 flex shrink-0 items-start gap-3 rounded-lg border border-warning bg-warning/10 px-3 py-2"
    >
      <p className="min-w-0 flex-1 text-ui-base text-warning">
        Could not start a session — {newSessionError}
      </p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss new-session error"
        onClick={() => setDismissedMessage(newSessionError)}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
