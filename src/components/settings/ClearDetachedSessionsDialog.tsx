import type { ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * The confirm for "clear detached sessions" — the app's WIDEST destructive
 * action (it deletes every stored session whose Space tab is closed, at once).
 * `docs/decisions/0016-session-archive-first-delete.md`'s 2026-10-21 amendment
 * accepts it precisely because it sits in a Settings surface reached only on
 * purpose, and requires the confirm to name the blast radius: hence the title
 * carries BOTH numbers (the session count and the folder count) and the body
 * lists the folders themselves — the title is the number you read, the list is
 * the evidence that this is the sweep you meant.
 *
 * Same shape as `DeleteSessionDialog`: `ui/dialog` with `showCloseButton={false}`
 * (no X — Cancel/Escape are the only exits) + a `destructive` confirm button.
 *
 * Presentational ONLY: no store, no IPC, no `useSessions`. The consuming
 * Settings section owns the deleting and passes what it found.
 */
export default function ClearDetachedSessionsDialog({
  count,
  folderNames,
  onConfirm,
  onClose,
}: {
  /** How many stored sessions are about to be deleted. */
  count: number;
  /** The DISTINCT folder names those sessions belong to. */
  folderNames: string[];
  onConfirm: () => void;
  onClose: () => void;
}): ReactElement {
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
          <DialogTitle>
            Delete {count} detached sessions from {folderNames.length} folders?
          </DialogTitle>
        </DialogHeader>
        {/* `DialogContent` sets no `max-h` and no `overflow-y-auto`, so a body
            that grows with the data would push the footer's Cancel/Delete past
            the viewport (DeleteSessionDialog escapes that only because its body
            is one line). The list scrolls; the buttons stay reachable. */}
        <div className="max-h-40 space-y-0.5 overflow-y-auto">
          {[...folderNames].sort().map((folder) => (
            <div
              key={folder}
              className="truncate text-ui-sm text-foreground-subtle"
            >
              {folder}
            </div>
          ))}
        </div>
        <DialogDescription>
          This permanently removes these sessions' transcripts from Archimedes'
          storage. This can't be undone. These sessions belong to Spaces that
          are not open; you can also remove them one at a time from the list.
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Delete {count} sessions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
