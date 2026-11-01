import type { InteractiveRequestData } from "../store/interactive";
import type { Message } from "../lib/sessionTypes";
import type { SessionInfo } from "../lib/tauri";

/**
 * The PURE derivations `ChatStream.tsx` used to run inline in its component body
 * (issue #135 §3).
 *
 * No React, no store reads: every function here takes its inputs explicitly, so
 * the derivations are unit-testable without mounting the ChatStream tree (the
 * 7,885-line `ChatStream.test.tsx` was the only place they were pinned). The
 * three-list walk (`lib/sessionLookup.ts`) deliberately lives in the HOOK's
 * selectors (`hooks/useChatSessionDerivations.ts`) and not here — this module
 * never touches a store, not even through a lookup helper.
 *
 * Same "pure core + thin hook" shape the repo already runs for the cue family
 * (`childGatesOf` + `useChildGates`, `sessionStatusOf` + `useSessionStatus`).
 * Bodies are byte-for-byte moves from `ChatStream.tsx` — behaviour is MOVED, not
 * improved.
 */

/**
 * The interactive surfaces for one session, split by `method` — the three lists
 * `MessageList` (asks) and `ComposerModals` (`confirm` / `password` dialogs)
 * render.
 */
export function classifyInteractiveRequests(requests: InteractiveRequestData[]): {
  askRequests: InteractiveRequestData[];
  confirmRequests: InteractiveRequestData[];
  passwordRequests: InteractiveRequestData[];
} {
  const askRequests = requests.filter((r) => r.method === "ask");
  const confirmRequests = requests.filter((r) => r.method === "confirm");
  const passwordRequests = requests.filter(
    (r) => r.method === "password",
  );
  return { askRequests, confirmRequests, passwordRequests };
}

/**
 * The request ids of the ANCHORED `ask`s.
 *
 * An `ask` request is ANCHORED when a `tool-call` message with its
 * `toolCallId` is in the stream (correlated by `(source, toolCallId)` —
 * only a `main` ask can anchor; the desktop has no ACP `tool_call` frame
 * for child tool calls). Anchored requests render IN PLACE of the
 * `ToolCallCard`; the rest stack in the stream (arrival order).
 */
export function anchoredAskRequestIds(
  askRequests: InteractiveRequestData[],
  messages: Message[],
): Set<string> {
  const anchored = new Set<string>();
  for (const r of askRequests) {
    if (
      r.source === "main" &&
      r.toolCallId &&
      messages.some((m) => m.kind === "tool-call" && m.id === r.toolCallId)
    ) {
      anchored.add(r.requestId);
    }
  }
  return anchored;
}

/** The `ask`s that stack in the stream (everything the anchored set excludes). */
export function stackedAskRequests(
  askRequests: InteractiveRequestData[],
  anchored: Set<string>,
): InteractiveRequestData[] {
  return askRequests.filter(
    (r) => !anchored.has(r.requestId),
  );
}

/**
 * Whether the active session is LIVE, HISTORY-ONLY, or RESUMABLE, and whether
 * the composer may SEND.
 *
 * A stored (non-live) session: its transcript is read-only unless the
 * agent negotiated `loadSession`, in which case it can be resumed.
 * `activeSessionIsKnown` is the presence half of the stored-row lookup this
 * replaced: the id is known to a list but the session is NOT live, which is
 * exactly what "stored" meant there.
 *
 * The composer's SEND is enabled for a live session OR a RESUMABLE
 * stored session (a non-resumable stored session can't receive a prompt
 * — no agent process to deliver to, and the harness's `send_prompt`
 * rejects an unknown session): a resumable stored session auto-resumes
 * on send. The TEXTAREA is always editable regardless (the draft is
 * kept — it just can't be SENT while `composerEnabled` is false).
 */
export function sessionKindDerivations(input: {
  liveSession: SessionInfo | undefined;
  activeSessionIsKnown: boolean;
  activeCapabilities: Record<string, unknown> | undefined;
}): {
  isLive: boolean;
  isHistoryOnly: boolean;
  canResume: boolean;
  composerEnabled: boolean;
} {
  const isLive = !!input.liveSession;
  const isHistoryOnly = !isLive && input.activeSessionIsKnown;
  const canResume = isHistoryOnly && input.activeCapabilities?.loadSession === true;
  const composerEnabled = isLive || canResume;
  return { isLive, isHistoryOnly, canResume, composerEnabled };
}

/**
 * The most recent turn (the messages after the last `user` message) and
 * its standalone `diff` messages — the SINGLE SOURCE OF TRUTH for the
 * file summary card: `applySessionUpdate`/`rowToMessages` emit BOTH a
 * `tool-call.diff = diffs[0]` AND standalone `diff` messages for the
 * same extracted diffs, so the `tool-call.diff` refs are deliberately
 * NOT used (summing both would count every file twice).
 */
export function turnDiffs(messages: Message[]): {
  lastUserIndex: number;
  turnDiffs: { path: string; patch: string }[];
} {
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === "user") return i;
    }
    return -1;
  })();
  const turnDiffs =
    lastUserIndex === -1
      ? []
      : messages
          .slice(lastUserIndex + 1)
          .flatMap((m) =>
            m.kind === "diff" ? [{ path: m.path, patch: m.patch }] : [],
          );
  return { lastUserIndex, turnDiffs };
}

/**
 * The composer-lock derivation for the ACTIVE session (issue #135 §3, final
 * increment). Pure over the three inputs the component used to select.
 *
 * `inTurn` is the ground truth for "a turn is in flight" (set by `beginTurn`,
 * cleared by `turnCompleted`) — a STALE `idle` from the previous turn must
 * not unlock the composer or hide the working indicator, so `inTurn`
 * wins alongside `working` (the store does not reset `agentState` on
 * `turnCompleted` — a store follow-up; an agent that hasn't
 * pushed yet is covered the same way: its turn IS in flight).
 *
 * A `blocked` agent is mid-turn AWAITING a request response (`inTurn` is
 * true) — the SEND must stay disabled for the whole wait (pre-branch,
 * `main`'s composer locked on `inTurn`): the harness is one-turn-at-a-time
 * (a prompt while a turn is in flight is REJECTED, not queued —
 * `send_prompt`'s atomic `pending_turn` claim), so sending concurrently
 * would fail + clobber the turn bookkeeping. The TEXTAREA is always
 * editable (you can draft while the agent works — `send()`'
 * `composerLocked` guard no-ops Enter, the draft is kept for when the
 * turn ends). (`agentState === "blocked"` also covers a blocked state
 * without an in-flight turn, where `inTurn` alone would not lock.)
 * A compaction locks for the same reason: the harness is one-turn-at-a-time
 * and a prompt racing the rewrite would be rejected (or reorder history).
 */
export function composerLockDerivations(input: {
  agentState: "working" | "idle" | "blocked" | undefined;
  inTurn: boolean;
  compacting: unknown; // `CompactionReason | undefined`; `unknown` keeps the type import out of the pure module
}): {
  workingOrInTurn: boolean;
  composerLocked: boolean;
} {
  const workingOrInTurn = input.agentState === "working" || input.inTurn;
  const composerLocked =
    workingOrInTurn || input.agentState === "blocked" || input.compacting !== undefined;
  return { workingOrInTurn, composerLocked };
}

/**
 * The history-pagination window for the ACTIVE session (issue #135 §3, final
 * increment). Pure over ONE store slice: the `history[sessionId]` entry and
 * the `loadOlderHistory` action. The action is returned UNWRAPPED (the
 * component hands it straight to `MessageList`'s `onStartReached`) and is
 * never invoked here; the three `?? false` / `?? 0` fallbacks sit OUTSIDE any
 * selector, exactly as they did in the component (the fallbacks are what keep
 * the no-session frame returning stable booleans).
 */
export function historyPaginationDerivations(input: {
  history: {
    oldestRowId: number | null;
    hasMore: boolean;
    loadingMore: boolean;
    generation: number;
    epoch: number;
  } | undefined;
  loadOlder: (sessionId: string) => Promise<void>;
}): {
  loadOlder: (sessionId: string) => Promise<void>;
  hasMore: boolean;
  loadingMore: boolean;
  generation: number;
} {
  return {
    loadOlder: input.loadOlder,
    hasMore: input.history?.hasMore ?? false,
    loadingMore: input.history?.loadingMore ?? false,
    generation: input.history?.generation ?? 0,
  };
}
