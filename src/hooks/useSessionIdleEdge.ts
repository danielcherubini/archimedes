import { useEffect, useRef } from "react";

/**
 * Fires `onIdle` on the FALLING EDGE of a composite busy flag — the trigger for
 * the **Prompt queue**'s **Flush**.
 *
 * ## Why the flag is composite, not `inTurn`
 *
 * The caller passes `composerLocked` verbatim:
 * `workingOrInTurn || agentState === "blocked" || compacting !== undefined`.
 * That is the SAME predicate the queue fork in `send()` enqueues on, so enqueue
 * and **Flush** agree by construction — anything that could have been queued is
 * reachable by a **Flush**. An `inTurn`-only trigger would not be: an IDLE
 * compaction (the `/compact` command) emits no `turn_start` / `agent_settled`,
 * so `inTurn` stays `false` for the whole of it and a prompt queued during a
 * `/compact` would never fire.
 *
 * ## Why the callback ref is assigned during RENDER
 *
 * `cb.current = opts.onIdle` runs in the render phase, so the closure the edge
 * fires is ALWAYS the current render's. That is what lets the caller pass a
 * fresh inline function instead of a `useCallback` with a guessed dep array —
 * a guessed array is a staleness bug waiting for the next value the closure
 * reads (`ChatStream`'s `flushHead` reads `imageCapable`, `sendText` and the
 * draft-owning state, all of which move between renders). This is the same
 * render-phase ref mirror the caller already uses for `attachmentsRef`,
 * `activeSessionIdRef` and `draftRef`.
 *
 * ## Visible-Session-only, and what that costs
 *
 * The **Flush** covers the VISIBLE **Session** only, because `sendText` expands
 * **Mentions** through catalogs keyed on the ACTIVE **Session**'s Space — a
 * background **Session**'s prompt would expand against the wrong **Space**. This
 * hook is therefore one boolean about one Session (plus the identity that
 * boolean belongs to), and `seen` is per-component:
 *
 * - A **Session** switch is NOT itself an edge, and the `key` option is what
 *   makes the hook able to say so. One boolean cannot tell "this Session fell"
 *   apart from "the Session changed, and the new one is idle": leaving a busy
 *   **Session** for an idle one moves `busy` `true → false` in a single render,
 *   and a **Flush** measured across two different **Session**s would dispatch
 *   the ARRIVED-AT **Session**'s head the moment the user clicks a tab — with no
 *   user gesture, and against the not-yet-loaded **Space** catalogs. So the hook
 *   is also given the identity `busy` describes: a change to `key` RE-SEEDS
 *   `seen` and returns, and can therefore NEVER fire. Switching to a
 *   **Session** that settled while it was hidden still does not flush — its
 *   queue holds until it goes idle again while on screen, which is the honest
 *   behaviour of an edge detector: a fall nobody observed is not an edge.
 * - `ChatStream`'s remount (the Settings view unmounts it wholesale,
 *   `App.tsx:424-425`) is likewise not an edge: the ref reset re-seeds BOTH
 *   fields from the CURRENT `key` and `busy`, so an already-idle Session starts
 *   idle. Per-component seeding is correct precisely because there is no
 *   cross-Session memory to preserve — no module-level map is needed, and adding
 *   one would resurrect the hidden-Session flush the bullet above just declined
 *   to invent.
 *
 * ## One known non-flush, accepted
 *
 * A **Session** left `blocked` by an unresolved **Gate** never drains its queue.
 * The store does NOT reset `agentState` on `turnCompleted`, so `agentState ===
 * "blocked"` keeps `composerLocked` — and therefore `busy` — true indefinitely
 * and no falling edge ever arrives. This is a PRE-EXISTING condition, not one
 * this hook creates: a locked composer cannot send either, so the Send button
 * has exactly the same behaviour today. Fixing it means clearing `agentState`
 * in `turnCompleted`, which is a composer change needing its own reasoning, so
 * there is deliberately NO timer and NO force-flush here working around it.
 */
export function useSessionIdleEdge(opts: {
  /** The composite busy flag — pass `composerLocked` verbatim. */
  busy: boolean;
  /** Identity of the Session `busy` describes. A change to this is NEVER an edge. */
  key: string;
  onIdle: () => void;
}): void {
  // Assigned DURING RENDER (see the doc comment): the edge fires the current
  // closure, so the caller never has to memoize one.
  const cb = useRef(opts.onIdle);
  cb.current = opts.onIdle;
  // Seed BOTH at mount, so neither the first render of an already-idle Session
  // nor a remount is an edge.
  const seen = useRef({ key: opts.key, busy: opts.busy });

  useEffect(() => {
    const was = seen.current;
    seen.current = { key: opts.key, busy: opts.busy };
    // A switch is a change of SUBJECT, not a change of state: the previous
    // Session's busy level says nothing about this one, so a fall measured
    // across the two is not an edge. Re-seed and wait for a fall we actually
    // observe while this Session is on screen.
    if (was.key !== opts.key) return;
    // ONLY the fall. A rise is a turn starting; a level (busy staying false
    // across unrelated re-renders) is not an edge and must not re-Flush.
    if (was.busy === true && !opts.busy) cb.current();
  }, [opts.key, opts.busy]);
}
