import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

/**
 * The confirm that stands between closing a tab and orphaning its work
 * (`SpaceTabs`). Shown ONLY when the Space still holds a LIVE `Session` — a
 * live one has a Worker behind it, and the sidebar groups Sessions by
 * **Space**, so a closed tab hides its Sessions while they keep running with
 * no surface left to stop them from. Nothing else needs asking: closing a
 * quiet Space is reversible by re-opening the folder, so it just happens.
 *
 * THREE exits, because there are two honest answers and one refusal:
 * - **Stop and close** — `close_session` each listed Session, then close.
 *   The safe default, so it is the emphasized button.
 * - **Close anyway** — the tab goes and the Sessions keep running (a turn you
 *   want finished but a tab you want gone). Their frames still arrive; only
 *   the row is unreachable until the Space is re-opened.
 * - **Cancel** — and the same abort for Escape / the overlay, per the
 *   `DeleteSessionDialog` precedent (no ✕ in the corner: the footer's Cancel
 *   is the only visible exit, so the overlay must not imply a fourth action).
 *
 * The description says OUT LOUD that the conversations survive. That is the
 * whole anxiety of a Close button, and "Forget this space" alone does not
 * settle it.
 *
 * THE LIST OF SESSIONS IS A LIST, NEXT TO the description, not inside it — the
 * `DeleteSessionDialog`'s split (subject in its own element, prose left alone).
 * `DialogDescription` is the dialog's `aria-describedby`, so anything folded in
 * there is announced as one run-on sentence, and a run of titles read back that
 * way is noise. It is also capped (`max-h-40`, scrollable): a Space with a
 * dozen open Sessions must grow the list, not push the buttons off-screen.
 * The rows are keyed by Session ID, because `titleFor` falls back to the
 * **Space**'s folder name for a Session with neither a title nor a first
 * message — two of those label identically, and a label is not a key.
 */
export default function CloseSpaceDialog({
  spaceName,
  sessions,
  onStopAndClose,
  onCloseAnyway,
  onClose,
}: {
  /** The Space's display label (its folder's base name). */
  spaceName: string;
  /**
   * The open Sessions (never empty — that case closes without asking): the id
   * `Stop and close` stops and the label the rows show them by.
   */
  sessions: { id: string; label: string }[];
  onStopAndClose: () => void;
  onCloseAnyway: () => void;
  onClose: () => void;
}) {
  const plural = sessions.length > 1;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Escape / overlay click: the same exit as Cancel.
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Close &ldquo;{spaceName}&rdquo;?</DialogTitle>
        </DialogHeader>
        {/* The Sessions at stake, as their own list — see the note above. */}
        <ul className="max-h-40 overflow-y-auto pr-1">
          {sessions.map((s) => (
            <li key={s.id} className="truncate font-medium text-foreground">
              {s.label}
            </li>
          ))}
        </ul>
        <DialogDescription>
          {plural
            ? `${sessions.length} sessions here are still open`
            : "A session here is still open"}
          . Closing the tab forgets the Space — its conversations stay, and
          re-opening the folder brings them back. Stop the{" "}
          {plural ? "sessions" : "session"} too?
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="ghost" onClick={onCloseAnyway}>
            Close anyway
          </Button>
          <Button onClick={onStopAndClose}>Stop and close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
