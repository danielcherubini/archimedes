import { useSessions } from "../store/sessions";
import { useInteractive } from "../store/interactive";
import {
  anchoredAskRequestIds,
  classifyInteractiveRequests,
  sessionKindDerivations,
  stackedAskRequests,
  turnDiffs,
} from "../lib/chatSessionDerivations";
import { sessionFieldOf } from "../lib/sessionLookup";
import { agentSupportsImages } from "../lib/chatAttachments";

/**
 * The session-state and capability derivations for the ACTIVE session (issue
 * #135 §3) — the thin adapter over the pure module `lib/chatSessionDerivations`.
 *
 * The selectors are verbatim copies of the ones this replaced in
 * `ChatStream.tsx`, including the selector-stability rule: a selector must
 * return a stable reference (no fresh `[]` / `{}` fallback inside the selector
 * body) or zustand v5 re-renders forever — every `?? []` fallback sits OUTSIDE
 * its selector.
 *
 * Deliberately UNMEMOISED (contrast `useChildGates`, which memoises because it
 * runs once per sidebar row): this hook is called once per `ChatStream` render,
 * and the inline code it replaces re-derived these arrays on every render
 * already. Wrapping them in `useMemo` would mint new identities as a *change*
 * with no consumer reading identity — behaviour is moved, not improved.
 */
export function useChatSessionDerivations() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  // Selectors must return stable references (no fresh `[]` fallbacks inside
  // the selector) or Zustand re-renders forever.
  const messages =
    useSessions((s) =>
      s.activeSessionId ? s.messages[s.activeSessionId] : undefined,
    ) ?? [];
  const liveSession = useSessions((s) =>
    s.activeSessionId
      ? s.sessions.find((x) => x.sessionId === s.activeSessionId)
      : undefined,
  );
  // The active session's CAPABILITIES, over the ONE three-list walk
  // (`lib/sessionLookup.ts`), which searches ALL THREE lists: a session living
  // ONLY in `archivedSessions` (opened from the Archived section) must still
  // resolve here — otherwise it renders no banner, a disabled composer ("This
  // session is closed"), and an unreachable `send()` auto-resume. Live wins, so
  // this is the same value the two row lookups it replaces produced
  // (`liveSession?.capabilities ?? stored?.capabilities`).
  //
  // It reads the FIELD and not the row on purpose: a selector may return the
  // stored row (a stable reference) but never a `{ … }` built per snapshot —
  // zustand v5 re-runs those forever (the rule at `ChatStream.tsx:80-81`).
  const activeCapabilities = useSessions((s) =>
    sessionFieldOf(s, s.activeSessionId, "capabilities"),
  );
  // Whether ANY of the three lists knows the active id — the presence test the
  // old stored-row lookup gave for free. `sessionId` is a required field, so a
  // hit on it means a row exists; it is read as a primitive for the same reason
  // above.
  const activeSessionIsKnown = useSessions(
    (s) => sessionFieldOf(s, s.activeSessionId, "sessionId") !== undefined,
  );
  // Interactive surfaces for the ACTIVE session (B3): the store is keyed by the
  // ACP session id, which matches `activeSessionId`.
  const interactiveRequests =
    useInteractive((s) =>
      activeSessionId ? s.requests[activeSessionId] : undefined,
    ) ?? [];

  const { askRequests, confirmRequests, passwordRequests } =
    classifyInteractiveRequests(interactiveRequests);
  const anchored = anchoredAskRequestIds(askRequests, messages);
  const stacked = stackedAskRequests(askRequests, anchored);
  const kind = sessionKindDerivations({
    liveSession,
    activeSessionIsKnown,
    activeCapabilities,
  });
  const { lastUserIndex, turnDiffs: diffs } = turnDiffs(messages);
  // Capability gate (FAIL-CLOSED): the feature is inert unless the agent
  // advertises `promptCapabilities.image === true`.
  const imageCapable = agentSupportsImages(activeCapabilities);

  return {
    askRequests,
    confirmRequests,
    passwordRequests,
    anchoredAskRequestIds: anchored,
    stackedAskRequests: stacked,
    isLive: kind.isLive,
    isHistoryOnly: kind.isHistoryOnly,
    canResume: kind.canResume,
    composerEnabled: kind.composerEnabled,
    imageCapable,
    lastUserIndex,
    turnDiffs: diffs,
  };
}
