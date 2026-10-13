import { usePermissions } from "../store/permissions";
import { isInteractivePause, useInteractive } from "../store/interactive";
import { useSessions } from "../store/sessions";
import { useSubagents } from "../store/subagents";
import { childGatesOf, useChildGates } from "./useChildGates";
import type { PermissionPromptData } from "../store/permissions";
import type { InteractiveRequestData } from "../store/interactive";

/** The four states a session row can be in, most attention-grabbing first. */
export type SessionStatus = "waiting" | "running" | "live" | "stored";

/** The inputs the status is derived from (see `sessionStatusOf`). */
export interface SessionStatusInput {
  isLive: boolean;
  inTurn: boolean;
  prompts: PermissionPromptData[];
  requests: InteractiveRequestData[];
  /** Pending gates held by THIS session's CHILDREN — a parent blocked on its
   * child's gate is blocked on the user, so it is `waiting`, not `running`. */
  childGateCount: number;
}

/**
 * The ONE status rule for a session, as a pure function so it can serve both
 * the single-row hook and the batch hook the collapsed rail uses (a hook cannot
 * be called once per row inside a list of changing length — the pure step is
 * what makes the two consumers share the rule rather than restate it).
 *
 * `waiting` WINS over `running`: a session holding a pending prompt is not
 * working, it is BLOCKED ON THE USER, and that is the fact both the row's
 * "Waiting" pill and the rail's mark exist to report. `running` requires a LIVE
 * session — an `inTurn` flag left behind by a session that has since closed
 * must not paint activity that is not happening (the open row's
 * `isLive && inTurn`, stated once, here).
 *
 * A session's OWN pending prompts are not the only way it can be parked on a
 * human: a `Subagent session`'s gates are answered in its PARENT's transcript
 * (the inline card, or the overlay when the parent is not the active Session),
 * so a parent whose child is holding a gate has nothing under its own id and
 * its turn is open only because it is waiting for the answer. `childGateCount`
 * is that fact — WITHOUT it a blocked parent reads `running`, i.e. it claims to
 * be working while it is waiting on the user.
 */
export function sessionStatusOf({
  isLive,
  inTurn,
  prompts,
  requests,
  childGateCount,
}: SessionStatusInput): SessionStatus {
  const waiting =
    prompts.length > 0 ||
    requests.some((r) => isInteractivePause(r.method)) ||
    childGateCount > 0;
  if (waiting) return "waiting";
  if (isLive && inTurn) return "running";
  return isLive ? "live" : "stored";
}

/**
 * The status of ONE session — consumed by the open `SessionRow` (its leading
 * spinner + its "Waiting" pill). It is a hook rather than logic inside
 * `SessionRow` because the collapsed rail is the SAME fact in less space, and a
 * summary that disagrees with the thing it summarises is worse than no summary
 * — the reasoning that put the todo count in `useBoardOpenCount` instead of
 * in the panel that renders it.
 *
 * THE ASYMMETRY THAT IS NOT A BUG: `childGateCount` makes a PARENT `waiting`
 * while its child holds a gate, and the CHILD stays `running` — in
 * `SubagentDelegatingCard`'s rows (its `subStatus` / `storeEntry.status`, i.e.
 * `useSubagents`' entry status) and in `SubagentDetailHost`'s status chip.
 * That is TRUE, not a missed case: the child's own turn really is open, parked
 * on the gate, and `sessionStatusOf` is the status of a Session in the LIST — a
 * `Subagent session` is never in that list (the Rust side filters
 * `is_subagent = 0`, see `SubagentModals`' cross-layer note), so it never gets
 * a row to be `waiting` in. Do NOT "fix" the disagreement by deriving a second
 * gate status here. If it is ever built, the shape is a BY-CHILD projection of
 * `useChildGates` (the gate already carries `childSessionId`) feeding the entry
 * display — not a new predicate, and never a second copy of the `waiting` rule.
 */
export function useSessionStatus(sessionId: string): SessionStatus {
  const isLive = useSessions((s) =>
    s.sessions.some((x) => x.sessionId === sessionId),
  );
  const inTurn = useSessions((s) => !!s.inTurn[sessionId]);
  const prompts = usePermissions((s) => s.prompts[sessionId]) ?? [];
  const requests = useInteractive((s) => s.requests[sessionId]) ?? [];
  // This row's CHILDREN's gates. `useChildGates` runs once per `SessionRow`
  // (`src/components/SpacesList.tsx`) and the rows are unmemoized, so what that
  // costs is SUBSCRIPTION BREADTH, not scan size: this hook now subscribes every
  // row to all three gate maps (`entries` / `requests` / `prompts`) rather than
  // only its own Session's slice, so ANY Session's gate churn re-renders EVERY
  // open row.
  // Accepted, because the re-render is bounded and cheap — `useSubagents.entries`
  // is capped at `MAX_CLOSED_ENTRIES` CLOSED entries (`src/store/subagents.ts`)
  // plus the handful still running, and only the visible rows re-render — and
  // because the genuinely redundant part, re-deriving and re-sorting the same
  // gate list once per row per render, is memoised inside `useChildGates` itself
  // (on the three store refs + the parent id).
  // Narrowing the SUBSCRIPTION is a different, larger change: it means either
  // memoizing the rows or reading the batch shape below — `useSessionStatuses`
  // subscribes `entries` ONCE for the whole rail list, which is the shape the
  // open list would want too — and restructuring `SpacesList`'s row rendering is
  // deliberately out of scope here.
  const childGateCount = useChildGates(sessionId).length;
  return sessionStatusOf({ isLive, inTurn, prompts, requests, childGateCount });
}

/**
 * The status of MANY sessions at once, for the collapsed rail. Subscribes to
 * the maps ONCE (a hook per row would violate the rules of hooks at a
 * changing list length) and applies `sessionStatusOf` per id, so the rail's
 * marks are derived by the same rule as the rows they summarise.
 *
 * Selectors return stable references — the maps themselves, never a fresh `{}`
 * fallback INSIDE the selector — or Zustand re-renders forever.
 */
export function useSessionStatuses(
  sessionIds: string[],
): Record<string, SessionStatus> {
  const live = useSessions((s) => s.sessions);
  const inTurn = useSessions((s) => s.inTurn);
  const prompts = usePermissions((s) => s.prompts);
  const requests = useInteractive((s) => s.requests);
  // The child gates, subscribed ONCE like everything else (never
  // `useChildGates` per id — a hook per row is impossible at a changing list
  // length, which is exactly why `childGatesOf` is pure).
  const entries = useSubagents((s) => s.entries);
  const liveIds = new Set(live.map((x) => x.sessionId));
  // ONE pass over `entries` builds parent → how many gates its children hold,
  // BEFORE the per-id loop. Re-deriving it per id would rescan `entries` (and
  // re-sort its gates) once per visible row for the same answer. `null` = every
  // child, then grouped by the parent each gate already carries.
  const childGateCounts = new Map<string, number>();
  for (const gate of childGatesOf(entries, requests, prompts, null)) {
    childGateCounts.set(
      gate.parentSessionId,
      (childGateCounts.get(gate.parentSessionId) ?? 0) + 1,
    );
  }
  const out: Record<string, SessionStatus> = {};
  for (const id of sessionIds) {
    out[id] = sessionStatusOf({
      isLive: liveIds.has(id),
      inTurn: !!inTurn[id],
      prompts: prompts[id] ?? [],
      requests: requests[id] ?? [],
      childGateCount: childGateCounts.get(id) ?? 0,
    });
  }
  return out;
}
