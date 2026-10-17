import { useEffect } from "react";
import { openNewSpaceDialog } from "../lib/newSpaceDialogState";
import { useSessions } from "../store/sessions";

/**
 * The app-wide ⌘N / ⌘O chord — the two app commands that exist wherever the app
 * is, not wherever a particular pane happens to be mounted.
 *
 * MOUNTED EXACTLY ONCE, at `App` root, for the same reason `useAttentionAlert`
 * is (its comment says it plainly: VIEW-INDEPENDENT — mounted with the app, not
 * with the workspace). This listener used to live inside `SpacesList`, and
 * `SpacesList` is inside the `view === "settings"` ternary's else-branch: open
 * the Settings page and the component unmounts, the effect cleans up, and both
 * chords stop existing until you come back. A command that exists in one of the
 * app's two views is not an app command.
 *
 * WHAT IT NO LONGER DOES is the other half of the fix, and the larger one. The
 * old guard read "the caret is in a text field" as "this is not our key". The
 * composer is a `textarea` that nothing ever blurs, so the first keystroke in a
 * draft killed both chords for the rest of the session — and `ComposerRow` never
 * calls `stopPropagation`, so the listener would have taken the chord anyway had
 * the guard let it. A `Cmd`/`Ctrl` chord is an app command, not text editing:
 * browsers and native apps fire it with the caret sitting in a textarea, and so
 * does this one now.
 *
 * ACCEPTED COST (macOS): a literal `Ctrl+N` typed in the composer no longer
 * moves the caret down a line — the Emacs binding loses to the chord. That is a
 * deliberate trade, and it is smaller than it looks: `⌘N` already won this
 * contest before the change (the guard only suppressed chords whose modifier was
 * `Cmd` OR `Ctrl`, so `Ctrl+N` was already claimed everywhere except inside a
 * text field, which is precisely the case being fixed), and `↓` still moves the
 * caret.
 *
 * NO INTERACTION WITH `useAttentionAlert` IS NEEDED, and none is wanted. That
 * hook listens in the CAPTURE phase — precisely because other handlers stop
 * propagation, so an activity signal has to be taken before anyone can swallow
 * it — and this hook adds a BUBBLING listener without removing one. The two
 * therefore coexist on the same event: activity is recorded first, the chord is
 * taken second, and neither sees the other's decision. (Both also fire for a key
 * this hook ignores, which is correct: typing in a composer IS activity.)
 */
export function useAppShortcuts(): void {
  const startSessionInActiveSpace = useSessions(
    (s) => s.startSessionInActiveSpace,
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      // Auto-repeat fires once per repeat and each sequential repeat starts a
      // Session (the store's in-flight guard absorbs only CONCURRENT ones);
      // Shift/Alt combinations are not ours to claim.
      if (e.repeat || e.shiftKey || e.altKey) return;
      // Stand aside ONLY inside an open modal. Radix moves focus INSIDE the
      // content, so an `<input>` there still matches via `closest`. BOTH roles
      // are needed: Radix's AlertDialog renders `role="alertdialog"`, which
      // does NOT match `[role='dialog']`, and the Settings remove-confirmations
      // are AlertDialogs — ⌘N under a "Remove provider?" confirm would move
      // the active Space out from under it.
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("[role='dialog'], [role='alertdialog']")
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        // The store command owns everything downstream, including the no-Space
        // routing: with no Space selected it opens the Open Space dialog rather
        // than starting nothing. That is why the chord needs no `activeView`
        // equivalent here — and no `stopPropagation`: the chord's owners are
        // this one listener and the store.
        void startSessionInActiveSpace();
      } else if (key === "o") {
        e.preventDefault();
        openNewSpaceDialog();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [startSessionInActiveSpace]);
}
