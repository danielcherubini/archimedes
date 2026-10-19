import { isInteractivePause, useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";
import { usePendingSubagentRequests } from "./usePendingSubagentRequests";

/**
 * Whether the user owes an answer anywhere: the active session's permission
 * prompts OR interactive requests whose method is a pause on the user
 * (`isInteractivePause` — `ask`/`confirm`/`password`), PLUS every `Subagent
 * session`'s gates app-wide (the shared `usePendingSubagentRequests` hook).
 *
 * The subagent half is app-wide BY DESIGN, not as a shortcut: `SubagentModals`
 * is mounted at the `App` root and genuinely surfaces every NON-active
 * parent's gates, so "you owe something, somewhere" is exactly what is on
 * screen. Attribution is NOT this cue's job — that is the inline card in the
 * parent's transcript and the parent row's `waiting` status (see
 * `usePendingSubagentRequests`, which owns the reasoning).
 *
 * THIS is the dot's ONE derivation: `ChatStream` and the chrome bar's two pane
 * toggles (`ChromeControls`) all call it, and those two draw the `bg-warning`
 * dot while their pane is collapsed, so the cues cannot disagree. (`ChatStream`
 * used to hand-roll these same four terms — which is precisely the drift this
 * hook exists to prevent, and the reason it now reads this hook instead.)
 *
 * Like every cue hook here, it is called UNCONDITIONALLY: it reads stores via
 * `useSyncExternalStore`, so a caller that sits behind an early return would
 * change its hook count when the active Session appears and crash the render.
 */
export function useHasPendingRequest(): boolean {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const prompts =
    usePermissions((s) =>
      activeSessionId ? s.prompts[activeSessionId] : undefined,
    ) ?? [];
  const interactiveRequests =
    useInteractive((s) =>
      activeSessionId ? s.requests[activeSessionId] : undefined,
    ) ?? [];
  const pendingSubagentRequests = usePendingSubagentRequests();
  return (
    prompts.length > 0 ||
    interactiveRequests.some((r) => isInteractivePause(r.method)) ||
    pendingSubagentRequests > 0
  );
}
