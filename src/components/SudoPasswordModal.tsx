import { useState, type ChangeEvent } from "react";
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
import { Input } from "./ui/input";
import { IpcErrorLine } from "./IpcErrorLine";
import { MutedCaption } from "./MutedCaption";

/**
 * Modal for an interactive `password` request (the `sudo_exec` credential gate):
 * displays the `command` + `reason` **verbatim** (so even a direct
 * `password` call — which skips the confirm gate — shows the user what the
 * password is for) plus a masked `•` field (the TUI `maskLine` behavior:
 * one `•` per char, the raw value never rendered). Enter confirms / Esc
 * cancels / Backspace deletes. Confirm → `respondInteractiveRequest(…, {
 * password })`; Esc/empty → `{ password: "" }` (cancel); then
 * `removeRequest` (the password lives only in this modal's `useState` —
 * it is never stored in the interactive store).
 */
export default function SudoPasswordModal({
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
  // The raw value lives in state only — it is NEVER rendered (the input
  // shows the mask: one `•` per char) and never stored in the interactive
  // store.
  const [secret, setSecret] = useState("");
  // `guard: true` — this is the site that self-guarded (`if (busy) return` at
  // the old `:49`), and the guard is NOT redundant with `disabled={busy}`: the
  // `<input>` is never disabled, so a second Enter reaches the handler and only
  // the JS guard stops a sudo password being answered twice. Pinned by
  // `SudoPasswordModal.test.tsx`'s "the JS guard at :49 blocks a second Enter".
  const { busy, error, run } = useAsyncAction({ guard: true });

  if (!request || request.method !== "password") return null;
  const params = request.params as { command?: string; reason?: string };
  const masked = "•".repeat(secret.length);

  const respond = (cancelled: boolean) => {
    const password = cancelled ? "" : secret;
    return run(() =>
      respondInteractiveRequest(sessionId, requestId, { password }).then(() =>
        // The password was in `useState` only — removing the request settles
        // the card; it never persisted in store state.
        removeRequest(sessionId, requestId),
      ),
    );
  };

  // The controlled-mask trick: the input's DOM value is the mask, so a
  // change is either the previous mask + typed chars (append) or the mask
  // minus its tail (Backspace). The raw value is derived, never rendered.
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value.startsWith(masked)) {
      setSecret(secret + value.slice(masked.length));
    } else if (masked.startsWith(value)) {
      setSecret(secret.slice(0, value.length));
    }
    // Any other change (replacement / selection) is ignored.
  };

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sudo password required</DialogTitle>
        </DialogHeader>
        <pre className="overflow-x-auto rounded-md bg-surface p-2 font-mono text-ui-sm">
          {params.command ?? ""}
        </pre>
        {params.reason && (
          <p className="text-ui-sm text-foreground-subtle">{params.reason}</p>
        )}
        <Input
          autoFocus
          value={masked}
          onChange={onChange}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void respond(false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              // Stop the native event from bubbling to `window`: the global
              // Esc handler (ChatStream) sends `session/cancel` while a turn
              // is in flight — an Esc meant for THIS modal (cancel) must
              // not also cancel the whole turn (the `AskQuestionCard`
              // Esc handler has the same treatment).
              e.stopPropagation();
              void respond(true);
            }
          }}
          placeholder="••••••••"
          aria-label="Password"
          className="tracking-widest"
        />
        <MutedCaption as="p">
          Enter confirm · Esc cancel · Backspace deletes the last character
        </MutedCaption>
        {error && <IpcErrorLine error={error} />}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void respond(true)}
          >
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void respond(false)}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
