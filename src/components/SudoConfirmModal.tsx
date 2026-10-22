import { respondInteractiveRequest } from "../lib/tauri";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useInteractive } from "../store/interactive";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { IpcErrorLine } from "./IpcErrorLine";

/**
 * Modal for an interactive `confirm` request (the `sudo_exec` confirm gate):
 * shows the `command` + `reason` verbatim with Run/Cancel. Run →
 * `respondInteractiveRequest(…, { confirmed: true })`; Cancel →
 * `{ confirmed: false }`; then `removeRequest` (the request is settled
 * and removed outright — there is no `markAnswered` step).
 */
export default function SudoConfirmModal({
  sessionId,
  requestId,
}: {
  sessionId: string;
  requestId: string;
}) {
  const request = useInteractive((state) =>
    (state.requests[sessionId] ?? []).find((r) => r.requestId === requestId),
  );
  const removeRequest = useInteractive((state) => state.removeRequest);
  // NO `guard`: this site has no `if (busy) return` today (its sibling
  // `SudoPasswordModal` does). Re-entrancy is blocked only by `disabled={busy}`
  // on the two footer buttons — pinned by
  // `SudoConfirmModal.test.tsx`'s "the ONLY re-entrancy protection here is the
  // disabled attribute" — so that attribute stays load-bearing.
  const { busy, error, run } = useAsyncAction();

  if (!request || request.method !== "confirm") return null;
  const params = request.params as { command?: string; reason?: string };

  const respond = (confirmed: boolean) =>
    run(() =>
      respondInteractiveRequest(sessionId, requestId, { confirmed }).then(() =>
        // The request is settled and removed outright — no `markAnswered` step.
        removeRequest(sessionId, requestId),
      ),
    );

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Run this command with sudo?</DialogTitle>
        </DialogHeader>
        <pre className="overflow-x-auto rounded-md bg-surface p-2 font-mono text-ui-sm">
          {params.command ?? ""}
        </pre>
        {params.reason && (
          <p className="text-ui-sm text-foreground-subtle">{params.reason}</p>
        )}
        {error && <IpcErrorLine error={error} />}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void respond(false)}
          >
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void respond(true)}>
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
