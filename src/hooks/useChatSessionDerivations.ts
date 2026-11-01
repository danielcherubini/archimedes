import { useSessions } from "../store/sessions";
import { useInteractive } from "../store/interactive";
import {
  anchoredAskRequestIds,
  classifyInteractiveRequests,
  composerLockDerivations,
  historyPaginationDerivations,
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
  // The composer-lock chain (issue #135 §3, final increment). The pure
  // predicate is `lib/chatSessionDerivations.composerLockDerivations`; the
  // THREE inputs are selected here and passed in — the hook owns the store
  // reads, the pure module owns the boolean. `inTurn` is `false` for the
  // no-session frame and `compacting` is `undefined` for it, so the chain
  // derives `{ workingOrInTurn: false, composerLocked: false }` there —
  // the same values the component's `?? false`/`!== undefined` fallbacks
  // produced. Wave 1 refused this move because it would "force
  // `useSpinQuip`/`useSessionIdleEdge`/`send` to read the hook's return"
  // (task01's recorded reason — ALL THREE legs). C1 has landed with
  // `composerLocked` as a PLAIN ARGUMENT of `useChatPromptDispatch` and of
  // `useSessionIdleEdge` (`busy`), and `send`'s queue-fork read sits INSIDE
  // `useChatPromptDispatch` — the `if (composerLocked)` arm reads the
  // argument, not a hook return — so all three legs are satisfied by
  // re-wiring two argument sites; the queue-fork arm is not a consumer this
  // task rewires.
  //
  // `inTurn` is the ground truth for "a turn is in flight" (set by `beginTurn`,
  // cleared by `turnCompleted`) — a STALE `idle` from the previous turn must
  // not unlock the composer or hide the working indicator, so `inTurn` wins
  // alongside `working` (the store does not reset `agentState` on
  // `turnCompleted`). The `blocked` / compaction terms and their reasoning are
  // in the pure predicate's JSDoc, which is where the component's lock comment
  // moved with the expression.
  const inTurnLock = useSessions((s) =>
    s.activeSessionId ? !!s.inTurn[s.activeSessionId] : false,
  );
  // The active session's in-flight compaction reason (ADR 0045). Indexed on
  // `s.activeSessionId` INSIDE the selector (the outer `activeSessionId` is
  // `string | null`, which TS2538 rejects as an index). The strict
  // `!== undefined` test the chain applies lives in the pure predicate — the
  // ADR 0045 "`null` = not compacting" contract is what that strictness keeps.
  const compacting = useSessions((s) =>
    s.activeSessionId ? s.compacting[s.activeSessionId] : undefined,
  );
  const agentStateForLock = useInteractive((s) =>
    activeSessionId ? s.agentState[activeSessionId] : undefined,
  );
  const lock = composerLockDerivations({
    agentState: agentStateForLock,
    inTurn: inTurnLock,
    compacting,
  });
  // The history-pagination slice (issue #135 §3, final increment). The
  // `history[sessionId]` entry and the `loadOlderHistory` action are read
  // here; the `?? false` / `?? 0` fallbacks are OUTSIDE the selectors (the
  // house stable-reference rule) and now live in the pure function. The action
  // is returned UNWRAPPED and NEVER invoked — the component's `onStartReached`
  // arrow is its only caller.
  const historyEntry = useSessions((s) =>
    s.activeSessionId ? s.history[s.activeSessionId] : undefined,
  );
  const loadOlder = useSessions((s) => s.loadOlderHistory);
  const pagination = historyPaginationDerivations({
    history: historyEntry,
    loadOlder,
  });

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
    workingOrInTurn: lock.workingOrInTurn,
    composerLocked: lock.composerLocked,
    loadOlder: pagination.loadOlder,
    hasMore: pagination.hasMore,
    loadingMore: pagination.loadingMore,
    generation: pagination.generation,
  };
}
