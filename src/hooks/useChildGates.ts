import { useMemo } from "react";
import {
  isInteractivePause,
  useInteractive,
  type InteractiveRequestData,
} from "../store/interactive";
import { usePermissions, type PermissionPromptData } from "../store/permissions";
import { useSubagents, type SubagentEntry } from "../store/subagents";
import type { PermissionOption } from "../lib/tauri";

/** The four gates a Subagent session can hold on the user. */
export type ChildGateKind = "ask" | "confirm" | "password" | "permission";

/** One pending gate held by a child of one parent Session.
 *
 * Deliberately NO `source` field. It used to carry `InteractiveRequestData.source`
 * and document it as e.g. `"subagent:reviewer"`, which the backend never emits:
 * the only production `interactive-request` emitters are `ask_flow`
 * (`src-tauri/src/agent/harness/ask.rs`) and the sudo flow's two sub-prompts
 * (`src-tauri/src/agent/interactive/mod.rs`), and both are handed `"native"` by
 * the `AgentLoop`'s tool dispatch (`src-tauri/src/agent/harness/loop.rs`) —
 * `"main"` / `"sudo"` exist only in test fixtures and the fake Worker. Nothing
 * read the field either (`childGatesOf` wrote it and no consumer asked), so it
 * is gone rather than re-documented: a gate already knows its child, its parent,
 * and its kind, which is every distinction the render sites make. A future
 * "who is asking" label must come from `agentName`, not from a store field whose
 * value is a transport detail. */
export interface ChildGate {
  /** The SUBAGENT session id — the key every respond command routes on. */
  childSessionId: string;
  /** `SubagentEntry.parentSessionId` — how the overlay excludes the ACTIVE
   * parent's gates (the render-site partition) and how the pending cue
   * attributes a gate to its parent. */
  parentSessionId: string;
  /** `SubagentEntry.agentName` — the attribution chip's text. */
  agentName: string;
  /** The interactive `requestId`, or the permission prompt's `requestId`. */
  requestId: string;
  kind: ChildGateKind;
  /** `InteractiveRequestData.params`; absent for `permission`. */
  params?: Record<string, unknown>;
  /** `PermissionPromptData.toolTitle`; present only for `permission`. */
  toolTitle?: string;
  /** `PermissionPromptData.options`; present only for `permission`. */
  options?: PermissionOption[];
  /** `SubagentEntry.startedAt` — the sort key for the child's arrival order. */
  childStartedAt: number;
}

/**
 * The identity of one gate, in ONE place. Every consumer keys on this exact
 * string — the overlay's React list keys, the inline rows' React keys, and the
 * attention snapshot's `gateId`, where the CHILD id is load-bearing because a
 * child's `requestId` is only unique inside its own session. Hand-rolling the
 * concatenation at each site lets the two meanings silently decouple, so every
 * site imports this instead.
 */
export const childGateKey = (g: ChildGate): string => `${g.childSessionId}:${g.requestId}`;

/**
 * The gates that render INLINE in a parent's transcript (`MessageList`) — the
 * other two kinds (`confirm` / `password`) are Radix `Dialog`s and belong to the
 * `SubagentModals` overlay for EVERY child, active parent or not.
 *
 * ONE predicate for both consumers: `MessageList` filters its rows with it and
 * `ChatStream` counts inline gates with it for the auto-scroll dep. Two
 * hand-written `kind` checks are how the dep ended up counting gates that never
 * render a row (a child's sudo prompt yanking the transcript to the bottom for
 * a row that does not exist), and the partition itself (exactly one render site
 * per gate) is stated here rather than implied in two files.
 */
export const isInlineChildGate = (g: ChildGate): boolean =>
  g.kind === "ask" || g.kind === "permission";

/** The hook's answer when there is no Session to scope to — ONE frozen array, so
 * "no gates" is referentially stable across renders (see `useChildGates`) and a
 * consumer that tried to mutate the shared instance throws instead of silently
 * corrupting every other render. */
const NO_GATES: ChildGate[] = [];
Object.freeze(NO_GATES);

/**
 * The ONE derivation of "which gates are the children of THIS Session holding on
 * the user, and who is holding them" — the parent transcript's inline card, the
 * always-mounted overlay, and the rail's dot all read it, so they cannot
 * disagree (the standing rule `useSessionStatus` / `useBoardOpenCount`
 * exist to enforce).
 *
 * The PURE core is exported because a hook cannot express the overlay's need —
 * "every child, regardless of parent" — and a component must not read three
 * stores ad hoc. It holds no React and reads no store: the tests drive it
 * directly.
 *
 * `parentSessionId === null` here means EVERY child's gates (the overlay's
 * need). It is deliberately NOT the same as `useChildGates(null)`, which returns
 * `[]` — the same literal means two different things, and the asymmetry is
 * pinned by a test on each side so nobody "fixes" one to match the other.
 *
 * A gate whose child has NO `SubagentEntry` is dropped: `parentSessionId` is
 * held ONLY by `useSubagents` (`useAttentionAlert`'s label comment says so
 * outright), so an entry evicted by `MAX_CLOSED_ENTRIES` means an unknown parent
 * and the gate has no home.
 *
 * Fail-quiet is the right shape, and that eviction is the ONLY cleanup this path
 * has — there is no chain of closes behind it. Checked against the Rust (read
 * only): `session-closed` has exactly ONE emitter, `on_session_exited_expected`
 * (`src-tauri/src/agent/session/router.rs`), and it returns without a `live`
 * entry, while the only insert into `live` is `establish_worker_session`
 * (`src-tauri/src/agent/session/mod.rs`) on the main-session start / resume
 * paths — so NO `session-closed` is ever emitted for a child id. A child's
 * teardown is `finish_subagent` (`src-tauri/src/agent/worker/manager.rs`), which
 * emits only `subagent-closed`, and `App`'s handler for THAT marks the entry
 * closed and discards its messages while clearing only its **todo board**
 * (ADR 0041) — never its gates or permission prompts. Nothing generic clears
 * them either: the Supervisor's
 * `cleanup_pending_modals` needs the same `live` entry a child never has, and
 * the ids it does relay for a child are tracked under the DELIVERY id — the
 * PARENT (`delivery_id` in `src-tauri/src/agent/worker/manager.rs`, routed into
 * `route_event` / `track_modal`) — so any close frame it emits arrives as
 * `removeRequest(parent, <the child's request id>)`, a no-op on the child's
 * slice. The ONE thing that does clear a child's own slice is
 * `SudoPromptCleanup` (`src-tauri/src/agent/interactive/sudo_exec.rs`): it
 * emits the close under the correct CHILD id, but only for a DROPPED sudo flow
 * (a cancel) and only for `confirm` / `password` — never an `ask` or a
 * Permission prompt. ADR 0040's amendment records both, with the follow-up.
 *
 * The consequence is stated plainly because it is the accepted state, not a
 * surprise: a CLOSED child still holding a gate keeps rendering its card —
 * inline in its parent's transcript, or in the `SubagentModals` overlay — until
 * its entry is evicted. (So does a child parked on an unanswered gate, for the
 * same reason: `SubagentModals`' own doc says nothing closes the gate in the
 * meantime and only the 30-minute `DEFAULT_SUBAGENT_SETTLE_TIMEOUT` ends the
 * DELEGATION, which is not the same as closing it.) That makes the drop a
 * STRONGER justification than a cleanup chain would, not a weaker one: eviction
 * is the single event that takes such a gate off every surface at once — no
 * inline card, no overlay row, no alert (the snapshot no longer recognises the
 * id as a child) — and a gate whose parent cannot be named has nowhere correct
 * to render anyway. What eviction does NOT do is clear the child's slice of the
 * two gate stores: nothing on this path does it for a gate that is not a
 * dropped sudo flow's `confirm`/`password` (the `SudoPromptCleanup` exception
 * above), so such a request outlives the entry that made it showable, invisible
 * here and unanswerable by anything that names the child.
 */
export function childGatesOf(
  entries: Record<string, SubagentEntry>,
  requests: Record<string, InteractiveRequestData[]>,
  prompts: Record<string, PermissionPromptData[]>,
  parentSessionId: string | null,
): ChildGate[] {
  const gates: ChildGate[] = [];
  for (const entry of Object.values(entries)) {
    // Parent filter FIRST: an unrelated Session's child is not this card's
    // business (the dot stays app-wide; the inline card never may).
    if (parentSessionId !== null && entry.parentSessionId !== parentSessionId) {
      continue;
    }
    // Interactive gates first, then permission prompts — the same two-store
    // order `useAttentionAlert`'s snapshot and `usePendingSubagentRequests` use.
    // The `method` filter is `isInteractivePause` — the ONE predicate the whole
    // cue family shares — kept even though the union has only its three members:
    // a future method that is not a pause on the user must not start surfacing
    // itself here (`useChildGates.test.ts` pins that it does not).
    for (const r of requests[entry.sessionId] ?? []) {
      if (!isInteractivePause(r.method)) continue;
      gates.push({
        childSessionId: entry.sessionId,
        parentSessionId: entry.parentSessionId,
        agentName: entry.agentName,
        requestId: r.requestId,
        kind: r.method,
        params: r.params,
        childStartedAt: entry.startedAt,
      });
    }
    for (const p of prompts[entry.sessionId] ?? []) {
      gates.push({
        childSessionId: entry.sessionId,
        parentSessionId: entry.parentSessionId,
        agentName: entry.agentName,
        requestId: p.requestId,
        kind: "permission",
        toolTitle: p.toolTitle,
        options: p.options,
        childStartedAt: entry.startedAt,
      });
    }
  }
  // Child arrival first (`startedAt`; `Object.values` order already breaks ties
  // by insertion, i.e. arrival, order), and within one child the store's own
  // per-session array index — `addRequest` filters-then-appends, so array order
  // IS request-arrival order. `Array.prototype.sort` is stable, so sorting on
  // the child's key alone keeps the request-arrival order it was built with.
  return gates.sort((a, b) => a.childStartedAt - b.childStartedAt);
}

/**
 * The gates the children of ONE Session are holding on the user, in arrival
 * order (see `childGatesOf`, whose rules this is a thin read of the three
 * stores over).
 *
 * `parentSessionId === null` → `[]` (there is no active Session to scope to).
 * This is deliberately the OPPOSITE of `childGatesOf(…, null)`, which means
 * "every child" — the overlay passes that, and no caller of this hook wants it.
 */
export function useChildGates(parentSessionId: string | null): ChildGate[] {
  // Selectors return the STORE's own slices — never a `?? {}` fallback inside a
  // selector, which would mint a fresh object per call and re-render forever
  // (the hazard `useSessionStatuses`' selector note and
  // `useAttentionAlert`'s selector comment both state). Defaults live OUTSIDE the selector.
  const entries = useSubagents((s) => s.entries);
  const requests = useInteractive((s) => s.requests);
  const prompts = usePermissions((s) => s.prompts);
  // MEMOISED on the three store references plus the parent id — the four values
  // this hook already subscribes to, so the derivation re-runs exactly when its
  // inputs could have changed.
  //
  // WHY (the cost this pays is subscription breadth and re-derivation, NOT scan
  // size): `useSessionStatus` calls this hook ONCE PER SIDEBAR ROW
  // (its `childGateCount` line, from `SpacesList`'s `SessionRow`, and the
  // rows are unmemoized), so an unmemoised derivation rebuilt and re-sorted the
  // whole gate list once per row per render for the same answer — and handed back
  // a new array each time, which makes the array's identity meaningless to any
  // `memo` / `useMemo` boundary downstream (`MessageList` is unmemoized today, so
  // no consumer depends on that identity yet; the memo is what lets one exist).
  // What per-row subscription STILL costs — every row listens to all three whole
  // maps instead of only its own Session's slice — and why that remains
  // acceptable, is stated on `useSessionStatus`' own `childGateCount` comment.
  //
  // `usePendingSubagentRequests` is the other derivation of the same pure core
  // and is memoised for the same reason; it is the HOTTER of the two (one of its
  // callers is `ChatStream`, which re-renders on every streamed token and every
  // composer keystroke), which is why its own test file pins the derivation's
  // CALL COUNT rather than an array identity — it returns a `number`.
  //
  // `useMemo` is a hint React may in principle discard, so no consumer may read
  // array identity as CORRECTNESS — only as "this render did not re-derive".
  return useMemo(() => {
    // The shared frozen empty array, so even the "no Session" answer has ONE
    // identity instead of minting a fresh `[]` per render.
    if (parentSessionId === null) return NO_GATES;
    return childGatesOf(entries, requests, prompts, parentSessionId);
  }, [entries, requests, prompts, parentSessionId]);
}
