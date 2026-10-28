import { respondPermission, type PermissionOutcome } from "../lib/tauri";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { usePermissions } from "../store/permissions";
import { Button } from "./ui/button";
import { IpcErrorLine } from "./IpcErrorLine";

/**
 * Inline card shown when a `permission-request` event arrives for the active
 * session (the green confirmation treatment). The header strip carries the
 * tool name — there is NO tool detail or diff preview to render (`{
 * requestId, toolTitle, options }` is all the store holds). The footer has
 * one `button` per agent-defined option (first = primary, the rest =
 * outline) + a Cancel. Buttons answer the agent via the
 * `respond_permission` command; the prompt is removed locally on success
 * (and auto-dismissed on session-closed by the store — a MAIN session only: the
 * lifted child prompts this component renders from `MessageList` /
 * `SubagentModals` are never dismissed that way, because no `session-closed`
 * names a child id, so they clear only by being answered — ADR 0040).
 */
export default function PermissionPrompt({
  sessionId,
  requestId,
}: {
  sessionId: string;
  requestId: string;
}) {
  const prompt = usePermissions((state) =>
    (state.prompts[sessionId] ?? []).find((p) => p.requestId === requestId),
  );
  const removePrompt = usePermissions((state) => state.removePrompt);
  // NO `guard`: this site has never had re-entrancy protection — the only thing
  // standing between a fast double click and a second `respond_permission` is
  // the `disabled={busy}` on every button below, exactly as before.
  const { busy, error, run } = useAsyncAction();

  if (!prompt) return null;

  const respond = (outcome: PermissionOutcome) =>
    run(() =>
      respondPermission(sessionId, requestId, outcome).then(() =>
        // The prompt is removed locally on success (and auto-dismissed on
        // session-closed by the store — a MAIN session only).
        removePrompt(sessionId, requestId),
      ),
    );

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="bg-interaction-confirmation-surface px-3 py-2">
        <p className="text-ui-base font-medium [overflow-wrap:anywhere] text-interaction-confirmation-foreground">
          {prompt.toolTitle}
        </p>
      </div>
      <div
        data-testid="permission-options-row"
        className="flex min-w-0 flex-wrap items-center gap-2 p-3"
      >
        {prompt.options.map((option, i) => (
          <Button
            key={option.optionId}
            variant={i === 0 ? "default" : "outline"}
            size="sm"
            disabled={busy}
            onClick={() =>
              respond({
                selected: {
                  option_id: option.optionId,
                  // The guard's `allow-directory` option carries `path`; echo it
                  // back as `value`. An option WITHOUT one emits the OLD payload
                  // shape (no `value` key at all) so boundary prompts stay
                  // byte-identical on the wire.
                  ...(option.path !== undefined ? { value: option.path } : {}),
                },
              })
            }
            className="min-w-0 [overflow-wrap:anywhere]"
          >
            {option.name}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => respond("cancelled")}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <IpcErrorLine error={error} className="px-3 pb-2" />
      )}
    </div>
  );
}
